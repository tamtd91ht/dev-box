// Nhà cung cấp STT / TTS tích hợp qua API — phía server: kho cấu hình + thực thi.
// Kiểu cấu hình và bộ thay biến: lib/speechProviders.ts. Route: /api/speech.
//
// Kho: configs/speech-providers.json (per-machine, gitignore cùng cả thư mục
// configs/ — file này CHỨA KHOÁ API). Full-file read/write như lib/docStore.
//
// Thực thi: dựng request từ template (endpoint, auth, headers, body), gọi bằng
// fetch của Node (không CORS, khoá không nằm trong trang), rồi đọc output theo
// `response`. Mọi lần gọi đều trả kèm `debug` (URL đã che khoá, status, kiểu
// nội dung, đoạn đầu phản hồi) — nút "Thử" trong màn cấu hình hiện nguyên cái
// đó để người dùng dò đường dẫn output mà không phải đoán.

import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';
import {
  PROVIDER_LIMITS, fillJson, fillString, normalizeProvider, pathToText, readPath,
  type ProviderKind, type SpeechProvider,
} from './speechProviders';

const REG_PATH = configPath('speech-providers.json');
const SAMPLE_RATE = 16_000;
/** Phản hồi chữ / JSON đọc tối đa chừng này. */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** File audio TTS nhận tối đa chừng này mỗi lần gọi. */
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

// ── Kho cấu hình ─────────────────────────────────────────────────────────────

async function readAll(): Promise<SpeechProvider[]> {
  try {
    const data = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as { providers?: SpeechProvider[] };
    return Array.isArray(data.providers) ? data.providers : [];
  } catch { return []; }
}
async function writeAll(providers: SpeechProvider[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ providers }, null, 2), 'utf8');
}

export const providersList = () => readAll();

export async function providerGet(id: unknown, kind: ProviderKind): Promise<SpeechProvider> {
  const p = (await readAll()).find((x) => x.id === id && x.kind === kind);
  if (!p) throw new Error('Không còn nhà cung cấp này (đã bị xoá?) — chọn lại nhà cung cấp.');
  return p;
}

export async function providerSave(input: unknown): Promise<SpeechProvider[]> {
  const p = normalizeProvider(input);
  const list = await readAll();
  const now = new Date().toISOString();
  if (p.id) {
    const i = list.findIndex((x) => x.id === p.id);
    if (i < 0) throw new Error('Không tìm thấy nhà cung cấp để cập nhật.');
    list[i] = { ...p, kind: list[i].kind, updatedAt: now }; // loại (STT/TTS) không đổi sau khi tạo
  } else {
    if (list.length >= PROVIDER_LIMITS.maxProviders) throw new Error(`Đã đủ ${PROVIDER_LIMITS.maxProviders} nhà cung cấp — xoá bớt trước khi thêm.`);
    list.push({ ...p, id: randomUUID(), updatedAt: now });
  }
  await writeAll(list);
  return list;
}

export async function providerRemove(id: unknown): Promise<SpeechProvider[]> {
  const list = (await readAll()).filter((x) => x.id !== id);
  await writeAll(list);
  return list;
}

// ── Dựng request ─────────────────────────────────────────────────────────────

export interface CallDebug {
  method: string;
  /** URL đã che khoá. */
  url: string;
  status: number | null;
  contentType: string;
  /** Đoạn đầu phản hồi (chữ), hoặc mô tả nếu là nhị phân. */
  body: string;
  bytes: number;
  ms: number;
}

/** PCM 16 kHz mono 16-bit → file WAV. */
function wavOf(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const isAudioVar = (v: string) => /^\{\{\s*audio\s*\}\}$/.test(v.trim());

function buildRequest(p: SpeechProvider, builtins: Record<string, string>, wav: Buffer | null): { url: string; shown: string; init: RequestInit } {
  // Biến tự đặt được dùng biến có sẵn bên trong (vd voice = "{{language}}-Standard-A").
  const vars: Record<string, string> = { ...builtins };
  for (const v of p.vars) vars[v.key] = fillString(v.value, builtins);

  // Trong URL thì giá trị biến phải được mã hoá.
  const enc = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, encodeURIComponent(v)]));
  let url = fillString(p.endpoint, enc);
  let shown = url;
  const headers = new Headers();
  const secrets: string[] = [];
  const addQuery = (u: string, k: string, v: string) => `${u}${u.includes('?') ? '&' : '?'}${encodeURIComponent(k)}=${encodeURIComponent(v)}`;

  if (p.auth.type === 'bearer' && p.auth.token) { headers.set('Authorization', `Bearer ${p.auth.token}`); secrets.push(p.auth.token); }
  else if (p.auth.type === 'header') { headers.set(p.auth.name, fillString(p.auth.value, vars)); secrets.push(p.auth.value); }
  else if (p.auth.type === 'basic') {
    headers.set('Authorization', `Basic ${Buffer.from(`${p.auth.username}:${p.auth.password}`).toString('base64')}`);
    secrets.push(p.auth.password);
  } else if (p.auth.type === 'query') {
    url = addQuery(url, p.auth.name, p.auth.value);
    shown = addQuery(shown, p.auth.name, '***');
    secrets.push(p.auth.value);
  }
  for (const h of p.headers) headers.set(h.key, fillString(h.value, vars));

  let body: BodyInit | undefined;
  const b = p.body;
  if (b.type === 'json') {
    body = fillJson(b.template, vars);
    if (!headers.has('content-type')) headers.set('Content-Type', 'application/json');
  } else if (b.type === 'raw') {
    body = fillString(b.template, vars);
    if (!headers.has('content-type')) headers.set('Content-Type', 'text/plain; charset=utf-8');
  } else if (b.type === 'urlencoded') {
    const sp = new URLSearchParams();
    // Trường ra giá trị rỗng (vd language khi "Tự nhận diện") thì bỏ hẳn.
    for (const f of b.fields) { const v = fillString(f.value, vars); if (v !== '') sp.append(f.key, v); }
    body = sp;
  } else if (b.type === 'form') {
    const fd = new FormData();
    for (const f of b.fields) {
      if (isAudioVar(f.value)) {
        if (!wav) throw new Error('Biến {{audio}} chỉ có ở nhà cung cấp STT.');
        fd.append(f.key, new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
      } else {
        const v = fillString(f.value, vars);
        if (v !== '') fd.append(f.key, v);
      }
    }
    body = fd;
    headers.delete('content-type'); // fetch tự đặt kèm boundary
  } else if (b.type === 'binary') {
    if (!wav) throw new Error('Body "File âm thanh" chỉ dùng cho STT.');
    body = new Uint8Array(wav);
    if (!headers.has('content-type')) headers.set('Content-Type', 'audio/wav');
  }
  // Che cả khoá lỡ nằm trong URL (endpoint viết sẵn ?key=…).
  for (const s of secrets) if (s && s.length >= 6) shown = shown.split(encodeURIComponent(s)).join('***').split(s).join('***');
  return { url, shown, init: { method: p.method, headers, body } };
}

// ── Gọi + đọc output ─────────────────────────────────────────────────────────

const snippet = (s: string, n = 3000) => (s.length > n ? `${s.slice(0, n)}… (còn ${s.length - n} ký tự)` : s);
const isTexty = (ct: string) => /json|text|xml|html|javascript|x-www-form-urlencoded/i.test(ct);

async function doFetch(p: SpeechProvider, builtins: Record<string, string>, wav: Buffer | null, signal?: AbortSignal) {
  const req = buildRequest(p, builtins, wav);
  const debug: CallDebug = { method: p.method, url: req.shown, status: null, contentType: '', body: '', bytes: 0, ms: 0 };
  const t0 = Date.now();
  const timeout = AbortSignal.timeout((p.timeoutSec ?? 60) * 1000);
  let res: Response;
  try {
    res = await fetch(req.url, { ...req.init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    debug.ms = Date.now() - t0;
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (signal?.aborted) throw Object.assign(new Error('Đã dừng.'), { debug });
    const why = err.name === 'TimeoutError' ? `quá ${p.timeoutSec ?? 60} giây không phản hồi`
      : err.cause?.code || err.cause?.message || err.message;
    throw Object.assign(new Error(`Không gọi được ${p.name}: ${why}`), { debug });
  }
  debug.status = res.status;
  debug.contentType = res.headers.get('content-type') ?? '';
  const buf = Buffer.from(await res.arrayBuffer());
  debug.ms = Date.now() - t0;
  debug.bytes = buf.length;
  const texty = isTexty(debug.contentType) || (!debug.contentType && buf.length < 4096);
  debug.body = texty ? snippet(buf.subarray(0, MAX_TEXT_BYTES).toString('utf8')) : `(dữ liệu nhị phân, ${buf.length.toLocaleString('vi-VN')} byte)`;
  if (!res.ok) {
    throw Object.assign(new Error(`${p.name} trả lỗi HTTP ${res.status}${texty && buf.length ? `: ${snippet(buf.toString('utf8'), 300)}` : ''}`), { debug });
  }
  return { buf, debug, texty };
}

function parseJson(buf: Buffer, p: SpeechProvider, debug: CallDebug): unknown {
  if (buf.length > MAX_TEXT_BYTES) throw Object.assign(new Error(`Phản hồi của ${p.name} lớn quá ${MAX_TEXT_BYTES / 1048576} MB.`), { debug });
  try { return JSON.parse(buf.toString('utf8')); } catch {
    throw Object.assign(new Error(`Phản hồi của ${p.name} không phải JSON — kiểm lại mục Response (đang chọn đọc theo đường dẫn JSON).`), { debug });
  }
}

/** STT qua API: PCM → chữ. Lỗi ném ra có kèm `.debug` nếu đã gọi được. */
export async function callStt(p: SpeechProvider, pcm: Buffer, language: string, signal?: AbortSignal): Promise<{ text: string; debug: CallDebug }> {
  const wav = wavOf(pcm);
  const { buf, debug } = await doFetch(p, {
    audio_base64: wav.toString('base64'),
    language: language === 'auto' ? '' : language,
    filename: 'audio.wav', mime: 'audio/wav',
    seconds: (pcm.length / 2 / SAMPLE_RATE).toFixed(2),
  }, wav, signal);
  if (p.response.type === 'text') return { text: buf.toString('utf8').trim(), debug };
  if (p.response.type !== 'json') throw Object.assign(new Error('Response của nhà cung cấp STT phải là "JSON" hoặc "Chữ thuần".'), { debug });
  const text = pathToText(readPath(parseJson(buf, p, debug), p.response.path));
  if (text === undefined) {
    throw Object.assign(new Error(`Không thấy chữ ở đường dẫn "${p.response.path}" trong phản hồi của ${p.name} — xem phản hồi và sửa đường dẫn ở mục Response.`), { debug });
  }
  return { text: text.replace(/\s+/g, ' ').trim(), debug };
}

function audioMime(cfg: string | undefined, contentType: string): string {
  if (cfg) return cfg;
  const ct = contentType.split(';')[0].trim().toLowerCase();
  return ct.startsWith('audio/') ? ct : 'audio/mpeg';
}

/** TTS qua API: một phần chữ → audio base64. */
export async function callTts(p: SpeechProvider, text: string, language: string, signal?: AbortSignal): Promise<{ mime: string; chunks: string[]; debug: CallDebug }> {
  const { buf, debug, texty } = await doFetch(p, { text, language }, null, signal);
  const r = p.response;
  if (r.type === 'audio') {
    if (texty) throw Object.assign(new Error(`${p.name} trả về chữ / JSON chứ không phải file audio — đổi mục Response sang "base64 trong JSON" hoặc "URL trong JSON".`), { debug });
    if (!buf.length) throw Object.assign(new Error(`${p.name} trả về audio rỗng.`), { debug });
    if (buf.length > MAX_AUDIO_BYTES) throw Object.assign(new Error('File audio trả về quá lớn.'), { debug });
    return { mime: audioMime(r.mime, debug.contentType), chunks: [buf.toString('base64')], debug };
  }
  if (r.type !== 'base64' && r.type !== 'url') throw Object.assign(new Error('Response của nhà cung cấp TTS phải là audio, base64 hoặc URL.'), { debug });
  const v = pathToText(readPath(parseJson(buf, p, debug), r.path));
  if (!v) {
    throw Object.assign(new Error(`Không thấy ${r.type === 'url' ? 'URL audio' : 'audio base64'} ở đường dẫn "${r.path}" trong phản hồi của ${p.name}.`), { debug });
  }
  if (r.type === 'base64') {
    const m = /^data:([^;,]+)[^,]*,(.*)$/s.exec(v.trim());
    const b64 = (m ? m[2] : v).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw Object.assign(new Error(`Giá trị ở "${r.path}" không phải base64.`), { debug });
    return { mime: r.mime ?? m?.[1] ?? 'audio/mpeg', chunks: [b64.replace(/-/g, '+').replace(/_/g, '/')], debug };
  }
  if (!/^https?:\/\//i.test(v)) throw Object.assign(new Error(`Giá trị ở "${r.path}" không phải URL: ${v.slice(0, 120)}`), { debug });
  // Có hãng trả link ngay nhưng vài giây sau file mới sẵn → thử lại vài lần.
  let last = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error('Đã dừng.'), { debug });
    if (attempt) await new Promise((res) => setTimeout(res, 1500));
    try {
      const a = await fetch(v, { signal: AbortSignal.timeout(30_000) });
      if (!a.ok) { last = `HTTP ${a.status}`; continue; }
      const ab = Buffer.from(await a.arrayBuffer());
      if (!ab.length) { last = 'file rỗng'; continue; }
      if (ab.length > MAX_AUDIO_BYTES) throw new Error('File audio quá lớn.');
      return { mime: audioMime(r.mime, a.headers.get('content-type') ?? ''), chunks: [ab.toString('base64')], debug };
    } catch (e) { last = (e as Error).message; }
  }
  throw Object.assign(new Error(`Không tải được audio từ URL ${p.name} trả về (${last}).`), { debug });
}

// ── Thử cấu hình (chưa cần lưu) ──────────────────────────────────────────────

export interface ProviderTest {
  ok: boolean;
  error: string | null;
  debug: CallDebug | null;
  /** STT: chữ đọc được. */
  text?: string;
  /** TTS: audio đọc được. */
  audio?: { mime: string; chunks: string[] };
}

export async function providerTest(body: Record<string, unknown>): Promise<ProviderTest> {
  let p: SpeechProvider;
  try { p = normalizeProvider(body.provider); } catch (e) { return { ok: false, error: (e as Error).message, debug: null }; }
  const language = typeof body.language === 'string' ? body.language : 'vi';
  try {
    if (p.kind === 'tts') {
      const text = String(body.text ?? '').trim().slice(0, p.maxChars ?? 2000);
      if (!text) return { ok: false, error: 'Nhập một câu để thử.', debug: null };
      const r = await callTts(p, text, language === 'auto' ? 'vi' : language);
      return { ok: true, error: null, debug: r.debug, audio: { mime: r.mime, chunks: r.chunks } };
    }
    const data = typeof body.pcm === 'string' ? body.pcm : '';
    if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return { ok: false, error: 'Thiếu âm thanh để thử — chọn một file ở cột STT trước.', debug: null };
    const pcm = Buffer.from(data, 'base64');
    const r = await callStt(p, pcm.subarray(0, pcm.length & ~1), language);
    return { ok: true, error: null, debug: r.debug, text: r.text };
  } catch (e) {
    return { ok: false, error: (e as Error).message, debug: (e as { debug?: CallDebug }).debug ?? null };
  }
}
