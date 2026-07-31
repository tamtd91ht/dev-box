// /api/mongo — single dispatch route for all MongoDB operations.
//
//   POST { action, ... }  where action is one of:
//     'test'        { scheme?, hosts, username?, password?, ... } → { ok, result: TestResult }   (no saved connection)
//     'ping'        { connectionId }                     → { ok, result: { latencyMs } }
//     'serverInfo'  { connectionId }                     → { ok, result: ServerInfoResult }
//     'databases'   { connectionId }                     → { ok, result: DatabaseInfo[] }
//     'collections' { connectionId, db }                 → { ok, result: CollectionInfo[] }
//     'stats'       { connectionId, db, coll }           → { ok, result: CollStatsResult }
//     'indexes'     { connectionId, db, coll }           → { ok, result: IndexInfo[] }
//     'find'        { connectionId, db, coll, filter?, projection?, sort?, limit?, skip? } → { ok, result: FindResult }
//     'count'       { connectionId, db, coll, filter? }  → { ok, result: CountResult }
//     'aggregate'   { connectionId, db, coll, pipeline } → { ok, result: AggregateResult }
//     'update'      { connectionId, db, coll, filter, update, mode? } → { ok, result: UpdateResult }
//
// READS are open (bounded by maxTimeMS + page caps in lib/mongoClient). 'update'
// is the ONLY write and passes three gates: MONGO_ALLOW_WRITE env flag, the
// per-connection readOnly flag, and mandatory non-empty filter + $-operator
// update (all enforced in lib/mongoClient.updateWithQuery).
//
// Gated by MONGO_TOOL_ENABLED (403 when off). The browser never talks to MongoDB
// directly — this server-side handler owns the driver client. Any driver/network
// error is caught and returned as { ok:false, error } so the UI can render it.

import { NextResponse, type NextRequest } from 'next/server';
import {
  MONGO_ENABLED,
  testConnection,
  ping,
  serverInfo,
  monitor,
  listDatabases,
  listCollections,
  collectionStats,
  listIndexes,
  find,
  count,
  aggregate,
  updateWithQuery,
} from '@/lib/mongoClient';
import { getConnection, buildUnsavedConnection } from '@/lib/mongoConnections';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!MONGO_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'MongoDB tool is disabled. Set MONGO_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  // 'test' probes an unsaved connection — raw form fields, no connectionId. The
  // form's name may be blank at test time; substitute a placeholder for validation.
  if (action === 'test') {
    try {
      const conn = buildUnsavedConnection({ ...body, name: body.name || 'test' });
      const result = await testConnection(conn);
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: (err as Error).message || 'Connection test failed', detail: String(err) },
        { status: 502 },
      );
    }
  }

  const connectionId = body?.connectionId as string | undefined;
  if (!connectionId) {
    return NextResponse.json({ ok: false, error: 'Missing connectionId' }, { status: 400 });
  }
  const conn = await getConnection(connectionId);
  if (!conn) {
    return NextResponse.json({ ok: false, error: `Unknown connection: ${connectionId}` }, { status: 404 });
  }

  const db = String(body.db ?? '');
  const coll = String(body.coll ?? '');

  try {
    let result: unknown;
    switch (action) {
      case 'ping':
        result = await ping(conn);
        break;
      case 'serverInfo':
        result = await serverInfo(conn);
        break;
      case 'monitor':
        result = await monitor(conn);
        break;
      case 'databases':
        result = await listDatabases(conn);
        break;
      case 'collections':
        result = await listCollections(conn, db);
        break;
      case 'stats':
        result = await collectionStats(conn, db, coll);
        break;
      case 'indexes':
        result = await listIndexes(conn, db, coll);
        break;
      case 'find':
        result = await find(conn, db, coll, {
          filter: body.filter,
          projection: body.projection,
          sort: body.sort,
          limit: body.limit,
          skip: body.skip,
        });
        break;
      case 'count':
        result = await count(conn, db, coll, body.filter);
        break;
      case 'aggregate':
        result = await aggregate(conn, db, coll, body.pipeline);
        break;
      case 'update': {
        try {
          result = await updateWithQuery(conn, db, coll, {
            filter: body.filter,
            update: body.update,
            mode: body.mode,
          });
        } catch (err) {
          // Gate refusals are 403 (so the UI shows "locked", not "server broke").
          const msg = (err as Error).message || 'update refused';
          const gate = msg.includes('disabled for the whole tool') || msg.includes('is read-only');
          return NextResponse.json({ ok: false, error: msg }, { status: gate ? 403 : 400 });
        }
        break;
      }
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'MongoDB operation failed', detail: String(err) },
      { status: 502 },
    );
  }
}
