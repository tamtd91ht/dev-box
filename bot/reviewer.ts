// Run the /review-mr-dev engine for one (service, branch) and extract the
// verdict from the report file it writes. The heavy lifting — diff, agent
// fan-out, rule checks, writing the report + monthly rollup — is done entirely
// by the existing lib/reviewMr.ts + the /review-mr-dev command. This module only
// orchestrates and reads the result back.

import { promises as fs } from 'fs';
import path from 'path';
import { runReviewMr } from '../lib/reviewMr';

export type Verdict = 'APPROVE' | 'FIX_REQUIRED' | 'BLOCK' | 'UNKNOWN';

export interface ReviewResult {
  verdict: Verdict;
  /** Parsed SCORE line counts, when present. */
  score?: { crit: number; high: number; med: number; low: number };
  /** Absolute path of the per-branch report file the engine wrote, if found. */
  reportPath?: string;
  /** Full command stdout (for logging / fallback). */
  rawOutput: string;
  exitCode: number;
}

const SANITIZE = /[\s/\\]+/g;

/** Sanitize a branch name the way /review-mr-dev does for the report filename. */
function sanitizeForFile(s: string): string {
  return s.replace(SANITIZE, '-');
}

/**
 * Run the review, then locate the report the engine just wrote for this
 * (service, branch). We match on the filename suffix `-{service}-{branch}.md`
 * under review-mr/{yyyy}/{MM}/ and pick the newest by mtime (a re-review writes
 * a new timestamped file). `author` is not needed to find it — the service +
 * branch suffix is unique per run.
 */
export async function runReview(opts: {
  basePath: string;
  service: string;
  branch: string;
}): Promise<ReviewResult> {
  const { basePath, service, branch } = opts;

  const cmd = await runReviewMr({ cwd: basePath, service, branch });

  const reportPath = await findReport(basePath, service, branch);
  let verdict: Verdict = 'UNKNOWN';
  let score: ReviewResult['score'];

  if (reportPath) {
    const content = await fs.readFile(reportPath, 'utf8').catch(() => '');
    const parsed = parseScoreLine(content);
    if (parsed) {
      verdict = parsed.verdict;
      score = parsed.score;
    }
  }
  // Fallback: parse the verdict straight out of the command output if no file.
  if (verdict === 'UNKNOWN') {
    verdict = parseVerdictFromText(cmd.output);
  }

  return { verdict, score, reportPath, rawOutput: cmd.output, exitCode: cmd.exitCode };
}

/** Find the newest report file matching this service+branch under review-mr/. */
async function findReport(basePath: string, service: string, branch: string): Promise<string | undefined> {
  const suffix = `-${service}-${sanitizeForFile(branch)}.md`;
  const root = path.join(basePath, 'review-mr');
  const files: { full: string; mtime: number }[] = [];

  // Walk review-mr/{yyyy}/{MM}/ — a shallow, bounded tree.
  const years = await safeReadDir(root);
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    const yDir = path.join(root, y);
    const months = await safeReadDir(yDir);
    for (const m of months) {
      const mDir = path.join(yDir, m);
      const entries = await safeReadDir(mDir);
      for (const f of entries) {
        if (f.endsWith(suffix)) {
          const full = path.join(mDir, f);
          const st = await fs.stat(full).catch(() => null);
          if (st) files.push({ full, mtime: st.mtimeMs });
        }
      }
    }
  }
  if (files.length === 0) return undefined;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0].full;
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Parse the machine-readable SCORE line the report ends with, e.g.
 *   `SCORE: CRIT=0 HIGH=2 MED=6 LOW=1 VERDICT=FIX_REQUIRED`
 * (VERDICT token may also read APPROVE / BLOCK, and older reports use
 *  `verdict=` / spaces — handle loosely).
 */
export function parseScoreLine(
  content: string,
): { verdict: Verdict; score: { crit: number; high: number; med: number; low: number } } | null {
  const line = content.split('\n').find((l) => /^\s*SCORE:/i.test(l));
  if (!line) return null;
  const num = (re: RegExp) => {
    const m = line.match(re);
    return m ? parseInt(m[1], 10) || 0 : 0;
  };
  const crit = num(/CRIT\s*=\s*(\d+)/i);
  const high = num(/HIGH\s*=\s*(\d+)/i);
  const med = num(/MED\s*=\s*(\d+)/i);
  const low = num(/LOW\s*=\s*(\d+)/i);
  const vm = line.match(/VERDICT\s*=\s*([A-Z_ ]+)/i);
  return { verdict: normalizeVerdict(vm ? vm[1] : ''), score: { crit, high, med, low } };
}

function normalizeVerdict(raw: string): Verdict {
  const v = raw.trim().toUpperCase().replace(/\s+/g, '_');
  if (v.startsWith('APPROVE')) return 'APPROVE';
  if (v.startsWith('BLOCK')) return 'BLOCK';
  if (v.startsWith('FIX')) return 'FIX_REQUIRED';
  return 'UNKNOWN';
}

/** Last-resort verdict detection from free command output. */
function parseVerdictFromText(text: string): Verdict {
  const t = text.toUpperCase();
  if (/\bBLOCK\b/.test(t)) return 'BLOCK';
  if (/FIX\s*REQUIRED/.test(t)) return 'FIX_REQUIRED';
  if (/\bAPPROVE\b/.test(t)) return 'APPROVE';
  return 'UNKNOWN';
}
