// STT & TTS — kiểu/hằng số dùng chung và phần chạy ở trình duyệt.
// Server: lib/speechServer.ts (Whisper trên máy + Google TTS). Route: /api/speech.
// Dùng ở: components/SpeechPanel.tsx (tab Tools › Giọng nói) và
// components/AiChat.tsx (nút micro + nút đọc câu trả lời).

import { apiFetch } from './apiFetch';

// ── Dùng chung client/server ─────────────────────────────────────────────────

export const STT_MODELS: { id: string; label: string; hint: string; sizeMb: number }[] = [
  { id: 'Xenova/whisper-small', label: 'Chính xác', hint: 'Whisper small — tiếng Việt khá, chậm hơn', sizeMb: 240 },
  { id: 'Xenova/whisper-base', label: 'Nhanh', hint: 'Whisper base — nhanh gấp ~3 lần, hay sai dấu và từ hiếm', sizeMb: 77 },
];
export const STT_DEFAULT_MODEL = STT_MODELS[0].id;

/** `id` là mã Whisper nhận; 'auto' = để model tự đoán (chậm hơn một chút, dễ nhầm với đoạn ngắn). */
export const STT_LANGS: { id: string; label: string }[] = [
  { id: 'vi', label: 'Tiếng Việt' },
  { id: 'en', label: 'English' },
  { id: 'auto', label: 'Tự nhận diện' },
  { id: 'zh', label: '中文' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'th', label: 'ไทย' },
];

export const TTS_LANGS: { id: string; label: string }[] = [
  { id: 'auto', label: 'Tự nhận diện' },
  { id: 'vi', label: 'Tiếng Việt' },
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '中文' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'th', label: 'ไทย' },
];

export const STT_LIMITS = {
  /** Âm thanh dài nhất nhận dạng một lượt. */
  maxSeconds: 30 * 60,
  /** File lớn hơn mức này không mở (giải mã trong trình duyệt tốn RAM gấp nhiều lần). */
  maxFileBytes: 300 * 1024 * 1024,
};
/** Số ký tự một lượt gọi TTS; văn bản dài hơn thì client cắt thành nhiều lượt. */
export const TTS_PART = 1500;
/** Văn bản dài nhất đọc / xuất file một lần. */
export const TTS_MAX_CHARS = 30_000;

export interface SttStatus {
  models: { id: string; label: string; hint: string; sizeMb: number; cached: boolean }[];
  busy: boolean;
}

export interface SttPoll {
  status: 'uploading' | 'queued' | 'loading' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  /** % tải model (lần đầu dùng); null khi không tải. */
  loadPct: number | null;
  /** Chữ đã nhận dạng tới lúc này. */
  text: string;
  error: string | null;
  /** Độ dài âm thanh (giây). */
  seconds: number;
  elapsedMs: number;
}

// ── Gọi API ──────────────────────────────────────────────────────────────────

async function call<T>(action: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const r = await apiFetch('/api/speech', { method: 'POST', body: JSON.stringify({ action, ...params }), timeoutMs });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: T };
  if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
  return data.result as T;
}

export const sttStatus = () => call<SttStatus>('stt.status');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── STT: giải mã âm thanh trong trình duyệt ──────────────────────────────────

const SAMPLE_RATE = 16_000;

/**
 * File / bản ghi âm bất kỳ (mp3, wav, m4a, ogg, webm, mp4…) → PCM 16 kHz mono
 * 16-bit. AudioContext tạo ở 16 kHz nên decodeAudioData tự hạ tần số lấy mẫu —
 * đỡ phải giữ bản giải mã 44,1/48 kHz khổng lồ trong RAM.
 */
export async function decodeToPcm16k(blob: Blob): Promise<Int16Array> {
  if (blob.size > STT_LIMITS.maxFileBytes) {
    throw new Error(`File nặng ${(blob.size / 1048576).toFixed(0)} MB — quá ${Math.round(STT_LIMITS.maxFileBytes / 1048576)} MB.`);
  }
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    let buf: AudioBuffer;
    try {
      buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      throw new Error('Không đọc được âm thanh trong file này (định dạng không hỗ trợ hoặc file hỏng).');
    }
    if (buf.duration > STT_LIMITS.maxSeconds) {
      throw new Error(`Âm thanh dài ${Math.round(buf.duration / 60)} phút — tối đa ${Math.round(STT_LIMITS.maxSeconds / 60)} phút mỗi lượt.`);
    }
    const n = buf.length;
    const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const ch of chans) v += ch[i];
      v /= chans.length;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    return out;
  } finally {
    void ctx.close().catch(() => {});
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) s += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(s);
}

export interface TranscribeOptions {
  model: string;
  language: string;
  /** Gọi mỗi nhịp poll (và trong lúc gửi âm thanh lên, với status 'uploading'). */
  onUpdate?: (p: SttPoll) => void;
  signal?: AbortSignal;
}

/** PCM → chữ. Ném Error khi lỗi; huỷ qua `signal` thì ném Error('Đã dừng.'). */
export async function transcribe(pcm: Int16Array, opts: TranscribeOptions): Promise<SttPoll> {
  const seconds = pcm.length / SAMPLE_RATE;
  const { id } = await call<{ id: string }>('stt.start', { model: opts.model, language: opts.language });
  const cancel = () => { void call('stt.cancel', { id }).catch(() => {}); };
  const aborted = () => opts.signal?.aborted === true;
  try {
    // ~1,5 MB PCM mỗi khúc (≈ 2 MB base64) — nhỏ đủ để đi qua cầu IPC êm.
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const STEP = 1_500_000;
    for (let off = 0; off < bytes.length; off += STEP) {
      if (aborted()) throw new Error('Đã dừng.');
      await call('stt.append', { id, data: toBase64(bytes.subarray(off, off + STEP)) }, 60_000);
      opts.onUpdate?.({
        status: 'uploading', progress: Math.min(1, (off + STEP) / bytes.length), loadPct: null,
        text: '', error: null, seconds, elapsedMs: 0,
      });
    }
    await call('stt.run', { id });
    for (;;) {
      if (aborted()) throw new Error('Đã dừng.');
      const p = await call<SttPoll>('stt.poll', { id });
      opts.onUpdate?.(p);
      if (p.status === 'done') return p;
      if (p.status === 'error') throw new Error(p.error || 'Nhận dạng lỗi.');
      if (p.status === 'cancelled') throw new Error('Đã dừng.');
      await sleep(600);
    }
  } catch (e) {
    cancel();
    throw e;
  }
}

/** Dòng trạng thái ngắn cho một nhịp poll. */
export function sttStatusText(p: SttPoll): string {
  switch (p.status) {
    case 'uploading': return `Đang chuẩn bị âm thanh… ${Math.round(p.progress * 100)}%`;
    case 'queued': return 'Đang chờ lượt trước chạy xong…';
    case 'loading': return p.loadPct !== null ? `Đang tải model nhận dạng (lần đầu)… ${p.loadPct}%` : 'Đang nạp model nhận dạng…';
    // Âm thanh ngắn chỉ có một đoạn → không có mốc % nào trước khi xong.
    case 'running': return p.progress > 0 ? `Đang nhận dạng… ${Math.round(p.progress * 100)}%` : 'Đang nhận dạng…';
    case 'done': return `Xong — ${fmtDuration(p.seconds)} âm thanh trong ${(p.elapsedMs / 1000).toFixed(1)} giây`;
    case 'cancelled': return 'Đã dừng.';
    default: return p.error || 'Lỗi.';
  }
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s} giây`;
}

// ── STT: ghi âm từ micro ─────────────────────────────────────────────────────

export interface Recording {
  /** Dừng và lấy bản ghi. */
  stop: () => Promise<Blob>;
  /** Bỏ bản ghi. */
  cancel: () => void;
}

export async function startRecording(): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Máy này không cho ghi âm (không có mediaDevices).');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    const name = (e as DOMException).name;
    throw new Error(
      name === 'NotFoundError' ? 'Không tìm thấy micro nào trên máy.'
        : name === 'NotAllowedError' ? 'Chưa được phép dùng micro — kiểm tra Cài đặt Windows › Quyền riêng tư › Micrô.'
          : `Không mở được micro: ${(e as Error).message}`,
    );
  }
  const rec = new MediaRecorder(stream);
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  rec.start(250);
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stop: () => new Promise<Blob>((resolve) => {
      rec.onstop = () => { release(); resolve(new Blob(parts, { type: rec.mimeType || 'audio/webm' })); };
      if (rec.state !== 'inactive') rec.stop(); else { release(); resolve(new Blob(parts, { type: rec.mimeType || 'audio/webm' })); }
    }),
    cancel: () => { rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); release(); },
  };
}

// ── TTS ──────────────────────────────────────────────────────────────────────

/** Markdown → chữ đọc được: bỏ ký hiệu, khối code thay bằng một câu ngắn. */
export function mdToSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (đoạn mã) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/https?:\/\/\S+/g, ' (đường dẫn) ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\.\s*\./g, '.')
    .trim();
}

const VI_RE = /[ăâđêôơưàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/i;

/** Đoán ngôn ngữ đọc cho chế độ "Tự nhận diện" — đủ phân biệt mấy thứ tiếng hay gặp. */
export function guessLang(text: string): string {
  if (VI_RE.test(text)) return 'vi';
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[가-힯]/.test(text)) return 'ko';
  if (/[一-鿿]/.test(text)) return 'zh-CN';
  if (/[฀-๿]/.test(text)) return 'th';
  return 'en';
}

/** Cắt văn bản dài thành các phần ≤ TTS_PART ký tự, ưu tiên cuối câu. */
export function ttsParts(text: string): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS);
  while (rest) {
    if (rest.length <= TTS_PART) { out.push(rest); break; }
    const head = rest.slice(0, TTS_PART);
    let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('。'));
    if (cut < TTS_PART * 0.5) cut = head.lastIndexOf(' ');
    if (cut < TTS_PART * 0.3) cut = TTS_PART - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  return out.filter(Boolean);
}

const ttsPart = (text: string, lang: string) =>
  call<{ mime: string; chunks: string[] }>('tts', { text, lang }, 60_000);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Cả văn bản → một file MP3 (nối các khung MP3 lại — phát được ở mọi trình phát). */
export async function ttsToBlob(text: string, lang: string, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const parts = ttsParts(text);
  if (!parts.length) throw new Error('Không có gì để đọc.');
  const real = lang === 'auto' ? guessLang(text) : lang;
  const bytes: Uint8Array[] = [];
  for (let i = 0; i < parts.length; i++) {
    const r = await ttsPart(parts[i], real);
    for (const c of r.chunks) bytes.push(b64ToBytes(c));
    onProgress?.(i + 1, parts.length);
  }
  return new Blob(bytes as BlobPart[], { type: 'audio/mpeg' });
}

// ── TTS: trình phát dùng chung (mỗi lúc chỉ một nguồn phát) ──────────────────

export interface SpeakState {
  /** Khoá của thứ đang đọc (id tin nhắn, 'tools'…); null = im lặng. */
  key: string | null;
  /** Đang tải phần đầu, chưa ra tiếng. */
  loading: boolean;
  error: string | null;
}

let state: SpeakState = { key: null, loading: false, error: null };
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
/** Tăng mỗi lần bắt đầu/dừng — vòng phát cũ thấy khác số thì tự thoát. */
let token = 0;

function set(next: SpeakState): void { state = next; listeners.forEach((fn) => fn()); }

export const speaker = {
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  getSnapshot(): SpeakState { return state; },
  getServerSnapshot(): SpeakState { return state; },

  stop(): void {
    token += 1;
    if (audio) { audio.pause(); audio.src = ''; audio = null; }
    if (state.key !== null || state.loading) set({ key: null, loading: false, error: null });
  },

  /** Đọc `text`. Gọi lại với cùng `key` khi đang đọc = dừng. */
  async speak(key: string, text: string, lang = 'auto'): Promise<void> {
    if (state.key === key) { speaker.stop(); return; }
    speaker.stop();
    const parts = ttsParts(text);
    if (!parts.length) return;
    const my = ++token;
    const real = lang === 'auto' ? guessLang(text) : lang;
    set({ key, loading: true, error: null });
    try {
      // Tải trước phần kế tiếp trong lúc đang phát phần hiện tại → không hẫng giữa chừng.
      let pending = ttsPart(parts[0], real);
      for (let i = 0; i < parts.length; i++) {
        const cur = await pending;
        if (my !== token) return;
        if (i + 1 < parts.length) {
          pending = ttsPart(parts[i + 1], real);
          pending.catch(() => {}); // lỗi sẽ được bắt ở vòng sau
        }
        set({ key, loading: false, error: null });
        for (const chunk of cur.chunks) {
          if (my !== token) return;
          await playOne(`data:${cur.mime};base64,${chunk}`, my);
        }
      }
      if (my === token) set({ key: null, loading: false, error: null });
    } catch (e) {
      if (my === token) set({ key: null, loading: false, error: (e as Error).message });
    }
  },
};

function playOne(src: string, my: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (my !== token) { resolve(); return; }
    const a = new Audio(src);
    audio = a;
    a.onended = () => resolve();
    a.onpause = () => { if (my !== token) resolve(); };
    a.onerror = () => reject(new Error('Không phát được âm thanh.'));
    a.play().catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}
