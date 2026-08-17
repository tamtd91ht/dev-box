// /api/redis — single dispatch route for all Redis operations.
//
//   POST { action, ... }  where action is one of:
//     'test'   { mode?, host?, port?, nodes?, password? } → { ok, result: { latencyMs } }  (no saved connection)
//     'ping'   { connectionId, db? }             → { ok, result: { latencyMs } }
//     'scan'   { connectionId, db?, match, cursor, count } → { ok, result: { cursor, keys[] } }
//     'lookup' { connectionId, db?, key }         → { ok, result: { cursor:'0', keys[0..1] } }
//     'value'  { connectionId, db?, key }         → { ok, result: { key, type, ttl, value, ... } }
//     'setTtl' { connectionId, db?, key, seconds }→ { ok, result: { applied } }
//     'set'    { connectionId, db?, key, type, value, ttl?, overwrite? } → { ok, result: { created, type } }
//     'del'    { connectionId, db?, key }         → { ok, result: { deleted, lockKeyWarning } }
//
// `db` is the logical DB index (0–15) chosen at browse time; it defaults to 0 and is
// forced to 0 for cluster connections (Redis Cluster only has DB 0). 'test' probes a
// not-yet-saved connection straight from the form (single or cluster).
//
// Gated by REDIS_TOOL_ENABLED (403 when off). The browser never talks to Redis
// directly — this server-side handler owns the ioredis socket. Any Redis / network
// error is caught and returned as { ok:false, error, detail } so the UI can render
// it instead of the request hanging.

import { NextResponse, type NextRequest } from 'next/server';
import { REDIS_ENABLED, normalizeDb, ping, scan, lookupKey, getValue, setTtl, setValue, del, testConnection, infoStats } from '@/lib/redisClient';
import { getConnection } from '@/lib/redisConnections';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!REDIS_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Redis tool is disabled. Set REDIS_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;

  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  // 'test' probes an unsaved connection — raw form fields, no connectionId. Supports
  // both single (host/port) and cluster (mode:'cluster' + nodes[]).
  if (action === 'test') {
    try {
      const result = await testConnection({
        mode: body.mode === 'cluster' ? 'cluster' : 'single',
        host: body.host != null ? String(body.host) : undefined,
        port: body.port != null ? Number(body.port) : undefined,
        nodes: Array.isArray(body.nodes) ? body.nodes : undefined,
        password: body.password ? String(body.password) : undefined,
      });
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

  const db = normalizeDb(body.db);

  try {
    let result: unknown;
    switch (action) {
      case 'ping':
        result = await ping(conn, db);
        break;
      case 'stats': // INFO snapshot per node (monitor strip)
        result = await infoStats(conn);
        break;
      case 'scan':
        result = await scan(conn, db, String(body.match ?? '*'), String(body.cursor ?? '0'), Number(body.count ?? 100));
        break;
      // Tra ĐÚNG một key theo tên (ô "Đúng key") — TYPE+TTL O(1), không quét.
      case 'lookup':
        result = await lookupKey(conn, db, String(body.key ?? ''));
        break;
      case 'value':
        result = await getValue(conn, db, String(body.key ?? ''));
        break;
      case 'setTtl':
        result = await setTtl(conn, db, String(body.key ?? ''), Number(body.seconds));
        break;
      case 'set':
        result = await setValue(conn, db, {
          key: String(body.key ?? ''),
          type: body.type,
          value: body.value,
          ttl: body.ttl != null ? Number(body.ttl) : undefined,
          overwrite: body.overwrite === true,
        });
        break;
      case 'del':
        result = await del(conn, db, String(body.key ?? ''));
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'Redis operation failed', detail: String(err) },
      { status: 502 },
    );
  }
}
