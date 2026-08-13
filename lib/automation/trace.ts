'use client';

// DevBox Automation — trace of the WATCH RUNNER.
//
// Answers a question the activity feed cannot: "is the infrastructure campaign
// actually running?" A healthy watch never breaches, so it never produces rule
// activity — leaving no way to tell "quiet because everything is fine" from
// "quiet because the runner stopped an hour ago".
//
//   10:00:01 09/08/2026  ✓ Campaign — RAM cao   redis · memUsedPct = 61.2  (12ms)
//   10:00:31 09/08/2026  ⚠ ES-02 — heap         es · heapPct = 91  ≥ 90  BREACH
//   10:01:01 09/08/2026  ✗ MG-01 — repl lag     mongo: không đọc được chỉ số
//
// TWO SINKS, independently switchable:
//   console  → the renderer's DevTools (this code runs there, not in the terminal)
//   file     → .automation-trace.jsonl via /api/automation/trace, pruned hourly
//
// WHY THE FILE PATH IS BATCHED: 153 watches at 60s is ~150 polls a minute. One
// fetch per poll would put more load on the app than the polling itself. Lines
// are buffered and flushed on a timer, and the buffer is bounded so a server that
// stops answering costs memory that is already accounted for rather than growing
// without limit.

import type { TraceConfig } from './types';

export interface TraceLine {
  /** Epoch ms — formatted for display at render time, not here. */
  ts: number;
  /** ok = read fine · breach · recovered · error = could not read ·
   *  suppressed = có vượt ngưỡng nhưng bị một watch NẶNG HƠN cùng nhóm che. */
  kind: 'ok' | 'breach' | 'recovered' | 'error' | 'heartbeat' | 'suppressed';
  watchId: string;
  watch: string;
  stack: string;
  instance: string;
  metric?: string;
  value?: number;
  threshold?: number;
  op?: string;
  /** How long the probe call took. */
  tookMs?: number;
  note?: string;
}

/** Buffered lines waiting for the next flush. */
let buffer: TraceLine[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Flush cadence. Long enough to batch a full poll round of 150 watches. */
const FLUSH_MS = 5000;
/**
 * Hard cap on the buffer. At ~150 lines/minute this is about eight minutes of
 * trace — enough to ride out a slow server, small enough to never be the reason
 * the app runs out of memory. Overflow drops the OLDEST lines and says so.
 */
const MAX_BUFFER = 1200;
let dropped = 0;

const pad = (n: number) => String(n).padStart(2, '0');

/** `10:00:01 09/08/2026` — the format asked for, local time. */
export function traceStamp(ts: number): string {
  const d = new Date(ts);
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
  );
}

const ICON: Record<TraceLine['kind'], string> = {
  ok: '✓',
  breach: '⚠',
  recovered: '✅',
  error: '✗',
  heartbeat: '♥',
  suppressed: '🔇',
};

/** One human-readable line — shared by the console sink and the file viewer. */
export function formatTrace(l: TraceLine): string {
  // Built from the parts that are actually present: a heartbeat has no stack or
  // metric, and padding it with empty separators makes the column unreadable.
  const parts: string[] = [];
  if (l.stack || l.instance) parts.push([l.stack, l.instance].filter(Boolean).join(' · '));
  if (l.metric) {
    const v = l.value === undefined ? '—' : String(l.value);
    const thr = l.threshold !== undefined ? ` (ngưỡng ${l.op ?? ''} ${l.threshold})` : '';
    parts.push(`${l.metric} = ${v}${thr}`);
  }
  if (l.tookMs !== undefined) parts.push(`${l.tookMs}ms`);
  if (l.note) parts.push(l.note);
  return `${traceStamp(l.ts)}  ${ICON[l.kind]} ${l.watch}${parts.length ? `  ${parts.join(' · ')}` : ''}`;
}

async function flush(cfg: TraceConfig): Promise<void> {
  timer = null;
  if (!buffer.length) return;
  const lines = buffer;
  const lost = dropped;
  buffer = [];
  dropped = 0;
  try {
    await fetch('/api/automation/trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'append',
        fileName: cfg.fileName,
        retentionHours: cfg.retentionHours,
        lines,
        dropped: lost,
      }),
    });
  } catch {
    // Tracing must never break the poll loop it is observing. A failed flush
    // loses those lines rather than retrying — retrying would grow the buffer
    // during exactly the outage that caused the failure.
  }
}

/**
 * Record one line. Cheap and synchronous: the console write happens now, the file
 * write is queued.
 *
 * `verbosity: 'changes'` keeps only lines that mean something — a breach, a
 * recovery, a probe that failed, or the periodic heartbeat. That is the mode you
 * can leave on; 'all' is for the ten minutes you spend confirming the campaign
 * runs at all.
 */
export function trace(cfg: TraceConfig, line: TraceLine): void {
  if (!cfg.console && !cfg.file) return;
  if (cfg.verbosity !== 'all' && line.kind === 'ok') return;

  if (cfg.console) {
    // eslint-disable-next-line no-console
    console.log(`AUTOMATION_WATCH ${formatTrace(line)}`);
  }
  if (!cfg.file) return;

  buffer.push(line);
  if (buffer.length > MAX_BUFFER) {
    dropped += buffer.length - MAX_BUFFER;
    buffer = buffer.slice(-MAX_BUFFER);
  }
  if (!timer) timer = setTimeout(() => void flush(cfg), FLUSH_MS);
}

/** Push whatever is buffered right now — used when tracing is switched off. */
export function flushTraceNow(cfg: TraceConfig): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  void flush(cfg);
}
