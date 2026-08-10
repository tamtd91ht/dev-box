// Zalo API (thử nghiệm) — biến một khung WebSocket đọc được thành AutomationEvent.
//
// Đây là nửa "ĐIỀU KIỆN từ Zalo" của yêu cầu liên kết automation: khung tin
// nhận qua WebSocket được chuẩn hoá thành đúng `message.received` mà engine đã
// hiểu — nên MỌI rule social hiện có khớp nó không cần sửa engine một dòng.
//
// Khác nguồn `social` (DOM/notification) ở một điểm quyết định: event mang
// `threadId` THẬT trong fields. Rule có thể đọc {{fields.threadId}} rồi đưa
// thẳng vào action `zaloApiSend` để trả lời đúng hội thoại — thứ đường DOM
// không làm được vì không có id.
//
// THỰC TẾ: parser dưới đây CỐ đọc JSON đã giải mã. Khung Zalo mã hoá thì
// `frame.decoded=false` và ta KHÔNG dựng event (không đoán bừa) — trung thực
// đúng như bước thử. Khi/nếu bước reverse mở được payload, chỉ cần sửa parser
// này, phần còn lại của pipeline giữ nguyên.

import type { AutomationEvent } from '@/lib/automation/types';

// Ghi chú lịch sử: bản đầu parse khung WebSocket NGAY TRONG guest (parseFrame +
// zaloApiEvent, dùng WsFrame). Sau khi chuyển sang Đường B (server-side), việc
// giải mã + parse chuyển hẳn về listener.ts, nên phần đó đã bỏ. Ở đây chỉ còn
// ánh xạ tin đã-parse (ServerIncoming) → AutomationEvent.

/** Short stable hash — cùng tin nhận hai lần cho cùng id, engine tự bỏ trùng. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Tin listener server-side đã parse (khớp ZaloIncoming của lib/zaloapi/api). */
export interface ServerIncoming {
  at: number;
  group: boolean;
  threadId: string;
  fromId: string;
  fromName: string;
  text: string;
}

/**
 * Tin NHẬN từ listener server-side → AutomationEvent chuẩn.
 *
 * Đây là nửa "điều kiện từ Zalo" sau khi chuyển sang Đường B: server (listener.ts)
 * đã giải mã + parse khung WebSocket rồi, nên ở đây chỉ còn ánh xạ trường. So với
 * nguồn DOM cũ: event này MANG threadId thật (fields.threadId) → rule đọc được
 * {{fields.threadId}} và đưa thẳng vào action zaloApiSend để trả lời đúng hội thoại.
 */
export function zaloIncomingEvent(
  m: ServerIncoming,
  instanceId: string,
  instanceLabel: string,
): AutomationEvent | null {
  const text = (m.text || '').trim();
  if (!text) return null;
  const ts = Number.isFinite(m.at) ? m.at : Date.now();
  const sender = m.fromName || m.fromId || '';
  // `conversation` phải là TÊN (không phải threadId), để scope "Hội thoại" theo
  // tên khớp được — giống nguồn DOM. threadId thật giữ riêng ở fields.threadId.
  // 1-1: tên người gửi. Nhóm: listener chưa có tên nhóm → tạm dùng name nếu có,
  // không thì threadId (người dùng đặt tên qua danh bạ). Tránh để trống kẻo scope
  // "mọi hội thoại" vẫn ok nhưng scope theo tên thì không có gì để khớp.
  const conversation = sender || m.threadId || '';
  return {
    id: `zaloapi:${instanceId}:${ts}:${hash(m.threadId + '|' + m.fromId + '|' + text)}`,
    ts,
    category: 'social',
    type: 'message.received',
    // sourceId RIÊNG 'zaloapi' — rule có thể giới hạn scope chỉ nhánh API, hoặc
    // để trống scope thì bắt cả DOM lẫn API. Engine không phân biệt, chỉ khớp.
    sourceId: 'zaloapi',
    instanceId,
    instanceLabel,
    title: (m.group ? conversation : sender) || conversation || sender || 'Zalo API',
    text,
    fields: {
      sender,
      conversation,
      chatType: m.group ? 'group' : 'user',
      app: 'Zalo API',
      capture: 'ws',
      /** id hội thoại THẬT — điểm khác biệt so với nguồn DOM. */
      threadId: m.threadId,
    },
  };
}
