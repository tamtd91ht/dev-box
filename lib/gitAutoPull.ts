// Server-only background auto-pull for every configured Git project.
//
// Started once per server process (instrumentation.ts on boot, or lazily by the
// first /api/git/auto-pull request). Every cycle it runs pullAll() over each
// project root (safe: --ff-only, dirty repos are skipped) and keeps the latest
// results in memory so the client can poll them cheaply and surface a
// notification when any repo is in conflict.
//
// The singleton lives on globalThis: `next dev` hot-reloads modules, and a
// module-scoped timer would be duplicated on every recompile.

import { GIT_ENABLED, pullAll, type PullResult } from './gitCore';
import { listProjects } from './gitProjects';

/** Cycle interval — 10 minutes, overridable for testing via env (minutes). */
const INTERVAL_MS =
  Math.max(1, Number(process.env.GIT_AUTO_PULL_MINUTES) || 10) * 60_000;

export interface ProjectPullReport {
  projectId: string;
  projectName: string;
  root: string;
  results: PullResult[];
}

export interface AutoPullConflict {
  projectName: string;
  repoName: string;
  path: string;
  message: string;
}

export interface AutoPullState {
  enabled: boolean;
  intervalMs: number;
  /** True while a cycle is in flight. */
  running: boolean;
  /** Incremented after each COMPLETED cycle — the client uses it to detect a new run. */
  runSeq: number;
  lastRunAt: number | null;
  projects: ProjectPullReport[];
  /** Repos whose last pull attempt ended in conflict (non-ff or mid-merge). */
  conflicts: AutoPullConflict[];
}

interface Store {
  timer: ReturnType<typeof setInterval> | null;
  state: AutoPullState;
}

const g = globalThis as typeof globalThis & { __gitAutoPull?: Store };

function store(): Store {
  if (!g.__gitAutoPull) {
    g.__gitAutoPull = {
      timer: null,
      state: {
        enabled: GIT_ENABLED,
        intervalMs: INTERVAL_MS,
        running: false,
        runSeq: 0,
        lastRunAt: null,
        projects: [],
        conflicts: [],
      },
    };
  }
  return g.__gitAutoPull;
}

/** One pull cycle over every configured project (roots deduped). Never throws. */
async function cycle(): Promise<void> {
  const s = store();
  if (s.state.running) return; // a slow cycle must never overlap the next tick
  s.state.running = true;
  try {
    const { projects } = await listProjects();
    const seenRoots = new Set<string>();
    const reports: ProjectPullReport[] = [];
    for (const p of projects) {
      if (seenRoots.has(p.root)) continue; // two projects on one root → pull once
      seenRoots.add(p.root);
      const results = await pullAll(p.root);
      reports.push({ projectId: p.id, projectName: p.name, root: p.root, results });
    }
    s.state.projects = reports;
    s.state.conflicts = reports.flatMap((r) =>
      r.results
        .filter((res) => res.outcome === 'conflict')
        .map((res) => ({
          projectName: r.projectName,
          repoName: res.name,
          path: res.path,
          message: res.message,
        })),
    );
  } catch {
    // listProjects/pullAll are already defensive; a cycle failure just leaves
    // the previous snapshot in place until the next tick.
  } finally {
    s.state.running = false;
    s.state.lastRunAt = Date.now();
    s.state.runSeq += 1;
  }
}

/** Start the 10-minute scheduler (idempotent). No-op when the Git tool is off. */
export function ensureAutoPull(): void {
  if (!GIT_ENABLED) return;
  const s = store();
  if (s.timer) return;
  s.timer = setInterval(() => void cycle(), INTERVAL_MS);
  // Don't let the timer keep a dying process alive.
  (s.timer as { unref?: () => void }).unref?.();
  void cycle(); // first pull right at app start
}

/** Latest snapshot for the polling client. */
export function getAutoPullState(): AutoPullState {
  return store().state;
}

/** Run a cycle immediately (manual "pull now"), then return the fresh state. */
export async function runAutoPullNow(): Promise<AutoPullState> {
  await cycle();
  return store().state;
}
