// Trợ lý AI — XUẤT FILE (chạy ở renderer, components/AiChat.tsx).
//
// Trợ lý vẫn KHÔNG có công cụ (lib/aiChatServer.ts): muốn xuất file thì nó VIẾT nội dung trong câu trả lời, bọc
// trong khối  <xuat_file name="ten.ext" …>…</xuat_file>. Bảng chat tách khối ra, hiện thẻ "Xuất file" và CHỈ khi
// người dùng bấm đồng ý mới dựng file rồi đưa qua hộp thoại Lưu của app (tải xuống → main.cjs will-download).
// Dựng hoàn toàn TRONG BỘ NHỚ: không ghi file tạm nào; xuất xong / bấm Bỏ thì nội dung bị xoá khỏi bộ nhớ, URL blob
// được thu hồi. Nội dung khối KHÔNG lưu vào sessionStorage cùng lịch sử chat.
//
// Định dạng:
//   · .txt .md .csv (thêm BOM cho Excel) .json .html .svg — chữ trợ lý viết;
//   · .docx (Markdown) / .xlsx (CSV, nhiều sheet = "### Sheet: Tên") — server dựng (lib/aiExport.ts);
//   · .doc — Markdown → HTML kiểu Word (Word mở được, không cần thư viện);
//   · ảnh .png .jpg .webp — trợ lý vẽ bằng SVG, hoặc nguon="anh-chup" = ảnh chụp màn hình MỚI NHẤT của câu hỏi;
//   · video .webm (.mp4 nếu Chromium ghi được) — các khung <khung giay="2"><svg>…</svg></khung>, hoặc
//     nguon="anh-chup" = trình chiếu mọi ảnh chụp màn hình của câu hỏi. Ghi bằng MediaRecorder từ canvas.

import { apiFetch } from './apiFetch';
import { renderMarkdown } from './md';

export interface ExportSpec {
  name: string;
  /** Nội dung chữ trong khối (Markdown / CSV / SVG / các khung video…). */
  content: string;
  /** "anh-chup": lấy từ ảnh chụp màn hình của câu hỏi. */
  source: string;
  /** Video: giây mỗi khung (mặc định). */
  seconds: number;
}

export interface Shot { mediaType: string; data: string }

export const EXPORT_LIMITS = { maxFiles: 6, maxChars: 2_000_000, maxFrames: 60, maxVideoSeconds: 120 } as const;

export type ExportKind = 'text' | 'docx' | 'doc' | 'xlsx' | 'image' | 'video';

const TEXT_MIME: Record<string, string> = {
  txt: 'text/plain;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
  html: 'text/html;charset=utf-8',
  svg: 'image/svg+xml;charset=utf-8',
};
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

export function kindOf(name: string): ExportKind | null {
  const e = extOf(name);
  if (e in TEXT_MIME) return 'text';
  if (e === 'docx' || e === 'xlsx' || e === 'doc') return e;
  if (e === 'docs') return 'docx';
  if (e in IMAGE_MIME) return 'image';
  if (e === 'webm' || e === 'mp4') return 'video';
  return null;
}

/** Tên file an toàn cho hệ điều hành (giữ tiếng Việt). ".docs" → ".docx". */
function cleanName(raw: string): string {
  const n = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return n.replace(/\.docs$/i, '.docx') || 'file.txt';
}

const BLOCK = /<xuat_file\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xuat_file>)/g;
const attr = (attrs: string, key: string) => new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1];

/** Tách các khối xuất file khỏi câu trả lời. */
export function parseExports(raw: string): { text: string; files: ExportSpec[] } {
  const files: ExportSpec[] = [];
  const text = raw.replace(BLOCK, (_m, attrs: string, body?: string) => {
    const name = attr(attrs, 'name');
    if (name && files.length < EXPORT_LIMITS.maxFiles) {
      files.push({
        name: cleanName(name),
        content: (body ?? '').replace(/^\r?\n/, '').replace(/\r?\n$/, '').slice(0, EXPORT_LIMITS.maxChars),
        source: (attr(attrs, 'nguon') ?? '').trim().toLowerCase(),
        seconds: Math.min(30, Math.max(0.5, Number(attr(attrs, 'giay')) || 2)),
      });
    }
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), files };
}

/** Bỏ khối xuất file (kể cả đang stream dở) khỏi phần chữ hiện cho người dùng. */
export const stripExports = (raw: string) => raw.replace(BLOCK, '').replace(/<xuat_file\b[\s\S]*$/, '').trimEnd();

// ── Dựng file ─────────────────────────────────────────────────────────────────

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function serverBuild(name: string, content: string): Promise<Blob> {
  const r = await apiFetch('/api/ai', { method: 'POST', body: JSON.stringify({ action: 'export.build', name, content }), timeoutMs: 120_000 });
  const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: { data: string; mime: string } };
  if (!r.ok || d.ok === false || !d.result) throw new Error(d.error || `HTTP ${r.status}`);
  return new Blob([b64ToBytes(d.result.data)], { type: d.result.mime });
}

function wordHtml(md: string, title: string): string {
  const esc = title.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[c]!);
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc}</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 6px}pre,code{font-family:Consolas,monospace}</style>
</head><body>${renderMarkdown(md)}</body></html>`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Không dựng được ảnh (SVG lỗi?).'));
    img.src = src;
  });
}

/** Kích thước của SVG (width/height, không có thì viewBox), giới hạn 4096 px. */
function svgSize(svg: string): { w: number; h: number } {
  const head = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const n = (k: string) => Number(attr(head, k)?.replace(/px$/, '')) || 0;
  let w = n('width');
  let h = n('height');
  const vb = attr(head, 'viewBox')?.split(/[\s,]+/).map(Number);
  if ((!w || !h) && vb?.length === 4) { w = w || vb[2]; h = h || vb[3]; }
  w = w || 1280; h = h || 720;
  const k = Math.min(1, 4096 / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

/** SVG chưa có width/height thì thêm (Chromium vẽ SVG thiếu kích thước thành 0×0). */
function sizedSvg(svg: string, w: number, h: number): string {
  return svg.replace(/<svg\b([^>]*)>/i, (m, a: string) => (/\bwidth=/.test(a) && /\bheight=/.test(a) ? m : `<svg${a} width="${w}" height="${h}">`));
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const shotUrl = (s: Shot) => `data:${s.mediaType};base64,${s.data}`;

function canvasBlob(c: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Không xuất được ảnh.'))), type, 0.92));
}

async function buildImage(spec: ExportSpec, shots: Shot[]): Promise<Blob> {
  const type = IMAGE_MIME[extOf(spec.name)];
  let img: HTMLImageElement;
  if (spec.source === 'anh-chup') {
    const s = shots[shots.length - 1];
    if (!s) throw new Error('Câu hỏi này chưa có ảnh chụp màn hình nào (chỉ có khi bật Thao tác màn hình).');
    img = await loadImage(shotUrl(s));
  } else {
    const svg = /<svg\b[\s\S]*<\/svg>/i.exec(spec.content)?.[0];
    if (!svg) throw new Error('Không có nội dung SVG để dựng ảnh.');
    const { w, h } = svgSize(svg);
    img = await loadImage(svgUrl(sizedSvg(svg, w, h)));
  }
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || 1280;
  c.height = img.naturalHeight || 720;
  const g = c.getContext('2d')!;
  if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(img, 0, 0, c.width, c.height);
  return canvasBlob(c, type);
}

/** Các khung video: <khung giay="2"><svg…></khung>; không có khung nhưng có SVG → mỗi SVG một khung. */
async function videoFrames(spec: ExportSpec, shots: Shot[]): Promise<{ img: HTMLImageElement; seconds: number }[]> {
  if (spec.source === 'anh-chup') {
    if (!shots.length) throw new Error('Câu hỏi này chưa có ảnh chụp màn hình nào để dựng video.');
    return Promise.all(shots.slice(-EXPORT_LIMITS.maxFrames).map(async (s) => ({ img: await loadImage(shotUrl(s)), seconds: spec.seconds })));
  }
  const frames: { svg: string; seconds: number }[] = [];
  for (const m of spec.content.matchAll(/<khung\b([^>]*)>([\s\S]*?)<\/khung>/gi)) {
    const svg = /<svg\b[\s\S]*<\/svg>/i.exec(m[2])?.[0];
    if (svg) frames.push({ svg, seconds: Math.min(30, Math.max(0.2, Number(attr(m[1], 'giay')) || spec.seconds)) });
  }
  if (!frames.length) for (const m of spec.content.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) frames.push({ svg: m[0], seconds: spec.seconds });
  if (!frames.length) throw new Error('Không có khung hình (SVG) nào để dựng video.');
  const { w, h } = svgSize(frames[0].svg);
  return Promise.all(frames.slice(0, EXPORT_LIMITS.maxFrames).map(async (f) => ({ img: await loadImage(svgUrl(sizedSvg(f.svg, w, h))), seconds: f.seconds })));
}

/** Ghi video từ canvas (MediaRecorder) — chạy THEO THỜI GIAN THẬT (video 20 giây mất ~20 giây). */
async function buildVideo(spec: ExportSpec, shots: Shot[]): Promise<{ blob: Blob; name: string; note: string }> {
  const frames = await videoFrames(spec, shots);
  const wantMp4 = extOf(spec.name) === 'mp4';
  const mp4 = ['video/mp4;codecs=avc1', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  const webm = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const mime = (wantMp4 && mp4) || webm || mp4;
  if (!mime) throw new Error('Trình duyệt của app không ghi được video.');
  const isMp4 = mime.startsWith('video/mp4');
  const name = isMp4 ? spec.name.replace(/\.[^.]+$/, '.mp4') : spec.name.replace(/\.[^.]+$/, '.webm');

  const c = document.createElement('canvas');
  c.width = Math.min(1920, frames[0].img.naturalWidth || 1280) & ~1;
  c.height = Math.min(1080, frames[0].img.naturalHeight || 720) & ~1;
  const g = c.getContext('2d')!;
  const draw = (img: HTMLImageElement) => {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    const k = Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    g.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
  };
  draw(frames[0].img);
  const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
  rec.start(1000);
  let total = 0;
  for (const f of frames) {
    if (total >= EXPORT_LIMITS.maxVideoSeconds) break;
    const secs = Math.min(f.seconds, EXPORT_LIMITS.maxVideoSeconds - total);
    const end = performance.now() + secs * 1000;
    // Vẽ lại đều đặn: captureStream chỉ phát khung khi canvas đổi.
    while (performance.now() < end) {
      draw(f.img);
      await new Promise((r) => setTimeout(r, 100));
    }
    total += secs;
  }
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  const note = wantMp4 && !isMp4 ? 'App không ghi được MP4 — đã xuất dạng WebM.' : '';
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), name, note };
}

/** Dựng một file. Trả blob + tên cuối cùng (video có thể đổi đuôi) + ghi chú. */
export async function buildFile(spec: ExportSpec, shots: Shot[]): Promise<{ blob: Blob; name: string; note: string }> {
  const kind = kindOf(spec.name);
  const ext = extOf(spec.name);
  if (!kind) throw new Error(`Chưa hỗ trợ xuất ".${ext}".`);
  if (kind === 'text') {
    const body = ext === 'csv' ? `﻿${spec.content}` : spec.content; // BOM: Excel đọc đúng tiếng Việt
    return { blob: new Blob([body], { type: TEXT_MIME[ext] }), name: spec.name, note: '' };
  }
  if (kind === 'docx' || kind === 'xlsx') return { blob: await serverBuild(spec.name, spec.content), name: spec.name, note: '' };
  if (kind === 'doc') return { blob: new Blob([`﻿${wordHtml(spec.content, spec.name)}`], { type: 'application/msword' }), name: spec.name, note: '' };
  if (kind === 'image') return { blob: await buildImage(spec, shots), name: spec.name, note: '' };
  return buildVideo(spec, shots);
}

/** Đưa file qua hộp thoại Lưu của app (main.cjs will-download) rồi thu hồi URL blob khỏi bộ nhớ. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // will-download đã nhận dữ liệu rất sớm; chờ một nhịp rồi thu hồi để blob không nằm lại trong bộ nhớ.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
