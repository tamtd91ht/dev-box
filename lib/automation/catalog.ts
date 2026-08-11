// DevBox Automation — the catalog the UI builds itself from.
//
// Everything the rule editor offers (feature groups, triggers, matchable
// fields, operators, and the metrics each infrastructure stack exposes) is
// declared here as data. Adding a metric, a trigger or a whole new group is an
// entry in this file plus a probe adapter — never a change to the editor.

import type { ActionType, ConditionOp, EventCategory, InfraStack, TriggerType } from './types';

// ── Feature groups ─────────────────────────────────────────────────────────

export interface FieldDef {
  name: string;
  label: string;
  kind: 'text' | 'number';
  hint?: string;
}

export interface TriggerDef {
  type: TriggerType;
  label: string;
  blurb: string;
  fields: FieldDef[];
}

export interface GroupDef {
  id: EventCategory;
  label: string;
  icon: string;
  blurb: string;
  triggers: TriggerDef[];
  /**
   * Action types the rule editor offers for this group — nó là bộ lọc CỦA UI,
   * không phải giới hạn của runtime: `runtime.ts` chạy được mọi action với mọi
   * nguồn event. Bỏ một action khỏi đây là ẩn nó khỏi editor, và người dùng chỉ
   * thấy "sao mất rồi" chứ không thấy lý do — nên chỉ cắt khi action THẬT SỰ
   * cần field riêng của group.
   *
   * `reply` là ca duy nhất như vậy: nó trả lời vào đúng hội thoại vừa nhắn nên
   * chỉ có nghĩa ở `social`. Các kênh gửi (telegram, wsSend, zaloApiSend) thì
   * chỉ cần đích đến người dùng tự chọn, nên có ở CẢ BA group — cảnh báo hạ
   * tầng nhắn qua Zalo API là việc bình thường.
   */
  actions: ActionType[];
}

/** Fields every event carries, offered in every group. */
const CORE_FIELDS: FieldDef[] = [
  { name: 'title', label: 'Tiêu đề', kind: 'text', hint: 'Người gửi, hoặc tên cảnh báo' },
  { name: 'text', label: 'Nội dung', kind: 'text' },
  { name: 'source', label: 'Nguồn', kind: 'text', hint: 'zalo · redis · mongo …' },
  { name: 'instance', label: 'Tài khoản / kết nối', kind: 'text' },
];

export const GROUPS: GroupDef[] = [
  {
    id: 'social',
    label: 'Social',
    icon: '💬',
    blurb: 'Tin nhắn đến từ các workspace nhắn tin (Zalo, Telegram, WhatsApp…) và nhánh Zalo API.',
    actions: ['notify', 'webhook', 'telegram', 'wsSend', 'zaloApiSend', 'log', 'kafka', 'reply'],
    triggers: [
      {
        type: 'message.received',
        label: 'Có tin nhắn đến',
        blurb: 'Bắt từ thông báo của chính ứng dụng trong workspace.',
        fields: [
          ...CORE_FIELDS,
          {
            name: 'conversation',
            label: 'Hội thoại',
            kind: 'text',
            hint: 'tên nhóm, hoặc tên người khi chat 1-1',
          },
          {
            name: 'sender',
            label: 'Người gửi',
            kind: 'text',
            hint: 'trong nhóm là người vừa nhắn; chat 1-1 thì trùng tên hội thoại',
          },
          {
            name: 'chatType',
            label: 'Loại hội thoại',
            kind: 'text',
            hint: 'group = nhóm · user = chat 1-1',
          },
          { name: 'capture', label: 'Cách bắt', kind: 'text', hint: 'notification · dom · ws (Zalo API)' },
          {
            name: 'threadId',
            label: 'threadId (Zalo API)',
            kind: 'text',
            hint: 'id hội thoại thật — chỉ nhánh Zalo API mới có; DOM để trống',
          },
        ],
      },
    ],
  },
  {
    id: 'infra',
    label: 'Infrastructure',
    icon: '🖥',
    blurb: 'Cảnh báo hạ tầng từ chính các kết nối đã khai báo trong DevBox.',
    actions: ['notify', 'webhook', 'telegram', 'wsSend', 'zaloApiSend', 'log', 'kafka'],
    triggers: [
      {
        type: 'infra.metric',
        label: 'Vượt ngưỡng',
        blurb: 'Một chỉ số theo dõi vượt ngưỡng và giữ đủ lâu.',
        fields: [
          ...CORE_FIELDS,
          { name: 'stack', label: 'Stack', kind: 'text', hint: 'redis · mongo · es · kafka · rabbit · pg' },
          { name: 'metric', label: 'Chỉ số', kind: 'text' },
          { name: 'value', label: 'Giá trị', kind: 'number' },
          { name: 'threshold', label: 'Ngưỡng', kind: 'number' },
          { name: 'watch', label: 'Tên watch', kind: 'text' },
        ],
      },
      {
        type: 'infra.recovered',
        label: 'Đã hồi phục',
        blurb: 'Chỉ số quay lại bình thường sau khi đã cảnh báo.',
        fields: [
          ...CORE_FIELDS,
          { name: 'stack', label: 'Stack', kind: 'text' },
          { name: 'metric', label: 'Chỉ số', kind: 'text' },
          { name: 'value', label: 'Giá trị', kind: 'number' },
          { name: 'threshold', label: 'Ngưỡng', kind: 'number' },
          { name: 'downSec', label: 'Thời gian vi phạm (giây)', kind: 'number' },
        ],
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    icon: '🧪',
    blurb: 'Sự kiện do chính DevBox phát ra — hiện dùng cho bảng thử quy tắc.',
    actions: ['notify', 'webhook', 'telegram', 'wsSend', 'zaloApiSend', 'log', 'kafka'],
    triggers: [
      {
        type: 'system.test',
        label: 'Sự kiện thử',
        blurb: 'Bắn từ bảng Test để kiểm tra quy tắc mà không cần chờ sự kiện thật.',
        fields: CORE_FIELDS,
      },
    ],
  },
];

export const groupOf = (id: EventCategory): GroupDef => GROUPS.find((g) => g.id === id) ?? GROUPS[0];

export function triggerDef(type: TriggerType): TriggerDef | undefined {
  for (const g of GROUPS) {
    const t = g.triggers.find((x) => x.type === type);
    if (t) return t;
  }
  return undefined;
}

export const categoryOfTrigger = (type: TriggerType): EventCategory =>
  GROUPS.find((g) => g.triggers.some((t) => t.type === type))?.id ?? 'system';

// ── Operators ──────────────────────────────────────────────────────────────

export interface OpDef {
  op: ConditionOp;
  label: string;
  kind: 'text' | 'number' | 'unary' | 'list';
}

export const OPERATORS: OpDef[] = [
  { op: 'contains', label: 'chứa', kind: 'text' },
  { op: 'notContains', label: 'không chứa', kind: 'text' },
  { op: 'equals', label: 'bằng', kind: 'text' },
  { op: 'notEquals', label: 'khác', kind: 'text' },
  { op: 'startsWith', label: 'bắt đầu bằng', kind: 'text' },
  { op: 'endsWith', label: 'kết thúc bằng', kind: 'text' },
  { op: 'anyOf', label: 'chứa một trong', kind: 'list' },
  { op: 'noneOf', label: 'không chứa cái nào trong', kind: 'list' },
  { op: 'regex', label: 'khớp regex', kind: 'text' },
  { op: 'empty', label: 'rỗng', kind: 'unary' },
  { op: 'notEmpty', label: 'khác rỗng', kind: 'unary' },
  { op: 'gt', label: '>', kind: 'number' },
  { op: 'gte', label: '≥', kind: 'number' },
  { op: 'lt', label: '<', kind: 'number' },
  { op: 'lte', label: '≤', kind: 'number' },
];

export const opDef = (op: ConditionOp): OpDef => OPERATORS.find((o) => o.op === op) ?? OPERATORS[0];

// ── Infrastructure metric catalog ──────────────────────────────────────────

/**
 * What polling this metric COSTS the system being watched.
 *
 * A monitor that loads the thing it monitors is worse than no monitor: it adds
 * load exactly when the cluster is already struggling, and the operator cannot
 * tell the alert from its cause. So cost is declared per metric and surfaced in
 * the editor — the decision "is this worth polling every 30s" is the user's, but
 * it has to be an informed one.
 *
 *   'cheap'  a single status/stats call the server answers from memory.
 *            INFO, serverStatus, /_cluster/health, /api/overview. Safe at 30s.
 *   'medium' one extra round-trip, or a fan-out across nodes. Fine at 60s+,
 *            wasteful at 15s.
 *   'heavy'  cost grows with the SIZE of the cluster (topics, groups, queues).
 *            The same call on a 20-topic cluster and a 2000-topic cluster are
 *            different operations. 120s+, and read the note.
 */
export type ProbeCost = 'cheap' | 'medium' | 'heavy';

export interface MetricDef {
  key: string;
  label: string;
  unit?: string;
  /** Suggested comparator + threshold when the user picks this metric. */
  suggest?: { op: 'gt' | 'gte' | 'lt' | 'lte'; threshold: number };
  hint?: string;
  /** Empty → 'cheap'. See ProbeCost. */
  cost?: ProbeCost;
  /** Why it costs that much, and what to do about it. Shown on hover. */
  costNote?: string;
  /** Poll interval below which this metric is a genuine risk (seconds). */
  minEverySec?: number;
}

export interface StackDef {
  id: InfraStack;
  label: string;
  icon: string;
  metrics: MetricDef[];
}

// ── Cost notes, written once and shared ────────────────────────────────────
// Each says WHAT the probe runs, WHY that scales, and WHAT to do — an operator
// deciding whether to enable a watch needs all three.

const KAFKA_META_NOTE =
  'Mỗi lần đo gọi describeCluster + listTopics + fetchTopicMetadata cho TẤT CẢ topic, và controller là bên trả lời. ' +
  'Chi phí tăng theo SỐ TOPIC: cụm 30 topic thì không đáng kể, cụm 2000 topic thì mỗi vòng là một lượt quét metadata lớn. ' +
  'Nên để ≥60s. Cụm nhiều topic thì dùng 120–300s, và chỉ giữ vài watch thật cần thiết trên mỗi cụm.';

const KAFKA_LAG_NOTE =
  'Nặng nhất trong tất cả: listGroups + describeGroups + fetchOffsets cho TỪNG group (song song tối đa 8), ' +
  'cộng fetchTopicOffsets cho mỗi topic phân biệt. Chi phí tăng theo SỐ GROUP × SỐ TOPIC. ' +
  'Nên để ≥120s; cụm nhiều group thì 300s. Lag không đổi trong 30 giây, nên đo dày hơn không cho thêm thông tin gì.';

const ES_NODES_NOTE =
  'Ngoài /_cluster/health còn gọi thêm /_cat/nodes (một round-trip nữa, master trả lời). Nên để ≥60s.';

const MONGO_STATUS_NOTE =
  'serverStatus + dbStats + replSetGetStatus mỗi lần đo. serverStatus rẻ, nhưng dbStats phải tổng hợp dung lượng ' +
  'nên nặng dần theo số collection. Nên để ≥60s; cụm nhiều collection thì 300s cho các chỉ số đĩa.';

const RABBIT_NODES_NOTE =
  'Ngoài /api/overview còn gọi /api/nodes. Management plugin của RabbitMQ tính số liệu ngay lúc được hỏi, ' +
  'nên hỏi quá dày sẽ ăn CPU của chính node. Nên để ≥60s.';

/** `up` exists for every stack: 1 = probe succeeded, 0 = unreachable. */
const UP: MetricDef = {
  key: 'up',
  label: 'Kết nối được',
  unit: '0/1',
  suggest: { op: 'lt', threshold: 1 },
  hint: 'Cảnh báo mất kết nối: up < 1',
};
const LATENCY: MetricDef = {
  key: 'latencyMs',
  label: 'Độ trễ probe',
  unit: 'ms',
  suggest: { op: 'gt', threshold: 1000 },
};

export const STACKS: StackDef[] = [
  {
    id: 'redis',
    label: 'Redis',
    icon: '🧠',
    metrics: [
      UP,
      { key: 'memUsedPct', label: 'RAM đã dùng', unit: '%', suggest: { op: 'gt', threshold: 80 } },
      { key: 'memUsedMb', label: 'RAM đã dùng', unit: 'MB' },
      { key: 'clients', label: 'Client đang kết nối', suggest: { op: 'gt', threshold: 5000 } },
      { key: 'opsPerSec', label: 'Ops/giây', suggest: { op: 'gt', threshold: 50000 } },
      {
        key: 'hitRatePct',
        label: 'Tỉ lệ cache hit',
        unit: '%',
        hint: '⚠ Chỉ có nghĩa với instance dùng làm CACHE. Redis làm queue/lock/session thì hit-rate thấp là bình thường — đặt ngưỡng ở đây sẽ báo sai liên tục.',
      },
      { key: 'fragmentation', label: 'Tỉ lệ phân mảnh', suggest: { op: 'gt', threshold: 1.6 } },
      { key: 'nodes', label: 'Số node đọc được' },
    ],
  },
  {
    id: 'mongo',
    label: 'MongoDB',
    icon: '🍃',
    metrics: [
      UP,
      { key: 'connectionsUsedPct', label: 'Connection pool đã dùng', unit: '%', suggest: { op: 'gt', threshold: 80 } },
      { key: 'connections', label: 'Connection hiện tại' },
      {
        key: 'cacheUsedPct',
        label: 'WiredTiger cache',
        unit: '%',
        hint: '⚠ WiredTiger được thiết kế để giữ cache ~80–95% — đây là hành vi BÌNH THƯỜNG, không phải sự cố. Đừng đặt ngưỡng ở đây.',
      },
      // dbStats aggregates storage size — the one Mongo call that grows with the
      // number of collections.
      {
        key: 'diskUsedPct',
        label: 'Đĩa đã dùng',
        unit: '%',
        suggest: { op: 'gt', threshold: 85 },
        cost: 'medium',
        costNote: MONGO_STATUS_NOTE,
        minEverySec: 60,
      },
      { key: 'memResidentMb', label: 'RAM resident', unit: 'MB' },
      { key: 'replLagSec', label: 'Replication lag', unit: 's', suggest: { op: 'gt', threshold: 10 } },
      { key: 'membersUnhealthy', label: 'Member lỗi', suggest: { op: 'gt', threshold: 0 } },
    ],
  },
  {
    id: 'es',
    label: 'Elasticsearch',
    icon: '🔎',
    metrics: [
      UP,
      { key: 'statusLevel', label: 'Trạng thái cluster', unit: '0=green 1=yellow 2=red', suggest: { op: 'gte', threshold: 1 } },
      { key: 'unassignedShards', label: 'Shard chưa gán', suggest: { op: 'gt', threshold: 0 } },
      { key: 'relocatingShards', label: 'Shard đang di chuyển' },
      { key: 'pendingTasks', label: 'Pending tasks', suggest: { op: 'gt', threshold: 10 } },
      // These four come from the second call, /_cat/nodes.
      { key: 'heapPct', label: 'Heap cao nhất', unit: '%', suggest: { op: 'gt', threshold: 85 }, cost: 'medium', costNote: ES_NODES_NOTE, minEverySec: 60 },
      { key: 'cpuPct', label: 'CPU cao nhất', unit: '%', suggest: { op: 'gt', threshold: 90 }, cost: 'medium', costNote: ES_NODES_NOTE, minEverySec: 60 },
      { key: 'diskUsedPct', label: 'Đĩa cao nhất', unit: '%', suggest: { op: 'gt', threshold: 85 }, cost: 'medium', costNote: ES_NODES_NOTE, minEverySec: 60 },
      { key: 'load1m', label: 'Load 1m cao nhất', cost: 'medium', costNote: ES_NODES_NOTE, minEverySec: 60 },
      { key: 'nodes', label: 'Số node', suggest: { op: 'lt', threshold: 3 } },
    ],
  },
  {
    id: 'kafka',
    label: 'Kafka',
    icon: '🧵',
    metrics: [
      // EVERY kafka metric pays for clusterHealth, which calls
      // fetchTopicMetadata over ALL topics — cost scales with the topic count,
      // and it is the controller that answers.
      { ...UP, cost: 'heavy', costNote: KAFKA_META_NOTE, minEverySec: 60 },
      {
        key: 'underReplicated',
        label: 'Partition under-replicated',
        suggest: { op: 'gt', threshold: 0 },
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
      },
      {
        key: 'offline',
        label: 'Partition offline',
        suggest: { op: 'gt', threshold: 0 },
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
      },
      { key: 'brokers', label: 'Số broker', suggest: { op: 'lt', threshold: 3 }, cost: 'heavy', costNote: KAFKA_META_NOTE, minEverySec: 60 },
      {
        key: 'noController',
        label: 'Mất controller',
        unit: '0/1',
        suggest: { op: 'gte', threshold: 1 },
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
      },
      {
        key: 'maxConsumerLag',
        label: 'Consumer lag cao nhất',
        unit: 'message',
        suggest: { op: 'gt', threshold: 10000 },
        hint: 'Group tụt hậu nhiều nhất. Cluster xanh mà chỉ số này cao = nghiệp vụ đã chậm',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
      },
      {
        key: 'stalledGroups',
        label: 'Group đứng im',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'Còn lag nhưng offset KHÔNG nhích qua ≥30s — consumer chết dù vẫn kết nối',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
      },
      {
        key: 'maxStalledSec',
        label: 'Đứng im lâu nhất',
        unit: 's',
        suggest: { op: 'gt', threshold: 600 },
        hint: 'Dùng thay stalledGroups khi muốn bỏ qua các lần treo ngắn',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
      },
      {
        key: 'emptyGroups',
        label: 'Group không còn member',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'Có commit offset nhưng 0 consumer đang chạy',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
      },
      {
        key: 'rebalancingGroups',
        label: 'Group đang rebalance',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'Kéo dài = consumer flapping (chết/sống liên tục)',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
      },
      {
        key: 'totalConsumerLag',
        label: 'Tổng lag toàn cluster',
        unit: 'message',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
      },
      {
        key: 'lagGroupsUnknown',
        label: 'Group không đọc được lag',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'Lag KHÔNG xác định (không phải 0) — thường do group đang rebalance',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
      },
      {
        key: 'undescribedGroups',
        label: 'Group không đọc được trạng thái',
        hint: 'describeGroups lỗi → số member/state không xác định; các chỉ số member bỏ qua group này',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
      },
      { key: 'groups', label: 'Số consumer group', cost: 'heavy', costNote: KAFKA_LAG_NOTE, minEverySec: 120 },
      { key: 'topics', label: 'Số topic', cost: 'heavy', costNote: KAFKA_META_NOTE, minEverySec: 60 },
      { key: 'partitions', label: 'Số partition', cost: 'heavy', costNote: KAFKA_META_NOTE, minEverySec: 60 },
    ],
  },
  {
    id: 'rabbit',
    label: 'RabbitMQ',
    icon: '🐰',
    metrics: [
      UP,
      { key: 'messagesReady', label: 'Message tồn (ready)', suggest: { op: 'gt', threshold: 10000 } },
      { key: 'messagesUnacked', label: 'Message chưa ack', suggest: { op: 'gt', threshold: 5000 } },
      { key: 'consumers', label: 'Số consumer', suggest: { op: 'lt', threshold: 1 } },
      // Everything below needs the second call, /api/nodes.
      { key: 'memAlarm', label: 'Cảnh báo RAM', unit: '0/1', suggest: { op: 'gte', threshold: 1 }, cost: 'medium', costNote: RABBIT_NODES_NOTE, minEverySec: 60 },
      { key: 'diskAlarm', label: 'Cảnh báo đĩa', unit: '0/1', suggest: { op: 'gte', threshold: 1 }, cost: 'medium', costNote: RABBIT_NODES_NOTE, minEverySec: 60 },
      { key: 'nodesDown', label: 'Node chết', suggest: { op: 'gt', threshold: 0 }, cost: 'medium', costNote: RABBIT_NODES_NOTE, minEverySec: 60 },
      { key: 'memUsedPct', label: 'RAM node cao nhất', unit: '%', suggest: { op: 'gt', threshold: 80 }, cost: 'medium', costNote: RABBIT_NODES_NOTE, minEverySec: 60 },
      { key: 'fdUsedPct', label: 'File descriptor', unit: '%', suggest: { op: 'gt', threshold: 80 }, cost: 'medium', costNote: RABBIT_NODES_NOTE, minEverySec: 60 },
      { key: 'queues', label: 'Số queue' },
      { key: 'publishRate', label: 'Publish/giây' },
    ],
  },
  {
    id: 'pg',
    label: 'PostgreSQL',
    icon: '🐘',
    metrics: [UP, LATENCY],
  },
];

export const stackDef = (id: InfraStack): StackDef | undefined => STACKS.find((s) => s.id === id);

export function metricDef(stack: InfraStack, key: string): MetricDef | undefined {
  return stackDef(stack)?.metrics.find((m) => m.key === key);
}

/** Human label for a metric, falling back to its raw key. */
export const metricLabel = (stack: InfraStack, key: string): string => {
  const m = metricDef(stack, key);
  if (!m) return key;
  return m.unit ? `${m.label} (${m.unit})` : m.label;
};

// ── "Will enabling this load the thing it monitors?" ────────────────────────
//
// Surfaced at the two moments the user decides: picking the metric, and flipping
// the switch on. Not as a standing dashboard — a permanent warning is one nobody
// reads.
//
// Note that watches do NOT share probe results: the runner polls each one
// separately, so several watches on the same cluster multiply the calls. That is
// why the note for an expensive metric says to keep only the few that matter.

export const COST_LABEL: Record<ProbeCost, string> = { cheap: 'nhẹ', medium: 'vừa', heavy: 'nặng' };
export const COST_ICON: Record<ProbeCost, string> = { cheap: '🟢', medium: '🟡', heavy: '🔴' };

export const metricCost = (stack: InfraStack, key: string): ProbeCost =>
  metricDef(stack, key)?.cost ?? 'cheap';

/** Poll floor for a metric, when it has one. */
export const metricMinEvery = (stack: InfraStack, key: string): number =>
  metricDef(stack, key)?.minEverySec ?? 0;

export interface WatchLoadIssue {
  level: 'watch' | 'risk';
  text: string;
}

/**
 * Is this ONE watch polling faster than its metric warrants?
 *
 * 'risk' when it polls at least twice as fast as the declared floor — that is
 * where a heavy probe starts being a measurable share of the cluster's work.
 */
export function watchLoadIssue(stack: InfraStack, metric: string, everySec: number): WatchLoadIssue | null {
  const floor = metricMinEvery(stack, metric);
  if (!floor || everySec >= floor) return null;
  const cost = metricCost(stack, metric);
  const label = COST_LABEL[cost].toLowerCase();
  return {
    level: everySec * 2 <= floor ? 'risk' : 'watch',
    text: `Chỉ số ${label} nhưng đo mỗi ${everySec}s — nên ≥${floor}s.`,
  };
}
