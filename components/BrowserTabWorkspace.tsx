'use client';

// Browser workspace — trình duyệt web đa tab TRONG app: ô địa chỉ kiểu trình
// duyệt thật (URL thì tự thêm https://, KHÔNG phải URL thì tìm Google luôn),
// mở nhiều tab song song, mỗi tab gán PROFILE
// để đăng nhập nhiều tài khoản SSO/SaaS khác nhau. Dấu trang (bookmark) để
// chọn nhanh khỏi gõ lại + nhớ user/pass (nút 🔑 tự điền form login).
//
// Tách khỏi tab Links (Links = bookmark tài liệu có tổ chức, dự án/tags).
// Viewer tái dùng LinkViewer (webview + fill login + save session).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  bmList, bmAdd, bmAddFolder, bmMove, bmRemove, bmReassign, bmUpdate,
  normalizeUrl, bmPartition, bmTree, type Bookmark, type BmNode,
} from '@/lib/bookmarks';
import BrowserExtensions from './BrowserExtensions';
import BrowserExtBar from './BrowserExtBar';
import BookmarkBar from './BookmarkBar';
import LinkViewer, { type TabOpener, type TabMeta, type ViewerApi } from './LinkViewer';
import PasswordManager from './PasswordManager';
import DupTabDialog, { tabUrlKey } from './DupTabDialog';
import { onOpenUrl } from '@/lib/openTarget';
import PasswordInput from './PasswordInput';
import AddressSuggest, { useAddressSuggest } from './AddressSuggest';
import BrowserHistory from './BrowserHistory';
import {
  TABS_KEY, serialize as serializeSession, restore as restoreSession,
  CLOSED_KEY, pushClosed, parseClosed, type ClosedTab,
} from '@/lib/browserSession';
import { browserKeyOf, NEED_HOST_KEYS, type BrowserKey } from '@/lib/browserKeys';
import { faviconOf, hideTile, hiddenTiles, unhideAllTiles } from '@/lib/browserSiteData';
import { historyList } from '@/lib/browserHistory';
import { usePopupOverWebview } from '@/lib/useOverWebview';
import {
  PROFILES_KEY, CUR_PROFILE_KEY, DEFAULT_PROFILE_ID, loadProfiles, mergeLegacy, findProfile,
  defaultProfile, partitionOfProfile, refOf, slugOf, saveLastPages, loadLastPages, clearLastPages, MAX_RESTORE,
  type BrowserProfile,
} from '@/lib/browserProfiles';
import { ProfileButton, ProfileDot, ProfileManager, ProfileSelect } from './BrowserProfiles';

interface Tab {
  id: string; name: string; url: string; profile?: string; partition: string;
  creds?: { username?: string; password?: string };
  /** Tab ghim: đứng đầu dải, chỉ hiện favicon, không có nút ✕ (như Chrome). */
  pinned?: boolean;
  /** Tab này mở từ liên kết trong tab khác → ngữ cảnh tab cha (Referer +
   *  sessionStorage) để trang đích không mất bộ lọc/phân trang. Xem `TabOpener`
   *  trong LinkViewer. Chỉ dùng cho lần tải đầu của tab. */
  opener?: TabOpener;
}

/** Chuột phải trên một dấu trang → menu ngữ cảnh tại toạ độ con trỏ. */
interface Ctx { x: number; y: number; bm: Bookmark }

/** Chữ cái đầu của tên tab — hiện thay tên khi tab bị co hẹp tới mức không đủ chỗ. */
function tabInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? '•').toUpperCase();
}

/** Số thứ tự trong id `tab-N` — thứ tự TẠO tab, không đổi suốt đời tab. */
function tabSeq(id: string): number { return Number(id.slice(4)) || 0; }

/** Khoá so URL "cùng trang" (bỏ #fragment và / cuối) — đánh dấu ☆/★. */
function urlKey(url: string): string { return tabUrlKey('', normalizeUrl(url) || url); }

/** Ô lối tắt ở trang tab mới — một host hay ghé, mở URL ghé nhiều nhất của host đó. */
interface Tile { host: string; url: string; title: string; visits: number }

export default function BrowserTabWorkspace({ visible = true }: {
  /** Pane Browser đang hiện — phím tắt kiểu Chrome chỉ ăn khi đang nhìn thấy nó. */
  visible?: boolean;
} = {}) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [addr, setAddr] = useState('');
  /** Hồ sơ dùng cho tab MỚI (ref: '' = mặc định). Đi theo tab đang xem, và
   *  chọn từ nút avatar thì đổi sang hồ sơ đó. */
  const [profile, setProfile] = useState('');
  const [profiles, setProfiles] = useState<BrowserProfile[]>(() => [defaultProfile()]);
  const [profLoaded, setProfLoaded] = useState(false);
  const [profMenuOpen, setProfMenuOpen] = useState(false);
  const [profMgrOpen, setProfMgrOpen] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Bookmark | null>(null); // dấu trang đang sửa/tạo
  const [full, setFull] = useState(false); // tràn viền: che header app, webview cao tối đa
  /** Thanh dấu trang — MẶC ĐỊNH HIỆN, như Chrome.
   *
   *  Trước đây mặc định tắt, mà tính năng chính của nó là KÉO ĐỊA CHỈ THẢ VÀO:
   *  không hiện thanh thì không có chỗ nào để thả, người dùng kéo mãi không
   *  được và cũng không đoán ra vì sao.
   *
   *  Khởi tạo `true` rồi đọc lại localStorage trong effect: đọc thẳng ở đây sẽ
   *  lệch giữa server render và client (hydration mismatch). */
  const [showMarks, setShowMarks] = useState(true);
  /** Hộp thoại "thư mục mới": parentId = tạo bên trong thư mục nào (undefined =
   *  gốc); `pendingUrl` = URL vừa kéo xuống, tạo xong thì lưu luôn vào đó. */
  /** Nút ⋯ — cần rect của nó để đặt menu đã portal ra body. */
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [folderAsk, setFolderAsk] = useState<{
    parentId?: string; name: string;
    /** URL vừa kéo xuống — tạo thư mục xong thì lưu mới vào đó. */
    pendingUrl?: string;
    /** Mục SẴN CÓ cần chuyển vào thư mục mới (không tạo bản sao). */
    moveId?: string;
  } | null>(null);
  useEffect(() => {
    try {
      // RESET MỘT LẦN. Trước đây openBookmark() tự gọi setShowMarks(false), nên
      // rất dễ tưởng thanh "bị lỗi mất" rồi bấm công tắc trong menu ⋯ để thử —
      // và cái bấm đó ghi '0' xuống localStorage. Sửa xong phần logic thì giá
      // trị '0' cũ vẫn nằm đó và tiếp tục ẩn thanh qua mọi lần tải lại, kể cả
      // hard reload: người dùng thấy "sửa rồi mà vẫn thế". Cờ dưới đây bỏ đúng
      // MỘT lần lựa chọn cũ, sau đó tôn trọng lựa chọn mới bình thường.
      if (!localStorage.getItem('bt:marks:v2')) {
        localStorage.setItem('bt:marks:v2', '1');
        localStorage.removeItem('bt:marks');
        return;
      }
      if (localStorage.getItem('bt:marks') === '0') setShowMarks(false);
    } catch { /* localStorage bị chặn — cứ hiện */ }
  }, []);
  /** Đặt hiện/ẩn thanh dấu trang, nhớ lựa chọn qua các lần mở app. */
  const setMarks = useCallback((next: boolean) => {
    setShowMarks(next);
    try { localStorage.setItem('bt:marks', next ? '1' : '0'); } catch { /* bỏ qua */ }
  }, []);

  const toggleMarks = useCallback(() => {
    setShowMarks((v) => {
      const next = !v;
      try { localStorage.setItem('bt:marks', next ? '1' : '0'); } catch { /* bỏ qua */ }
      return next;
    });
  }, []);

  /** Menu chuột phải trên thanh chỉ hiện khi thanh đang bật, nên đây luôn là
   *  hành động ẨN — dùng setMarks(false) cho rõ ý, không dựa vào toggle. */
  const hideMarks = useCallback(() => setMarks(false), [setMarks]);

  const [histOpen, setHistOpen] = useState(false); // modal 🕘 Lịch sử (Ctrl+H)

  /* Ctrl+Shift+B (thanh dấu trang) và Ctrl+H (lịch sử) giờ đi chung bảng phím
     kiểu Chrome — xem runKey ở dưới và lib/browserKeys.ts. */
  const [menuOpen, setMenuOpen] = useState(false); // menu ⋯ (lưu/dấu trang/tràn viền)
  const [newTabOpen, setNewTabOpen] = useState(false); // panel nhập URL khi đã có tab
  const [ctx, setCtx] = useState<Ctx | null>(null); // menu chuột phải trên dấu trang
  /** Menu chuột phải trên MỘT TAB của dải tab (nhân đôi / đóng…). Giữ id chứ
   *  không giữ cả object Tab: tab có thể điều hướng trong lúc menu đang mở,
   *  tra lại theo id thì luôn nhân đôi ĐÚNG trang đang xem. */
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const [pwOpen, setPwOpen] = useState(false); // modal 🔑 Mật khẩu đã lưu
  const [extOpen, setExtOpen] = useState(false); // modal 🧩 Extension (chỉ tab Browser)
  /** Nonce tải lại THEO TỪNG TAB (nút ↻ trên thanh extension). Đổi `key` là
   *  React dựng <webview> mới → trang tải lại từ đầu → content script của
   *  extension được chèn lại. Không có cách nào nhẹ hơn: content script chỉ
   *  chèn vào lúc trang tải.
   *
   *  PHẢI lưu theo từng tab, KHÔNG được ghép nonce vào key của riêng tab đang
   *  active (`t.id === activeId ? id#nonce : id`): kiểu đó làm key đổi theo
   *  MỖI LẦN chuyển tab (được chọn thì thêm hậu tố, thôi chọn thì mất) — mà
   *  đổi key là unmount + mount lại, webview bị huỷ và tải lại từ src gốc.
   *  Hậu quả từng có thật: điều hướng trong tab A, sang tab B rồi quay lại
   *  thì A quay về trang mặc định ban đầu. */
  const [reloadNonces, setReloadNonces] = useState<Record<string, number>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Trạng thái hiển thị của từng tab (tiêu đề, favicon, đang tải, âm thanh,
   *  zoom) — LinkViewer báo lên qua onMeta. Tách khỏi `tabs` vì đổi rất dày
   *  (mỗi lần tải trang) mà không phải thứ cần cất xuống phiên. */
  const [meta, setMeta] = useState<Record<string, TabMeta>>({});
  /** Bộ điều khiển của từng viewer (phím tắt, menu ⋮ gọi vào). */
  const apisRef = useRef<Map<string, ViewerApi>>(new Map());
  /** Ô trống cuối hàng công cụ của từng viewer — cụm hồ sơ/extension/⋮ được
   *  portal vào ô của TAB ĐANG XEM cho giống hàng công cụ Chrome. Đổi ô thì
   *  tăng `slotTick` để render lại và portal sang đúng chỗ. */
  const slotsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  /** Ô ngay dưới hàng công cụ — thanh dấu trang portal vào đây. */
  const underSlotsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [, setSlotTick] = useState(0);
  /** Tab đã đóng gần đây (Ctrl+Shift+T) — nạp/cất localStorage như phiên tab. */
  const [closed, setClosed] = useState<ClosedTab[]>([]);
  const [tabSearchOpen, setTabSearchOpen] = useState(false);
  const tabSearchBtnRef = useRef<HTMLButtonElement | null>(null);
  /** Kéo thả sắp xếp tab: tab đang kéo + chỗ sẽ thả (trước/sau tab nào). */
  const dragTabRef = useRef<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /** Bộ đếm cấp id tab. Id KHÔNG còn dựng từ partition|url: id theo url nghĩa
   *  là không bao giờ mở được hai tab cùng một trang — mà so sánh hai bản ghi,
   *  hai môi trường cùng dashboard là nhu cầu thật. Id giờ chỉ là số thứ tự;
   *  chuyện "trang này mở chưa" do tabKeysRef trả lời. */
  const tabSeqRef = useRef(0);
  // Khoá trang (tabUrlKey) → id của tab ĐẦU TIÊN đang mở trang đó. Dựng lại từ
  // `tabs` mỗi lần đổi nên đóng tab / điều hướng không phải tự tay dọn map.
  const tabKeysRef = useRef<Map<string, string>>(new Map());
  /** Trang vừa mở trong ~2s — OpenLinkDialog phát cùng một event HAI LẦN (lo
   *  tab vừa mount chưa kịp nghe), không có mốc này thì cú thứ hai sẽ bật hộp
   *  thoại "đang mở sẵn" ngay trên trang người dùng vừa mở. */
  const recentOpenRef = useRef<{ key: string; at: number; id: string } | null>(null);
  /* ── Nhớ các tab đang mở qua localStorage ────────────────────────────────
     Đóng app rồi mở lại thì những trang CHƯA đóng hiện lại y như cũ, còn tab
     đã tự tay đóng thì thôi — như "restore session" của trình duyệt.

     Phần rút gọn/dựng lại nằm ở lib/browserSession.ts (kiểm bằng
     scripts/check-browser-session.ts): ở đó mới thấy rõ những gì KHÔNG được
     cất — nhất là `creds`, vì localStorage là plaintext. */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const { tabs: restored, active } = restoreSession(
        localStorage.getItem(TABS_KEY),
        () => `tab-${++tabSeqRef.current}`,
        hostOf,
      );
      if (restored.length) { setTabs(restored); setActiveId(active); }
      setClosed(parseClosed(localStorage.getItem(CLOSED_KEY)));
    } catch { /* localStorage bị chặn — mở bàn trắng, không phải lỗi đáng kêu */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(CLOSED_KEY, JSON.stringify(closed)); } catch { /* đầy thì thôi */ }
  }, [hydrated, closed]);

  /* Cờ `hydrated` là STATE chứ không phải ref, và effect ghi phải chờ nó —
     cùng lý do đã ghi ở ApiWorkspace: đánh dấu bằng ref thì ngay trong lượt
     commit đó, effect ghi chạy sau effect nạp nhưng vẫn nắm `tabs` CŨ (rỗng)
     và sẽ đè rỗng lên đúng thứ vừa khôi phục. */
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(serializeSession(tabs, activeId)));
    } catch { /* đầy thì thôi */ }
  }, [hydrated, tabs, activeId]);

  /** Hộp thoại "trang đang mở sẵn — chuyển tới hay mở thêm?". */
  const [dupAsk, setDupAsk] = useState<{
    url: string; name?: string; profile?: string; creds?: Tab['creds'];
    existingId: string; existingName: string;
  } | null>(null);
  // Ảnh chụp mới nhất của tabs/activeId — listener IPC (đăng ký MỘT lần) đọc ra
  // để biết tab nào đang xem, khỏi phải gỡ/gắn lại mỗi lần đổi tab.
  const tabsRef = useRef<Tab[]>([]);
  const activeRef = useRef<string | null>(null);
  // openTab được useCallback([]) nên đọc state qua ref, không qua closure.
  const newTabOpenRef = useRef(false);
  tabsRef.current = tabs;
  activeRef.current = activeId;
  newTabOpenRef.current = newTabOpen;

  // Map "trang → tab đang mở" đi theo danh sách tab, mọi đường thay đổi
  // (mở/đóng/điều hướng qua popup extension) đều được phủ ở một chỗ.
  useEffect(() => {
    const m = new Map<string, string>();
    for (const t of tabs) {
      const k = tabUrlKey(t.partition, t.url);
      if (!m.has(k)) m.set(k, t.id);
    }
    tabKeysRef.current = m;
  }, [tabs]);

  // Esc thoát tràn viền (chỉ host document; phím trong guest không bubble ra).
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  // Click bất kỳ đâu (hoặc chuột phải chỗ khác) → đóng menu ngữ cảnh.
  useEffect(() => {
    if (!ctx && !tabCtx) return;
    const close = () => { setCtx(null); setTabCtx(null); };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close, true);
    };
  }, [ctx, tabCtx]);

  const reload = useCallback(() => { bmList().then(setBookmarks).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { reload(); }, [reload]);

  /* ── Sổ hồ sơ ───────────────────────────────────────────────────────────
     Nạp sau mount (đọc localStorage ngay ở useState sẽ lệch SSR/client). Effect
     nạp phải đứng TRƯỚC effect gộp: hai cái cùng chạy ở lượt mount và gộp dùng
     setState dạng hàm nên nhận đúng giá trị vừa nạp. */
  useEffect(() => {
    try {
      setProfiles(loadProfiles(localStorage.getItem(PROFILES_KEY)));
      const cur = slugOf(localStorage.getItem(CUR_PROFILE_KEY) ?? '');
      setProfile(cur === DEFAULT_PROFILE_ID ? '' : cur);
    } catch { /* localStorage bị chặn — chỉ có hồ sơ mặc định */ }
    setProfLoaded(true);
  }, []);

  // Profile gõ tay từ trước (dấu trang, tab khôi phục) tự thành hồ sơ — cùng id
  // nên phiên đăng nhập cũ giữ nguyên.
  useEffect(() => {
    const refs = [...bookmarks.map((b) => b.profile), ...tabs.map((t) => t.profile)];
    setProfiles((cur) => mergeLegacy(cur, refs));
  }, [bookmarks, tabs]);

  useEffect(() => {
    if (!profLoaded) return;
    try { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)); } catch { /* đầy thì thôi */ }
  }, [profLoaded, profiles]);

  useEffect(() => {
    if (!profLoaded) return;
    try { localStorage.setItem(CUR_PROFILE_KEY, profile); } catch { /* bỏ qua */ }
  }, [profLoaded, profile]);

  // Chuyển sang xem một tab → hồ sơ "hiện tại" theo tab đó, để tab mới mở từ
  // đây dùng chung tài khoản (đang ở Gmail của hồ sơ B thì ＋ cũng là hồ sơ B).
  useEffect(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t) setProfile(t.profile ?? '');
  }, [activeId]);

  const currentProfile = findProfile(profiles, profile);
  /** Hồ sơ hiện tại cho các callback nghe sự kiện từ NGOÀI (link từ Zalo,
   *  popup extension…) — đọc qua ref để khỏi đăng ký lại listener mỗi lần đổi
   *  hồ sơ. Gán ngay trong render nên luôn là giá trị mới nhất. */
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const labelOf = useCallback((ref?: string) => findProfile(profiles, ref).name, [profiles]);

  /** Dấu trang CỦA HỒ SƠ ĐANG DÙNG — như Chrome, mỗi hồ sơ một bộ riêng; đổi
   *  hồ sơ là đổi cả thanh dấu trang. So theo id qua findProfile để ref cũ gõ
   *  tay ('Work A') vẫn khớp hồ sơ 'work-a'. `bookmarks` vẫn giữ đủ mọi hồ sơ
   *  vì store trả về cả danh sách sau mỗi thao tác. */
  const marks = useMemo(
    () => bookmarks.filter((b) => findProfile(profiles, b.profile).id === currentProfile.id),
    [bookmarks, profiles, currentProfile.id],
  );
  /** Ref của hồ sơ đang dùng — gắn vào dấu trang/thư mục tạo mới. */
  const curRef = refOf(currentProfile);

  // Nhớ các trang gần nhất (tối đa MAX_RESTORE) của từng hồ sơ có tab đang mở —
  // để lần sau chuyển về hồ sơ đó còn biết mở lại những trang nào. Hồ sơ không
  // còn tab nào thì giữ nguyên bản đã nhớ (không ghi đè bằng rỗng).
  useEffect(() => {
    if (!profLoaded) return;
    const byProf = new Map<string, Tab[]>();
    for (const t of tabs) {
      if (!/^https?:\/\//i.test(t.url)) continue;
      const id = findProfile(profiles, t.profile).id;
      byProf.set(id, [...(byProf.get(id) ?? []), t]);
    }
    for (const [id, list] of byProf) {
      // Ưu tiên tab đang xem, rồi tới các tab cuối danh sách (mới mở nhất).
      const act = list.find((t) => t.id === activeId);
      const rest = list.filter((t) => t !== act).slice(-(MAX_RESTORE - (act ? 1 : 0)));
      const picked = act ? [act, ...rest] : rest;
      saveLastPages(id, { pages: picked.map((t) => ({ url: t.url, name: t.name })), active: 0 });
    }
  }, [profLoaded, profiles, tabs, activeId]);

  /** Chọn hồ sơ từ nút avatar = ĐỔI HỒ SƠ, như chuyển cửa sổ hồ sơ của Chrome:
   *  đóng hết tab hiện có (huỷ <webview> cho nhẹ máy) rồi mở lại tối đa
   *  MAX_RESTORE trang gần nhất của hồ sơ đích, chưa có thì để trang trắng.
   *  Chọn lại chính hồ sơ đang dùng chỉ mở trang tab mới. */
  const pickProfile = (p: BrowserProfile) => {
    if (p.id === currentProfile.id) { openNewTabPage(); return; }
    setTabs([]);
    setActiveId(null);
    setNewTabOpen(false);
    setAddr('');
    setProfile(refOf(p));
    const last = loadLastPages(p.id);
    if (!last) return;
    // Tab đang xem mở sau cùng (không background) để nó là tab nổi; các tab còn
    // lại mở nền, theo thứ tự đã nhớ.
    last.pages.forEach((pg, i) => {
      if (i === last.active) return;
      openTab(pg.url, { name: pg.name || undefined, profile: refOf(p), forceNew: true, background: true });
    });
    const cur = last.pages[last.active];
    if (cur) openTab(cur.url, { name: cur.name || undefined, profile: refOf(p), forceNew: true });
  };

  const tabCounts = tabs.reduce<Record<string, number>>((m, t) => {
    const id = findProfile(profiles, t.profile).id;
    m[id] = (m[id] ?? 0) + 1;
    return m;
  }, {});

  /** Xoá cookie/dữ liệu của hồ sơ. Đóng tab đang dùng nó trước, chờ một nhịp để
   *  Electron huỷ hẳn <webview> (xem BrowserWorkspace.pendingWipe) rồi mới xoá —
   *  xoá khi guest còn chạy thì trang ghi lại cookie ngay sau đó. */
  const wipeProfile = useCallback(async (p: BrowserProfile) => {
    setTabs((cur) => {
      const next = cur.filter((t) => findProfile(profiles, t.profile).id !== p.id);
      setActiveId((a) => (cur.some((t) => t.id === a && !next.includes(t)) ? next[next.length - 1]?.id ?? null : a));
      if (next.length === 0) setNewTabOpen(false);
      return next;
    });
    await new Promise((r) => setTimeout(r, 350));
    const res = await window.workspace?.clearSession(partitionOfProfile(p));
    if (res && !res.ok) setErr(`Không xoá được phiên "${p.name}": ${res.error ?? 'lỗi không rõ'}`);
  }, [profiles]);

  const signOutProfile = (p: BrowserProfile) => {
    if (!window.confirm(`Đăng xuất hồ sơ "${p.name}"? Xoá cookie/dữ liệu trang của hồ sơ này và đóng các tab đang dùng nó.`)) return;
    clearLastPages(p.id);
    void wipeProfile(p);
  };

  const deleteProfile = async (p: BrowserProfile) => {
    if (p.id === DEFAULT_PROFILE_ID) return;
    if (!window.confirm(`Xoá hồ sơ "${p.name}"? Toàn bộ phiên đăng nhập của nó bị xoá và các tab đang dùng nó bị đóng. Dấu trang của hồ sơ này sẽ chuyển sang hồ sơ Mặc định.`)) return;
    setProfiles((cur) => cur.filter((x) => x.id !== p.id));
    if (slugOf(profile) === p.id) setProfile('');
    // Bộ dấu trang của hồ sơ vừa xoá → gộp sang Mặc định (giữ nguyên cây thư
    // mục), khỏi mất trắng và khỏi mở ra một phiên trắng không tên.
    try { setBookmarks(await bmReassign(p.id, '')); } catch (e) { setErr((e as Error).message); }
    clearLastPages(p.id);
    await wipeProfile(p);
  };

  /**
   * Mở một URL thành tab.
   *
   * TRÙNG trang (cùng partition + URL) thì KHÔNG âm thầm nhảy về tab cũ nữa:
   *   · mở chủ động (bookmark, ô địa chỉ, popup extension) → HỎI qua hộp thoại
   *     "chuyển tới tab đã mở hay mở thêm tab mới?" — hai tab cùng một trang
   *     là nhu cầu thật (so hai bản ghi, hai môi trường cùng dashboard);
   *   · background (window.open/_blank trong trang) → mở thêm tab luôn, đúng
   *     hành vi trình duyệt thật, không hỏi;
   *   · cùng event bị phát lặp trong ~2s (OpenLinkDialog bắn hai lần) → coi là
   *     tiếng vọng, chỉ kích hoạt tab vừa mở.
   *  `forceNew` = người dùng đã chọn "Mở thêm tab mới" trong hộp thoại.
   */
  const openTab = useCallback((rawUrl: string, opts: {
    name?: string; profile?: string; creds?: Tab['creds']; background?: boolean; forceNew?: boolean;
    opener?: TabOpener;
    /** Chèn vào vị trí này thay vì cuối dải (mở lại tab đã đóng về chỗ cũ). */
    at?: number;
    pinned?: boolean;
  } = {}) => {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    if (typeof window === 'undefined' || !window.workspace?.isDesktop) { window.open(url, '_blank'); return; }
    const prof = (opts.profile ?? '').trim() || undefined;
    const partition = bmPartition(prof);
    const key = tabUrlKey(partition, url);

    if (!opts.forceNew) {
      const recent = recentOpenRef.current;
      if (recent && recent.key === key && Date.now() - recent.at < 2000) {
        if (!opts.background) { setActiveId(recent.id); setNewTabOpen(false); }
        return;
      }
      const existingId = tabKeysRef.current.get(key);
      if (existingId && !opts.background) {
        const existing = tabsRef.current.find((t) => t.id === existingId);
        setDupAsk({
          url, name: opts.name, profile: prof, creds: opts.creds,
          existingId, existingName: existing?.name ?? hostOf(url),
        });
        return;
      }
    }

    const id = `tab-${++tabSeqRef.current}`;
    recentOpenRef.current = { key, at: Date.now(), id };
    setTabs((cur) => {
      const tab: Tab = {
        id, name: opts.name || hostOf(url), url, profile: prof, partition, creds: opts.creds,
        opener: opts.opener, ...(opts.pinned ? { pinned: true } : {}),
      };
      // Tab ghim luôn đứng trong nhóm ghim, tab thường luôn đứng sau nhóm đó —
      // kẹp vị trí chèn cho khỏi lẫn hai nhóm.
      const nPinned = cur.filter((t) => t.pinned).length;
      let at = opts.at ?? cur.length;
      at = tab.pinned ? Math.min(at, nPinned) : Math.max(Math.min(at, cur.length), nPinned);
      return [...cur.slice(0, at), tab, ...cur.slice(at)];
    });
    // Tab mới ở chế độ background: giữ nguyên tab đang xem, trừ khi chưa có
    // tab nào nổi thì đưa lên cho khỏi bấm mò.
    //
    // `newTabOpenRef`: đang ở trang new-tab thì activeId = null một cách CÓ CHỦ
    // Ý, không phải "chưa có gì để xem" — kéo tab nền lên lúc này là hất người
    // dùng khỏi ô địa chỉ họ đang gõ dở.
    if (!opts.background) { setActiveId(id); setNewTabOpen(false); }
    else setActiveId((a) => (a === null && !newTabOpenRef.current ? id : a));
  }, []);

  // Link bấm trong tin nhắn Zalo/Telegram đã chọn "Mở trong Browser của app".
  // OpenLinkDialog phát event hai lần (lo tab vừa mount chưa kịp nghe); cú thứ
  // hai bị openTab nhận diện là tiếng vọng (recentOpenRef) nên vô hại.
  //
  // Mở bằng HỒ SƠ ĐANG DÙNG — như Chrome nhận link từ app khác vào cửa sổ
  // đang mở, chứ không phải lúc nào cũng hồ sơ Mặc định. Chỉ đăng ký SAU KHI
  // nạp xong hồ sơ: link bấm lúc Browser chưa mount nằm chờ trong openTarget,
  // nếu nghe ngay ở lượt mount thì nó bị mở bằng '' trước khi kịp đọc hồ sơ
  // đã lưu. Chờ thêm không mất gì — yêu cầu chờ vẫn còn đó.
  useEffect(() => {
    if (!profLoaded) return;
    return onOpenUrl('browser', (u) => openTab(u, { profile: profileRef.current }));
  }, [openTab, profLoaded]);

  // Link target=_blank / window.open bấm TRONG một tab → tab MỚI ngay ở đây,
  // như trình duyệt thật (main.cjs, nhánh BROWSER_PARTITION). Mở nền: trang
  // đang xem giữ nguyên, đúng thói quen "mở ngầm rồi đọc sau".
  // Profile lấy theo tab đang hoạt động để tab con dùng chung phiên đăng nhập.
  useEffect(() => {
    if (!window.workspace?.onOpenInBrowserTab) return;
    return window.workspace.onOpenInBrowserTab(({ url, opener, session }) => {
      const from = tabsRef.current.find((t) => t.id === activeRef.current);
      // Ngữ cảnh tab cha (main.cjs đọc sẵn): tab con dựng lại Referer +
      // sessionStorage, nếu không thì trang phân trang/bộ lọc mở ra rỗng.
      // Không có `opener` (main cũ) → mở như trước, chỉ mất phần khôi phục.
      openTab(url, {
        profile: from?.profile,
        background: true,
        opener: opener ? { url: opener, session: session ?? [] } : undefined,
      });
    });
  }, [openTab]);

  /** Ghi các tab sắp đóng vào "đã đóng gần đây" (Ctrl+Shift+T mở lại). Gọi
   *  với danh sách HIỆN TẠI để biết vị trí của từng tab lúc đóng. */
  const rememberClosed = useCallback((cur: Tab[], ids: Set<string>) => {
    const gone = cur.map((t, index) => ({ ...t, index })).filter((t) => ids.has(t.id));
    if (gone.length) setClosed((list) => pushClosed(list, gone));
    // Trạng thái hiển thị của tab đã đóng — dọn cho khỏi phình.
    setMeta((m) => {
      if (!gone.some((t) => t.id in m)) return m;
      const next = { ...m };
      for (const t of gone) delete next[t.id];
      return next;
    });
  }, []);

  // rememberClosed đọc ảnh chụp tabsRef BÊN NGOÀI updater của setTabs: updater
  // phải thuần (React có thể gọi hai lần), đặt setClosed trong đó là ghi đôi.
  const closeTab = useCallback((id: string) => {
    rememberClosed(tabsRef.current, new Set([id]));
    setTabs((cur) => {
      const idx = cur.findIndex((t) => t.id === id);
      const next = cur.filter((t) => t.id !== id);
      setActiveId((a) => (a === id ? next[Math.max(0, idx - 1)]?.id ?? null : a));
      // ĐÓNG TAB CUỐI thì phải tắt panel new-tab, nếu không màn hình KẸT HẲN:
      // ô nhập URL của panel nằm trong thanh tab (`hasTabs && newTabOpen`), mà
      // thanh tab biến mất cùng tab cuối — còn lại đúng một dòng chữ "gõ địa
      // chỉ ở ô phía trên" trỏ vào một cái ô không còn tồn tại. Tắt panel thì
      // trang chủ Browser hiện ra với ô nhập của chính nó.
      if (next.length === 0) setNewTabOpen(false);
      return next;
    });
  }, [rememberClosed]);

  /** Đóng nhiều tab một lượt (các tab khác / bên phải / tất cả). */
  const closeMany = useCallback((pick: (t: Tab, i: number, all: Tab[]) => boolean, keepActive?: string) => {
    const snap = tabsRef.current;
    const ids = new Set(snap.filter((t, i) => pick(t, i, snap)).map((t) => t.id));
    if (!ids.size) return;
    rememberClosed(snap, ids);
    setTabs((cur) => {
      const next = cur.filter((t) => !ids.has(t.id));
      setActiveId((a) => (keepActive ?? (a && !ids.has(a) ? a : next[next.length - 1]?.id ?? null)));
      if (next.length === 0) setNewTabOpen(false);
      return next;
    });
  }, [rememberClosed]);

  /** Mở lại tab đã đóng — mặc định tab mới đóng nhất (Ctrl+Shift+T). Về đúng
   *  vị trí cũ, đúng hồ sơ, đúng cờ ghim. */
  // Đọc qua ref (gán ngay khi set): hai cú Ctrl+Shift+T tới trước khi React kịp
  // render lại sẽ cùng thấy một `closed` cũ và mở đôi một tab.
  const closedRef = useRef<ClosedTab[]>([]);
  closedRef.current = closed;
  const reopenClosed = useCallback((i = 0) => {
    const list = closedRef.current;
    const c = list[i];
    if (!c) return;
    const rest = list.filter((_, k) => k !== i);
    closedRef.current = rest;
    setClosed(rest);
    openTab(c.url, { name: c.name || undefined, profile: c.profile, forceNew: true, at: c.index, pinned: c.pinned });
  }, [openTab]);

  /** Ghim / bỏ ghim: chuyển về cuối nhóm ghim (= đầu nhóm thường khi bỏ ghim). */
  const pinTab = useCallback((id: string, pin: boolean) => {
    setTabs((cur) => {
      const t = cur.find((x) => x.id === id);
      if (!t || !!t.pinned === pin) return cur;
      const rest = cur.filter((x) => x.id !== id);
      const n = rest.filter((x) => x.pinned).length;
      const moved: Tab = { ...t, pinned: pin || undefined };
      return [...rest.slice(0, n), moved, ...rest.slice(n)];
    });
  }, []);

  /** Kéo thả: đưa tab `id` tới trước/sau tab `target`, không vượt ranh giới
   *  nhóm ghim (Chrome cũng không cho kéo tab thường lọt vào giữa nhóm ghim). */
  const moveTab = useCallback((id: string, target: string, after: boolean) => {
    if (id === target) return;
    setTabs((cur) => {
      const src = cur.find((t) => t.id === id);
      if (!src) return cur;
      const rest = cur.filter((t) => t.id !== id);
      const ti = rest.findIndex((t) => t.id === target);
      if (ti < 0) return cur;
      const n = rest.filter((t) => t.pinned).length;
      let to = ti + (after ? 1 : 0);
      to = src.pinned ? Math.min(to, n) : Math.max(to, n);
      return [...rest.slice(0, to), src, ...rest.slice(to)];
    });
  }, []);

  /** Tắt / bật tiếng một tab (nút loa trên tab, menu chuột phải). */
  const toggleMute = useCallback((id: string) => {
    const api = apisRef.current.get(id);
    if (!api) return;
    api.setMuted(!meta[id]?.muted);
  }, [meta]);

  /**
   * NHÂN ĐÔI TAB — như "Duplicate tab" của Chrome.
   *
   * Mở thêm một tab CÙNG PROFILE, cùng địa chỉ ĐANG XEM (không phải địa chỉ
   * lúc mở tab — `t.url` được onUrlChange giữ cho luôn mới), và ngay CẠNH tab
   * gốc thay vì cuối dải: nhân đôi là để so hai bên, đặt xa nhau thì phải kéo
   * lại. Đưa lên xem luôn (không background) — người dùng vừa chủ ý bấm.
   *
   * KHÔNG đi qua openTab: đây chính là ca trùng URL mà openTab sẽ chặn để hỏi
   * "trang này đang mở sẵn, chuyển tới hay mở thêm?" — với nhân đôi thì trùng
   * là ĐÚNG Ý, hỏi lại là vô nghĩa. Chèn thẳng vào danh sách cũng là cách duy
   * nhất đặt được bản sao ngay cạnh tab gốc (openTab chỉ thêm vào cuối).
   *
   * KHÔNG chép `creds`: mật khẩu đã lưu đi theo origin trong PasswordManager
   * (tab Browser bật `passwordManager`), nên bản nhân đôi vẫn tự điền được.
   * Còn `creds` là tài khoản gắn với DẤU TRANG — nhân đôi một tab đã điều
   * hướng đi nơi khác mà vẫn mang theo user/pass của dấu trang gốc là mang
   * mật khẩu sang một site khác.
   */
  const duplicateTab = useCallback((id: string) => {
    const src = tabsRef.current.find((t) => t.id === id);
    if (!src) return;
    const copy: Tab = {
      ...src,
      id: `tab-${++tabSeqRef.current}`,
      creds: undefined,
      // Bản nhân đôi là tab thường, đứng ngay cạnh — kể cả khi gốc là tab ghim.
      pinned: undefined,
      // KHÔNG chép `opener`: đó là ngữ cảnh của lần mở ĐẦU tiên (ghé trang cha
      // để lấy sessionStorage rồi mới sang trang đích). Nhân đôi là "mở lại
      // đúng trang đang xem" — mang theo opener thì bản sao lại vòng qua trang
      // cha một lần nữa, và bơm đè sessionStorage cũ lên trang hiện tại.
      opener: undefined,
    };
    // Mốc "vừa mở" cho khoá của bản sao: openTab dùng recentOpenRef để nhận ra
    // event phát lặp — không đặt thì một cú openTab cùng URL ngay sau đó lại
    // bật hộp thoại "đang mở sẵn".
    recentOpenRef.current = { key: tabUrlKey(copy.partition, copy.url), at: Date.now(), id: copy.id };
    setTabs((cur) => {
      const i = cur.findIndex((t) => t.id === id);
      if (i < 0) return cur;
      const at = Math.max(i + 1, cur.filter((t) => t.pinned).length);
      return [...cur.slice(0, at), copy, ...cur.slice(at)];
    });
    setActiveId(copy.id);
    setNewTabOpen(false);
  }, []);

  /**
   * Guest trong tab tự điều hướng → cập nhật `url` của tab.
   *
   * Nhờ đó "nhân đôi tab" nhân ra ĐÚNG trang đang xem, và dò tab trùng
   * (tabKeysRef) so với địa chỉ thật chứ không phải trang khởi đầu.
   *
   * `sameUrl`-hoá bằng tabUrlKey trước khi ghi: did-navigate-in-page bắn rất
   * dày trên SPA, ghi state mỗi lần là render lại cả cây tab vô ích. Ghi vào
   * đây KHÔNG làm webview tải lại — effect prop→guest của LinkViewer có chốt
   * so với `el.getURL()`, mà giá trị này đến TỪ chính guest.
   */
  const trackUrl = useCallback((id: string, url: string) => {
    setTabs((cur) => {
      const i = cur.findIndex((t) => t.id === id);
      if (i < 0) return cur;
      const t = cur[i];
      if (tabUrlKey(t.partition, t.url) === tabUrlKey(t.partition, url)) return cur;
      const next = [...cur];
      // Tên tab bám host như trình duyệt — nhưng CHỈ khi đã sang host khác:
      // tab mở từ dấu trang có tên riêng ("Kafka UI"), đi vòng trong chính
      // site đó mà đổi thành hostname là mất cái tên người dùng đặt.
      next[i] = { ...t, url, name: hostOf(t.url) === hostOf(url) ? t.name : hostOf(url) };
      return next;
    });
  }, []);

  /**
   * chrome.tabs.update tu popup extension → doi dia chi TAB DANG XEM.
   *
   * Id tab giờ ổn định (số thứ tự) nên chỉ cần đổi `url` — LinkViewer có effect
   * "prop url đổi → loadURL" tự đưa guest đi, KHÔNG remount nên không chớp màn.
   *
   * Chua co tab nao dang xem thi mo tab moi: popup bam "di toi" ma khong co gi
   * xay ra la kho hieu hon la mo them tab.
   */
  const navigateActive = useCallback((rawUrl: string) => {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    const cur = activeRef.current;
    if (!cur) { openTab(url, { profile: profileRef.current }); return; }
    setTabs((list) => {
      const i = list.findIndex((t) => t.id === cur);
      if (i < 0) return list;
      const t = list[i];
      // Da o dung dia chi roi thi khong dung vao — tranh tai lai trang.
      if (tabUrlKey(t.partition, t.url) === tabUrlKey(t.partition, url)) return list;
      const next = [...list];
      next[i] = { ...t, url, name: hostOf(url) };
      return next;
    });
  }, [openTab]);

  // Popup extension goi chrome.tabs.create → mo tab moi that.
  useEffect(() => {
    const off = window.browserExt?.onOpenTab?.((url: string) => openTab(url, { profile: profileRef.current }));
    return () => { off?.(); };
  }, [openTab]);

  /* Hai callback ổn định cho BrowserTab (React.memo). Nhận `tab` làm tham số
     thay vì bắt biến từ closure — nhờ vậy tham chiếu không đổi giữa các lần
     render, và memo mới thật sự chặn được render lại của <webview>. */
  // Ctrl+click / chuột giữa / Shift+click trong trang → tab NỀN.
  //
  // `opener` PHẢI được chuyển tiếp: tab con dựng lại Referer + sessionStorage
  // của tab cha, nếu không thì trang có bộ lọc/phân trang mở ra rỗng hoặc bị
  // đá về mặc định. Nhánh target=_blank đã làm việc này từ f11378f; nhánh
  // ctrl+click thì chưa, nên cùng một cú "mở liên kết liên quan" lúc được lúc
  // không tuỳ người dùng bấm kiểu gì. Giờ hai nhánh đi chung một đường.
  const openTabBackground = useCallback((url: string, tab: Tab, opener?: TabOpener) => {
    openTab(url, { profile: tab.profile, background: true, opener });
  }, [openTab]);

  const trackUrlFromTab = useCallback((url: string, tab: Tab) => {
    trackUrl(tab.id, url);
  }, [trackUrl]);

  /** Dấu trang đang mở trong hộp thoại là dấu trang VỪA THÊM bằng ☆ — tiêu
   *  đề hộp thoại đổi thành "Đã thêm dấu trang", như bong bóng của Chrome. */
  const [justStarred, setJustStarred] = useState(false);

  /**
   * ☆ trên ô địa chỉ / Ctrl+D — như Chrome:
   *   · trang CHƯA có dấu trang → lưu ngay vào thanh dấu trang của hồ sơ của
   *     tab, rồi mở hộp thoại để đổi tên / chọn hồ sơ / xoá nếu lỡ tay;
   *   · ĐÃ có → mở thẳng hộp thoại sửa dấu trang đó.
   * Không chép `creds` của tab vào dấu trang mới: mật khẩu đi theo origin
   * trong PasswordManager rồi.
   */
  const starFromTab = useCallback(async (url: string, title: string, tab: Tab) => {
    const k = urlKey(url);
    const pid = findProfile(profiles, tab.profile).id;
    const mine = (b: Bookmark) => b.kind !== 'folder' && findProfile(profiles, b.profile).id === pid;
    const existing = bookmarks.find((b) => mine(b) && urlKey(b.url) === k);
    if (existing) { setJustStarred(false); setEdit(structuredClone(existing)); return; }
    try {
      const list = await bmAdd(url, { name: title, profile: tab.profile ?? '' });
      setBookmarks(list);
      setMarks(true);
      const added = list
        .filter((b) => mine(b) && urlKey(b.url) === k)
        .reduce<Bookmark | null>((m, b) => (!m || b.order > m.order ? b : m), null);
      if (added) { setJustStarred(true); setEdit(structuredClone(added)); }
    } catch (e) { setErr((e as Error).message); }
  }, [bookmarks, profiles, setMarks]);
  const starRef = useRef(starFromTab);
  starRef.current = starFromTab;
  /** Bản ổn định cho BrowserTab (memo) — gọi tới bản mới nhất qua ref. */
  const starStable = useCallback((url: string, title: string, tab: Tab) => {
    void starRef.current(url, title, tab);
  }, []);

  const metaFromTab = useCallback((m: TabMeta, tab: Tab) => {
    setMeta((cur) => {
      const o = cur[tab.id];
      if (o && o.title === m.title && o.favicon === m.favicon && o.loading === m.loading
        && o.audible === m.audible && o.muted === m.muted && o.zoom === m.zoom) return cur;
      return { ...cur, [tab.id]: m };
    });
  }, []);

  const apiFromTab = useCallback((api: ViewerApi | null, tab: Tab) => {
    if (api) apisRef.current.set(tab.id, api);
    else apisRef.current.delete(tab.id);
  }, []);

  const slotFromTab = useCallback((el: HTMLDivElement | null, tab: Tab, under?: boolean) => {
    const map = under ? underSlotsRef.current : slotsRef.current;
    if (map.get(tab.id) === el) return;
    if (el) map.set(tab.id, el);
    else map.delete(tab.id);
    setSlotTick((n) => n + 1);
  }, []);

  const go = () => {
    if (!addr.trim()) return;
    openTab(addr, { profile });
    setAddr(''); setNewTabOpen(false);
  };

  /** Mở một địa chỉ CHỌN TỪ GỢI Ý — đi luôn, không đợi bấm "▶ Mở".
   *
   *  Không dùng `go()` được: go() đọc `addr` từ state, mà chọn gợi ý thì URL
   *  đến từ dòng vừa bấm và state chưa kịp cập nhật (setState là async) — sẽ
   *  mở đúng thứ người dùng gõ dở thay vì gợi ý họ chọn. */
  const goSuggest = useCallback((url: string) => {
    openTab(url, { profile });
    setAddr(''); setNewTabOpen(false);
  }, [openTab, profile]);

  /** Ô địa chỉ trang new-tab: gợi ý theo lịch sử đã xem.
   *
   *  Ô TRỐNG thì không gợi ý gì (minChars: 1): new-tab là trang trắng như
   *  Chrome, chỉ hiện gợi ý khi người dùng gõ (↓ vẫn xem được "gần đây"). */
  const [addrFocus, setAddrFocus] = useState(false);
  const addrSug = useAddressSuggest({ query: addr, onPick: goSuggest, enabled: addrFocus, minChars: 1 });

  /** Mở dấu trang. background = chuột phải → "Mở trong tab mới": thêm tab
   *  nhưng giữ nguyên trang đang xem.
   *
   *  KHÔNG tắt thanh dấu trang ở đây. Trước đây có `setShowMarks(false)` —
   *  còn sót từ thời thanh này là một dải chọn nhanh, chọn xong thì thu lại.
   *  Giờ nó là thanh dấu trang thường trực như Chrome, nên tắt đi là bấm một
   *  dấu trang xong thanh biến mất: trông đúng như "trang chủ có, vào tab thì
   *  không có". Ẩn/hiện chỉ do người dùng quyết (menu ⋯ / Ctrl+Shift+B). */
  const openBookmark = (b: Bookmark, background = false) => {
    openTab(b.url, {
      name: b.name, profile: b.profile, background,
      creds: { username: b.username, password: b.password },
    });
    if (!background) setNewTabOpen(false);
  };

  // closeMany tự tắt panel new-tab khi hết tab (cùng lý do như closeTab: hết
  // tab mà cờ còn bật là kẹt màn hình) và ghi các tab vào "đã đóng gần đây".
  const closeAllTabs = () => closeMany(() => true);

  const saveEdit = async () => {
    if (!edit) return;
    try {
      const list = edit.id
        ? await bmUpdate(edit.id, edit)
        : await bmAdd(edit.url, edit);
      setBookmarks(list); setEdit(null);
    } catch (e) { setErr((e as Error).message); }
  };

  const removeBookmark = async (b: Bookmark) => {
    if (!window.confirm(`Xóa dấu trang "${b.name}"?`)) return;
    try { setBookmarks(await bmRemove(b.id)); } catch (e) { setErr((e as Error).message); }
  };

  const hasTabs = tabs.length > 0;

  /**
   * Bấm ＋ = mở TRANG new-tab thật sự: ô địa chỉ trống VÀ khung dưới trống.
   *
   * Trước đây chỉ mở panel nhập URL còn `activeId` giữ nguyên, nên nửa trên là
   * "tab mới" mà nửa dưới vẫn là trang cũ — nhìn như ＋ không ăn. Bỏ chọn tab
   * (activeId = null) để khung dưới về trang new-tab, đúng như trình duyệt thật.
   *
   * Tab cũ KHÔNG bị đóng, chỉ thôi được chọn: bấm lại vào tab trên thanh là
   * quay về đúng chỗ đang đọc, và webview không bị huỷ nên không tải lại trang.
   */
  const openNewTabPage = () => {
    if (activeRef.current) prevActiveRef.current = activeRef.current;
    setNewTabOpen(true);
    setAddr('');
    setActiveId(null);
    // Ô địa chỉ của trang tab mới có autoFocus, nhưng đang ở tab new-tab rồi
    // (Ctrl+T lần hai) thì nó không mount lại — focus tay.
    requestAnimationFrame(() => homeInputRef.current?.focus());
  };

  /** Tab đang xem ngay trước khi bấm ＋ — đóng trang tab mới thì quay về đó. */
  const prevActiveRef = useRef<string | null>(null);
  const homeInputRef = useRef<HTMLInputElement | null>(null);

  /** Hủy trang new-tab → quay lại tab đang xem trước đó (nếu còn). */
  const cancelNewTab = () => {
    setNewTabOpen(false);
    const prev = prevActiveRef.current;
    setActiveId((a) => a ?? (prev && tabs.some((t) => t.id === prev) ? prev : tabs[tabs.length - 1]?.id ?? null));
  };

  /** Chọn tab theo vị trí trên dải (Ctrl+1..8, Ctrl+PageUp/Down). */
  const selectTabAt = (i: number) => {
    const t = tabs[i];
    if (t) { setActiveId(t.id); setNewTabOpen(false); }
  };

  /**
   * Một phím tắt kiểu Chrome → hành động. Hai đường vào cùng một chỗ: keydown
   * ở host (con trỏ ở thanh tab / ô địa chỉ / trang tab mới) và 'browser:key'
   * từ main (con trỏ trong trang web) — xem lib/browserKeys.ts.
   * Hành động thuộc về TRANG đi qua bộ điều khiển của tab đang xem.
   */
  const runKey = (k: BrowserKey) => {
    const api = activeId ? apisRef.current.get(activeId) : undefined;
    const idx = tabs.findIndex((t) => t.id === activeId);
    switch (k) {
      case 'newTab': openNewTabPage(); break;
      case 'closeTab':
        if (activeId) closeTab(activeId);
        else if (hasTabs) cancelNewTab();
        break;
      case 'reopenTab': reopenClosed(); break;
      case 'nextTab': if (tabs.length) selectTabAt(idx < 0 ? 0 : (idx + 1) % tabs.length); break;
      case 'prevTab': if (tabs.length) selectTabAt(idx < 0 ? tabs.length - 1 : (idx - 1 + tabs.length) % tabs.length); break;
      case 'lastTab': selectTabAt(tabs.length - 1); break;
      case 'focusOmni':
        if (api) api.focusOmni();
        else homeInputRef.current?.focus();
        break;
      case 'find': api?.find(); break;
      case 'findNext': api?.findNext(1); break;
      case 'findPrev': api?.findNext(-1); break;
      case 'reload': api?.reload(); break;
      case 'hardReload': api?.reload(true); break;
      case 'back': api?.back(); break;
      case 'forward': api?.forward(); break;
      case 'zoomIn': api?.zoom(1); break;
      case 'zoomOut': api?.zoom(-1); break;
      case 'zoomReset': api?.zoom(0); break;
      case 'bookmark': api?.star(); break;
      case 'print': api?.print(); break;
      case 'tabSearch': setTabSearchOpen((v) => !v); break;
      case 'history': setHistOpen(true); break;
      case 'toggleMarks': toggleMarks(); break;
      default:
        if (/^tab[1-8]$/.test(k)) selectTabAt(Number(k.slice(3)) - 1);
    }
  };
  const runKeyRef = useRef(runKey);
  runKeyRef.current = runKey;

  // Phím bấm khi con trỏ ở phần khung của tab Browser. Nghe ở document vì
  // focus có thể ở bất cứ đâu trong pane; chỉ nhận khi pane đang hiện và sự
  // kiện thuộc về pane này (chế độ chia màn hình: Ctrl+F trong pane bên cạnh
  // không được rơi vào đây).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!visibleRef.current || e.defaultPrevented) return;
      const k = browserKeyOf({ key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
      if (!k) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !rootRef.current?.contains(t)) return;
      // Ctrl+H là xoá lùi trong vài ô nhập — đang gõ thì để yên cho ô.
      if (k === 'history' && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      runKeyRef.current(k);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Phím bấm TRONG trang web — main gửi về cả hai loại: phím giữ chặt (chặn
  // trước trang) và phím trang bỏ qua (BK_SCRIPT trong isolated world). Hành động cần gõ phím ở host (ô địa chỉ, ô tìm…) phải rứt
  // focus khỏi guest trước — chỉ gọi input.focus() thì guest vẫn giữ bàn phím.
  const keyFromGuest = useCallback((k: BrowserKey) => {
    if (!visibleRef.current) return;
    if (!NEED_HOST_KEYS.has(k)) { runKeyRef.current(k); return; }
    const p = window.workspace?.focusHost?.();
    if (!p) { runKeyRef.current(k); return; }
    void p.catch(() => {}).finally(() => runKeyRef.current(k));
  }, []);
  useEffect(() => window.workspace?.onBrowserKey?.(({ key }) => keyFromGuest(key)), [keyFromGuest]);

  /* ── Lối tắt ở trang tab mới — các host ghé nhiều nhất, như Chrome ───── */
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [tilesHidden, setTilesHidden] = useState(0); // số ô đã ẩn, để hiện "khôi phục"
  const onHome = activeId === null;
  const loadTiles = useCallback(() => {
    historyList('', 400).then((rows) => {
      const hidden = hiddenTiles();
      setTilesHidden(hidden.size);
      const by = new Map<string, Tile & { best: number }>();
      for (const r of rows) {
        if (!r.host || hidden.has(r.host) || !/^https?:\/\//i.test(r.url)) continue;
        const cur = by.get(r.host);
        if (!cur) { by.set(r.host, { host: r.host, url: r.url, title: r.title, visits: r.visitCount, best: r.visitCount }); continue; }
        cur.visits += r.visitCount;
        if (r.visitCount > cur.best) { cur.best = r.visitCount; cur.url = r.url; cur.title = r.title || cur.title; }
      }
      setTiles([...by.values()].sort((a, b) => b.visits - a.visits).slice(0, 10));
    }).catch(() => setTiles([]));
  }, []);
  useEffect(() => { if (onHome && visible) loadTiles(); }, [onHome, visible, loadTiles]);

  /** Chuột phải trên một dấu trang → mở menu ngữ cảnh tại con trỏ (toạ độ quy
   *  về gốc .bt-root vì menu position:absolute trong đó). */
  const openCtx = (ev: React.MouseEvent, bm: Bookmark) => {
    ev.preventDefault();
    ev.stopPropagation();
    const host = rootRef.current?.getBoundingClientRect();
    // Kẹp trong khung để menu không tràn ra ngoài khi bấm sát mép phải/dưới.
    const MW = 220, MH = 260;
    const x = Math.min(ev.clientX - (host?.left ?? 0), Math.max(0, (host?.width ?? MW) - MW));
    const y = Math.min(ev.clientY - (host?.top ?? 0), Math.max(0, (host?.height ?? MH) - MH));
    setCtx({ x, y, bm });
  };

  /**
   * Tạo thư mục. Mở hộp thoại trong app, KHÔNG dùng window.prompt: Electron
   * chặn prompt() trong renderer và trả về null không báo gì — bấm "Thư mục
   * mới" xong chẳng có gì xảy ra, cũng không có lỗi nào để lần ra.
   *
   * Nhập được CẢ ĐƯỜNG DẪN nhiều cấp kiểu `Work/Infra/Kafka` — tạo một lúc cả
   * chuỗi thư mục lồng nhau, khỏi phải bấm ba lần rồi kéo vào nhau.
   */
  const newFolder = useCallback((parentId?: string) => {
    setFolderAsk({ parentId, name: '' });
  }, []);

  /** Thật sự tạo thư mục sau khi người dùng xác nhận trong hộp thoại. */
  const createFolders = useCallback(async (raw: string, parentId?: string): Promise<string | undefined> => {
    // Tách theo '/' và bỏ đoạn rỗng: "Work//Infra/" vẫn ra hai cấp đúng.
    const parts = raw.split('/').map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return undefined;
    let pid = parentId;
    let list: Bookmark[] = [];
    for (const part of parts) {
      list = await bmAddFolder(part, pid, curRef);
      // bmAddFolder trả về CẢ danh sách, thư mục vừa tạo là mục có order lớn
      // nhất trong cha đó — dùng làm cha cho cấp kế tiếp.
      const made = list
        .filter((b) => b.kind === 'folder' && b.parentId === pid)
        .reduce<Bookmark | null>((m, b) => (!m || b.order > m.order ? b : m), null);
      if (!made) break;
      pid = made.id;
    }
    if (list.length) setBookmarks(list);
    return pid;
  }, [curRef]);

  // Dùng cờ `popup` chứ không phải `modal`: mấy hộp thoại này nhỏ, giữ được
  // thanh tab và thanh dấu trang phía sau thì người dùng còn thấy mình đang ở
  // tab nào (xem lib/useOverWebview.ts để biết khác biệt hai cờ).
  //
  // MỌI overlay của file này phải có mặt trong biểu thức dưới đây. Thiếu một cái
  // là nó bị <webview> che kín, và vì guest là process riêng nên cú bấm lẫn phím
  // gõ đi vào TRANG WEB chứ không vào ô nhập — `edit` từng bị sót, triệu chứng
  // là "sửa tên dấu trang không được, bàn phím như bị chặn". Menu ⋯ cũng vậy:
  // z-index 21 không cứu được gì trước tầng native.
  usePopupOverWebview(!!folderAsk || menuOpen || !!dupAsk || !!edit || !!tabCtx || profMenuOpen || profMgrOpen
    || tabSearchOpen);

  /** Esc đóng menu ⋯. Menu đã portal ra body nên không nhận keydown của cây
   *  con nữa — phải nghe ở window. */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  /** Xác nhận hộp thoại: tạo chuỗi thư mục, rồi lưu URL đang chờ (nếu có). */
  const submitFolder = useCallback(async () => {
    if (!folderAsk) return;
    const { name, parentId, pendingUrl, moveId } = folderAsk;
    if (!name.trim()) return;
    setFolderAsk(null);
    setShowMarks(true);
    try {
      const deepest = await createFolders(name, parentId);
      if (moveId) setBookmarks(await bmMove(moveId, deepest));
      else if (pendingUrl) {
        const url = normalizeUrl(pendingUrl);
        if (url) setBookmarks(await bmAdd(url, { parentId: deepest, name: hostOf(url), profile: curRef }));
      }
    } catch (e) { setErr((e as Error).message); }
  }, [folderAsk, createFolders, curRef]);

  /** Kéo thả: chuyển một mục sang thư mục khác / đổi vị trí. */
  const moveBookmarkTo = useCallback(async (id: string, parentId?: string, beforeId?: string) => {
    try { setBookmarks(await bmMove(id, parentId, beforeId)); }
    catch (e) { setErr((e as Error).message); }
  }, []);

  /**
   * Thả một URL (kéo từ ô địa chỉ) vào thanh hoặc vào một thư mục.
   *
   * `beforeId` = thả vào GIỮA hai mục có sẵn. Store chỉ biết thêm vào cuối, nên
   * thêm rồi chuyển ngay — không có API 'add tại vị trí'. Hai lượt gọi liền
   * nhau, nhưng đổi lại người dùng thả đâu là nằm đó, không bị nhảy về cuối.
   */
  const dropUrl = useCallback(async (rawUrl: string, parentId?: string, beforeId?: string) => {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    try {
      const list = await bmAdd(url, { parentId, name: hostOf(url), profile: curRef });
      if (!beforeId) { setBookmarks(list); return; }
      // Mục vừa thêm là mục có order lớn nhất trong thư mục đích.
      const added = list
        .filter((b) => b.parentId === parentId)
        .reduce<Bookmark | null>((m, b) => (!m || b.order > m.order ? b : m), null);
      setBookmarks(added ? await bmMove(added.id, parentId, beforeId) : list);
    } catch (e) { setErr((e as Error).message); }
  }, [curRef]);

  /** Một chip dấu trang — click mở tại chỗ, chuột phải ra menu (tab mới…). */
  const markChip = (b: Bookmark) => (
    <span key={b.id} className="bt-mark" title={`${b.url} — chuột phải để mở trong tab mới`}
      onContextMenu={(ev) => openCtx(ev, b)}>
      <button className="bt-mark-go" onClick={() => openBookmark(b)}
        onAuxClick={(ev) => { if (ev.button === 1) { ev.preventDefault(); openBookmark(b, true); } }}>
        🔖 {b.name}
      </button>
      <button className="bt-mark-act" onClick={() => setEdit(structuredClone(b))} title="Sửa">✎</button>
      <button className="bt-mark-act" onClick={() => void removeBookmark(b)} title="Xóa">✕</button>
    </span>
  );

  /**
   * Danh sách dấu trang ở trang chủ / panel ＋ — THEO CÂY THƯ MỤC.
   *
   * Bản trước làm `bookmarks.filter(kind === 'link')`, tức là dàn phẳng: mọi
   * link trong mọi thư mục đổ ra thành một đống rời rạc, xếp cạnh nhau không
   * theo thứ tự nào. Sắp xếp vào thư mục ở thanh dấu trang xong ra trang chủ
   * thấy y như chưa làm gì.
   *
   * Nay đi theo cây: mỗi thư mục là một NHÓM có tiêu đề, link ở gốc nằm trong
   * nhóm "không thư mục" đầu tiên. Lồng sâu thì thụt vào theo cấp.
   */
  const marksList = marks.length > 0 && (
    <div className="bt-home-marks-tree">
      <div className="small" style={{ color: 'var(--muted)', marginBottom: 4 }}>
        Dấu trang <span style={{ color: 'var(--faint)' }}>— chuột phải: mở trong tab mới</span>
      </div>
      {(() => {
        const rows: React.ReactNode[] = [];
        const walk = (nodes: BmNode[], depth: number) => {
          // Link trước, thư mục sau — trong mỗi cấp, để mắt bắt được link ngay
          // thay vì phải nhảy qua các tiêu đề thư mục.
          const links = nodes.filter((n) => n.kind === 'link');
          const dirs = nodes.filter((n) => n.kind === 'folder');
          if (links.length) {
            rows.push(
              <div key={`l${depth}-${nodes[0]?.id ?? 'x'}`} className="bt-home-row"
                style={{ paddingLeft: depth * 14 }}>
                {links.map(markChip)}
              </div>,
            );
          }
          for (const d of dirs) {
            rows.push(
              <div key={`d-${d.id}`} className="bt-home-dir" style={{ paddingLeft: depth * 14 }}>
                📁 {d.name}
                {d.children.length === 0 && <span className="bt-home-dir-empty">trống</span>}
              </div>,
            );
            walk(d.children, depth + 1);
          }
        };
        walk(bmTree(marks), 0);
        return rows;
      })()}
    </div>
  );

  /** Ô tìm/địa chỉ của trang tab mới — to, bo tròn, ở giữa như Chrome. */
  const addressForm = (
    <div className="bt-addr bt-ntp-search">
      {/* Khung neo cho danh sách gợi ý (position:absolute). Phải bọc RIÊNG ô
          URL, không dùng cả .bt-addr: danh sách sẽ rộng bằng cả hàng, trùm qua
          ô Profile. */}
      <div className="bt-addr-wrap">
        <span className="bt-ntp-search-ico" aria-hidden>🔍</span>
        <input ref={homeInputRef} className="input bt-addr-input" placeholder="Tìm Google hoặc nhập URL"
          value={addrSug.preview ?? addr} autoFocus onChange={(e) => setAddr(e.target.value)}
          onFocus={(e) => { setAddrFocus(true); e.currentTarget.select(); }}
          // Xem ghi chú ở ô địa chỉ của LinkViewer: KHÔNG đóng danh sách tại
          // onBlur, vì bấm vào một dòng cũng làm ô mất focus.
          onBlur={() => setAddrFocus(false)}
          onKeyDown={(e) => {
            if (addrSug.onKeyDown(e)) return;
            // Enter mở ĐÚNG thứ đang hiện trong ô: đang chọn một dòng gợi ý
            // bằng ↑↓ thì ô hiện URL dòng đó nhưng `addr` vẫn là chữ gõ dở.
            if (e.key === 'Enter') { if (addrSug.preview) goSuggest(addrSug.preview); else go(); }
            if (e.key === 'Escape' && hasTabs) cancelNewTab();
          }} />
        <AddressSuggest {...addrSug.listProps} />
      </div>
      <ProfileSelect profiles={profiles} value={profile} onChange={setProfile}
        title="Cùng hồ sơ = chung phiên đăng nhập. Hai tài khoản khác nhau → hai hồ sơ (⚙ trong nút avatar để thêm)." />
    </div>
  );

  const activeTab = tabs.find((t) => t.id === activeId);
  /** Ô trống ở hàng công cụ của tab đang xem — có thì cụm hồ sơ/extension/⋮
   *  portal vào đó; ở trang tab mới (không có viewer) thì nằm cuối dải tab. */
  const slot = activeId ? slotsRef.current.get(activeId) : undefined;
  const underSlot = activeId ? underSlotsRef.current.get(activeId) : undefined;
  /** URL đã có dấu trang (của hồ sơ đang dùng) — để tab vẽ ☆ hay ★. */
  const markedUrls = useMemo(
    () => new Set(marks.filter((b) => b.kind !== 'folder').map((b) => urlKey(b.url))),
    [marks],
  );
  /** Thứ tự RENDER viewer = thứ tự tạo tab, KHÔNG theo thứ tự trên dải. Kéo thả
   *  / ghim đổi thứ tự dải; nếu viewer render theo đó thì React phải chuyển chỗ
   *  nút <webview> trong DOM — mà gỡ ra gắn lại một <webview> là guest bị huỷ
   *  và tải lại từ đầu. Tab mới luôn có số lớn nhất nên chỉ thêm vào cuối. */
  const viewerOrder = useMemo(() => [...tabs].sort((a, b) => tabSeq(a.id) - tabSeq(b.id)), [tabs]);

  /** Cụm cuối hàng công cụ, như Chrome: extension · hồ sơ · ⋮. */
  const toolCluster = (
    <div className="bt-cluster">
      <BrowserExtBar
        partition={activeTab?.partition ?? bmPartition(profile || undefined)}
        activeUrl={activeTab?.url ?? ''}
        onNavigate={navigateActive}
        onManage={() => setExtOpen(true)}
        onReloadPage={() => {
          const cur = activeRef.current;
          if (cur) setReloadNonces((m) => ({ ...m, [cur]: (m[cur] ?? 0) + 1 }));
        }}
      />
      <ProfileButton
        profiles={profiles} current={currentProfile}
        open={profMenuOpen} onOpenChange={setProfMenuOpen}
        onPick={pickProfile} onManage={() => setProfMgrOpen(true)}
      />
      {/* Nút ⋮ — menu của Chrome. Menu PORTAL ra <body> + position:fixed:
          dải tab có `overflow-x: auto` (khung cắt), menu absolute bên trong
          bị cắt cụt theo chiều cao dải nên thả xuống là mất hút. */}
      <div className="bt-menu-wrap">
        <button
          ref={menuBtnRef}
          className={`bt-kebab${menuOpen ? ' on' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          title="Tuỳ chỉnh và điều khiển Browser"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >⋮</button>
      </div>
    </div>
  );

  /** Một tab trên dải — favicon/vòng xoay, tiêu đề, loa, ✕; kéo thả để sắp xếp. */
  const tabChip = (t: Tab) => {
    const m = meta[t.id];
    const on = t.id === activeId;
    const title = m?.title || t.name;
    const icon = m?.favicon ?? faviconOf(t.url);
    const prof = t.profile ? findProfile(profiles, t.profile) : null;
    return (
      <div
        key={t.id}
        role="tab"
        aria-selected={on}
        className={`bt-tab${on ? ' on' : ''}${t.pinned ? ' pinned' : ''}${
          dropAt?.id === t.id ? (dropAt.after ? ' drop-after' : ' drop-before') : ''}`}
        title={`${title}\n${t.url}${prof ? `\nHồ sơ: ${prof.name}` : ''}`}
        draggable
        onClick={() => { setActiveId(t.id); setNewTabOpen(false); }}
        // Chuột giữa đóng tab — như Chrome. mousedown chặn kiểu cuộn tự động.
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const host = rootRef.current?.getBoundingClientRect();
          const MW = 240, MH = 380;
          setTabCtx({
            x: Math.min(ev.clientX - (host?.left ?? 0), Math.max(0, (host?.width ?? MW) - MW)),
            y: Math.min(ev.clientY - (host?.top ?? 0), Math.max(0, (host?.height ?? MH) - MH)),
            id: t.id,
          });
        }}
        onDragStart={(e) => {
          dragTabRef.current = t.id;
          e.dataTransfer.setData('application/x-dbx-tab', t.id);
          // Thả xuống thanh dấu trang = lưu dấu trang, như kéo tab của Chrome.
          e.dataTransfer.setData('text/uri-list', t.url);
          e.dataTransfer.setData('text/plain', t.url);
          e.dataTransfer.effectAllowed = 'all';
        }}
        onDragOver={(e) => {
          if (!dragTabRef.current || dragTabRef.current === t.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const r = e.currentTarget.getBoundingClientRect();
          const after = e.clientX > r.left + r.width / 2;
          setDropAt((d) => (d?.id === t.id && d.after === after ? d : { id: t.id, after }));
        }}
        onDragLeave={() => setDropAt((d) => (d?.id === t.id ? null : d))}
        onDrop={(e) => {
          const src = dragTabRef.current;
          if (!src) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          moveTab(src, t.id, e.clientX > r.left + r.width / 2);
          dragTabRef.current = null;
          setDropAt(null);
        }}
        onDragEnd={() => { dragTabRef.current = null; setDropAt(null); }}
      >
        <span className="bt-tab-ico" aria-hidden>
          {m?.loading ? <span className="bt-spin" /> : (
            <>
              <span className="bt-tab-letter" style={prof ? { background: prof.color } : undefined}>{tabInitial(title)}</span>
              {icon && (
                // Ảnh hỏng (favicon cần cookie, host chết) thì giấu đi, chữ cái
                // nằm bên dưới lộ ra thay.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={icon} alt="" draggable={false}
                  onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
              )}
            </>
          )}
        </span>
        {!t.pinned && <span className="bt-tab-title">{title}</span>}
        {(m?.audible || m?.muted) && (
          <button className={`bt-tab-audio${m.muted ? ' muted' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleMute(t.id); }}
            title={m.muted ? 'Bật tiếng tab' : 'Tắt tiếng tab'}>
            {m.muted ? '🔇' : '🔊'}
          </button>
        )}
        {!t.pinned && (
          <button className="bt-tab-x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
            title="Đóng tab (Ctrl+W)">✕</button>
        )}
      </div>
    );
  };

  const marksBar = (
    <BookmarkBar
      bookmarks={marks}
      onOpen={(b, background) => openBookmark(b, background)}
      onEdit={(b) => { setJustStarred(false); setEdit(structuredClone(b)); }}
      onRemove={(b) => void removeBookmark(b)}
      onNewFolder={(pid) => newFolder(pid)}
      onNewFolderWith={(id, pid) => setFolderAsk({ parentId: pid, name: '', moveId: id })}
      onMove={(id, pid, before) => void moveBookmarkTo(id, pid, before)}
      onHideBar={hideMarks}
      onDropUrl={(url, pid, before) => void dropUrl(url, pid, before)}
    />
  );

  /** Ô lối tắt ở trang tab mới. */
  const tileEl = (tl: Tile) => {
    const icon = faviconOf(tl.url);
    const label = tl.title || tl.host;
    return (
      <div key={tl.host} className="bt-tile" title={`${label}\n${tl.url}`}
        onClick={() => openTab(tl.url, { profile })}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openTab(tl.url, { profile, background: true }); } }}>
        <span className="bt-tile-ico">
          <span className="bt-tab-letter">{tabInitial(tl.host.replace(/^www\./, ''))}</span>
          {icon && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={icon} alt="" draggable={false} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
          )}
        </span>
        <span className="bt-tile-name">{label}</span>
        <button className="bt-tile-x" title="Ẩn lối tắt này (không xoá lịch sử)"
          onClick={(e) => { e.stopPropagation(); hideTile(tl.host); loadTiles(); }}>✕</button>
      </div>
    );
  };

  return (
    <div className={`bt-root${full ? ' bt-full' : ''}`} ref={rootRef}>
      {err && (
        <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '4px 0' }}
          onClick={() => setErr(null)} title="Bấm để ẩn">{err}</pre>
      )}

      {/* ── Dải tab kiểu Chrome: tab ghim · tab thường · ＋ · tìm tab ──
          Luôn hiện (kể cả chưa có tab nào): trang tab mới cũng là một "tab".
          Đúp chuột vào chỗ trống của dải = tab mới, như Chrome. */}
      <div className="bt-strip" role="tablist">
        {tabs.map(tabChip)}
        {activeId === null && (
          <div role="tab" aria-selected className="bt-tab on bt-tab--ntp" title="Thẻ mới">
            <span className="bt-tab-ico" aria-hidden><span className="bt-tab-letter">＋</span></span>
            <span className="bt-tab-title">Thẻ mới</span>
            {hasTabs && <button className="bt-tab-x" onClick={cancelNewTab} title="Đóng (Ctrl+W)">✕</button>}
          </div>
        )}
        <button className="bt-newtab" onClick={openNewTabPage} title="Tab mới (Ctrl+T)">＋</button>
        <span className="bt-strip-fill" onDoubleClick={openNewTabPage} />
        <button ref={tabSearchBtnRef} className={`bt-tabsearch${tabSearchOpen ? ' on' : ''}`}
          onClick={() => setTabSearchOpen((v) => !v)} title="Tìm kiếm tab (Ctrl+Shift+A)">⌄</button>
        {!slot && toolCluster}
      </div>
      {slot && createPortal(toolCluster, slot)}

      {/* Thanh dấu trang — cây thư mục như Chrome. Bật/tắt từ menu ⋮ /
          Ctrl+Shift+B. Đang xem một tab thì nằm DƯỚI hàng công cụ của tab đó
          (portal), ở trang tab mới thì nằm ngay dưới dải tab. */}
      {showMarks && (underSlot ? createPortal(marksBar, underSlot) : marksBar)}

      {/* ── Vùng nội dung ──
          Các tab LUÔN được mount khi còn tồn tại, kể cả lúc đang ở trang
          new-tab (activeId = null): unmount <webview> là huỷ phiên đang chạy,
          quay lại tab phải tải lại trang từ đầu và mất cả chỗ đang đọc. Trang
          new-tab chỉ nằm ĐÈ lên, tab nền vẫn nguyên vẹn phía sau. */}
      {hasTabs && (
        <div className="lv-wrap bt-viewer" hidden={activeId === null}>
          <div className="lv-body">
            {viewerOrder.map((t) => (
              <BrowserTab
                // Nonce riêng của TỪNG tab: chỉ đổi khi bấm ↻ đúng tab đó, nên
                // chuyển tab qua lại không làm key đổi → webview không bị huỷ,
                // trang và vị trí đang xem giữ nguyên như trình duyệt thật.
                key={`${t.id}#${reloadNonces[t.id] ?? 0}`}
                tab={t}
                hidden={t.id !== activeId}
                bookmarked={markedUrls.has(urlKey(t.url))}
                // Truyền các hàm ỔN ĐỊNH (useCallback ở trên) chứ không phải
                // closure tạo mới mỗi lần render: BrowserTab bọc React.memo, mà
                // memo so sánh prop theo tham chiếu — closure mới là mỗi lần gõ
                // một chữ trong form "Sửa dấu trang" lại render lại TOÀN BỘ
                // <webview> đang mở. Đó chính là chỗ gây lag khi nhập.
                onClose={closeTab}
                onOpenNewTab={openTabBackground}
                onUrlChange={trackUrlFromTab}
                onStar={starStable}
                onMeta={metaFromTab}
                onApi={apiFromTab}
                onSlot={slotFromTab}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Trang tab mới — như Chrome: ô tìm kiếm ở giữa, lối tắt các trang
          hay ghé, dưới là các tab vừa đóng và dấu trang. ── */}
      {activeId === null && (
        <div className="bt-home">
          <div className="bt-ntp">
            <div className="bt-ntp-brand">
              <span className="bt-ntp-logo" aria-hidden>🌐</span>
              <span>Browser</span>
              <button className="bt-ntp-prof" onClick={() => setProfMgrOpen(true)}
                title="Hồ sơ đang dùng — mỗi hồ sơ giữ phiên đăng nhập & dấu trang riêng">
                <ProfileDot p={currentProfile} size={16} /> {currentProfile.name}
              </button>
            </div>
            {addressForm}
            {tiles.length > 0 && (
              <div className="bt-tiles">{tiles.map(tileEl)}</div>
            )}
            {tilesHidden > 0 && (
              <button className="ghost sm bt-ntp-link"
                onClick={() => { unhideAllTiles(); loadTiles(); }}>
                Khôi phục {tilesHidden} lối tắt đã ẩn
              </button>
            )}
            {closed.length > 0 && (
              <div className="bt-ntp-closed">
                <div className="bt-ntp-h">Đã đóng gần đây</div>
                <div className="bt-home-row">
                  {closed.slice(0, 6).map((c, i) => (
                    <button key={`${c.url}-${c.closedAt}-${i}`} className="bt-chip" title={c.url}
                      onClick={() => reopenClosed(i)}>
                      ↶ {c.name || hostOf(c.url)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {marksList}
          </div>
        </div>
      )}

      {/* Trình quản lý mật khẩu đã lưu */}
      {/* Hộp thoại "Thư mục mới" — thay window.prompt (Electron chặn prompt).
          Nhận cả đường dẫn nhiều cấp: Work/Infra/Kafka. */}
      {folderAsk && (
        <div className="bt-modal-back" onMouseDown={() => setFolderAsk(null)}>
          <div className="bt-modal" onMouseDown={(e) => e.stopPropagation()}>
            <b>📁 Thư mục mới</b>
            <p className="small" style={{ color: 'var(--muted)', margin: 0 }}>
              Gõ nhiều cấp bằng dấu <code>/</code> — ví dụ <code>Work/Infra/Kafka</code>.
              {folderAsk.pendingUrl && <> Dấu trang sẽ được lưu vào cấp trong cùng.</>}
            </p>
            <input
              className="input" autoFocus placeholder="Tên thư mục…"
              value={folderAsk.name}
              onChange={(e) => setFolderAsk((v) => (v ? { ...v, name: e.target.value } : v))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void submitFolder(); }
                else if (e.key === 'Escape') { e.stopPropagation(); setFolderAsk(null); }
              }}
            />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button className="ghost sm" onClick={() => setFolderAsk(null)}>Hủy</button>
              <button onClick={() => void submitFolder()} disabled={!folderAsk.name.trim()}>Tạo</button>
            </div>
          </div>
        </div>
      )}

      {/* Menu ⋮ kiểu Chrome — portal ra <body> để thoát khỏi khung cắt
          `overflow-x: auto` của dải tab. Neo theo rect của nút. Mục thuộc về
          TRANG (tìm, in, thu phóng, DevTools…) gọi vào viewer của tab đang xem. */}
      {mounted && menuOpen && createPortal(
        (() => {
          const api = activeId ? apisRef.current.get(activeId) : undefined;
          const zoomPct = Math.round((activeId ? meta[activeId]?.zoom ?? 1 : 1) * 100);
          const close = () => setMenuOpen(false);
          const r = menuBtnRef.current?.getBoundingClientRect();
          const W = 290;
          return (
            <>
              <div className="bt-menu-backdrop" onMouseDown={close} />
              <div
                className="bt-menu bt-menu-fixed bt-menu-chrome"
                role="menu"
                style={{
                  // Canh phải theo nút, kẹp trong màn hình để không tràn mép.
                  left: Math.max(6, Math.min((r?.right ?? window.innerWidth) - W, window.innerWidth - W - 6)),
                  top: (r?.bottom ?? 40) + 4,
                  width: W,
                  maxHeight: `calc(100vh - ${Math.round((r?.bottom ?? 40) + 14)}px)`,
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button onClick={() => { close(); openNewTabPage(); }}>
                  <span className="bt-menu-check" />Tab mới<span className="bt-menu-key">Ctrl+T</span>
                </button>
                <button disabled={!closed.length} onClick={() => { close(); reopenClosed(); }}>
                  <span className="bt-menu-check" />Mở lại tab đã đóng<span className="bt-menu-key">Ctrl+Shift+T</span>
                </button>
                {/* Nhân đôi tab ĐANG XEM. Ở trang new-tab thì chẳng có gì để nhân. */}
                <button disabled={!activeId}
                  onClick={() => { const cur = activeId; close(); if (cur) duplicateTab(cur); }}>
                  <span className="bt-menu-check" />Nhân đôi tab
                </button>
                <div className="bt-menu-sep" />
                <button onClick={() => { close(); setHistOpen(true); }}>
                  <span className="bt-menu-check" />🕘 Lịch sử<span className="bt-menu-key">Ctrl+H</span>
                </button>
                {/* Mục bật/tắt kiểu Chrome: có dấu ✓ cho biết trạng thái hiện tại,
                    nhãn KHÔNG đổi theo trạng thái. */}
                <button role="menuitemcheckbox" aria-checked={showMarks} onClick={() => { toggleMarks(); close(); }}>
                  <span className="bt-menu-check">{showMarks ? '✓' : ''}</span>
                  Hiện thanh dấu trang<span className="bt-menu-key">Ctrl+Shift+B</span>
                </button>
                <button disabled={!api} onClick={() => { close(); api?.star(); }}>
                  <span className="bt-menu-check" />☆ Lưu dấu trang cho trang này<span className="bt-menu-key">Ctrl+D</span>
                </button>
                <button onClick={() => { setMarks(true); close(); newFolder(); }}>
                  <span className="bt-menu-check" />📁 Thư mục dấu trang mới…
                </button>
                <button onClick={() => { close(); setPwOpen(true); }}>
                  <span className="bt-menu-check" />🔑 Mật khẩu đã lưu
                </button>
                <button onClick={() => { close(); setExtOpen(true); }}>
                  <span className="bt-menu-check" />🧩 Extension
                </button>
                <div className="bt-menu-sep" />
                {/* Hàng thu phóng như Chrome: − 110% + ⛶ — bấm KHÔNG đóng menu,
                    để bấm liên tiếp mà nhìn mức đổi. */}
                <div className="bt-menu-zoom">
                  <span>Thu phóng</span>
                  <span className="bt-menu-zoom-ctl">
                    <button disabled={!api} onClick={() => api?.zoom(-1)} title="Thu nhỏ (Ctrl+-)">−</button>
                    <button disabled={!api || zoomPct === 100} onClick={() => api?.zoom(0)}
                      className="bt-menu-zoom-val" title="Về 100% (Ctrl+0)">{zoomPct}%</button>
                    <button disabled={!api} onClick={() => api?.zoom(1)} title="Phóng to (Ctrl++)">+</button>
                    <button className={full ? 'on' : ''} onClick={() => { setFull((v) => !v); close(); }}
                      title="Tràn viền — che khung app, trang cao tối đa (Esc để thoát)">⛶</button>
                  </span>
                </div>
                <div className="bt-menu-sep" />
                <button disabled={!api} onClick={() => { close(); api?.find(); }}>
                  <span className="bt-menu-check" />🔍 Tìm trong trang…<span className="bt-menu-key">Ctrl+F</span>
                </button>
                <button disabled={!api} onClick={() => { close(); api?.print(); }}>
                  <span className="bt-menu-check" />🖨 In…<span className="bt-menu-key">Ctrl+P</span>
                </button>
                <button disabled={!activeTab} onClick={() => {
                  close(); if (activeTab) void navigator.clipboard?.writeText(activeTab.url);
                }}>
                  <span className="bt-menu-check" />⧉ Chép địa chỉ trang
                </button>
                <button disabled={!api} onClick={() => { close(); api?.openExternal(); }}>
                  <span className="bt-menu-check" />↗ Mở bằng trình duyệt ngoài
                </button>
                <div className="bt-menu-sep" />
                <div className="bt-menu-h">Công cụ khác</div>
                <button disabled={!api} onClick={() => { close(); api?.devtools(); }}>
                  <span className="bt-menu-check" />🔧 Công cụ cho nhà phát triển<span className="bt-menu-key">F12</span>
                </button>
                <button disabled={!api} onClick={() => { close(); api?.googleLogin(); }}>
                  <span className="bt-menu-check" />Ⓖ Đăng nhập Google trong tab này
                </button>
                <button onClick={() => { close(); signOutProfile(currentProfile); }}>
                  <span className="bt-menu-check" />⎋ Đăng xuất hồ sơ “{currentProfile.name}”…
                </button>
                <button onClick={() => { close(); setProfMgrOpen(true); }}>
                  <span className="bt-menu-check" />👤 Quản lý hồ sơ…
                </button>
                <div className="bt-menu-sep" />
                <button className="danger" disabled={!hasTabs} onClick={() => { closeAllTabs(); close(); }}>
                  <span className="bt-menu-check" />✕ Đóng tất cả tab
                </button>
              </div>
            </>
          );
        })(),
        document.body,
      )}

      {/* Tìm kiếm tab (⌄ / Ctrl+Shift+A) — như Chrome: tab đang mở + đã đóng. */}
      {mounted && tabSearchOpen && createPortal(
        <TabSearch
          anchor={tabSearchBtnRef.current?.getBoundingClientRect() ?? null}
          tabs={tabs.map((t) => ({
            id: t.id, url: t.url, title: meta[t.id]?.title || t.name,
            icon: meta[t.id]?.favicon ?? faviconOf(t.url), on: t.id === activeId,
          }))}
          closed={closed}
          onPick={(id) => { setActiveId(id); setNewTabOpen(false); setTabSearchOpen(false); }}
          onCloseTab={closeTab}
          onReopen={(i) => { reopenClosed(i); setTabSearchOpen(false); }}
          onClose={() => setTabSearchOpen(false)}
        />,
        document.body,
      )}

      {/* Hộp thoại "trang đang mở sẵn" — chuyển tới tab cũ hay mở thêm tab mới. */}
      {dupAsk && (
        <DupTabDialog
          url={dupAsk.url}
          existingName={dupAsk.existingName}
          onGoExisting={() => { setActiveId(dupAsk.existingId); setNewTabOpen(false); setDupAsk(null); }}
          onOpenNew={() => {
            const d = dupAsk;
            setDupAsk(null);
            openTab(d.url, { name: d.name, profile: d.profile, creds: d.creds, forceNew: true });
          }}
          onCancel={() => setDupAsk(null)}
        />
      )}

      {/* Lịch sử — bấm một dòng là mở lại trang đó trong TAB MỚI (openTab tự
          hỏi nếu trang đang mở sẵn), giống bấm một mục lịch sử của trình duyệt. */}
      {histOpen && (
        <BrowserHistory
          onOpen={(u) => openTab(u, { profile })}
          onClose={() => setHistOpen(false)}
        />
      )}
      {pwOpen && <PasswordManager onClose={() => setPwOpen(false)} />}
      {extOpen && <BrowserExtensions onClose={() => setExtOpen(false)} />}
      {profMgrOpen && (
        <ProfileManager
          profiles={profiles} tabCounts={tabCounts}
          onChange={setProfiles} onSignOut={signOutProfile} onDelete={(p) => void deleteProfile(p)}
          onClose={() => setProfMgrOpen(false)}
        />
      )}

      {/* Menu chuột phải TRÊN MỘT TAB của dải tab — như trình duyệt thật. */}
      {tabCtx && (() => {
        const t = tabs.find((x) => x.id === tabCtx.id);
        if (!t) return null;
        return (
          <div className="bt-ctx" style={{ left: tabCtx.x, top: tabCtx.y }} onClick={(e) => e.stopPropagation()}>
            <div className="bt-ctx-head" title={t.url}>{meta[t.id]?.title || t.name}</div>
            <button onClick={() => { setTabCtx(null); openNewTabPage(); }}>
              ＋ Tab mới
            </button>
            <button onClick={() => {
              setTabCtx(null);
              const api = apisRef.current.get(t.id);
              // Có bộ điều khiển thì tải lại tại chỗ (giữ lịch sử lùi/tiến);
              // chưa có (guest chưa attach) thì dựng lại webview như cũ.
              if (api) api.reload();
              else setReloadNonces((m) => ({ ...m, [t.id]: (m[t.id] ?? 0) + 1 }));
            }}>
              ↻ Tải lại
            </button>
            <button onClick={() => { duplicateTab(t.id); setTabCtx(null); }}>
              ⧉ Nhân đôi tab
            </button>
            <button onClick={() => { setTabCtx(null); pinTab(t.id, !t.pinned); }}>
              📌 {t.pinned ? 'Bỏ ghim tab' : 'Ghim tab'}
            </button>
            <button onClick={() => { setTabCtx(null); toggleMute(t.id); }} disabled={!apisRef.current.has(t.id)}>
              {meta[t.id]?.muted ? '🔊 Bật tiếng trang web' : '🔇 Tắt tiếng trang web'}
            </button>
            {/* Mở đúng trang này bằng tài khoản khác: vd. đang ở Claude hồ sơ A
                thì mở thêm một tab Claude ở hồ sơ B. */}
            {profiles.filter((p) => p.id !== findProfile(profiles, t.profile).id).length > 0 && (
              <>
                <div className="bt-menu-sep" />
                <div className="small" style={{ color: 'var(--muted)', padding: '2px 10px' }}>Mở trang này bằng hồ sơ…</div>
                {profiles.filter((p) => p.id !== findProfile(profiles, t.profile).id).map((p) => (
                  <button key={p.id} onClick={() => {
                    setTabCtx(null);
                    openTab(t.url, { name: t.name, profile: refOf(p), forceNew: true });
                  }}>
                    <ProfileDot p={p} size={14} /> {p.name}
                  </button>
                ))}
              </>
            )}
            <div className="bt-menu-sep" />
            <button onClick={() => { void navigator.clipboard?.writeText(t.url); setTabCtx(null); }}>
              ⧉ Copy địa chỉ
            </button>
            <button onClick={() => {
              setTabCtx(null);
              setEdit({ id: '', name: t.name, url: t.url, profile: t.profile ?? '', kind: 'link', order: 0, addedAt: '' });
            }}>
              ☆ Lưu vào dấu trang…
            </button>
            <div className="bt-menu-sep" />
            <button className="danger" onClick={() => { const id = t.id; setTabCtx(null); closeTab(id); }}>
              ✕ Đóng tab
            </button>
            {/* "Đóng các tab khác" chỉ có nghĩa khi thật có tab khác. Tab ghim
                được giữ lại, như Chrome. */}
            {tabs.some((x) => x.id !== t.id && !x.pinned) && (
              <button className="danger" onClick={() => {
                const keep = t.id;
                setTabCtx(null);
                closeMany((x) => x.id !== keep && !x.pinned, keep);
                setNewTabOpen(false);
              }}>
                ✕ Đóng các tab khác
              </button>
            )}
            {tabs.slice(tabs.findIndex((x) => x.id === t.id) + 1).some((x) => !x.pinned) && (
              <button className="danger" onClick={() => {
                const keep = t.id;
                setTabCtx(null);
                closeMany((x, i, all) => !x.pinned && i > all.findIndex((y) => y.id === keep));
              }}>
                ✕ Đóng các tab bên phải
              </button>
            )}
            {closed.length > 0 && (
              <>
                <div className="bt-menu-sep" />
                <button onClick={() => { setTabCtx(null); reopenClosed(); }}>
                  ↶ Mở lại tab đã đóng <span className="bt-menu-key">Ctrl+Shift+T</span>
                </button>
              </>
            )}
          </div>
        );
      })()}

      {/* Menu chuột phải trên dấu trang — như trình duyệt thật */}
      {ctx && (
        <div className="bt-ctx" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()}>
          <div className="bt-ctx-head" title={ctx.bm.url}>{ctx.bm.name}</div>
          <button onClick={() => { openBookmark(ctx.bm, true); setCtx(null); }}>
            ⊞ Mở trong tab mới
          </button>
          <button onClick={() => { openBookmark(ctx.bm); setCtx(null); }}>
            ▶ Mở ở tab này
          </button>
          <button onClick={() => { window.open(normalizeUrl(ctx.bm.url), '_blank'); setCtx(null); }}>
            ↗ Mở bằng trình duyệt ngoài
          </button>
          <div className="bt-menu-sep" />
          <button onClick={() => { void navigator.clipboard?.writeText(normalizeUrl(ctx.bm.url)); setCtx(null); }}>
            ⧉ Copy địa chỉ
          </button>
          <button onClick={() => { setEdit(structuredClone(ctx.bm)); setCtx(null); }}>✎ Sửa dấu trang</button>
          <button className="danger" onClick={() => { const b = ctx.bm; setCtx(null); void removeBookmark(b); }}>
            🗑 Xóa dấu trang
          </button>
        </div>
      )}

      {/* Modal thêm/sửa dấu trang */}
      {edit && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setEdit(null)}>
          <div className="mail-compose panel" style={{ width: 'min(520px, 94vw)' }}>
            <div className="mail-compose-head">
              <b>{justStarred && edit.id ? '★ Đã thêm dấu trang' : edit.id ? '✎ Sửa dấu trang' : '🔖 Dấu trang'}</b>
              <span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setEdit(null)}>✕</button></div>
            <input className="input" placeholder="URL (vd sso.example.com)" value={edit.url}
              onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
            <input className="input" placeholder="Tên hiển thị (mặc định: hostname)" value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <ProfileSelect profiles={profiles} value={edit.profile ?? ''} style={{ width: '100%' }}
              title="Hồ sơ sở hữu dấu trang này (mỗi hồ sơ một bộ dấu trang riêng, mở bằng phiên đăng nhập của hồ sơ đó). Đổi hồ sơ = chuyển dấu trang sang bộ của hồ sơ kia."
              onChange={(v) => setEdit({ ...edit, profile: v })} />
            <div className="glink-meta-pair">
              <input className="input" placeholder="Username (optional)" value={edit.username ?? ''}
                autoComplete="off" onChange={(e) => setEdit({ ...edit, username: e.target.value })} />
              <PasswordInput value={edit.password ?? ''} onChange={(v) => setEdit({ ...edit, password: v })}
                placeholder="Password (optional — 🔑 tự điền)" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void saveEdit()} disabled={!edit.url.trim()}>💾 {justStarred ? 'Xong' : 'Lưu'}</button>
              <button className="ghost" onClick={() => setEdit(null)}>Hủy</button>
              {/* Như bong bóng ☆ của Chrome: lỡ tay lưu thì xoá ngay tại đây,
                  không cần confirm — dấu trang vừa thêm chưa có gì để mất. */}
              {edit.id && (
                <button className="ghost danger" style={{ marginLeft: 'auto' }} onClick={() => {
                  const id = edit.id;
                  const quiet = justStarred;
                  if (!quiet && !window.confirm(`Xóa dấu trang "${edit.name}"?`)) return;
                  setEdit(null);
                  bmRemove(id).then(setBookmarks).catch((e) => setErr((e as Error).message));
                }}>🗑 Xoá</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Một tab = LinkViewer với partition theo profile.
 *
 * BỌC React.memo: đây là cây con ĐẮT NHẤT của tab Browser (LinkViewer ~760
 * dòng, bên trong là <webview>). Không có memo thì mọi lần state của
 * BrowserTabWorkspace đổi — gõ một chữ trong form "Sửa dấu trang" chẳng hạn —
 * đều render lại từng tab đang mở, và cảm giác là nhập rất lag.
 *
 * Ba callback nhận thêm `tab` rồi tự bind trong đây bằng useCallback: nếu để
 * cha tạo closure `() => closeTab(t.id)` thì tham chiếu đổi mỗi lần render và
 * memo vô hiệu — memo chỉ so sánh prop theo tham chiếu.
 */
const BrowserTab = memo(function BrowserTab({
  tab, hidden, bookmarked, onClose, onOpenNewTab, onUrlChange, onStar, onMeta, onApi, onSlot,
}: {
  tab: Tab; hidden: boolean;
  /** Trang đang xem đã có dấu trang — ☆ thành ★. */
  bookmarked: boolean;
  onClose: (id: string) => void;
  onOpenNewTab: (url: string, tab: Tab, opener?: TabOpener) => void;
  /** Guest điều hướng → báo lên để cha giữ `tab.url` luôn là trang ĐANG xem
   *  ("nhân đôi tab" cần đúng trang đó, không phải trang lúc mở tab). */
  onUrlChange: (url: string, tab: Tab) => void;
  onStar: (url: string, title: string, tab: Tab) => void;
  onMeta: (m: TabMeta, tab: Tab) => void;
  onApi: (api: ViewerApi | null, tab: Tab) => void;
  onSlot: (el: HTMLDivElement | null, tab: Tab, under?: boolean) => void;
}) {
  /* `tab` là object mới mỗi lần tab điều hướng / ghim. Các callback dưới đây
     đọc nó qua ref và chỉ phụ thuộc id, nên giữ nguyên danh tính suốt đời tab
     — nhất là `slot` (callback ref: đổi danh tính là React gọi null rồi gọi
     lại, kéo theo một lượt render thừa ở cha). */
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const close = useCallback(() => onClose(tab.id), [onClose, tab.id]);
  const openNew = useCallback(
    (u: string, opener?: TabOpener) => onOpenNewTab(u, tabRef.current, opener),
    [onOpenNewTab],
  );
  const track = useCallback((u: string) => onUrlChange(u, tabRef.current), [onUrlChange]);
  const star = useCallback((u: string, t: string) => onStar(u, t, tabRef.current), [onStar]);
  const meta = useCallback((m: TabMeta) => onMeta(m, tabRef.current), [onMeta]);
  const api = useCallback((a: ViewerApi | null) => onApi(a, tabRef.current), [onApi]);
  const slot = useCallback((el: HTMLDivElement | null) => onSlot(el, tabRef.current), [onSlot]);
  const underSlot = useCallback((el: HTMLDivElement | null) => onSlot(el, tabRef.current, true), [onSlot]);

  return (
    <LinkViewer
      name={tab.name}
      url={tab.url}
      partition={tab.partition}
      hidden={hidden}
      creds={tab.creds}
      profile={tab.profile}
      passwordManager
      addressBar
      history
      browserChrome
      bookmarked={bookmarked}
      opener={tab.opener}
      onOpenNewTab={openNew}
      onUrlChange={track}
      onClose={close}
      onStar={star}
      onMeta={meta}
      onApi={api}
      toolbarSlot={slot}
      underToolbarSlot={underSlot}
    />
  );
});

/**
 * Bảng "Tìm kiếm tab" (⌄ / Ctrl+Shift+A) — như Chrome: gõ để lọc các tab đang
 * mở theo tiêu đề/địa chỉ, ↑↓ Enter để nhảy tới; bên dưới là tab đã đóng gần
 * đây để mở lại. Portal ra <body>, cha bật cờ popup-over-webview.
 */
function TabSearch({ anchor, tabs, closed, onPick, onCloseTab, onReopen, onClose }: {
  anchor: DOMRect | null;
  tabs: { id: string; url: string; title: string; icon?: string; on: boolean }[];
  closed: ClosedTab[];
  onPick: (id: string) => void;
  onCloseTab: (id: string) => void;
  onReopen: (i: number) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const needle = q.trim().toLowerCase();
  const match = (title: string, url: string) =>
    !needle || title.toLowerCase().includes(needle) || url.toLowerCase().includes(needle);
  const open = tabs.filter((t) => match(t.title, t.url));
  const gone = closed.map((c, i) => ({ c, i })).filter(({ c }) => match(c.name, c.url)).slice(0, 8);
  const total = open.length + gone.length;
  useEffect(() => { setSel(0); }, [q]);

  const activate = (k: number) => {
    if (k < open.length) onPick(open[k].id);
    else if (gone[k - open.length]) onReopen(gone[k - open.length].i);
  };

  const W = 380;
  const left = Math.max(6, Math.min((anchor?.right ?? window.innerWidth) - W, window.innerWidth - W - 6));
  return (
    <>
      <div className="bt-menu-backdrop" onMouseDown={onClose} />
      <div className="bt-menu bt-menu-fixed bt-tabsearch-pop" style={{ left, top: (anchor?.bottom ?? 40) + 4, width: W }}
        onMouseDown={(e) => e.stopPropagation()}>
        <input className="input" autoFocus placeholder="Tìm trong các tab" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((v) => Math.min(total - 1, v + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((v) => Math.max(0, v - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); activate(sel); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          }} />
        <div className="bt-tabsearch-list">
          <div className="bt-menu-h">Tab đang mở ({open.length})</div>
          {open.length === 0 && <div className="bt-tabsearch-empty">Không có tab nào khớp</div>}
          {open.map((t, k) => (
            <div key={t.id} className={`bt-tabsearch-row${k === sel ? ' sel' : ''}${t.on ? ' cur' : ''}`}
              onMouseEnter={() => setSel(k)} onClick={() => onPick(t.id)} title={t.url}>
              <span className="bt-tab-ico">
                <span className="bt-tab-letter">{tabInitial(t.title)}</span>
                {t.icon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={t.icon} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                )}
              </span>
              <span className="bt-tabsearch-text">
                <span className="bt-tabsearch-title">{t.title}</span>
                <span className="bt-tabsearch-url">{hostOf(t.url)}</span>
              </span>
              <button className="bt-tab-x" title="Đóng tab"
                onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}>✕</button>
            </div>
          ))}
          {gone.length > 0 && <div className="bt-menu-h">Đã đóng gần đây</div>}
          {gone.map(({ c, i }, k) => (
            <div key={`${c.url}-${c.closedAt}-${i}`}
              className={`bt-tabsearch-row${open.length + k === sel ? ' sel' : ''}`}
              onMouseEnter={() => setSel(open.length + k)} onClick={() => onReopen(i)} title={c.url}>
              <span className="bt-tab-ico"><span className="bt-tab-letter">↶</span></span>
              <span className="bt-tabsearch-text">
                <span className="bt-tabsearch-title">{c.name || hostOf(c.url)}</span>
                <span className="bt-tabsearch-url">{hostOf(c.url)} · {agoText(c.closedAt)}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** "3 phút trước" — mốc thời gian tương đối cho tab đã đóng. */
function agoText(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
