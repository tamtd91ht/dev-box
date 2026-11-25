// Nhà cung cấp STT / TTS — kiểu cấu hình + phần thuần (dùng chung client/server).
//
// Mỗi loại (STT, TTS) có MỘT nhà cung cấp mặc định có sẵn, không cần cấu hình:
//   · STT: Whisper chạy trên máy   · TTS: giọng đọc Google   (lib/speechServer.ts)
// Ngoài ra người dùng tự thêm nhà cung cấp tích hợp QUA API bằng một bản cấu
// hình ĐỘNG hoàn toàn: endpoint, authentication, headers, body, response. Không
// có dòng code nào viết riêng cho hãng nào — mọi thứ là template + đường dẫn:
//
//   · ĐƯA INPUT VÀO: endpoint / headers / body viết bằng template có biến
//     {{tên}}. Biến có sẵn theo loại (PROVIDER_VARS) + biến tự đặt (`vars`, vd
//     model, voice). Body JSON được phân tích rồi mới thay biến nên giá trị tự
//     được escape đúng; {{x|number}} / {{x|bool}} để ra số / true-false.
//   · ĐỌC OUTPUT RA: `response` nói kết quả nằm ở đâu — STT: chữ ở một đường dẫn
//     JSON (vd results[0].alternatives[0].transcript, segments[*].text), cả body,
//     hoặc URL tới file kết quả; TTS: body là file audio, hoặc base64 / URL (hay
//     tự nhận một trong hai) ở một đường dẫn JSON. Đường dẫn khai được nhiều
//     phương án ngăn bằng `|` (vd `data.url | data.link | audio`) — lấy cái đầu
//     tiên có giá trị, nên một cấu hình chịu được tên trường khác nhau.
//   · ĐỊNH DẠNG AUDIO (TTS): người dùng chọn (MP3, WAV…) hoặc để tự nhận — theo
//     đuôi file trong URL, rồi Content-Type, rồi mấy byte đầu của file. Chỉ là
//     khai báo để phát / lưu đúng, không chuyển đổi định dạng.
//   · Chỉ API đồng bộ (một lần gọi ra kết quả); kiểu job + hỏi lại chưa hỗ trợ.
//
// Thực thi (gọi HTTP) nằm ở lib/speechProviderServer.ts — phía server, nên không
// dính CORS và khoá API không nằm trong trang.

export type ProviderKind = 'stt' | 'tts';

export type ProviderAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'header'; name: string; value: string }
  | { type: 'query'; name: string; value: string }
  | { type: 'basic'; username: string; password: string };

export interface KV { key: string; value: string }

export type ProviderBody =
  | { type: 'none' }
  /** Chuỗi JSON có biến {{…}}. */
  | { type: 'json'; template: string }
  /** multipart/form-data; trường có giá trị đúng bằng {{audio}} là FILE âm thanh. */
  | { type: 'form'; fields: KV[] }
  | { type: 'urlencoded'; fields: KV[] }
  /** Body là chính file âm thanh (chỉ STT). */
  | { type: 'binary' }
  /** Chuỗi thô có biến (text/plain, XML/SSML…) — tự đặt Content-Type ở Headers. */
  | { type: 'raw'; template: string };

export type ProviderResponse =
  /** STT: chữ nằm ở `path` trong JSON trả về. */
  | { type: 'json'; path: string }
  /** STT: cả body là chữ. */
  | { type: 'text' }
  /** TTS: body là file audio. `mime` để trống = tự nhận. */
  | { type: 'audio'; mime?: string }
  /** TTS: audio dạng base64 (hoặc data: URI) ở `path` trong JSON. */
  | { type: 'base64'; path: string; mime?: string }
  /**
   * `path` trong JSON là URL tải kết quả (có hãng trả link, vài giây sau mới có file).
   * TTS: URL file audio. STT: URL file chữ (.txt) hoặc JSON — khi là JSON thì
   * chữ nằm ở `textPath` trong file đó.
   */
  | { type: 'url'; path: string; mime?: string; textPath?: string }
  /** TTS: giá trị ở `path` là URL hay base64 thì tự nhận. */
  | { type: 'auto'; path: string; mime?: string };

export interface SpeechProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  method: 'POST' | 'GET' | 'PUT';
  /** URL, có thể chứa biến (vd …?lang={{language}}). */
  endpoint: string;
  auth: ProviderAuth;
  headers: KV[];
  body: ProviderBody;
  response: ProviderResponse;
  /** Biến tự đặt dùng trong template: model, voice, speed… */
  vars: KV[];
  /** TTS: số ký tự tối đa mỗi lần gọi (văn bản dài hơn được cắt thành nhiều lần). */
  maxChars?: number;
  /** Hạn chờ một lần gọi (giây). */
  timeoutSec?: number;
  updatedAt?: string;
}

/** id của nhà cung cấp mặc định (có sẵn, không lưu trong file cấu hình). */
export const DEFAULT_PROVIDER = 'default';
export const DEFAULT_PROVIDER_NAME: Record<ProviderKind, string> = {
  stt: 'Mặc định — Whisper chạy trên máy',
  tts: 'Mặc định — giọng đọc Google',
};

/** Biến có sẵn cho template, theo loại. */
export const PROVIDER_VARS: Record<ProviderKind, { name: string; hint: string }[]> = {
  stt: [
    { name: 'audio', hint: 'file âm thanh WAV 16 kHz mono — chỉ dùng làm giá trị một trường của body "Form"' },
    { name: 'audio_base64', hint: 'cùng file đó, dạng base64' },
    { name: 'language', hint: 'mã ngôn ngữ đang chọn (vi, en…); rỗng khi chọn "Tự nhận diện"' },
    { name: 'filename', hint: 'audio.wav' },
    { name: 'mime', hint: 'audio/wav' },
    { name: 'seconds', hint: 'độ dài âm thanh (giây)' },
  ],
  tts: [
    { name: 'text', hint: 'đoạn chữ cần đọc của lần gọi này' },
    { name: 'language', hint: 'mã ngôn ngữ đọc (vi, en, zh-CN…)' },
  ],
};

export const PROVIDER_LIMITS = { maxProviders: 30, maxName: 60, maxTemplate: 20_000, maxRows: 40 };

// ── Template ─────────────────────────────────────────────────────────────────

const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?:\|\s*(number|bool|json))?\s*\}\}/g;

/** Tên các biến một template dùng tới. */
export function templateVars(tpl: string): string[] {
  const out = new Set<string>();
  for (const m of tpl.matchAll(VAR_RE)) out.add(m[1]);
  return [...out];
}

/** Thay biến trong một chuỗi (biến lạ → chuỗi rỗng). */
export function fillString(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(VAR_RE, (_m, name: string) => vars[name] ?? '');
}

/** Một giá trị chuỗi trong JSON: nếu CẢ chuỗi là một biến có ép kiểu thì trả đúng kiểu đó. */
function fillJsonString(s: string, vars: Record<string, string>): unknown {
  const whole = /^\{\{\s*([A-Za-z_][\w.-]*)\s*\|\s*(number|bool|json)\s*\}\}$/.exec(s);
  if (!whole) return fillString(s, vars);
  const raw = vars[whole[1]] ?? '';
  if (whole[2] === 'number') { const n = Number(raw); return Number.isFinite(n) && raw.trim() !== '' ? n : null; }
  if (whole[2] === 'bool') return /^(1|true|yes|on)$/i.test(raw.trim());
  try { return JSON.parse(raw); } catch { return raw; }
}

function walk(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === 'string') return fillJsonString(v, vars);
  if (Array.isArray(v)) return v.map((x) => walk(x, vars));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [fillString(k, vars), walk(x, vars)]));
  }
  return v;
}

/**
 * Template JSON → chuỗi JSON đã thay biến. Phân tích TRƯỚC rồi mới thay nên
 * dấu nháy / xuống dòng trong giá trị (vd chữ cần đọc) không làm vỡ JSON.
 * Ném Error nếu template không phải JSON hợp lệ.
 */
export function fillJson(tpl: string, vars: Record<string, string>): string {
  let parsed: unknown;
  try { parsed = JSON.parse(tpl); } catch (e) {
    throw new Error(`Body JSON không hợp lệ: ${(e as Error).message}`);
  }
  return JSON.stringify(walk(parsed, vars));
}

// ── Đọc output theo đường dẫn ────────────────────────────────────────────────

/**
 * Lấy giá trị ở `path` trong một JSON. Cú pháp: a.b[0].c · ["khoá có dấu chấm"]
 * · [*] = mọi phần tử (kết quả được nối lại). Đường dẫn rỗng = cả object.
 * Trả undefined nếu không tới được.
 */
export function readPath(data: unknown, path: string): unknown {
  const tokens: (string | number | '*')[] = [];
  const re = /\[(\*|\d+|"[^"]*"|'[^']*')\]|([^.[\]]+)/g;
  for (const m of path.trim().matchAll(re)) {
    if (m[2] !== undefined) tokens.push(m[2]);
    else if (m[1] === '*') tokens.push('*');
    else if (/^\d+$/.test(m[1])) tokens.push(Number(m[1]));
    else tokens.push(m[1].slice(1, -1));
  }
  const step = (cur: unknown, i: number): unknown => {
    if (i >= tokens.length) return cur;
    const t = tokens[i];
    if (cur === null || cur === undefined) return undefined;
    if (t === '*') {
      if (!Array.isArray(cur)) return undefined;
      return cur.map((x) => step(x, i + 1)).filter((x) => x !== undefined);
    }
    if (typeof t === 'number') return Array.isArray(cur) ? step(cur[t], i + 1) : undefined;
    return typeof cur === 'object' ? step((cur as Record<string, unknown>)[t], i + 1) : undefined;
  };
  return step(data, 0);
}

/** Kết quả readPath → chữ (mảng thì nối bằng dấu cách). undefined nếu không có gì. */
export function pathToText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.flat(Infinity).map((x) => pathToText(x)).filter((x): x is string => !!x);
    return parts.length ? parts.join(' ') : undefined;
  }
  return undefined;
}

/**
 * Tách khai báo nhiều đường dẫn: `data.url | data.link | audio`. Dấu `|` nằm
 * trong ["…"] / ['…'] không tính là dấu ngăn.
 */
export function splitPaths(spec: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of spec) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '|') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Thử lần lượt từng đường dẫn, trả giá trị (dạng chữ) đầu tiên không rỗng +
 * đường dẫn khớp. Không có cái nào khác rỗng nhưng có trường tồn tại mà rỗng
 * (vd STT trả "" khi im lặng) thì trả cái rỗng đó; không tới được đâu = undefined.
 */
export function readFirst(data: unknown, spec: string): { value: string; path: string } | undefined {
  let empty: { value: string; path: string } | undefined;
  for (const path of splitPaths(spec)) {
    const v = pathToText(readPath(data, path));
    if (v === undefined) continue;
    if (v.trim() !== '') return { value: v, path };
    empty ??= { value: v, path };
  }
  return empty;
}

// ── Định dạng audio ──────────────────────────────────────────────────────────

/** Định dạng người dùng chọn được cho audio TTS. */
export const AUDIO_FORMATS: { mime: string; ext: string; label: string }[] = [
  { mime: 'audio/mpeg', ext: 'mp3', label: 'MP3' },
  { mime: 'audio/wav', ext: 'wav', label: 'WAV' },
  { mime: 'audio/ogg', ext: 'ogg', label: 'OGG / Opus' },
  { mime: 'audio/mp4', ext: 'm4a', label: 'M4A (mp4)' },
  { mime: 'audio/aac', ext: 'aac', label: 'AAC' },
  { mime: 'audio/flac', ext: 'flac', label: 'FLAC' },
  { mime: 'audio/webm', ext: 'webm', label: 'WebM' },
];

const EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', mpga: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm',
};

/** Đuôi file trong một URL / tên file → mime audio; undefined nếu không nhận ra. */
export function mimeFromExt(urlOrName: string): string | undefined {
  let p: string;
  try { p = new URL(urlOrName).pathname; } catch { p = urlOrName.split(/[?#]/)[0]; }
  const m = /\.([a-z0-9]{2,5})$/i.exec(p);
  return m ? EXT_MIME[m[1].toLowerCase()] : undefined;
}

/** Mime → đuôi file để lưu. */
export function extOfMime(mime: string): string {
  const m = mime.split(';')[0].trim().toLowerCase();
  const hit = AUDIO_FORMATS.find((f) => f.mime === m);
  if (hit) return hit.ext;
  if (/wav/.test(m)) return 'wav';
  if (/ogg|opus/.test(m)) return 'ogg';
  if (/mp4|m4a/.test(m)) return 'm4a';
  if (/aac/.test(m)) return 'aac';
  if (/flac/.test(m)) return 'flac';
  if (/webm/.test(m)) return 'webm';
  return 'mp3';
}

/** Nhận dạng định dạng audio qua mấy byte đầu; undefined nếu không chắc. */
export function sniffAudio(b: Uint8Array): string | undefined {
  const at = (i: number, s: string) => [...s].every((c, j) => b[i + j] === c.charCodeAt(0));
  if (b.length < 12) return undefined;
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, 'fLaC')) return 'audio/flac';
  if (at(4, 'ftyp')) return 'audio/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (at(0, 'ID3')) return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio/aac'; // ADTS
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) return 'audio/mpeg';
  return undefined;
}

// ── Kiểm cấu hình + mẫu điền sẵn ─────────────────────────────────────────────

const cleanKV = (rows: unknown): KV[] => (Array.isArray(rows) ? rows : [])
  .slice(0, PROVIDER_LIMITS.maxRows)
  .map((r) => ({ key: String((r as KV)?.key ?? '').trim(), value: String((r as KV)?.value ?? '') }))
  .filter((r) => r.key);

const str = (v: unknown, max = PROVIDER_LIMITS.maxTemplate) => String(v ?? '').slice(0, max);

/** Chuẩn hoá + kiểm một bản cấu hình từ client. Ném Error (thông báo cho người dùng). */
export function normalizeProvider(input: unknown): SpeechProvider {
  const p = (input ?? {}) as Partial<SpeechProvider>;
  const kind: ProviderKind = p.kind === 'tts' ? 'tts' : 'stt';
  const name = str(p.name, PROVIDER_LIMITS.maxName).replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Thiếu tên nhà cung cấp.');
  const endpoint = str(p.endpoint, 2000).trim();
  if (!/^https?:\/\/\S+$/i.test(endpoint)) throw new Error('Endpoint phải là URL http(s)://… (có thể chứa biến {{…}}).');
  const method = p.method === 'GET' || p.method === 'PUT' ? p.method : 'POST';

  const a = (p.auth ?? { type: 'none' }) as ProviderAuth;
  let auth: ProviderAuth = { type: 'none' };
  if (a.type === 'bearer') auth = { type: 'bearer', token: str(a.token, 4000).trim() };
  else if (a.type === 'header') auth = { type: 'header', name: str(a.name, 200).trim(), value: str(a.value, 4000) };
  else if (a.type === 'query') auth = { type: 'query', name: str(a.name, 200).trim(), value: str(a.value, 4000) };
  else if (a.type === 'basic') auth = { type: 'basic', username: str(a.username, 400), password: str(a.password, 4000) };
  if ((auth.type === 'header' || auth.type === 'query') && !auth.name) throw new Error('Authentication: thiếu tên header / tham số.');

  const b = (p.body ?? { type: 'none' }) as ProviderBody;
  let body: ProviderBody = { type: 'none' };
  if (b.type === 'json') {
    body = { type: 'json', template: str(b.template) };
    try { JSON.parse(body.template); } catch (e) { throw new Error(`Body JSON không hợp lệ: ${(e as Error).message}`); }
  } else if (b.type === 'form') body = { type: 'form', fields: cleanKV(b.fields) };
  else if (b.type === 'urlencoded') body = { type: 'urlencoded', fields: cleanKV(b.fields) };
  else if (b.type === 'raw') body = { type: 'raw', template: str(b.template) };
  else if (b.type === 'binary') {
    if (kind !== 'stt') throw new Error('Body "File âm thanh" chỉ dùng cho STT.');
    body = { type: 'binary' };
  }
  if (method === 'GET' && body.type !== 'none') throw new Error('Method GET không gửi body — chọn POST hoặc đặt Body là "Không có".');

  const r = (p.response ?? {}) as ProviderResponse;
  const pathOf = (v: unknown) => splitPaths(str(v, 600)).join(' | ');
  const mime = str((r as { mime?: string }).mime, 80).trim().toLowerCase() || undefined;
  let response: ProviderResponse;
  if (kind === 'stt') {
    if (r.type === 'text') response = { type: 'text' };
    else if (r.type === 'url') {
      const path = pathOf(r.path);
      if (!path) throw new Error('Response: thiếu đường dẫn tới URL file kết quả (vd data.url).');
      const textPath = pathOf(r.textPath);
      response = { type: 'url', path, ...(textPath ? { textPath } : {}) };
    } else {
      response = { type: 'json', path: pathOf((r as { path?: string }).path) };
      if (!response.path) throw new Error('Response: thiếu đường dẫn tới chữ nhận dạng (vd text).');
    }
  } else if (r.type === 'base64' || r.type === 'url' || r.type === 'auto') {
    const path = pathOf(r.path);
    if (!path) {
      const what = r.type === 'url' ? 'URL audio' : r.type === 'base64' ? 'audio base64' : 'URL / base64 audio';
      throw new Error(`Response: thiếu đường dẫn tới ${what} (vd data.url).`);
    }
    response = { type: r.type, path, mime };
  } else response = { type: 'audio', mime };

  const maxChars = Math.min(20_000, Math.max(100, Math.round(Number(p.maxChars) || 2000)));
  const timeoutSec = Math.min(600, Math.max(5, Math.round(Number(p.timeoutSec) || (kind === 'stt' ? 180 : 60))));
  return {
    id: str(p.id, 80), kind, name, method, endpoint, auth, headers: cleanKV(p.headers), body, response,
    vars: cleanKV(p.vars), ...(kind === 'tts' ? { maxChars } : {}), timeoutSec,
  };
}

/** Bản cấu hình trống để bắt đầu. */
export function blankProvider(kind: ProviderKind): SpeechProvider {
  return {
    id: '', kind, name: '', method: 'POST', endpoint: '', auth: { type: 'bearer', token: '' }, headers: [],
    body: kind === 'stt' ? { type: 'form', fields: [{ key: 'file', value: '{{audio}}' }] } : { type: 'json', template: '{\n  "text": "{{text}}"\n}' },
    response: kind === 'stt' ? { type: 'json', path: 'text' } : { type: 'audio' },
    vars: [], ...(kind === 'tts' ? { maxChars: 2000 } : {}), timeoutSec: kind === 'stt' ? 180 : 60,
  };
}

/** Mẫu điền sẵn cho các API theo chuẩn OpenAI (OpenAI, Groq, máy chủ tự dựng tương thích…). */
export const PROVIDER_PRESETS: { id: string; label: string; make: () => SpeechProvider }[] = [
  {
    id: 'openai-stt',
    label: 'STT kiểu OpenAI (/v1/audio/transcriptions)',
    make: () => ({
      ...blankProvider('stt'),
      name: 'OpenAI-compatible STT',
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
      body: { type: 'form', fields: [
        { key: 'file', value: '{{audio}}' },
        { key: 'model', value: '{{model}}' },
        { key: 'language', value: '{{language}}' },
        { key: 'response_format', value: 'json' },
      ] },
      response: { type: 'json', path: 'text' },
      vars: [{ key: 'model', value: 'whisper-1' }],
    }),
  },
  {
    id: 'openai-tts',
    label: 'TTS kiểu OpenAI (/v1/audio/speech)',
    make: () => ({
      ...blankProvider('tts'),
      name: 'OpenAI-compatible TTS',
      endpoint: 'https://api.openai.com/v1/audio/speech',
      body: { type: 'json', template: '{\n  "model": "{{model}}",\n  "input": "{{text}}",\n  "voice": "{{voice}}",\n  "response_format": "mp3"\n}' },
      response: { type: 'audio', mime: 'audio/mpeg' },
      vars: [{ key: 'model', value: 'tts-1' }, { key: 'voice', value: 'alloy' }],
      maxChars: 4000,
    }),
  },
  {
    id: 'json-link-tts',
    label: 'TTS trả JSON chứa link / base64 audio (vd OMI AI)',
    make: () => ({
      ...blankProvider('tts'),
      name: 'OMI AI TTS',
      endpoint: 'https://your-tts-host/text-to-speech/v1',
      auth: { type: 'header', name: 'apikey', value: '' },
      body: { type: 'json', template: JSON.stringify({
        config: { speed: '{{speed|number}}', speech_emotion: '{{emotion}}' },
        model_id: '{{model}}',
        text: '{{text}}',
        voice_id: '{{voice}}',
      }, null, 2) },
      response: { type: 'auto', path: 'data.url | data.link | url' },
      vars: [
        { key: 'model', value: 'tts-standard' },
        { key: 'voice', value: 'northern_female_ngocanh' },
        { key: 'speed', value: '1.0' },
        { key: 'emotion', value: 'neutral' },
      ],
    }),
  },
];
