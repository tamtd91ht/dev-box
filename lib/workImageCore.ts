// ẢNH ĐÍNH KÈM của tab Công việc — phần lõi THUẦN (client + server dùng chung).
//
// Ảnh KHÔNG nằm trong document Mongo/file JSON của task/ghi chú/trọng tâm. Văn
// bản (mô tả task, nội dung ghi chú, ghi chú nhiệm vụ trọng tâm) chỉ chứa một
// TOKEN kiểu markdown trỏ tới ảnh:
//
//     ![ảnh](devbox-img:l/2026-10/3f2c…e1.png)            ← lưu file local
//     ![ảnh](devbox-img:m/devbox-work/2026-10/3f2c…e1.png) ← lưu MinIO, bucket devbox-work
//
// Nhờ vậy không phải đổi schema ba kho, tìm kiếm/giới hạn độ dài vẫn như cũ, và
// ảnh đã gắn vẫn đọc được sau khi đổi chế độ lưu (ref tự mang theo nơi lưu).
// Ref MinIO cố tình KHÔNG chứa connectionId: id connection là theo từng máy,
// trong khi task là dữ liệu global — máy nào cũng đọc qua cụm MinIO mình đã cấu
// hình (xem lib/workImages).
//
// FILE ĐÍNH KÈM (pdf, xlsx, zip, …) đi đúng đường đó, chỉ khác token — nhãn là
// TÊN FILE GỐC (ref chỉ có uuid + phần mở rộng), không có dấu `!`:
//
//     [📎 bao-cao-q3.xlsx](devbox-file:l/2026-10/7a1b…c9.xlsx)
//
// File luôn được trả về dạng TẢI XUỐNG (attachment, octet-stream) — không bao
// giờ hiển thị inline, để một file .html/.svg đính kèm không chạy được trong app.

export type WorkImageMode = 'local' | 'minio';

/** Định dạng ảnh nhận — ảnh chụp màn hình dán vào luôn là PNG. */
export const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export const EXT_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_EXT).map(([t, e]) => [e, t]),
);

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Trần một file đính kèm (không phải ảnh). */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;

const FILE_RE = /^\d{4}-\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,10}$/;

/** Phần mở rộng an toàn lấy từ tên file gốc — không hợp lệ thì 'bin'. */
export function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  const ext = i > 0 ? name.slice(i + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'bin';
}

/** Ref là ảnh (định dạng raster đã nhận) — chỉ những ref này được trả inline. */
export function isImageRef(ref: string): boolean {
  return !!EXT_TYPE[ref.slice(ref.lastIndexOf('.') + 1)];
}
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export type ParsedRef =
  | { mode: 'local'; file: string }
  | { mode: 'minio'; bucket: string; key: string };

/** Ref hợp lệ → nơi lưu; null nếu sai dạng (chặn path traversal ở route đọc). */
export function parseRef(ref: string): ParsedRef | null {
  if (ref.startsWith('l/')) {
    const file = ref.slice(2);
    return FILE_RE.test(file) ? { mode: 'local', file } : null;
  }
  if (ref.startsWith('m/')) {
    const rest = ref.slice(2);
    const i = rest.indexOf('/');
    if (i < 0) return null;
    const bucket = rest.slice(0, i);
    const file = rest.slice(i + 1);
    return BUCKET_RE.test(bucket) && FILE_RE.test(file) ? { mode: 'minio', bucket, key: `devbox-work/${file}` } : null;
  }
  return null;
}

/** Tên phần mở rộng → content-type (đọc từ ref). */
export function refType(ref: string): string {
  return EXT_TYPE[ref.slice(ref.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
}

export const imageToken = (ref: string, alt = 'ảnh'): string => `![${alt.replace(/[[\]]/g, '')}](devbox-img:${ref})`;

/** Tên file đưa vào nhãn token: bỏ ký tự phá cú pháp, cắt độ dài. */
export function cleanFileName(name: string): string {
  return name.replace(/[[\]\r\n]/g, '').replace(/^📎\s*/, '').trim().slice(0, 120) || 'file';
}

export const fileToken = (ref: string, name: string): string => `[📎 ${cleanFileName(name)}](devbox-file:${ref})`;

const TOKEN_RE = /!\[([^\]\n]*)\]\(devbox-img:([^)\s]+)\)/g;
const FILE_TOKEN_RE = /\[📎 ([^\]\n]*)\]\(devbox-file:([^)\s]+)\)/g;
/** Ảnh HOẶC file — để tách văn bản theo đúng thứ tự xuất hiện. */
const ANY_TOKEN_RE = /!\[([^\]\n]*)\]\(devbox-img:([^)\s]+)\)|\[📎 ([^\]\n]*)\]\(devbox-file:([^)\s]+)\)/g;

export interface TextPart { kind: 'text'; text: string }
export interface ImagePart { kind: 'image'; ref: string; alt: string }
export interface FilePart { kind: 'file'; ref: string; name: string }

/** Tách văn bản thành đoạn chữ + ảnh + file theo đúng thứ tự xuất hiện. */
export function splitImages(text: string): (TextPart | ImagePart | FilePart)[] {
  const out: (TextPart | ImagePart | FilePart)[] = [];
  let last = 0;
  for (const m of text.matchAll(ANY_TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    if (m[2] !== undefined) out.push({ kind: 'image', alt: m[1], ref: m[2] });
    else out.push({ kind: 'file', name: m[3], ref: m[4] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export function imageRefs(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[2]);
}

export function fileRefs(text: string): { ref: string; name: string }[] {
  return [...text.matchAll(FILE_TOKEN_RE)].map((m) => ({ name: m[1], ref: m[2] }));
}

/** Văn bản bỏ token ảnh (file thì còn lại TÊN) — cho dòng preview / tìm kiếm. */
export function stripImages(text: string): string {
  return text.replace(TOKEN_RE, ' ').replace(FILE_TOKEN_RE, (_all, name: string) => ` ${name} `);
}

/** Bỏ MỘT token ảnh/file (nút ✕) — cùng dòng trống thừa nó để lại. */
export function removeImageRef(text: string, ref: string): string {
  return text
    .replace(ANY_TOKEN_RE, (all, _a, img: string | undefined, _n, file: string | undefined) => ((img ?? file) === ref ? '' : all))
    .replace(/\n{3,}/g, '\n\n');
}

export const imageUrl = (ref: string): string => `/api/work-images?ref=${encodeURIComponent(ref)}`;
/** Link TẢI file đính kèm — server đặt tên tải về theo `name`. */
export const fileUrl = (ref: string, name: string): string =>
  `/api/work-images?ref=${encodeURIComponent(ref)}&name=${encodeURIComponent(name)}`;
