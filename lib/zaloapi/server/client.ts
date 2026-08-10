// Zalo API (thử nghiệm) — client server-side, port thu gọn từ zca-js.
//
// Chạy trên Node của DevBox (trong Next API route), KHÔNG dùng webview. Nhận
// credential đã trích xuất từ guest (cookie + imei + userAgent), gọi login để
// lấy secretKey + zpwServiceMap, rồi gửi tin qua API thật.
//
// Port có chủ đích là THU GỌN: chỉ login + sendMessage (+ chỗ nối listener).
// Giữ đúng cách zca-js dựng tham số/ký/mã hoá — sai là Zalo từ chối.
//
// ⚠ imei PHẢI là imei guest đã sinh (xem lib/zaloapi/server/crypto note +
// memory). KHÔNG generateZaloUUID lại: phần UUID ngẫu nhiên sẽ khác, cookie gắn
// với imei gốc bị từ chối.

import { encodeAES, decodeAES, decodeRespAES, getSignKey, ParamsEncryptor } from './crypto';
import { trace } from './trace';

/** Hằng số API — port từ ctx mặc định của zca-js. Đổi khi Zalo nâng version. */
export const API_TYPE = 30;
export const API_VERSION = 671;
const LOGIN_URL = 'https://wpa.chat.zalo.me/api/login/getLoginInfo';
const SERVERINFO_URL = 'https://wpa.chat.zalo.me/api/login/getServerInfo';

export interface ZaloCreds {
  /** Chuỗi cookie đầy đủ (đã ghép name=value; …) từ phiên guest. */
  cookie: string;
  /** imei guest đã sinh — KHÔNG tái tạo. */
  imei: string;
  userAgent: string;
  language?: string;
}

export interface ZaloContext extends ZaloCreds {
  language: string;
  secretKey: string;
  uid: string;
  /** Map dịch vụ → danh sách host, từ zpw_service_map_v3 của response login. */
  serviceMap: Record<string, string[]>;
  /** URL WebSocket nhận tin, từ zpw_ws của response login. Rỗng nếu không có. */
  wsUrls: string[];
  /** Nhịp ping (ms) lấy từ getServerInfo settings; 0 = chưa lấy được. */
  pingIntervalMs: number;
}

/** makeURL của zca-js: thêm zpw_ver + zpw_type nếu chưa có. */
function makeURL(base: string, params: Record<string, string | number>, apiVersion = true): string {
  const url = new URL(base);
  for (const k of Object.keys(params)) url.searchParams.append(k, String(params[k]));
  if (apiVersion) {
    if (!url.searchParams.has('zpw_ver')) url.searchParams.set('zpw_ver', String(API_VERSION));
    if (!url.searchParams.has('zpw_type')) url.searchParams.set('zpw_type', String(API_TYPE));
  }
  return url.toString();
}

/** Header chung cho mọi request — cookie + UA + Origin đúng như trình duyệt. */
function headers(ctx: ZaloCreds): Record<string, string> {
  return {
    'User-Agent': ctx.userAgent,
    Cookie: ctx.cookie,
    Origin: 'https://chat.zalo.me',
    Referer: 'https://chat.zalo.me/',
    Accept: 'application/json, text/plain, */*',
  };
}

/** Trần thời gian một request — Zalo treo thì cả rule automation treo theo. */
const REQ_TIMEOUT_MS = 20_000;

/** Hình dạng response chung của Zalo: data đã mã hoá + mã lỗi. */
interface ZaloEnvelope {
  data?: string;
  error_code?: number;
  error_message?: string;
}

/**
 * fetch + timeout + đọc JSON AN TOÀN.
 *
 * Vì sao không dùng thẳng `res.json()`: khi cookie hết hạn hoặc bị chặn, Zalo
 * trả HTML (trang đăng nhập) hoặc chuỗi rỗng — `.json()` khi đó ném lỗi cú pháp
 * khó hiểu, che mất nguyên nhân thật. Đọc text trước rồi parse có bắt lỗi thì
 * báo được đúng "Zalo trả về không phải JSON" kèm đoạn đầu để chẩn đoán.
 */
async function fetchZalo(url: string, init: RequestInit, what: string): Promise<ZaloEnvelope> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new Error(`${what}: quá ${REQ_TIMEOUT_MS / 1000}s không phản hồi`);
    throw new Error(`${what}: không gọi được (${err.message})`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!text.trim()) {
    throw new Error(`${what}: Zalo trả về rỗng (HTTP ${res.status}) — cookie có thể đã hết hạn`);
  }
  try {
    return JSON.parse(text) as ZaloEnvelope;
  } catch {
    const head = text.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(
      `${what}: Zalo trả về không phải JSON (HTTP ${res.status}) — thường là cookie hết hạn `
      + `hoặc bị chặn. Đoạn đầu: ${head}`,
    );
  }
}

/**
 * getEncryptParam — port từ zca-js. Dựng data login, mã hoá bằng ParamsEncryptor
 * (chưa có secretKey ở bước này), tính signkey. Trả params để đính vào URL +
 * `enk` (encryptKey) để giải mã response.
 */
function getEncryptParam(ctx: ZaloCreds, type: string) {
  const firstLaunchTime = Date.now();
  const data: Record<string, unknown> = {
    computer_name: 'Web',
    imei: ctx.imei,
    language: ctx.language ?? 'vi',
    ts: Date.now(),
  };

  const encryptor = new ParamsEncryptor({ type: API_TYPE, imei: ctx.imei, firstLaunchTime });
  const stddata = JSON.stringify(data);
  // PHẢI mã hoá bằng encryptKey (khoá UTF-8) ra BASE64 — port đúng
  // ParamsEncryptor.encodeAES của zca-js. Trước đây lỡ dùng encodeAES (parse
  // khoá base64) nên payload rác → Zalo trả 18060 "Invalid encryption protocol".
  const encryptedData = ParamsEncryptor.encodeAES(encryptor.getEncryptKey(), stddata, 'base64', false);
  const encParams = encryptor.getParams(); // {zcid, zcid_ext, enc_ver}

  // Top-level params: CHỈ encrypted_params (spread) + params + type +
  // client_version + signkey. KHÔNG thêm computer_name/imei ở top-level — chúng
  // nằm trong encrypted_data rồi; thêm dư làm signkey tính sai object → 18060.
  const params: Record<string, unknown> = {};
  if (encryptedData && encParams) {
    params.zcid = encParams.zcid;
    params.zcid_ext = encParams.zcid_ext;
    params.enc_ver = encParams.enc_ver;
    params.params = encryptedData;
  }
  params.type = API_TYPE;
  params.client_version = API_VERSION;

  params.signkey =
    type === 'getserverinfo'
      ? getSignKey(type, {
          imei: ctx.imei,
          type: API_TYPE,
          client_version: API_VERSION,
          computer_name: 'Web',
        })
      : getSignKey(type, params as Record<string, unknown>);

  return { params, enk: encryptor.getEncryptKey() };
}

/**
 * decryptResp — giải mã data.data của response LOGIN bằng encryptKey (UTF-8).
 * PHẢI dùng decodeRespAES (khoá UTF-8), KHÔNG phải decodeAES (khoá base64) —
 * dùng nhầm là "giải mã response thất bại" dù request đã đúng.
 */
function decryptResp(enk: string, data: string): unknown {
  const dec = decodeRespAES(enk, data);
  if (!dec) return null;
  try {
    return JSON.parse(dec);
  } catch {
    return dec;
  }
}

/**
 * Giải mã response SAU-LOGIN (message send/receive) bằng secretKey (base64) —
 * KHÁC decryptResp (login, khoá UTF-8). Hai response mã hoá bằng hai khoá khác
 * kiểu, dùng nhầm là ra rỗng.
 */
function decryptRespSecret(secretKey: string, data: string): unknown {
  const dec = decodeAES(secretKey, data);
  if (!dec) return null;
  try {
    return JSON.parse(dec);
  } catch {
    return dec;
  }
}

/**
 * Đăng nhập: cookie + imei + UA → secretKey + uid + serviceMap.
 *
 * Đây là bước biến "credential trích xuất" thành "context gọi API được". Nếu
 * fail thường vì: imei lệch (không phải imei gốc), UA lệch, hoặc cookie hết hạn.
 */
export async function login(creds: ZaloCreds): Promise<ZaloContext> {
  // Kiểu có language BẮT BUỘC ngay từ đây → phía dưới khỏi ?? 'vi' lặp lại.
  const ctx: ZaloCreds & { language: string } = { ...creds, language: creds.language ?? 'vi' };

  // CHẨN ĐOÁN credential (đã che) TRƯỚC khi gửi — 102 thường do imei không khớp
  // cookie. Đọc trace là biết imei có rỗng/lệch không mà không cần gửi thêm lần
  // nào. Cookie hết hạn cũng ra 102 → nhìn cookie có zpsid/zpw_sek không.
  const cookieNames = ctx.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
  const mask = (v: string) => (!v ? '(RỖNG)' : v.length <= 8 ? v[0] + '…' : v.slice(0, 6) + '…' + v.slice(-3));
  trace('login', 'gửi credential', {
    imei: mask(ctx.imei),
    imeiLen: ctx.imei.length,
    ua: ctx.userAgent.slice(0, 40),
    cookieNames,
    hasZpsid: cookieNames.includes('zpsid'),
    hasZpwSek: cookieNames.includes('zpw_sek'),
  });

  const ep = getEncryptParam(ctx, 'getlogininfo');
  const url = makeURL(LOGIN_URL, { ...(ep.params as Record<string, string | number>), nretry: 0 });

  const raw = await fetchZalo(url, { method: 'GET', headers: headers(ctx) }, 'login');
  if (raw.error_code && raw.error_code !== 0) {
    throw new Error(`login lỗi ${raw.error_code}: ${raw.error_message ?? ''}`);
  }
  if (!raw.data) throw new Error('login: response không có data (cookie/imei/UA có thể sai)');

  const decoded = decryptResp(ep.enk, raw.data) as Record<string, unknown> | null;
  if (!decoded || typeof decoded === 'string') throw new Error('login: giải mã response thất bại');

  // Response login hay bọc một lớp: { error_code, data: { zpw_enk, ... } }. Bóc
  // lớp `data` nếu có; nếu không thì dùng thẳng object top-level.
  const inner = (decoded['data'] && typeof decoded['data'] === 'object')
    ? (decoded['data'] as Record<string, unknown>)
    : decoded;
  const info = inner;

  // CHẨN ĐOÁN: nếu vẫn thiếu zpw_enk, ghi ra TÊN các key thật (không lộ giá trị)
  // ở cả lớp ngoài lẫn lớp trong — để biết đúng tên/vị trí thay vì đoán.
  const secretKey = String(info['zpw_enk'] ?? '');
  if (!secretKey) {
    trace('login', 'response thiếu zpw_enk — dump keys', {
      outerKeys: Object.keys(decoded).slice(0, 20),
      innerKeys: info !== decoded ? Object.keys(info).slice(0, 30) : '(không có lớp data)',
      error_code: decoded['error_code'],
      error_message: decoded['error_message'],
    });
  }
  const uid = String(info['send2me_id'] ?? info['uid'] ?? info['userId'] ?? '');
  const serviceMap = (info['zpw_service_map_v3'] ?? {}) as Record<string, string[]>;
  // zpw_ws: danh sách URL WebSocket nhận tin. Có thể vắng ở vài bản build — khi
  // đó chỉ mất đường NHẬN, gửi vẫn chạy, nên không ném lỗi mà để listener báo.
  const wsRaw = info['zpw_ws'];
  const wsUrls = Array.isArray(wsRaw) ? (wsRaw as unknown[]).map(String) : typeof wsRaw === 'string' ? [wsRaw] : [];
  if (!secretKey) throw new Error('login: response thiếu zpw_enk (secretKey)');
  if (!serviceMap.chat?.length) throw new Error('login: response thiếu zpw_service_map_v3.chat');

  const base: ZaloContext = { ...ctx, secretKey, uid, serviceMap, wsUrls, pingIntervalMs: 0 };
  // Lấy ping_interval cho listener; lỗi thì bỏ qua (gửi tin không cần cái này).
  try {
    const info2 = (await getServerInfo(base)) as Record<string, unknown> | null;
    const settings = (info2?.['settings'] ?? (info2 as Record<string, unknown>)?.['setttings']) as
      | Record<string, unknown>
      | undefined;
    const socket = ((settings?.['features'] as Record<string, unknown>)?.['socket']) as
      | Record<string, unknown>
      | undefined;
    const ping = Number(socket?.['ping_interval']);
    if (Number.isFinite(ping) && ping > 0) base.pingIntervalMs = ping;
  } catch {
    /* không sao — listener sẽ dùng nhịp ping mặc định */
  }
  return base;
}

/**
 * Lấy thông tin server (settings/ping_interval) — listener cần.
 *
 * Port đúng zca-js: getserverinfo CHỈ gửi {imei, type, client_version,
 * computer_name, signkey} với apiVersion=false (KHÔNG đính zpw_ver/zpw_type,
 * KHÔNG gửi blob mã hoá). signkey vẫn tính qua getEncryptParam để đúng công thức.
 */
export async function getServerInfo(ctx: ZaloContext): Promise<unknown> {
  const ep = getEncryptParam(ctx, 'getserverinfo');
  const url = makeURL(
    SERVERINFO_URL,
    {
      imei: ctx.imei,
      type: API_TYPE,
      client_version: API_VERSION,
      computer_name: 'Web',
      signkey: String(ep.params.signkey ?? ''),
    },
    false,
  );
  const raw = await fetchZalo(url, { method: 'GET', headers: headers(ctx) }, 'getServerInfo');
  // getserverinfo trả data KHÔNG mã hoá (không có enk cho nó) — parse thẳng.
  if (!raw.data) return null;
  try { return JSON.parse(raw.data); } catch { return raw.data; }
}

export interface SendResult {
  ok: boolean;
  msgId?: string;
  detail: string;
  raw?: unknown;
}

/**
 * Gửi tin nhắn văn bản. Port từ apis/sendMessage.ts:
 *   cá nhân → chat[0]/api/message/sms, params.toid
 *   nhóm    → group[0]/api/group/sendmsg, params.grid
 * Body POST là URLSearchParams({ params: <encodeAES(secretKey, JSON)> }).
 */
export async function sendMessage(
  ctx: ZaloContext,
  opts: { threadId: string; message: string; group: boolean },
): Promise<SendResult> {
  const now = Date.now();
  const clientId = now;

  // threadId rỗng = gửi cho chính mình.
  const dest = opts.threadId || ctx.uid;
  if (!dest) return { ok: false, detail: 'không có threadId và cũng không biết uid để gửi cho chính mình' };

  const host = opts.group ? ctx.serviceMap.group?.[0] : ctx.serviceMap.chat?.[0];
  if (!host) return { ok: false, detail: `serviceMap thiếu host ${opts.group ? 'group' : 'chat'}` };
  const path = opts.group ? '/api/group/sendmsg' : '/api/message/sms';

  const payload: Record<string, unknown> = opts.group
    ? { grid: dest, message: opts.message, clientId, mentionInfo: '', ttl: 0, visibility: 0, imei: ctx.imei }
    : { toid: dest, message: opts.message, clientId, ttl: 0, imei: ctx.imei };

  const encrypted = encodeAES(ctx.secretKey, JSON.stringify(payload));
  if (!encrypted) return { ok: false, detail: 'mã hoá params thất bại' };

  const type = opts.group ? 'group' : 'sms';
  const signParams = { params: encrypted };
  const url = makeURL(`${host}${path}`, { nretry: 0, signkey: getSignKey(type, signParams) });

  const body = new URLSearchParams({ params: encrypted });
  // Hàm này trả SendResult chứ không ném — mọi lỗi mạng/timeout/HTML phải quy
  // về { ok:false, detail } để automation ghi trace được thay vì vỡ giữa chừng.
  let raw: ZaloEnvelope;
  try {
    raw = await fetchZalo(
      url,
      {
        method: 'POST',
        headers: { ...headers(ctx), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      'gửi tin',
    );
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  if (raw.error_code && raw.error_code !== 0) {
    return { ok: false, detail: `Zalo trả lỗi ${raw.error_code}: ${raw.error_message ?? ''}`, raw };
  }
  const decoded = raw.data ? decryptRespSecret(ctx.secretKey, raw.data) : null;
  const msgId =
    decoded && typeof decoded === 'object'
      ? String((decoded as Record<string, unknown>)['msgId'] ?? (decoded as Record<string, unknown>)['msgID'] ?? '')
      : '';
  return { ok: true, msgId: msgId || undefined, detail: 'đã gửi qua API' + (msgId ? ` · msgId ${msgId}` : ''), raw: decoded };
}
