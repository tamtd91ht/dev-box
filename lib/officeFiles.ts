// Server-only shared plumbing for the Office tab editors (Sheet + Word):
// path validation (open + create-new), stale-mtime check, the create-only
// write, and the backup-then-atomic-overwrite write path. Keeping this in
// ONE place means every Office editor gets the exact same safety behaviour.

import { promises as fs } from 'fs';
import path from 'path';

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

export interface OfficeTarget {
  abs: string;
  /** Lowercased extension including the dot, e.g. '.xlsx'. */
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Resolve + validate a user-supplied path: absolute-ize, whitelist the
 * extension, refuse known-bad ones with a specific message, require a real
 * file under the size cap.
 */
export async function resolveOfficeFile(
  raw: unknown,
  allowed: string[],
  refused?: Record<string, string>,
): Promise<OfficeTarget> {
  const p = String(raw ?? '').trim();
  if (!p) throw new Error('Thiếu đường dẫn file.');
  const abs = path.resolve(p);
  const ext = path.extname(abs).toLowerCase();
  if (refused && refused[ext]) throw new Error(refused[ext]);
  if (!allowed.includes(ext)) {
    throw new Error(`Chỉ hỗ trợ ${allowed.join(' / ')} (file: ${path.basename(abs)}).`);
  }
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new Error(`Không đọc được file: ${abs}`);
  }
  if (!st.isFile()) throw new Error(`Không phải file: ${abs}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`File quá lớn (${(st.size / 1048576).toFixed(1)} MB > ${MAX_FILE_BYTES / 1048576} MB).`);
  }
  return { abs, ext, sizeBytes: st.size, mtimeMs: st.mtimeMs };
}

/**
 * Resolve + validate the target for a NEW file: existing directory + a bare
 * file name (no separators, no illegal Windows chars). A missing extension
 * gets the first allowed one appended. The file itself must NOT exist yet.
 */
export async function resolveNewOfficeFile(
  dirRaw: unknown,
  nameRaw: unknown,
  allowed: string[],
): Promise<{ abs: string; ext: string }> {
  const dir = String(dirRaw ?? '').trim();
  if (!dir) throw new Error('Thiếu thư mục lưu file.');
  const absDir = path.resolve(dir);
  let st;
  try {
    st = await fs.stat(absDir);
  } catch {
    throw new Error(`Không đọc được thư mục: ${absDir}`);
  }
  if (!st.isDirectory()) throw new Error(`Không phải thư mục: ${absDir}`);

  let name = String(nameRaw ?? '').trim();
  if (!name) throw new Error('Thiếu tên file.');
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name) || /^\.+$/.test(name) || name.endsWith('.')) {
    throw new Error('Tên file không hợp lệ (không được chứa \\ / : * ? " < > | hay kết thúc bằng dấu chấm).');
  }
  let ext = path.extname(name).toLowerCase();
  if (!ext) { ext = allowed[0]; name += ext; }
  if (!allowed.includes(ext)) throw new Error(`Chỉ tạo được file ${allowed.join(' / ')}.`);

  const abs = path.join(absDir, name);
  return { abs, ext };
}

/** Create-only write: refuses to touch an existing file (O_EXCL). */
export async function writeNewFile(abs: string, data: Buffer): Promise<void> {
  try {
    await fs.writeFile(abs, data, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`File đã tồn tại: ${abs} — mở file đó hoặc đặt tên khác.`);
    }
    throw e;
  }
}

/** Refuse the save when the file changed since the client opened it. */
export function assertNotStale(target: OfficeTarget, sentMtimeMs: unknown): void {
  const opened = Number(sentMtimeMs);
  if (!Number.isFinite(opened) || Math.abs(target.mtimeMs - opened) > 1) {
    throw new Error('File đã bị thay đổi từ khi mở (mtime khác). Bấm "Tải lại" xem bản mới rồi sửa tiếp.');
  }
}

/**
 * Overwrite `abs` safely: write a temp sibling → copy the original to
 * `<file>.bak` (single backup, refreshed each save) → atomic rename over the
 * original (same volume, MOVEFILE_REPLACE_EXISTING). Returns the backup path.
 */
export async function atomicBackupWrite(abs: string, data: Buffer): Promise<string> {
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  const backupPath = `${abs}.bak`;
  try {
    await fs.writeFile(tmp, data);
    await fs.copyFile(abs, backupPath);
    await fs.rename(tmp, abs);
  } finally {
    await fs.unlink(tmp).catch(() => {}); // no-op when the rename succeeded
  }
  return backupPath;
}
