// Zalo API (thử nghiệm) — lớp crypto, port CHÍNH XÁC từ zca-js (RFS-ADRENO).
//
// KHÔNG tự nghĩ ra crypto. Đây là bản port nguyên xi các hàm của zca-js, vì sai
// một byte là toàn bộ request bị Zalo từ chối. Giữ nguyên hằng số, thứ tự ghép
// ký tự, IV, chế độ AES. Nguồn: zca-js/src/utils.ts.
//
// Chạy SERVER-SIDE (Node) — không phụ thuộc webview. Dùng crypto-js cho AES-CBC
// (khớp WordArray/PKCS7 của zca-js), node WebCrypto cho AES-GCM nhận tin.

import CryptoJS from 'crypto-js';

/** AES-CBC IV toàn số 0 (16 byte) — zca-js dùng đúng cái này cho mọi request. */
const ZERO_IV = CryptoJS.enc.Hex.parse('00000000000000000000000000000000');

/**
 * Mã hoá tham số request đã login: encodeAES(secretKey, JSON.stringify(data)).
 * secretKey là zpw_enk (base64) lấy từ response login. Ra base64 → nhét vào
 * query/body field `params`.
 */
export function encodeAES(secretKey: string, data: string, retry = 0): string | null {
  try {
    const key = CryptoJS.enc.Base64.parse(secretKey);
    return CryptoJS.AES.encrypt(data, key, {
      iv: ZERO_IV,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }).ciphertext.toString(CryptoJS.enc.Base64);
  } catch {
    return retry < 3 ? encodeAES(secretKey, data, retry + 1) : null;
  }
}

/** Giải mã response (ngược của encodeAES). */
export function decodeAES(secretKey: string, data: string, retry = 0): string | null {
  try {
    const raw = decodeURIComponent(data);
    const key = CryptoJS.enc.Base64.parse(secretKey);
    return CryptoJS.AES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(raw) } as CryptoJS.lib.CipherParams,
      key,
      { iv: ZERO_IV, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
    ).toString(CryptoJS.enc.Utf8);
  } catch {
    return retry < 3 ? decodeAES(secretKey, data, retry + 1) : null;
  }
}

/**
 * Giải mã RESPONSE LOGIN — khoá là encryptKey (chuỗi UTF-8), KHÁC decodeAES
 * (khoá base64). Port `decodeRespAES` của zca-js.
 *
 * Vì sao có hai hàm giải mã: response LOGIN mã hoá bằng encryptKey UTF-8 (do
 * ParamsEncryptor sinh), còn response sau-login (message) mã hoá bằng secretKey
 * base64. Dùng nhầm hàm → "giải mã response thất bại" dù request đã đúng.
 */
export function decodeRespAES(key: string, data: string): string | null {
  try {
    const raw = decodeURIComponent(data);
    const parsedKey = CryptoJS.enc.Utf8.parse(key);
    return CryptoJS.AES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(raw) } as CryptoJS.lib.CipherParams,
      parsedKey,
      { iv: ZERO_IV, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
    ).toString(CryptoJS.enc.Utf8);
  } catch {
    return null;
  }
}

/**
 * Chữ ký request: MD5("zsecure" + type + <các value đã sắp xếp theo key>).
 * Port nguyên từ getSignKey của zca-js.
 */
export function getSignKey(type: string, params: Record<string, unknown>): string {
  const keys: string[] = [];
  for (const k in params) if (Object.prototype.hasOwnProperty.call(params, k)) keys.push(k);
  keys.sort();
  let a = 'zsecure' + type;
  for (const k of keys) a += params[k];
  return CryptoJS.MD5(a).toString();
}

/**
 * Mã hoá tham số TRƯỚC KHI login (chưa có secretKey). Dựng zcid từ imei bằng
 * khoá cứng của Zalo, rồi dẫn ra encryptKey. Port nguyên ParamsEncryptor.
 *
 * Vì sao có khoá cứng "3FC4F0..." trong code: đó là hằng số của chính Zalo Web,
 * dùng để dựng zcid — không phải bí mật của ta, và không mã hoá nội dung tin,
 * chỉ mã hoá cái định danh phiên khởi tạo.
 */
export class ParamsEncryptor {
  private zcid: string | null = null;
  private zcidExt: string;
  private encryptKey: string | null = null;
  private readonly encVer = 'v2';

  constructor(opts: { type: number; imei: string; firstLaunchTime: number }) {
    this.createZcid(opts.type, opts.imei, opts.firstLaunchTime);
    this.zcidExt = ParamsEncryptor.randomString();
    this.createEncryptKey();
  }

  getEncryptKey(): string {
    if (!this.encryptKey) throw new Error('getEncryptKey: chưa dựng encryptKey');
    return this.encryptKey;
  }

  getParams(): { zcid: string; zcid_ext: string; enc_ver: string } | null {
    return this.zcid ? { zcid: this.zcid, zcid_ext: this.zcidExt, enc_ver: this.encVer } : null;
  }

  private createZcid(type: number, imei: string, firstLaunchTime: number): void {
    if (!type || !imei || !firstLaunchTime) throw new Error('createZcid: thiếu tham số');
    const msg = `${type},${imei},${firstLaunchTime}`;
    this.zcid = ParamsEncryptor.encodeAES('3FC4F0D2AB50057BCE0D90D9187A22B1', msg, 'hex', true);
  }

  private createEncryptKey(depth = 0): boolean {
    const build = (md5Upper: string, zcid: string): boolean => {
      const { even: n } = ParamsEncryptor.processStr(md5Upper);
      const { even: a, odd: s } = ParamsEncryptor.processStr(zcid);
      if (!n || !a || !s) return false;
      const i = n.slice(0, 8).join('') + a.slice(0, 12).join('') + s.reverse().slice(0, 12).join('');
      this.encryptKey = i;
      return true;
    };
    if (!this.zcid || !this.zcidExt) throw new Error('createEncryptKey: thiếu zcid/zcid_ext');
    try {
      const n = CryptoJS.MD5(this.zcidExt).toString().toUpperCase();
      if (build(n, this.zcid) || !(depth < 3)) return false;
      this.createEncryptKey(depth + 1);
    } catch {
      if (depth < 3) this.createEncryptKey(depth + 1);
    }
    return true;
  }

  /**
   * AES-CBC với khoá là chuỗi UTF-8 (KHÁC encodeAES tự do ở dưới — cái kia parse
   * khoá base64). Port `ParamsEncryptor.encodeAES` của zca-js. Ra hex hoặc base64.
   *
   * PHẢI dùng đúng cái này cho payload login: zcid dùng hex+uppercase, còn dữ
   * liệu login dùng base64+thường. Trước đây login lỡ dùng `encodeAES` (khoá
   * base64) → mã hoá rác → Zalo trả 18060 "Invalid encryption protocol".
   */
  static encodeAES(key: string, message: string, type: 'hex' | 'base64', upper: boolean, retry = 0): string | null {
    if (!message) return null;
    try {
      const k = CryptoJS.enc.Utf8.parse(key);
      const encoder = type === 'hex' ? CryptoJS.enc.Hex : CryptoJS.enc.Base64;
      const enc = CryptoJS.AES.encrypt(message, k, {
        iv: ZERO_IV,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      }).ciphertext.toString(encoder);
      return upper ? enc.toUpperCase() : enc;
    } catch {
      return retry < 3 ? ParamsEncryptor.encodeAES(key, message, type, upper, retry + 1) : null;
    }
  }

  /** Tách ký tự vị trí chẵn / lẻ — port processStr của zca-js. */
  private static processStr(e: string): { even: string[] | null; odd: string[] | null } {
    if (!e || typeof e !== 'string') return { even: null, odd: null };
    const acc: string[][] = [[], []];
    [...e].forEach((ch, n) => acc[n % 2].push(ch));
    return { even: acc[0], odd: acc[1] };
  }

  /** Chuỗi hex ngẫu nhiên 6..12 ký tự — port randomString của zca-js. */
  static randomString(min?: number, max?: number): string {
    const n = min || 6;
    const a = max && min && max > min ? max : 12;
    let s = Math.floor(Math.random() * (a - n + 1)) + n;
    if (s > 12) {
      let e = '';
      while (s > 0) {
        e += Math.random().toString(16).substr(2, s > 12 ? 12 : s);
        s -= 12;
      }
      return e;
    }
    return Math.random().toString(16).substr(2, s);
  }
}

/**
 * Giải mã một sự kiện WebSocket (nhận tin) — port decodeEventData.
 * encrypt: 0 = JSON thô, 1 = base64 rồi inflate, 2/3 = AES-GCM.
 * GCM: IV = byte[0:16], AAD = byte[16:32], data = byte[32:], tag 128-bit.
 */
export async function decodeEventData(
  parsed: { data: unknown; encrypt: unknown },
  cipherKey?: string,
): Promise<unknown> {
  if (typeof parsed.data !== 'string') throw new Error('decodeEventData: data không phải string');
  if (typeof parsed.encrypt !== 'number') throw new Error('decodeEventData: encrypt không phải number');
  const encryptType = parsed.encrypt as 0 | 1 | 2 | 3;
  if (encryptType < 0 || encryptType > 3) throw new Error('decodeEventData: encrypt ngoài 0..3');

  const rawData = parsed.data;
  if (encryptType === 0) return JSON.parse(rawData);

  const b64 = encryptType === 1 ? rawData : decodeURIComponent(rawData);
  const decoded = Buffer.from(b64, 'base64');

  let decrypted: Uint8Array = decoded;
  if (encryptType !== 1) {
    if (cipherKey && decoded.length >= 48) {
      const iv = decoded.subarray(0, 16);
      const aad = decoded.subarray(16, 32);
      const dataSource = decoded.subarray(32);
      const keyBuf = Buffer.from(cipherKey, 'base64');
      const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-GCM' }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        key,
        dataSource,
      );
      decrypted = new Uint8Array(plain);
    } else {
      throw new Error('decodeEventData: thiếu cipherKey hoặc dữ liệu quá ngắn');
    }
  }

  // encrypt=3 không nén; còn lại inflate (zlib) — dùng pako để khớp zca-js.
  const pako = (await import('pako')).default;
  const out = encryptType === 3 ? decrypted : pako.inflate(decrypted);
  const text = Buffer.from(out).toString('utf-8');
  if (!text) return undefined;
  const JSONBig = (await import('json-bigint')).default;
  return JSONBig.parse(text);
}
