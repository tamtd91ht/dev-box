// Client-side helpers + shared types for the RabbitMQ workspace. All calls go to
// the same-origin /api/rabbit* routes (the Next server holds the credentials and
// talks to the management API — the browser never sees the password). This file
// is browser-safe: NO `fs`, no server-only imports.

export interface PublicRabbitConnection {
  id: string;
  name: string;
  project: string;
  /** Management-API endpoints "host:port" — one per cluster node (failover order). */
  nodes: string[];
  username: string;
  tls: boolean;
  vhost: string;
  hasPassword: boolean;
  /**
   * Mutating ops blocked on this broker. Defaults to true server-side (including
   * for brokers saved before the flag existed), so the UI must treat a missing
   * value as locked too — never render write buttons as enabled on a guess.
   */
  readOnly: boolean;
}

export interface RabbitConnectionsResponse {
  enabled: boolean;
  connections: PublicRabbitConnection[];
}

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
   * Opaque hash addressing ONE binding among several sharing source+destination.
   * Required as the last path segment when deleting a binding — a binding has no
   * other unique id.
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
   * Declaration arguments, carried on the summary so the route tester can read
   * `x-delayed-type` off an `x-delayed-message` exchange without a detail fetch.
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
  bindings: BindingInfo[];
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

// ── Cluster health / topology ─────────────────────────────────────────────────

/** One cluster node's resource headroom. Mirrors NodeInfo in rabbitClient.topology.ts. */
export interface NodeInfo {
  name: string;
  type: string;
  running: boolean;
  /** Either alarm true ⇒ publishers blocked CLUSTER-WIDE, not just on this node. */
  memAlarm: boolean;
  diskFreeAlarm: boolean;
  memUsed: number;
  memLimit: number;
  diskFree: number;
  diskFreeLimit: number;
  fdUsed: number;
  fdTotal: number;
  socketsUsed: number;
  socketsTotal: number;
  procUsed: number;
  procTotal: number;
  uptimeMs: number;
  partitions: string[];
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ClusterHealthResult {
  ok: boolean;
  checks: HealthCheck[];
}

export interface VhostInfo {
  name: string;
  messages: number;
  messagesReady: number;
  messagesUnacked: number;
}

export interface AlivenessResult {
  ok: boolean;
  vhost: string;
  detail: string;
}

export interface ChannelInfo {
  name: string;
  connectionName: string;
  vhost: string;
  user: string;
  prefetch: number;
  unacked: number;
  unconfirmed: number;
  consumerCount: number;
  confirm: boolean;
  state: string;
}

// ── Declaration diff ──────────────────────────────────────────────────────────

export interface DiffField {
  field: string;
  desired: string;
  actual: string;
  equal: boolean;
}

/**
 * Result of comparing a desired declaration against the broker. `requiresRecreate`
 * is the important one: RabbitMQ cannot alter an existing queue/exchange, so a
 * mismatch means delete + create, never a "Save".
 */
export interface DeclarationDiff {
  exists: boolean;
  identical: boolean;
  requiresRecreate: boolean;
  fields: DiffField[];
}

export interface MutationResult {
  ok: true;
}

export interface QueueDeclarationInput {
  vhost: string;
  name: string;
  durable: boolean;
  autoDelete: boolean;
  arguments: Record<string, unknown>;
}

export interface ExchangeDeclarationInput {
  vhost: string;
  name: string;
  type: string;
  durable: boolean;
  autoDelete: boolean;
  internal: boolean;
  arguments: Record<string, unknown>;
}

export interface BindingDeclarationInput {
  vhost: string;
  source: string;
  destination: string;
  destinationType: 'queue' | 'exchange';
  routingKey: string;
  arguments: Record<string, unknown>;
}

// ── Connection registry (CRUD) ────────────────────────────────────────────────

export async function fetchRabbitConnections(): Promise<RabbitConnectionsResponse> {
  try {
    const r = await fetch('/api/rabbit-connections');
    if (!r.ok) return { enabled: false, connections: [] };
    return (await r.json()) as RabbitConnectionsResponse;
  } catch {
    return { enabled: false, connections: [] };
  }
}

export async function mutateRabbitConnection(
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<PublicRabbitConnection[]> {
  const r = await fetch('/api/rabbit-connections', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { connections: PublicRabbitConnection[] }).connections;
}

// ── RabbitMQ operations ─────────────────────────────────────────────────────────

async function rabbitAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/rabbit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

/** Test a not-yet-saved connection straight from the form. */
export function testRabbitConnection(input: {
  nodes: string[] | string;
  username: string;
  password: string;
  tls: boolean;
}): Promise<OverviewResult> {
  return rabbitAction<OverviewResult>('test', input);
}

/** Overview for a saved connection. */
export function rabbitOverview(connectionId: string): Promise<OverviewResult> {
  return rabbitAction<OverviewResult>('overview', { connectionId });
}

export function listRabbitQueues(connectionId: string): Promise<QueueSummary[]> {
  return rabbitAction<QueueSummary[]>('listQueues', { connectionId });
}

export function describeRabbitQueue(connectionId: string, vhost: string, name: string): Promise<QueueDetail> {
  return rabbitAction<QueueDetail>('describeQueue', { connectionId, vhost, name });
}

export function listRabbitExchanges(connectionId: string): Promise<ExchangeSummary[]> {
  return rabbitAction<ExchangeSummary[]>('listExchanges', { connectionId });
}

export function describeRabbitExchange(connectionId: string, vhost: string, name: string): Promise<ExchangeDetail> {
  return rabbitAction<ExchangeDetail>('describeExchange', { connectionId, vhost, name });
}

export function listRabbitConnectionsLive(connectionId: string): Promise<ConnectionInfo[]> {
  return rabbitAction<ConnectionInfo[]>('listConnections', { connectionId });
}

export function peekRabbitMessages(connectionId: string, vhost: string, name: string, count: number): Promise<PeekResult> {
  return rabbitAction<PeekResult>('peek', { connectionId, vhost, name, count });
}

export function publishRabbitMessage(
  connectionId: string,
  input: { vhost: string; exchange: string; routingKey: string; payload: string; contentType?: string },
): Promise<PublishResult> {
  return rabbitAction<PublishResult>('publish', { connectionId, ...input });
}

// ── Cluster health / topology reads ───────────────────────────────────────────

export function listRabbitNodes(connectionId: string): Promise<NodeInfo[]> {
  return rabbitAction<NodeInfo[]>('listNodes', { connectionId });
}

export function rabbitClusterHealth(connectionId: string): Promise<ClusterHealthResult> {
  return rabbitAction<ClusterHealthResult>('clusterHealth', { connectionId });
}

export function listRabbitVhosts(connectionId: string): Promise<VhostInfo[]> {
  return rabbitAction<VhostInfo[]>('listVhosts', { connectionId });
}

/** Whole binding graph — the dataset the route tester matches against locally. */
export function listRabbitBindings(connectionId: string, vhost?: string): Promise<BindingInfo[]> {
  return rabbitAction<BindingInfo[]>('listBindings', vhost === undefined ? { connectionId } : { connectionId, vhost });
}

/** Real publish+consume round-trip on a vhost — proves the broker accepts traffic. */
export function rabbitAliveness(connectionId: string, vhost: string): Promise<AlivenessResult> {
  return rabbitAction<AlivenessResult>('aliveness', { connectionId, vhost });
}

export function listRabbitChannels(connectionId: string): Promise<ChannelInfo[]> {
  return rabbitAction<ChannelInfo[]>('listChannels', { connectionId });
}

// ── Config check (read-only) ──────────────────────────────────────────────────

export function diffRabbitQueue(connectionId: string, d: QueueDeclarationInput): Promise<DeclarationDiff> {
  return rabbitAction<DeclarationDiff>('diffQueue', { connectionId, ...d });
}

export function diffRabbitExchange(connectionId: string, d: ExchangeDeclarationInput): Promise<DeclarationDiff> {
  return rabbitAction<DeclarationDiff>('diffExchange', { connectionId, ...d });
}

// ── Mutating ops ──────────────────────────────────────────────────────────────
// All of these hit the server's two-layer gate (RABBIT_ALLOW_DESTRUCTIVE +
// per-connection readOnly) and throw with a Vietnamese explanation on 403.

export function createRabbitQueue(connectionId: string, d: QueueDeclarationInput): Promise<MutationResult> {
  return rabbitAction<MutationResult>('createQueue', { connectionId, ...d });
}

export function createRabbitExchange(connectionId: string, d: ExchangeDeclarationInput): Promise<MutationResult> {
  return rabbitAction<MutationResult>('createExchange', { connectionId, ...d });
}

export function createRabbitBinding(connectionId: string, d: BindingDeclarationInput): Promise<MutationResult> {
  return rabbitAction<MutationResult>('createBinding', { connectionId, ...d });
}

export function purgeRabbitQueue(connectionId: string, vhost: string, name: string): Promise<MutationResult> {
  return rabbitAction<MutationResult>('purgeQueue', { connectionId, vhost, name });
}

export function deleteRabbitQueue(
  connectionId: string,
  vhost: string,
  name: string,
  opts: { ifEmpty?: boolean; ifUnused?: boolean } = {},
): Promise<MutationResult> {
  return rabbitAction<MutationResult>('deleteQueue', { connectionId, vhost, name, ...opts });
}

export function deleteRabbitExchange(
  connectionId: string,
  vhost: string,
  name: string,
  opts: { ifUnused?: boolean } = {},
): Promise<MutationResult> {
  return rabbitAction<MutationResult>('deleteExchange', { connectionId, vhost, name, ...opts });
}

export function deleteRabbitBinding(
  connectionId: string,
  d: { vhost: string; source: string; destination: string; destinationType: 'queue' | 'exchange'; propertiesKey: string },
): Promise<MutationResult> {
  return rabbitAction<MutationResult>('deleteBinding', { connectionId, ...d });
}

// ── Formatters ───────────────────────────────────────────────────────────────

export function fmtInt(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US');
}

/** Compact byte size (e.g. 1.4 MB). */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Compact rate (msg/s). */
export function fmtRate(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  return n < 10 ? n.toFixed(1) : Math.round(n).toString();
}

export function fmtTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toLocaleString('sv-SE');
}

/** Display label for a vhost ("" or "/" → "/"). */
export function vhostLabel(v: string): string {
  return v === '' ? '/' : v;
}

/** Uptime as a compact "3d 4h" / "12m" string. */
export function fmtUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** 0..100 usage percentage, clamped. `limit <= 0` (unbounded) → 0. */
export function usagePct(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

/** Gauge severity band. Kept in one place so every gauge colours identically. */
export function gaugeLevel(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}

/**
 * Queue/exchange `x-*` arguments a backend dev reads most, with human labels.
 * Anything not listed still renders — under its raw key — so nothing is hidden.
 */
export const ARG_LABELS: Record<string, string> = {
  'x-queue-type': 'Queue type',
  'x-dead-letter-exchange': 'Dead-letter exchange (DLX)',
  'x-dead-letter-routing-key': 'Dead-letter routing key',
  'x-message-ttl': 'Message TTL (ms)',
  'x-expires': 'Queue expires after (ms)',
  'x-max-length': 'Max length (messages)',
  'x-max-length-bytes': 'Max length (bytes)',
  'x-overflow': 'Overflow behaviour',
  'x-max-priority': 'Max priority',
  'x-single-active-consumer': 'Single active consumer',
  'x-delivery-limit': 'Delivery limit',
  'x-quorum-initial-group-size': 'Quorum group size',
  'alternate-exchange': 'Alternate exchange',
  'x-match': 'Header match mode',
};

export function argLabel(key: string): string {
  return ARG_LABELS[key] ?? key;
}

/** Render an argument value for display without hiding its type. */
export function fmtArgValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
