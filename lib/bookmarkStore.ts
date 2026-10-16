// Per-machine store cho tab Browser — dấu trang (bookmark) để chọn nhanh khỏi
// gõ lại URL, kèm profile session + user/pass tự điền. Tách khỏi Links (Links =
// bookmark tài liệu có tổ chức; Browser = trình duyệt phiên làm việc + dấu
// trang truy cập nhanh). File configs/bookmarks.json gitignored.
//
// CÂY THƯ MỤC (như Chrome): mỗi mục có `parentId` trỏ tới thư mục cha, và
// `kind` phân biệt link với folder. Gốc cây là parentId = undefined.
//
// VÌ SAO PHẲNG + parentId CHỨ KHÔNG LỒNG NHAU: file cũ là một mảng phẳng và
// đang có dữ liệu thật của người dùng. Giữ nguyên hình dạng mảng thì bản cũ
// đọc file mới vẫn thấy đủ link (chỉ không hiểu folder), và mọi thao tác
// (thêm/xoá/di chuyển) vẫn là sửa một phần tử — không phải đi bộ cả cây rồi
// ghi lại. Chuyển sang cấu trúc lồng nhau chỉ để trông "giống cây" là đổi lấy
// rủi ro mất dữ liệu mà không được gì.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';
import { defaultScheme } from './bookmarks';

export type BookmarkKind = 'link' | 'folder';

export interface Bookmark {
  id: string;
  name: string;
  /** Rỗng với folder. */
  url: string;
  kind: BookmarkKind;
  /** undefined = nằm ở gốc cây. */
  parentId?: string;
  /** Thứ tự trong cùng một thư mục, nhỏ hơn đứng trước. */
  order: number;
  /** Hồ sơ SỞ HỮU mục này (như Chrome: mỗi hồ sơ một bộ dấu trang riêng) —
   *  cũng là phiên đăng nhập dùng khi mở. undefined = hồ sơ Mặc định. Áp cho
   *  CẢ thư mục: con luôn cùng hồ sơ với thư mục cha (xem profKey). */
  profile?: string;
  /** Tài khoản site (optional) — nút 🔑 tự điền form login. */
  username?: string;
  password?: string;
  addedAt: string;
}

export type BookmarkMeta = Partial<Omit<Bookmark, 'id' | 'addedAt' | 'kind'>>;

const REG_PATH = process.env.BOOKMARKS_PATH ? path.resolve(process.cwd(), process.env.BOOKMARKS_PATH) : configPath('bookmarks.json', ['.bookmarks.json']);

/**
 * Đọc file và NÂNG CẤP các bản ghi cũ ngay lúc đọc.
 *
 * Dấu trang tạo trước khi có cây không có `kind`/`order`/`parentId`. Điền mặc
 * định ở đây — kind='link', nằm ở gốc, order theo đúng thứ tự đang có — nên
 * dữ liệu cũ hiện nguyên vẹn ở gốc cây, không mất và không phải chạy migration
 * riêng. Ghi lại chỉ xảy ra ở lần sửa đầu tiên.
 */
async function readAll(): Promise<Bookmark[]> {
  try {
    const d = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as { bookmarks?: Partial<Bookmark>[] };
    const raw = Array.isArray(d.bookmarks) ? d.bookmarks : [];
    return raw
      .filter((b): b is Partial<Bookmark> & { id: string } => typeof b?.id === 'string')
      .map((b, i) => ({
        id: b.id,
        name: typeof b.name === 'string' ? b.name : '',
        url: typeof b.url === 'string' ? b.url : '',
        kind: b.kind === 'folder' ? 'folder' : 'link',
        parentId: typeof b.parentId === 'string' && b.parentId ? b.parentId : undefined,
        order: typeof b.order === 'number' ? b.order : i,
        profile: b.profile || undefined,
        username: b.username || undefined,
        password: b.password || undefined,
        addedAt: typeof b.addedAt === 'string' ? b.addedAt : new Date().toISOString(),
      }));
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

/**
 * Khoá so sánh hồ sơ. Ref lưu trong file có thể là id ('p-abc123'), tên gõ tay
 * từ trước ('Work A') hoặc rỗng — quy về cùng slug như findProfile phía client
 * để 'Work A' và 'work-a' là một hồ sơ; '' và 'default' đều là Mặc định.
 */
function profKey(ref?: string): string {
  const s = (ref ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s === 'default' ? '' : s;
}

/** Đổi hồ sơ của một mục và CẢ NHÁNH bên dưới nó — thư mục mà con nằm ở hồ sơ
 *  khác thì con bị mồ côi: hồ sơ cũ không thấy cha, hồ sơ mới không thấy con. */
function setProfileDeep(list: Bookmark[], b: Bookmark, profile?: string): void {
  b.profile = profile;
  if (b.kind === 'folder') for (const id of descendants(list, b.id)) {
    const c = list.find((x) => x.id === id);
    if (c) c.profile = profile;
  }
}

/** Số thứ tự kế tiếp trong một thư mục — mục mới xuống cuối. */
function nextOrder(list: Bookmark[], parentId?: string): number {
  const sib = list.filter((b) => b.parentId === parentId);
  return sib.length ? Math.max(...sib.map((b) => b.order)) + 1 : 0;
}

/** parentId hợp lệ = trỏ tới một FOLDER đang tồn tại (hoặc gốc). */
function validParent(list: Bookmark[], parentId?: string): string | undefined {
  if (!parentId) return undefined;
  const p = list.find((b) => b.id === parentId);
  return p && p.kind === 'folder' ? p.id : undefined;
}

export async function listBookmarks(): Promise<Bookmark[]> { return readAll(); }

export async function addBookmark(input: { url: string } & BookmarkMeta): Promise<Bookmark[]> {
  const url = normalizeUrl(input.url);
  if (!/^https?:\/\//i.test(url)) throw new Error('URL không hợp lệ.');
  const list = await readAll();
  const parentId = validParent(list, input.parentId);
  const name = (input.name ?? '').trim() || (() => { try { return new URL(url).hostname; } catch { return url; } })();
  // Nằm trong thư mục thì theo hồ sơ của thư mục — không để con lệch cha.
  const parent = parentId ? list.find((b) => b.id === parentId) : undefined;
  list.push({
    id: randomUUID(), name, url, kind: 'link', parentId,
    order: nextOrder(list, parentId),
    profile: parent ? parent.profile : (input.profile ?? '').trim() || undefined,
    username: (input.username ?? '').trim() || undefined,
    password: input.password || undefined,
    addedAt: new Date().toISOString(),
  });
  await writeAll(list);
  return list;
}

export async function addFolder(name: string, parentId?: string, profile?: string): Promise<Bookmark[]> {
  const n = name.trim();
  if (!n) throw new Error('Tên thư mục không được để trống.');
  const list = await readAll();
  const pid = validParent(list, parentId);
  const parent = pid ? list.find((b) => b.id === pid) : undefined;
  list.push({
    id: randomUUID(), name: n, url: '', kind: 'folder', parentId: pid,
    order: nextOrder(list, pid),
    profile: parent ? parent.profile : (profile ?? '').trim() || undefined,
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
  if (patch.url !== undefined && patch.url.trim() && b.kind === 'link') b.url = normalizeUrl(patch.url);
  if (patch.profile !== undefined && profKey(patch.profile) !== profKey(b.profile)) {
    // Chuyển sang hồ sơ khác = chuyển sang BỘ dấu trang khác: rời thư mục cũ
    // (thư mục đó thuộc hồ sơ cũ) và xuống cuối gốc của hồ sơ mới.
    setProfileDeep(list, b, patch.profile.trim() || undefined);
    b.parentId = undefined;
    b.order = nextOrder(list.filter((x) => x.id !== b.id), undefined);
  }
  if (patch.username !== undefined) b.username = patch.username.trim() || undefined;
  if (patch.password !== undefined) b.password = patch.password || undefined;
  await writeAll(list);
  return list;
}

/** Mọi hậu duệ của một thư mục — dùng để xoá cả cây, và để chặn kéo vòng. */
function descendants(list: Bookmark[], rootId: string): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const b of list) {
      if (b.parentId === pid && !out.has(b.id)) { out.add(b.id); walk(b.id); }
    }
  };
  walk(rootId);
  return out;
}

/**
 * Di chuyển một mục sang thư mục khác, và/hoặc đổi vị trí trong thư mục đó.
 *
 * `beforeId` = thả NGAY TRƯỚC mục đó; bỏ trống thì xuống cuối.
 */
export async function moveBookmark(id: string, parentId?: string, beforeId?: string): Promise<Bookmark[]> {
  const list = await readAll();
  const b = list.find((x) => x.id === id);
  if (!b) throw new Error('Không tìm thấy mục cần di chuyển.');

  const pid = validParent(list, parentId);

  // KHÔNG cho thả một thư mục vào chính nó hoặc vào con cháu của nó — cây sẽ
  // đứt khỏi gốc và cả nhánh biến mất khỏi giao diện dù dữ liệu vẫn nằm trong
  // file. Đây là ca dễ gặp nhất khi kéo thả.
  if (b.kind === 'folder' && pid) {
    if (pid === b.id) throw new Error('Không thể thả một thư mục vào chính nó.');
    if (descendants(list, b.id).has(pid)) throw new Error('Không thể thả một thư mục vào thư mục con của nó.');
  }

  b.parentId = pid;
  // Thả vào thư mục thì nhận hồ sơ của thư mục (giao diện chỉ hiện một hồ sơ
  // nên thường đã trùng — đây là chốt chặn cho dữ liệu sửa tay/gọi API thẳng).
  const parent = pid ? list.find((x) => x.id === pid) : undefined;
  if (parent && profKey(parent.profile) !== profKey(b.profile)) setProfileDeep(list, b, parent.profile);

  // Đánh lại số thứ tự cho cả thư mục đích: chèn `b` vào đúng chỗ rồi cấp số
  // 0,1,2… Cách này tránh hẳn chuyện số trùng nhau sau nhiều lần kéo thả.
  const sib = list.filter((x) => x.parentId === pid && x.id !== id).sort((x, y) => x.order - y.order);
  const at = beforeId ? sib.findIndex((x) => x.id === beforeId) : -1;
  const ordered = at >= 0 ? [...sib.slice(0, at), b, ...sib.slice(at)] : [...sib, b];
  ordered.forEach((x, i) => { x.order = i; });

  await writeAll(list);
  return list;
}

/** Xoá một mục. Với thư mục thì xoá CẢ nhánh bên trong. */
export async function removeBookmark(id: string): Promise<Bookmark[]> {
  const list = await readAll();
  const kill = new Set<string>([id, ...descendants(list, id)]);
  const next = list.filter((b) => !kill.has(b.id));
  await writeAll(next);
  return next;
}

/** Chuyển TOÀN BỘ dấu trang của một hồ sơ sang hồ sơ khác (giữ nguyên cây) —
 *  dùng khi xoá hồ sơ, để dấu trang không mất theo. Đổi đồng loạt trong một lần
 *  ghi chứ không gọi updateBookmark từng mục: update tách mục khỏi thư mục cha
 *  khi cha còn ở hồ sơ cũ, làm từng mục là cả cây bị dàn phẳng. */
export async function reassignProfile(from: string, to?: string): Promise<Bookmark[]> {
  const list = await readAll();
  const k = profKey(from);
  const target = (to ?? '').trim() || undefined;
  for (const b of list) if (profKey(b.profile) === k) b.profile = target;
  await writeAll(list);
  return list;
}
