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
import { kafkaClusterHealth, kafkaConsumerLag } from '@/lib/kafka';
import { mongoMonitor } from '@/lib/mongo';
import { pingPg } from '@/lib/pg';
import { listRabbitNodes, rabbitOverview } from '@/lib/rabbit';
import { redisStats } from '@/lib/redis';
import type { AutomationEvent, InfraStack, InfraWatch, WatchSeverity } from '../types';
import { metricDef, metricLabel, stackDef } from '../catalog';
import { alertTypeOf, buildDescription, OP_TEXT } from '../meta';

export type MetricMap = Record<string, number>;

export interface ProbeResult {
  at: number;
  metrics: MetricMap;
  /** Probe-level failure (host down, bad credentials…). `metrics.up` is 0 then. */
  error?: string;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;
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
  // Mẫu số của memUsedPct — để cảnh báo nói được "90% CỦA BAO NHIÊU".
  put(m, 'memTotalMb', round(sumOf(nodes.map((n) => n.maxMemoryBytes || n.systemMemoryBytes)) / MB));
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
  put(m, 'connectionsTotal', s.connectionsCurrent + s.connectionsAvailable);
  put(m, 'connectionsUsedPct', pct(s.connectionsCurrent, s.connectionsCurrent + s.connectionsAvailable));
  put(m, 'cacheUsedMb', round(s.cacheUsedBytes / MB));
  put(m, 'cacheTotalMb', round(s.cacheMaxBytes / MB));
  put(m, 'cacheUsedPct', pct(s.cacheUsedBytes, s.cacheMaxBytes));
  put(m, 'diskUsedGb', s.fsUsedBytes !== null ? round(s.fsUsedBytes / GB) : null);
  put(m, 'diskTotalGb', s.fsTotalBytes !== null ? round(s.fsTotalBytes / GB) : null);
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
    // Số tuyệt đối của CHÍNH node đầy nhất — cùng node với diskUsedPct, để
    // "92% · còn 40GB" không bao giờ là hai node khác nhau nói chuyện.
    const worst = nodes
      .filter((n) => n.diskUsedPercent !== null && n.diskTotalBytes !== null)
      .sort((a, b) => (b.diskUsedPercent ?? 0) - (a.diskUsedPercent ?? 0))[0];
    if (worst && worst.diskTotalBytes !== null) {
      put(m, 'diskTotalGb', round(worst.diskTotalBytes / GB));
      put(m, 'diskUsedGb', worst.diskAvailBytes !== null ? round((worst.diskTotalBytes - worst.diskAvailBytes) / GB) : null);
    }
  } catch {
    /* cluster health still counts as up */
  }
  return m;
}

/**
 * Metrics that require the consumer-lag sweep. That sweep costs one fetchOffsets
 * per group, so — unlike cluster health — it runs ONLY when the asking watch
 * actually reads one of these. A cluster-health watch polling every 30s must not
 * drag a full lag sweep behind it.
 */
const KAFKA_LAG_METRICS = new Set([
  'maxConsumerLag',
  'totalConsumerLag',
  'stalledGroups',
  'emptyGroups',
  'rebalancingGroups',
  'lagGroupsUnknown',
  'undescribedGroups',
  'maxStalledSec',
  'groups',
]);

async function probeKafka(id: string, metric?: string): Promise<MetricMap> {
  const h = await kafkaClusterHealth(id);
  const m: MetricMap = { up: 1 };
  put(m, 'brokers', h.brokers.length);
  put(m, 'noController', h.controllerId === null ? 1 : 0);
  put(m, 'underReplicated', h.underReplicated);
  put(m, 'offline', h.offline);
  put(m, 'topics', h.topicCount);
  put(m, 'partitions', h.partitionCount);

  if (metric === undefined || KAFKA_LAG_METRICS.has(metric)) {
    try {
      const lag = await kafkaConsumerLag(id);
      // A group whose own fetchOffsets failed has UNKNOWN lag. Counting it as 0
      // would quietly report "no lag" for the one group that may be broken, so
      // it is excluded from the maxima and surfaced as its own metric instead.
      const ok = lag.groups.filter((g) => !g.error);
      put(m, 'groups', lag.groups.length);
      put(m, 'lagGroupsUnknown', lag.groups.length - ok.length);
      put(m, 'maxConsumerLag', maxOf(ok.map((g) => g.totalLag)) ?? 0);
      put(m, 'totalConsumerLag', sumOf(ok.map((g) => g.totalLag)));
      // Stuck = behind AND not moving. Lag alone is not a fault; a group that is
      // catching up is healthy, one frozen at 40k is a dead consumer.
      const stuck = ok.filter((g) => g.totalLag > 0 && g.stalledSec !== null);
      put(m, 'stalledGroups', stuck.length);
      put(m, 'maxStalledSec', maxOf(stuck.map((g) => g.stalledSec)) ?? 0);
      // A group with committed offsets but zero members has no consumer running.
      // `described` guards it: when describeGroups fails (routine mid-rebalance)
      // member counts are UNKNOWN, and treating unknown as zero would fire
      // "no consumer" for every group on the cluster at once.
      put(m, 'emptyGroups', ok.filter((g) => g.described && g.members === 0 && g.partitions > 0).length);
      put(m, 'rebalancingGroups', ok.filter((g) => g.described && /rebalanc|preparing/i.test(g.state)).length);
      put(m, 'undescribedGroups', ok.filter((g) => !g.described).length);
    } catch {
      /* cluster health alone still counts as up */
    }
  }
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
    // Số tuyệt đối của node XẤU NHẤT theo từng chiều — cùng node với con số %.
    const worstMem = [...nodes].sort((a, b) => (pct(b.memUsed, b.memLimit) ?? -1) - (pct(a.memUsed, a.memLimit) ?? -1))[0];
    if (worstMem) {
      put(m, 'memUsedMb', round(worstMem.memUsed / MB));
      put(m, 'memLimitMb', round(worstMem.memLimit / MB));
    }
    const worstFd = [...nodes].sort((a, b) => (pct(b.fdUsed, b.fdTotal) ?? -1) - (pct(a.fdUsed, a.fdTotal) ?? -1))[0];
    if (worstFd) {
      put(m, 'fdUsed', worstFd.fdUsed);
      put(m, 'fdTotal', worstFd.fdTotal);
    }
  } catch {
    /* overview alone still counts as up */
  }
  return m;
}

async function probePg(id: string): Promise<MetricMap> {
  const r = await pingPg(id);
  return { up: 1, latencyMs: round(r.latencyMs) };
}

const PROBES: Record<InfraStack, (connectionId: string, metric?: string) => Promise<MetricMap>> = {
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
 *
 * `metric` is the key the CALLING watch is about to read. A probe may use it to
 * skip an expensive second call nothing will look at (Kafka's lag sweep). Omit it
 * — as the editor's "Thử ngay" does — to collect everything the stack offers.
 */
export async function probeStack(
  stack: InfraStack,
  connectionId: string,
  metric?: string,
): Promise<ProbeResult> {
  const at = Date.now();
  const run = PROBES[stack];
  if (!run) return { at, metrics: {}, error: `stack không hỗ trợ: ${stack}` };
  try {
    return { at, metrics: await run(connectionId, metric) };
  } catch (e) {
    return { at, metrics: { up: 0 }, error: (e as Error).message || 'probe thất bại' };
  }
}

// ── Events ─────────────────────────────────────────────────────────────────

/** What an alert calls itself. Recognition only — never routing. */
const SEVERITY_LABEL: Record<WatchSeverity, string> = {
  critical: '🔴 NGHIÊM TRỌNG',
  warning: '🟠 CẢNH BÁO',
  info: '🔵 THÔNG TIN',
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

/**
 * Dữ kiện chỉ NGƯỜI GỌI mới có — watcher đưa address từ cache danh sách kết
 * nối (connections.ts peekAddress) và CẢ MetricMap của lần poll (để cảnh báo
 * % nói được con số tuyệt đối cùng thời điểm). Optional để đường Test/console
 * cũ vẫn gọi được; thiếu thì field thành '' chứ event không vỡ.
 */
export interface InfraEventExtras {
  address?: string;
  /** Toàn bộ chỉ số của CÙNG lần đo — nguồn của absUsed/absTotal (catalog.absolute). */
  metrics?: MetricMap;
}

/** "3899 MB" → "3.8 GB" khi đáng đọc; số đếm thì thêm dấu phân tách nghìn. */
function fmtAbs(n: number, unit: string): string {
  if (unit === 'MB' && Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} GB`;
  const v = Number.isInteger(n) ? n.toLocaleString('vi-VN') : n.toFixed(1);
  return unit ? `${v} ${unit}` : v;
}

/**
 * Fields tuyệt đối đi kèm một cảnh báo — vì "90%" của 1GB nguy hiểm khác hẳn
 * 90% của 20GB. Cặp used/total do catalog khai (MetricDef.absolute), giá trị
 * lấy từ CÙNG lần đo. Thiếu dữ liệu → mọi field rỗng, absText rỗng: template
 * `{{value}}...{{absText}}` tự gọn lại, không cần điều kiện.
 *
 * `absText` MANG SẴN dấu phân cách đầu chuỗi (" · ") — template engine không có
 * if/else, nên "có thì nối, không thì thôi" phải nằm trong chính giá trị.
 */
function absoluteFields(watch: InfraWatch, extras?: InfraEventExtras): Record<string, string | number> {
  const abs = metricDef(watch.stack, watch.metric)?.absolute;
  const used = abs ? extras?.metrics?.[abs.used] : undefined;
  const total = abs ? extras?.metrics?.[abs.total] : undefined;
  if (!abs || typeof used !== 'number' || typeof total !== 'number' || total <= 0) {
    return { absUsed: '', absTotal: '', absLeft: '', absUnit: '', absText: '' };
  }
  const left = Math.round((total - used) * 100) / 100;
  return {
    absUsed: used,
    absTotal: total,
    absLeft: left,
    absUnit: abs.unit,
    absText: ` · ${fmtAbs(used, abs.unit)} / ${fmtAbs(total, abs.unit)} · còn ${fmtAbs(left, abs.unit)}`,
  };
}

function baseEvent(
  watch: InfraWatch,
  value: number,
  at: number,
  extras?: InfraEventExtras,
): Omit<AutomationEvent, 'id' | 'type' | 'title' | 'text'> {
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
      opText: OP_TEXT[watch.op] ?? watch.op,
      unit: metricDef(watch.stack, watch.metric)?.unit ?? '',
      watch: watch.name,
      watchId: watch.id,
      // Alert identity, for templates ({{fields.severityLabel}}) and conditions.
      // Routing is by watchId — severity never decides which rule runs.
      severity: watch.severity ?? 'warning',
      severityLabel: SEVERITY_LABEL[watch.severity ?? 'warning'],
      tags: (watch.tags ?? []).join(','),
      // Metadata chuẩn hoá (AlertMeta v1, xem meta.ts): máy nào, mã cảnh báo
      // ổn định, tham số đo, và mô tả cơ chế phát hiện tự sinh từ catalog —
      // đủ để một webhook/bot AI hiểu cảnh báo mà không mở DevBox.
      address: extras?.address ?? '',
      alertType: alertTypeOf(watch.stack, watch.metric, watch.op),
      everySec: watch.everySec,
      forSec: watch.forSec ?? 0,
      note: watch.note ?? '',
      description: buildDescription(watch),
      ...absoluteFields(watch, extras),
    },
  };
}

const where = (w: InfraWatch): string => `${w.connectionLabel || w.connectionId}`;

/** A watch just breached (and held long enough). */
export function infraBreachEvent(
  watch: InfraWatch,
  value: number,
  at: number,
  extras?: InfraEventExtras,
): AutomationEvent {
  const label = metricLabel(watch.stack, watch.metric);
  const base = baseEvent(watch, value, at, extras);
  return {
    ...base,
    id: `watch:${watch.id}:breach:${at}`,
    type: 'infra.metric',
    title: `${watch.name} — ${label} = ${value}`,
    // absText mang sẵn " · " đầu chuỗi khi có, rỗng khi không — text tự gọn.
    text: `${where(watch)}: ${label} = ${value} (ngưỡng ${OP_TEXT[watch.op]} ${watch.threshold})${base.fields.absText}`,
  };
}

/** …and the same watch coming back to normal. */
export function infraRecoveredEvent(
  watch: InfraWatch,
  value: number,
  at: number,
  downSec: number,
  extras?: InfraEventExtras,
): AutomationEvent {
  const label = metricLabel(watch.stack, watch.metric);
  const base = baseEvent(watch, value, at, extras);
  return {
    ...base,
    id: `watch:${watch.id}:ok:${at}`,
    type: 'infra.recovered',
    title: `${watch.name} — đã hồi phục`,
    text: `${where(watch)}: ${label} = ${value}${base.fields.absText}, bình thường trở lại sau ${downSec}s`,
    fields: { ...base.fields, downSec },
  };
}
