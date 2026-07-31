// Server-only RabbitMQ engine — talks to the HTTP MANAGEMENT API (default port
// 15672), NOT AMQP. Rationale (perf-first, dev-centric):
//   • The management API is already aggregated server-side — queue depth,
//     message rates, consumer counts, bindings, connections/channels come back
//     in one cheap GET. No need to open an AMQP connection just to look.
//   • `columns=` trims each response to the fields the UI shows.
//   • Peek uses basic.get with ackmode=reject_requeue_true → NON-DESTRUCTIVE
//     (messages are requeued, nothing is consumed away).
//   • Publish uses the management publish endpoint (dev test messages only).
// No queue/exchange create or delete is exposed. Gated by RABBIT_TOOL_ENABLED.
//
// Every op is bounded: a short AbortController timeout, capped peek count, and a
// truncated payload preview. Credentials come from the server-side registry
// (lib/rabbitConnections) — the browser never sees the password.

import type { RabbitConnection } from './rabbitConnections';

export const RABBIT_ENABLED = /^(1|true|yes|on)$/i.test(process.env.RABBIT_TOOL_ENABLED ?? '');

const REQUEST_TIMEOUT_MS = 15_000;
const PEEK_MAX = 50;
const PAYLOAD_PREVIEW_BYTES = 16_384;
const MAX_PUBLISH_BYTES = 262_144; // 256 KB test-message ceiling

// ── Types returned to the browser ─────────────────────────────────────────────

export interface OverviewResult {
  latencyMs: number;
  version: string;
  node: string;
  clusterName: string;
  erlangVersion: string;
  totals: { queues: number; connections: number; channels: number; consumers: number; exchanges: number };
  messages: { ready: number; unacked: number; total: number };
  rates: { publish: number; deliver: number; ack: number };
}

export interface QueueSummary {
  vhost: string;
  name: string;
  state: string;
  messages: number;
  ready: number;
  unacked: number;
  consumers: number;
  memory: number;
  durable: boolean;
  node: string;
  publishRate: number;
  deliverRate: number;
}

export interface BindingInfo {
  source: string;
  destination: string;
  destinationType: string;
  routingKey: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque hash the management API uses to address ONE binding among several
   * that share source+destination (they differ only by routing key/arguments).
   * Required as the last path segment when deleting a binding.
   */
  propertiesKey: string;
}

export interface QueueConsumer {
  tag: string;
  channel: string;
  ackRequired: boolean;
  prefetch: number;
}

export interface QueueDetail {
  vhost: string;
  name: string;
  state: string;
  durable: boolean;
  autoDelete: boolean;
  exclusive: boolean;
  node: string;
  messages: number;
  ready: number;
  unacked: number;
  consumers: number;
  memory: number;
  publishRate: number;
  deliverRate: number;
  ackRate: number;
  arguments: Record<string, unknown>;
  bindings: BindingInfo[];
  consumerList: QueueConsumer[];
}

export interface ExchangeSummary {
  vhost: string;
  name: string;
  type: string;
  durable: boolean;
  internal: boolean;
  publishInRate: number;
  publishOutRate: number;
  /**
   * Declaration arguments. Carried on the SUMMARY (not just the detail) because
   * the route tester needs `x-delayed-type` to know how an `x-delayed-message`
   * exchange actually routes — and it only ever has the summary list to hand.
   */
  arguments: Record<string, unknown>;
}

export interface ExchangeDetail {
  vhost: string;
  name: string;
  type: string;
  durable: boolean;
  internal: boolean;
  arguments: Record<string, unknown>;
  bindings: BindingInfo[]; // where this exchange is the SOURCE
}

export interface ConnectionInfo {
  name: string;
  user: string;
  state: string;
  channels: number;
  protocol: string;
  peerHost: string;
  vhost: string;
  connectedAtMs: number;
}

export interface RabbitMessage {
  payload: string;
  payloadBytes: number;
  payloadTruncated: boolean;
  encoding: string;
  routingKey: string;
  exchange: string;
  redelivered: boolean;
  properties: Record<string, unknown>;
}

export interface PeekResult {
  messages: RabbitMessage[];
  count: number;
  requeued: boolean;
}

export interface PublishResult {
  routed: boolean;
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

export type Creds = Pick<RabbitConnection, 'nodes' | 'username' | 'password' | 'tls'>;

/** Base URL for a single "host:port" node. */
function nodeUrl(c: Creds, node: string): string {
  return `${c.tls ? 'https' : 'http'}://${node}`;
}

function authHeader(c: Creds): string {
  return 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64');
}

/** True for connection-level failures worth failing over to the next node. */
function isNetworkError(e: unknown): boolean {
  const err = e as { name?: string; code?: string };
  return err?.name === 'AbortError' || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND'
    || err?.code === 'EHOSTUNREACH' || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET';
}

/**
 * If any node points at the AMQP port (5672 / 5671 TLS) instead of the management
 * HTTP port (15672 / 15671), return a corrective hint — this is the #1 cause of an
 * unreachable "management API" and the raw fetch error doesn't explain it.
 */
function amqpPortHint(nodes: string[]): string {
  const amqp = nodes.filter((n) => /:(5672|5671)$/.test(n));
  if (amqp.length === 0) return '';
  const fixed = amqp.map((n) => n.replace(/:5672$/, ':15672').replace(/:5671$/, ':15671'));
  return ` — ${amqp.join(', ')} look like the AMQP port; this tool needs the HTTP management port (use ${fixed.join(', ')})`;
}

/** URL-encode a vhost segment ("/" → "%2F"). */
export function vh(vhost: string): string {
  return encodeURIComponent(vhost === '' ? '/' : vhost);
}

/** Number coercion that treats missing/NaN as 0. */
export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Issue one management-API request, trying each cluster node in order and failing
 * over to the next on a connection-level error (refused/timeout/DNS). An HTTP
 * response — even 4xx/5xx — is treated as authoritative (same creds/data on every
 * node), so 401/404 are NOT retried across nodes. Throws Error(message) with a
 * friendly reason. `path` is the API path incl. leading /api.
 */
export async function mgmt<T>(c: Creds, path: string, init?: RequestInit): Promise<T> {
  const nodes = c.nodes.length ? c.nodes : [''];
  let lastNetErr: unknown = null;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(nodeUrl(c, node) + path, {
        ...init,
        signal: ctrl.signal,
        headers: {
          authorization: authHeader(c),
          'content-type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      lastNetErr = e;
      if (isNetworkError(e) && i < nodes.length - 1) continue; // fail over to next node
      const err = e as { name?: string; code?: string; message?: string };
      if (err.name === 'AbortError') throw new Error(`management API timed out after ${REQUEST_TIMEOUT_MS} ms (tried ${nodes.length} node(s))${amqpPortHint(nodes)}`);
      if (err.code === 'ECONNREFUSED') throw new Error(`connection refused (tried ${nodes.length} node(s): ${nodes.join(', ')})${amqpPortHint(nodes) || ' — is the management plugin enabled on port 15672?'}`);
      throw new Error(`cannot reach management API (tried ${nodes.join(', ')}): ${err.message ?? String(e)}${amqpPortHint(nodes)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw new Error('authentication failed (401) — check username/password');
    if (res.status === 404) throw new Error('not found (404) — check vhost / resource name');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`management API HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  // Every node raised a network error.
  throw new Error(`cannot reach any management node (${nodes.join(', ')}): ${String((lastNetErr as Error)?.message ?? lastNetErr)}${amqpPortHint(nodes)}`);
}

// ── Operations ────────────────────────────────────────────────────────────────

export async function testConnection(c: Creds): Promise<OverviewResult> {
  const t0 = Date.now();
  const ov = await mgmt<Record<string, unknown>>(c, '/api/overview');
  const latencyMs = Date.now() - t0;
  const totals = (ov.object_totals ?? {}) as Record<string, unknown>;
  const qt = (ov.queue_totals ?? {}) as Record<string, unknown>;
  const ms = (ov.message_stats ?? {}) as Record<string, unknown>;
  return {
    latencyMs,
    version: String(ov.rabbitmq_version ?? ov.product_version ?? '?'),
    node: String(ov.node ?? '?'),
    clusterName: String(ov.cluster_name ?? '?'),
    erlangVersion: String(ov.erlang_version ?? '?'),
    totals: {
      queues: num(totals.queues),
      connections: num(totals.connections),
      channels: num(totals.channels),
      consumers: num(totals.consumers),
      exchanges: num(totals.exchanges),
    },
    messages: {
      ready: num(qt.messages_ready),
      unacked: num(qt.messages_unacknowledged),
      total: num(qt.messages),
    },
    rates: {
      publish: num((ms.publish_details as Record<string, unknown>)?.rate),
      deliver: num((ms.deliver_get_details as Record<string, unknown>)?.rate),
      ack: num((ms.ack_details as Record<string, unknown>)?.rate),
    },
  };
}

/** Build the vhost path segment for a list endpoint (conn.vhost filters, else all). */
function listScope(conn: RabbitConnection, resource: 'queues' | 'exchanges'): string {
  return conn.vhost ? `/api/${resource}/${vh(conn.vhost)}` : `/api/${resource}`;
}

export async function listQueues(conn: RabbitConnection): Promise<QueueSummary[]> {
  const cols = [
    'name', 'vhost', 'state', 'messages', 'messages_ready', 'messages_unacknowledged',
    'consumers', 'memory', 'durable', 'node',
    'message_stats.publish_details.rate', 'message_stats.deliver_get_details.rate',
  ].join(',');
  const rows = await mgmt<Record<string, unknown>[]>(conn, `${listScope(conn, 'queues')}?columns=${cols}&disable_stats=false`);
  return (rows ?? []).map((q) => {
    const ms = (q.message_stats ?? {}) as Record<string, unknown>;
    return {
      vhost: String(q.vhost ?? '/'),
      name: String(q.name ?? ''),
      state: String(q.state ?? 'unknown'),
      messages: num(q.messages),
      ready: num(q.messages_ready),
      unacked: num(q.messages_unacknowledged),
      consumers: num(q.consumers),
      memory: num(q.memory),
      durable: !!q.durable,
      node: String(q.node ?? ''),
      publishRate: num((ms.publish_details as Record<string, unknown>)?.rate),
      deliverRate: num((ms.deliver_get_details as Record<string, unknown>)?.rate),
    };
  });
}

export async function describeQueue(conn: RabbitConnection, vhost: string, name: string): Promise<QueueDetail> {
  const q = await mgmt<Record<string, unknown>>(conn, `/api/queues/${vh(vhost)}/${encodeURIComponent(name)}`);
  const bindingsRaw = await mgmt<Record<string, unknown>[]>(conn, `/api/queues/${vh(vhost)}/${encodeURIComponent(name)}/bindings`).catch(() => []);
  const ms = (q.message_stats ?? {}) as Record<string, unknown>;
  const consumers = Array.isArray(q.consumer_details) ? (q.consumer_details as Record<string, unknown>[]) : [];
  return {
    vhost: String(q.vhost ?? vhost),
    name: String(q.name ?? name),
    state: String(q.state ?? 'unknown'),
    durable: !!q.durable,
    autoDelete: !!q.auto_delete,
    exclusive: !!q.exclusive,
    node: String(q.node ?? ''),
    messages: num(q.messages),
    ready: num(q.messages_ready),
    unacked: num(q.messages_unacknowledged),
    consumers: num(q.consumers),
    memory: num(q.memory),
    publishRate: num((ms.publish_details as Record<string, unknown>)?.rate),
    deliverRate: num((ms.deliver_get_details as Record<string, unknown>)?.rate),
    ackRate: num((ms.ack_details as Record<string, unknown>)?.rate),
    arguments: (q.arguments ?? {}) as Record<string, unknown>,
    bindings: (bindingsRaw ?? []).map(mapBinding),
    consumerList: consumers.map((c) => ({
      tag: String(c.consumer_tag ?? ''),
      channel: String((c.channel_details as Record<string, unknown>)?.name ?? ''),
      ackRequired: !!c.ack_required,
      prefetch: num(c.prefetch_count),
    })),
  };
}

export function mapBinding(b: Record<string, unknown>): BindingInfo {
  return {
    source: String(b.source ?? ''),
    destination: String(b.destination ?? ''),
    destinationType: String(b.destination_type ?? ''),
    routingKey: String(b.routing_key ?? ''),
    arguments: (b.arguments ?? {}) as Record<string, unknown>,
    propertiesKey: String(b.properties_key ?? ''),
  };
}

export async function listExchanges(conn: RabbitConnection): Promise<ExchangeSummary[]> {
  const cols = [
    'name', 'vhost', 'type', 'durable', 'internal', 'arguments',
    'message_stats.publish_in_details.rate', 'message_stats.publish_out_details.rate',
  ].join(',');
  const rows = await mgmt<Record<string, unknown>[]>(conn, `${listScope(conn, 'exchanges')}?columns=${cols}`);
  return (rows ?? []).map((x) => {
    const ms = (x.message_stats ?? {}) as Record<string, unknown>;
    return {
      vhost: String(x.vhost ?? '/'),
      name: String(x.name ?? ''),
      type: String(x.type ?? ''),
      durable: !!x.durable,
      internal: !!x.internal,
      publishInRate: num((ms.publish_in_details as Record<string, unknown>)?.rate),
      publishOutRate: num((ms.publish_out_details as Record<string, unknown>)?.rate),
      arguments: (x.arguments ?? {}) as Record<string, unknown>,
    };
  });
}

export async function describeExchange(conn: RabbitConnection, vhost: string, name: string): Promise<ExchangeDetail> {
  const x = await mgmt<Record<string, unknown>>(conn, `/api/exchanges/${vh(vhost)}/${encodeURIComponent(name)}`);
  const bindingsRaw = await mgmt<Record<string, unknown>[]>(conn, `/api/exchanges/${vh(vhost)}/${encodeURIComponent(name)}/bindings/source`).catch(() => []);
  return {
    vhost: String(x.vhost ?? vhost),
    name: String(x.name ?? name),
    type: String(x.type ?? ''),
    durable: !!x.durable,
    internal: !!x.internal,
    arguments: (x.arguments ?? {}) as Record<string, unknown>,
    bindings: (bindingsRaw ?? []).map(mapBinding),
  };
}

export async function listConnections(conn: RabbitConnection): Promise<ConnectionInfo[]> {
  const cols = ['name', 'user', 'state', 'channels', 'protocol', 'peer_host', 'vhost', 'connected_at'].join(',');
  const rows = await mgmt<Record<string, unknown>[]>(conn, `/api/connections?columns=${cols}`);
  return (rows ?? []).map((r) => ({
    name: String(r.name ?? ''),
    user: String(r.user ?? ''),
    state: String(r.state ?? ''),
    channels: num(r.channels),
    protocol: String(r.protocol ?? ''),
    peerHost: String(r.peer_host ?? ''),
    vhost: String(r.vhost ?? '/'),
    connectedAtMs: num(r.connected_at),
  }));
}

/**
 * Peek up to `count` messages from a queue WITHOUT consuming them
 * (ackmode=reject_requeue_true requeues everything). Payloads are truncated for
 * the preview.
 */
export async function peekMessages(conn: RabbitConnection, vhost: string, name: string, count: number): Promise<PeekResult> {
  const n = Math.max(1, Math.min(PEEK_MAX, Math.floor(count) || 10));
  const body = JSON.stringify({
    count: n,
    ackmode: 'reject_requeue_true',
    encoding: 'auto',
    truncate: PAYLOAD_PREVIEW_BYTES,
  });
  const rows = await mgmt<Record<string, unknown>[]>(conn, `/api/queues/${vh(vhost)}/${encodeURIComponent(name)}/get`, {
    method: 'POST',
    body,
  });
  const messages: RabbitMessage[] = (rows ?? []).map((m) => {
    const payload = String(m.payload ?? '');
    const bytes = num(m.payload_bytes) || Buffer.byteLength(payload);
    return {
      payload,
      payloadBytes: bytes,
      payloadTruncated: bytes > PAYLOAD_PREVIEW_BYTES,
      encoding: String(m.payload_encoding ?? 'string'),
      routingKey: String(m.routing_key ?? ''),
      exchange: String(m.exchange ?? ''),
      redelivered: !!m.redelivered,
      properties: (m.properties ?? {}) as Record<string, unknown>,
    };
  });
  return { messages, count: messages.length, requeued: true };
}

/**
 * Publish a test message to an exchange (routing_key routes it). Empty exchange
 * name = the default exchange, which routes by queue name — the easy path for
 * "put a message on this queue". Audited to stdout.
 */
export async function publishMessage(
  conn: RabbitConnection,
  input: { vhost: string; exchange: string; routingKey: string; payload: string; contentType?: string },
): Promise<PublishResult> {
  const bytes = Buffer.byteLength(input.payload ?? '');
  if (bytes > MAX_PUBLISH_BYTES) throw new Error(`payload too large (${bytes} B > ${MAX_PUBLISH_BYTES} B cap)`);
  const properties: Record<string, unknown> = { delivery_mode: 2 }; // persistent
  if (input.contentType) properties.content_type = input.contentType;
  const body = JSON.stringify({
    properties,
    routing_key: input.routingKey,
    payload: input.payload,
    payload_encoding: 'string',
  });
  const res = await mgmt<{ routed?: boolean }>(conn, `/api/exchanges/${vh(input.vhost)}/${encodeURIComponent(input.exchange)}/publish`, {
    method: 'POST',
    body,
  });
  console.log(
    `RABBIT_AUDIT operation=PUBLISH conn=${sanitize(conn.id)} vhost=${sanitize(input.vhost)} exchange=${sanitize(input.exchange || '(default)')} routingKey=${sanitize(input.routingKey)} bytes=${bytes} routed=${!!res?.routed}`,
  );
  return { routed: !!res?.routed };
}

/** Strip control chars so a hostile value can't forge audit-log lines. */
export function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 200);
}
