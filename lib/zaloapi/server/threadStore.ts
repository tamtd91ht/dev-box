// Zalo API (thử nghiệm) — kho tin theo HỘI THOẠI, server-side, CHỈ TRONG RAM.
//
// Vì sao có kho này: listener cũ chỉ có một hàng đợi "drain-rồi-xoá" để nuôi
// automation — hút xong là mất, không giữ lịch sử. Màn chat cần thấy lại các tin
// trước đó của từng hội thoại và gom cả hai chiều (mình gửi + người gửi) vào
// đúng một luồng. Kho này giữ tin theo threadId để dựng màn chat như app thường.
//
// Kho này vẫn là NGUỒN ĐỌC DUY NHẤT của màn chat và vẫn chỉ ở RAM (sống qua
// hot-reload bằng globalThis, tự giới hạn để không phình RAM). Nhưng RAM mất
// theo tiến trình, mà Zalo không cho lấy lại lịch sử 1-1 — nên mỗi tin ghi vào
// đây cũng được ĐẨY SANG kho lưu trữ tuỳ chọn (messageArchive: off/local/mongo)
// để lần render sau dựng lại được. Kho lưu trữ KHÔNG BAO GIỜ chặn luồng tin:
// mọi lời gọi là fire-and-forget và tự nuốt lỗi bên trong.

import type { IncomingMessage } from './listener';
import { archiveMessage, archiveMessages, archiveReaction, archiveReplaceId, archiveStatus, archiveThreadMeta, loadAccountThreads } from './messageArchive';

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
  /**
   * ID THẬT của Zalo, giữ RIÊNG khỏi `id`.
   *
   * `id` là khoá nội bộ để React key + khử trùng, và nó CÓ THỂ do ta tự sinh
   * ('out-<at>-<hash>' cho tin gửi lạc quan, '<at>-<hash>' cho tin đến thiếu
   * msgId). Những id đó Zalo không tra được. Thả cảm xúc lại BẮT BUỘC id thật
   * dạng SỐ (gMsgID/cMsgID), nên phải cất riêng — trước đây dùng `id` làm msgId
   * khiến Zalo nhận request rồi im lặng bỏ qua: bấm được mà bên nhận không thấy.
   */
  zMsgId?: string;
  /** cliMsgId của Zalo (cMsgID khi thả cảm xúc). */
  zCliMsgId?: string;
  /**
   * Tin GỐC mà tin này trả lời — để màn chat vẽ khối trích dẫn phía trên.
   *
   * Lưu bản SAO nội dung chứ không chỉ id: tin gốc có thể chưa từng qua phiên
   * này (trả lời một tin cũ hơn cửa sổ đang giữ), hoặc đã bị thu hồi. Trỏ id
   * rồi tra ngược thì đúng những ca đó lại hiện khối trích dẫn trống.
   */
  quote?: { msgId: string; fromName: string; text: string };
  /** 'sending' | 'sent' | 'failed' cho tin gửi lạc quan; để trống với tin đến. */
  status?: 'sending' | 'sent' | 'failed';
  /**
   * CẢM XÚC đã thả lên tin này, gom theo người thả: uid → { icon, rType }.
   * Gom theo uid (không phải mảng) vì Zalo cho MỘT người đúng MỘT mặt trên một
   * tin — thả mặt mới là thay mặt cũ, và bỏ thả thì xoá hẳn khoá đó. Nhờ vậy
   * không cần khử trùng khi cùng một người đổi ý nhiều lần.
   */
  reactions?: Record<string, { icon: string; rType: number }>;
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

/**
 * Đẩy một tin sang kho lưu trữ + cập nhật metadata hội thoại. Fire-and-forget:
 * KHÔNG await (luồng listener phải trả về ngay) và lỗi đã được nuốt bên trong
 * messageArchive, nên chỉ cần chặn unhandled rejection.
 */
function persist(accountKey: string, t: Thread, msg: StoredMessage): void {
  void archiveMessage(accountKey, t.threadId, t.group, msg).catch(() => {});
  void archiveThreadMeta(accountKey, t.threadId, { name: t.name, group: t.group, lastAt: t.lastAt }).catch(() => {});
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
  // CẢM XÚC đi nhánh riêng: nó SỬA một tin đã có, không tạo bong bóng mới.
  if (m.reaction) {
    recordReaction(accountKey, m);
    return;
  }
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
      const staleId = pending.id;
      pending.status = 'sent';
      if (m.msgId) pending.id = m.msgId;
      // Đây là lần DUY NHẤT ta biết id thật của tin MÌNH gửi (lúc bấm gửi chỉ
      // có id tự sinh). Không cất lại thì tin của mình mãi không thả được cảm xúc.
      if (m.zMsgId) pending.zMsgId = m.zMsgId;
      if (m.zCliMsgId) pending.zCliMsgId = m.zCliMsgId;
      // Bản Zalo dội về mới là bản có id THẬT. Trong RAM ta vừa SỬA id của đúng
      // một object, nhưng kho lưu trữ khoá theo id nên phải bảo nó XOÁ bản
      // 'out-…' cũ, không thì nạp lại sẽ thấy một tin thành hai.
      void archiveReplaceId(accountKey, t.threadId, staleId, pending, t.group).catch(() => {});
      void archiveThreadMeta(accountKey, t.threadId, { name: t.name, group: t.group, lastAt: t.lastAt }).catch(() => {});
      return;
    }
  }

  const msg: StoredMessage = {
    id,
    at: m.at,
    self: m.isSelf,
    fromId: m.fromId,
    fromName: m.fromName,
    text: m.text,
    ...(m.quote ? { quote: m.quote } : {}),
    status: m.isSelf ? 'sent' : undefined,
    // Cất id THẬT để thả cảm xúc được (xem zMsgId trong StoredMessage).
    ...(m.zMsgId ? { zMsgId: m.zMsgId } : {}),
    ...(m.zCliMsgId ? { zCliMsgId: m.zCliMsgId } : {}),
  };
  push(t, msg);
  if (!m.isSelf) t.unread += 1;
  persist(accountKey, t, msg);
}

/**
 * Ghi một CẢM XÚC nhận từ listener lên tin đích.
 *
 * Không tìm thấy tin đích thì BỎ QUA (không tạo bong bóng giả): tin đó có thể đã
 * bị đẩy khỏi trần MAX_PER_THREAD, hoặc thuộc quãng lịch sử ta chưa kéo về. Thà
 * mất một biểu tượng còn hơn dựng ra một tin không tồn tại.
 */
function recordReaction(accountKey: string, m: IncomingMessage): void {
  const r = m.reaction;
  if (!r) return;
  const t = accountThreads(accountKey).get(m.threadId);
  const target = t?.messages.find((x) => x.id === r.targetMsgId);
  if (!t || !target) return;
  // Khoá người thả. Cảm xúc của CHÍNH TA luôn dùng khoá cố định '(self)' — Zalo
  // gửi uidFrom '0' cho tin của mình đồng bộ từ thiết bị khác, nên nếu lấy
  // nguyên uidFrom thì mặt ta thả ở máy này ('(self)', ghi lạc quan) và mặt dội
  // về từ Zalo ('0') thành HAI khoá khác nhau → hiện đôi.
  const who = r.isSelf ? '(self)' : (m.fromId || '?');
  applyReaction(target, who, r.icon, r.rType);
  void archiveReaction(accountKey, t.threadId, target.id, target.reactions ?? {}).catch(() => {});
}

/**
 * Gắn/bỏ một cảm xúc lên một tin (dùng chung cho tin đến và lượt ta tự thả).
 * rType -1 hoặc icon rỗng = BỎ.
 */
function applyReaction(target: StoredMessage, who: string, icon: string, rType: number): void {
  const map = target.reactions ? { ...target.reactions } : {};
  if (rType === -1 || !icon) delete map[who];
  else map[who] = { icon, rType };
  target.reactions = Object.keys(map).length ? map : undefined;
}

/**
 * Tra ID THẬT của Zalo cho một bong bóng (theo id nội bộ).
 *
 * Cần vì UI chỉ biết `id` nội bộ, mà id đó có thể do ta tự sinh
 * ('out-<at>-<hash>' / '<at>-<hash>') — gửi nó lên Zalo thì Zalo tra không ra và
 * BỎ QUA IM LẶNG (không báo lỗi). Rơi về chính `id` khi tin không có id thật:
 * lúc đó sendReaction sẽ chặn lại và báo rõ, thay vì gửi đi rồi mất hút.
 */
export function realMsgIds(accountKey: string, threadId: string, id: string): { zMsgId: string; zCliMsgId?: string } {
  const msg = accountThreads(accountKey).get(threadId)?.messages.find((x) => x.id === id);
  // Rơi về chính `id` khi thiếu zMsgId — và đây KHÔNG phải nước cuối vô vọng:
  // recordIncoming đặt `id = m.msgId` khi Zalo có gửi msgId, mà msgId của Zalo là
  // chuỗi SỐ. Nên với tin đến bình thường (kể cả tin đã lưu từ trước khi có field
  // zMsgId — vd 51 tin khôi phục từ kho), `id` chính là id thật cần dùng.
  // Chỉ id ta TỰ SINH ('out-…' / '<at>-<hash>') mới không phải số, và sendReaction
  // chặn đúng mấy ca đó.
  const fallback = /^\d+$/.test(id) ? id : '';
  return { zMsgId: msg?.zMsgId || fallback || id, zCliMsgId: msg?.zCliMsgId };
}

/**
 * Ta vừa thả cảm xúc (lạc quan, gọi trước khi Zalo xác nhận) — hiện ngay lên
 * màn chat.
 *
 * Trả về mặt TRƯỚC ĐÓ của chính ta trên tin này (null nếu chưa thả gì), để
 * người gọi HOÀN NGUYÊN chính xác khi Zalo từ chối. Không trả cái này thì rollback
 * phải đoán, và đoán sai sẽ để lại một mặt giả trên màn chat.
 * `undefined` = không tìm thấy tin đích (không có gì để hoàn nguyên).
 */
export function recordOwnReaction(
  accountKey: string,
  threadId: string,
  msgId: string,
  icon: string,
  rType: number,
): { icon: string; rType: number } | null | undefined {
  const t = accountThreads(accountKey).get(threadId);
  const target = t?.messages.find((x) => x.id === msgId);
  if (!t || !target) return undefined;
  const prev = target.reactions?.['(self)'] ?? null;
  applyReaction(target, '(self)', icon, rType);
  void archiveReaction(accountKey, threadId, msgId, target.reactions ?? {}).catch(() => {});
  return prev;
}

/**
 * Ghi một tin MÌNH GỬI ngay khi bấm gửi (lạc quan) để màn chat phản hồi tức thì.
 * Trả về id để UI cập nhật trạng thái sau khi route trả kết quả.
 */
export function recordOutgoing(
  accountKey: string,
  p: {
    threadId: string; group: boolean; text: string; at: number;
    status?: StoredMessage['status']; imageUrl?: string;
    quote?: StoredMessage['quote'];
  },
): string {
  const t = getThread(accountKey, p.threadId, p.group);
  if (p.group) t.group = true;
  const id = `out-${p.at}-${hash(p.text + '|' + (p.imageUrl ?? ''))}`;
  if (!t.messages.some((x) => x.id === id)) {
    const msg: StoredMessage = {
      id, at: p.at, self: true, fromId: '', fromName: '', text: p.text,
      imageUrl: p.imageUrl, status: p.status ?? 'sending',
      ...(p.quote ? { quote: p.quote } : {}),
    };
    push(t, msg);
    // Ghi luôn cả tin đang 'sending': nếu app tắt giữa lúc gửi, tin vẫn còn dấu
    // vết. archiveMessage bỏ trạng thái tạm, setMessageStatus vá lại sau.
    persist(accountKey, t, msg);
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
  msgs: Array<{ id: string; at: number; self: boolean; fromId: string; fromName: string; text: string; imageUrl?: string; zMsgId?: string; zCliMsgId?: string }>,
): void {
  const t = getThread(accountKey, threadId, group);
  if (group) t.group = true;
  const have = new Set(t.messages.map((x) => x.id));
  const add = msgs
    .filter((m) => m.id && !have.has(m.id))
    .map((m) => ({
      id: m.id, at: m.at, self: m.self, fromId: m.fromId, fromName: m.fromName, text: m.text,
      imageUrl: m.imageUrl, status: m.self ? ('sent' as const) : undefined,
      // Giữ id thật để tin lịch sử cũng thả được cảm xúc.
      ...(m.zMsgId ? { zMsgId: m.zMsgId } : {}),
      ...(m.zCliMsgId ? { zCliMsgId: m.zCliMsgId } : {}),
    }));
  if (!add.length) return;
  t.messages = [...add, ...t.messages].sort((a, b) => a.at - b.at);
  if (t.messages.length > MAX_PER_THREAD) t.messages.splice(0, t.messages.length - MAX_PER_THREAD);
  const newest = t.messages[t.messages.length - 1];
  if (newest && newest.at > t.lastAt) t.lastAt = newest.at;
  // Lịch sử vừa kéo về đáng giữ nhất: đây là nguồn DUY NHẤT lấy lại được tin cũ
  // (chỉ nhóm có API), nên ghi cả lô sang kho.
  void archiveMessages(accountKey, threadId, t.group, add).catch(() => {});
  void archiveThreadMeta(accountKey, threadId, { name: t.name, group: t.group, lastAt: t.lastAt }).catch(() => {});
}

/**
 * Đổi trạng thái một tin gửi (sau khi route trả ok/lỗi).
 *
 * `id` là id LÚC GỬI ('out-…'). Nếu Zalo đã dội tin về trước khi route kịp gọi
 * hàm này, recordIncoming đã đổi id của bong bóng đó sang msgId thật — nên tìm
 * theo id cũ sẽ không thấy gì, và kho phải được vá theo id HIỆN TẠI, không phải
 * id đã chết (vá id đã chết là tạo ra một dòng rác không ai đọc).
 */
export function setMessageStatus(accountKey: string, threadId: string, id: string, status: StoredMessage['status']): void {
  const t = accountThreads(accountKey).get(threadId);
  let msg = t?.messages.find((x) => x.id === id);
  if (msg) {
    msg.status = status;
  } else if (t && id.startsWith('out-')) {
    // Đã bị gộp: lấy lại bằng dấu vết còn nằm trong chính id ('out-<at>-<hash>').
    const at = Number(id.split('-')[1]);
    if (Number.isFinite(at)) {
      msg = [...t.messages].reverse().find((x) => x.self && Math.abs(x.at - at) < ECHO_WINDOW_MS);
      if (msg && msg.status === 'sending') msg.status = status;
    }
  }
  void archiveStatus(accountKey, threadId, msg?.id ?? id, status).catch(() => {});
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

/**
 * Xoá toàn bộ tin của một tài khoản KHỎI RAM (đăng xuất).
 *
 * KHÔNG đụng tới kho lưu trữ: đăng xuất rồi đăng nhập lại là chuyện thường
 * (cookie bị Zalo xoay), mất sạch lịch sử mỗi lần như vậy thì kho lưu trữ vô
 * nghĩa. Muốn xoá hẳn thì dùng nút dọn kho trong cấu hình (purgeArchive).
 */
export function dropThreads(accountKey: string): void {
  byAccount.delete(accountKey);
}

/**
 * KHÔI PHỤC hội thoại từ kho lưu trữ vào RAM — gọi sau khi đăng nhập/kết nối để
 * màn chat có ngay lịch sử của các phiên trước (RAM vừa trống trơn).
 *
 * Tin trong RAM (nếu có) THẮNG tin trong kho ở cùng id: RAM là bản mới hơn, có
 * thể đang mang trạng thái 'sending' của lượt gửi vừa rồi. Không đụng `unread`
 * — tin cũ khôi phục lại coi như đã đọc.
 *
 * Chế độ 'off' → kho trả rỗng, hàm này thành no-op. Lỗi kho được nuốt: không
 * đọc lại được lịch sử thì vẫn phải đăng nhập được.
 */
export async function hydrateFromArchive(accountKey: string): Promise<{ threads: number; messages: number }> {
  let threads = 0;
  let messages = 0;
  try {
    const stored = await loadAccountThreads(accountKey);
    for (const s of stored) {
      if (!s.threadId || s.threadId === '0') continue;
      const t = getThread(accountKey, s.threadId, s.group);
      if (s.group) t.group = true;
      if (s.name && t.name === t.threadId) t.name = s.name;
      const have = new Set(t.messages.map((x) => x.id));
      // Khử trùng HAI TẦNG. Tầng 1 theo id. Tầng 2 theo (tự gửi, nội dung, mốc
      // thời gian gần nhau) — cần vì kho có thể còn cặp 'out-…' + msgId của cùng
      // một tin, do bản trước bản vá archiveReplaceId để lại. Không có tầng 2
      // thì những tin gửi trước lúc vá vẫn hiện đôi mãi.
      // Tin TỰ GỬI đã nhận vào lượt này — để so cặp trùng trong CÙNG lô kho.
      const keptSelf: StoredMessage[] = [];
      const add = s.messages.filter((m) => {
        if (have.has(m.id)) return false;
        if (!m.self) return true;
        // Tin cùng nội dung ĐÃ CÓ trong RAM → bỏ hẳn (RAM là bản mới hơn).
        if (t.messages.some((x) => x.self && x.text === m.text && Math.abs(x.at - m.at) < ECHO_WINDOW_MS)) return false;
        // Cặp 'out-…' + msgId của CÙNG một tin lệch nhau vài trăm ms. So bằng
        // KHOẢNG CÁCH thời gian, KHÔNG băm theo giây: hai mốc cách nhau 350ms
        // vẫn có thể rơi vào hai giây khác nhau (vd .800 và 1.150) nên cách băm
        // để lọt cặp trùng tuỳ theo tin rơi vào đâu trong giây — lỗi chập chờn
        // đúng nghĩa, chạy lại là khác kết quả.
        if (keptSelf.some((x) => x.text === m.text && Math.abs(x.at - m.at) < ECHO_WINDOW_MS)) return false;
        keptSelf.push(m);
        return true;
      });
      if (!add.length) continue;
      t.messages = [...add, ...t.messages].sort((a, b) => a.at - b.at);
      if (t.messages.length > MAX_PER_THREAD) t.messages.splice(0, t.messages.length - MAX_PER_THREAD);
      const newest = t.messages[t.messages.length - 1];
      if (newest && newest.at > t.lastAt) t.lastAt = newest.at;
      threads += 1;
      messages += add.length;
    }
  } catch { /* kho không với tới được → chạy tiếp với RAM trống */ }
  return { threads, messages };
}
