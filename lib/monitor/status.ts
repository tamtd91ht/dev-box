// DevBox Monitor — luật đánh giá sức khoẻ MỘT tài nguyên hạ tầng.
//
// Thuần dữ liệu + hàm thuần (không React, không I/O) để kiểm bằng script
// (check:monitor) và để UI chỉ việc vẽ. Đầu vào là `ProbeResult` mà
// `probeStack()` của Automation đã trả — Monitor KHÔNG có đường thu thập số liệu
// riêng, nên thấy gì trên Automation thì thấy đúng thế ở đây.
//
// Mức độ (Level), nặng → nhẹ:
//   down     mất kết nối (probe lỗi / up = 0)
//   crit     đang hỏng hoặc sắp hỏng (đỏ)
//   warn     cần để mắt (vàng)
//   ok       bình thường (xanh)
//   unknown  chưa có lần đo nào
//
// Mỗi luật = một chỉ số + hướng so sánh + ngưỡng vàng/đỏ. Ngưỡng mặc định ở
// RULES; người dùng ghi đè từng ngưỡng qua `Overrides` (lưu localStorage ở UI).

import type { InfraStack } from '@/lib/automation/types';
import type { ProbeResult } from '@/lib/automation/sources/infra';

export type Level = 'ok' | 'warn' | 'crit' | 'down' | 'unknown';

/** Mức nặng hơn có số lớn hơn — dùng để gộp (worst-wins) và sắp xếp. */
export const LEVEL_RANK: Record<Level, number> = { unknown: 0, ok: 1, warn: 2, crit: 3, down: 4 };

export const LEVEL_LABEL: Record<Level, string> = {
  ok: 'Bình thường',
  warn: 'Cảnh báo',
  crit: 'Nghiêm trọng',
  down: 'Mất kết nối',
  unknown: 'Chưa đo',
};

export const worst = (a: Level, b: Level): Level => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);

export const STACK_ORDER: InfraStack[] = ['redis', 'kafka', 'rabbit', 'mongo', 'es', 'pg'];

export const STACK_META: Record<InfraStack, { label: string; /** Nhãn ngắn cho nút lọc trên thanh. */ short: string; icon: string; tab: string }> = {
  redis: { label: 'Redis', short: 'Redis', icon: '◆', tab: 'redis' },
  kafka: { label: 'Kafka', short: 'Kafka', icon: '≋', tab: 'kafka' },
  rabbit: { label: 'RabbitMQ', short: 'Rabbit', icon: '🐇', tab: 'rabbit' },
  mongo: { label: 'MongoDB', short: 'Mongo', icon: '🍃', tab: 'mongo' },
  es: { label: 'Elastic', short: 'ES', icon: '🔍', tab: 'es' },
  pg: { label: 'PostgreSQL', short: 'Postgre', icon: '🐘', tab: 'pg' },
};

/**
 * Thứ tự loại do người dùng chọn → thứ tự đầy đủ, hợp lệ: bỏ khoá lạ/trùng,
 * loại còn thiếu (vd bản sau thêm stack mới) nối vào cuối theo thứ tự mặc định.
 */
export function normOrder(saved: unknown): InfraStack[] {
  const out: InfraStack[] = [];
  if (Array.isArray(saved)) {
    for (const x of saved) {
      if (STACK_ORDER.includes(x as InfraStack) && !out.includes(x as InfraStack)) out.push(x as InfraStack);
    }
  }
  for (const s of STACK_ORDER) if (!out.includes(s)) out.push(s);
  return out;
}

// ── Luật ───────────────────────────────────────────────────────────────────

export type Unit = '%' | 'ms' | 's' | 'MB' | 'GB' | '' | '/s';

export interface Rule {
  metric: string;
  label: string;
  unit: Unit;
  /** gt: càng LỚN càng xấu · lt: càng NHỎ càng xấu. */
  dir: 'gt' | 'lt';
  /** Vượt ngưỡng này → vàng. */
  warn?: number;
  /** Vượt ngưỡng này → đỏ. */
  crit?: number;
  /** Chỉ số trạng thái (0/1/2…) — hiển thị chữ thay vì số, và lời giải thích riêng. */
  say?: (value: number) => string;
  /** Câu giải thích NGUYÊN NHÂN khi vi phạm (thêm vào sau "label = value"). */
  why?: string;
}

const ES_STATUS_TEXT = ['green', 'yellow', 'red'];

/**
 * Luật theo stack. Thứ tự = thứ tự hiện ở bảng ngưỡng. Mọi chỉ số đều là key mà
 * `probeStack` thật sự phát ra (xem sources/infra.ts); chỉ số vắng mặt thì bỏ qua,
 * nên luật cho chỉ số tuỳ chọn (host Kafka, node ES) không bao giờ báo giả.
 */
export const RULES: Record<InfraStack, Rule[]> = {
  redis: [
    { metric: 'memUsedPct', label: 'RAM đã dùng', unit: '%', dir: 'gt', warn: 80, crit: 90, why: 'Gần chạm maxmemory — sắp evict key hoặc từ chối ghi.' },
    { metric: 'fragmentation', label: 'Phân mảnh bộ nhớ', unit: '', dir: 'gt', warn: 1.8, crit: 3, why: 'RSS lớn hơn nhiều so với dữ liệu thật.' },
    { metric: 'hitRatePct', label: 'Hit rate', unit: '%', dir: 'lt', warn: 50, why: 'Phần lớn truy vấn trượt cache.' },
    { metric: 'clients', label: 'Client đang kết nối', unit: '', dir: 'gt', warn: 5000, crit: 9000, why: 'Gần chạm maxclients.' },
  ],
  kafka: [
    { metric: 'noController', label: 'Controller', unit: '', dir: 'gt', crit: 0, say: (v) => (v ? 'không có' : 'có'), why: 'Cụm không có controller — mất quorum, không bầu được leader.' },
    { metric: 'offline', label: 'Partition offline', unit: '', dir: 'gt', crit: 0, why: 'Partition không có leader — producer/consumer topic đó bị chặn.' },
    { metric: 'underReplicated', label: 'Partition under-replicated', unit: '', dir: 'gt', warn: 0, crit: 50, why: 'Replica tụt lại sau leader — mất 1 broker nữa có thể mất dữ liệu.' },
    { metric: 'maxConsumerLag', label: 'Lag lớn nhất của một group', unit: '', dir: 'gt', warn: 10_000, crit: 100_000, why: 'Consumer xử lý không kịp tốc độ producer.' },
    { metric: 'deadLagGroups', label: 'Group có lag nhưng không consumer', unit: '', dir: 'gt', warn: 0, why: 'Có lag mà không ai tiêu thụ (0 member) — consumer đã chết/tắt.' },
    { metric: 'stalledGroups', label: 'Group đứng im', unit: '', dir: 'gt', warn: 0, why: 'Có message chờ lâu mà chưa được commit.' },
    { metric: 'maxStalledSec', label: 'Message chờ lâu nhất', unit: 's', dir: 'gt', warn: 300, crit: 1800 },
    { metric: 'lagGroupsUnknown', label: 'Group không đọc được lag', unit: '', dir: 'gt', warn: 0, why: 'fetchOffsets lỗi — lag của group này là ẩn số, không phải 0.' },
    { metric: 'hostsDown', label: 'Host broker mất exporter', unit: '', dir: 'gt', warn: 0, why: 'node_exporter không trả lời — không đo được đĩa/RAM/CPU.' },
    { metric: 'hostDiskUsedPct', label: 'Đĩa broker đầy nhất', unit: '%', dir: 'gt', warn: 80, crit: 90, why: 'Đĩa đầy là cách Kafka chết im lặng nhất — broker ngừng ghi.' },
    { metric: 'hostMemUsedPct', label: 'RAM host broker', unit: '%', dir: 'gt', warn: 90, crit: 95 },
    { metric: 'hostCpuPct', label: 'CPU host broker', unit: '%', dir: 'gt', warn: 85, crit: 95 },
    { metric: 'hostLoad1PerCore', label: 'Load/core host broker', unit: '', dir: 'gt', warn: 1.5, crit: 3 },
  ],
  rabbit: [
    { metric: 'nodesDown', label: 'Node không chạy', unit: '', dir: 'gt', crit: 0, why: 'Một node của cụm đã dừng.' },
    { metric: 'memAlarm', label: 'Cảnh báo RAM', unit: '', dir: 'gt', crit: 0, say: (v) => (v ? 'đang kêu' : 'không'), why: 'Memory alarm — RabbitMQ chặn mọi publisher.' },
    { metric: 'diskAlarm', label: 'Cảnh báo đĩa', unit: '', dir: 'gt', crit: 0, say: (v) => (v ? 'đang kêu' : 'không'), why: 'Disk free alarm — RabbitMQ chặn mọi publisher.' },
    { metric: 'memUsedPct', label: 'RAM đã dùng', unit: '%', dir: 'gt', warn: 70, crit: 90, why: 'Tiến gần ngưỡng memory high watermark.' },
    { metric: 'fdUsedPct', label: 'File descriptor đã dùng', unit: '%', dir: 'gt', warn: 80, crit: 90, why: 'Hết FD là không nhận thêm kết nối được.' },
    { metric: 'messagesReady', label: 'Message sẵn sàng (tồn)', unit: '', dir: 'gt', warn: 10_000, crit: 100_000, why: 'Queue tồn đọng — consumer chậm hoặc đã dừng.' },
    { metric: 'messagesUnacked', label: 'Message chưa ack', unit: '', dir: 'gt', warn: 5_000, crit: 50_000, why: 'Consumer nhận mà không ack — có thể treo.' },
    { metric: 'latencyMs', label: 'Độ trễ API', unit: 'ms', dir: 'gt', warn: 1000, crit: 3000 },
  ],
  mongo: [
    { metric: 'membersUnhealthy', label: 'Member không khoẻ', unit: '', dir: 'gt', crit: 0, why: 'Một member của replica set không healthy.' },
    { metric: 'replLagSec', label: 'Replication lag', unit: 's', dir: 'gt', warn: 10, crit: 60, why: 'Secondary tụt sau primary.' },
    { metric: 'connectionsUsedPct', label: 'Kết nối đã dùng', unit: '%', dir: 'gt', warn: 80, crit: 90, why: 'Gần hết slot kết nối.' },
    { metric: 'diskUsedPct', label: 'Đĩa đã dùng', unit: '%', dir: 'gt', warn: 80, crit: 90, why: 'Đĩa dữ liệu sắp đầy.' },
    { metric: 'cacheUsedPct', label: 'WiredTiger cache', unit: '%', dir: 'gt', warn: 95, crit: 99, why: 'Cache đầy liên tục — working set lớn hơn RAM.' },
  ],
  es: [
    { metric: 'statusLevel', label: 'Trạng thái cụm', unit: '', dir: 'gt', warn: 0, crit: 1, say: (v) => ES_STATUS_TEXT[v] ?? '?', why: 'yellow: thiếu replica · red: có primary shard chưa được gán.' },
    { metric: 'unassignedShards', label: 'Shard chưa gán', unit: '', dir: 'gt', warn: 0, why: 'Shard không có node nào giữ — dữ liệu chưa sẵn sàng hoặc thiếu replica.' },
    { metric: 'heapPct', label: 'JVM heap', unit: '%', dir: 'gt', warn: 85, crit: 95, why: 'Heap đầy — GC dài, nguy cơ OOM.' },
    { metric: 'diskUsedPct', label: 'Đĩa node đầy nhất', unit: '%', dir: 'gt', warn: 80, crit: 90, why: 'Chạm watermark là ES khoá index (read-only).' },
    { metric: 'cpuPct', label: 'CPU node bận nhất', unit: '%', dir: 'gt', warn: 85, crit: 95 },
    { metric: 'pendingTasks', label: 'Cluster task chờ', unit: '', dir: 'gt', warn: 20, crit: 100, why: 'Master xử lý cluster-state không kịp.' },
    { metric: 'latencyMs', label: 'Độ trễ API', unit: 'ms', dir: 'gt', warn: 1000, crit: 3000 },
  ],
  pg: [
    { metric: 'latencyMs', label: 'Độ trễ (SELECT 1)', unit: 'ms', dir: 'gt', warn: 500, crit: 2000, why: 'Server phản hồi chậm bất thường.' },
  ],
};

/** Ghi đè ngưỡng: khoá `stack.metric` → {warn?, crit?} (undefined = giữ mặc định, null = bỏ ngưỡng đó). */
export type Overrides = Record<string, { warn?: number | null; crit?: number | null }>;

export const overrideKey = (stack: InfraStack, metric: string): string => `${stack}.${metric}`;

/** Luật sau khi áp ghi đè của người dùng. */
export function effectiveRule(stack: InfraStack, rule: Rule, ov?: Overrides): Rule {
  const o = ov?.[overrideKey(stack, rule.metric)];
  if (!o) return rule;
  const pick = (own: number | null | undefined, base: number | undefined): number | undefined =>
    own === null ? undefined : own === undefined ? base : own;
  return { ...rule, warn: pick(o.warn, rule.warn), crit: pick(o.crit, rule.crit) };
}

// ── Định dạng ──────────────────────────────────────────────────────────────

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return String(+n.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2));
}

export function fmtValue(value: number, unit: Unit, say?: (v: number) => string): string {
  if (say) return say(value);
  if (unit === 's') return fmtDuration(value);
  if (unit === 'MB' && value >= 1024) return `${+(value / 1024).toFixed(1)} GB`;
  return unit ? `${fmtNum(value)}${unit === '%' ? '%' : ` ${unit}`}` : fmtNum(value);
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${Math.round(sec % 60) ? ` ${Math.round(sec % 60)}s` : ''}`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h${m ? ` ${m}m` : ''}`;
}

/** "5s trước", "3 phút trước"… */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'vừa xong';
  if (s < 60) return `${s}s trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  return `${Math.floor(s / 3600)} giờ trước`;
}

// ── Đánh giá ───────────────────────────────────────────────────────────────

export interface Reason {
  level: Exclude<Level, 'ok' | 'unknown'>;
  metric: string;
  /** Tên chỉ số ngắn ("RAM đã dùng") + giá trị đã định dạng ("93%") — cho ô cảnh báo gọn. */
  label: string;
  value: string;
  /** Một dòng cho tooltip: "RAM đã dùng = 93% (đỏ khi > 90%)". */
  text: string;
  /** Vì sao điều đó đáng lo — rỗng nếu luật không có lời giải thích. */
  why?: string;
}

export interface Kpi {
  metric: string;
  label: string;
  text: string;
  /** Màu của riêng chỉ số này (ok khi không có luật hoặc chưa vi phạm). */
  level: Level;
}

export interface Evaluation {
  level: Level;
  reasons: Reason[];
  kpis: Kpi[];
}

/** Chỉ số nổi lên mặt thẻ (tối đa 3) — thứ người trực muốn thấy đầu tiên của từng loại. */
const KPI_METRICS: Record<InfraStack, { metric: string; label: string; unit: Unit; say?: (v: number) => string }[]> = {
  redis: [
    { metric: 'memUsedPct', label: 'RAM', unit: '%' },
    { metric: 'opsPerSec', label: 'ops/s', unit: '' },
    { metric: 'clients', label: 'client', unit: '' },
  ],
  kafka: [
    { metric: 'brokers', label: 'broker', unit: '' },
    { metric: 'maxConsumerLag', label: 'lag max', unit: '' },
    { metric: 'underReplicated', label: 'under-rep', unit: '' },
  ],
  rabbit: [
    { metric: 'messagesReady', label: 'tồn', unit: '' },
    { metric: 'consumers', label: 'consumer', unit: '' },
    { metric: 'memUsedPct', label: 'RAM', unit: '%' },
  ],
  mongo: [
    { metric: 'connectionsUsedPct', label: 'kết nối', unit: '%' },
    { metric: 'diskUsedPct', label: 'đĩa', unit: '%' },
    { metric: 'replLagSec', label: 'repl lag', unit: 's' },
  ],
  es: [
    { metric: 'statusLevel', label: 'cụm', unit: '', say: (v) => ES_STATUS_TEXT[v] ?? '?' },
    { metric: 'heapPct', label: 'heap', unit: '%' },
    { metric: 'diskUsedPct', label: 'đĩa', unit: '%' },
  ],
  pg: [{ metric: 'latencyMs', label: 'latency', unit: 'ms' }],
};

/** Chỉ số vẽ sparkline mặc định trên thẻ. */
export const SPARK_METRIC: Record<InfraStack, string> = {
  redis: 'memUsedPct',
  kafka: 'maxConsumerLag',
  rabbit: 'messagesReady',
  mongo: 'connectionsUsedPct',
  es: 'heapPct',
  pg: 'latencyMs',
};

/** Một chỉ số vi phạm luật mức nào (ok nếu không vi phạm / không có ngưỡng). */
export function levelOf(rule: Rule, value: number): 'ok' | 'warn' | 'crit' {
  const past = (t: number | undefined): boolean =>
    t !== undefined && (rule.dir === 'gt' ? value > t : value < t);
  if (past(rule.crit)) return 'crit';
  if (past(rule.warn)) return 'warn';
  return 'ok';
}

const cmp = (dir: Rule['dir']): string => (dir === 'gt' ? '>' : '<');

function reasonText(rule: Rule, value: number, lv: 'warn' | 'crit'): string {
  const t = lv === 'crit' ? rule.crit : rule.warn;
  const shown = fmtValue(value, rule.unit, rule.say);
  // Chỉ số trạng thái (say): giá trị đã tự nói đủ, không cần "khi > 0".
  if (rule.say || t === undefined) return `${rule.label}: ${shown}`;
  return `${rule.label} = ${shown} (${lv === 'crit' ? 'đỏ' : 'vàng'} khi ${cmp(rule.dir)} ${fmtValue(t, rule.unit)})`;
}

/**
 * Đánh giá một kết quả probe. `probe` undefined = chưa đo lần nào.
 * Không ném lỗi, không đọc đồng hồ — cùng đầu vào cho cùng đầu ra.
 */
export function evaluate(stack: InfraStack, probe: ProbeResult | undefined, ov?: Overrides): Evaluation {
  if (!probe) return { level: 'unknown', reasons: [], kpis: [] };

  const m = probe.metrics;
  if (probe.error || m.up === 0) {
    return {
      level: 'down',
      reasons: [{
        level: 'down',
        metric: 'up',
        label: 'Kết nối',
        value: 'mất',
        text: probe.error ? `Không kết nối được: ${probe.error}` : 'Không kết nối được',
        why: 'Hạ tầng không trả lời probe của DevBox — kiểm tra dịch vụ, mạng, VPN hoặc credential.',
      }],
      kpis: [],
    };
  }

  const rules = RULES[stack].map((r) => effectiveRule(stack, r, ov));
  const byMetric = new Map(rules.map((r) => [r.metric, r]));

  const reasons: Reason[] = [];
  let level: Level = 'ok';
  for (const rule of rules) {
    const v = m[rule.metric];
    if (typeof v !== 'number') continue; // vắng mặt = không đánh giá
    const lv = levelOf(rule, v);
    if (lv === 'ok') continue;
    reasons.push({ level: lv, metric: rule.metric, label: rule.label, value: fmtValue(v, rule.unit, rule.say), text: reasonText(rule, v, lv), why: rule.why });
    level = worst(level, lv);
  }
  // Đỏ trước vàng, trong cùng mức giữ thứ tự khai luật.
  reasons.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);

  const kpis: Kpi[] = [];
  for (const k of KPI_METRICS[stack]) {
    const v = m[k.metric];
    if (typeof v !== 'number') continue;
    const rule = byMetric.get(k.metric);
    kpis.push({
      metric: k.metric,
      label: k.label,
      text: fmtValue(v, k.unit, k.say),
      level: rule ? levelOf(rule, v) : 'ok',
    });
  }
  return { level, reasons, kpis };
}

/** Nhãn + đơn vị của một chỉ số bất kỳ (kể cả chỉ số không có luật) — cho lưới chỉ số ở màn chi tiết. */
const EXTRA_LABELS: Record<string, { label: string; unit: Unit }> = {
  nodes: { label: 'Số node', unit: '' },
  brokers: { label: 'Số broker', unit: '' },
  topics: { label: 'Topic', unit: '' },
  partitions: { label: 'Partition', unit: '' },
  groups: { label: 'Consumer group', unit: '' },
  totalConsumerLag: { label: 'Tổng lag', unit: '' },
  emptyGroups: { label: 'Group không member', unit: '' },
  rebalancingGroups: { label: 'Group đang rebalance', unit: '' },
  undescribedGroups: { label: 'Group chưa describe được', unit: '' },
  hostsTotal: { label: 'Host broker', unit: '' },
  opsPerSec: { label: 'Ops/giây', unit: '' },
  memUsedMb: { label: 'RAM đã dùng', unit: 'MB' },
  memTotalMb: { label: 'RAM tối đa', unit: 'MB' },
  memLimitMb: { label: 'Giới hạn RAM', unit: 'MB' },
  connections: { label: 'Kết nối hiện tại', unit: '' },
  connectionsTotal: { label: 'Tổng slot kết nối', unit: '' },
  cacheUsedMb: { label: 'Cache đã dùng', unit: 'MB' },
  cacheTotalMb: { label: 'Cache tối đa', unit: 'MB' },
  memResidentMb: { label: 'RAM resident', unit: 'MB' },
  diskUsedGb: { label: 'Đĩa đã dùng', unit: 'GB' },
  diskTotalGb: { label: 'Đĩa tổng', unit: 'GB' },
  hostDiskFreeGb: { label: 'Đĩa còn trống (host tệ nhất)', unit: 'GB' },
  relocatingShards: { label: 'Shard đang di chuyển', unit: '' },
  load1m: { label: 'Load 1 phút', unit: '' },
  consumers: { label: 'Consumer', unit: '' },
  queues: { label: 'Queue', unit: '' },
  publishRate: { label: 'Publish/giây', unit: '/s' },
  fdUsed: { label: 'FD đang dùng', unit: '' },
  fdTotal: { label: 'FD tối đa', unit: '' },
  latencyMs: { label: 'Độ trễ', unit: 'ms' },
};

export function describeMetric(stack: InfraStack, metric: string, ov?: Overrides): { label: string; unit: Unit; say?: (v: number) => string; rule?: Rule } {
  const raw = RULES[stack].find((r) => r.metric === metric);
  if (raw) {
    const rule = effectiveRule(stack, raw, ov);
    return { label: rule.label, unit: rule.unit, say: rule.say, rule };
  }
  const x = EXTRA_LABELS[metric];
  return x ? { label: x.label, unit: x.unit } : { label: metric, unit: '' };
}

/** Rollup nhiều tài nguyên: đếm theo mức. */
export type Counts = Record<Level, number>;
export const emptyCounts = (): Counts => ({ ok: 0, warn: 0, crit: 0, down: 0, unknown: 0 });

export function countLevels(levels: Level[]): Counts {
  const c = emptyCounts();
  for (const l of levels) c[l]++;
  return c;
}

/** Mức tệ nhất của cả nhóm (nhóm rỗng → unknown). */
export const rollup = (levels: Level[]): Level =>
  levels.length ? levels.reduce<Level>((a, l) => worst(a, l), 'unknown') : 'unknown';
