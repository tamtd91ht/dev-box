// STT & TTS — phía server (app/api/speech/route.ts).
//
// ── STT (âm thanh → chữ): Whisper chạy NGAY TRÊN MÁY ─────────────────────────
// Dùng @huggingface/transformers (onnxruntime-node, CPU). Miễn phí, không cần
// key, âm thanh không rời máy. Model tải từ huggingface.co ở lần dùng đầu rồi
// nằm trong data/models/ (đã gitignore).
//
// Whisper KHÔNG chạy trong server này mà trong một TIẾN TRÌNH CON
// (scripts/stt-worker.cjs): onnxruntime-node suy luận đồng bộ trên luồng JS,
// chạy tại chỗ thì cả app đứng hình suốt lúc nhận dạng. File này chỉ giữ hàng
// đợi + trạng thái job và chuyển việc cho tiến trình con qua IPC.
//
// Âm thanh do RENDERER giải mã (WebAudio đọc được mp3/wav/m4a/webm… mà không
// cần ffmpeg) thành PCM 16 kHz mono 16-bit rồi gửi lên theo từng khúc nhỏ —
// body qua cầu apiFetch là chuỗi JSON, gửi một cục vài chục MB thì dễ nghẹn.
// Nhận dạng chạy lâu hơn hạn 120s của cầu nên làm kiểu job + poll (như trợ lý).
// Mỗi lúc chỉ chạy MỘT job (CPU); job khác xếp hàng. Dừng = kill tiến trình con
// (dừng ngay kể cả giữa một đoạn 30 giây, và trả RAM của model).
//
// ── NHÀ CUNG CẤP ─────────────────────────────────────────────────────────────
// Hai thứ trên là nhà cung cấp MẶC ĐỊNH. Người dùng có thể thêm nhà cung cấp
// tích hợp qua API (cấu hình động — lib/speechProviders.ts); khi một job / lượt
// đọc mang `provider` khác 'default' thì việc được chuyển cho
// lib/speechProviderServer.ts (gọi HTTP, không dùng Whisper / Google ở đây).
//
// ── TTS (chữ → âm thanh): Google translate_tts ───────────────────────────────
// Cùng nguồn với nút 🔊 của Dịch nhanh (lib/translateServer.ts): server tải về
// (thẻ <audio> gửi Referer localhost thì Google trả 404) rồi trả MP3 base64.
// Mỗi request Google đọc ~200 ký tự; ở đây một lượt gọi nhận tối đa TTS_PART
// ký tự, client tự cắt văn bản dài thành nhiều lượt và phát nối tiếp.
// LƯU Ý: chữ cần đọc được gửi tới Google.

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { STT_DEFAULT_MODEL, STT_LANGS, STT_LIMITS, STT_MODELS, TTS_PART, type SttPoll, type SttStatus } from './speech';
import { DEFAULT_PROVIDER } from './speechProviders';
import { callStt, callTts, providerGet } from './speechProviderServer';

const SAMPLE_RATE = 16_000;
const MODEL_DIR = path.join(process.cwd(), 'data', 'models');
const WORKER = path.join(process.cwd(), 'scripts', 'stt-worker.cjs');
const KEEP_DONE_MS = 10 * 60_000;

interface Job {
  id: string;
  /** id nhà cung cấp API; null = mặc định (Whisper trên máy). */
  provider: string | null;
  /** Để huỷ lượt gọi API đang chờ. */
  abort: AbortController | null;
  model: string;
  language: string;
  chunks: Buffer[];
  bytes: number;
  status: SttPoll['status'];
  /** 0..1 — phần âm thanh đã nhận dạng xong. */
  progress: number;
  /** % tải model (chỉ có ở lần đầu dùng model đó). */
  loadPct: number | null;
  text: string;
  error: string | null;
  seconds: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

type WorkerMsg =
  | { type: 'status'; id: string; status: 'loading' | 'running'; loadPct: number | null }
  | { type: 'progress'; id: string; progress: number; text: string }
  | { type: 'done'; id: string; text: string }
  | { type: 'error'; id: string; error: string };

interface Store {
  jobs: Map<string, Job>;
  /** Hàng đợi tuần tự: mỗi job nối vào đuôi promise này. */
  tail: Promise<void>;
  child: ChildProcess | null;
  /** Job đang nằm trong tiến trình con + hàm báo "xong" cho hàng đợi. */
  current: { job: Job; settle: () => void } | null;
}

const g = globalThis as typeof globalThis & { __speechStore?: Store };
const store = (): Store => (g.__speechStore ??= { jobs: new Map(), tail: Promise.resolve(), child: null, current: null });

const modelCached = (id: string) =>
  existsSync(path.join(MODEL_DIR, ...id.split('/'), 'onnx', 'decoder_model_merged_quantized.onnx'))
  && existsSync(path.join(MODEL_DIR, ...id.split('/'), 'onnx', 'encoder_model_quantized.onnx'));

function sweep(): void {
  const now = Date.now();
  for (const [id, j] of store().jobs) {
    const stale = j.endedAt ? now - j.endedAt > KEEP_DONE_MS : j.status === 'uploading' && now - j.createdAt > KEEP_DONE_MS;
    if (stale) store().jobs.delete(id);
  }
}

// ── API cho route ────────────────────────────────────────────────────────────

export function sttStatus(): SttStatus {
  return {
    models: STT_MODELS.map((m) => ({ ...m, cached: modelCached(m.id) })),
    busy: store().current !== null,
  };
}

export function sttStart(body: Record<string, unknown>): { id: string } {
  const provider = typeof body.provider === 'string' && body.provider && body.provider !== DEFAULT_PROVIDER ? body.provider : null;
  // Model Whisper chỉ có nghĩa với nhà cung cấp mặc định.
  const model = provider ? STT_DEFAULT_MODEL : STT_MODELS.find((m) => m.id === body.model)?.id;
  if (!model) throw new Error(`model: ${STT_MODELS.map((m) => m.id).join(' | ')}`);
  const language = STT_LANGS.find((l) => l.id === body.language)?.id;
  if (!language) throw new Error(`language: ${STT_LANGS.map((l) => l.id).join(' | ')}`);
  sweep();
  const job: Job = {
    id: `stt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    provider, abort: null, model, language, chunks: [], bytes: 0, status: 'uploading', progress: 0, loadPct: null,
    text: '', error: null, seconds: 0, createdAt: Date.now(), startedAt: null, endedAt: null,
  };
  store().jobs.set(job.id, job);
  return { id: job.id };
}

function need(id: unknown): Job {
  const job = typeof id === 'string' ? store().jobs.get(id) : undefined;
  if (!job) throw new Error('Không còn lượt nhận dạng này (server vừa khởi động lại?) — thử lại giúp.');
  return job;
}

/** Nhận thêm một khúc PCM 16-bit (base64). */
export function sttAppend(id: unknown, data: unknown): { bytes: number } {
  const job = need(id);
  if (job.status !== 'uploading') throw new Error('Lượt này đã bắt đầu chạy, không nhận thêm âm thanh.');
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Dữ liệu âm thanh không hợp lệ.');
  const buf = Buffer.from(data, 'base64');
  if (buf.length % 2) throw new Error('Khúc PCM phải có số byte chẵn (16-bit).');
  const max = STT_LIMITS.maxSeconds * SAMPLE_RATE * 2;
  if (job.bytes + buf.length > max) {
    store().jobs.delete(job.id);
    throw new Error(`Âm thanh dài quá ${Math.round(STT_LIMITS.maxSeconds / 60)} phút — cắt bớt rồi thử lại.`);
  }
  job.chunks.push(buf);
  job.bytes += buf.length;
  return { bytes: job.bytes };
}

/** Đã gửi đủ âm thanh → xếp hàng chạy. */
export function sttRun(id: unknown): { ok: true } {
  const job = need(id);
  if (job.status !== 'uploading') return { ok: true };
  if (job.bytes < SAMPLE_RATE * 2 * 0.3) throw new Error('Âm thanh quá ngắn (dưới 0,3 giây).');
  job.seconds = job.bytes / 2 / SAMPLE_RATE;
  if (job.provider) {
    // Gọi API chỉ là chờ mạng → không cần xếp hàng sau Whisper.
    void runApiJob(job);
    return { ok: true };
  }
  job.status = 'queued';
  const s = store();
  s.tail = s.tail.then(() => runJob(job)).catch(() => {});
  return { ok: true };
}

export function sttPoll(id: unknown): SttPoll {
  const j = need(id);
  return {
    status: j.status, progress: j.progress, loadPct: j.loadPct, text: j.text, error: j.error,
    seconds: j.seconds, elapsedMs: j.startedAt ? (j.endedAt ?? Date.now()) - j.startedAt : 0,
  };
}

export function sttCancel(id: unknown): void {
  const s = store();
  const job = typeof id === 'string' ? s.jobs.get(id) : undefined;
  if (!job || job.endedAt) return;
  finish(job, 'cancelled', null);
  job.abort?.abort();
  // Đang chạy trong tiến trình con → kill luôn: suy luận là đồng bộ, không có
  // cách nào chen ngang giữa một đoạn. Lần sau sẽ fork tiến trình mới.
  if (s.current?.job === job) killWorker();
}

// ── Job qua nhà cung cấp API ─────────────────────────────────────────────────

async function runApiJob(job: Job): Promise<void> {
  job.startedAt = Date.now();
  job.status = 'running';
  const pcm = Buffer.concat(job.chunks);
  job.chunks = [];
  job.abort = new AbortController();
  try {
    const p = await providerGet(job.provider, 'stt');
    const r = await callStt(p, pcm, job.language, job.abort.signal);
    job.text = r.text;
    job.progress = 1;
    finish(job, 'done', null);
  } catch (e) {
    finish(job, 'error', (e as Error).message); // đã bị huỷ thì finish() bỏ qua
  } finally {
    job.abort = null;
  }
}

// ── Tiến trình con ───────────────────────────────────────────────────────────

function finish(job: Job, status: Job['status'], error: string | null): void {
  if (job.endedAt) return;
  job.status = status;
  job.error = error;
  job.endedAt = Date.now();
  job.chunks = [];
}

function killWorker(): void {
  const s = store();
  const child = s.child;
  s.child = null;
  if (child && child.exitCode === null) { try { child.kill(); } catch { /* đã thoát */ } }
  // 'exit' của child sẽ settle job đang chạy; phòng khi không bắn thì settle luôn.
  const cur = s.current;
  if (cur) { s.current = null; cur.settle(); }
}

function onMessage(m: WorkerMsg): void {
  const cur = store().current;
  if (!cur || cur.job.id !== m.id || cur.job.endedAt) return;
  const job = cur.job;
  if (m.type === 'status') { job.status = m.status; job.loadPct = m.loadPct; return; }
  if (m.type === 'progress') { job.progress = m.progress; job.text = m.text; return; }
  if (m.type === 'done') { job.text = m.text; job.progress = 1; finish(job, 'done', null); }
  else {
    finish(job, 'error', /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(m.error)
      ? `Không tải được model nhận dạng (cần mạng ở lần đầu): ${m.error}`
      : `Nhận dạng lỗi: ${m.error}`);
  }
  store().current = null;
  cur.settle();
}

function worker(): ChildProcess {
  const s = store();
  if (s.child && s.child.connected && s.child.exitCode === null) return s.child;
  // Server của bản desktop chạy bằng Electron-làm-Node (process.execPath là
  // electron.exe) → tiến trình con cũng phải mang ELECTRON_RUN_AS_NODE, không
  // thì nó mở ra một cửa sổ app thay vì chạy script.
  const child = fork(WORKER, [], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-600); });
  child.on('message', (m) => onMessage(m as WorkerMsg));
  const gone = (why: string) => {
    const cur = store();
    if (cur.child === child) cur.child = null;
    const running = cur.current;
    if (!running) return;
    cur.current = null;
    finish(running.job, 'error', `Tiến trình nhận dạng dừng đột ngột (${why})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
    running.settle();
  };
  child.on('error', (e) => gone(e.message));
  child.on('exit', (code, signal) => gone(signal ? `tín hiệu ${signal}` : `mã ${code}`));
  s.child = child;
  return child;
}

function runJob(job: Job): Promise<void> {
  if (job.endedAt) return Promise.resolve(); // đã bị huỷ lúc còn xếp hàng
  const s = store();
  job.startedAt = Date.now();
  job.status = 'loading';
  const pcm = Buffer.concat(job.chunks);
  job.chunks = [];
  return new Promise<void>((resolve) => {
    s.current = { job, settle: resolve };
    try {
      worker().send({
        type: 'run', id: job.id, model: job.model, language: job.language, pcm,
        modelDir: MODEL_DIR, downloading: !modelCached(job.model),
      }, (err) => {
        if (!err || store().current?.job !== job) return;
        store().current = null;
        finish(job, 'error', `Không gửi được âm thanh cho tiến trình nhận dạng: ${err.message}`);
        resolve();
      });
    } catch (e) {
      s.current = null;
      finish(job, 'error', `Không khởi động được tiến trình nhận dạng: ${(e as Error).message}`);
      resolve();
    }
  });
}

// ── TTS ──────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TTS_CHUNK = 190;

/** Cắt theo câu → dấu phẩy → khoảng trắng để mỗi mẩu vừa một request Google. */
function ttsChunks(text: string): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trim();
  while (rest) {
    if (rest.length <= TTS_CHUNK) { out.push(rest); break; }
    const head = rest.slice(0, TTS_CHUNK);
    let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('。'));
    if (cut < 60) cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf('，'));
    if (cut < 60) cut = head.lastIndexOf(' ');
    if (cut < 20) cut = TTS_CHUNK - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  return out.filter(Boolean);
}

async function ttsOne(part: string, lang: string, idx: number, total: number): Promise<string> {
  const url = `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=${encodeURIComponent(lang)}`
    + `&total=${total}&idx=${idx}&textlen=${part.length}&q=${encodeURIComponent(part)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Google đọc lỗi HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Một phần văn bản (≤ TTS_PART ký tự) → các mẩu MP3 base64, phát lần lượt. */
export async function tts(textRaw: unknown, langRaw: unknown, providerRaw?: unknown): Promise<{ mime: string; chunks: string[] }> {
  const text = String(textRaw ?? '').trim();
  if (!text) throw new Error('Không có gì để đọc.');
  if (typeof providerRaw === 'string' && providerRaw && providerRaw !== DEFAULT_PROVIDER) {
    const p = await providerGet(providerRaw, 'tts');
    if (text.length > (p.maxChars ?? 2000) + 200) throw new Error(`Mỗi lượt đọc của ${p.name} tối đa ${p.maxChars ?? 2000} ký tự.`);
    const r = await callTts(p, text, String(langRaw ?? 'vi'));
    return { mime: r.mime, chunks: r.chunks };
  }
  if (text.length > TTS_PART + 200) throw new Error(`Mỗi lượt đọc tối đa ${TTS_PART} ký tự.`);
  const lang = String(langRaw ?? '');
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) throw new Error(`Mã ngôn ngữ đọc không hợp lệ: "${lang}"`);
  const parts = ttsChunks(text);
  const chunks: string[] = new Array(parts.length);
  // 4 request song song — đủ nhanh mà không dội Google.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, parts.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= parts.length) return;
      chunks[i] = await ttsOne(parts[i], lang, i, parts.length);
    }
  }));
  return { mime: 'audio/mpeg', chunks };
}
