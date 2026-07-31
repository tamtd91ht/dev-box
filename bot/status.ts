// Live status snapshot for the operator sitting at the local machine.
//
// The bot writes bot/.status.json on every state change; `npm run bot:status`
// reads it back and prints a one-glance summary — so you can tell, from any
// terminal, whether a review is running, how long it's been going, what's queued,
// and how the last one ended, WITHOUT staring at the bot's own console window.
//
// This is a plain JSON file (no Redis/Telegram) so the status command stays
// instant and works even when the bot is between runs or just restarted.

import { promises as fs } from 'fs';
import path from 'path';

export type BotState = 'starting' | 'idle' | 'reviewing' | 'stopped';

export interface StatusSnapshot {
  state: BotState;
  instanceId: string;
  /** ISO time this snapshot was written. */
  updatedAt: string;
  /** The review in flight, if state === 'reviewing'. */
  current?: {
    service: string;
    branch: string;
    requester: string;
    /** epoch ms when this review started — used to show elapsed time. */
    startedAt: number;
  };
  /** How many branches are still waiting behind the current one, this batch. */
  queued: number;
  /** The most recently finished review. */
  last?: {
    service: string;
    branch: string;
    verdict: string;
    /** "CRIT=0 HIGH=2 MED=4 LOW=4" or '' if unknown. */
    score: string;
    /** seconds the engine took. */
    durationSec: number;
    finishedAt: string;
  };
}

/** The status file lives next to the bot code. */
export function statusPath(): string {
  return path.join(__dirname, '.status.json');
}

/**
 * A tiny mutable writer the bot holds for its lifetime. It keeps the snapshot in
 * memory and flushes to disk on every mutation. Disk errors are swallowed —
 * status is a convenience, never a reason to fail a review.
 */
export class StatusWriter {
  private snap: StatusSnapshot;
  private readonly file: string;

  constructor(instanceId: string) {
    this.file = statusPath();
    this.snap = { state: 'starting', instanceId, updatedAt: nowIso(), queued: 0 };
  }

  private async flush(): Promise<void> {
    this.snap.updatedAt = nowIso();
    await fs.writeFile(this.file, JSON.stringify(this.snap, null, 2), 'utf8').catch(() => {});
  }

  async set(state: BotState): Promise<void> {
    this.snap.state = state;
    if (state !== 'reviewing') this.snap.current = undefined;
    await this.flush();
  }

  async startReview(c: { service: string; branch: string; requester: string; startedAt: number }, queued: number): Promise<void> {
    this.snap.state = 'reviewing';
    this.snap.current = c;
    this.snap.queued = queued;
    await this.flush();
  }

  async finishReview(last: NonNullable<StatusSnapshot['last']>): Promise<void> {
    this.snap.last = last;
    this.snap.current = undefined;
    if (this.snap.queued > 0) this.snap.queued -= 1;
    await this.flush();
  }

  async remove(): Promise<void> {
    await fs.unlink(this.file).catch(() => {});
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
