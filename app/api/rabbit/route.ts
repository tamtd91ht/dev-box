// /api/rabbit — single dispatch route for all RabbitMQ management-API operations.
//
//   POST { action, ... } where action is one of:
//   READ (always allowed when the tool is enabled)
//     'test'            { nodes, username, password, tls }            → OverviewResult (unsaved)
//     'overview'        { connectionId }                              → OverviewResult
//     'listQueues'      { connectionId }                              → QueueSummary[]
//     'describeQueue'   { connectionId, vhost, name }                 → QueueDetail
//     'listExchanges'   { connectionId }                              → ExchangeSummary[]
//     'describeExchange'{ connectionId, vhost, name }                 → ExchangeDetail
//     'listConnections' { connectionId }                              → ConnectionInfo[]
//     'listChannels'    { connectionId }                              → ChannelInfo[]
//     'listNodes'       { connectionId }                              → NodeInfo[]   (RAM/disk/fd + alarms)
//     'clusterHealth'   { connectionId }                              → ClusterHealthResult
//     'listVhosts'      { connectionId }                              → VhostInfo[]
//     'listBindings'    { connectionId, vhost? }                      → BindingInfo[] (route-tester dataset)
//     'aliveness'       { connectionId, vhost }                       → AlivenessResult
//     'diffQueue'       { connectionId, ...QueueDeclaration }         → DeclarationDiff
//     'diffExchange'    { connectionId, ...ExchangeDeclaration }      → DeclarationDiff
//     'peek'            { connectionId, vhost, name, count? }         → PeekResult (non-destructive)
//     'publish'         { connectionId, vhost, exchange, routingKey, payload, contentType? } → PublishResult
//   MUTATING (double-gated — see below)
//     'createQueue' · 'createExchange' · 'createBinding'
//     'purgeQueue'  · 'deleteQueue'    · 'deleteExchange' · 'deleteBinding'
//
// Gated by RABBIT_TOOL_ENABLED (403 when off). The browser never talks to Rabbit
// directly — this server-side handler holds the credentials. Management / network
// errors are caught and returned as { ok:false, error, detail } so the UI can
// render them instead of hanging.
//
// ── Mutating-action gate: TWO independent layers, both must open ──────────────
//  1. RABBIT_ALLOW_DESTRUCTIVE env flag — off by default, covers the whole tool.
//     `create*` counts as mutating: changing the topology of a live cluster is a
//     write even when nothing is deleted.
//  2. Per-connection `readOnly` flag — defaults to TRUE, including for brokers
//     saved before the flag existed (see lib/rabbitConnections.ts), so a
//     production cluster already in .rabbitconnections.json stays locked until
//     someone unlocks it deliberately.
// Neither layer can be satisfied from the request body. A UI typed-confirm modal
// is a third, client-side layer — defence in depth, never a substitute.
//
// 'publish' is deliberately NOT gated: it was already allowed, and sending one
// message is the normal way to verify a route. It is still audit-logged.

import { NextResponse, type NextRequest } from 'next/server';
import {
  RABBIT_ENABLED,
  testConnection,
  listQueues,
  describeQueue,
  listExchanges,
  describeExchange,
  listConnections as listLiveConnections,
  peekMessages,
  publishMessage,
} from '@/lib/rabbitClient';
import {
  listNodes,
  clusterHealth,
  listVhosts,
  listBindings,
  alivenessTest,
  listChannels,
} from '@/lib/rabbitClient.topology';
import {
  createQueue,
  createExchange,
  createBinding,
  purgeQueue,
  deleteQueue,
  deleteExchange,
  deleteBinding,
  diffQueueDeclaration,
  diffExchangeDeclaration,
} from '@/lib/rabbitClient.admin';
import { getConnection, parseNodes, type RabbitConnection } from '@/lib/rabbitConnections';

export const runtime = 'nodejs';

/** Actions that change broker state. Everything here passes the two-layer gate. */
const MUTATING_ACTIONS = new Set([
  'createQueue',
  'createExchange',
  'createBinding',
  'purgeQueue',
  'deleteQueue',
  'deleteExchange',
  'deleteBinding',
]);

const ALLOW_DESTRUCTIVE = process.env.RABBIT_ALLOW_DESTRUCTIVE === 'true';

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on';
}

/** Accept an argument map only if it is a plain object; anything else → {}. */
function argMap(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

function destType(v: unknown): 'queue' | 'exchange' {
  return v === 'exchange' ? 'exchange' : 'queue';
}

/**
 * Both write gates. Returns an error response when either is closed, else null.
 * Messages are in Vietnamese and name the exact flag to flip, because the whole
 * point of a guard is that the operator understands what they are opening.
 */
function checkWriteGate(action: string, conn: RabbitConnection): NextResponse | null {
  if (!MUTATING_ACTIONS.has(action)) return null;

  if (!ALLOW_DESTRUCTIVE) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Thao tác ghi đang bị khoá ở cấp toàn tool. Đặt RABBIT_ALLOW_DESTRUCTIVE=true trong .env.local rồi restart dev server.',
      },
      { status: 403 },
    );
  }

  if (conn.readOnly) {
    return NextResponse.json(
      {
        ok: false,
        error: `Broker "${conn.name}" đang ở chế độ read-only. Mở form sửa broker và bỏ chọn "Read-only" nếu thực sự muốn ghi vào cluster này.`,
      },
      { status: 403 },
    );
  }

  return null;
}

export async function POST(req: NextRequest) {
  if (!RABBIT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'RabbitMQ tool is disabled. Set RABBIT_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  // 'test' probes an unsaved connection — raw creds from the form, no connectionId.
  if (action === 'test') {
    try {
      const nodes = parseNodes(body.nodes);
      if (nodes.length === 0) {
        return NextResponse.json({ ok: false, error: 'at least one node (host:port) is required' }, { status: 400 });
      }
      const result = await testConnection({
        nodes,
        username: String(body.username ?? ''),
        password: String(body.password ?? ''),
        tls: bool(body.tls),
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
  if (!connectionId) return NextResponse.json({ ok: false, error: 'Missing connectionId' }, { status: 400 });

  const conn = await getConnection(connectionId);
  if (!conn) return NextResponse.json({ ok: false, error: `Unknown connection: ${connectionId}` }, { status: 404 });

  const gated = checkWriteGate(action, conn);
  if (gated) return gated;

  if (action === 'publish') {
    const payload = typeof body.payload === 'string' ? body.payload : '';
    const routingKey = typeof body.routingKey === 'string' ? body.routingKey : '';
    if (!payload) return NextResponse.json({ ok: false, error: 'publish requires a payload' }, { status: 400 });
    if (body.exchange !== '' && !routingKey) {
      // With a named exchange a routing key is usually needed; the default ("")
      // exchange routes by queue name so a routing key is still required there.
      return NextResponse.json({ ok: false, error: 'publish requires a routing key' }, { status: 400 });
    }
  }

  try {
    let result: unknown;
    switch (action) {
      // ── Reads ────────────────────────────────────────────────────────────────
      case 'overview':
        result = await testConnection(conn);
        break;
      case 'listQueues':
        result = await listQueues(conn);
        break;
      case 'describeQueue':
        result = await describeQueue(conn, String(body.vhost ?? '/'), String(body.name ?? ''));
        break;
      case 'listExchanges':
        result = await listExchanges(conn);
        break;
      case 'describeExchange':
        result = await describeExchange(conn, String(body.vhost ?? '/'), String(body.name ?? ''));
        break;
      case 'listConnections':
        result = await listLiveConnections(conn);
        break;
      case 'listChannels':
        result = await listChannels(conn);
        break;
      case 'listNodes':
        result = await listNodes(conn);
        break;
      case 'clusterHealth':
        result = await clusterHealth(conn);
        break;
      case 'listVhosts':
        result = await listVhosts(conn);
        break;
      case 'listBindings':
        result = await listBindings(conn, body.vhost === undefined ? undefined : String(body.vhost));
        break;
      case 'aliveness':
        result = await alivenessTest(conn, String(body.vhost ?? ''));
        break;
      case 'diffQueue':
        result = await diffQueueDeclaration(conn, {
          vhost: String(body.vhost ?? '/'),
          name: String(body.name ?? ''),
          durable: bool(body.durable),
          autoDelete: bool(body.autoDelete),
          arguments: argMap(body.arguments),
        });
        break;
      case 'diffExchange':
        result = await diffExchangeDeclaration(conn, {
          vhost: String(body.vhost ?? '/'),
          name: String(body.name ?? ''),
          type: String(body.type ?? 'direct'),
          durable: bool(body.durable),
          autoDelete: bool(body.autoDelete),
          internal: bool(body.internal),
          arguments: argMap(body.arguments),
        });
        break;
      case 'peek':
        result = await peekMessages(conn, String(body.vhost ?? '/'), String(body.name ?? ''), Number(body.count ?? 10));
        break;
      case 'publish':
        result = await publishMessage(conn, {
          vhost: String(body.vhost ?? '/'),
          exchange: String(body.exchange ?? ''),
          routingKey: String(body.routingKey ?? ''),
          payload: String(body.payload ?? ''),
          contentType: body.contentType ? String(body.contentType) : undefined,
        });
        break;

      // ── Mutating (past both gates) ───────────────────────────────────────────
      case 'createQueue':
        result = await createQueue(conn, {
          vhost: String(body.vhost ?? '/'),
          name: String(body.name ?? ''),
          durable: bool(body.durable),
          autoDelete: bool(body.autoDelete),
          arguments: argMap(body.arguments),
        });
        break;
      case 'createExchange':
        result = await createExchange(conn, {
          vhost: String(body.vhost ?? '/'),
          name: String(body.name ?? ''),
          type: String(body.type ?? 'direct'),
          durable: bool(body.durable),
          autoDelete: bool(body.autoDelete),
          internal: bool(body.internal),
          arguments: argMap(body.arguments),
        });
        break;
      case 'createBinding':
        result = await createBinding(conn, {
          vhost: String(body.vhost ?? '/'),
          source: String(body.source ?? ''),
          destination: String(body.destination ?? ''),
          destinationType: destType(body.destinationType),
          routingKey: String(body.routingKey ?? ''),
          arguments: argMap(body.arguments),
        });
        break;
      case 'purgeQueue':
        result = await purgeQueue(conn, String(body.vhost ?? '/'), String(body.name ?? ''));
        break;
      case 'deleteQueue':
        result = await deleteQueue(conn, String(body.vhost ?? '/'), String(body.name ?? ''), {
          ifEmpty: bool(body.ifEmpty),
          ifUnused: bool(body.ifUnused),
        });
        break;
      case 'deleteExchange':
        result = await deleteExchange(conn, String(body.vhost ?? '/'), String(body.name ?? ''), {
          ifUnused: bool(body.ifUnused),
        });
        break;
      case 'deleteBinding':
        result = await deleteBinding(conn, {
          vhost: String(body.vhost ?? '/'),
          source: String(body.source ?? ''),
          destination: String(body.destination ?? ''),
          destinationType: destType(body.destinationType),
          propertiesKey: String(body.propertiesKey ?? ''),
        });
        break;

      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'RabbitMQ operation failed', detail: String(err) },
      { status: 502 },
    );
  }
}
