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
  /**
   * Giá trị minh hoạ, để UI dựng được "event mẫu" và bảng biến {{…}} có ví dụ
   * cụ thể thay vì chỉ tên trường. Registry này là NGUỒN DUY NHẤT — script
   * check:automation đối chiếu nó với emission thật trong sources/.
   */
  sample?: string | number;
  /**
   * true = biến suy diễn (title, metaJson…) — KHÔNG nằm trong event.fields.
   * Bảng biến vẫn liệt kê nó, nhưng script đối chiếu emission thì bỏ qua.
   */
  derived?: boolean;
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

/** Fields every event carries, offered in every group. `derived`: they live on
 * the event itself, not in `event.fields` — the consistency check skips them. */
const CORE_FIELDS: FieldDef[] = [
  { name: 'title', label: 'Tiêu đề', kind: 'text', hint: 'Người gửi, hoặc tên cảnh báo', sample: 'FusionPBX — RAM cạn kiệt', derived: true },
  { name: 'text', label: 'Nội dung', kind: 'text', sample: 'FusionPBX: RAM đã dùng (%) = 95.2 (ngưỡng > 92)', derived: true },
  { name: 'source', label: 'Nguồn', kind: 'text', hint: 'zalo · redis · mongo …', sample: 'redis', derived: true },
  { name: 'instance', label: 'Tài khoản / kết nối', kind: 'text', sample: 'FusionPBX', derived: true },
];

/**
 * Fields EVERY infra event carries — the exact keys `sources/infra.ts baseEvent()`
 * emits, one entry per key (script check:automation giữ hai bên khớp nhau).
 * Samples kể một câu chuyện nhất quán: Redis FusionPBX vượt ngưỡng RAM.
 */
const INFRA_FIELDS: FieldDef[] = [
  ...CORE_FIELDS,
  { name: 'stack', label: 'Stack', kind: 'text', hint: 'redis · mongo · es · kafka · rabbit · pg', sample: 'redis' },
  { name: 'stackLabel', label: 'Tên stack', kind: 'text', sample: 'Redis' },
  { name: 'metric', label: 'Chỉ số', kind: 'text', sample: 'memUsedPct' },
  { name: 'metricLabel', label: 'Tên chỉ số', kind: 'text', sample: 'RAM đã dùng (%)' },
  { name: 'value', label: 'Giá trị', kind: 'number', sample: 95.2 },
  { name: 'threshold', label: 'Ngưỡng', kind: 'number', sample: 92 },
  { name: 'op', label: 'Phép so sánh', kind: 'text', hint: 'gt · gte · lt · lte · eq · neq', sample: 'gt' },
  { name: 'opText', label: 'Phép so sánh (ký hiệu)', kind: 'text', hint: '> · ≥ · < · ≤ · = · ≠', sample: '>' },
  { name: 'unit', label: 'Đơn vị', kind: 'text', sample: '%' },
  { name: 'watch', label: 'Tên watch', kind: 'text', sample: 'FusionPBX — RAM cạn kiệt (>92%)' },
  { name: 'watchId', label: 'Id watch', kind: 'text', hint: 'định danh ổn định — đổi tên watch không đổi id', sample: 'w-redis-omicrm-fusionpbx-memusedpct-p1' },
  { name: 'severity', label: 'Mức độ', kind: 'text', hint: 'critical · warning · info', sample: 'critical' },
  { name: 'severityLabel', label: 'Mức độ (nhãn)', kind: 'text', sample: '🔴 NGHIÊM TRỌNG' },
  { name: 'tags', label: 'Tags', kind: 'text', hint: 'nối bằng dấu phẩy', sample: 'redis,omicrm' },
  { name: 'address', label: 'Địa chỉ', kind: 'text', hint: 'host:port của kết nối — rỗng khi chưa tải được danh sách kết nối', sample: '10.0.0.5:6379' },
  { name: 'alertType', label: 'Mã cảnh báo', kind: 'text', hint: 'mã ổn định stack.mã.hướng — vd redis.ram.high, pg.down', sample: 'redis.ram.high' },
  { name: 'everySec', label: 'Chu kỳ đo (giây)', kind: 'number', sample: 30 },
  { name: 'forSec', label: 'Giữ ngưỡng (giây)', kind: 'number', hint: '0 = báo ngay khi chạm ngưỡng', sample: 120 },
  { name: 'note', label: 'Ghi chú watch', kind: 'text', hint: 'ngữ cảnh nghiệp vụ do người tạo watch viết', sample: 'Redis này cấp session cho tổng đài FusionPBX.' },
  { name: 'absUsed', label: 'Tuyệt đối — đã dùng', kind: 'number', hint: 'chỉ có khi metric % khai cặp used/total trong catalog; rỗng khi không', sample: 3899 },
  { name: 'absTotal', label: 'Tuyệt đối — tổng', kind: 'number', hint: 'mẫu số của con số % — 90% CỦA BAO NHIÊU', sample: 4096 },
  { name: 'absLeft', label: 'Tuyệt đối — còn lại', kind: 'number', hint: 'tổng − đã dùng, cùng thời điểm đo', sample: 197 },
  { name: 'absUnit', label: 'Đơn vị tuyệt đối', kind: 'text', hint: 'MB · GB · (rỗng = số đếm)', sample: 'MB' },
  {
    name: 'absText',
    label: 'Tuyệt đối (chuỗi đọc được)',
    kind: 'text',
    hint: 'mang sẵn " · " đầu chuỗi, rỗng khi metric không có cặp used/total — đặt ngay sau {{value}} là tự gọn',
    sample: ' · 3.8 GB / 4.0 GB · còn 197 MB',
  },
  {
    name: 'ladderAbove',
    label: 'Bậc nặng hơn đang yên',
    kind: 'text',
    hint: 'các watch cùng chỉ số có ngưỡng chặt hơn mà lúc này KHÔNG vượt — rỗng khi đây đã là bậc cao nhất',
    sample: 'MG-01 — đĩa nguy cấp (>97%)',
  },
  {
    name: 'ladderCount',
    label: 'Số bậc nặng hơn đang yên',
    kind: 'number',
    hint: '0 = cảnh báo này là bậc cao nhất của nhóm',
    sample: 1,
  },
  {
    name: 'ladderText',
    label: 'Bậc nặng hơn (chuỗi đọc được)',
    kind: 'text',
    hint: 'mang sẵn xuống dòng đầu chuỗi, rỗng khi đây là bậc cao nhất — giải thích "vì sao báo ở mức này chứ không phải mức nặng hơn"',
    sample: '\nBậc nặng hơn đang bình thường: MG-01 — đĩa nguy cấp (> 97)',
  },
  {
    name: 'description',
    label: 'Mô tả cơ chế phát hiện',
    kind: 'text',
    hint: 'tự sinh từ catalog: chỉ số nghĩa là gì, đo bằng gì, chu kỳ, ngưỡng — đủ ngữ cảnh cho người trực hoặc bot AI phân tích',
    sample: 'RAM đã dùng (%) — tỉ lệ bộ nhớ Redis đang dùng so với giới hạn maxmemory…',
  },
  {
    name: 'consumers',
    label: 'Consumer liên quan (chuỗi)',
    kind: 'text',
    hint: 'CHỈ Kafka chỉ số theo group: danh sách group liên quan kèm giá trị + topic + nhãn 🟢 đang tiêu thụ / 🟡 không consumer (AKHQ vàng/xanh) — rỗng với stack/chỉ số khác',
    sample: 'nlp_shadow=đứng im 70 phút · lag 5.977 (nlp_need) · 🟡 KHÔNG consumer (Empty, 0 member)',
  },
  {
    name: 'consumerCount',
    label: 'Số consumer liên quan',
    kind: 'number',
    hint: 'tổng số group liên quan (kể cả phần bị cắt khỏi danh sách hiển thị); 0 khi không có',
    sample: 2,
  },
  {
    name: 'consumersJson',
    label: 'Consumer liên quan (JSON)',
    kind: 'text',
    hint: 'bản máy đọc [{group,lag,topic?,topicLag?,stalledSec?,active?,state?,members?}] — vào AlertMeta.consumers của metaJson; rỗng khi không có',
    sample: '[{"group":"billing-worker","lag":45200,"topic":"invoice-created","topicLag":45200,"active":true,"members":3}]',
  },
  {
    name: 'topics',
    label: 'Topic ảnh hưởng (chuỗi)',
    kind: 'text',
    hint: 'CHỈ Kafka underReplicated/offline: topic có partition under-replicated/offline — rỗng với chỉ số khác',
    sample: 'orders, payments',
  },
  {
    name: 'topicCount',
    label: 'Số topic ảnh hưởng',
    kind: 'number',
    hint: 'tổng số topic bị ảnh hưởng (kể cả phần bị cắt khỏi danh sách); 0 khi không có',
    sample: 2,
  },
  {
    name: 'hosts',
    label: 'Host broker liên quan (chuỗi)',
    kind: 'text',
    hint: 'CHỈ Kafka chỉ số host (đĩa/RAM/CPU/load/mất exporter): đích danh máy nào kèm số liệu — rỗng với stack/chỉ số khác',
    sample: '192.168.2.94=đĩa 91% /var/lib/kafka, còn 18.4 GB',
  },
  {
    name: 'hostCount',
    label: 'Số host broker liên quan',
    kind: 'number',
    hint: 'tổng số host liên quan (kể cả phần bị cắt khỏi danh sách hiển thị); 0 khi không có',
    sample: 2,
  },
  {
    name: 'hostsJson',
    label: 'Host broker liên quan (JSON)',
    kind: 'text',
    hint: 'bản máy đọc [{host,diskUsedPct?,diskFreeGb?,mount?,memUsedPct?,cpuPct?,load1PerCore?,unreachable?}] — vào AlertMeta.hosts của metaJson; rỗng khi không có',
    sample: '[{"host":"192.168.2.94","diskUsedPct":91,"diskFreeGb":18.4,"mount":"/var/lib/kafka"}]',
  },
  {
    name: 'reachSummary',
    label: 'Chẩn đoán mất kết nối',
    kind: 'text',
    hint: 'CHỈ Kafka mất kết nối: câu kết luận hướng xử lý — mất mạng/VPN, node nào chết, hay cụm mở cổng mà chưa phục vụ. Rỗng với chỉ số khác',
    sample: '1/3 node không kết nối được (192.168.2.220:9092); 2 node còn TCP bình thường → mạng thông, hỏng ở đúng (các) node kia.',
  },
  {
    name: 'brokerReach',
    label: 'Từng broker (chuỗi)',
    kind: 'text',
    hint: 'CHỈ Kafka mất kết nối: kết quả bắt tay TCP tới TỪNG seed broker, nêu rõ IP và lỗi. Rỗng với chỉ số khác',
    sample: '192.168.2.218:9092 = TCP mở (2ms) · 192.168.2.220:9092 = KHÔNG kết nối được (ECONNREFUSED)',
  },
  {
    name: 'brokersUp',
    label: 'Số broker bắt tay được',
    kind: 'number',
    hint: 'số seed broker còn mở cổng TCP lúc cụm mất kết nối; 0 khi không node nào trả lời',
    sample: 2,
  },
  {
    name: 'brokersTotal',
    label: 'Tổng số seed broker',
    kind: 'number',
    hint: 'số seed broker khai trong cấu hình kết nối; 0 khi không đo (chỉ số khác)',
    sample: 3,
  },
  {
    name: 'advertised',
    label: 'advertised.listeners cụm trả về',
    kind: 'text',
    hint: 'CHỈ Kafka mất kết nối: địa chỉ cụm TỰ QUẢNG BÁ cho client. Khác với địa chỉ DevBox đang gọi là nguyên nhân kinh điển của "kết nối được mà vẫn hỏng". Rỗng khi cụm không trả lời được',
    sample: 'kafka-1.omicrm.services:9092, kafka-2.omicrm.services:9092',
  },
  {
    name: 'brokerReachJson',
    label: 'Từng broker (JSON)',
    kind: 'text',
    hint: 'bản máy đọc [{addr,host,port,reachable,latencyMs?,error?}] — vào AlertMeta.brokers của metaJson; rỗng khi không có',
    sample: '[{"addr":"192.168.2.220:9092","host":"192.168.2.220","port":9092,"reachable":false,"error":"ECONNREFUSED"}]',
  },
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
            sample: 'OMITeam',
          },
          {
            name: 'sender',
            label: 'Người gửi',
            kind: 'text',
            hint: 'trong nhóm là người vừa nhắn; chat 1-1 thì trùng tên hội thoại',
            sample: 'Nguyễn Văn A',
          },
          {
            name: 'chatType',
            label: 'Loại hội thoại',
            kind: 'text',
            hint: 'group = nhóm · user = chat 1-1',
            sample: 'group',
          },
          { name: 'app', label: 'Ứng dụng', kind: 'text', hint: 'Zalo · Telegram · Zalo API…', sample: 'Zalo API' },
          { name: 'capture', label: 'Cách bắt', kind: 'text', hint: 'notification · dom · ws (Zalo API)', sample: 'ws' },
          {
            name: 'threadId',
            label: 'threadId (Zalo API)',
            kind: 'text',
            hint: 'id hội thoại thật — chỉ nhánh Zalo API mới có; DOM để trống',
            sample: 'g8134772156',
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
        fields: INFRA_FIELDS,
      },
      {
        type: 'infra.recovered',
        label: 'Đã hồi phục',
        blurb: 'Chỉ số quay lại bình thường sau khi đã cảnh báo.',
        fields: [
          ...INFRA_FIELDS,
          { name: 'downSec', label: 'Thời gian vi phạm (giây)', kind: 'number', sample: 340 },
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

/** Gộp số liệu nhiều node thành MỘT con số thế nào — khớp maxOf/minOf/sumOf trong sources/infra.ts. */
export type MetricAgg = 'max' | 'min' | 'sum' | 'count';

// Nhãn cố ý nói "giá trị" chứ không nói "node": Redis gộp theo node nhưng
// Kafka lag gộp theo consumer group — cùng một phép max, khác đơn vị gộp.
export const AGG_LABEL: Record<MetricAgg, string> = {
  max: 'lấy giá trị cao nhất trong cụm (xấu nhất thắng)',
  min: 'lấy giá trị thấp nhất trong cụm (xấu nhất thắng)',
  sum: 'cộng tổng toàn cụm',
  count: 'đếm trên toàn cụm',
};

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
  /**
   * Mã ngữ nghĩa cho alertType (`stack.mã.hướng`, vd `redis.ram.high`) — định
   * danh ỔN ĐỊNH để hệ thống ngoài (bot AI, webhook) phân loại cảnh báo mà
   * không parse tiếng Việt. Trống → dùng chính `key`. Metric `up` là ngoại lệ:
   * alertType = `stack.down` (xem meta.ts).
   */
  alertCode?: string;
  /** Chỉ số này NGHĨA là gì và vì sao đáng quan tâm (1–2 câu, cho description). */
  meaning?: string;
  /** Probe đọc nó bằng gì: 'lệnh INFO', '/_cat/nodes', 'SELECT 1'… */
  probe?: string;
  /** Cách gộp nhiều node. Trống = số liệu vốn là một con số duy nhất. */
  agg?: MetricAgg;
  /**
   * Cặp chỉ số TUYỆT ĐỐI đi kèm khi metric (thường là %) này cảnh báo — vì 90%
   * của 1GB nguy hiểm khác hẳn 90% của 20GB. `used`/`total` là key metric khác
   * trong CÙNG lần đo (watcher đưa cả MetricMap vào event), nên hai con số luôn
   * cùng thời điểm; các probe cũng lấy chúng từ CÙNG NODE với con số % (node
   * xấu nhất) để không tự mâu thuẫn. Sinh ra fields absUsed/absTotal/absLeft/
   * absText trên event.
   */
  absolute?: { used: string; total: string; unit: string };
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

const KAFKA_HOST_NOTE =
  'Rẻ và KHÔNG đụng vào Kafka: đọc HTTP node_exporter của từng broker host (song song, timeout 5s/host), ' +
  'không gọi broker hay controller lượt nào. Chi phí không tăng theo số topic/group — chỉ theo số host. ' +
  'Chỉ hoạt động khi cụm đã khai "Metrics URL" trong cấu hình kết nối; chưa khai thì mọi chỉ số host vắng mặt ' +
  'và watch không bao giờ khớp (nên bật nhầm cũng không sinh báo giả).';

const ES_NODES_NOTE =
  'Ngoài /_cluster/health còn gọi thêm /_cat/nodes (một round-trip nữa, master trả lời). Nên để ≥60s.';

const MONGO_STATUS_NOTE =
  'serverStatus + dbStats + replSetGetStatus mỗi lần đo. serverStatus rẻ, nhưng dbStats phải tổng hợp dung lượng ' +
  'nên nặng dần theo số collection. Nên để ≥60s; cụm nhiều collection thì 300s cho các chỉ số đĩa.';

const RABBIT_NODES_NOTE =
  'Ngoài /api/overview còn gọi /api/nodes. Management plugin của RabbitMQ tính số liệu ngay lúc được hỏi, ' +
  'nên hỏi quá dày sẽ ăn CPU của chính node. Nên để ≥60s.';

// ── Probe descriptions, written once and shared ─────────────────────────────
// `probe` nói máy ĐO BẰNG GÌ — nó đi vào description của mọi cảnh báo, nên một
// người trực (hoặc bot AI) đọc tin nhắn là biết con số đến từ đâu.

const REDIS_PROBE = 'lệnh INFO trên từng node';
const MONGO_PROBE = 'serverStatus + dbStats + replSetGetStatus';
const ES_HEALTH_PROBE = '/_cluster/health';
const ES_NODES_PROBE = '/_cluster/health + /_cat/nodes';
const KAFKA_META_PROBE = 'describeCluster + metadata toàn bộ topic';
const KAFKA_LAG_PROBE = 'listGroups + describeGroups + fetchOffsets cho từng consumer group';
const KAFKA_HOST_PROBE = 'node_exporter /metrics của từng broker host';
const RABBIT_OVERVIEW_PROBE = '/api/overview (management API)';
const RABBIT_NODES_PROBE = '/api/overview + /api/nodes (management API)';
const PG_PROBE = 'truy vấn ping (SELECT 1)';

/** `up` exists for every stack: 1 = probe succeeded, 0 = unreachable. */
const UP: MetricDef = {
  key: 'up',
  label: 'Kết nối được',
  unit: '0/1',
  suggest: { op: 'lt', threshold: 1 },
  hint: 'Cảnh báo mất kết nối: up < 1',
  // alertType của `up` được đặc cách thành `stack.down` trong meta.ts.
  meaning:
    'DevBox mở kết nối và hỏi trạng thái: 1 = máy chủ trả lời, 0 = không kết nối được (sập, nghẽn, sai thông tin đăng nhập, mất mạng/VPN). Mất kết nối là sự cố trực tiếp với mọi dịch vụ đang dùng hệ thống này.',
};
const LATENCY: MetricDef = {
  key: 'latencyMs',
  label: 'Độ trễ probe',
  unit: 'ms',
  suggest: { op: 'gt', threshold: 1000 },
  alertCode: 'latency',
  meaning: 'thời gian từ lúc DevBox hỏi đến lúc dịch vụ trả lời; tăng đột biến là mạng hoặc máy chủ đang nghẽn.',
};

export const STACKS: StackDef[] = [
  {
    id: 'redis',
    label: 'Redis',
    icon: '🧠',
    metrics: [
      { ...UP, probe: REDIS_PROBE },
      {
        key: 'memUsedPct',
        label: 'RAM đã dùng',
        unit: '%',
        suggest: { op: 'gt', threshold: 80 },
        alertCode: 'ram',
        probe: REDIS_PROBE,
        agg: 'max',
        absolute: { used: 'memUsedMb', total: 'memTotalMb', unit: 'MB' },
        meaning:
          'tỉ lệ bộ nhớ Redis đang dùng so với giới hạn maxmemory; node không đặt maxmemory thì so với RAM hệ thống. RAM đầy khiến Redis từ chối ghi (OOM) hoặc bắt đầu evict key.',
      },
      {
        key: 'memUsedMb',
        label: 'RAM đã dùng',
        unit: 'MB',
        alertCode: 'ram',
        probe: REDIS_PROBE,
        agg: 'sum',
        meaning: 'tổng bộ nhớ mọi node đang giữ, tính bằng MB — dùng khi muốn ngưỡng tuyệt đối thay vì phần trăm.',
      },
      {
        key: 'memTotalMb',
        label: 'RAM giới hạn',
        unit: 'MB',
        alertCode: 'ram',
        probe: REDIS_PROBE,
        agg: 'sum',
        meaning: 'tổng giới hạn bộ nhớ (maxmemory; node không đặt thì lấy RAM hệ thống) của mọi node — mẫu số của memUsedPct.',
      },
      {
        key: 'clients',
        label: 'Client đang kết nối',
        suggest: { op: 'gt', threshold: 5000 },
        alertCode: 'conn',
        probe: REDIS_PROBE,
        agg: 'sum',
        meaning: 'tổng số client đang mở kết nối; tăng vọt thường do rò kết nối hoặc connection pool cấu hình sai phía ứng dụng.',
      },
      {
        key: 'opsPerSec',
        label: 'Ops/giây',
        suggest: { op: 'gt', threshold: 50000 },
        alertCode: 'ops',
        probe: REDIS_PROBE,
        agg: 'sum',
        meaning: 'tổng số lệnh Redis xử lý mỗi giây — thước đo tải; đột biến là có nơi gọi bất thường.',
      },
      {
        key: 'hitRatePct',
        label: 'Tỉ lệ cache hit',
        unit: '%',
        hint: '⚠ Chỉ có nghĩa với instance dùng làm CACHE. Redis làm queue/lock/session thì hit-rate thấp là bình thường — đặt ngưỡng ở đây sẽ báo sai liên tục.',
        alertCode: 'hitrate',
        probe: REDIS_PROBE,
        agg: 'min',
        meaning: 'tỉ lệ lệnh đọc trúng cache; chỉ có nghĩa với instance làm CACHE — tụt sâu là cache đang bị evict hoặc pattern truy cập đổi.',
      },
      {
        key: 'fragmentation',
        label: 'Tỉ lệ phân mảnh',
        suggest: { op: 'gt', threshold: 1.6 },
        alertCode: 'frag',
        probe: REDIS_PROBE,
        agg: 'max',
        meaning: 'tỉ lệ RAM hệ điều hành cấp cho Redis so với dữ liệu thật (RSS/used_memory); vượt ~1.5 thường sau khi xoá key hàng loạt — RAM bị giữ mà không chứa gì.',
      },
      {
        key: 'nodes',
        label: 'Số node đọc được',
        alertCode: 'nodes',
        probe: REDIS_PROBE,
        agg: 'count',
        meaning: 'số node trả lời probe; giảm so với bình thường nghĩa là có node trong cụm không trả lời.',
      },
    ],
  },
  {
    id: 'mongo',
    label: 'MongoDB',
    icon: '🍃',
    metrics: [
      { ...UP, probe: MONGO_PROBE },
      {
        key: 'connectionsUsedPct',
        label: 'Connection pool đã dùng',
        unit: '%',
        suggest: { op: 'gt', threshold: 80 },
        alertCode: 'conn',
        probe: MONGO_PROBE,
        absolute: { used: 'connections', total: 'connectionsTotal', unit: '' },
        meaning: 'tỉ lệ connection đã dùng so với giới hạn của mongod; chạm 100% là client mới bị từ chối kết nối.',
      },
      {
        key: 'connections',
        label: 'Connection hiện tại',
        alertCode: 'conn',
        probe: MONGO_PROBE,
        meaning: 'số connection đang mở tới mongod — dùng khi muốn ngưỡng tuyệt đối.',
      },
      {
        key: 'connectionsTotal',
        label: 'Connection tối đa',
        alertCode: 'conn',
        probe: MONGO_PROBE,
        meaning: 'trần connection của mongod (đang mở + còn trống) — mẫu số của connectionsUsedPct.',
      },
      {
        key: 'cacheUsedPct',
        label: 'WiredTiger cache',
        unit: '%',
        hint: '⚠ WiredTiger được thiết kế để giữ cache ~80–95% — đây là hành vi BÌNH THƯỜNG, không phải sự cố. Đừng đặt ngưỡng ở đây.',
        alertCode: 'cache',
        probe: MONGO_PROBE,
        absolute: { used: 'cacheUsedMb', total: 'cacheTotalMb', unit: 'MB' },
        meaning: 'mức dùng cache WiredTiger; 80–95% là vùng thiết kế bình thường, chỉ bất thường khi kèm dấu hiệu khác.',
      },
      {
        key: 'cacheUsedMb',
        label: 'WiredTiger cache đã dùng',
        unit: 'MB',
        alertCode: 'cache',
        probe: MONGO_PROBE,
        meaning: 'dung lượng cache WiredTiger đang giữ, tính bằng MB.',
      },
      {
        key: 'cacheTotalMb',
        label: 'WiredTiger cache tối đa',
        unit: 'MB',
        alertCode: 'cache',
        probe: MONGO_PROBE,
        meaning: 'giới hạn cache WiredTiger cấu hình cho mongod — mẫu số của cacheUsedPct.',
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
        alertCode: 'disk',
        probe: MONGO_PROBE,
        absolute: { used: 'diskUsedGb', total: 'diskTotalGb', unit: 'GB' },
        meaning: 'tỉ lệ đĩa đã dùng trên filesystem chứa dữ liệu; đĩa đầy là mongod dừng ghi.',
      },
      {
        key: 'diskUsedGb',
        label: 'Đĩa đã dùng',
        unit: 'GB',
        cost: 'medium',
        costNote: MONGO_STATUS_NOTE,
        minEverySec: 60,
        alertCode: 'disk',
        probe: MONGO_PROBE,
        meaning: 'dung lượng đĩa đã dùng trên filesystem chứa dữ liệu, tính bằng GB.',
      },
      {
        key: 'diskTotalGb',
        label: 'Dung lượng đĩa',
        unit: 'GB',
        cost: 'medium',
        costNote: MONGO_STATUS_NOTE,
        minEverySec: 60,
        alertCode: 'disk',
        probe: MONGO_PROBE,
        meaning: 'tổng dung lượng filesystem chứa dữ liệu — mẫu số của diskUsedPct.',
      },
      {
        key: 'memResidentMb',
        label: 'RAM resident',
        unit: 'MB',
        alertCode: 'ram',
        probe: MONGO_PROBE,
        meaning: 'RAM tiến trình mongod đang giữ (resident), tính bằng MB.',
      },
      {
        key: 'replLagSec',
        label: 'Replication lag',
        unit: 's',
        suggest: { op: 'gt', threshold: 10 },
        alertCode: 'repllag',
        probe: MONGO_PROBE,
        agg: 'max',
        meaning: 'độ trễ của secondary chậm nhất so với primary; lag cao nghĩa là đọc từ secondary bị dữ liệu cũ và failover sẽ mất dữ liệu mới nhất.',
      },
      {
        key: 'membersUnhealthy',
        label: 'Member lỗi',
        suggest: { op: 'gt', threshold: 0 },
        alertCode: 'members',
        probe: MONGO_PROBE,
        agg: 'count',
        meaning: 'số member trong replica set tự báo không khỏe (state khác PRIMARY/SECONDARY/ARBITER khỏe mạnh).',
      },
    ],
  },
  {
    id: 'es',
    label: 'Elasticsearch',
    icon: '🔎',
    metrics: [
      { ...UP, probe: ES_HEALTH_PROBE },
      {
        key: 'statusLevel',
        label: 'Trạng thái cluster',
        unit: '0=green 1=yellow 2=red',
        suggest: { op: 'gte', threshold: 1 },
        alertCode: 'status',
        probe: ES_HEALTH_PROBE,
        meaning: 'trạng thái cluster ES tự báo: 0=green, 1=yellow (thiếu bản sao — mất thêm node là mất dữ liệu), 2=red (mất primary shard — CÓ dữ liệu không đọc được ngay bây giờ).',
      },
      {
        key: 'unassignedShards',
        label: 'Shard chưa gán',
        suggest: { op: 'gt', threshold: 0 },
        alertCode: 'shards',
        probe: ES_HEALTH_PROBE,
        meaning: 'số shard chưa được gán vào node nào — nguyên nhân trực tiếp của yellow/red; thường do node rời cụm hoặc đĩa đầy chặn phân bổ.',
      },
      {
        key: 'relocatingShards',
        label: 'Shard đang di chuyển',
        alertCode: 'shards',
        probe: ES_HEALTH_PROBE,
        meaning: 'số shard đang chuyển giữa các node; nhiều và kéo dài nghĩa là cụm đang tái cân bằng nặng, ăn I/O và băng thông.',
      },
      {
        key: 'pendingTasks',
        label: 'Pending tasks',
        suggest: { op: 'gt', threshold: 10 },
        alertCode: 'tasks',
        probe: ES_HEALTH_PROBE,
        meaning: 'số task quản trị đang xếp hàng chờ master xử lý; tăng dần là master quá tải.',
      },
      // These four come from the second call, /_cat/nodes.
      {
        key: 'heapPct',
        label: 'Heap cao nhất',
        unit: '%',
        suggest: { op: 'gt', threshold: 85 },
        cost: 'medium',
        costNote: ES_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'heap',
        probe: ES_NODES_PROBE,
        agg: 'max',
        meaning: 'mức dùng heap JVM của node cao nhất trong cụm; heap cao kéo dài gây GC liên tục, truy vấn chậm và node có thể rớt khỏi cụm.',
      },
      {
        key: 'cpuPct',
        label: 'CPU cao nhất',
        unit: '%',
        suggest: { op: 'gt', threshold: 90 },
        cost: 'medium',
        costNote: ES_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'cpu',
        probe: ES_NODES_PROBE,
        agg: 'max',
        meaning: 'mức dùng CPU của node bận nhất trong cụm.',
      },
      {
        key: 'diskUsedPct',
        label: 'Đĩa cao nhất',
        unit: '%',
        suggest: { op: 'gt', threshold: 85 },
        cost: 'medium',
        costNote: ES_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'disk',
        probe: ES_NODES_PROBE,
        agg: 'max',
        absolute: { used: 'diskUsedGb', total: 'diskTotalGb', unit: 'GB' },
        meaning: 'tỉ lệ đĩa đã dùng của node đầy nhất; chạm ~85% ES ngừng phân bổ shard mới vào node đó, ~95% chuyển index sang chỉ-đọc.',
      },
      {
        key: 'diskUsedGb',
        label: 'Đĩa đã dùng (node đầy nhất)',
        unit: 'GB',
        cost: 'medium',
        costNote: ES_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'disk',
        probe: ES_NODES_PROBE,
        meaning: 'dung lượng đĩa đã dùng của CHÍNH node đầy nhất (cùng node với diskUsedPct), tính bằng GB.',
      },
      {
        key: 'diskTotalGb',
        label: 'Dung lượng đĩa (node đầy nhất)',
        unit: 'GB',
        cost: 'medium',
        costNote: ES_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'disk',
        probe: ES_NODES_PROBE,
        meaning: 'tổng dung lượng đĩa của node đầy nhất — mẫu số của diskUsedPct.',
      },
      {
        key: 'load1m',
        label: 'Load 1m cao nhất',
        cost: 'medium',
        costNote: ES_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'load',
        probe: ES_NODES_PROBE,
        agg: 'max',
        meaning: 'load average 1 phút của node nặng nhất trong cụm.',
      },
      {
        key: 'nodes',
        label: 'Số node',
        suggest: { op: 'lt', threshold: 3 },
        alertCode: 'nodes',
        probe: ES_HEALTH_PROBE,
        agg: 'count',
        meaning: 'số node đang có mặt trong cụm; giảm so với bình thường là có node vừa rời cụm.',
      },
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
      {
        ...UP,
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
        probe: KAFKA_META_PROBE,
        // Riêng Kafka, khi mất kết nối DevBox đo thêm TỪNG seed broker (bắt tay
        // TCP) rồi đính vào cảnh báo — nói rõ node nào chết thay vì chỉ "0/1".
        meaning: `${UP.meaning} Riêng Kafka: khi mất kết nối, DevBox bắt tay TCP tới TỪNG broker `
          + 'trong danh sách để chỉ rõ node nào không kết nối được và lỗi gì (ECONNREFUSED = máy sống '
          + 'nhưng Kafka không nghe cổng · timeout = gói không tới nơi, thường do mất mạng/VPN hoặc '
          + 'firewall), kèm một câu kết luận hướng xử lý.',
      },
      {
        key: 'underReplicated',
        label: 'Partition under-replicated',
        suggest: { op: 'gt', threshold: 0 },
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
        alertCode: 'replication',
        probe: KAFKA_META_PROBE,
        meaning: 'số partition thiếu bản sao trong ISR — dữ liệu vẫn đọc/ghi được nhưng mất thêm broker nữa là mất dữ liệu.',
      },
      {
        key: 'offline',
        label: 'Partition offline',
        suggest: { op: 'gt', threshold: 0 },
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
        alertCode: 'partition',
        probe: KAFKA_META_PROBE,
        meaning: 'số partition không có leader — producer/consumer vào các partition này đang lỗi NGAY BÂY GIỜ.',
      },
      {
        key: 'brokers',
        label: 'Số broker',
        suggest: { op: 'lt', threshold: 3 },
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
        alertCode: 'brokers',
        probe: KAFKA_META_PROBE,
        agg: 'count',
        meaning: 'số broker đang sống trong cụm; giảm là có broker vừa rớt.',
      },
      {
        key: 'noController',
        label: 'Mất controller',
        unit: '0/1',
        suggest: { op: 'gte', threshold: 1 },
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
        alertCode: 'controller',
        probe: KAFKA_META_PROBE,
        meaning: '1 = cụm không có controller — không ai điều phối bầu leader, sự cố partition sẽ không tự hồi phục.',
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
        alertCode: 'lag',
        probe: KAFKA_LAG_PROBE,
        agg: 'max',
        meaning: 'chênh lệch giữa offset cuối của topic và offset đã commit, của group tụt hậu nhiều nhất; group không đọc được lag bị loại khỏi phép tính (không đoán là 0). Cluster có thể vẫn "xanh" mà lag cao — nghĩa là nghiệp vụ đang xử lý chậm hoặc consumer đã chết.',
      },
      {
        key: 'stalledGroups',
        label: 'Group đứng im',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'Còn lag nhưng offset KHÔNG nhích qua ≥30s — consumer chết dù vẫn kết nối',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
        alertCode: 'stalled',
        probe: KAFKA_LAG_PROBE,
        agg: 'count',
        meaning: 'số group còn lag nhưng offset KHÔNG nhích qua ≥30s — consumer chết dù vẫn giữ kết nối; group đang bắt kịp thì không tính.',
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
        alertCode: 'stalled',
        probe: KAFKA_LAG_PROBE,
        agg: 'max',
        meaning: 'thời gian group tệ nhất đã đứng im (còn lag, offset không nhích) — dùng thay stalledGroups khi muốn bỏ qua các lần treo ngắn.',
      },
      {
        key: 'deadLagGroups',
        label: 'Group có lag nhưng không consumer (AKHQ vàng)',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'Có message chờ nhưng 0 consumer đang tiêu thụ — "lag vàng", kẹt thật dù nhỏ. Ít báo nhầm hơn "đứng im" (không dính control-record của consumer còn sống)',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
        alertCode: 'consumers',
        probe: KAFKA_LAG_PROBE,
        agg: 'count',
        meaning: 'số group CÒN lag nhưng 0 member đang chạy — không ai tiêu thụ phần message đang chờ (AKHQ tô vàng). Khác "đứng im" (offset không nhích): chỉ số này bỏ qua group còn consumer sống, nên không báo nhầm vì control-record của transaction (lag=1 vĩnh viễn) hay topic nhàn rỗi.',
      },
      {
        key: 'emptyGroups',
        label: 'Group không còn member',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'Có commit offset nhưng 0 consumer đang chạy (kể cả khi đã hết lag)',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
        alertCode: 'consumers',
        probe: KAFKA_LAG_PROBE,
        agg: 'count',
        meaning: 'số group có commit offset nhưng 0 consumer đang chạy — dịch vụ tiêu thụ đã tắt hẳn (kể cả khi lag đã về 0; muốn chỉ báo khi CÒN message chờ thì dùng deadLagGroups).',
      },
      {
        key: 'rebalancingGroups',
        label: 'Group đang rebalance',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'Kéo dài = consumer flapping (chết/sống liên tục)',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
        alertCode: 'rebalance',
        probe: KAFKA_LAG_PROBE,
        agg: 'count',
        meaning: 'số group đang rebalance; rebalance kéo dài là consumer flapping (chết/sống liên tục), nghiệp vụ chập chờn.',
      },
      {
        key: 'totalConsumerLag',
        label: 'Tổng lag toàn cluster',
        unit: 'message',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
        alertCode: 'lag',
        probe: KAFKA_LAG_PROBE,
        agg: 'sum',
        meaning: 'tổng lag cộng dồn của mọi group đọc được — thước đo "khối lượng chưa xử lý" toàn cụm.',
      },
      {
        key: 'lagGroupsUnknown',
        label: 'Group không đọc được lag',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'Lag KHÔNG xác định (không phải 0) — thường do group đang rebalance',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
        alertCode: 'lag',
        probe: KAFKA_LAG_PROBE,
        agg: 'count',
        meaning: 'số group mà probe KHÔNG đọc được lag (thường đang rebalance) — lag của chúng là KHÔNG XÁC ĐỊNH, không phải 0.',
      },
      {
        key: 'undescribedGroups',
        label: 'Group không đọc được trạng thái',
        hint: 'describeGroups lỗi → số member/state không xác định; các chỉ số member bỏ qua group này',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
        alertCode: 'groups',
        probe: KAFKA_LAG_PROBE,
        agg: 'count',
        meaning: 'số group mà describeGroups lỗi — số member/state không xác định, các chỉ số member bỏ qua chúng.',
      },
      {
        key: 'groups',
        label: 'Số consumer group',
        cost: 'heavy',
        costNote: KAFKA_LAG_NOTE,
        minEverySec: 120,
        alertCode: 'groups',
        probe: KAFKA_LAG_PROBE,
        agg: 'count',
        meaning: 'tổng số consumer group cụm đang biết.',
      },
      {
        key: 'topics',
        label: 'Số topic',
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
        alertCode: 'topics',
        probe: KAFKA_META_PROBE,
        agg: 'count',
        meaning: 'tổng số topic trong cụm.',
      },
      {
        key: 'partitions',
        label: 'Số partition',
        cost: 'heavy',
        costNote: KAFKA_META_NOTE,
        minEverySec: 60,
        alertCode: 'partition',
        probe: KAFKA_META_PROBE,
        agg: 'count',
        meaning: 'tổng số partition trong cụm.',
      },

      // ── Chỉ số HOST của broker (node_exporter) ────────────────────────────
      // Kafka không nói gì về máy chạy nó. Mà đĩa đầy là cách một cụm Kafka
      // chết thường gặp nhất và im lặng nhất: mọi chỉ số cluster vẫn "xanh"
      // cho tới đúng lúc broker không ghi được nữa. Chỉ có ở cụm đã khai
      // metricsUrls; cụm chưa khai thì các chỉ số này vắng mặt và watch không
      // bao giờ khớp (metric vắng mặt không được đánh giá).
      {
        key: 'hostDiskUsedPct',
        label: 'Đĩa broker đã dùng',
        unit: '%',
        suggest: { op: 'gt', threshold: 85 },
        hint: 'Mount CHẬT NHẤT trong các broker — đĩa đầy là broker ngừng ghi, cluster vẫn xanh tới phút chót',
        cost: 'cheap',
        costNote: KAFKA_HOST_NOTE,
        minEverySec: 60,
        alertCode: 'hostdisk',
        probe: KAFKA_HOST_PROBE,
        agg: 'max',
        meaning: 'phần trăm đã dùng của phân vùng chật nhất trên các broker host. Kafka ghi log liên tục nên đĩa đầy làm broker ngừng nhận message — và các chỉ số cluster vẫn báo bình thường cho tới đúng lúc đó, nên đây là cảnh báo đi TRƯỚC sự cố.',
      },
      {
        key: 'hostDiskFreeGb',
        label: 'Đĩa broker còn trống',
        unit: 'GB',
        suggest: { op: 'lt', threshold: 20 },
        hint: 'Dùng thay % khi các broker có đĩa lệch nhau nhiều — 10% của 4TB khác hẳn 10% của 100GB',
        cost: 'cheap',
        costNote: KAFKA_HOST_NOTE,
        minEverySec: 60,
        alertCode: 'hostdisk',
        probe: KAFKA_HOST_PROBE,
        agg: 'min',
        meaning: 'dung lượng trống còn lại (GB) trên phân vùng chật nhất của các broker. Dùng thay phần trăm khi các broker có đĩa lệch nhau nhiều: 10% của 4TB là 400GB còn rất thoải mái, 10% của 100GB là sắp chết.',
      },
      {
        key: 'hostMemUsedPct',
        label: 'RAM broker đã dùng',
        unit: '%',
        suggest: { op: 'gt', threshold: 90 },
        hint: 'Kafka dựa vào page cache của OS — RAM cạn là đọc rơi xuống đĩa, độ trễ tăng vọt',
        cost: 'cheap',
        costNote: KAFKA_HOST_NOTE,
        minEverySec: 60,
        alertCode: 'hostram',
        probe: KAFKA_HOST_PROBE,
        agg: 'max',
        meaning: 'phần trăm RAM đã dùng trên broker tốn nhiều nhất (tính theo MemAvailable). Kafka phục vụ phần lớn lượt đọc từ page cache của OS, nên RAM cạn không làm nó chết ngay mà làm mọi lượt đọc rơi xuống đĩa — độ trễ tăng vọt trong khi cluster vẫn xanh.',
      },
      {
        key: 'hostCpuPct',
        label: 'CPU broker',
        unit: '%',
        suggest: { op: 'gt', threshold: 90 },
        hint: 'Cần HAI vòng đo mới có số (tính từ chênh lệch bộ đếm) — vòng đầu luôn vắng mặt',
        cost: 'cheap',
        costNote: KAFKA_HOST_NOTE,
        minEverySec: 60,
        alertCode: 'hostcpu',
        probe: KAFKA_HOST_PROBE,
        agg: 'max',
        meaning: 'phần trăm CPU đang bận trên broker tải cao nhất, tính từ chênh lệch bộ đếm giữa hai vòng đo liên tiếp — nên vòng đo ĐẦU TIÊN sau khi bật watch không có số (chỉ số vắng mặt, không phải 0).',
      },
      {
        key: 'hostLoad1PerCore',
        label: 'Load broker (mỗi core)',
        suggest: { op: 'gt', threshold: 1.5 },
        hint: 'load1 chia số core — ngưỡng dùng chung được cho broker khác cấu hình. >1 = có tiến trình phải xếp hàng',
        cost: 'cheap',
        costNote: KAFKA_HOST_NOTE,
        minEverySec: 60,
        alertCode: 'hostcpu',
        probe: KAFKA_HOST_PROBE,
        agg: 'max',
        meaning: 'load average 1 phút chia cho số core, của broker cao nhất. Chia core rồi thì một ngưỡng dùng chung được cho mọi máy dù khác cấu hình: >1 nghĩa là đã có tiến trình phải xếp hàng chờ CPU, >2 là ngộp thật sự.',
      },
      {
        key: 'hostsDown',
        label: 'Host broker không lấy được số liệu',
        suggest: { op: 'gt', threshold: 0 },
        hint: 'node_exporter tắt / firewall / máy chết — KHÔNG chắc broker đã chết, dùng kèm chỉ số brokers',
        cost: 'cheap',
        costNote: KAFKA_HOST_NOTE,
        minEverySec: 60,
        alertCode: 'hostdown',
        probe: KAFKA_HOST_PROBE,
        agg: 'count',
        meaning: 'số host broker mà node_exporter không trả lời (tắt, firewall, hoặc máy đã chết). Lưu ý đây là chỗ ĐO bị mất chứ chưa chắc broker chết — đối chiếu với chỉ số "Số broker" mới kết luận được: cả hai cùng giảm là máy chết thật, chỉ mình chỉ số này tăng là exporter hỏng.',
      },
      {
        key: 'hostsTotal',
        label: 'Số host broker đang giám sát',
        cost: 'cheap',
        costNote: KAFKA_HOST_NOTE,
        minEverySec: 60,
        alertCode: 'hostdown',
        probe: KAFKA_HOST_PROBE,
        agg: 'count',
        meaning: 'số endpoint node_exporter đã khai trong cấu hình cụm — mẫu số của "host không lấy được số liệu".',
      },
    ],
  },
  {
    id: 'rabbit',
    label: 'RabbitMQ',
    icon: '🐰',
    metrics: [
      { ...UP, probe: RABBIT_OVERVIEW_PROBE },
      {
        key: 'messagesReady',
        label: 'Message tồn (ready)',
        suggest: { op: 'gt', threshold: 10000 },
        alertCode: 'queue',
        probe: RABBIT_OVERVIEW_PROBE,
        agg: 'sum',
        meaning: 'tổng message nằm chờ trong queue chưa có ai nhận; tăng đều nghĩa là consumer không theo kịp tốc độ publish.',
      },
      {
        key: 'messagesUnacked',
        label: 'Message chưa ack',
        suggest: { op: 'gt', threshold: 5000 },
        alertCode: 'queue',
        probe: RABBIT_OVERVIEW_PROBE,
        agg: 'sum',
        meaning: 'message đã giao cho consumer nhưng chưa được ack; cao là consumer xử lý chậm hoặc đang treo giữa chừng.',
      },
      {
        key: 'consumers',
        label: 'Số consumer',
        suggest: { op: 'lt', threshold: 1 },
        alertCode: 'consumers',
        probe: RABBIT_OVERVIEW_PROBE,
        agg: 'count',
        meaning: 'tổng consumer đang đăng ký trên broker; về 0 là không còn ai xử lý message.',
      },
      // Everything below needs the second call, /api/nodes.
      {
        key: 'memAlarm',
        label: 'Cảnh báo RAM',
        unit: '0/1',
        suggest: { op: 'gte', threshold: 1 },
        cost: 'medium',
        costNote: RABBIT_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'ram',
        probe: RABBIT_NODES_PROBE,
        meaning: '1 = có node chạm memory watermark — RabbitMQ CHẶN mọi publisher toàn cụm cho tới khi hạ xuống.',
      },
      {
        key: 'diskAlarm',
        label: 'Cảnh báo đĩa',
        unit: '0/1',
        suggest: { op: 'gte', threshold: 1 },
        cost: 'medium',
        costNote: RABBIT_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'disk',
        probe: RABBIT_NODES_PROBE,
        meaning: '1 = có node còn ít đĩa trống dưới ngưỡng an toàn — cũng chặn publisher toàn cụm như memAlarm.',
      },
      {
        key: 'nodesDown',
        label: 'Node chết',
        suggest: { op: 'gt', threshold: 0 },
        cost: 'medium',
        costNote: RABBIT_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'nodes',
        probe: RABBIT_NODES_PROBE,
        agg: 'count',
        meaning: 'số node trong cụm không chạy.',
      },
      {
        key: 'memUsedPct',
        label: 'RAM node cao nhất',
        unit: '%',
        suggest: { op: 'gt', threshold: 80 },
        cost: 'medium',
        costNote: RABBIT_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'ram',
        probe: RABBIT_NODES_PROBE,
        agg: 'max',
        absolute: { used: 'memUsedMb', total: 'memLimitMb', unit: 'MB' },
        meaning: 'RAM đã dùng so với giới hạn (watermark) của node cao nhất; chạm 100% là node đó giương memAlarm.',
      },
      {
        key: 'memUsedMb',
        label: 'RAM đã dùng (node cao nhất)',
        unit: 'MB',
        cost: 'medium',
        costNote: RABBIT_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'ram',
        probe: RABBIT_NODES_PROBE,
        meaning: 'RAM đang dùng của CHÍNH node căng nhất (cùng node với memUsedPct), tính bằng MB.',
      },
      {
        key: 'memLimitMb',
        label: 'RAM watermark (node cao nhất)',
        unit: 'MB',
        cost: 'medium',
        costNote: RABBIT_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'ram',
        probe: RABBIT_NODES_PROBE,
        meaning: 'giới hạn RAM (memory watermark) của node căng nhất — mẫu số của memUsedPct; chạm là chặn publisher toàn cụm.',
      },
      {
        key: 'fdUsedPct',
        label: 'File descriptor',
        unit: '%',
        suggest: { op: 'gt', threshold: 80 },
        cost: 'medium',
        costNote: RABBIT_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'fd',
        probe: RABBIT_NODES_PROBE,
        agg: 'max',
        absolute: { used: 'fdUsed', total: 'fdTotal', unit: '' },
        meaning: 'tỉ lệ file descriptor đã dùng của node cao nhất; hết fd là node không nhận thêm kết nối mới.',
      },
      {
        key: 'fdUsed',
        label: 'File descriptor đã dùng (node cao nhất)',
        cost: 'medium',
        costNote: RABBIT_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'fd',
        probe: RABBIT_NODES_PROBE,
        meaning: 'số file descriptor đang mở của node căng nhất (cùng node với fdUsedPct).',
      },
      {
        key: 'fdTotal',
        label: 'File descriptor tối đa (node cao nhất)',
        cost: 'medium',
        costNote: RABBIT_NODES_NOTE,
        minEverySec: 60,
        alertCode: 'fd',
        probe: RABBIT_NODES_PROBE,
        meaning: 'trần file descriptor của node căng nhất — mẫu số của fdUsedPct.',
      },
      {
        key: 'queues',
        label: 'Số queue',
        alertCode: 'queue',
        probe: RABBIT_OVERVIEW_PROBE,
        agg: 'count',
        meaning: 'tổng số queue trên broker.',
      },
      {
        key: 'publishRate',
        label: 'Publish/giây',
        alertCode: 'ops',
        probe: RABBIT_OVERVIEW_PROBE,
        agg: 'sum',
        meaning: 'tốc độ message được publish vào broker mỗi giây.',
      },
    ],
  },
  {
    id: 'pg',
    label: 'PostgreSQL',
    icon: '🐘',
    metrics: [
      { ...UP, probe: PG_PROBE },
      { ...LATENCY, probe: PG_PROBE },
    ],
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
