// /api/automation/log — the log-storage panel's server side.
//
//   POST { action, logStore, ... }
//     'stats'      → local file size/lines, or Mongo doc count + TTL
//     'test'       → write ONE probe record to the given target, then report where
//     'prune'      → local: drop lines past retention now
//     'ttl'        → mongo: create/adjust the TTL index for N days
//     'indexes'    → mongo: create the indexes the reports need
//     'report'     → mongo: run one report over a time window
//     'saveMongo'  → save a typed-in connection INTO the Mongo registry, so it
//                    shows up in the Mongo tab and can be referenced by id
//
// `logStore` is passed in from the editor's UNSAVED draft on purpose: the point
// of "ghi thử" is to check a target BEFORE committing it to the config. Nothing
// here writes the automation config — the caller saves it once the test passes.
//
// Reports are Mongo-only. The local file is a tail-able text log; aggregating it
// would mean reading the whole thing into memory on every request, and the
// answer would still be limited to one machine's last seven days.

import { NextResponse, type NextRequest } from 'next/server';
import { normalizeConfig } from '@/lib/automation/normalize';
import { localLogStats, pruneLocalLogNow } from '@/lib/automation/store';
import {
  buildLogEntry,
  ensureMongoTtl,
  ensureReportIndexes,
  mongoLogStats,
  runReport,
  writeLogEntry,
  type ReportKind,
} from '@/lib/automation/logStore';
import { addConnection, listConnections } from '@/lib/mongoConnections';
import type { LogStoreConfig } from '@/lib/automation/types';

export const runtime = 'nodejs';

const REPORTS: ReportKind[] = ['noisiest', 'byStack', 'mttr', 'timeline', 'flapping'];

/** Reuse the config normalizer so this route can never see a shape the engine can't. */
function readLogStore(raw: unknown): LogStoreConfig {
  return normalizeConfig({ logStore: raw }).logStore;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  if (!action) return NextResponse.json({ error: 'action là bắt buộc' }, { status: 400 });

  const cfg = readLogStore(body?.logStore);

  try {
    switch (action) {
      case 'stats': {
        if (cfg.target === 'mongo') return NextResponse.json({ mongo: await mongoLogStats(cfg) });
        return NextResponse.json({ local: await localLogStats(cfg.file) });
      }

      case 'test': {
        // A real record through the real writer — a test that took a shortcut
        // would prove nothing about the path that runs at 2am.
        const entry = buildLogEntry(
          {
            category: 'system',
            type: 'system.test',
            title: 'Ghi thử từ bảng cấu hình log',
            text: 'Bản ghi kiểm tra — có thể xoá.',
            sourceId: 'devbox',
            instanceId: 'devbox',
            instanceLabel: 'DevBox',
            fields: { probe: 1 },
          },
          { ruleId: '__test__', ruleName: 'Ghi thử', dryRun: false },
        );
        const r = await writeLogEntry({ ...cfg, enabled: true }, entry);
        return NextResponse.json({ ok: true, ...r, verifiedAt: Date.now() });
      }

      case 'prune': {
        if (cfg.target !== 'local') {
          return NextResponse.json({ error: 'chỉ áp dụng cho log local' }, { status: 400 });
        }
        const removed = await pruneLocalLogNow(cfg.file, cfg.retentionDays ?? 7);
        return NextResponse.json({ ok: true, removed, local: await localLogStats(cfg.file) });
      }

      case 'ttl': {
        const days = Number(body?.days);
        if (!Number.isFinite(days) || days < 1) {
          return NextResponse.json({ error: 'days phải ≥ 1' }, { status: 400 });
        }
        const seconds = await ensureMongoTtl(cfg, days);
        return NextResponse.json({ ok: true, seconds, mongo: await mongoLogStats(cfg) });
      }

      case 'indexes': {
        const names = await ensureReportIndexes(cfg);
        return NextResponse.json({ ok: true, names });
      }

      case 'report': {
        if (cfg.target !== 'mongo') {
          return NextResponse.json(
            { error: 'Báo cáo cần log lưu trên MongoDB (log local chỉ để xem bằng tail).' },
            { status: 400 },
          );
        }
        const kind = REPORTS.includes(body?.kind as ReportKind) ? (body!.kind as ReportKind) : 'noisiest';
        const toMs = Number(body?.toMs) || Date.now();
        const fromMs = Number(body?.fromMs) || toMs - 7 * 24 * 3600e3;
        if (fromMs >= toMs) return NextResponse.json({ error: 'fromMs phải nhỏ hơn toMs' }, { status: 400 });
        const limit = Number(body?.limit) || 25;
        return NextResponse.json(await runReport(cfg, kind, fromMs, toMs, limit));
      }

      case 'saveMongo': {
        // Saved into the SHARED registry rather than inlined here: credentials
        // then live in one place, and the connection becomes visible/editable in
        // the Mongo tab like any other — which is what the user asked for.
        const input = body?.connection;
        if (!input || typeof input !== 'object') {
          return NextResponse.json({ error: 'connection là bắt buộc' }, { status: 400 });
        }
        const before = new Set((await listConnections()).map((c) => c.id));
        const list = await addConnection(input as Record<string, unknown>);
        const created = list.find((c) => !before.has(c.id));
        return NextResponse.json({ ok: true, connections: list, created });
      }

      default:
        return NextResponse.json({ error: `action không hỗ trợ: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
