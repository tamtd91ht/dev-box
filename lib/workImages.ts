// Server-only: kho ẢNH + FILE ĐÍNH KÈM của tab Công việc (task, ghi chú, nhiệm vụ
// trọng tâm). Token trong văn bản + định dạng ref: xem lib/workImageCore. Ảnh và
// file dùng chung nơi lưu, chung cấu hình — chỉ khác kiểm tra đầu vào.
//
// HAI chế độ lưu, chọn trong hộp "Lưu ảnh" (configs/workimages.json):
//   · 'local' (mặc định) — file trong data/work-images/<YYYY-MM>/<uuid>.<ext>.
//     Thư mục bị gitignore và cố ý KHÔNG nằm trong configs/ (configs được đồng
//     bộ lên repo config — ảnh nhị phân không có chỗ ở đó). Chỉ máy này thấy ảnh.
//   · 'minio' — object devbox-work/<YYYY-MM>/<uuid>.<ext> trong bucket đã chọn,
//     qua một connection của menu MinIO (cùng registry lib/minioConnections).
//     Ghi vẫn qua cổng an toàn của tool MinIO: MINIO_ALLOW_WRITE + connection
//     không read-only (assertWritable) — không có đường ghi riêng ở đây.
//
// Đổi chế độ KHÔNG di chuyển ảnh cũ: ref mang theo nơi lưu nên ảnh cũ vẫn đọc
// được — riêng ảnh MinIO cần connectionId còn trong cấu hình, nên khi chuyển về
// local ta giữ lại connectionId/bucket chứ không xoá.

import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import { configPath } from './configDir';
import { getConnection, listConnections, type PublicMinioConnection } from './minioConnections';
import { MINIO_ENABLED, MINIO_ALLOW_WRITE, putObject, openObject, listBuckets, makeBucket, validBucket } from './minioClient';
import { IMAGE_EXT, IMAGE_MAX_BYTES, FILE_MAX_BYTES, fileExt, parseRef, refType, type WorkImageMode } from './workImageCore';

export interface WorkImageConfig {
  mode: WorkImageMode;
  connectionId: string | null;
  bucket: string | null;
}

const CONFIG_FILE = configPath('workimages.json');
const LOCAL_DIR = process.env.WORK_IMAGES_DIR
  ? path.resolve(process.cwd(), process.env.WORK_IMAGES_DIR)
  : path.join(process.cwd(), 'data', 'work-images');

async function readConfig(): Promise<WorkImageConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')) as Partial<WorkImageConfig>;
    return {
      mode: raw.mode === 'minio' ? 'minio' : 'local',
      connectionId: typeof raw.connectionId === 'string' && raw.connectionId ? raw.connectionId : null,
      bucket: typeof raw.bucket === 'string' && raw.bucket ? raw.bucket : null,
    };
  } catch {
    return { mode: 'local', connectionId: null, bucket: null };
  }
}

export interface WorkImageConfigView {
  config: WorkImageConfig;
  localDir: string;
  /** Tool MinIO có bật không (MINIO_TOOL_ENABLED) — tắt thì chỉ còn chế độ local. */
  minioEnabled: boolean;
  /** MINIO_ALLOW_WRITE — thiếu thì chế độ MinIO không upload được. */
  minioAllowWrite: boolean;
  connections: PublicMinioConnection[];
}

export async function getImageConfigView(): Promise<WorkImageConfigView> {
  return {
    config: await readConfig(),
    localDir: LOCAL_DIR,
    minioEnabled: MINIO_ENABLED,
    minioAllowWrite: MINIO_ALLOW_WRITE,
    connections: MINIO_ENABLED ? await listConnections() : [],
  };
}

export async function setImageConfig(raw: Record<string, unknown>): Promise<void> {
  const prev = await readConfig();
  const mode: WorkImageMode = raw.mode === 'minio' ? 'minio' : 'local';
  const connectionId = typeof raw.connectionId === 'string' && raw.connectionId ? raw.connectionId : prev.connectionId;
  let bucket = typeof raw.bucket === 'string' && raw.bucket.trim() ? raw.bucket.trim() : prev.bucket;
  if (mode === 'minio') {
    if (!MINIO_ENABLED) throw new Error('Tool MinIO đang tắt (MINIO_TOOL_ENABLED) — chỉ dùng được chế độ lưu local.');
    if (!connectionId) throw new Error('Chọn một cụm MinIO.');
    const conn = await getConnection(connectionId);
    if (!conn) throw new Error('Connection không còn trong danh sách quản lý MinIO.');
    bucket = validBucket(bucket);
    // Bucket chưa có thì tạo luôn — đỡ phải sang menu MinIO chỉ để bấm tạo bucket.
    const exists = (await listBuckets(conn)).some((b) => b.name === bucket);
    if (!exists) await makeBucket(conn, bucket);
  }
  const cfg: WorkImageConfig = { mode, connectionId, bucket };
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** Lưu một ảnh theo chế độ hiện tại → ref (đưa vào token trong văn bản). */
export async function saveImage(data: Buffer, contentType: string): Promise<string> {
  const ext = IMAGE_EXT[contentType.toLowerCase()];
  if (!ext) throw new Error(`Không nhận kiểu file "${contentType || '?'}" — chỉ PNG, JPEG, GIF, WebP, BMP.`);
  if (!data.length) throw new Error('Ảnh rỗng.');
  if (data.length > IMAGE_MAX_BYTES) throw new Error(`Ảnh lớn hơn ${IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
  return store(data, ext, contentType);
}

/**
 * Lưu một FILE đính kèm bất kỳ → ref. Phần mở rộng lấy từ tên gốc (đã lọc), tên
 * gốc nằm trong token chứ không trong ref. Lưu với octet-stream: kiểu thật của
 * file không bao giờ được dùng để hiển thị inline (xem route GET).
 */
export async function saveFile(data: Buffer, name: string): Promise<string> {
  if (!data.length) throw new Error(`File "${name}" rỗng.`);
  if (data.length > FILE_MAX_BYTES) throw new Error(`File "${name}" lớn hơn ${FILE_MAX_BYTES / 1024 / 1024} MB.`);
  return store(data, fileExt(name), 'application/octet-stream');
}

async function store(data: Buffer, ext: string, contentType: string): Promise<string> {
  const now = new Date();
  const file = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;

  const cfg = await readConfig();
  if (cfg.mode === 'minio') {
    if (!MINIO_ENABLED) throw new Error('Tool MinIO đang tắt — đổi chế độ lưu ảnh về local hoặc bật MINIO_TOOL_ENABLED.');
    const conn = cfg.connectionId ? await getConnection(cfg.connectionId) : null;
    if (!conn || !cfg.bucket) throw new Error('Chưa cấu hình cụm MinIO / bucket để lưu ảnh / file.');
    try {
      await putObject(conn, cfg.bucket, `devbox-work/${file}`, data, contentType);
    } catch (e) {
      throw new Error(`Upload MinIO thất bại: ${(e as Error).message}`);
    }
    return `m/${cfg.bucket}/${file}`;
  }

  const full = path.join(LOCAL_DIR, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
  return `l/${file}`;
}

export interface OpenedImage { stream: Readable; size: number; type: string }

/** Mở ảnh theo ref để stream về trình duyệt. Ném lỗi 'not found' nếu không có. */
export async function openImage(ref: string): Promise<OpenedImage> {
  const p = parseRef(ref);
  if (!p) throw new Error('ref ảnh không hợp lệ');
  if (p.mode === 'local') {
    const full = path.join(LOCAL_DIR, p.file);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) throw new Error('not found');
    return { stream: createReadStream(full), size: st.size, type: refType(ref) };
  }
  if (!MINIO_ENABLED) throw new Error('Tool MinIO đang tắt — không đọc được ảnh lưu trên MinIO.');
  const cfg = await readConfig();
  const conn = cfg.connectionId ? await getConnection(cfg.connectionId) : null;
  if (!conn) throw new Error('Máy này chưa cấu hình cụm MinIO cho ảnh Công việc.');
  const { stream, stat } = await openObject(conn, p.bucket, p.key);
  return { stream, size: stat.size, type: refType(ref) };
}
