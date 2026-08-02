// Server-only filesystem ops for the Code Studio tab (mini-IDE).
//
// SECURITY MODEL — same as lib/gitProjects.ts: LOCAL single-user tool, gated by
// CODE_TOOL_ENABLED. Every operation takes (projectRoot, relPath) and the
// resolved target MUST stay inside the root — path.resolve + relative check,
// case-insensitive on Windows (see the api-explorer containment fix b600977).
// The project roots themselves come from the SAME registry as the Git tab
// (.gitprojects.json) so a project is registered once and every tool sees it.

import { promises as fs } from 'fs';
import path from 'path';

/** Max file size the editor will open (bytes) — Monaco chokes far beyond this. */
export const MAX_EDIT_SIZE = 2 * 1024 * 1024;

/** Resolve rel inside root or throw. Returns the absolute path. */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel || '.');
  const relBack = path.relative(root, abs);
  // Same drive + not escaping. Windows compares case-insensitively.
  const escaped =
    relBack === '..' ||
    relBack.startsWith('..' + path.sep) ||
    path.isAbsolute(relBack);
  if (escaped) throw new Error('Đường dẫn nằm ngoài project.');
  return abs;
}

export interface TreeEntry {
  name: string;
  /** Path RELATIVE to the project root, always forward slashes. */
  rel: string;
  type: 'dir' | 'file';
  size?: number;
}

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** One directory level, dirs first then files, each group A→Z (IntelliJ order). */
export async function listDir(root: string, rel: string): Promise<TreeEntry[]> {
  const abs = resolveInside(root, rel);
  const names = await fs.readdir(abs, { withFileTypes: true });
  const out: TreeEntry[] = [];
  for (const d of names) {
    const childAbs = path.join(abs, d.name);
    let type: TreeEntry['type'] = d.isDirectory() ? 'dir' : 'file';
    let size: number | undefined;
    if (d.isSymbolicLink()) {
      // Follow one hop so a linked folder still browses; a broken link lists as file.
      try {
        type = (await fs.stat(childAbs)).isDirectory() ? 'dir' : 'file';
      } catch {
        type = 'file';
      }
    }
    if (type === 'file') {
      try {
        size = (await fs.stat(childAbs)).size;
      } catch {
        /* races with deletes — keep listing */
      }
    }
    out.push({ name: d.name, rel: toRel(root, childAbs), type, size });
  }
  out.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  return out;
}

export interface ReadResult {
  content: string;
  /** Editor refuses binaries — flag lets the UI say why. */
  binary: boolean;
  size: number;
  /** mtime (epoch ms) at read — write passes it back for conflict detection. */
  mtime: number;
}

export async function readFileSafe(root: string, rel: string): Promise<ReadResult> {
  const abs = resolveInside(root, rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new Error('Đây là thư mục.');
  if (st.size > MAX_EDIT_SIZE) {
    throw new Error(`File quá lớn cho editor (${(st.size / 1024 / 1024).toFixed(1)} MB > 2 MB).`);
  }
  const buf = await fs.readFile(abs);
  const probe = buf.subarray(0, 8192);
  const binary = probe.includes(0);
  return {
    content: binary ? '' : buf.toString('utf8'),
    binary,
    size: st.size,
    mtime: st.mtimeMs,
  };
}

/**
 * Write with optimistic conflict check: nếu file trên đĩa đã đổi sau lần đọc
 * (mtime khác quá 1ms so với expectedMtime) thì từ chối — tránh Code Studio đè
 * lên thay đổi của Claude Code / IDE khác đang sửa cùng file.
 */
export async function writeFileSafe(
  root: string,
  rel: string,
  content: string,
  expectedMtime?: number,
): Promise<{ mtime: number }> {
  const abs = resolveInside(root, rel);
  if (expectedMtime !== undefined) {
    try {
      const st = await fs.stat(abs);
      if (Math.abs(st.mtimeMs - expectedMtime) > 1) {
        throw new Error('File đã bị thay đổi bên ngoài từ lần mở — tải lại (⟳) rồi sửa tiếp.');
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // file mới tạo → cho ghi
    }
  }
  await fs.writeFile(abs, content, 'utf8');
  const st = await fs.stat(abs);
  return { mtime: st.mtimeMs };
}

export async function createEntry(root: string, rel: string, kind: 'file' | 'dir'): Promise<void> {
  const abs = resolveInside(root, rel);
  if (kind === 'dir') {
    await fs.mkdir(abs, { recursive: true });
    return;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // 'wx' — fail thay vì lặng lẽ truncate file đang tồn tại.
  await fs.writeFile(abs, '', { encoding: 'utf8', flag: 'wx' });
}

/** Rename WITHIN the same parent folder (IntelliJ-style Shift+F6). */
export async function renameEntry(root: string, rel: string, newName: string): Promise<{ rel: string }> {
  if (!newName || /[\\/]/.test(newName)) throw new Error('Tên mới không hợp lệ.');
  const abs = resolveInside(root, rel);
  if (abs === path.resolve(root)) throw new Error('Không thể đổi tên thư mục gốc project.');
  const dest = path.join(path.dirname(abs), newName);
  resolveInside(root, toRel(root, dest)); // vẫn phải nằm trong root
  try {
    await fs.access(dest);
    throw new Error(`"${newName}" đã tồn tại.`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await fs.rename(abs, dest);
  return { rel: toRel(root, dest) };
}

export async function deleteEntry(root: string, rel: string): Promise<void> {
  const abs = resolveInside(root, rel);
  if (abs === path.resolve(root)) throw new Error('Không thể xóa thư mục gốc project.');
  await fs.rm(abs, { recursive: true, force: true });
}
