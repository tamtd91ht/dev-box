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
export interface SavedTab { name: string; url: string; profile?: string }

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
    tabs: kept.map((t) => ({ name: t.name, url: t.url, profile: t.profile })),
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
    };
  });

  const at = saved?.active;
  const active = (typeof at === 'number' && at >= 0 && at < tabs.length) ? tabs[at].id : tabs[0].id;
  return { tabs, active };
}
