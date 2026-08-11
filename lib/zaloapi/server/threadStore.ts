// Zalo API (thử nghiệm) — kho tin theo HỘI THOẠI, server-side, CHỈ TRONG RAM.
//
// Vì sao có kho này: listener cũ chỉ có một hàng đợi "drain-rồi-xoá" để nuôi
// automation — hút xong là mất, không giữ lịch sử. Màn chat cần thấy lại các tin
// trước đó của từng hội thoại và gom cả hai chiều (mình gửi + người gửi) vào
// đúng một luồng. Kho này giữ tin theo threadId để dựng màn chat như app thường.
//
// Cùng kỷ luật với session store: KHÔNG ghi đĩa (credential/tin cá nhân toàn
// quyền), sống qua hot-reload bằng globalThis, tự giới hạn để không phình RAM.

import type { IncomingMessage } from './listener';

/** Một tin đã lưu để dựng bong bóng chat. */
export interface StoredMessage {
  /** id ổn định để React key + khử trùng. */
  id: string;
  at: number;
  /** true = tin do CHÍNH tài khoản này gửi (bong bóng bên phải). */
  self: boolean;
  fromId: string;
  fromName: string;
  text: string;
  /** URL ảnh (nếu là tin ảnh) — UI hiện thumbnail thay vì chữ. */
  imageUrl?: string;
  /** 'sending' | 'sent' | 'failed' cho tin gửi lạc quan; để trống với tin đến. */
  status?: 'sending' | 'sent' | 'failed';
}

/** Tóm tắt một hội thoại cho danh sách bên trái. */
export interface ThreadSummary {
  threadId: string;
  group: boolean;
  name: string;
  lastText: string;
  lastAt: number;
  /** Số tin chưa đọc (tin đến kể từ lần markRead gần nhất). */
  unread: number;
}

interface Thread {
  threadId: string;
  group: boolean;
  name: string;
  messages: StoredMessage[];
  lastAt: number;
  unread: number;
}

/** Trần tin mỗi hội thoại — đủ để cuộn lại một quãng, không phình vô hạn. */
const MAX_PER_THREAD = 400;
/** Cửa sổ khử trùng echo (ms): tin mình gửi lạc quan vs bản Zalo dội về. */
const ECHO_WINDOW_MS = 20_000;

const g = globalThis as typeof globalThis & { __zaloApiThreads?: Map<string, Map<string, Thread>> };
const byAccount: Map<string, Map<string, Thread>> = g.__zaloApiThreads ?? (g.__zaloApiThreads = new Map());

function accountThreads(accountKey: string): Map<string, Thread> {
  let m = byAccount.get(accountKey);
  if (!m) { m = new Map(); byAccount.set(accountKey, m); }
  return m;
}

function getThread(accountKey: string, threadId: string, group: boolean): Thread {
  const m = accountThreads(accountKey);
  let t = m.get(threadId);
  if (!t) {
    t = { threadId, group, name: threadId, messages: [], lastAt: 0, unread: 0 };
    m.set(threadId, t);
  }
  return t;
}

/** Ghi tin sau khi đã có id ổn định + đẩy cận trần. */
function push(t: Thread, msg: StoredMessage): void {
  t.messages.push(msg);
  if (t.messages.length > MAX_PER_THREAD) t.messages.splice(0, t.messages.length - MAX_PER_THREAD);
  if (msg.at > t.lastAt) t.lastAt = msg.at;
}

/** Băm ngắn ổn định cho id khi payload không có msgId. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * Ghi một tin NHẬN từ listener. Tự phân hội thoại theo threadId, cập nhật tên
 * (tin 1-1 của người khác mang tên người gửi), tăng chưa-đọc cho tin của người
 * khác, và KHỬ TRÙNG với tin mình vừa gửi lạc quan (Zalo dội tin của ta về).
 */
export function recordIncoming(accountKey: string, m: IncomingMessage): void {
  if (!m.threadId || m.threadId === '0' || !m.text) return;
  const t = getThread(accountKey, m.threadId, m.group);
  if (m.group) t.group = true;
  // Tên hiển thị: chỉ đặt theo tin 1-1 của NGƯỜI KHÁC (fromName là tên họ).
  if (!m.group && !m.isSelf && m.fromName) t.name = m.fromName;

  const id = m.msgId || `${m.at}-${hash(m.fromId + '|' + m.text)}`;

  // Đã có id này rồi → bỏ (Zalo có thể gửi trùng khi nối lại).
  if (t.messages.some((x) => x.id === id)) return;

  if (m.isSelf) {
    // Tin của CHÍNH mình dội về: nếu vừa ghi một tin gửi lạc quan cùng nội dung
    // trong cửa sổ ngắn thì gộp (chuyển 'sending'→'sent' + gắn id thật) thay vì
    // thêm bong bóng thứ hai.
    const pending = [...t.messages].reverse().find(
      (x) => x.self && x.text === m.text && (x.status === 'sending' || x.status === 'sent') && m.at - x.at < ECHO_WINDOW_MS,
    );
    if (pending) {
      pending.status = 'sent';
      if (m.msgId) pending.id = m.msgId;
      return;
    }
  }

  push(t, {
    id,
    at: m.at,
    self: m.isSelf,
    fromId: m.fromId,
    fromName: m.fromName,
    text: m.text,
    status: m.isSelf ? 'sent' : undefined,
  });
  if (!m.isSelf) t.unread += 1;
}

/**
 * Ghi một tin MÌNH GỬI ngay khi bấm gửi (lạc quan) để màn chat phản hồi tức thì.
 * Trả về id để UI cập nhật trạng thái sau khi route trả kết quả.
 */
export function recordOutgoing(
  accountKey: string,
  p: { threadId: string; group: boolean; text: string; at: number; status?: StoredMessage['status']; imageUrl?: string },
): string {
  const t = getThread(accountKey, p.threadId, p.group);
  if (p.group) t.group = true;
  const id = `out-${p.at}-${hash(p.text + '|' + (p.imageUrl ?? ''))}`;
  if (!t.messages.some((x) => x.id === id)) {
    push(t, { id, at: p.at, self: true, fromId: '', fromName: '', text: p.text, imageUrl: p.imageUrl, status: p.status ?? 'sending' });
  }
  return id;
}

/**
 * Chèn LỊCH SỬ CŨ (đã lấy từ API) vào ĐẦU luồng. Khử trùng theo id, rồi sắp lại
 * theo thời gian tăng để bong bóng đúng thứ tự. Không đụng unread (tin cũ coi
 * như đã đọc). Cập nhật lastAt nếu có tin mới hơn hiện tại.
 */
export function prependHistory(
  accountKey: string,
  threadId: string,
  group: boolean,
  msgs: Array<{ id: string; at: number; self: boolean; fromId: string; fromName: string; text: string; imageUrl?: string }>,
): void {
  const t = getThread(accountKey, threadId, group);
  if (group) t.group = true;
  const have = new Set(t.messages.map((x) => x.id));
  const add = msgs
    .filter((m) => m.id && !have.has(m.id))
    .map((m) => ({ id: m.id, at: m.at, self: m.self, fromId: m.fromId, fromName: m.fromName, text: m.text, imageUrl: m.imageUrl, status: m.self ? ('sent' as const) : undefined }));
  if (!add.length) return;
  t.messages = [...add, ...t.messages].sort((a, b) => a.at - b.at);
  if (t.messages.length > MAX_PER_THREAD) t.messages.splice(0, t.messages.length - MAX_PER_THREAD);
  const newest = t.messages[t.messages.length - 1];
  if (newest && newest.at > t.lastAt) t.lastAt = newest.at;
}

/** Đổi trạng thái một tin gửi (sau khi route trả ok/lỗi). */
export function setMessageStatus(accountKey: string, threadId: string, id: string, status: StoredMessage['status']): void {
  const t = accountThreads(accountKey).get(threadId);
  const msg = t?.messages.find((x) => x.id === id);
  if (msg) msg.status = status;
}

/** Danh sách hội thoại (mới nhất trước) cho cột trái. */
export function threadsFor(accountKey: string): ThreadSummary[] {
  const m = byAccount.get(accountKey);
  if (!m) return [];
  return [...m.values()]
    .map((t) => ({
      threadId: t.threadId,
      group: t.group,
      name: t.name,
      lastText: t.messages.length ? t.messages[t.messages.length - 1].text : '',
      lastAt: t.lastAt,
      unread: t.unread,
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

/** Tin của một hội thoại (cũ → mới) để dựng khung chat. */
export function messagesFor(accountKey: string, threadId: string): StoredMessage[] {
  const t = byAccount.get(accountKey)?.get(threadId);
  return t ? [...t.messages] : [];
}

/** Đánh dấu đã đọc một hội thoại (người dùng mở nó). */
export function markThreadRead(accountKey: string, threadId: string): void {
  const t = byAccount.get(accountKey)?.get(threadId);
  if (t) t.unread = 0;
}

/** Bổ sung tên hội thoại từ danh bạ (route gọi để làm đẹp danh sách). */
export function applyNames(accountKey: string, names: Record<string, string>): void {
  const m = byAccount.get(accountKey);
  if (!m) return;
  for (const [threadId, name] of Object.entries(names)) {
    const t = m.get(threadId);
    // Chỉ vá khi tên hiện đang là threadId trơ (chưa học được từ tin).
    if (t && name && t.name === t.threadId) t.name = name;
  }
}

/** Xoá toàn bộ tin của một tài khoản (đăng xuất). */
export function dropThreads(accountKey: string): void {
  byAccount.delete(accountKey);
}
