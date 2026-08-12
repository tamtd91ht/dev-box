// Zalo API (thử nghiệm) — helper gọi /api/zaloapi từ phía client.
//
// Một chỗ duy nhất biết hình dạng request/response của route, để UI
// (ZaloApiWorkspace) và automation (lib/automation/zaloApiSend.ts) không tự
// viết fetch mỗi nơi một kiểu rồi lệch nhau khi route đổi.
//
// Browser-safe: không import gì từ lib/zaloapi/server/* (chỗ đó cần Node).

/** Trạng thái một phiên server-side. Không bao giờ chứa cookie/secretKey. */
export interface ZaloSessionInfo {
  accountKey: string;
  uid: string;
  /** Đã có host chat để gửi được chưa. */
  ready: boolean;
  createdAt: number;
  touchedAt: number;
  expiresAt: number;
}

export interface ZaloSendResult {
  ok: boolean;
  msgId?: string;
  detail: string;
  raw?: unknown;
  /** threadId đích thực tế đã gửi (dùng để refresh đúng hội thoại sau khi gửi). */
  threadId?: string;
}

/** Tóm tắt một hội thoại cho cột trái màn chat. */
export interface ZaloThreadSummary {
  threadId: string;
  group: boolean;
  name: string;
  lastText: string;
  lastAt: number;
  unread: number;
  /** Nhãn phân loại người dùng gán (để lọc/tìm). */
  tags?: string[];
}

/** Một tin đã lưu để dựng bong bóng chat. */
export interface ZaloStoredMessage {
  id: string;
  at: number;
  self: boolean;
  fromId: string;
  fromName: string;
  text: string;
  /** URL ảnh nếu là tin ảnh — UI hiện thumbnail. */
  imageUrl?: string;
  status?: 'sending' | 'sent' | 'failed';
  /** Cảm xúc đã thả lên tin: uid người thả → mặt. '(self)' là chính ta. */
  reactions?: Record<string, { icon: string; rType: number }>;
  /**
   * id THẬT của Zalo. CHỈ tin có id này (dạng số) mới thả được cảm xúc — tin vừa
   * gửi chưa được Zalo dội về thì chưa có, nên UI ẩn nút thả để không mời người
   * dùng bấm vào chỗ chắc chắn thất bại.
   */
  zMsgId?: string;
}

export interface ZaloApiFlags {
  enabled: boolean;
  allowSend: boolean;
}

async function call<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/zaloapi', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: T };
  if (!r.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    (err as Error & { status?: number }).status = r.status;
    throw err;
  }
  return data.result as T;
}

export function fetchZaloApiFlags(): Promise<ZaloApiFlags> {
  return call<ZaloApiFlags>('flags');
}

/** Dựng phiên server-side từ credential vừa trích khỏi guest. */
export function zaloApiLogin(params: {
  accountKey: string;
  cookie: string;
  imei: string;
  userAgent: string;
  language?: string;
}): Promise<ZaloSessionInfo> {
  return call<ZaloSessionInfo>('login', params);
}

export function zaloApiStatus(accountKey: string): Promise<ZaloSessionInfo | null> {
  return call<ZaloSessionInfo | null>('status', { accountKey });
}

/** Một khoảng định dạng chữ (in đậm/nghiêng/màu…). */
export interface ZaloTextStyle {
  start: number;
  len: number;
  /** 'b'|'i'|'u'|'s' | 'c_<hex6>' | 'f_<size>'. */
  st: string;
}

export function zaloApiSendMessage(params: {
  accountKey: string;
  threadId?: string;
  text: string;
  group?: boolean;
  styles?: ZaloTextStyle[];
}): Promise<ZaloSendResult> {
  return call<ZaloSendResult>('send', params);
}

export function zaloApiLogout(accountKey: string): Promise<{ dropped: boolean }> {
  return call<{ dropped: boolean }>('logout', { accountKey });
}

/** Một tin listener nhận được — khớp IncomingMessage của server (đã bỏ raw). */
export interface ZaloIncoming {
  at: number;
  group: boolean;
  /** threadId thật — điểm khác biệt so với nguồn DOM (không có id). */
  threadId: string;
  fromId: string;
  fromName: string;
  text: string;
  /**
   * Có giá trị nghĩa là sự kiện CẢM XÚC, không phải tin nhắn: ai đó thả/bỏ mặt
   * trên tin `targetMsgId`. `text` khi đó chỉ là mô tả ngắn để ghi log.
   */
  reaction?: {
    targetMsgId: string;
    /** rIcon Zalo trả về; rỗng = BỎ cảm xúc. */
    icon: string;
    rType: number;
    isSelf: boolean;
  };
}

export interface ZaloListenerState {
  state: 'connecting' | 'open' | 'ready' | 'closed' | 'error' | 'off';
  detail: string;
  queued?: number;
}

/** Một hội thoại trong danh bạ đích (id thật + tên + nhóm). */
export interface ZaloContact {
  accountKey: string;
  threadId: string;
  name: string;
  group: boolean;
  lastSeen: number;
  manual?: boolean;
}

/** Danh bạ đích của một tài khoản (tự học từ tin đến + thêm tay). */
export function zaloApiContacts(accountKey: string): Promise<ZaloContact[]> {
  return call<ZaloContact[]>('contacts', { accountKey });
}

/** Thêm/sửa một contact thủ công. Trả danh bạ mới của tài khoản. */
export function zaloApiContactAdd(p: {
  accountKey: string;
  threadId: string;
  name?: string;
  group?: boolean;
}): Promise<ZaloContact[]> {
  return call<ZaloContact[]>('contactAdd', p);
}

/** Xoá một contact. Trả danh bạ mới của tài khoản. */
export function zaloApiContactRemove(accountKey: string, threadId: string): Promise<ZaloContact[]> {
  return call<ZaloContact[]>('contactRemove', { accountKey, threadId });
}

/** Bật listener NHẬN tin server-side (cần đã login). Idempotent. */
export function zaloApiListen(accountKey: string): Promise<ZaloListenerState> {
  return call<ZaloListenerState>('listen', { accountKey });
}

/** Danh sách hội thoại (mới nhất trước) cho cột trái màn chat. */
export function zaloApiThreads(accountKey: string): Promise<ZaloThreadSummary[]> {
  return call<ZaloThreadSummary[]>('threads', { accountKey });
}

/** Quét nhóm + khách từ tài khoản Zalo về danh bạ. Trả danh sách hội thoại mới. */
export function zaloApiScan(accountKey: string): Promise<{
  threads: ZaloThreadSummary[];
  groups: number;
  friends: number;
  note: string;
}> {
  return call<{ threads: ZaloThreadSummary[]; groups: number; friends: number; note: string }>('scan', { accountKey });
}

/** Lịch sử tin của một hội thoại (cũ → mới). Gọi cũng đánh dấu đã đọc. */
export function zaloApiHistory(accountKey: string, threadId: string): Promise<ZaloStoredMessage[]> {
  return call<ZaloStoredMessage[]>('history', { accountKey, threadId });
}

/**
 * THẢ cảm xúc lên một tin (`key` từ lib/zaloapi/reactions), hoặc BỎ cảm xúc mình
 * đã thả (`remove: true`). Trả về danh sách tin đã cập nhật để UI vẽ lại ngay.
 */
export function zaloApiReact(
  accountKey: string,
  p: { threadId: string; msgId: string; group: boolean; key?: string; remove?: boolean },
): Promise<{ ok: boolean; detail: string; messages: ZaloStoredMessage[] }> {
  return call<{ ok: boolean; detail: string; messages: ZaloStoredMessage[] }>('react', { accountKey, ...p });
}

/** Đánh dấu đã đọc một hội thoại. */
export function zaloApiMarkRead(accountKey: string, threadId: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>('markRead', { accountKey, threadId });
}

/** Gán/đổi tag cho một hội thoại (để lọc/tìm). */
export function zaloApiSetTags(p: {
  accountKey: string;
  threadId: string;
  tags: string[];
  name?: string;
  group?: boolean;
}): Promise<{ ok: boolean; tags: string[] }> {
  return call<{ ok: boolean; tags: string[] }>('setTags', p);
}

/** Gửi ẢNH: bytes đã mã hoá base64 (không kèm tiền tố data:). */
export function zaloApiSendImage(params: {
  accountKey: string;
  threadId?: string;
  group?: boolean;
  dataBase64: string;
  fileName?: string;
  caption?: string;
}): Promise<ZaloSendResult> {
  return call<ZaloSendResult>('sendImage', params);
}

/** Kéo lịch sử cũ (chỉ nhóm có API). Trả lại toàn bộ tin của hội thoại sau khi chèn. */
export function zaloApiLoadOlder(
  accountKey: string,
  threadId: string,
  group: boolean,
): Promise<{ supported: boolean; messages: ZaloStoredMessage[] }> {
  return call<{ supported: boolean; messages: ZaloStoredMessage[] }>('loadOlder', { accountKey, threadId, group });
}

/** Đếm chẩn đoán của listener — để trả lời "vì sao không có tin". */
export interface ZaloListenerStats {
  frames: number;
  msgFrames: number;
  decoded: number;
  extracted: number;
  decodeErr: number;
  hasCipher: boolean;
}

/** Hút tin listener đã nhận + trạng thái kết nối + đếm chẩn đoán. Gọi theo nhịp poll. */
export function zaloApiPoll(
  accountKey: string,
): Promise<ZaloListenerState & { messages: ZaloIncoming[]; stats?: ZaloListenerStats }> {
  return call<ZaloListenerState & { messages: ZaloIncoming[]; stats?: ZaloListenerStats }>('poll', { accountKey });
}
