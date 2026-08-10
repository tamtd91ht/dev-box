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
  /** Action types that make sense for this group. */
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
    actions: ['notify', 'webhook', 'telegram', 'wsSend', 'log', 'kafka'],
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
    actions: ['notify', 'webhook', 'telegram', 'wsSend', 'log', 'kafka'],
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

export interface MetricDef {
  key: string;
  label: string;
  unit?: string;
  /** Suggested comparator + threshold when the user picks this metric. */
  suggest?: { op: 'gt' | 'gte' | 'lt' | 'lte'; threshold: number };
  hint?: string;
}

export interface StackDef {
  id: InfraStack;
  label: string;
  icon: string;
  metrics: MetricDef[];
}

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
      { key: 'hitRatePct', label: 'Tỉ lệ cache hit', unit: '%', suggest: { op: 'lt', threshold: 80 } },
      { key: 'fragmentation', label: 'Tỉ lệ phân mảnh', suggest: { op: 'gt', threshold: 1.5 } },
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
      { key: 'cacheUsedPct', label: 'WiredTiger cache', unit: '%', suggest: { op: 'gt', threshold: 90 } },
      { key: 'diskUsedPct', label: 'Đĩa đã dùng', unit: '%', suggest: { op: 'gt', threshold: 85 } },
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
      { key: 'heapPct', label: 'Heap cao nhất', unit: '%', suggest: { op: 'gt', threshold: 85 } },
      { key: 'cpuPct', label: 'CPU cao nhất', unit: '%', suggest: { op: 'gt', threshold: 90 } },
      { key: 'diskUsedPct', label: 'Đĩa cao nhất', unit: '%', suggest: { op: 'gt', threshold: 85 } },
      { key: 'load1m', label: 'Load 1m cao nhất' },
      { key: 'nodes', label: 'Số node', suggest: { op: 'lt', threshold: 3 } },
    ],
  },
  {
    id: 'kafka',
    label: 'Kafka',
    icon: '🧵',
    metrics: [
      UP,
      { key: 'underReplicated', label: 'Partition under-replicated', suggest: { op: 'gt', threshold: 0 } },
      { key: 'offline', label: 'Partition offline', suggest: { op: 'gt', threshold: 0 } },
      { key: 'brokers', label: 'Số broker', suggest: { op: 'lt', threshold: 3 } },
      { key: 'noController', label: 'Mất controller', unit: '0/1', suggest: { op: 'gte', threshold: 1 } },
      { key: 'topics', label: 'Số topic' },
      { key: 'partitions', label: 'Số partition' },
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
      { key: 'memAlarm', label: 'Cảnh báo RAM', unit: '0/1', suggest: { op: 'gte', threshold: 1 } },
      { key: 'diskAlarm', label: 'Cảnh báo đĩa', unit: '0/1', suggest: { op: 'gte', threshold: 1 } },
      { key: 'nodesDown', label: 'Node chết', suggest: { op: 'gt', threshold: 0 } },
      { key: 'memUsedPct', label: 'RAM node cao nhất', unit: '%', suggest: { op: 'gt', threshold: 80 } },
      { key: 'fdUsedPct', label: 'File descriptor', unit: '%', suggest: { op: 'gt', threshold: 80 } },
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
