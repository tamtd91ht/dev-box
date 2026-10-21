// Đoán nguyên nhân lag từ vài message đang chờ (lib/kafka peekKafkaPending).
//
// Chỉ là gợi ý để người xem biết nhìn vào đâu — không kết luận. Luật cố ý đơn
// giản, dựa trên thứ thấy được ngay: group còn consumer không, message ĐẦU (cái
// consumer đang kẹt) có khác các message sau không (không phải JSON, quá lớn,
// null, cấu trúc khác), và lag dồn vào một partition hay rải đều.

import type { PendingPage, PreviewMessage } from './kafka';

export interface PendingHint {
  level: 'warn' | 'info';
  text: string;
}

export interface PendingContext {
  /** Số member của group (0 = không có consumer nào chạy). */
  members: number;
  /** Số partition của topic đang có lag trong group này. */
  laggingPartitions: number;
  /** Tổng số partition group đang đọc trên topic. */
  totalPartitions: number;
}

/** Message lớn hơn mức này đáng nghi (mặc định max.partition.fetch.bytes / max.message.bytes ≈ 1 MB). */
const BIG_BYTES = 512 * 1024;

function parseJson(v: string | null): Record<string, unknown> | unknown[] | null | undefined {
  if (v == null) return undefined;
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

const topKeys = (j: unknown): string[] =>
  j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j).sort() : [];

const kb = (n: number): string => `${Math.round(n / 1024)} KB`;

export function pendingHints(page: PendingPage, ctx: PendingContext): PendingHint[] {
  const out: PendingHint[] = [];
  if (ctx.members === 0) {
    out.push({ level: 'warn', text: 'Group không có consumer nào đang chạy — lag do consumer tắt/chết/scale về 0, thường không phải lỗi của message.' });
  }
  if (page.startOffset > page.committed) {
    out.push({ level: 'warn', text: 'Message chưa xử lý đã bị retention xoá — consumer dừng lâu hơn retention của topic.' });
  }
  const msgs = page.messages;
  if (msgs.length === 0) return out;

  const head: PreviewMessage = msgs[0];
  const rest = msgs.slice(1);
  const headLen = head.value?.length ?? 0;

  if (head.valueTruncated || headLen > BIG_BYTES) {
    out.push({ level: 'warn', text: `Message đang kẹt rất lớn (${head.valueTruncated ? '> 1 MB' : kb(headLen)}) — consumer có thể vượt max.partition.fetch.bytes, hết bộ nhớ hoặc xử lý quá max.poll.interval.ms.` });
  }
  if (head.value == null) {
    out.push({ level: 'warn', text: 'Message đang kẹt có value null (tombstone) — consumer không xử lý null có thể lỗi ở đây.' });
  }

  const headJson = parseJson(head.value);
  const restJson = rest.map((m) => parseJson(m.value));
  const restOk = restJson.filter((j) => j !== undefined);
  if (head.value != null && headJson === undefined && rest.length > 0 && restOk.length === rest.length) {
    out.push({ level: 'warn', text: 'Message đang kẹt KHÔNG phải JSON hợp lệ trong khi các message sau đều là JSON — nghi poison message (lỗi deserialize).' });
  } else if (headJson !== undefined && restOk.length >= 2) {
    // Cấu trúc khác số đông các message sau → thiếu/thừa field.
    const sig = (j: unknown) => topKeys(j).join(',');
    const counts = new Map<string, number>();
    for (const j of restOk) counts.set(sig(j), (counts.get(sig(j)) ?? 0) + 1);
    const [common, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n >= 2 && common && sig(headJson) !== common) {
      const want = new Set(common.split(','));
      const have = new Set(topKeys(headJson));
      const missing = [...want].filter((k) => !have.has(k));
      const extra = [...have].filter((k) => !want.has(k));
      const parts = [missing.length ? `thiếu ${missing.slice(0, 5).join(', ')}` : '', extra.length ? `thừa ${extra.slice(0, 5).join(', ')}` : ''].filter(Boolean);
      out.push({ level: 'warn', text: `Message đang kẹt có cấu trúc khác các message sau (${parts.join('; ')}) — consumer có thể lỗi khi đọc field.` });
    }
  }

  if (ctx.members > 0 && ctx.totalPartitions > 1 && ctx.laggingPartitions === 1) {
    out.push({ level: 'info', text: 'Chỉ partition này lag, các partition khác vẫn chạy — thường do một message cụ thể làm consumer lỗi/retry mãi, hoặc một key quá nóng dồn vào partition này.' });
  } else if (ctx.members > 0 && ctx.laggingPartitions > 1 && ctx.laggingPartitions === ctx.totalPartitions) {
    out.push({ level: 'info', text: 'Mọi partition đều lag — nghiêng về consumer xử lý chậm hơn tốc độ ghi (thiếu instance, phụ thuộc ngoài chậm) hơn là một message lỗi.' });
  }

  if (msgs.length > 1 && head.key != null && msgs.every((m) => m.key === head.key)) {
    out.push({ level: 'info', text: `Các message đang chờ cùng một key (${head.key.slice(0, 60)}) — key nóng / một thực thể bị gửi dồn dập.` });
  }
  return out;
}
