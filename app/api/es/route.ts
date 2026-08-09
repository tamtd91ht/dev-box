// /api/es — single dispatch route for all Elasticsearch operations (READ-ONLY).
//
//   POST { action, ... }  where action is one of:
//     'test'    { host, port, tls? }            → { ok, result: EsTestResult }   (no saved connection)
//     'ping'    { connectionId }                → { ok, result: { latencyMs } }
//     'health'  { connectionId }                → { ok, result: EsHealthResult }
//     'indices' { connectionId }                → { ok, result: EsIndexInfo[] }
//     'nodes'   { connectionId }                → { ok, result: EsNodeInfo[] }   (heap/disk/cpu/load)
//     'mapping' { connectionId, index }         → { ok, result: { json, truncated } }
//     'search'  { connectionId, index, query?, source?, sort?, size?, from? } → { ok, result: EsSearchResult }
//     'count'   { connectionId, index, query? } → { ok, result: { count, tookMs } }
//     'console' { connectionId, method, path, body? } → { ok, result: EsConsoleResult }
//
// There is NO write action — the tool cannot index/delete/change settings.
// 'console' passes a raw REST call through, but only after esClient vets it
// (GET/HEAD/POST only, deny-list of state-changing endpoints, POST restricted
// to read endpoints) — so the read-only guarantee still holds.
// Every search is server-bounded (size ≤200, result window, 15s timeout,
// scripting keys rejected). Gated by ES_TOOL_ENABLED (403 when off).

import { NextResponse, type NextRequest } from 'next/server';
import {
  ES_ENABLED,
  testConnection,
  clusterHealth,
  listIndices,
  listNodes,
  getMapping,
  search,
  count,
  consoleRequest,
} from '@/lib/esClient';
import { getConnection, buildUnsavedConnection } from '@/lib/esConnections';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!ES_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Elasticsearch tool is disabled. Set ES_TOOL_ENABLED=true (local dev only).' },
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

  try {
    let result: unknown;
    switch (action) {
      case 'ping': {
        const r = await testConnection(conn);
        result = { latencyMs: r.latencyMs };
        break;
      }
      case 'health':
        result = await clusterHealth(conn);
        break;
      case 'indices':
        result = await listIndices(conn);
        break;
      case 'nodes':
        result = await listNodes(conn);
        break;
      case 'mapping':
        result = await getMapping(conn, String(body.index ?? ''));
        break;
      case 'search':
        result = await search(conn, String(body.index ?? ''), {
          query: body.query,
          source: body.source,
          sort: body.sort,
          size: body.size,
          from: body.from,
        });
        break;
      case 'count':
        result = await count(conn, String(body.index ?? ''), body.query);
        break;
      case 'console':
        // Lệnh REST thô từ tab Console — read-only được giữ bằng allowlist trong esClient.
        result = await consoleRequest(conn, { method: body.method, path: body.path, body: body.body });
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'Elasticsearch operation failed', detail: String(err) },
      { status: 502 },
    );
  }
}
