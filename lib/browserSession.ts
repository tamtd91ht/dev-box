// Cất & khôi phục PHIÊN LÀM VIỆC của tab Browser — đóng app rồi mở lại thì
// những trang CHƯA đóng hiện lại y như cũ, còn tab đã tự tay đóng thì thôi
// ("restore session" của trình duyệt). Browser-safe, không phụ thuộc React.
//
// Phần logic tách ra khỏi component vì đây là chỗ dễ sai mà lỗi lại ÂM THẦM:
// cất thiếu/thừa một field thì tab khôi phục dùng sai phiên đăng nhập, hoặc
// tệ hơn là mật khẩu bị rải xuống localStorage. Tách ra thì kiểm được bằng
// scripts/check-browser-session.ts thay vì phải đóng/mở app rồi ngồi đoán.

import { bmPartition } from './bookmarks';

/** Chỗ cất trong localStorage. */
export const TABS_KEY = 'devbox.browser.tabs';

/** Một tab đang mở, phần mà component quan tâm. */
export interface SessionTab {
  id: string;
  name: string;
  url: string;
  profile?: string;
  partition: string;
  creds?: { username?: string; password?: string };
  /** Tab ghim (như Chrome): luôn nằm đầu dải, chỉ hiện favicon. */
  pinned?: boolean;
}

/**
 * Một tab đã cất xuống localStorage. Hẹp hơn `SessionTab` một cách CÓ CHỦ Ý:
 *
 *  • KHÔNG có `creds`. Đó là user/pass lấy từ dấu trang, mà localStorage là
 *    plaintext — cất vào là rải mật khẩu ra một chỗ thứ hai ngoài
 *    configs/passwords.json (chỗ đó mã hoá bằng safeStorage). Tab khôi phục
 *    vẫn đăng nhập được: PasswordManager tự điền theo ORIGIN, không cần creds
 *    đi kèm tab.
 *  • KHÔNG có `partition` — dựng lại từ `profile` khi khôi phục, xem `restore`.
 *  • KHÔNG có `id` — chỉ là số thứ tự trong một phiên, cấp lại khi khôi phục.
 */
export interface SavedTab { name: string; url: string; profile?: string; pinned?: boolean }

export interface SavedSession { tabs: SavedTab[]; active: number }

/** Trần số tab cất lại. Người dùng để 200 tab mở rồi đóng app thì mở lại là
 *  dựng 200 <webview> một lúc — treo máy. Giữ các tab ĐẦU danh sách. */
const MAX_TABS = 30;

/**
 * Rút danh sách tab về đúng phần cất được, kèm vị trí tab đang xem.
 *
 * `active` cất theo VỊ TRÍ chứ không theo id, vì id được cấp lại khi khôi phục.
 * Không tìm thấy tab đang xem (đang ở trang new-tab, activeId = null) thì trả 0
 * — mở lại app thì nổi tab đầu, hợp lý hơn là không nổi tab nào.
 */
export function serialize(tabs: SessionTab[], activeId: string | null): SavedSession {
  const kept = tabs.slice(0, MAX_TABS);
  const at = kept.findIndex((t) => t.id === activeId);
  return {
    tabs: kept.map((t) => ({ name: t.name, url: t.url, profile: t.profile, ...(t.pinned ? { pinned: true } : {}) })),
    active: at >= 0 ? at : 0,
  };
}

/**
 * Dựng lại danh sách tab từ dữ liệu đã cất.
 *
 * @param nextId Cấp id mới cho từng tab. Component truyền hàm tăng tabSeqRef —
 *        PHẢI cấp mới, giữ nguyên id cũ thì bộ đếm của phiên mới vẫn ở 0 và
 *        tab mở thêm sau đó sẽ trùng id với tab vừa khôi phục.
 * @returns `active` là id của tab cần nổi (null nếu không khôi phục được gì).
 */
export function restore(
  raw: string | null,
  nextId: () => string,
  hostOf: (url: string) => string,
): { tabs: SessionTab[]; active: string | null } {
  let saved: Partial<SavedSession> | null = null;
  try {
    saved = raw ? (JSON.parse(raw) as Partial<SavedSession>) : null;
  } catch {
    // JSON hỏng (ghi dở lúc app bị kill…) — mở bàn trắng, không phải lỗi đáng kêu.
    return { tabs: [], active: null };
  }

  const rows = (Array.isArray(saved?.tabs) ? saved.tabs : [])
    .filter((t): t is SavedTab => !!t && typeof t.url === 'string' && /^https?:\/\//i.test(t.url))
    .slice(0, MAX_TABS);
  if (!rows.length) return { tabs: [], active: null };

  const tabs: SessionTab[] = rows.map((t) => {
    const profile = (typeof t.profile === 'string' && t.profile.trim()) ? t.profile.trim() : undefined;
    return {
      id: nextId(),
      name: (typeof t.name === 'string' && t.name.trim()) ? t.name : hostOf(t.url),
      url: t.url,
      profile,
      // Dựng lại từ profile, KHÔNG đọc `partition` đã cất: hai giá trị phải
      // khớp nhau (bmPartition(profile)) và bản cất có thể đến từ bản app cũ
      // hơn — lệch một cái là tab khôi phục dùng SAI phiên đăng nhập.
      partition: bmPartition(profile),
      // creds không bao giờ khôi phục — xem ghi chú ở SavedTab.
      ...(t.pinned === true ? { pinned: true } : {}),
    };
  });
  // Tab ghim luôn đứng đầu — bản cất tay/cũ có thể lẫn thứ tự. Sắp ỔN ĐỊNH
  // (giữ thứ tự tương đối trong mỗi nhóm), vị trí `active` tính lại theo id.
  const at0 = saved?.active;
  const activeTab = (typeof at0 === 'number' && at0 >= 0 && at0 < tabs.length) ? tabs[at0] : tabs[0];
  tabs.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  return { tabs, active: activeTab.id };
}

/* ── Tab đã đóng gần đây (Ctrl+Shift+T) ──────────────────────────────────
   Như "Recently closed" của Chrome: đóng nhầm thì mở lại được, kể cả sau khi
   tắt app. Cùng luật với SavedTab — KHÔNG cất creds. */

export const CLOSED_KEY = 'devbox.browser.closed';

/** Một tab vừa đóng: đủ để mở lại đúng chỗ, đúng hồ sơ. */
export interface ClosedTab extends SavedTab {
  /** Vị trí trên dải tab lúc đóng — mở lại thì chèn về gần đó. */
  index: number;
  closedAt: number;
}

/** Trần danh sách — Chrome giữ 25. */
export const MAX_CLOSED = 25;

/** Thêm các tab vừa đóng vào ĐẦU danh sách (mới nhất trước). Trang không phải
 *  http(s) (trang trắng, chrome-extension://) thì bỏ — mở lại chẳng để làm gì. */
export function pushClosed(list: ClosedTab[], tabs: (SessionTab & { index: number })[], now = Date.now()): ClosedTab[] {
  const add = tabs
    .filter((t) => /^https?:\/\//i.test(t.url))
    .map((t): ClosedTab => ({
      name: t.name, url: t.url, profile: t.profile, index: t.index, closedAt: now,
      ...(t.pinned ? { pinned: true } : {}),
    }))
    // Đóng một loạt (đóng các tab khác) → tab cuối dải là tab "mới đóng nhất"
    // theo nghĩa Ctrl+Shift+T mở lại theo thứ tự ngược.
    .reverse();
  return [...add, ...list].slice(0, MAX_CLOSED);
}

/** Đọc danh sách đã cất; JSON hỏng/thiếu field thì bỏ dòng đó, không ném lỗi. */
export function parseClosed(raw: string | null): ClosedTab[] {
  try {
    const arr = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((t): t is ClosedTab => !!t && typeof (t as ClosedTab).url === 'string'
        && /^https?:\/\//i.test((t as ClosedTab).url))
      .map((t) => ({
        name: typeof t.name === 'string' ? t.name : '',
        url: t.url,
        profile: typeof t.profile === 'string' && t.profile.trim() ? t.profile.trim() : undefined,
        index: typeof t.index === 'number' && t.index >= 0 ? t.index : 0,
        closedAt: typeof t.closedAt === 'number' ? t.closedAt : 0,
        ...(t.pinned === true ? { pinned: true } : {}),
      }))
      .slice(0, MAX_CLOSED);
  } catch { return []; }
}
