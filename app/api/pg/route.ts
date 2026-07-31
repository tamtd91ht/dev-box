// /api/pg — single dispatch route for all PostgreSQL operations.
//
//   POST { action, ... }  where action is one of:
//     'test'       { host, port, database, username, password?, tls? } → { ok, result: PgTestResult }
//     'ping'       { connectionId }                        → { ok, result: { latencyMs } }
//     'databases'  { connectionId }                        → { ok, result: PgDatabaseInfo[] }
//     'tables'     { connectionId, db }                    → { ok, result: PgTableInfo[] }
//     'columns'    { connectionId, db, schema, table }     → { ok, result: PgColumnInfo[] }
//     'indexes'    { connectionId, db, schema, table }     → { ok, result: PgIndexInfo[] }
//     'query'      { connectionId, db, sql }               → { ok, result: PgQueryResult }        (READ ONLY tx)
//     'quickFind'  { connectionId, db, schema, table, entries[], limit?, offset?, columns? } → { ok, result }
//     'quickCount' { connectionId, db, schema, table, entries[] } → { ok, result: { count } }
//     'countWhere' { connectionId, db, schema, table, where } → { ok, result: { count } }         (update dry-run)
//     'update'     { connectionId, db, schema, table, set[], where } → { ok, result: { updated } } (gated write)
//
// Reads run inside READ ONLY transactions with statement_timeout — the
// database itself refuses any write smuggled into a "read". 'update' is the
// ONLY write and passes: PG_ALLOW_WRITE env + per-connection readOnly +
// mandatory non-empty WHERE (all enforced in lib/pgClient).
// Gated by PG_TOOL_ENABLED (403 when off).

import { NextResponse, type NextRequest } from 'next/server';
import {
  PG_ENABLED,
  testConnection,
  ping,
  listDatabases,
  listTables,
  listColumns,
  listIndexes,
  query,
  quickFind,
  quickCount,
  countWhere,
  updateWithWhere,
} from '@/lib/pgClient';
import { getConnection, buildUnsavedConnection } from '@/lib/pgConnections';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!PG_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'PostgreSQL tool is disabled. Set PG_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  if (action === 'test') {
    try {
      const conn = buildUnsavedConnection(body ?? {});
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

  try {
    let result: unknown;
    switch (action) {
      case 'ping':
        result = await ping(conn);
        break;
      case 'info': // version + latency of the SAVED connection (Overview)
        result = await testConnection(conn);
        break;
      case 'databases':
        result = await listDatabases(conn);
        break;
      case 'tables':
        result = await listTables(conn, db);
        break;
      case 'columns':
        result = await listColumns(conn, db, String(body.schema ?? ''), String(body.table ?? ''));
        break;
      case 'indexes':
        result = await listIndexes(conn, db, String(body.schema ?? ''), String(body.table ?? ''));
        break;
      case 'query':
        result = await query(conn, db, body.sql);
        break;
      case 'quickFind':
        result = await quickFind(conn, db, {
          schema: String(body.schema ?? ''),
          table: String(body.table ?? ''),
          entries: Array.isArray(body.entries) ? body.entries : [],
          limit: body.limit,
          offset: body.offset,
          columns: body.columns,
        });
        break;
      case 'quickCount':
        result = await quickCount(conn, db, {
          schema: String(body.schema ?? ''),
          table: String(body.table ?? ''),
          entries: Array.isArray(body.entries) ? body.entries : [],
        });
        break;
      case 'countWhere':
        result = await countWhere(conn, db, body.schema, body.table, body.where);
        break;
      case 'update': {
        try {
          result = await updateWithWhere(conn, db, {
            schema: String(body.schema ?? ''),
            table: String(body.table ?? ''),
            set: Array.isArray(body.set) ? body.set : [],
            where: String(body.where ?? ''),
          });
        } catch (err) {
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
      { ok: false, error: (err as Error).message || 'PostgreSQL operation failed', detail: String(err) },
      { status: 502 },
    );
  }
}
