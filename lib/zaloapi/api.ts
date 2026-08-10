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

export function zaloApiSendMessage(params: {
  accountKey: string;
  threadId?: string;
  text: string;
  group?: boolean;
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
}

export interface ZaloListenerState {
  state: 'connecting' | 'open' | 'ready' | 'closed' | 'error' | 'off';
  detail: string;
  queued?: number;
}

/** Bật listener NHẬN tin server-side (cần đã login). Idempotent. */
export function zaloApiListen(accountKey: string): Promise<ZaloListenerState> {
  return call<ZaloListenerState>('listen', { accountKey });
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
