// Sổ HỒ SƠ (profile) của tab Browser — như hồ sơ người dùng của Chrome.
// Browser-safe, không phụ thuộc React.
//
// Mỗi hồ sơ = MỘT phiên đăng nhập riêng (cookie, localStorage…), nên cùng một
// trang (Gmail, ChatGPT, Claude…) mở được bằng nhiều tài khoản song song.
//
// KHÔNG đổi quy ước partition. `Tab.profile` / `Bookmark.profile` vẫn là một
// chuỗi và partition vẫn là bmPartition(chuỗi) = `persist:browser-<slug>`; chuỗi
// ấy giờ là ID của hồ sơ trong sổ này. Nhờ vậy:
//   • các profile gõ tay trước đây tự thành hồ sơ (id = slug của tên cũ) và
//     GIỮ NGUYÊN phiên đăng nhập đã có — không ai phải đăng nhập lại;
//   • main.cjs (BROWSER_PARTITION, extension, xoá phiên…) không phải sửa gì;
//   • đổi TÊN hồ sơ chỉ đổi nhãn hiển thị, partition giữ nguyên.
// Hồ sơ mặc định có ref rỗng (`undefined`) ↔ `persist:browser-default`.

import { bmPartition } from './bookmarks';

export const PROFILES_KEY = 'devbox.browser.profiles';
export const CUR_PROFILE_KEY = 'devbox.browser.profile.cur';

/** id của hồ sơ mặc định trong sổ. Ref lưu ở tab/dấu trang cho nó là '' / undefined. */
export const DEFAULT_PROFILE_ID = 'default';

export interface BrowserProfile {
  /** Ổn định, slug an toàn — là phần đuôi của partition. */
  id: string;
  /** Nhãn hiển thị, sửa tự do. */
  name: string;
  color: string;
}

export const PROFILE_COLORS = [
  '#4f8cff', '#e5484d', '#30a46c', '#f5a524',
  '#a855f7', '#14b8a6', '#ec4899', '#8b8f98',
] as const;

export const slugOf = (s?: string): string =>
  (s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const colorByHash = (id: string): string => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PROFILE_COLORS[h % PROFILE_COLORS.length];
};

export const defaultProfile = (): BrowserProfile => ({
  id: DEFAULT_PROFILE_ID, name: 'Mặc định', color: PROFILE_COLORS[7],
});

/** Ref lưu ở tab/dấu trang ('' = mặc định) cho một hồ sơ. */
export const refOf = (p: BrowserProfile): string => (p.id === DEFAULT_PROFILE_ID ? '' : p.id);

export const partitionOfProfile = (p: BrowserProfile): string => bmPartition(refOf(p));

/**
 * Tìm hồ sơ theo ref. Ref không có trong sổ (dấu trang trỏ tới hồ sơ đã xoá,
 * file sửa tay…) vẫn trả về một hồ sơ "ảo" — tab đó vẫn mở được đúng phiên
 * `persist:browser-<slug>`, chỉ là chưa có tên/màu riêng.
 */
export function findProfile(list: BrowserProfile[], ref?: string): BrowserProfile {
  const slug = slugOf(ref);
  if (!slug || slug === DEFAULT_PROFILE_ID) return list.find((p) => p.id === DEFAULT_PROFILE_ID) ?? defaultProfile();
  return list.find((p) => p.id === slug)
    ?? { id: slug, name: (ref ?? slug).trim(), color: colorByHash(slug) };
}

/** Id mới cho hồ sơ tạo trong UI. Dạng `p-xxxxxx` — slug sẵn, không đụng profile cũ. */
export function newProfileId(existing: BrowserProfile[]): string {
  const taken = new Set(existing.map((p) => p.id));
  for (;;) {
    const id = `p-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id) && /^p-[a-z0-9]{6}$/.test(id)) return id;
  }
}

/** Màu chưa dùng đầu tiên — hồ sơ mới khác màu hồ sơ đang có cho dễ phân biệt. */
export function nextColor(existing: BrowserProfile[]): string {
  const used = new Set(existing.map((p) => p.color));
  return PROFILE_COLORS.find((c) => !used.has(c)) ?? PROFILE_COLORS[existing.length % PROFILE_COLORS.length];
}

/** Tên mặc định "Hồ sơ N" theo chỗ trống đầu tiên (xem lý do ở newAccount). */
export function nextName(existing: BrowserProfile[]): string {
  const taken = new Set(existing.map((p) => p.name.toLowerCase()));
  let n = 1;
  while (taken.has(`hồ sơ ${n}`)) n += 1;
  return `Hồ sơ ${n}`;
}

/** Đọc sổ đã lưu; luôn có hồ sơ mặc định ở đầu. Dữ liệu hỏng → chỉ còn mặc định. */
export function loadProfiles(raw: string | null): BrowserProfile[] {
  let arr: unknown = null;
  try { arr = raw ? JSON.parse(raw) : null; } catch { /* JSON hỏng */ }
  const seen = new Set<string>();
  const out: BrowserProfile[] = [];
  for (const p of Array.isArray(arr) ? arr : []) {
    const o = p as Partial<BrowserProfile> | null;
    if (!o || typeof o.id !== 'string' || !o.id || slugOf(o.id) !== o.id || seen.has(o.id)) continue;
    seen.add(o.id);
    out.push({
      id: o.id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : o.id,
      color: typeof o.color === 'string' && o.color ? o.color : colorByHash(o.id),
    });
  }
  const i = out.findIndex((p) => p.id === DEFAULT_PROFILE_ID);
  const def = i >= 0 ? out.splice(i, 1)[0] : defaultProfile();
  return [def, ...out];
}

/**
 * Nhập các tên profile gõ tay từ trước (dấu trang, tab đã lưu) vào sổ.
 * Không có gì mới thì trả về CHÍNH mảng cũ — để setState bỏ qua, không render
 * lại vô ích (và không lặp effect).
 */
export function mergeLegacy(list: BrowserProfile[], refs: Array<string | undefined>): BrowserProfile[] {
  let next = list;
  for (const ref of refs) {
    const name = (ref ?? '').trim();
    const id = slugOf(name);
    if (!id || id === DEFAULT_PROFILE_ID || next.some((p) => p.id === id)) continue;
    next = [...next, { id, name, color: nextColor(next) }];
  }
  return next;
}
