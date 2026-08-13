// Per-machine store cho tab Browser — dấu trang (bookmark) để chọn nhanh khỏi
// gõ lại URL, kèm profile session + user/pass tự điền. Tách khỏi Links (Links =
// bookmark tài liệu có tổ chức; Browser = trình duyệt phiên làm việc + dấu
// trang truy cập nhanh). File .bookmarks.json gitignored.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';
import { defaultScheme } from './bookmarks';

export interface Bookmark {
  id: string;
  name: string;
  url: string;
  /** Profile session — cùng profile chung cookie đăng nhập trong viewer. */
  profile?: string;
  /** Tài khoản site (optional) — nút 🔑 tự điền form login. */
  username?: string;
  password?: string;
  addedAt: string;
}

export type BookmarkMeta = Partial<Omit<Bookmark, 'id' | 'addedAt'>>;

const REG_PATH = process.env.BOOKMARKS_PATH ? path.resolve(process.cwd(), process.env.BOOKMARKS_PATH) : configPath('bookmarks.json', ['.bookmarks.json']);

async function readAll(): Promise<Bookmark[]> {
  try {
    const d = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as { bookmarks?: Bookmark[] };
    return Array.isArray(d.bookmarks) ? d.bookmarks : [];
  } catch { return []; }
}
async function writeAll(bookmarks: Bookmark[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ bookmarks }, null, 2), 'utf8');
}

/** Thêm scheme nếu người dùng gõ thiếu (nguyên nhân 404 hay gặp). Dùng chung
 *  defaultScheme với ô địa chỉ để mở và lưu không lệch nhau: gõ localhost:3000
 *  mà mở bằng http rồi lưu thành https thì lần sau bấm lại là hỏng. */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  const bare = s.replace(/^\/+/, '');
  return `${defaultScheme(bare.split(/[/?#]/)[0])}://${bare}`;
}

export async function listBookmarks(): Promise<Bookmark[]> { return readAll(); }

export async function addBookmark(input: { url: string } & BookmarkMeta): Promise<Bookmark[]> {
  const url = normalizeUrl(input.url);
  if (!/^https?:\/\//i.test(url)) throw new Error('URL không hợp lệ.');
  const list = await readAll();
  const name = (input.name ?? '').trim() || (() => { try { return new URL(url).hostname; } catch { return url; } })();
  list.unshift({
    id: randomUUID(), name, url,
    profile: (input.profile ?? '').trim() || undefined,
    username: (input.username ?? '').trim() || undefined,
    password: input.password || undefined,
    addedAt: new Date().toISOString(),
  });
  await writeAll(list);
  return list;
}

export async function updateBookmark(id: string, patch: BookmarkMeta): Promise<Bookmark[]> {
  const list = await readAll();
  const b = list.find((x) => x.id === id);
  if (!b) throw new Error('Không tìm thấy dấu trang.');
  if (patch.name !== undefined) b.name = patch.name.trim() || b.name;
  if (patch.url !== undefined && patch.url.trim()) b.url = normalizeUrl(patch.url);
  if (patch.profile !== undefined) b.profile = patch.profile.trim() || undefined;
  if (patch.username !== undefined) b.username = patch.username.trim() || undefined;
  if (patch.password !== undefined) b.password = patch.password || undefined;
  await writeAll(list);
  return list;
}

export async function removeBookmark(id: string): Promise<Bookmark[]> {
  const list = (await readAll()).filter((b) => b.id !== id);
  await writeAll(list);
  return list;
}
