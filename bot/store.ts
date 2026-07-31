// Local file-backed state for the bot: the Telegram update offset and the
// per-commit dedup records. Persisted to a single JSON file next to the bot code
// (bot/.state.json), so a machine restart resumes exactly where it left off.
//
// Why a file and not Redis: this bot runs on ONE machine at a time (company OR
// home, never both). Offset + dedup are the only state that must survive a
// restart, and both are tiny. A cross-machine lock (Redis SET NX) would only
// matter if two machines shared one broker — which they don't. So a plain JSON
// file removes the whole "is Redis running?" failure mode while keeping the two
// guarantees that matter: don't lose/replay a command, don't re-review a commit.

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

interface StateFile {
  /** Next Telegram update offset to request (last processed update_id + 1). */
  offset: number;
  /** dedupKey → { reportPath, at (epoch ms) }. Pruned by age on load. */
  reviews: Record<string, { reportPath: string; at: number }>;
}

const DEDUP_TTL_MS = 30 * 24 * 3600 * 1000; // keep a commit's review record 30 days

export class BotStore {
  private readonly file: string;
  private state: StateFile = { offset: 0, reviews: {} };
  private writing: Promise<void> = Promise.resolve();

  constructor() {
    this.file = path.join(__dirname, '.state.json');
  }

  /** Load persisted state from disk (creating an empty one if absent). */
  async connect(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      this.state = {
        offset: typeof parsed.offset === 'number' ? parsed.offset : 0,
        reviews: parsed.reviews ?? {},
      };
      this.pruneExpired();
    } catch {
      this.state = { offset: 0, reviews: {} }; // first run or unreadable → fresh
    }
  }

  async close(): Promise<void> {
    await this.writing; // let any in-flight write finish
  }

  /** Serialize writes so concurrent flushes never interleave/corrupt the file. */
  private flush(): Promise<void> {
    this.writing = this.writing.then(() =>
      fs.writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8').catch(() => {}),
    );
    return this.writing;
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, v] of Object.entries(this.state.reviews)) {
      if (v.at < cutoff) delete this.state.reviews[k];
    }
  }

  // ── Telegram offset ────────────────────────────────────────────────────────

  async getOffset(): Promise<number> {
    return this.state.offset;
  }

  async setOffset(offset: number): Promise<void> {
    this.state.offset = offset;
    await this.flush();
  }

  // ── Per-commit dedup ─────────────────────────────────────────────────────────

  /** Stable key for one (repo, branch, HEAD sha) combination. */
  static dedupKey(repoName: string, branch: string, headSha: string): string {
    return createHash('sha256').update(`${repoName}|${branch}|${headSha}`).digest('hex').slice(0, 32);
  }

  /** Report path if this exact commit was already reviewed, else null. */
  async getReview(dedupKey: string): Promise<string | null> {
    const rec = this.state.reviews[dedupKey];
    if (!rec) return null;
    if (rec.at < Date.now() - DEDUP_TTL_MS) {
      delete this.state.reviews[dedupKey];
      return null;
    }
    return rec.reportPath;
  }

  /** Record that this commit was reviewed (kept 30 days). */
  async saveReview(dedupKey: string, reportPath: string): Promise<void> {
    this.state.reviews[dedupKey] = { reportPath, at: Date.now() };
    await this.flush();
  }
}
