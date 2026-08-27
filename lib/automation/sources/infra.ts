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
import { kafkaClusterHealth, kafkaConsumerLag, kafkaHostMetrics, kafkaBrokerReach } from '@/lib/kafka';
import type {
  KafkaBrokerReach, KafkaDnsAnswer, KafkaDnsDiagnosis, KafkaDnsResult, KafkaProtocolProbe,
} from '@/lib/kafka';
import { mongoMonitor } from '@/lib/mongo';
import { pingPg } from '@/lib/pg';
import { listRabbitNodes, rabbitOverview } from '@/lib/rabbit';
import { redisStats } from '@/lib/redis';
import type { AutomationEvent, InfraStack, InfraWatch, WatchSeverity } from '../types';
import type { RateOutcome, WindowOutcome } from '../rate';
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

/**
 * Chi tiết MỘT host broker (từ node_exporter). Giữ lại để cảnh báo nêu đích
 * danh MÁY nào đầy đĩa / hết RAM, chứ không chỉ "một máy nào đó trong cụm".
 */
export interface KafkaHostDetail {
  /** Hostname/IP rút từ URL exporter — nhãn hiển thị. */
  host: string;
  /** Có lấy được số liệu không (false = exporter tắt / timeout / lỗi mạng). */
  reachable: boolean;
  error?: string;
  diskUsedPct: number | null;
  diskFreeGb: number | null;
  /** Mount chật nhất — chỗ thật sự sắp đầy. */
  worstMount: string | null;
  memUsedPct: number | null;
  /** null ở lần đo ĐẦU TIÊN: CPU% cần chênh lệch giữa hai lần đo. */
  cpuPct: number | null;
  load1PerCore: number | null;
}

/** Kết quả một probe: metrics phẳng + (Kafka) chi tiết group + topic bị ảnh hưởng. */
export interface ProbePayload {
  metrics: MetricMap;
  kafkaGroups?: KafkaGroupDetail[];
  /** Kafka: topic có partition under-replicated / offline (từ clusterHealth). */
  affectedTopics?: string[];
  /** Kafka: chi tiết từng host broker (khi cụm có khai metricsUrls). */
  kafkaHosts?: KafkaHostDetail[];
  /** Kafka: bắt tay TCP từng seed broker — chỉ đo khi cụm KHÔNG trả lời. */
  brokerReach?: KafkaBrokerReach[];
  /** Kafka: kết quả hỏi cụm bằng giao thức Kafka (kèm advertised.listeners). */
  kafkaProtocol?: KafkaProtocolProbe;
  /** Kafka: DevBox phân giải hostname bằng DNS nào, ra IP gì. */
  kafkaDns?: KafkaDnsDiagnosis;
}

export interface ProbeResult {
  at: number;
  metrics: MetricMap;
  /** Chỉ Kafka: chi tiết từng group (đã lọc theo groupFilter nếu có) — nguồn của
   *  danh sách group mà watcher đính vào cảnh báo tuỳ theo chỉ số. */
  kafkaGroups?: KafkaGroupDetail[];
  /** Chỉ Kafka: topic bị ảnh hưởng (under-replicated/offline) — cho cảnh báo theo topic. */
  affectedTopics?: string[];
  /** Chỉ Kafka: chi tiết host broker (node_exporter) — cho cảnh báo nêu đích danh máy. */
  kafkaHosts?: KafkaHostDetail[];
  /**
   * Chỉ Kafka, chỉ khi MẤT KẾT NỐI: bắt tay TCP tới từng seed broker. Cho biết
   * node nào chết / cả cụm chết / cổng mở mà Kafka không phục vụ.
   */
  brokerReach?: KafkaBrokerReach[];
  /**
   * Chỉ Kafka: cụm có nói được GIAO THỨC Kafka không (khác hẳn "cổng TCP mở"),
   * kèm advertised.listeners — nguyên nhân kinh điển của "kết nối được mà vẫn hỏng".
   */
  kafkaProtocol?: KafkaProtocolProbe;
  /**
   * Chỉ Kafka: DNS mà DevBox dùng để phân giải hostname (seed khai bằng tên,
   * hoặc advertised.listeners), kèm kết quả từng tên. Trả lời câu hỏi tiếp ngay
   * sau "cụm quảng bá hostname khác": phân giải bằng resolver nào, ra IP gì.
   */
  kafkaDns?: KafkaDnsDiagnosis;
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
  'deadLagGroups',
  'emptyGroups',
  'rebalancingGroups',
  'lagGroupsUnknown',
  'undescribedGroups',
  'maxStalledSec',
  'groups',
]);

/**
 * Chỉ số HOST của broker, lấy từ node_exporter khai trong connection
 * (metricsUrls). Kafka không nói gì về RAM/đĩa/CPU của máy chạy nó — mà đĩa đầy
 * là cách một cụm Kafka chết thường gặp nhất, và im lặng nhất: cluster vẫn
 * "xanh" cho tới đúng lúc broker không ghi được nữa.
 *
 * Cùng cơ chế tiết kiệm như KAFKA_LAG_METRICS: chỉ fetch khi watch thật sự đọc
 * một trong các chỉ số này. Cụm KHÔNG khai metricsUrls thì mọi chỉ số ở đây
 * vắng mặt — watch không bao giờ khớp (metric vắng mặt không được đánh giá,
 * xem watcher.ts), nên bật nhầm cũng không gây báo giả.
 */
export const KAFKA_HOST_METRICS = new Set([
  'hostDiskUsedPct',
  'hostDiskFreeGb',
  'hostMemUsedPct',
  'hostCpuPct',
  'hostLoad1PerCore',
  'hostsDown',
  'hostsTotal',
]);

/**
 * Group đang "active" theo kiểu AKHQ: có consumer sống đang gán/tiêu thụ.
 * 🟢 = Stable + có member → lag đang được xử lý (dù to). 🟡 = ngược lại
 * (Empty/0 member) → lag không ai tiêu thụ, kẹt thật dù nhỏ. Đây là thứ phân
 * biệt "lag vàng/xanh", KHÔNG phải độ lớn của lag.
 */
export function groupActive(state: string, members: number): boolean {
  return members > 0 && /stable/i.test(state);
}

/** Options riêng của từng lần probe — hiện chỉ Kafka dùng (lọc consumer group). */
export interface ProbeOpts {
  /** Chỉ xét các consumer group này (theo groupId). Rỗng/không có = mọi group. */
  groupFilter?: string[];
}

/**
 * Bộ đếm CPU của lần đo TRƯỚC, theo từng URL exporter.
 *
 * node_exporter chỉ trả BỘ ĐẾM TÍCH LUỸ (tổng số giây CPU từ lúc boot), không
 * trả phần trăm. Muốn ra "CPU đang bận bao nhiêu %" phải lấy chênh lệch giữa
 * hai lần đo: busy% = 1 − Δidle/Δtotal. Nên lần đo ĐẦU TIÊN của mỗi host luôn
 * cho cpuPct = null (chưa có mốc so sánh) — watch CPU vì thế bỏ qua vòng đầu
 * rồi mới có số từ vòng thứ hai. Đây là cách duy nhất đúng, cùng công thức mà
 * HealthStrip trên tab Kafka đang dùng.
 *
 * Map ở cấp module: watcher chạy trong một tiến trình client duy nhất, mỗi
 * (cụm, host) chỉ có một dòng, và dọn theo URL nên không phình.
 */
const cpuPrev = new Map<string, { idle: number; total: number; at: number }>();

/**
 * Bộ đếm cũ quá thì bỏ: máy vừa reboot (counter về 0) hoặc watch vừa bị tắt
 * lâu. Lấy chênh lệch qua một quãng dài như thế ra con số vô nghĩa.
 */
const CPU_PREV_MAX_AGE_MS = 15 * 60 * 1000;

/** Đọc node_exporter của mọi broker host và gộp thành chỉ số cụm + chi tiết máy. */
async function kafkaHostPayload(id: string): Promise<{ metrics: MetricMap; hosts: KafkaHostDetail[] }> {
  const raw = await kafkaHostMetrics(id);
  const m: MetricMap = {};
  if (raw.length === 0) return { metrics: m, hosts: [] };

  const now = Date.now();
  const hosts: KafkaHostDetail[] = raw.map((h) => {
    if (h.error) {
      return {
        host: h.host, reachable: false, error: h.error,
        diskUsedPct: null, diskFreeGb: null, worstMount: null,
        memUsedPct: null, cpuPct: null, load1PerCore: null,
      };
    }

    // Đĩa: lấy mount CHẬT NHẤT, không phải mount lớn nhất — chỗ sắp đầy mới là
    // chỗ làm broker chết, dù nó có nhỏ.
    let diskUsedPct: number | null = null;
    let diskFreeGb: number | null = null;
    let worstMount: string | null = null;
    for (const d of h.disks ?? []) {
      if (d.sizeBytes <= 0) continue;
      const usedPct = ((d.sizeBytes - d.availBytes) / d.sizeBytes) * 100;
      if (diskUsedPct === null || usedPct > diskUsedPct) {
        diskUsedPct = round(usedPct);
        diskFreeGb = round(d.availBytes / GB);
        worstMount = d.mount;
      }
    }

    const memUsedPct = h.memTotalBytes && h.memAvailableBytes !== undefined
      ? round(((h.memTotalBytes - h.memAvailableBytes) / h.memTotalBytes) * 100)
      : null;

    // CPU%: cần mốc lần trước (xem ghi chú ở cpuPrev).
    let cpuPct: number | null = null;
    if (h.cpuIdleSec !== undefined && h.cpuTotalSec !== undefined) {
      const prev = cpuPrev.get(h.url);
      if (prev && now - prev.at <= CPU_PREV_MAX_AGE_MS && h.cpuTotalSec > prev.total) {
        const dTotal = h.cpuTotalSec - prev.total;
        const dIdle = h.cpuIdleSec - prev.idle;
        if (dTotal > 0) cpuPct = round(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)));
      }
      cpuPrev.set(h.url, { idle: h.cpuIdleSec, total: h.cpuTotalSec, at: now });
    }

    // load1 quy về MỖI CORE: load 8 trên máy 16 core là nhàn, trên máy 2 core
    // là ngộp — chuẩn hoá rồi thì một ngưỡng (vd 1.5) dùng chung được cho mọi
    // broker dù khác cấu hình. Không đếm được core thì để null thay vì trả
    // load1 thô: một con số mang tên "mỗi core" mà không chia core sẽ khiến
    // người ta đặt ngưỡng sai.
    const load1PerCore = typeof h.load1 === 'number' && h.cpuCores
      ? round(h.load1 / h.cpuCores)
      : null;

    return {
      host: h.host, reachable: true,
      diskUsedPct, diskFreeGb, worstMount, memUsedPct, cpuPct, load1PerCore,
    };
  });

  const live = hosts.filter((h) => h.reachable);
  put(m, 'hostsTotal', hosts.length);
  put(m, 'hostsDown', hosts.length - live.length);
  // Gộp theo máy TỆ NHẤT: một broker đầy đĩa là đủ để cụm gãy, không cần đợi
  // trung bình cả cụm xấu đi.
  put(m, 'hostDiskUsedPct', maxOf(live.map((h) => h.diskUsedPct)));
  put(m, 'hostDiskFreeGb', minOf(live.map((h) => h.diskFreeGb)));
  put(m, 'hostMemUsedPct', maxOf(live.map((h) => h.memUsedPct)));
  put(m, 'hostCpuPct', maxOf(live.map((h) => h.cpuPct)));
  put(m, 'hostLoad1PerCore', maxOf(live.map((h) => h.load1PerCore)));
  return { metrics: m, hosts };
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
      // "Lag không có consumer" (AKHQ vàng): có lag mà KHÔNG group nào đang tiêu
      // thụ (0 member). Sạch hơn stalledGroups — control-record của consumer còn
      // sống (Stable + member) không lọt vào đây.
      put(m, 'deadLagGroups', ok.filter((g) => g.described && g.members === 0 && g.totalLag > 0).length);
      put(m, 'rebalancingGroups', ok.filter((g) => g.described && /rebalanc|preparing/i.test(g.state)).length);
      put(m, 'undescribedGroups', ok.filter((g) => !g.described).length);
    } catch {
      /* cluster health alone still counts as up */
    }
  }

  // Chỉ số HOST của broker (node_exporter). Chỉ chạy khi watch đang hỏi một
  // chỉ số host — hoặc khi không nêu metric (nút "Thử ngay" của trình soạn
  // watch, cần thấy hết những gì cụm này báo được).
  let kafkaHosts: KafkaHostDetail[] | undefined;
  if (metric === undefined || KAFKA_HOST_METRICS.has(metric)) {
    try {
      const hp = await kafkaHostPayload(id);
      Object.assign(m, hp.metrics);
      if (hp.hosts.length) kafkaHosts = hp.hosts;
    } catch {
      /* exporter hỏng không làm cụm thành "down" — chỉ số host vắng mặt là đủ */
    }
  }

  return { metrics: m, kafkaGroups, affectedTopics, kafkaHosts };
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
    return {
      at,
      metrics: payload.metrics,
      kafkaGroups: payload.kafkaGroups,
      affectedTopics: payload.affectedTopics,
      kafkaHosts: payload.kafkaHosts,
    };
  } catch (e) {
    const error = (e as Error).message || 'probe thất bại';
    // MẤT KẾT NỐI KAFKA — đo thêm từng broker trước khi trả về.
    //
    // describeCluster ném MỘT lỗi cho cả cụm, nên nếu dừng ở đây cảnh báo chỉ
    // nói được "Kết nối được 0/1": người trực vẫn phải tự ssh từng máy để biết
    // node nào chết. Một lượt bắt tay TCP (3s, song song) trả lời sẵn câu đó.
    // Bọc try riêng: chẩn đoán hỏng thì vẫn phải báo mất kết nối như cũ.
    if (stack === 'kafka') {
      try {
        const report = await kafkaBrokerReach(connectionId);
        return {
          at,
          metrics: { up: 0 },
          brokerReach: report.brokers,
          kafkaProtocol: report.protocol,
          kafkaDns: report.dns,
          error,
        };
      } catch { /* không chẩn đoán được — vẫn báo mất kết nối */ }
    }
    return { at, metrics: { up: 0 }, error };
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
  /**
   * CHỈ rate watch: kết quả tính trên mọi cửa sổ.
   *
   * Cảnh báo tốc độ mà chỉ nói "vượt ngưỡng" thì vô dụng — người trực cần
   * biết cửa sổ nào, từ bao nhiêu lên bao nhiêu, và (quan trọng nhất) còn bao
   * lâu nữa thì cạn. Watcher là chỗ duy nhất có buffer để tính, nên nó truyền
   * vào đây.
   */
  rate?: RateOutcome;
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
  /**
   * Kafka: các HOST broker liên quan tới cảnh báo host (đĩa/RAM/CPU/load/mất
   * exporter). Nêu đích danh máy nào, vì "đĩa 92%" mà không biết máy nào thì
   * người trực vẫn phải đi dò từng broker.
   */
  breachingHosts?: BreachingHost[];
  /**
   * Kafka, chỉ ca MẤT KẾT NỐI: bắt tay TCP tới từng seed broker. Biến cảnh báo
   * từ "Kết nối được 0/1" thành câu trả lời chẩn đoán được: node nào chết, IP
   * nào, lỗi gì (ECONNREFUSED = máy sống mà Kafka không nghe cổng · timeout =
   * gói đi không tới, thường là mất mạng/VPN hoặc firewall).
   */
  brokerReach?: KafkaBrokerReach[];
  /** Kafka: cụm có nói được giao thức Kafka không + advertised.listeners. */
  kafkaProtocol?: KafkaProtocolProbe;
  /**
   * Kafka: DNS mà DevBox dùng để phân giải hostname + kết quả từng tên. Vì trên
   * container/VPN resolver rất hay khác máy người đang đọc cảnh báo, nên "không
   * phân giải được" mà không nói DNS nào thì người trực không tra được tiếp.
   */
  kafkaDns?: KafkaDnsDiagnosis;
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
  /** AKHQ vàng/xanh: true = còn consumer đang tiêu thụ (Stable + member). */
  active?: boolean;
  state?: string;
  members?: number;
}

/**
 * Một HOST broker liên quan tới cảnh báo host. Chỉ set field có nghĩa với ca
 * đó (đĩa thì có diskUsedPct + mount, CPU thì có cpuPct…) — renderer tự chọn
 * cách hiển thị theo dữ kiện có mặt, cùng lối với BreachingConsumer.
 */
export interface BreachingHost {
  host: string;
  diskUsedPct?: number;
  diskFreeGb?: number;
  /** Mount chật nhất — biết ngay phải đi dọn thư mục nào. */
  mount?: string;
  memUsedPct?: number;
  cpuPct?: number;
  load1PerCore?: number;
  /** Có ca "mất số liệu": exporter không trả lời. */
  unreachable?: boolean;
  error?: string;
}

/** Trần số phần tử đưa vào cảnh báo — metaJson phải gọn dưới một tin Zalo. */
const MAX_ITEMS_IN_ALERT = 20;

/** Nhãn hoạt động AKHQ: 🟢 đang tiêu thụ · 🟡 không consumer · ⚪ không rõ. */
function activityTag(c: BreachingConsumer): string {
  if (c.active === undefined) return '';
  if (c.active) return ' · 🟢 đang tiêu thụ';
  const who = c.state ? `${c.state}` : 'Empty';
  return ` · 🟡 KHÔNG consumer (${who}${c.members !== undefined ? `, ${c.members} member` : ''})`;
}

/** Chuỗi người đọc cho MỘT group, tự chọn dạng theo dữ kiện có mặt. */
function renderConsumer(c: BreachingConsumer): string {
  const lag = c.lag ? ` · lag ${c.lag.toLocaleString('vi-VN')}` : '';
  const topic = c.topic ? ` (${c.topic})` : '';
  const act = activityTag(c);
  if (c.stalledSec !== undefined) return `${c.group}=đứng im ${humanizeSec(c.stalledSec)}${lag}${topic}${act}`;
  if (c.members !== undefined && c.active === undefined) return `${c.group} (${c.members} member${c.state ? `, ${c.state.toLowerCase()}` : ''})`;
  if (c.state !== undefined && c.active === undefined) return `${c.group} (${c.state})`;
  return `${c.group}=${c.lag.toLocaleString('vi-VN')}${topic}${act}`;
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

/** Chuỗi người đọc cho MỘT host, tự chọn dạng theo dữ kiện có mặt. */
function renderHost(h: BreachingHost): string {
  if (h.unreachable) return `${h.host}=không lấy được số liệu${h.error ? ` (${h.error})` : ''}`;
  const bits: string[] = [];
  if (h.diskUsedPct !== undefined) {
    const free = h.diskFreeGb !== undefined ? `, còn ${h.diskFreeGb} GB` : '';
    bits.push(`đĩa ${h.diskUsedPct}%${h.mount ? ` ${h.mount}` : ''}${free}`);
  } else if (h.diskFreeGb !== undefined) {
    bits.push(`đĩa còn ${h.diskFreeGb} GB${h.mount ? ` ${h.mount}` : ''}`);
  }
  if (h.memUsedPct !== undefined) bits.push(`RAM ${h.memUsedPct}%`);
  if (h.cpuPct !== undefined) bits.push(`CPU ${h.cpuPct}%`);
  if (h.load1PerCore !== undefined) bits.push(`load ${h.load1PerCore}/core`);
  return `${h.host}=${bits.join(' · ') || '?'}`;
}

/**
 * Fields liệt kê host broker liên quan. LUÔN trả đủ 3 khoá (rỗng khi không có)
 * — cùng lý do với consumerFields: emission phải ≡ catalog ở mọi stack để
 * check:automation không báo lệch.
 */
function hostFields(extras?: InfraEventExtras): Record<string, string | number> {
  const list = extras?.breachingHosts ?? [];
  if (!list.length) return { hosts: '', hostCount: 0, hostsJson: '' };
  const shown = list.slice(0, MAX_ITEMS_IN_ALERT);
  const more = list.length > shown.length ? ` … (+${list.length - shown.length})` : '';
  return {
    hosts: shown.map(renderHost).join(', ') + more,
    hostCount: list.length,
    hostsJson: JSON.stringify(shown),
  };
}

/**
 * Fields chẩn đoán MẤT KẾT NỐI Kafka: từng seed broker có bắt tay TCP được
 * không. LUÔN trả đủ khoá (rỗng khi không đo) — template tham chiếu
 * {{brokerReach}} không được vỡ ở những cảnh báo khác.
 *
 * `reachSummary` là câu kết luận đọc-là-hiểu, thứ người trực cần nhất lúc 2 giờ
 * sáng: cả cụm chết hay chỉ một node, và nghi ngờ ở đâu.
 */
function brokerReachFields(extras?: InfraEventExtras): Record<string, string | number> {
  const list = extras?.brokerReach ?? [];
  if (!list.length) {
    return {
      brokerReach: '', brokersUp: 0, brokersTotal: 0, reachSummary: '',
      brokerReachJson: '', advertised: '',
      dnsServers: '', dnsResolve: '', dnsJson: '',
    };
  }
  const up = list.filter((b) => b.reachable);
  const down = list.filter((b) => !b.reachable);
  const proto = extras?.kafkaProtocol;
  const dns = extras?.kafkaDns;

  // Mỗi broker một dòng: '192.168.2.218:9092 = TCP mở (2ms)' / '= ECONNREFUSED'.
  const rendered = list.map((b) => (b.reachable
    ? `${b.addr} = TCP mở${b.latencyMs !== undefined ? ` (${b.latencyMs}ms)` : ''}`
    : `${b.addr} = KHÔNG kết nối được${b.error ? ` (${b.error})` : ''}`));

  return {
    brokerReach: rendered.join(' · '),
    brokersUp: up.length,
    brokersTotal: list.length,
    reachSummary: reachSummary(up, down, proto, dns),
    brokerReachJson: JSON.stringify(list),
    // advertised.listeners cụm trả về — rỗng khi cụm không nói được giao thức.
    advertised: (proto?.advertised ?? []).join(', '),
    // DNS: nameserver đang dùng + kết quả phân giải từng hostname. Ca mọi địa chỉ
    // đều là IP thì dnsResolve nói thẳng "KHÔNG CẦN" chứ không để rỗng — rỗng
    // đọc như chưa đo, và người trực sẽ đi tra một hướng đã bị loại trừ.
    dnsServers: (dns?.servers ?? []).join(', '),
    dnsResolve: dns?.hosts.length
      ? dns.hosts.map(renderDnsResult).join(' · ')
      : (dns?.noNames ? 'KHÔNG CẦN — mọi địa chỉ đều là IP thuần' : ''),
    dnsJson: dns ? JSON.stringify(dns) : '',
  };
}

/**
 * 'kafka-1.omicrm.services = 10.0.0.11 (4ms)' / 'kafka-1.omicrm.services = ENOTFOUND'.
 * Ca hỏng in THẲNG mã lỗi, không bọc thêm ngoặc: chuỗi này thường đã nằm trong
 * một cặp ngoặc của câu kết luận, ngoặc lồng ngoặc đọc rất rối.
 *
 * Khi hai đường tra khác nhau thì in CẢ HAI, vì lúc đó chênh lệch chính là phát
 * hiện: tên chỉ chạy được nhờ /etc/hosts của riêng máy DevBox.
 */
function renderDnsResult(d: KafkaDnsResult): string {
  const sys = renderDnsAnswer(d.system);
  if (!d.hostsFileOverride || !d.nameserver) return `${d.host} = ${sys}`;
  return `${d.host} = ${sys} theo getaddrinfo NHƯNG ${renderDnsAnswer(d.nameserver)} khi hỏi thẳng nameserver`;
}

function renderDnsAnswer(a: KafkaDnsAnswer): string {
  if (a.resolved) {
    return `${(a.addresses ?? []).join(', ')}${a.ms !== undefined ? ` (${a.ms}ms)` : ''}`;
  }
  return a.error || 'không phân giải được';
}

/**
 * Kết luận chẩn đoán, dựa trên CẢ HAI phép đo: bắt tay TCP từng broker và một
 * câu hỏi bằng giao thức Kafka. Mỗi ca có HƯỚNG XỬ LÝ khác hẳn nhau — đó là
 * toàn bộ lý do phải đo riêng thay vì chỉ báo "0/1".
 */
function reachSummary(
  up: KafkaBrokerReach[],
  down: KafkaBrokerReach[],
  proto?: KafkaProtocolProbe,
  dns?: KafkaDnsDiagnosis,
): string {
  const total = up.length + down.length;

  // 1) Không cổng nào mở — mạng hoặc cả cụm.
  if (up.length === 0) {
    // Seed khai bằng hostname mà không phân giải được thì KHÔNG phải lỗi mạng:
    // hỏng ngay ở bước tra tên, và nói rõ tra bằng DNS nào mới tra tiếp được.
    const bad = failedDns(dns, [...up, ...down].map((b) => b.host));
    if (bad.length) {
      return `KHÔNG bắt tay TCP được node nào trong ${total} vì KHÔNG PHÂN GIẢI ĐƯỢC TÊN `
        + `(${bad.map(renderDnsResult).join(' · ')})${dnsServerText(dns)} — sửa DNS/hosts trước, `
        + 'chưa phải lỗi Kafka.';
    }
    return `KHÔNG bắt tay TCP được node nào trong ${total} — nghi mất mạng/VPN/firewall từ DevBox, `
      + `hoặc cả cụm cùng chết. Kiểm tra đường mạng trước.${dnsText(dns)}`;
  }

  const tcpPart = down.length
    ? `${down.length}/${total} node không kết nối được (${down.map((b) => b.addr).join(', ')}); ${up.length} node còn TCP bình thường`
    : `Cả ${total} node đều mở cổng TCP`;

  // 2) Cổng mở nhưng KHÔNG nói được giao thức Kafka.
  if (proto && !proto.spoke) {
    // Ca này KHÔNG có advertised.listeners (chưa nói được giao thức thì chưa hỏi
    // được cụm quảng bá gì), nên nếu seed toàn IP thì không tên nào để tra —
    // dnsText nói rõ điều đó thay vì bỏ trống mục DNS.
    return `${tcpPart}, NHƯNG cụm không trả lời câu hỏi Kafka (${proto.error ?? 'không rõ'}) — `
      + 'tiến trình chưa sẵn sàng (đang khởi động / recovery log), mất quorum KRaft-ZooKeeper, '
      + `hoặc thứ đang nghe cổng đó không phải Kafka.${dnsText(dns)}`;
  }

  // 3) Cụm TRẢ LỜI được — nghĩa là lúc probe chính hỏng thì lỗi ở chỗ khác.
  if (proto?.spoke) {
    const bits: string[] = [];
    if (proto.controllerId === null) {
      // Không controller = mất quorum, kể cả khi describeCluster trả lời được.
      bits.push('cụm KHÔNG có controller (mất quorum KRaft/ZooKeeper)');
    }
    // advertised.listeners khác hẳn địa chỉ ta đang gọi là nguyên nhân kinh
    // điển: bắt tay seed OK, nhưng mọi thao tác sau đi tới địa chỉ quảng bá.
    const adv = proto.advertised ?? [];
    const seedHosts = new Set([...up, ...down].map((b) => b.host));
    const advHosts = adv.map((a) => a.slice(0, a.lastIndexOf(':')) || a);
    const mismatch = advHosts.filter((h) => !seedHosts.has(h));
    const mismatched = mismatch.length > 0;
    if (mismatched) {
      // Không dừng ở "NẾU không phân giải được" nữa: ta ĐÃ tra thật, nên nói
      // luôn tra bằng DNS nào và ra IP gì — đó là bước người trực làm tiếp.
      const bad = failedDns(dns, mismatch);
      const advDns = (dns?.hosts ?? []).filter((h) => mismatch.includes(h.host));
      const overridden = overriddenDns(dns, mismatch);
      // Tên mà getaddrinfo trượt NHƯNG nameserver lại có bản ghi: bản ghi DNS
      // không thiếu, hỏng ở tầng phân giải của chính máy DevBox (resolv.conf,
      // systemd-resolved, NSS, hoặc hosts file ghi đè sai). Khuyên "thêm bản ghi
      // DNS" ở ca này là chỉ sai chỗ hoàn toàn.
      const localBroken = bad.filter((h) => h.nameserver?.resolved);
      let tail: string;
      if (localBroken.length && localBroken.length === bad.length) {
        tail = ` và getaddrinfo của DevBox KHÔNG PHÂN GIẢI ĐƯỢC các host đó DÙ NAMESERVER CÓ BẢN GHI `
          + `(${localBroken.map(renderDnsResult).join(' · ')})${dnsServerText(dns)} → bản ghi DNS không `
          + 'thiếu, hỏng ở tầng phân giải của chính máy DevBox: xem /etc/resolv.conf, '
          + 'systemd-resolved/NSS, hoặc một dòng /etc/hosts ghi đè sai';
      } else if (bad.length) {
        tail = ` và DevBox KHÔNG PHÂN GIẢI ĐƯỢC các host đó (${bad.map(renderDnsResult).join(' · ')})`
          + `${dnsServerText(dns)} → đây chính là chỗ hỏng: thêm bản ghi DNS/hosts hoặc sửa `
          + 'advertised.listeners về địa chỉ DevBox tới được';
      } else if (overridden.length) {
        // Phân giải được NHƯNG chỉ nhờ hosts file: chạy trên DevBox mà pod/máy
        // khác sẽ hỏng. Im lặng ở đây là để lại một quả mìn.
        tail = ` — DevBox phân giải được các host đó NHƯNG KHÔNG PHẢI TỪ DNS `
          + `(${overridden.map(renderDnsResult).join(' · ')})${dnsServerText(dns)}: tên đang được `
          + '/etc/hosts (hoặc NSS) của riêng máy DevBox vá tại chỗ, nên máy/pod khác không có bản '
          + 'vá đó sẽ KHÔNG kết nối được — nên thêm bản ghi DNS thật';
      } else if (advDns.length) {
        tail = ` — DevBox phân giải được các host đó (${advDns.map(renderDnsResult).join(' · ')})`
          + `${dnsServerText(dns)}, cả getaddrinfo và hỏi thẳng nameserver đều khớp, nên nếu vẫn `
          + 'hỏng thì là chặn ĐƯỜNG MẠNG tới IP đó (firewall/routing/VPN), không phải DNS';
      } else {
        tail = ' — mọi thao tác sau bước bắt tay đều đi tới đó, nên nếu DevBox không phân giải/không '
          + 'tới được các host này thì kết nối vẫn hỏng dù cổng seed vẫn mở';
      }
      bits.push(`cụm quảng bá địa chỉ KHÁC với địa chỉ DevBox đang gọi (advertised.listeners = `
        + `${adv.join(', ')})${tail}`);
    }
    if (!bits.length) {
      bits.push('cụm trả lời BÌNH THƯỜNG vào lúc chẩn đoán — nhiều khả năng là sự cố thoáng qua '
        + '(mạng chớp, broker vừa restart) và đã tự hồi, hoặc phép đo chính hỏng ở bước nặng hơn '
        + '(metadata toàn bộ topic)');
    }
    // Nhánh mismatch đã tự chèn phần DNS vào bits; các nhánh còn lại thì chưa,
    // nên bù ở đây để mục DNS không bao giờ vắng mặt.
    const dnsTail = mismatched ? '' : dnsText(dns);
    return `${tcpPart}; ${bits.join(' · ')}.${dnsTail}`;
  }

  // 4) Có cổng mở nhưng không hỏi được giao thức (không đo được) — như cũ.
  if (down.length === 0) {
    return `Cả ${total} node đều MỞ cổng TCP nhưng cụm không phục vụ — tiến trình Kafka còn sống mà `
      + 'chưa sẵn sàng (đang khởi động, mất quorum KRaft/ZooKeeper), hoặc advertised.listeners trỏ '
      + `sai địa chỉ mà DevBox không tới được.${dnsText(dns)}`;
  }
  return `${tcpPart} → mạng thông, hỏng ở đúng (các) node kia.${dnsText(dns)}`;
}

/**
 * Các hostname trong `names` mà DevBox tra tên KHÔNG ra IP. Xét đường
 * getaddrinfo, vì đó là đường kafkajs THẬT SỰ đi — nameserver có bản ghi mà
 * getaddrinfo vẫn trượt thì kết nối vẫn hỏng.
 */
function failedDns(dns: KafkaDnsDiagnosis | undefined, names: string[]): KafkaDnsResult[] {
  const want = new Set(names);
  return (dns?.hosts ?? []).filter((h) => want.has(h.host) && !h.system.resolved);
}

/** Các hostname mà hai đường tra KHÔNG khớp — /etc/hosts hoặc NSS đang can thiệp. */
function overriddenDns(dns: KafkaDnsDiagnosis | undefined, names: string[]): KafkaDnsResult[] {
  const want = new Set(names);
  return (dns?.hosts ?? []).filter((h) => want.has(h.host) && h.hostsFileOverride);
}

/**
 * ' (DNS DevBox đang dùng: 10.0.0.2, 8.8.8.8)'. Rỗng khi không đọc được resolver
 * — thà không nói gì còn hơn nói "DNS: " trống làm người đọc tưởng mất cấu hình.
 */
function dnsServerText(dns?: KafkaDnsDiagnosis): string {
  const list = dns?.servers ?? [];
  if (!list.length) return '';
  return ` [DNS DevBox đang dùng: ${list.join(', ')}]`;
}

/** Cả phần DNS cho ca không có mismatch: nameserver + kết quả từng tên. */
function dnsText(dns?: KafkaDnsDiagnosis): string {
  const hosts = dns?.hosts ?? [];
  // Toàn IP thuần: nói thẳng là KHÔNG CÓ GÌ để phân giải, thay vì im lặng. Im
  // lặng ở đây trông y hệt "cảnh báo chưa biết đo DNS", nên người trực vẫn đi
  // tra DNS — một hướng điều tra đã bị loại trừ sẵn.
  if (!hosts.length) return dns?.noNames ? ` ${DNS_NO_NAMES}` : '';
  return ` Phân giải tên: ${hosts.map(renderDnsResult).join(' · ')}.${dnsServerText(dns)}`;
}

/**
 * Ca "không có tên nào": đã đo và kết luận DNS không liên quan. Nói rõ cả lý do
 * (địa chỉ toàn IP) để không ai phải đoán vì sao mục phân giải tên trống.
 */
const DNS_NO_NAMES = 'Phân giải tên: KHÔNG CẦN — mọi địa chỉ đều là IP thuần, '
  + 'không có tên nào để tra, nên DNS chắc chắn không phải nguyên nhân.';

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

/** Cửa sổ đọc thành lời: 300 → "5 phút", 43200 → "12 giờ". */
function fmtWindow(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600} giờ`;
  if (sec % 60 === 0) return `${sec / 60} phút`;
  return `${sec} giây`;
}

/** Đơn vị của con số delta, theo chế độ đo. */
function rateUnit(watch: InfraWatch): string {
  const u = metricDef(watch.stack, watch.metric)?.unit ?? '';
  switch (watch.rate?.mode) {
    case 'points': return 'điểm';
    case 'relative': return '%';
    case 'eta': return 'giờ';
    default: return u;
  }
}

const signed = (n: number): string => (n > 0 ? `+${round(n)}` : `${round(n)}`);

/**
 * Câu mô tả MỘT cửa sổ — đây là thứ người trực thật sự đọc.
 *
 * Luôn nêu HAI ĐẦU MÚT chứ không chỉ con số chênh lệch: "78% → 90%" nói được
 * cả mức độ lẫn hướng đi, còn "+12" thì phải tự tra mới biết đang ở đâu.
 */
function windowText(watch: InfraWatch, w: WindowOutcome): string {
  const unit = metricDef(watch.stack, watch.metric)?.unit ?? '';
  const span = fmtWindow(w.windowSec);
  if (watch.rate?.mode === 'eta') {
    const eta = w.etaSec === null ? 'không xác định' : humanizeSec(w.etaSec);
    return `trong ${span}: ${fmtAbs(w.from, unit)} → ${fmtAbs(w.to, unit)} · sẽ cạn sau ~${eta}`;
  }
  return `trong ${span}: ${fmtAbs(w.from, unit)} → ${fmtAbs(w.to, unit)} (${signed(w.delta)} ${rateUnit(watch)})`;
}

/**
 * Fields của một cảnh báo TỐC ĐỘ.
 *
 * Cùng giao kèo với absText/ladderText: `rateText` MANG SẴN dấu phân cách và
 * rỗng khi không có gì để nói, nên template cũ nhét thêm `{{rateText}}` vào
 * đâu cũng tự gọn.
 *
 * `etaSec`/`etaText` là phần đáng giá nhất: "đĩa mongo1 sẽ đầy sau ~9 giờ" là
 * câu trả lời cho đúng câu hỏi mà người trực đêm đang hỏi, và nó gộp cả tốc độ
 * lẫn phần còn trống — thứ mà một ngưỡng tĩnh không bao giờ nói được.
 */
function rateFields(watch: InfraWatch, extras?: InfraEventExtras): Record<string, string | number> {
  const out = extras?.rate;
  // Watch thường vẫn phát ĐỦ mọi key, chỉ là rỗng — cùng giao kèo với absText:
  // template tham chiếu {{etaText}} không bao giờ gặp undefined, và catalog chỉ
  // phải kể một câu chuyện duy nhất (script check:automation soát điều này).
  if (!out || !isRate(watch)) {
    return {
      rateMode: '', rateWindow: '', rateWindowSec: '', rateFrom: '', rateTo: '',
      rateDelta: '', ratePerHour: '', rateUnit: '', rateSamples: '',
      etaSec: '', etaText: '', rateWindows: '', rateText: '', rateWindowsJson: '',
    };
  }
  const lead = out.lead;
  const hot = out.windows.filter((w) => w.breaching);
  // Liệt kê MỌI cửa sổ đang vượt, không chỉ cái đại diện: ba cửa sổ cùng kêu
  // là tín hiệu khác hẳn một cửa sổ kêu, và người đọc cần thấy điều đó.
  const list = (hot.length ? hot : lead ? [lead] : []).map((w) => windowText(watch, w)).join('; ');
  const eta = lead?.etaSec ?? null;
  return {
    rateMode: watch.rate?.mode ?? '',
    rateWindow: lead ? fmtWindow(lead.windowSec) : '',
    rateWindowSec: lead?.windowSec ?? '',
    rateFrom: lead?.from ?? '',
    rateTo: lead?.to ?? '',
    rateDelta: lead ? round(lead.delta) : '',
    ratePerHour: lead ? round(lead.perHour) : '',
    rateUnit: rateUnit(watch),
    rateSamples: out.samples,
    etaSec: eta ?? '',
    etaText: eta === null ? '' : humanizeSec(eta),
    rateWindows: list,
    rateText: list ? `
${list}` : '',
    // MỌI cửa sổ dưới dạng JSON gọn — `fields` là phẳng (string|number) nên đây
    // là cách duy nhất để AlertMeta dựng lại được toàn cảnh xu hướng cho bot
    // ngoài. Người dùng không đọc field này; nó tồn tại cho máy.
    rateWindowsJson: JSON.stringify(
      out.windows.map((w) => ({
        windowSec: w.windowSec,
        from: w.from,
        to: w.to,
        delta: Number.isFinite(w.delta) ? w.delta : 0,
        threshold: w.threshold,
        breaching: w.breaching,
        ...(w.etaSec === null ? {} : { etaSec: w.etaSec }),
      })),
    ),
  };
}

const isRate = (w: InfraWatch): boolean => w.kind === 'rate';

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
      ...rateFields(watch, extras),
      ...ladderFields(extras),
      ...consumerFields(extras),
      ...topicFields(extras),
      ...hostFields(extras),
      ...brokerReachFields(extras),
    },
  };
}

/** Nhãn dẫn cho danh sách group trong tin, theo chỉ số đang cảnh báo. */
function consumersLead(metric: string): string {
  switch (metric) {
    case 'stalledGroups':
    case 'maxStalledSec':
      return 'Group đứng im';
    case 'deadLagGroups':
      return 'Group có lag nhưng không consumer';
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

/** Nhãn dẫn cho danh sách host broker trong tin, theo chỉ số đang cảnh báo. */
function hostsLead(metric: string): string {
  switch (metric) {
    case 'hostDiskUsedPct':
    case 'hostDiskFreeGb':
      return 'Broker sắp đầy đĩa';
    case 'hostMemUsedPct':
      return 'Broker cạn RAM';
    case 'hostCpuPct':
    case 'hostLoad1PerCore':
      return 'Broker tải cao';
    case 'hostsDown':
      return 'Host không lấy được số liệu';
    default:
      return 'Host broker';
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
  const rate = isRate(watch);
  // Cảnh báo TỐC ĐỘ mở đầu bằng chuyện đang xảy ra (đang tăng nhanh / sắp cạn),
  // không phải bằng con số hiện tại — vì con số hiện tại có thể còn rất bình
  // thường, và đó chính là lý do watch này tồn tại.
  const headline = !rate
    ? `${label} = ${value}`
    : watch.rate?.mode === 'eta'
      ? `${label} sẽ cạn sau ~${base.fields.etaText || '?'}`
      : `${label} tăng ${base.fields.rateDelta} ${base.fields.rateUnit}/${base.fields.rateWindow}`;
  const eta = watch.rate?.mode === 'eta';
  const cond = rate
    ? `${eta ? 'còn lại' : 'tốc độ'} ${OP_TEXT[watch.op]} ${watch.threshold}${eta ? ' giờ' : ''}`
    : `ngưỡng ${OP_TEXT[watch.op]} ${watch.threshold}`;
  return {
    ...base,
    id: `watch:${watch.id}:breach:${at}`,
    type: 'infra.metric',
    title: `${watch.name} — ${headline}`,
    // absText/rateText mang sẵn dấu phân cách khi có, rỗng khi không — tự gọn.
    // consumers/topics (nếu có) nêu đích danh group/topic ngay trong tin mặc định.
    text:
      `${where(watch)}: ${headline} (${cond})` +
      // Với rate, giá trị HIỆN TẠI vẫn phải có mặt: "sẽ đầy sau 6 giờ" mà không
      // nói đang ở 78% thì người đọc không tự đánh giá được mức khẩn cấp.
      (rate ? ` · hiện ${fmtAbs(value, metricDef(watch.stack, watch.metric)?.unit ?? '')}` : '') +
      `${base.fields.absText}${base.fields.rateText}${base.fields.ladderText}` +
      (base.fields.consumers ? `\n${consumersLead(watch.metric)}: ${base.fields.consumers}` : '') +
      (base.fields.topics ? `\nTopic ảnh hưởng: ${base.fields.topics}` : '') +
      (base.fields.hosts ? `\n${hostsLead(watch.metric)}: ${base.fields.hosts}` : ''),
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
    // NGỮ NGHĨA KHÁC HẲN với rate: "hồi phục" ở đây nghĩa là TỐC ĐỘ đã chậm
    // lại, KHÔNG phải chỉ số đã về mức an toàn. Đĩa vẫn 94% mà thôi tăng thì
    // rate watch recover — viết "đã bình thường" vào đó là nói dối người trực,
    // và là đường dẫn thẳng tới bỏ lọt. Nên câu này nêu luôn giá trị hiện tại.
    title: isRate(watch) ? `${watch.name} — tốc độ đã chậm lại` : `${watch.name} — đã hồi phục`,
    text: isRate(watch)
      ? `${where(watch)}: tốc độ thay đổi của ${label} đã về dưới ngưỡng sau ${downSec}s.` +
        ` Chỉ số HIỆN VẪN ở ${fmtAbs(value, metricDef(watch.stack, watch.metric)?.unit ?? '')}${base.fields.absText}`
      : `${where(watch)}: ${label} = ${value}${base.fields.absText}, bình thường trở lại sau ${downSec}s`,
    fields: { ...base.fields, downSec },
  };
}

/**
 * Rate watch bị đặt lại mốc đo vì chỉ số tụt sâu (restart, xoay log, dọn đĩa).
 *
 * Không phải cảnh báo sự cố, nhưng KHÔNG được im: watch vừa mất toàn bộ lịch
 * sử và sẽ nằm "đang gom dữ liệu" một lúc — không nói ra thì đó là một quãng
 * mù không ai giải thích được. Và bản thân "Redis vừa restart lúc 3h sáng"
 * cũng đã là tin đáng biết.
 */
export function infraResetEvent(
  watch: InfraWatch,
  value: number,
  at: number,
  extras?: InfraEventExtras,
): AutomationEvent {
  const label = metricLabel(watch.stack, watch.metric);
  const base = baseEvent(watch, value, at, extras);
  return {
    ...base,
    id: `watch:${watch.id}:reset:${at}`,
    type: 'infra.metric',
    title: `${watch.name} — đã đặt lại mốc đo`,
    text:
      `${where(watch)}: ${label} tụt sâu xuống ${value} (restart / dọn dữ liệu?).` +
      ` Mốc đo tốc độ đã được đặt lại — watch sẽ gom đủ mẫu rồi canh tiếp.`,
    fields: { ...base.fields, alertType: `${watch.stack}.rate.reset`, rateReset: 1 },
  };
}

/**
 * Rate watch nằm "chưa đủ mẫu" quá lâu — tức là đang MÙ.
 *
 * Watchdog cho watchdog, và là cảnh báo phục vụ trực tiếp mục tiêu "không bỏ
 * lọt": một watch không kết luận được thì nhìn từ UI y hệt một watch khoẻ.
 * Nếu chính nó không kêu lên thì không có gì kêu thay nó.
 */
export function infraRateStuckEvent(
  watch: InfraWatch,
  at: number,
  blindSec: number,
  samples: number,
  extras?: InfraEventExtras,
): AutomationEvent {
  const label = metricLabel(watch.stack, watch.metric);
  const base = baseEvent(watch, 0, at, extras);
  return {
    ...base,
    id: `watch:${watch.id}:stuck:${at}`,
    type: 'infra.metric',
    title: `${watch.name} — KHÔNG đo được tốc độ`,
    text:
      `${where(watch)}: watch tốc độ trên ${label} đã ${humanizeSec(blindSec)} không đủ dữ liệu để kết luận` +
      ` (${samples} mẫu). Chỉ số này đang KHÔNG được canh — kiểm tra kết nối hoặc probe.`,
    fields: {
      ...base.fields,
      alertType: `${watch.stack}.rate.stuck`,
      // Mù = không biết gì cả, và "không biết" luôn phải xếp nặng hơn "có vẻ ổn".
      severity: 'critical',
      severityLabel: SEVERITY_LABEL.critical,
      blindSec,
      rateSamples: samples,
    },
  };
}
