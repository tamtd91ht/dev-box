// /api/automation/trace — the watch-runner trace file.
//
//   POST { action: 'append', lines[], fileName?, retentionHours?, dropped? }
//   POST { action: 'tail',   fileName?, limit? }   → last N lines, newest first
//   POST { action: 'clear',  fileName? }
//   POST { action: 'stats',  fileName? }
//
// SEPARATE FILE from the `log` action's output on purpose. This is high-volume
// debug material (153 watches at 60s ≈ 150 lines/minute) with a lifetime measured
// in hours; the alert log is low-volume and kept for days or in Mongo. Mixing them
// would bury the alerts and make the alert log's retention meaningless.
//
// Writes are APPEND-ONLY and pruned by age on a timer, same as the alert log — see
// lib/automation/store.ts for why pruning is rate-limited rather than per-write.

import { NextResponse, type NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export const runtime = 'nodejs';

const DEFAULT_FILE = '.automation-trace.jsonl';
/** Lines accepted in one request — bounds both the body size and the write. */
const MAX_LINES = 2000;
/** Lines returned by `tail`. */
const MAX_TAIL = 500;
const PRUNE_EVERY_MS = 5 * 60 * 1000;

const lastPrune = new Map<string, number>();

/**
 * Confine the target to a plain .jsonl in the working dir. Same rule as the log
 * action: the name arrives from a browser form, so traversal and absolute paths
 * are rejected rather than sanitised.
 */
function resolveFile(name?: unknown): string {
  const s = typeof name === 'string' ? name.trim() : '';
  const safe =
    s && !path.isAbsolute(s) && !s.includes('..') && !/[\\/]/.test(s) && /^[\w.-]+\.jsonl$/.test(s)
      ? s
      : DEFAULT_FILE;
  return path.join(process.cwd(), safe);
}

/** Drop lines older than `hours`. Returns how many went. */
async function prune(target: string, hours: number): Promise<number> {
  const cutoff = Date.now() - hours * 3600e3;
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch {
    return 0;
  }
  const lines = raw.split('\n').filter(Boolean);
  const keep = lines.filter((line) => {
    // Unparseable or undated lines are KEPT — pruning bounds growth, it does not
    // get to discard records whose shape we failed to recognise.
    try {
      const ts = (JSON.parse(line) as { ts?: number }).ts;
      return typeof ts !== 'number' || ts >= cutoff;
    } catch {
      return true;
    }
  });
  const removed = lines.length - keep.length;
  if (removed > 0) await fs.writeFile(target, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
  return removed;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const target = resolveFile(body?.fileName);
  const name = path.basename(target);

  try {
    switch (action) {
      case 'append': {
        const lines = Array.isArray(body?.lines) ? body.lines.slice(0, MAX_LINES) : [];
        if (!lines.length) return NextResponse.json({ ok: true, written: 0 });
        const dropped = Number(body?.dropped) || 0;
        const out = lines.map((l) => JSON.stringify(l));
        // Record the gap rather than hiding it: a trace with silent holes is
        // worse than one that admits where it lost lines.
        if (dropped > 0) {
          out.push(JSON.stringify({ ts: Date.now(), kind: 'error', watchId: '', watch: '(trace)', stack: '', instance: '', note: `bỏ ${dropped} dòng vì hàng đợi đầy` }));
        }
        await fs.appendFile(target, out.join('\n') + '\n', 'utf8');

        const hours = Math.min(168, Math.max(1, Number(body?.retentionHours) || 24));
        const now = Date.now();
        if (now - (lastPrune.get(target) ?? 0) >= PRUNE_EVERY_MS) {
          lastPrune.set(target, now);
          // Housekeeping must never fail a write that already succeeded.
          await prune(target, hours).catch(() => 0);
        }
        return NextResponse.json({ ok: true, written: out.length, file: name });
      }

      case 'tail': {
        const limit = Math.min(MAX_TAIL, Math.max(1, Number(body?.limit) || 200));
        let raw = '';
        try {
          raw = await fs.readFile(target, 'utf8');
        } catch {
          return NextResponse.json({ file: name, lines: [], total: 0 });
        }
        const all = raw.split('\n').filter(Boolean);
        const lines = all
          .slice(-limit)
          .map((l) => {
            try {
              return JSON.parse(l) as Record<string, unknown>;
            } catch {
              return { ts: 0, kind: 'error', watch: '(dòng lỗi)', note: l.slice(0, 200) };
            }
          })
          .reverse();
        return NextResponse.json({ file: name, lines, total: all.length });
      }

      case 'clear': {
        await fs.writeFile(target, '', 'utf8').catch(() => {});
        return NextResponse.json({ ok: true, file: name });
      }

      case 'stats': {
        try {
          const [stat, raw] = await Promise.all([fs.stat(target), fs.readFile(target, 'utf8')]);
          const all = raw.split('\n').filter(Boolean);
          let oldest: number | undefined;
          for (const l of all) {
            try {
              const ts = (JSON.parse(l) as { ts?: number }).ts;
              if (typeof ts === 'number') {
                oldest = ts;
                break;
              }
            } catch {
              /* dòng lỗi — bỏ qua khi tìm mốc cũ nhất */
            }
          }
          return NextResponse.json({ file: name, bytes: stat.size, lines: all.length, oldest });
        } catch {
          return NextResponse.json({ file: name, bytes: 0, lines: 0 });
        }
      }

      default:
        return NextResponse.json({ error: `action không hỗ trợ: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
