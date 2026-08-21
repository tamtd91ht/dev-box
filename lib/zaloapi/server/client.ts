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

import { createHash } from 'crypto';
import { encodeAES, decodeAES, decodeRespAES, getSignKey, ParamsEncryptor } from './crypto';
import { readImageMeta } from './imageMeta';
import { trace } from './trace';
import { waitFileDone } from './uploadHub';

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
/** Một khoảng định dạng chữ — port style của Zalo (textProperties.styles). */
export interface TextStyle {
  start: number;
  len: number;
  /** 'b'|'i'|'u'|'s' | 'c_<hex6>' (màu) | 'f_<size>' (cỡ chữ). */
  st: string;
}

/** Một người cần tag (@) trong tin NHÓM — cần uid thật thì Zalo mới ping. */
export interface MentionTarget {
  uid: string;
  name: string;
}

/**
 * Nối dòng tag vào cuối tin + dựng mentionInfo (port từ zca-js Mention:
 * mảng {pos, len, uid, type:0}, pos/len tính theo đơn vị UTF-16 — chính là
 * .length của chuỗi JS nên không phải quy đổi gì).
 *
 * Text và vị trí được dựng CÙNG MỘT CHỖ ở đây — nếu để tầng trên tự ghép
 * "@Tên" vào text rồi tầng này đi dò lại vị trí thì tên người trùng với chữ
 * trong thân tin là mention trỏ sai người.
 */
function withMentions(message: string, mentions: MentionTarget[]): { message: string; mentionInfo: string } {
  if (!mentions.length) return { message, mentionInfo: '' };
  let text = message.trimEnd() + '\n→ ';
  const info: { pos: number; len: number; uid: string; type: 0 }[] = [];
  mentions.forEach((m, i) => {
    if (i > 0) text += ' ';
    const tagText = `@${m.name || m.uid}`;
    info.push({ pos: text.length, len: tagText.length, uid: m.uid, type: 0 });
    text += tagText;
  });
  return { message: text, mentionInfo: JSON.stringify(info) };
}

export async function sendMessage(
  ctx: ZaloContext,
  opts: { threadId: string; message: string; group: boolean; styles?: TextStyle[]; mentions?: MentionTarget[] },
): Promise<SendResult> {
  const now = Date.now();
  const clientId = now;

  // threadId rỗng = gửi cho chính mình.
  const dest = opts.threadId || ctx.uid;
  if (!dest) return { ok: false, detail: 'không có threadId và cũng không biết uid để gửi cho chính mình' };

  const host = opts.group ? ctx.serviceMap.group?.[0] : ctx.serviceMap.chat?.[0];
  if (!host) return { ok: false, detail: `serviceMap thiếu host ${opts.group ? 'group' : 'chat'}` };
  const path = opts.group ? '/api/group/sendmsg' : '/api/message/sms';

  // Mention chỉ có nghĩa trong nhóm — tin 1-1 bỏ qua lặng lẽ (người nhận là
  // chính người được "tag" rồi, thêm @ chỉ gây rối).
  const tagged = opts.group ? withMentions(opts.message, opts.mentions ?? []) : { message: opts.message, mentionInfo: '' };

  const payload: Record<string, unknown> = opts.group
    ? { grid: dest, message: tagged.message, clientId, mentionInfo: tagged.mentionInfo, ttl: 0, visibility: 0, imei: ctx.imei }
    : { toid: dest, message: opts.message, clientId, ttl: 0, imei: ctx.imei };

  // Định dạng chữ (in đậm/nghiêng/màu…) đi kèm dưới dạng textProperties — port
  // đúng zca-js: { styles:[{start,len,st}], ver:0 }.
  if (opts.styles?.length) {
    payload.textProperties = JSON.stringify({ styles: opts.styles, ver: 0 });
  }

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

// ════════════════════════════════════════════════════════════════════════════
//  GỬI ẢNH — port từ zca-js apis/uploadAttachment.ts + apis/sendMessage.ts.
//
//  Hai bước: (1) UPLOAD buffer ảnh lên file[0] (multipart, có thể nhiều chunk) →
//  nhận {photoId, normalUrl, hdUrl, thumbUrl}; (2) SEND tin ảnh tham chiếu các
//  URL đó. Khác gửi text: dùng host serviceMap.file, không có signkey.
//
//  ⚠ THỬ NGHIỆM chưa chạy thật được ở môi trường dev — hằng số nhạy phiên bản
//  (type=2 cá nhân / 11 nhóm; đường /message vs /group). Nếu Zalo từ chối, đọc
//  trace 'upload'/'sendPhoto' để biết error_code mà chỉnh.
// ════════════════════════════════════════════════════════════════════════════

/** Kích thước một chunk upload (byte). Ảnh thường < 1 chunk; ảnh lớn thì chia. */
const UPLOAD_CHUNK = 1_000_000;

export interface ImageAttachment {
  photoId: string;
  normalUrl: string;
  hdUrl: string;
  thumbUrl: string;
  width: number;
  height: number;
  totalSize: number;
}

/** Lấy một object con lồng theo tên khoá (chịu được response bọc lớp `data`). */
function unwrap(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o['data'] && typeof o['data'] === 'object') return o['data'] as Record<string, unknown>;
  return o;
}

/**
 * Upload buffer ảnh. Trả ImageAttachment để sendPhoto tham chiếu.
 * Port: params mã hoá nằm ở QUERY (khác gửi tin — params ở body), body là
 * multipart field `chunkContent`.
 */
export async function uploadImage(
  ctx: ZaloContext,
  opts: { buffer: Buffer; fileName: string; threadId: string; group: boolean },
): Promise<ImageAttachment> {
  const host = ctx.serviceMap.file?.[0];
  if (!host) throw new Error('serviceMap thiếu host file — bản build không lộ đường upload');
  const dest = opts.threadId || ctx.uid;
  if (!dest) throw new Error('không có threadId để upload ảnh');

  const meta = readImageMeta(opts.buffer);
  const totalSize = meta.totalSize;
  const totalChunk = Math.max(1, Math.ceil(totalSize / UPLOAD_CHUNK));
  const clientId = Date.now();
  const typeParam = opts.group ? '11' : '2';
  const path = `/api/${opts.group ? 'group' : 'message'}/photo_original/upload`;

  let result: ImageAttachment | null = null;
  for (let i = 0; i < totalChunk; i++) {
    const chunk = opts.buffer.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK);
    const params: Record<string, unknown> = {
      totalChunk,
      fileName: opts.fileName,
      clientId,
      totalSize,
      imei: ctx.imei,
      isE2EE: 0,
      jxl: 0,
      chunkId: i + 1,
      [opts.group ? 'grid' : 'toid']: dest,
    };
    const encrypted = encodeAES(ctx.secretKey, JSON.stringify(params));
    if (!encrypted) throw new Error('mã hoá params upload thất bại');
    const url = makeURL(`${host}${path}`, { type: typeParam, params: encrypted });

    const form = new FormData();
    form.append('chunkContent', new Blob([new Uint8Array(chunk)], { type: 'application/octet-stream' }), opts.fileName);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
    let raw: ZaloEnvelope;
    try {
      const res = await fetch(url, { method: 'POST', headers: headers(ctx), body: form, signal: ac.signal });
      const text = await res.text().catch(() => '');
      if (!text.trim()) throw new Error(`upload: Zalo trả rỗng (HTTP ${res.status})`);
      raw = JSON.parse(text) as ZaloEnvelope;
    } catch (e) {
      throw new Error(`upload chunk ${i + 1}/${totalChunk}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (raw.error_code && raw.error_code !== 0) {
      trace('upload', `Zalo lỗi ${raw.error_code}`, { chunk: i + 1, totalChunk, msg: raw.error_message });
      throw new Error(`upload ảnh lỗi ${raw.error_code}: ${raw.error_message ?? ''}`);
    }
    const decoded = raw.data ? unwrap(decryptRespSecret(ctx.secretKey, raw.data)) : null;
    if (decoded && (decoded['photoId'] || decoded['normalUrl'])) {
      result = {
        photoId: String(decoded['photoId'] ?? ''),
        normalUrl: String(decoded['normalUrl'] ?? decoded['oriUrl'] ?? ''),
        hdUrl: String(decoded['hdUrl'] ?? ''),
        thumbUrl: String(decoded['thumbUrl'] ?? ''),
        width: meta.width,
        height: meta.height,
        totalSize,
      };
    }
  }

  if (!result) throw new Error('upload xong nhưng response không có photoId/normalUrl — xem trace');
  trace('upload', 'upload ảnh OK', { photoId: result.photoId, hasUrls: !!result.normalUrl });
  return result;
}

/** Gửi tin ẢNH tham chiếu attachment đã upload. Port từ nhánh photo của sendMessage. */
export async function sendPhoto(
  ctx: ZaloContext,
  opts: { threadId: string; group: boolean; attachment: ImageAttachment; caption?: string },
): Promise<SendResult> {
  const host = ctx.serviceMap.file?.[0];
  if (!host) return { ok: false, detail: 'serviceMap thiếu host file' };
  const dest = opts.threadId || ctx.uid;
  if (!dest) return { ok: false, detail: 'không có threadId để gửi ảnh' };
  const a = opts.attachment;
  const clientId = Date.now();
  const isGroup = opts.group;

  const payload: Record<string, unknown> = {
    photoId: a.photoId,
    clientId: String(clientId),
    desc: opts.caption ?? '',
    width: a.width,
    height: a.height,
    toid: isGroup ? undefined : String(dest),
    grid: isGroup ? String(dest) : undefined,
    rawUrl: a.normalUrl,
    hdUrl: a.hdUrl,
    thumbUrl: a.thumbUrl,
    oriUrl: isGroup ? a.normalUrl : undefined,
    normalUrl: isGroup ? undefined : a.normalUrl,
    hdSize: String(a.totalSize),
    zsource: -1,
    ttl: 0,
    jcp: '{"convertible":"jxl"}',
  };

  const encrypted = encodeAES(ctx.secretKey, JSON.stringify(payload));
  if (!encrypted) return { ok: false, detail: 'mã hoá params gửi ảnh thất bại' };
  const url = makeURL(`${host}/api/${isGroup ? 'group' : 'message'}/photo_original/send`, { nretry: 0 });
  const body = new URLSearchParams({ params: encrypted });

  let raw: ZaloEnvelope;
  try {
    raw = await fetchZalo(
      url,
      { method: 'POST', headers: { ...headers(ctx), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      'gửi ảnh',
    );
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  if (raw.error_code && raw.error_code !== 0) {
    trace('sendPhoto', `Zalo lỗi ${raw.error_code}`, { msg: raw.error_message });
    return { ok: false, detail: `Zalo trả lỗi ${raw.error_code}: ${raw.error_message ?? ''}`, raw };
  }
  const decoded = raw.data ? decryptRespSecret(ctx.secretKey, raw.data) : null;
  const msgId = decoded && typeof decoded === 'object' ? String((decoded as Record<string, unknown>)['msgId'] ?? '') : '';
  return { ok: true, msgId: msgId || undefined, detail: 'đã gửi ảnh qua API', raw: decoded };
}

// ════════════════════════════════════════════════════════════════════════════
//  GỬI FILE ĐÍNH KÈM — port từ nhánh "others" của zca-js uploadAttachment +
//  sendMessage (asyncfile). Khác ảnh ở MỘT điểm cốt lõi: HTTP upload chỉ trả
//  fileId; fileUrl về SAU qua WebSocket (file_done, xem uploadHub) — nên
//  LISTENER phải đang chạy thì gửi file mới hoàn tất.
// ════════════════════════════════════════════════════════════════════════════

export interface FileAttachment {
  fileId: string;
  /** md5 hex của toàn bộ file — Zalo đối chiếu khi nhận. */
  checksum: string;
  fileUrl: string;
  totalSize: number;
  fileName: string;
}

/**
 * Upload buffer FILE theo chunk (multipart `chunkContent`, params mã hoá ở
 * query — cùng khuôn uploadImage nhưng endpoint asyncfile/upload), rồi chờ
 * file_done để lấy fileUrl.
 */
export async function uploadFile(
  ctx: ZaloContext,
  opts: { buffer: Buffer; fileName: string; threadId: string; group: boolean },
): Promise<FileAttachment> {
  const host = ctx.serviceMap.file?.[0];
  if (!host) throw new Error('serviceMap thiếu host file — bản build không lộ đường upload');
  const dest = opts.threadId || ctx.uid;
  if (!dest) throw new Error('không có threadId để upload file');

  const totalSize = opts.buffer.length;
  const totalChunk = Math.max(1, Math.ceil(totalSize / UPLOAD_CHUNK));
  const clientId = Date.now();
  const typeParam = opts.group ? '11' : '2';
  const path = `/api/${opts.group ? 'group' : 'message'}/asyncfile/upload`;

  let fileId = '';
  let done: Promise<{ fileUrl: string }> | null = null;
  for (let i = 0; i < totalChunk; i++) {
    const chunk = opts.buffer.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK);
    const params: Record<string, unknown> = {
      totalChunk,
      fileName: opts.fileName,
      clientId,
      totalSize,
      imei: ctx.imei,
      isE2EE: 0,
      jxl: 0,
      chunkId: i + 1,
      [opts.group ? 'grid' : 'toid']: dest,
    };
    const encrypted = encodeAES(ctx.secretKey, JSON.stringify(params));
    if (!encrypted) throw new Error('mã hoá params upload file thất bại');
    const url = makeURL(`${host}${path}`, { type: typeParam, params: encrypted });

    const form = new FormData();
    form.append('chunkContent', new Blob([new Uint8Array(chunk)], { type: 'application/octet-stream' }), opts.fileName);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
    let raw: ZaloEnvelope;
    try {
      const res = await fetch(url, { method: 'POST', headers: headers(ctx), body: form, signal: ac.signal });
      const text = await res.text().catch(() => '');
      if (!text.trim()) throw new Error(`upload file: Zalo trả rỗng (HTTP ${res.status})`);
      raw = JSON.parse(text) as ZaloEnvelope;
    } catch (e) {
      throw new Error(`upload file chunk ${i + 1}/${totalChunk}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (raw.error_code && raw.error_code !== 0) {
      trace('uploadFile', `Zalo lỗi ${raw.error_code}`, { chunk: i + 1, totalChunk, msg: raw.error_message });
      throw new Error(`upload file lỗi ${raw.error_code}: ${raw.error_message ?? ''}`);
    }
    const decoded = raw.data ? unwrap(decryptRespSecret(ctx.secretKey, raw.data)) : null;
    if (decoded && decoded['fileId'] != null && !fileId) {
      fileId = String(decoded['fileId']);
      // Đăng ký chờ NGAY khi biết fileId — file_done có thể về trước khi vòng
      // upload kết thúc (Zalo phát nó ngay lúc ghép đủ chunk phía server).
      done = waitFileDone(fileId);
      // Reject của promise này được await bên dưới; chặn unhandled-rejection
      // trong lúc còn đang upload các chunk còn lại.
      done.catch(() => {});
    }
  }

  if (!fileId || !done) throw new Error('upload xong nhưng response không có fileId — xem trace');
  const checksum = createHash('md5').update(opts.buffer).digest('hex');
  const { fileUrl } = await done;
  trace('uploadFile', 'upload file OK', { fileId, totalSize, fileName: opts.fileName });
  return { fileId, checksum, fileUrl, totalSize, fileName: opts.fileName };
}

/** Gửi tin FILE tham chiếu attachment đã upload — nhánh asyncfile/msg. */
export async function sendFileMessage(
  ctx: ZaloContext,
  opts: { threadId: string; group: boolean; attachment: FileAttachment },
): Promise<SendResult> {
  const host = ctx.serviceMap.file?.[0];
  if (!host) return { ok: false, detail: 'serviceMap thiếu host file' };
  const dest = opts.threadId || ctx.uid;
  if (!dest) return { ok: false, detail: 'không có threadId để gửi file' };
  const a = opts.attachment;
  const isGroup = opts.group;
  const dot = a.fileName.lastIndexOf('.');
  const extension = dot > 0 ? a.fileName.slice(dot + 1).toLowerCase() : '';

  // `extention` sai chính tả là CỦA ZALO — sửa lại là server từ chối.
  const payload: Record<string, unknown> = {
    fileId: a.fileId,
    checksum: a.checksum,
    checksumSha: '',
    extention: extension,
    totalSize: a.totalSize,
    fileName: a.fileName,
    clientId: Date.now(),
    fType: 1,
    fileCount: 0,
    fdata: '{}',
    toid: isGroup ? undefined : String(dest),
    grid: isGroup ? String(dest) : undefined,
    fileUrl: a.fileUrl,
    zsource: -1,
    ttl: 0,
  };

  const encrypted = encodeAES(ctx.secretKey, JSON.stringify(payload));
  if (!encrypted) return { ok: false, detail: 'mã hoá params gửi file thất bại' };
  const url = makeURL(`${host}/api/${isGroup ? 'group' : 'message'}/asyncfile/msg`, { nretry: 0 });
  const body = new URLSearchParams({ params: encrypted });

  let raw: ZaloEnvelope;
  try {
    raw = await fetchZalo(
      url,
      { method: 'POST', headers: { ...headers(ctx), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      'gửi file',
    );
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  if (raw.error_code && raw.error_code !== 0) {
    trace('sendFile', `Zalo lỗi ${raw.error_code}`, { msg: raw.error_message });
    return { ok: false, detail: `Zalo trả lỗi ${raw.error_code}: ${raw.error_message ?? ''}`, raw };
  }
  const decoded = raw.data ? decryptRespSecret(ctx.secretKey, raw.data) : null;
  const msgId = decoded && typeof decoded === 'object' ? String((decoded as Record<string, unknown>)['msgId'] ?? '') : '';
  return { ok: true, msgId: msgId || undefined, detail: 'đã gửi file qua API', raw: decoded };
}

// ════════════════════════════════════════════════════════════════════════════
//  LỊCH SỬ NHÓM — port nguyên từ zca-js apis/getGroupChatHistory.ts.
//  GET group[0]/api/group/history?params=encodeAES({grid,count}). KHÔNG signkey.
//  (Zalo Web KHÔNG có API tương đương cho chat 1-1 — lịch sử 1-1 chỉ dựng dần
//  từ lúc kết nối; đây là giới hạn của nền tảng, không phải thiếu sót port.)
// ════════════════════════════════════════════════════════════════════════════

/** Một tin lịch sử đã chuẩn hoá (khớp StoredMessage của threadStore). */
export interface HistoryMessage {
  id: string;
  at: number;
  self: boolean;
  fromId: string;
  fromName: string;
  text: string;
  /** id THẬT của Zalo (gMsgID/cMsgID khi thả cảm xúc) — xem zMsgId ở threadStore. */
  zMsgId?: string;
  zCliMsgId?: string;
}

function historyText(m: Record<string, unknown>): string {
  const c = m['content'];
  if (typeof c === 'string' && c) return c;
  if (c && typeof c === 'object') {
    const t = (c as Record<string, unknown>)['title'] ?? (c as Record<string, unknown>)['text'];
    if (typeof t === 'string' && t) return t;
  }
  const alt = m['message'] ?? m['msg'];
  return typeof alt === 'string' ? alt : '';
}

/** Lấy lịch sử tin của một NHÓM (mới → cũ tuỳ Zalo; ta sắp lại theo ts tăng). */
export async function getGroupHistory(ctx: ZaloContext, groupId: string, count = 50): Promise<HistoryMessage[]> {
  const host = ctx.serviceMap.group?.[0];
  if (!host) throw new Error('serviceMap thiếu host group');
  const encrypted = encodeAES(ctx.secretKey, JSON.stringify({ grid: groupId, count }));
  if (!encrypted) throw new Error('mã hoá params lịch sử thất bại');
  const url = makeURL(`${host}/api/group/history`, { params: encrypted });

  const raw = await fetchZalo(url, { method: 'GET', headers: headers(ctx) }, 'lịch sử nhóm');
  if (raw.error_code && raw.error_code !== 0) {
    throw new Error(`lịch sử nhóm lỗi ${raw.error_code}: ${raw.error_message ?? ''}`);
  }
  const decoded = raw.data ? decryptRespSecret(ctx.secretKey, raw.data) : null;
  const inner = unwrap(decoded);
  const listRaw = inner?.['groupMsgs'];
  const list = Array.isArray(listRaw) ? listRaw : [];

  const out: HistoryMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const text = historyText(m);
    if (!text) continue;
    const fromId = String(m['uidFrom'] ?? m['fromId'] ?? '');
    const at = Number(m['ts'] ?? m['at'] ?? 0) || 0;
    // id THẬT của Zalo, giữ riêng để thả cảm xúc được (xem zMsgId trong
    // threadStore). `id` bên dưới có thể là chuỗi ta tự ghép khi payload thiếu.
    const zMsgId = String(m['msgId'] ?? m['msgID'] ?? m['realMsgId'] ?? '');
    const zCliMsgId = String(m['cliMsgId'] ?? m['clientMsgId'] ?? '');
    out.push({
      id: zMsgId || `${at}-${fromId}`,
      at,
      self: !!ctx.uid && fromId === ctx.uid,
      fromId,
      fromName: String(m['dName'] ?? m['fromName'] ?? ''),
      text,
      ...(zMsgId ? { zMsgId } : {}),
      ...(zCliMsgId ? { zCliMsgId } : {}),
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  QUÉT DANH BẠ — lấy DANH SÁCH NHÓM + KHÁCH (bạn) về, để danh sách hội thoại
//  không trống trơn mỗi lần vào. Port từ zca-js:
//    getAllGroups   GET  group_poll[0]/api/group/getlg/v4        → gridVerMap (ids)
//    getGroupInfo   POST group[0]/api/group/getmg-v2            → tên nhóm
//    getAllFriends  GET  profile[0]/api/social/friend/getfriends → khách 1-1
// ════════════════════════════════════════════════════════════════════════════

/** Một mục danh bạ tối thiểu để nạp vào danh sách hội thoại. */
export interface ContactLite {
  threadId: string;
  name: string;
  group: boolean;
}

/** Danh sách id nhóm tài khoản đang tham gia. */
async function getAllGroupIds(ctx: ZaloContext): Promise<string[]> {
  const host = ctx.serviceMap.group_poll?.[0] ?? ctx.serviceMap.group?.[0];
  if (!host) return [];
  const url = makeURL(`${host}/api/group/getlg/v4`, {});
  const raw = await fetchZalo(url, { method: 'GET', headers: headers(ctx) }, 'lấy danh sách nhóm');
  if (raw.error_code && raw.error_code !== 0) throw new Error(`getlg lỗi ${raw.error_code}: ${raw.error_message ?? ''}`);
  const decoded = raw.data ? unwrap(decryptRespSecret(ctx.secretKey, raw.data)) : null;
  const map = decoded?.['gridVerMap'];
  return map && typeof map === 'object' ? Object.keys(map as Record<string, unknown>) : [];
}

/** Tên nhóm theo id (chia lô để tránh payload quá lớn). */
async function getGroupsInfo(ctx: ZaloContext, ids: string[]): Promise<ContactLite[]> {
  const host = ctx.serviceMap.group?.[0];
  if (!host || !ids.length) return [];
  const out: ContactLite[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const gridVerMap = JSON.stringify(Object.fromEntries(chunk.map((id) => [id, 0])));
    const encrypted = encodeAES(ctx.secretKey, JSON.stringify({ gridVerMap }));
    if (!encrypted) continue;
    const url = makeURL(`${host}/api/group/getmg-v2`, {});
    const body = new URLSearchParams({ params: encrypted });
    let raw: ZaloEnvelope;
    try {
      raw = await fetchZalo(url, { method: 'POST', headers: { ...headers(ctx), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, 'thông tin nhóm');
    } catch { continue; }
    const decoded = raw.data ? unwrap(decryptRespSecret(ctx.secretKey, raw.data)) : null;
    const infoMap = decoded?.['gridInfoMap'];
    if (infoMap && typeof infoMap === 'object') {
      for (const [gid, info] of Object.entries(infoMap as Record<string, Record<string, unknown>>)) {
        out.push({ threadId: gid, name: String(info?.['name'] ?? gid), group: true });
      }
    }
  }
  return out;
}

/** Danh sách khách (bạn bè) 1-1. */
async function getAllFriendContacts(ctx: ZaloContext): Promise<ContactLite[]> {
  const host = ctx.serviceMap.profile?.[0];
  if (!host) return [];
  const params = { incInvalid: 1, page: 1, count: 20000, avatar_size: 120, actiontime: 0, imei: ctx.imei };
  const encrypted = encodeAES(ctx.secretKey, JSON.stringify(params));
  if (!encrypted) return [];
  const url = makeURL(`${host}/api/social/friend/getfriends`, { params: encrypted });
  const raw = await fetchZalo(url, { method: 'GET', headers: headers(ctx) }, 'danh sách bạn');
  if (raw.error_code && raw.error_code !== 0) throw new Error(`getfriends lỗi ${raw.error_code}: ${raw.error_message ?? ''}`);
  const decoded = raw.data ? decryptRespSecret(ctx.secretKey, raw.data) : null;
  const arr = Array.isArray(decoded)
    ? (decoded as unknown[])
    : (() => { const d = unwrap(decoded); const v = d?.['data'] ?? d; return Array.isArray(v) ? (v as unknown[]) : []; })();
  const out: ContactLite[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const u = item as Record<string, unknown>;
    const id = String(u['userId'] ?? u['uid'] ?? '');
    if (!id) continue;
    out.push({ threadId: id, name: String(u['displayName'] ?? u['zaloName'] ?? id), group: false });
  }
  return out;
}

/**
 * Quét TẤT CẢ nhóm + khách về một lượt. Mỗi nguồn lỗi độc lập (không có nhóm,
 * hoặc endpoint đổi) không làm hỏng nguồn kia. Loại chính uid tài khoản.
 */
export async function scanContacts(ctx: ZaloContext): Promise<{ contacts: ContactLite[]; groups: number; friends: number; note: string }> {
  const notes: string[] = [];
  let groups: ContactLite[] = [];
  let friends: ContactLite[] = [];
  try {
    const ids = await getAllGroupIds(ctx);
    groups = await getGroupsInfo(ctx, ids);
  } catch (e) { notes.push('nhóm: ' + (e as Error).message); }
  try {
    friends = await getAllFriendContacts(ctx);
  } catch (e) { notes.push('khách: ' + (e as Error).message); }

  const seen = new Set<string>();
  const contacts: ContactLite[] = [];
  for (const c of [...groups, ...friends]) {
    if (!c.threadId || c.threadId === ctx.uid || seen.has(c.threadId)) continue;
    seen.add(c.threadId);
    contacts.push(c);
  }
  return { contacts, groups: groups.length, friends: friends.length, note: notes.join(' · ') };
}

// ════════════════════════════════════════════════════════════════════════════
//  THẢ CẢM XÚC (reaction) — port từ zca-js apis/addReaction.ts.
//
//  Endpoint dùng host serviceMap.reaction (KHÔNG phải chat/group như gửi tin):
//    cá nhân → reaction[0]/api/message/reaction, params.toid
//    nhóm    → reaction[0]/api/group/reaction,   params.grid + imei
//
//  Payload có một chỗ dễ sai: `react_list[0].message` là một CHUỖI JSON lồng
//  bên trong params (không phải object). Bên trong nó cần CẢ HAI id của tin:
//    gMsgID = msgId phía SERVER  ·  cMsgID = msgId phía CLIENT
//  Zalo dùng cặp này để định vị đúng tin. Ta thường chỉ có một trong hai (tin
//  đến có msgId server; tin mình gửi lạc quan có cliMsgId) nên khi thiếu thì
//  điền cùng một giá trị cho cả hai — đúng cách zca-js làm khi caller chỉ đưa
//  một id, và Zalo chấp nhận.
//
//  rType = -1 nghĩa là BỎ cảm xúc (xem lib/zaloapi/reactions.ts).
// ════════════════════════════════════════════════════════════════════════════

export interface ReactionResult {
  ok: boolean;
  detail: string;
  raw?: unknown;
}

export async function sendReaction(
  ctx: ZaloContext,
  opts: {
    threadId: string;
    group: boolean;
    /** msgId phía server (gMsgID). Để rỗng nếu chỉ có id client. */
    msgId: string;
    /** msgId phía client (cMsgID). Để rỗng nếu chỉ có id server. */
    cliMsgId?: string;
    /** rIcon — chuỗi emoticon Zalo, vd '/-heart'. */
    icon: string;
    rType: number;
    source?: number;
  },
): Promise<ReactionResult> {
  const dest = opts.threadId || ctx.uid;
  if (!dest) return { ok: false, detail: 'không có threadId để thả cảm xúc' };

  // gMsgID / cMsgID phải là SỐ (zca-js dùng parseInt). Gửi chuỗi thì Zalo vẫn
  // trả error_code 0 nhưng KHÔNG áp cảm xúc — im lặng bỏ qua, đúng triệu chứng
  // "bấm được mà máy người nhận không thấy gì".
  //
  // Và phải là id THẬT của Zalo, không phải id ta tự sinh: kho tin nội bộ đặt
  // 'out-<at>-<hash>' cho tin gửi lạc quan và '<at>-<hash>' cho tin đến thiếu
  // msgId (xem threadStore). Mấy id đó Zalo không tra được → cũng im lặng.
  // Thà BÁO LỖI rõ ở đây còn hơn để người dùng tưởng đã thả xong.
  const numeric = (v: string | undefined): string => {
    const s = (v ?? '').trim();
    return /^\d+$/.test(s) ? s : '';
  };
  const gMsgID = numeric(opts.msgId) || numeric(opts.cliMsgId);
  const cMsgID = numeric(opts.cliMsgId) || numeric(opts.msgId);
  if (!gMsgID) {
    return {
      ok: false,
      detail: 'tin này chưa có msgId thật từ Zalo nên không thả được cảm xúc '
        + '(tin vừa gửi cần đợi Zalo dội về, tin cũ khôi phục từ kho có thể không còn id gốc)',
    };
  }

  // Host reaction riêng; bản build nào không lộ thì thử group/chat cho đỡ chết.
  const host = ctx.serviceMap.reaction?.[0]
    ?? (opts.group ? ctx.serviceMap.group?.[0] : ctx.serviceMap.chat?.[0]);
  if (!host) return { ok: false, detail: 'serviceMap thiếu host reaction' };
  const path = opts.group ? '/api/group/reaction' : '/api/message/reaction';

  const payload: Record<string, unknown> = {
    react_list: [
      {
        // CHUỖI JSON lồng — không phải object (xem ghi chú đầu khối). gMsgID/
        // cMsgID phải ra SỐ trong JSON (zca-js parseInt) — Number() ở đây, không
        // phải chuỗi, nếu không Zalo im lặng bỏ qua.
        message: JSON.stringify({
          rMsg: [{ gMsgID: Number(gMsgID), cMsgID: Number(cMsgID || gMsgID), msgType: 1 }],
          rIcon: opts.icon,
          rType: opts.rType,
          source: opts.source ?? 6,
        }),
        clientId: Date.now(),
      },
    ],
    ...(opts.group ? { grid: dest, imei: ctx.imei } : { toid: dest }),
  };

  const encrypted = encodeAES(ctx.secretKey, JSON.stringify(payload));
  if (!encrypted) return { ok: false, detail: 'mã hoá params cảm xúc thất bại' };
  const url = makeURL(`${host}${path}`, { nretry: 0 });

  let raw: ZaloEnvelope;
  try {
    raw = await fetchZalo(
      url,
      {
        method: 'POST',
        headers: { ...headers(ctx), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ params: encrypted }).toString(),
      },
      'thả cảm xúc',
    );
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  if (raw.error_code && raw.error_code !== 0) {
    return { ok: false, detail: `Zalo trả lỗi ${raw.error_code}: ${raw.error_message ?? ''}`, raw };
  }
  const decoded = raw.data ? decryptRespSecret(ctx.secretKey, raw.data) : null;
  return {
    ok: true,
    detail: opts.rType === -1 ? 'đã bỏ cảm xúc' : `đã thả ${opts.icon}`,
    raw: decoded,
  };
}
