// DevBox Automation — AlertMeta: metadata CHUẨN HOÁ của một sự kiện.
//
// Mọi event đã mang đủ dữ kiện trong `fields` phẳng (để {{var}} và điều kiện
// dùng thẳng); module này DẪN XUẤT từ đó một JSON có cấu trúc, phiên bản hoá —
// thứ một hệ thống NGOÀI (webhook, bot AI đọc tin nhắn trong nhóm Zalo) parse
// được mà không phải hiểu tiếng Việt trong title/text.
//
// Nguyên tắc: thuần tuý như match.ts — chỉ import catalog + types, không I/O,
// không state. Meta KHÔNG lưu trên event; nó được dựng lại lúc render template
// ({{metaJson}} / {{metaJsonPretty}}, xem match.ts).

import type { AutomationEvent, EventCategory, InfraStack, InfraWatch, TriggerType } from './types';
import { AGG_LABEL, metricDef, metricLabel, type FieldDef } from './catalog';

/**
 * Bump khi đổi shape — bot phía ngoài dựa vào số này để parse đúng.
 *
 * Quy ước cho bot: KHÔNG có marker bọc. Bot tách metadata bằng cách tìm trong
 * tin nhắn dòng/đoạn JSON bắt đầu bằng `{"schemaVersion":` rồi JSON.parse.
 */
export const META_SCHEMA_VERSION = 1;

/** Ký hiệu người đọc của phép so sánh — dùng chung cho description, text và meta. */
export const OP_TEXT: Record<InfraWatch['op'], string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
};

// ── alertType — mã cảnh báo ổn định ─────────────────────────────────────────

/** Hướng vi phạm, đọc từ phép so sánh: vượt lên (high) hay tụt xuống (low). */
const DIRECTION: Record<InfraWatch['op'], string> = {
  gt: 'high',
  gte: 'high',
  lt: 'low',
  lte: 'low',
  eq: 'eq',
  neq: 'ne',
};

/**
 * Mã định danh loại cảnh báo: `stack.mã.hướng` — vd `redis.ram.high`,
 * `kafka.lag.high`, `mongo.repllag.high`. Metric `up` đặc cách thành
 * `stack.down`: vi phạm `up < 1` CHÍNH LÀ "sập", thêm đuôi hướng chỉ gây rối.
 * Breach và recovery mang CÙNG một mã — bot ghép cặp bằng watchId + alertType.
 */
export function alertTypeOf(stack: InfraStack, metric: string, op: InfraWatch['op']): string {
  if (metric === 'up') return `${stack}.down`;
  const code = metricDef(stack, metric)?.alertCode ?? metric.toLowerCase();
  return `${stack}.${code}.${DIRECTION[op] ?? op}`;
}

// ── description — cơ chế phát hiện, tự sinh từ catalog ─────────────────────

export interface DescriptionInput {
  stack: InfraStack;
  metric: string;
  op: InfraWatch['op'];
  threshold: number;
  everySec: number;
  forSec?: number;
  /** Ghi chú nghiệp vụ của watch — phần ngữ cảnh catalog không thể biết. */
  note?: string;
}

/**
 * Mô tả một cảnh báo TỰ GIẢI THÍCH: chỉ số nghĩa là gì (meaning), máy đo bằng
 * gì và bao lâu một lần (probe + everySec + agg), ngưỡng phát là gì (op +
 * threshold + forSec), rồi nối ghi chú riêng của watch. Người trực — hoặc bot
 * AI kéo tin nhắn về phân tích — đọc mỗi đoạn này là đủ ngữ cảnh, không cần
 * mở DevBox.
 */
export function buildDescription(w: DescriptionInput): string {
  const md = metricDef(w.stack, w.metric);
  const label = metricLabel(w.stack, w.metric);
  const meaning = md?.meaning ?? 'chỉ số theo dõi hạ tầng.';
  const probe = md?.probe ?? 'probe qua kết nối đã khai báo trong DevBox';
  const agg = md?.agg ? `, ${AGG_LABEL[md.agg]}` : '';
  const hold = (w.forSec ?? 0) > 0 ? ` liên tục ≥ ${w.forSec}s` : ' (báo ngay khi chạm ngưỡng)';
  const note = (w.note ?? '').trim();
  return (
    `${label} — ${meaning} ` +
    `DevBox đo bằng ${probe} mỗi ${w.everySec}s${agg}. ` +
    `Cảnh báo phát khi giá trị ${OP_TEXT[w.op] ?? w.op} ${w.threshold}${hold}.` +
    (note ? ` Ghi chú: ${note}` : '')
  );
}

/** "340" → "5 phút 40 giây" — cho recovery.downText. */
export function humanizeSec(total: number): string {
  const s = Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} giờ`);
  if (m) parts.push(`${m} phút`);
  if (r || !parts.length) parts.push(`${r} giây`);
  return parts.join(' ');
}

// ── AlertMeta — schema v1 ───────────────────────────────────────────────────

export interface AlertMetaMetric {
  key: string;
  label: string;
  unit: string;
}

export interface AlertMetaThreshold {
  op: string;
  opText: string;
  value: number;
}

export interface AlertMetaWatch {
  id: string;
  name: string;
  everySec: number;
  forSec: number;
  tags: string[];
  note?: string;
}

export interface AlertMetaDetection {
  /** Máy đo BẰNG GÌ — chuỗi probe từ catalog. */
  method: string;
  intervalSec: number;
  holdSec: number;
  /** Cách gộp nhiều node, khi metric có. */
  aggregation?: string;
}

export interface AlertMetaRecovery {
  downSec: number;
  downText: string;
}

/**
 * Con số TUYỆT ĐỐI đi kèm con số %: 90% RAM của tổng bao nhiêu, còn lại bao
 * nhiêu — 10% còn lại là 100MB thì nguy, là 2GB thì chưa chắc. Chỉ xuất hiện
 * khi metric có cặp used/total trong catalog và probe đọc được cả hai.
 */
export interface AlertMetaAbsolute {
  used: number;
  total: number;
  left: number;
  unit: string;
  /** Bản chữ người đọc: "3.8 GB / 4.0 GB · còn 197 MB". */
  text: string;
}

/**
 * Metadata chuẩn của MỘT sự kiện automation. Phần chung luôn có; phần infra /
 * social chỉ xuất hiện đúng nhóm. Đây là hợp đồng với hệ thống ngoài — đổi
 * shape thì bump META_SCHEMA_VERSION.
 */
export interface AlertMeta {
  schemaVersion: number;
  /** = event.category: infra · social · system. */
  module: EventCategory;
  /** = event.sourceId: redis · mongo · zalo · zaloapi … */
  type: string;
  /** Sự kiện là gì: breach · recovered · message · test. */
  event: 'breach' | 'recovered' | 'message' | 'test';
  trigger: TriggerType;
  /** Tên kết nối / tài khoản (instanceLabel). */
  name: string;
  /** ISO 8601. */
  at: string;
  title: string;

  // ── infra ──
  alertType?: string;
  severity?: string;
  severityLabel?: string;
  address?: string;
  metric?: AlertMetaMetric;
  threshold?: AlertMetaThreshold;
  current?: number;
  absolute?: AlertMetaAbsolute;
  watch?: AlertMetaWatch;
  detection?: AlertMetaDetection;
  description?: string;
  recovery?: AlertMetaRecovery;

  // ── social ──
  conversation?: string;
  sender?: string;
  chatType?: string;
  app?: string;
  capture?: string;
  threadId?: string;

  // ── social + system ──
  text?: string;
  /** system.test: bảng thử cho nhập field tự do — giữ nguyên văn. */
  fields?: Record<string, string | number>;
}

const KIND: Partial<Record<TriggerType, AlertMeta['event']>> = {
  'infra.metric': 'breach',
  'infra.recovered': 'recovered',
  'message.received': 'message',
  'system.test': 'test',
};

const s = (v: string | number | undefined): string => (v === undefined || v === null ? '' : String(v));
const n = (v: string | number | undefined): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Dựng AlertMeta từ một event — dẫn xuất thuần tuý, không đụng I/O. Event cũ
 * (ghi trước khi có các field mới) vẫn dựng được: field thiếu thành ''/0 chứ
 * không vỡ, để {{metaJson}} không bao giờ làm hỏng một action đang chạy.
 */
export function buildAlertMeta(event: AutomationEvent): AlertMeta {
  const f = event.fields ?? {};
  const base = {
    schemaVersion: META_SCHEMA_VERSION,
    module: event.category,
    type: event.sourceId ?? '',
    event: KIND[event.type] ?? ('test' as const),
    trigger: event.type,
    name: event.instanceLabel ?? '',
    at: Number.isFinite(event.ts) ? new Date(event.ts).toISOString() : '',
    title: event.title ?? '',
  };

  if (event.category === 'infra') {
    const stack = s(f.stack) as InfraStack;
    const metric = s(f.metric);
    const md = metricDef(stack, metric);
    const note = s(f.note).trim();
    const meta: AlertMeta = {
      ...base,
      alertType: s(f.alertType),
      severity: s(f.severity),
      severityLabel: s(f.severityLabel),
      address: s(f.address),
      metric: { key: metric, label: s(f.metricLabel), unit: s(f.unit) || (md?.unit ?? '') },
      threshold: {
        op: s(f.op),
        opText: s(f.opText) || OP_TEXT[s(f.op) as InfraWatch['op']] || s(f.op),
        value: n(f.threshold),
      },
      current: n(f.value),
      // absText mang sẵn " · " đầu chuỗi (cho template) — bản trong meta bỏ đi.
      ...(typeof f.absTotal === 'number' && f.absTotal > 0
        ? {
            absolute: {
              used: n(f.absUsed),
              total: n(f.absTotal),
              left: n(f.absLeft),
              unit: s(f.absUnit),
              text: s(f.absText).replace(/^ · /, ''),
            },
          }
        : {}),
      watch: {
        id: s(f.watchId),
        name: s(f.watch),
        everySec: n(f.everySec),
        forSec: n(f.forSec),
        tags: s(f.tags)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        ...(note ? { note } : {}),
      },
      detection: {
        method: md?.probe ?? 'probe qua kết nối đã khai báo trong DevBox',
        intervalSec: n(f.everySec),
        holdSec: n(f.forSec),
        ...(md?.agg ? { aggregation: AGG_LABEL[md.agg] } : {}),
      },
      description: s(f.description),
    };
    if (event.type === 'infra.recovered') {
      meta.recovery = { downSec: n(f.downSec), downText: humanizeSec(n(f.downSec)) };
    }
    return meta;
  }

  if (event.category === 'social') {
    return {
      ...base,
      conversation: s(f.conversation),
      sender: s(f.sender),
      chatType: s(f.chatType),
      app: s(f.app),
      capture: s(f.capture),
      threadId: s(f.threadId),
      text: event.text ?? '',
    };
  }

  // system.* — bảng thử cho nhập field tuỳ ý, giữ nguyên văn.
  return { ...base, text: event.text ?? '', fields: { ...f } };
}

// ── Biến template lõi — tài liệu MÁY ĐỌC ĐƯỢC cho UI ───────────────────────
//
// templateVars() (match.ts) tạo các biến này cho MỌI event; danh sách dưới đây
// là bản khai báo để bảng "Biến khả dụng" render — cùng một FieldDef với
// catalog để một component hiển thị được cả hai. `derived: true` vì chúng
// không nằm trong event.fields (script check:automation bỏ qua chúng).

export const TEMPLATE_CORE_VARS: FieldDef[] = [
  { name: 'category', label: 'Nhóm sự kiện', kind: 'text', hint: 'social · infra · system', sample: 'infra', derived: true },
  { name: 'type', label: 'Loại trigger', kind: 'text', sample: 'infra.metric', derived: true },
  { name: 'instanceId', label: 'Id kết nối / tài khoản', kind: 'text', sample: 'omicrm-fusionpbx', derived: true },
  { name: 'id', label: 'Id sự kiện', kind: 'text', sample: 'watch:w-redis…:breach:1786538553712', derived: true },
  { name: 'ts', label: 'Epoch (ms)', kind: 'number', sample: 1786538553712, derived: true },
  { name: 'iso', label: 'Thời điểm (ISO)', kind: 'text', sample: '2026-08-12T02:30:00.000Z', derived: true },
  { name: 'time', label: 'Giờ (HH:mm:ss)', kind: 'text', sample: '09:30:00', derived: true },
  { name: 'date', label: 'Ngày (DD/MM/YYYY)', kind: 'text', sample: '12/08/2026', derived: true },
  { name: 'json', label: 'Cả event (JSON)', kind: 'text', hint: 'nguyên văn AutomationEvent — body mặc định của webhook', derived: true },
  { name: 'm1', label: 'Nhóm bắt regex', kind: 'text', hint: 'm1…m9 — các nhóm () của điều kiện regex khớp được', derived: true },
  {
    name: 'metaJson',
    label: 'Metadata chuẩn (JSON nén)',
    kind: 'text',
    hint: 'AlertMeta v1 trên một dòng — dùng cho webhook body hoặc nhúng vào tin nhắn',
    derived: true,
  },
  { name: 'metaJsonPretty', label: 'Metadata chuẩn (JSON thụt dòng)', kind: 'text', derived: true },
];
