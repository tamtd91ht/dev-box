// Tiến trình con chạy Whisper cho STT — được lib/speechServer.ts fork ra.
//
// VÌ SAO PHẢI LÀ TIẾN TRÌNH RIÊNG: onnxruntime-node chạy suy luận ĐỒNG BỘ trên
// luồng JS. Chạy thẳng trong server Next thì suốt lúc nhận dạng (hàng chục giây
// tới nhiều phút) server không trả lời được request nào — mọi tab của Dev Box
// đứng hình theo. Đo thật: file 6 giây với model small làm server im ~15 giây.
// Ở đây thì chỉ tiến trình này bận; muốn dừng ngay thì cha kill nó là xong, RAM
// của model (0,5–1 GB) cũng được trả lại hệ điều hành.
//
// Giao thức (IPC, serialization 'advanced' nên Buffer đi thẳng không qua JSON):
//   cha → con  { type:'run', id, model, language, pcm: Buffer(PCM 16 kHz mono 16-bit LE), modelDir, downloading }
//   con → cha  { type:'status', id, status:'loading'|'running', loadPct }
//              { type:'progress', id, progress: 0..1, text }
//              { type:'done', id, text } | { type:'error', id, error }
// Mỗi lúc một job (cha xếp hàng). Rảnh IDLE_EXIT_MS thì tự thoát để nhả RAM.

'use strict';

const SAMPLE_RATE = 16000;
/** Đoạn dài nhất đưa cho Whisper (giây) — cửa sổ của nó là 30s. */
const SEG_MAX_S = 28;
/** Tìm chỗ lặng để cắt trong khoảng này trước mốc SEG_MAX_S (giây). */
const SEG_SEARCH_S = 8;
const IDLE_EXIT_MS = 10 * 60 * 1000;

let asr = null;
let asrModel = null;
let idle = null;

function armIdle() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
}

async function loadAsr(m) {
  if (asr && asrModel === m.model) return asr;
  if (asr) { try { await asr.dispose(); } catch { /* đã nhả */ } asr = null; asrModel = null; }
  process.send({ type: 'status', id: m.id, status: 'loading', loadPct: null });
  const tf = require('@huggingface/transformers');
  tf.env.cacheDir = m.modelDir;
  // Tiến độ TẢI VỀ chỉ có nghĩa ở lần đầu; model đã nằm trên đĩa thì callback
  // vẫn bắn (đọc file) nhưng đó không phải "đang tải" — đừng báo sai.
  const files = new Map();
  let lastPct = -1;
  asr = await tf.pipeline('automatic-speech-recognition', m.model, {
    dtype: 'q8',
    progress_callback: (p) => {
      if (!m.downloading || p.status !== 'progress' || !p.file || !p.file.endsWith('.onnx') || !p.total) return;
      files.set(p.file, { loaded: p.loaded || 0, total: p.total });
      let loaded = 0; let total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      const pct = total ? Math.min(99, Math.floor((loaded / total) * 100)) : null;
      if (pct !== lastPct) { lastPct = pct; process.send({ type: 'status', id: m.id, status: 'loading', loadPct: pct }); }
    },
  });
  asrModel = m.model;
  return asr;
}

/** Điểm cắt các đoạn ≤ SEG_MAX_S, đặt tại chỗ lặng nhất trong SEG_SEARCH_S giây cuối
 *  của mỗi đoạn — để không cắt giữa chừng một từ. */
function segmentBounds(pcm) {
  const max = SEG_MAX_S * SAMPLE_RATE;
  const search = SEG_SEARCH_S * SAMPLE_RATE;
  const win = Math.round(0.2 * SAMPLE_RATE);
  const hop = Math.round(0.05 * SAMPLE_RATE);
  const bounds = [0];
  let start = 0;
  while (pcm.length - start > max) {
    const from = start + max - search;
    const to = start + max - win;
    let best = to;
    let bestE = Infinity;
    for (let i = from; i <= to; i += hop) {
      let e = 0;
      for (let k = i; k < i + win; k += 4) e += pcm[k] * pcm[k];
      if (e < bestE) { bestE = e; best = i + (win >> 1); }
    }
    bounds.push(best);
    start = best;
  }
  bounds.push(pcm.length);
  return bounds;
}

/** Whisper hay "nghe ra" mấy câu quen ở đoạn chỉ có im lặng — bỏ đoạn gần như không có tiếng. */
function isSilent(seg) {
  let e = 0;
  for (let i = 0; i < seg.length; i += 8) e += seg[i] * seg[i];
  return Math.sqrt(e / Math.max(1, seg.length / 8)) < 0.0015;
}

async function run(m) {
  if (idle) { clearTimeout(idle); idle = null; }
  try {
    const raw = Buffer.from(m.pcm.buffer, m.pcm.byteOffset, m.pcm.byteLength);
    const n = raw.length >> 1;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = raw.readInt16LE(i * 2) / 32768;

    const pipe = await loadAsr(m);
    process.send({ type: 'status', id: m.id, status: 'running', loadPct: null });

    const language = m.language === 'auto' ? null : m.language;
    const bounds = segmentBounds(pcm);
    const parts = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const seg = pcm.subarray(bounds[i], bounds[i + 1]);
      if (!isSilent(seg)) {
        const out = await pipe(seg, { language, task: 'transcribe' });
        const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).replace(/\s+/g, ' ').trim();
        if (text) parts.push(text);
      }
      process.send({ type: 'progress', id: m.id, progress: bounds[i + 1] / pcm.length, text: parts.join(' ') });
    }
    process.send({ type: 'done', id: m.id, text: parts.join(' ') });
  } catch (e) {
    process.send({ type: 'error', id: m.id, error: (e && e.message) || String(e) });
    // Lỗi lúc nạp/chạy → bỏ pipeline để lần sau nạp lại sạch.
    if (asr) { try { await asr.dispose(); } catch { /* bỏ qua */ } }
    asr = null; asrModel = null;
  } finally {
    armIdle();
  }
}

process.on('message', (m) => { if (m && m.type === 'run') void run(m); });
// Cha chết / ngắt kênh → không để tiến trình mồ côi giữ RAM.
process.on('disconnect', () => process.exit(0));
armIdle();
