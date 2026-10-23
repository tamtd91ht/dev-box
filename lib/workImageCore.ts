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

const FILE_RE = /^\d{4}-\d{2}\/[0-9a-f-]{36}\.(png|jpg|gif|webp|bmp)$/;
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

const TOKEN_RE = /!\[([^\]\n]*)\]\(devbox-img:([^)\s]+)\)/g;

export interface TextPart { kind: 'text'; text: string }
export interface ImagePart { kind: 'image'; ref: string; alt: string }

/** Tách văn bản thành đoạn chữ + ảnh theo đúng thứ tự xuất hiện. */
export function splitImages(text: string): (TextPart | ImagePart)[] {
  const out: (TextPart | ImagePart)[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    out.push({ kind: 'image', alt: m[1], ref: m[2] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export function imageRefs(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[2]);
}

/** Văn bản bỏ token ảnh — cho dòng preview / tìm kiếm. */
export function stripImages(text: string): string {
  return text.replace(TOKEN_RE, ' ');
}

/** Bỏ MỘT token (nút ✕ trên thumbnail) — cùng dòng trống thừa nó để lại. */
export function removeImageRef(text: string, ref: string): string {
  return text.replace(TOKEN_RE, (all, _alt, r) => (r === ref ? '' : all)).replace(/\n{3,}/g, '\n\n');
}

export const imageUrl = (ref: string): string => `/api/work-images?ref=${encodeURIComponent(ref)}`;
