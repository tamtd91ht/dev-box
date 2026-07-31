// Server-only RabbitMQ topology + cluster-health reads. Split out of
// rabbitClient.ts to keep that file focused on queue/exchange/message ops.
//
// These are the reads a backend dev actually needs when a queue "isn't moving":
//   • listNodes      — RAM / disk / file-descriptor / socket headroom + alarms.
//     A triggered mem_alarm or disk_free_alarm BLOCKS ALL PUBLISHERS cluster-wide.
//     That is the single most common cause of "my producer just hangs" and it is
//     invisible from queue depth alone, which is why it gets first-class UI.
//   • listBindings   — the whole routing graph in one GET, feeding both the
//     binding table and the client-side route tester (lib/rabbitRouting.ts).
//   • clusterHealth  — the modern /api/health/checks/* probes.
//   • alivenessTest  — real publish+consume round-trip on a vhost.
//   • listVhosts     — lets the UI re-scope without editing the saved connection.
//
// Everything here is a plain GET and shares rabbitClient's mgmt() helper, so it
// inherits the multi-node failover, timeout and error-message handling.

import type { RabbitConnection } from './rabbitConnections';
import { mgmt, vh, num, mapBinding, type BindingInfo } from './rabbitClient';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NodeInfo {
  name: string;
  type: string;
  running: boolean;
  /** Publishers are blocked cluster-wide while either alarm is set. */
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
  /** Non-empty = network partition (split brain). */
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

/** A channel, flattened for the connections table (prefetch/unacked live here). */
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

// ── Operations ────────────────────────────────────────────────────────────────

export async function listNodes(conn: RabbitConnection): Promise<NodeInfo[]> {
  // No `columns=` filter here: /api/nodes is a handful of rows and the alarm +
  // watermark fields are exactly what we need, so trimming buys nothing.
  const rows = await mgmt<Record<string, unknown>[]>(conn, '/api/nodes');
  return (rows ?? []).map((n) => ({
    name: String(n.name ?? ''),
    type: String(n.type ?? ''),
    running: n.running !== false,
    memAlarm: !!n.mem_alarm,
    diskFreeAlarm: !!n.disk_free_alarm,
    memUsed: num(n.mem_used),
    memLimit: num(n.mem_limit),
    diskFree: num(n.disk_free),
    diskFreeLimit: num(n.disk_free_limit),
    fdUsed: num(n.fd_used),
    fdTotal: num(n.fd_total),
    socketsUsed: num(n.sockets_used),
    socketsTotal: num(n.sockets_total),
    procUsed: num(n.proc_used),
    procTotal: num(n.proc_total),
    uptimeMs: num(n.uptime),
    partitions: Array.isArray(n.partitions) ? (n.partitions as unknown[]).map(String) : [],
  }));
}

/**
 * Run the management health probes. Each is fetched independently and a failing
 * probe is reported as a failed CHECK, not a failed request — one unhealthy
 * dimension must not blank out the whole panel. A 503 from these endpoints is
 * the documented "unhealthy" signal, so mgmt()'s throw is caught per-check.
 */
export async function clusterHealth(conn: RabbitConnection): Promise<ClusterHealthResult> {
  const probes: { name: string; path: string }[] = [
    { name: 'alarms', path: '/api/health/checks/alarms' },
    { name: 'local-alarms', path: '/api/health/checks/local-alarms' },
    { name: 'port-listener', path: '/api/health/checks/port-listener/5672' },
  ];

  const checks = await Promise.all(
    probes.map(async ({ name, path }): Promise<HealthCheck> => {
      try {
        const r = await mgmt<Record<string, unknown>>(conn, path);
        const status = String(r?.status ?? 'ok');
        return { name, ok: status === 'ok', detail: String(r?.reason ?? status) };
      } catch (e) {
        return { name, ok: false, detail: (e as Error).message };
      }
    }),
  );

  return { ok: checks.every((c) => c.ok), checks };
}

export async function listVhosts(conn: RabbitConnection): Promise<VhostInfo[]> {
  const cols = ['name', 'messages', 'messages_ready', 'messages_unacknowledged'].join(',');
  const rows = await mgmt<Record<string, unknown>[]>(conn, `/api/vhosts?columns=${cols}`);
  return (rows ?? [])
    .map((v) => ({
      name: String(v.name ?? ''),
      messages: num(v.messages),
      messagesReady: num(v.messages_ready),
      messagesUnacked: num(v.messages_unacknowledged),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Full binding graph. Scoped to the connection's vhost when it has one, else
 * cluster-wide. This can be a large response on a busy broker — the UI filters
 * client-side, so we fetch once per view rather than per keystroke.
 */
export async function listBindings(conn: RabbitConnection, vhostOverride?: string): Promise<BindingInfo[]> {
  const scope = vhostOverride ?? conn.vhost;
  const path = scope ? `/api/bindings/${vh(scope)}` : '/api/bindings';
  const rows = await mgmt<Record<string, unknown>[]>(conn, path);
  return (rows ?? []).map(mapBinding);
}

/**
 * Synthetic publish + consume on a vhost — a REAL readiness probe, unlike
 * /api/overview which only proves the management plugin answers. Declares its
 * own temporary queue, so it needs write permission on the vhost.
 */
export async function alivenessTest(conn: RabbitConnection, vhost: string): Promise<AlivenessResult> {
  const target = vhost || conn.vhost || '/';
  try {
    const r = await mgmt<Record<string, unknown>>(conn, `/api/aliveness-test/${vh(target)}`);
    const status = String(r?.status ?? '');
    return { ok: status === 'ok', vhost: target, detail: status || 'không rõ trạng thái' };
  } catch (e) {
    return { ok: false, vhost: target, detail: (e as Error).message };
  }
}

export async function listChannels(conn: RabbitConnection): Promise<ChannelInfo[]> {
  const cols = [
    'name', 'connection_details.name', 'vhost', 'user', 'prefetch_count',
    'messages_unacknowledged', 'messages_unconfirmed', 'consumer_count', 'confirm', 'state',
  ].join(',');
  const rows = await mgmt<Record<string, unknown>[]>(conn, `/api/channels?columns=${cols}`);
  return (rows ?? []).map((c) => ({
    name: String(c.name ?? ''),
    connectionName: String((c.connection_details as Record<string, unknown>)?.name ?? ''),
    vhost: String(c.vhost ?? '/'),
    user: String(c.user ?? ''),
    prefetch: num(c.prefetch_count),
    unacked: num(c.messages_unacknowledged),
    unconfirmed: num(c.messages_unconfirmed),
    consumerCount: num(c.consumer_count),
    confirm: !!c.confirm,
    state: String(c.state ?? ''),
  }));
}
