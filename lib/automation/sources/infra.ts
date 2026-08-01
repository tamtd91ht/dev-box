'use client';

// DevBox Automation — the INFRASTRUCTURE source.
//
// One probe per stack, each reusing the API client the DevBox already uses for
// its monitor pages — no new backend, no credentials outside the existing
// connection registries. A probe flattens whatever that stack reports into a
// plain `{ metric: number }` map, which is the only thing the watch runner and
// the rule engine ever see. Booleans become 0/1 and unknown values are simply
// absent (an absent metric is never evaluated — see watcher.ts).
//
// Adding a metric = one line here + one entry in catalog.ts. Adding a stack =
// one probe + one StackDef.

import { esHealth, listEsNodes } from '@/lib/es';
import { kafkaClusterHealth } from '@/lib/kafka';
import { mongoMonitor } from '@/lib/mongo';
import { pingPg } from '@/lib/pg';
import { listRabbitNodes, rabbitOverview } from '@/lib/rabbit';
import { redisStats } from '@/lib/redis';
import type { AutomationEvent, InfraStack, InfraWatch } from '../types';
import { metricLabel, stackDef } from '../catalog';

export type MetricMap = Record<string, number>;

export interface ProbeResult {
  at: number;
  metrics: MetricMap;
  /** Probe-level failure (host down, bad credentials…). `metrics.up` is 0 then. */
  error?: string;
}

const MB = 1024 * 1024;
const pct = (used: number, total: number): number | null =>
  total > 0 ? round((used / total) * 100) : null;
const round = (n: number): number => Math.round(n * 100) / 100;

/** Keep only the numbers that are actually numbers. */
function put(map: MetricMap, key: string, value: number | null | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) map[key] = value;
}

const maxOf = (xs: (number | null | undefined)[]): number | null => {
  const ns = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return ns.length ? Math.max(...ns) : null;
};
const minOf = (xs: (number | null | undefined)[]): number | null => {
  const ns = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return ns.length ? Math.min(...ns) : null;
};
const sumOf = (xs: (number | null | undefined)[]): number =>
  xs.reduce<number>((a, x) => a + (typeof x === 'number' && Number.isFinite(x) ? x : 0), 0);

// ── The probes ─────────────────────────────────────────────────────────────

async function probeRedis(id: string): Promise<MetricMap> {
  const nodes = await redisStats(id);
  const m: MetricMap = { up: 1, nodes: nodes.length };
  put(m, 'memUsedMb', round(sumOf(nodes.map((n) => n.usedMemoryBytes)) / MB));
  // A node with maxmemory=0 is bounded by the box instead — use system memory.
  put(m, 'memUsedPct', maxOf(nodes.map((n) => pct(n.usedMemoryBytes, n.maxMemoryBytes || n.systemMemoryBytes))));
  put(m, 'clients', sumOf(nodes.map((n) => n.connectedClients)));
  put(m, 'opsPerSec', sumOf(nodes.map((n) => n.opsPerSec)));
  put(m, 'hitRatePct', minOf(nodes.map((n) => n.hitRatePct))); // worst node wins
  put(m, 'fragmentation', maxOf(nodes.map((n) => n.fragmentationRatio)));
  return m;
}

async function probeMongo(id: string): Promise<MetricMap> {
  const s = await mongoMonitor(id);
  const m: MetricMap = { up: 1 };
  put(m, 'connections', s.connectionsCurrent);
  put(m, 'connectionsUsedPct', pct(s.connectionsCurrent, s.connectionsCurrent + s.connectionsAvailable));
  put(m, 'cacheUsedPct', pct(s.cacheUsedBytes, s.cacheMaxBytes));
  put(m, 'diskUsedPct', s.fsTotalBytes ? pct(s.fsUsedBytes ?? 0, s.fsTotalBytes) : null);
  put(m, 'memResidentMb', round(s.memResidentBytes / MB));
  put(m, 'replLagSec', maxOf(s.members.map((x) => x.lagSec)));
  put(m, 'membersUnhealthy', s.members.filter((x) => !x.healthy).length);
  return m;
}

const ES_STATUS: Record<string, number> = { green: 0, yellow: 1, red: 2 };

async function probeEs(id: string): Promise<MetricMap> {
  const h = await esHealth(id);
  const m: MetricMap = { up: 1 };
  put(m, 'statusLevel', ES_STATUS[(h.status || '').toLowerCase()] ?? 2);
  put(m, 'nodes', h.nodes);
  put(m, 'unassignedShards', h.unassignedShards);
  put(m, 'relocatingShards', h.relocatingShards);
  put(m, 'pendingTasks', h.pendingTasks);
  put(m, 'latencyMs', h.latencyMs);
  // Node-level gauges are a second call: only worth it when the watch asks.
  try {
    const nodes = await listEsNodes(id);
    put(m, 'heapPct', maxOf(nodes.map((n) => n.heapPercent)));
    put(m, 'cpuPct', maxOf(nodes.map((n) => n.cpu)));
    put(m, 'diskUsedPct', maxOf(nodes.map((n) => n.diskUsedPercent)));
    put(m, 'load1m', maxOf(nodes.map((n) => n.load1m)));
  } catch {
    /* cluster health still counts as up */
  }
  return m;
}

async function probeKafka(id: string): Promise<MetricMap> {
  const h = await kafkaClusterHealth(id);
  const m: MetricMap = { up: 1 };
  put(m, 'brokers', h.brokers.length);
  put(m, 'noController', h.controllerId === null ? 1 : 0);
  put(m, 'underReplicated', h.underReplicated);
  put(m, 'offline', h.offline);
  put(m, 'topics', h.topicCount);
  put(m, 'partitions', h.partitionCount);
  return m;
}

async function probeRabbit(id: string): Promise<MetricMap> {
  const o = await rabbitOverview(id);
  const m: MetricMap = { up: 1 };
  put(m, 'messagesReady', o.messages.ready);
  put(m, 'messagesUnacked', o.messages.unacked);
  put(m, 'consumers', o.totals.consumers);
  put(m, 'queues', o.totals.queues);
  put(m, 'publishRate', o.rates.publish);
  put(m, 'latencyMs', o.latencyMs);
  try {
    const nodes = await listRabbitNodes(id);
    put(m, 'nodesDown', nodes.filter((n) => !n.running).length);
    // Either alarm blocks publishers cluster-wide — one node raising it is enough.
    put(m, 'memAlarm', nodes.some((n) => n.memAlarm) ? 1 : 0);
    put(m, 'diskAlarm', nodes.some((n) => n.diskFreeAlarm) ? 1 : 0);
    put(m, 'memUsedPct', maxOf(nodes.map((n) => pct(n.memUsed, n.memLimit))));
    put(m, 'fdUsedPct', maxOf(nodes.map((n) => pct(n.fdUsed, n.fdTotal))));
  } catch {
    /* overview alone still counts as up */
  }
  return m;
}

async function probePg(id: string): Promise<MetricMap> {
  const r = await pingPg(id);
  return { up: 1, latencyMs: round(r.latencyMs) };
}

const PROBES: Record<InfraStack, (connectionId: string) => Promise<MetricMap>> = {
  redis: probeRedis,
  mongo: probeMongo,
  es: probeEs,
  kafka: probeKafka,
  rabbit: probeRabbit,
  pg: probePg,
};

/**
 * Poll one connection. NEVER throws: an unreachable host is itself a signal —
 * it comes back as `up: 0`, which is exactly what a "mất kết nối" watch matches.
 */
export async function probeStack(stack: InfraStack, connectionId: string): Promise<ProbeResult> {
  const at = Date.now();
  const run = PROBES[stack];
  if (!run) return { at, metrics: {}, error: `stack không hỗ trợ: ${stack}` };
  try {
    return { at, metrics: await run(connectionId) };
  } catch (e) {
    return { at, metrics: { up: 0 }, error: (e as Error).message || 'probe thất bại' };
  }
}

// ── Events ─────────────────────────────────────────────────────────────────

const OP_TEXT: Record<InfraWatch['op'], string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
};

/** True when `value op threshold` holds. */
export function breaches(value: number, op: InfraWatch['op'], threshold: number): boolean {
  switch (op) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
    case 'neq':
      return value !== threshold;
    default:
      return false;
  }
}

function baseEvent(watch: InfraWatch, value: number, at: number): Omit<AutomationEvent, 'id' | 'type' | 'title' | 'text'> {
  return {
    ts: at,
    category: 'infra',
    sourceId: watch.stack,
    instanceId: watch.connectionId,
    instanceLabel: watch.connectionLabel || watch.connectionId,
    fields: {
      stack: watch.stack,
      stackLabel: stackDef(watch.stack)?.label ?? watch.stack,
      metric: watch.metric,
      metricLabel: metricLabel(watch.stack, watch.metric),
      value,
      threshold: watch.threshold,
      op: watch.op,
      watch: watch.name,
      watchId: watch.id,
    },
  };
}

const where = (w: InfraWatch): string => `${w.connectionLabel || w.connectionId}`;

/** A watch just breached (and held long enough). */
export function infraBreachEvent(watch: InfraWatch, value: number, at: number): AutomationEvent {
  const label = metricLabel(watch.stack, watch.metric);
  return {
    ...baseEvent(watch, value, at),
    id: `watch:${watch.id}:breach:${at}`,
    type: 'infra.metric',
    title: `${watch.name} — ${label} = ${value}`,
    text: `${where(watch)}: ${label} = ${value} (ngưỡng ${OP_TEXT[watch.op]} ${watch.threshold})`,
  };
}

/** …and the same watch coming back to normal. */
export function infraRecoveredEvent(watch: InfraWatch, value: number, at: number, downSec: number): AutomationEvent {
  const label = metricLabel(watch.stack, watch.metric);
  const base = baseEvent(watch, value, at);
  return {
    ...base,
    id: `watch:${watch.id}:ok:${at}`,
    type: 'infra.recovered',
    title: `${watch.name} — đã hồi phục`,
    text: `${where(watch)}: ${label} = ${value}, bình thường trở lại sau ${downSec}s`,
    fields: { ...base.fields, downSec },
  };
}
