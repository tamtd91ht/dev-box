// Zalo API (thử nghiệm) — quản lý listener + đệm tin nhận, server-side.
//
// Listener chạy trong Node (tiến trình Next), automation chạy ở renderer. Cầu
// nối: listener nhét tin vào một hàng đợi trong RAM; renderer POST {op:'poll'}
// mỗi nhịp để hút — cùng kiểu poll mà collector cũ dùng, tránh SSE cho một
// nhánh thử.
//
// Một listener/tài khoản (đúng ràng buộc zca-js). Sống qua hot-reload bằng
// globalThis như session store.

import { ZaloListener, type IncomingMessage, type ListenerState } from './listener';
import type { ZaloContext } from './client';
import { getFreshContext } from './session';
import { learnContact } from './contacts';

interface Hub {
  listener: ZaloListener;
  queue: IncomingMessage[];
  state: ListenerState;
  detail: string;
}

const g = globalThis as typeof globalThis & { __zaloApiListeners?: Map<string, Hub> };
const hubs: Map<string, Hub> = g.__zaloApiListeners ?? (g.__zaloApiListeners = new Map());

const MAX_QUEUE = 200;

/** Bật listener cho một tài khoản (idempotent — gọi lại không tạo cái thứ hai). */
export function startListener(accountKey: string, ctx: ZaloContext): { ok: boolean; detail: string } {
  const existing = hubs.get(accountKey);
  if (existing) return { ok: true, detail: 'listener đã chạy (' + existing.state + ')' };
  if (!ctx.wsUrls.length) return { ok: false, detail: 'không có zpw_ws — bản build này không lộ URL WebSocket, chưa nhận được tin qua API' };

  const hub: Hub = {
    listener: null as unknown as ZaloListener,
    queue: [],
    state: 'connecting',
    detail: 'đang khởi động',
  };
  hub.listener = new ZaloListener(
    ctx,
    (msg) => {
      hub.queue.push(msg);
      if (hub.queue.length > MAX_QUEUE) hub.queue.splice(0, hub.queue.length - MAX_QUEUE);
      // TỰ HỌC danh bạ: hội thoại vừa nhắn tới → có mặt trong danh bạ (id thật +
      // tên + nhóm), để rule chỉ việc chọn thay vì gõ threadId. Ghi đĩa best-effort.
      if (msg.threadId) {
        void learnContact({
          accountKey,
          threadId: msg.threadId,
          name: msg.group ? msg.threadId : (msg.fromName || msg.fromId || msg.threadId),
          group: msg.group,
        }).catch(() => { /* học danh bạ không được làm hỏng nhận tin */ });
      }
    },
    (state, detail) => {
      hub.state = state;
      hub.detail = detail;
    },
    // reauth: trước mỗi lần nối lại, login lại (force) để lấy cookie/secretKey
    // mới. Cookie Zalo có thể đã xoay; nối lại bằng cái cũ là vào vòng rớt.
    async () => {
      try {
        return await getFreshContext(accountKey, true);
      } catch {
        return null;
      }
    },
  );
  hubs.set(accountKey, hub);
  hub.listener.start();
  return { ok: true, detail: 'đã bật listener' };
}

/** Hút tin tích luỹ từ lần poll trước + đếm chẩn đoán. */
export function pollMessages(accountKey: string): {
  state: ListenerState | 'off';
  detail: string;
  messages: IncomingMessage[];
  stats?: ReturnType<ZaloListener['getStats']>;
} {
  const hub = hubs.get(accountKey);
  if (!hub) return { state: 'off', detail: 'listener chưa bật', messages: [] };
  const messages = hub.queue.splice(0, hub.queue.length);
  return { state: hub.state, detail: hub.detail, messages, stats: hub.listener.getStats() };
}

/** Trạng thái listener (không hút hàng đợi). */
export function listenerState(accountKey: string): { state: ListenerState | 'off'; detail: string; queued: number } {
  const hub = hubs.get(accountKey);
  if (!hub) return { state: 'off', detail: 'listener chưa bật', queued: 0 };
  return { state: hub.state, detail: hub.detail, queued: hub.queue.length };
}

/** Dừng + xoá listener (đăng xuất / đổi phiên). */
export function stopListener(accountKey: string): boolean {
  const hub = hubs.get(accountKey);
  if (!hub) return false;
  hub.listener.stop();
  hubs.delete(accountKey);
  return true;
}
