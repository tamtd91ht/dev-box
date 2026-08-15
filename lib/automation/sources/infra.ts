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
import { alertTypeOf, buildDescription, humanizeSec, OP_TEXT } from '../meta';

export type MetricMap = Record<string, number>;

/**
 * Chi tiết MỘT consumer group (chỉ Kafka) — probe giữ lại đủ dữ kiện để MỌI
 * cảnh báo theo group (lag, đứng im, mất member, rebalance, lag unknown) nêu
 * được đích danh group nào + topic nào, không chỉ con số tổng hợp.
 */
export interface KafkaGroupDetail {
  groupId: string;
  lag: number;
  worstTopic: string | null;
  worstTopicLag: number;
  state: string;
  members: number;
  described: boolean;
  partitions: number;
  /** Số giây offset đứng im (còn lag mà không nhích); null = đang chạy/không lag. */
  stalledSec: number | null;
  /** true = lag KHÔNG đọc được (fetchOffsets lỗi) — khác với lag = 0. */
  error: boolean;
}

/** Kết quả một probe: metrics phẳng + (Kafka) chi tiết group + topic bị ảnh hưởng. */
export interface ProbePayload {
  metrics: MetricMap;
  kafkaGroups?: KafkaGroupDetail[];
  /** Kafka: topic có partition under-replicated / offline (từ clusterHealth). */
  affectedTopics?: string[];
}

export interface ProbeResult {
  at: number;
  metrics: MetricMap;
  /** Chỉ Kafka: chi tiết từng group (đã lọc theo groupFilter nếu có) — nguồn của
   *  danh sách group mà watcher đính vào cảnh báo tuỳ theo chỉ số. */
  kafkaGroups?: KafkaGroupDetail[];
  /** Chỉ Kafka: topic bị ảnh hưởng (under-replicated/offline) — cho cảnh báo theo topic. */
  affectedTopics?: string[];
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

async function probeRedis(id: string): Promise<ProbePayload> {
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
  return { metrics: m };
}

async function probeMongo(id: string): Promise<ProbePayload> {
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
  return { metrics: m };
}

const ES_STATUS: Record<string, number> = { green: 0, yellow: 1, red: 2 };

async function probeEs(id: string): Promise<ProbePayload> {
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
  return { metrics: m };
}

/**
 * Metrics that require the consumer-lag sweep. That sweep costs one fetchOffsets
 * per group, so — unlike cluster health — it runs ONLY when the asking watch
 * actually reads one of these. A cluster-health watch polling every 30s must not
 * drag a full lag sweep behind it.
 */
export const KAFKA_LAG_METRICS = new Set([
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

/** Options riêng của từng lần probe — hiện chỉ Kafka dùng (lọc consumer group). */
export interface ProbeOpts {
  /** Chỉ xét các consumer group này (theo groupId). Rỗng/không có = mọi group. */
  groupFilter?: string[];
}

async function probeKafka(id: string, metric?: string, opts?: ProbeOpts): Promise<ProbePayload> {
  const h = await kafkaClusterHealth(id);
  const m: MetricMap = { up: 1 };
  let kafkaGroups: KafkaGroupDetail[] | undefined;
  // Topic có partition under-replicated/offline — cho cảnh báo theo topic nêu
  // đích danh (clusterHealth đã gom sẵn, gột không cần thêm lượt gọi).
  const affectedTopics = h.affectedTopics ?? [];
  put(m, 'brokers', h.brokers.length);
  put(m, 'noController', h.controllerId === null ? 1 : 0);
  put(m, 'underReplicated', h.underReplicated);
  put(m, 'offline', h.offline);
  put(m, 'topics', h.topicCount);
  put(m, 'partitions', h.partitionCount);

  if (metric === undefined || KAFKA_LAG_METRICS.has(metric)) {
    try {
      const lag = await kafkaConsumerLag(id);
      // Watch #2: giới hạn vào đúng các group đã chọn (theo groupId). Rỗng =
      // mọi group (watch #1). Lọc TRƯỚC mọi phép tính bên dưới, nên cùng chỉ số
      // maxConsumerLag nhưng chỉ nhìn tập group này — "1 trong danh sách vượt
      // ngưỡng là báo".
      const filter = opts?.groupFilter;
      const scoped = filter && filter.length
        ? lag.groups.filter((g) => filter.includes(g.groupId))
        : lag.groups;
      // A group whose own fetchOffsets failed has UNKNOWN lag. Counting it as 0
      // would quietly report "no lag" for the one group that may be broken, so
      // it is excluded from the maxima and surfaced as its own metric instead.
      const ok = scoped.filter((g) => !g.error);
      // Giữ chi tiết MỌI group trong phạm vi (kể cả lag=0, kể cả lag unknown):
      // watcher sẽ chọn tập nào tuỳ chỉ số (đứng im, mất member, rebalance…),
      // nên không được lọc sẵn ở đây.
      kafkaGroups = scoped.map((g) => ({
        groupId: g.groupId,
        lag: g.totalLag,
        worstTopic: g.worstTopic,
        worstTopicLag: g.worstTopicLag,
        state: g.state,
        members: g.members,
        described: g.described,
        partitions: g.partitions,
        stalledSec: g.stalledSec,
        error: !!g.error,
      }));
      put(m, 'groups', scoped.length);
      put(m, 'lagGroupsUnknown', scoped.length - ok.length);
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
  return { metrics: m, kafkaGroups, affectedTopics };
}

async function probeRabbit(id: string): Promise<ProbePayload> {
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
  return { metrics: m };
}

async function probePg(id: string): Promise<ProbePayload> {
  const r = await pingPg(id);
  return { metrics: { up: 1, latencyMs: round(r.latencyMs) } };
}

const PROBES: Record<InfraStack, (connectionId: string, metric?: string, opts?: ProbeOpts) => Promise<ProbePayload>> = {
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
  opts?: ProbeOpts,
): Promise<ProbeResult> {
  const at = Date.now();
  const run = PROBES[stack];
  if (!run) return { at, metrics: {}, error: `stack không hỗ trợ: ${stack}` };
  try {
    const payload = await run(connectionId, metric, opts);
    return { at, metrics: payload.metrics, kafkaGroups: payload.kafkaGroups, affectedTopics: payload.affectedTopics };
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
  /**
   * Các bậc NẶNG HƠN cùng nhóm đang bình thường vào lúc watch này phát.
   *
   * Chỉ watcher biết được điều này (nó là chỗ duy nhất thấy cả nhóm cùng lúc),
   * nên nó phải truyền vào chứ không tự suy ra được ở đây. Rỗng/không có =
   * watch này vốn đã là bậc cao nhất → cảnh báo không nhắc gì tới bậc, y như cũ.
   */
  ladderAbove?: { name: string; op: InfraWatch['op']; threshold: number }[];
  /**
   * Kafka: danh sách consumer group LIÊN QUAN tới cảnh báo — tuỳ chỉ số mà là
   * "vượt ngưỡng lag", "đứng im", "mất member", "đang rebalance", "lag unknown".
   * KHÔNG chỉ cái nặng nhất: mọi group thoả điều kiện đều được liệt kê. Watcher
   * tính từ ProbeResult.kafkaGroups; vào cả fields ({{consumers}}) lẫn
   * AlertMeta.consumers (metaJson).
   */
  breachingConsumers?: BreachingConsumer[];
  /** Kafka: topic bị under-replicated/offline — cho cảnh báo theo topic. */
  affectedTopics?: string[];
}

/**
 * Một consumer group liên quan tới cảnh báo. `lag`/`topic` cho ca lag; `stalledSec`
 * cho ca đứng im; `state`/`members` cho ca mất member / rebalance / lag unknown.
 * Chỉ set field có nghĩa với ca đó — renderer tự chọn cách hiển thị theo đó.
 */
export interface BreachingConsumer {
  group: string;
  lag: number;
  topic?: string;
  topicLag?: number;
  stalledSec?: number;
  state?: string;
  members?: number;
}

/** Trần số phần tử đưa vào cảnh báo — metaJson phải gọn dưới một tin Zalo. */
const MAX_ITEMS_IN_ALERT = 20;

/** Chuỗi người đọc cho MỘT group, tự chọn dạng theo dữ kiện có mặt. */
function renderConsumer(c: BreachingConsumer): string {
  const lag = c.lag ? ` · lag ${c.lag.toLocaleString('vi-VN')}` : '';
  const topic = c.topic ? ` (${c.topic})` : '';
  if (c.stalledSec !== undefined) return `${c.group}=đứng im ${humanizeSec(c.stalledSec)}${lag}${topic}`;
  if (c.members !== undefined) return `${c.group} (${c.members} member${c.state ? `, ${c.state.toLowerCase()}` : ''})`;
  if (c.state !== undefined) return `${c.group} (${c.state})`;
  return `${c.group}=${c.lag.toLocaleString('vi-VN')}${topic}`;
}

/**
 * Fields liệt kê consumer group liên quan. LUÔN trả đủ 3 khoá (rỗng khi không
 * có), giống absText/ladderText — nhờ vậy emission ≡ catalog ở MỌI stack và
 * check:automation không báo lệch.
 *
 * `consumers` là bản người đọc, `consumersJson` là bản máy đọc (buildAlertMeta
 * parse thành AlertMeta.consumers), `consumerCount` là TỔNG số thật.
 */
function consumerFields(extras?: InfraEventExtras): Record<string, string | number> {
  const list = extras?.breachingConsumers ?? [];
  if (!list.length) return { consumers: '', consumerCount: 0, consumersJson: '' };
  const shown = list.slice(0, MAX_ITEMS_IN_ALERT);
  const human = shown.map(renderConsumer).join(', ');
  const more = list.length > shown.length ? ` … (+${list.length - shown.length})` : '';
  return {
    consumers: human + more,
    consumerCount: list.length,
    consumersJson: JSON.stringify(shown),
  };
}

/**
 * Fields liệt kê topic bị ảnh hưởng (under-replicated/offline). LUÔN trả đủ 2
 * khoá (rỗng khi không có) — cùng lý do với consumerFields.
 */
function topicFields(extras?: InfraEventExtras): Record<string, string | number> {
  const list = (extras?.affectedTopics ?? []).filter(Boolean);
  if (!list.length) return { topics: '', topicCount: 0 };
  const shown = list.slice(0, MAX_ITEMS_IN_ALERT);
  const more = list.length > shown.length ? ` … (+${list.length - shown.length})` : '';
  return { topics: shown.join(', ') + more, topicCount: list.length };
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

/**
 * Vì sao cảnh báo này là bậc THẤP, khi nhóm còn có bậc cao hơn.
 *
 * Bối cảnh: nâng ngưỡng bậc trên (vd đĩa 93% → 97%) làm nó hết vượt, và bậc
 * dưới (>85%) vốn đang bị che liền lộ ra và phát. Nhìn từ Zalo thì y hệt "sửa
 * ngưỡng xong cảnh báo vẫn để mức cũ" — người nhận không có cách nào biết đây
 * là một watch KHÁC. Câu này nói thẳng điều đó ra.
 *
 * Cùng giao kèo với absText: MANG SẴN dấu phân cách, rỗng khi không có gì để
 * nói, nên `{{ladderText}}` nhét vào template ở đâu cũng tự gọn.
 */
function ladderFields(extras?: InfraEventExtras): Record<string, string | number> {
  const above = extras?.ladderAbove ?? [];
  if (!above.length) return { ladderAbove: '', ladderCount: 0, ladderText: '' };
  // Hầu hết tên watch đã tự mang ngưỡng ("… (>97%)"), nên chỉ nối thêm phần
  // "(> 97)" khi tên KHÔNG nhắc tới con số đó — nếu không thành "…(>97%) (> 97)".
  const list = above
    .map((a) => {
      const named = new RegExp(`(?<![\\d.])${String(a.threshold).replace('.', '\\.')}(?![\\d.])`).test(a.name);
      return named ? a.name : `${a.name} (${OP_TEXT[a.op] ?? a.op} ${a.threshold})`;
    })
    .join(', ');
  return {
    ladderAbove: list,
    ladderCount: above.length,
    ladderText: `\nBậc nặng hơn đang bình thường: ${list}`,
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
      ...ladderFields(extras),
      ...consumerFields(extras),
      ...topicFields(extras),
    },
  };
}

/** Nhãn dẫn cho danh sách group trong tin, theo chỉ số đang cảnh báo. */
function consumersLead(metric: string): string {
  switch (metric) {
    case 'stalledGroups':
    case 'maxStalledSec':
      return 'Group đứng im';
    case 'emptyGroups':
      return 'Group mất consumer';
    case 'rebalancingGroups':
      return 'Group đang rebalance';
    case 'lagGroupsUnknown':
    case 'undescribedGroups':
      return 'Group không đọc được lag';
    default:
      return 'Consumer vượt ngưỡng';
  }
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
    // consumers/topics (nếu có) nêu đích danh group/topic ngay trong tin mặc định.
    text:
      `${where(watch)}: ${label} = ${value} (ngưỡng ${OP_TEXT[watch.op]} ${watch.threshold})` +
      `${base.fields.absText}${base.fields.ladderText}` +
      (base.fields.consumers ? `\n${consumersLead(watch.metric)}: ${base.fields.consumers}` : '') +
      (base.fields.topics ? `\nTopic ảnh hưởng: ${base.fields.topics}` : ''),
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
