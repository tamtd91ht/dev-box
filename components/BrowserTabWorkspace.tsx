'use client';

// Browser workspace — trình duyệt web đa tab TRONG app: ô địa chỉ kiểu trình
// duyệt thật (URL thì tự thêm https://, KHÔNG phải URL thì tìm Google luôn),
// mở nhiều tab song song, mỗi tab gán PROFILE
// để đăng nhập nhiều tài khoản SSO/SaaS khác nhau. Dấu trang (bookmark) để
// chọn nhanh khỏi gõ lại + nhớ user/pass (nút 🔑 tự điền form login).
//
// Tách khỏi tab Links (Links = bookmark tài liệu có tổ chức, dự án/tags).
// Viewer tái dùng LinkViewer (webview + fill login + save session).

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  bmList, bmAdd, bmAddFolder, bmUpdate, bmMove, bmRemove,
  normalizeUrl, bmPartition, bmTree, type Bookmark, type BmNode,
} from '@/lib/bookmarks';
import BrowserExtensions from './BrowserExtensions';
import BrowserExtBar from './BrowserExtBar';
import BookmarkBar from './BookmarkBar';
import LinkViewer, { type TabOpener } from './LinkViewer';
import PasswordManager from './PasswordManager';
import DupTabDialog, { tabUrlKey } from './DupTabDialog';
import { onOpenUrl } from '@/lib/openTarget';
import PasswordInput from './PasswordInput';
import AddressSuggest, { useAddressSuggest } from './AddressSuggest';
import BrowserHistory from './BrowserHistory';
import {
  TABS_KEY, serialize as serializeSession, restore as restoreSession,
} from '@/lib/browserSession';
import { usePopupOverWebview } from '@/lib/useOverWebview';

interface Tab {
  id: string; name: string; url: string; profile?: string; partition: string;
  creds?: { username?: string; password?: string };
  /** Tab này mở từ liên kết trong tab khác → ngữ cảnh tab cha (Referer +
   *  sessionStorage) để trang đích không mất bộ lọc/phân trang. Xem `TabOpener`
   *  trong LinkViewer. Chỉ dùng cho lần tải đầu của tab. */
  opener?: TabOpener;
}

/** Chuột phải trên một dấu trang → menu ngữ cảnh tại toạ độ con trỏ. */
interface Ctx { x: number; y: number; bm: Bookmark }

export default function BrowserTabWorkspace() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [addr, setAddr] = useState('');
  const [profile, setProfile] = useState('');
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

  /** Ctrl/Cmd+Shift+B ẩn/hiện thanh dấu trang — đúng phím của Chrome.
   *
   *  Bắt ở `document` chứ không phải trên .bt-root: focus hầu như luôn nằm
   *  TRONG <webview>, mà guest là process riêng nên keydown của nó không nổi
   *  lên DOM của host. Nghe ở document thì mọi lúc con trỏ ở phần chrome của
   *  app (thanh tab, ô địa chỉ, thanh dấu trang) phím đều ăn. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        toggleMarks();
        return;
      }
      // Ctrl+H mở Lịch sử — đúng phím của Chrome. KHÔNG kèm Shift (Ctrl+Shift+H
      // là phím khác hẳn), và bỏ qua khi con trỏ đang ở một ô nhập của app:
      // vài ô dùng Ctrl+H làm xoá lùi, cướp mất thì gõ rất khó chịu.
      if (!e.shiftKey && (e.key === 'H' || e.key === 'h')) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setHistOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleMarks]);
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
    } catch { /* localStorage bị chặn — mở bàn trắng, không phải lỗi đáng kêu */ }
    setHydrated(true);
  }, []);

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

  const profiles = [...new Set(bookmarks.map((b) => b.profile).filter(Boolean) as string[])].sort();

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
    setTabs((cur) => [...cur, {
      id, name: opts.name || hostOf(url), url, profile: prof, partition, creds: opts.creds,
      opener: opts.opener,
    }]);
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
  useEffect(() => onOpenUrl('browser', (u) => openTab(u)), [openTab]);

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

  const closeTab = useCallback((id: string) => {
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
  }, []);

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
      return [...cur.slice(0, i + 1), copy, ...cur.slice(i + 1)];
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
    if (!cur) { openTab(url); return; }
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
    const off = window.browserExt?.onOpenTab?.((url: string) => openTab(url));
    return () => { off?.(); };
  }, [openTab]);

  /* Hai callback ổn định cho BrowserTab (React.memo). Nhận `tab` làm tham số
     thay vì bắt biến từ closure — nhờ vậy tham chiếu không đổi giữa các lần
     render, và memo mới thật sự chặn được render lại của <webview>. */
  const openTabBackground = useCallback((url: string, tab: Tab) => {
    openTab(url, { profile: tab.profile, background: true });
  }, [openTab]);

  const trackUrlFromTab = useCallback((url: string, tab: Tab) => {
    trackUrl(tab.id, url);
  }, [trackUrl]);

  const saveBookmarkFromTab = useCallback(async (name: string, url: string, tab: Tab) => {
    await bmAdd(url, { name, profile: tab.profile, ...tab.creds });
    reload();
  }, [reload]);

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
   *  Cho phép cả khi ô còn TRỐNG (khác ô trong tab): trang new-tab đang trống
   *  trơn, hiện ngay các trang vào gần đây là đúng thứ người dùng cần — chẳng
   *  che mất gì cả. */
  const [addrFocus, setAddrFocus] = useState(false);
  const addrSug = useAddressSuggest({ query: addr, onPick: goSuggest, enabled: addrFocus });

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

  const closeAllTabs = () => {
    setTabs([]); setActiveId(null);
    // Cùng lý do như closeTab: hết tab mà panel new-tab còn bật là kẹt màn hình.
    setNewTabOpen(false);
  };

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
    setNewTabOpen(true);
    setAddr('');
    setActiveId(null);
  };

  /** Hủy trang new-tab → quay lại tab đang xem trước đó (nếu còn). */
  const cancelNewTab = () => {
    setNewTabOpen(false);
    setActiveId((a) => a ?? tabs[tabs.length - 1]?.id ?? null);
  };

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
      list = await bmAddFolder(part, pid);
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
  }, []);

  // Dùng cờ `popup` chứ không phải `modal`: mấy hộp thoại này nhỏ, giữ được
  // thanh tab và thanh dấu trang phía sau thì người dùng còn thấy mình đang ở
  // tab nào (xem lib/useOverWebview.ts để biết khác biệt hai cờ).
  //
  // MỌI overlay của file này phải có mặt trong biểu thức dưới đây. Thiếu một cái
  // là nó bị <webview> che kín, và vì guest là process riêng nên cú bấm lẫn phím
  // gõ đi vào TRANG WEB chứ không vào ô nhập — `edit` từng bị sót, triệu chứng
  // là "sửa tên dấu trang không được, bàn phím như bị chặn". Menu ⋯ cũng vậy:
  // z-index 21 không cứu được gì trước tầng native.
  usePopupOverWebview(!!folderAsk || menuOpen || !!dupAsk || !!edit || !!tabCtx);

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
        if (url) setBookmarks(await bmAdd(url, { parentId: deepest, name: hostOf(url) }));
      }
    } catch (e) { setErr((e as Error).message); }
  }, [folderAsk, createFolders]);

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
      const list = await bmAdd(url, { parentId, name: hostOf(url) });
      if (!beforeId) { setBookmarks(list); return; }
      // Mục vừa thêm là mục có order lớn nhất trong thư mục đích.
      const added = list
        .filter((b) => b.parentId === parentId)
        .reduce<Bookmark | null>((m, b) => (!m || b.order > m.order ? b : m), null);
      setBookmarks(added ? await bmMove(added.id, parentId, beforeId) : list);
    } catch (e) { setErr((e as Error).message); }
  }, []);

  /** Một chip dấu trang — click mở tại chỗ, chuột phải ra menu (tab mới…). */
  const markChip = (b: Bookmark) => (
    <span key={b.id} className="bt-mark" title={`${b.url}${b.profile ? ` · ${b.profile}` : ''} — chuột phải để mở trong tab mới`}
      onContextMenu={(ev) => openCtx(ev, b)}>
      <button className="bt-mark-go" onClick={() => openBookmark(b)}
        onAuxClick={(ev) => { if (ev.button === 1) { ev.preventDefault(); openBookmark(b, true); } }}>
        🔖 {b.name}{b.profile && <span className="bt-mark-prof">{b.profile}</span>}
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
  const marksList = bookmarks.length > 0 && (
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
        walk(bmTree(bookmarks), 0);
        return rows;
      })()}
    </div>
  );

  /** Ô nhập URL + profile — dùng cho cả trang new-tab lẫn panel ＋. */
  const addressForm = (
    <div className="bt-addr">
      {/* Khung neo cho danh sách gợi ý (position:absolute). Phải bọc RIÊNG ô
          URL, không dùng cả .bt-addr: danh sách sẽ rộng bằng cả hàng, trùm qua
          ô Profile và hai cái nút. */}
      <div className="bt-addr-wrap">
        <input className="input bt-addr-input" placeholder="Gõ địa chỉ web hoặc từ khóa tìm Google rồi Enter…"
          value={addrSug.preview ?? addr} autoFocus onChange={(e) => setAddr(e.target.value)}
          onFocus={() => setAddrFocus(true)}
          // Xem ghi chú ở ô địa chỉ của LinkViewer: KHÔNG đóng danh sách tại
          // onBlur, vì bấm vào một dòng cũng làm ô mất focus.
          onBlur={() => setAddrFocus(false)}
          onKeyDown={(e) => {
            if (addrSug.onKeyDown(e)) return;
            if (e.key === 'Enter') go();
            if (e.key === 'Escape' && hasTabs) cancelNewTab();
          }} />
        <AddressSuggest {...addrSug.listProps} />
      </div>
      <input className="input" style={{ width: 130 }} list="bt-profiles" placeholder="Profile"
        value={profile} onChange={(e) => setProfile(e.target.value)}
        title="Cùng profile = chung phiên đăng nhập. Hai tài khoản SSO khác nhau → hai profile." />
      <datalist id="bt-profiles">{profiles.map((p) => <option key={p} value={p} />)}</datalist>
      {/* Bấm "▶ Mở" phải mở ĐÚNG thứ đang hiện trong ô. Đang chọn một dòng gợi
          ý bằng ↑↓ thì ô hiện URL của dòng đó nhưng `addr` vẫn là chữ gõ dở
          (có thể rỗng) — dựa vào `addr` thì nút xám đi hoặc mở sai trang. */}
      <button
        onClick={() => { if (addrSug.preview) goSuggest(addrSug.preview); else go(); }}
        disabled={!addrSug.preview && !addr.trim()}
      >
        ▶ Mở
      </button>
      {hasTabs && <button className="ghost sm" onClick={cancelNewTab}>Hủy</button>}
    </div>
  );

  return (
    <div className={`bt-root${full ? ' bt-full' : ''}`} ref={rootRef}>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '4px 0' }}>{err}</pre>}

      {/* ── Có tab: thanh tab + ＋ new tab + ⋯ menu (KHÔNG còn ô địa chỉ thừa) ── */}
      {hasTabs && (
        <div className="lv-tabbar bt-tabbar" role="tablist">
          {tabs.map((t) => (
            <span
              key={t.id}
              className={`lv-tab${t.id === activeId ? ' on' : ''}`}
              title={t.url}
              // Chuột phải TRÊN TAB → menu "Nhân đôi / Đóng…", như trình duyệt.
              // Toạ độ quy về gốc .bt-root (menu position:absolute trong đó),
              // giống openCtx của dấu trang.
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const host = rootRef.current?.getBoundingClientRect();
                const MW = 230, MH = 200;
                setTabCtx({
                  x: Math.min(ev.clientX - (host?.left ?? 0), Math.max(0, (host?.width ?? MW) - MW)),
                  y: Math.min(ev.clientY - (host?.top ?? 0), Math.max(0, (host?.height ?? MH) - MH)),
                  id: t.id,
                });
              }}
            >
              <button className="lv-tab-btn" onClick={() => { setActiveId(t.id); setNewTabOpen(false); }}>
                {t.name}{t.profile && <span className="bt-mark-prof">{t.profile}</span>}
              </button>
              <button className="lv-tab-x" onClick={() => closeTab(t.id)} title="Đóng tab">✕</button>
            </span>
          ))}
          <button className="bt-newtab" onClick={openNewTabPage} title="Tab mới (khung dưới trống, gõ địa chỉ để mở)">＋</button>
          <span style={{ flex: 1 }} />
          {/* Thanh công cụ extension — icon từng extension có popup, cộng nút
              🧩 quản lý. Đứng NGOÀI menu ⋯ như Chrome: đang ở trang bất kỳ vẫn
              bấm được ngay. */}
          <BrowserExtBar
            partition={tabs.find((t) => t.id === activeId)?.partition ?? bmPartition(profile || undefined)}
            activeUrl={tabs.find((t) => t.id === activeId)?.url ?? ''}
            onNavigate={navigateActive}
            onManage={() => setExtOpen(true)}
            onReloadPage={() => {
              const cur = activeRef.current;
              if (cur) setReloadNonces((m) => ({ ...m, [cur]: (m[cur] ?? 0) + 1 }));
            }}
          />
          {/* Nút cấu hình ⋯ — như menu ba chấm của Chrome.
              Menu PORTAL ra <body> + position:fixed, KHÔNG để absolute trong
              .bt-menu-wrap: thanh tab (.lv-tabbar) có `overflow-x: auto`, tức là
              một khung cắt — menu absolute bên trong bị cắt cụt theo chiều cao
              thanh tab nên thả xuống là mất hút. Đây mới là lý do thật nút ⋯
              không dùng được khi đang ở trong một trang. */}
          <div className="bt-menu-wrap">
            <button
              ref={menuBtnRef}
              className={`ghost sm${menuOpen ? ' on' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              title="Cấu hình tab Browser"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >⋯</button>
          </div>
        </div>
      )}

      {/* Panel new-tab (＋) — ô nhập địa chỉ + DẤU TRANG chọn nhanh (như trang
          new-tab của trình duyệt thật), đóng lại khi mở xong. */}
      {hasTabs && newTabOpen && (
        <div className="bt-newtab-panel">
          {addressForm}
          {marksList}
        </div>
      )}

      {/* Thanh dấu trang — cây thư mục như Chrome. Bật/tắt từ menu ⋯. */}
      {showMarks && (
        <BookmarkBar
          bookmarks={bookmarks}
          onOpen={(b, background) => openBookmark(b, background)}
          onEdit={(b) => setEdit(structuredClone(b))}
          onRemove={(b) => void removeBookmark(b)}
          onNewFolder={(pid) => newFolder(pid)}
          onNewFolderWith={(id, pid) => setFolderAsk({ parentId: pid, name: '', moveId: id })}
          onMove={(id, pid, before) => void moveBookmarkTo(id, pid, before)}
          onHideBar={hideMarks}
          onDropUrl={(url, pid, before) => void dropUrl(url, pid, before)}
        />
      )}

      {/* ── Vùng nội dung ──
          Các tab LUÔN được mount khi còn tồn tại, kể cả lúc đang ở trang
          new-tab (activeId = null): unmount <webview> là huỷ phiên đang chạy,
          quay lại tab phải tải lại trang từ đầu và mất cả chỗ đang đọc. Trang
          new-tab chỉ nằm ĐÈ lên, tab nền vẫn nguyên vẹn phía sau. */}
      {hasTabs && (
        <div className="lv-wrap bt-viewer" hidden={activeId === null}>
          <div className="lv-body">
            {tabs.map((t) => (
              <BrowserTab
                // Nonce riêng của TỪNG tab: chỉ đổi khi bấm ↻ đúng tab đó, nên
                // chuyển tab qua lại không làm key đổi → webview không bị huỷ,
                // trang và vị trí đang xem giữ nguyên như trình duyệt thật.
                key={`${t.id}#${reloadNonces[t.id] ?? 0}`}
                tab={t}
                hidden={t.id !== activeId}
                // Truyền các hàm ỔN ĐỊNH (useCallback ở trên) chứ không phải
                // closure tạo mới mỗi lần render: BrowserTab bọc React.memo, mà
                // memo so sánh prop theo tham chiếu — closure mới là mỗi lần gõ
                // một chữ trong form "Sửa dấu trang" lại render lại TOÀN BỘ
                // <webview> đang mở. Đó chính là chỗ gây lag khi nhập.
                onClose={closeTab}
                onOpenNewTab={openTabBackground}
                onSaveBookmark={saveBookmarkFromTab}
                onUrlChange={trackUrlFromTab}
              />
            ))}
          </div>
        </div>
      )}

      {/* Trang "new tab" — hiện khi chưa chọn tab nào (chưa có tab, hoặc vừa ＋).
          Bấm ＋ thì ô địa chỉ + dấu trang đã nằm ở panel phía trên rồi, nên ở
          đây chỉ để TRỐNG kèm một dòng nhắc: vẽ lại lần hai là hai ô giống hệt
          nhau trên cùng màn hình, không biết gõ vào ô nào. */}
      {activeId === null && (
        // `hasTabs &&` là LƯỚI AN TOÀN, không thừa: dòng "gõ địa chỉ ở ô phía
        // trên" chỉ đúng khi thanh tab còn đó để chứa cái ô ấy. Hết tab mà vẫn
        // rơi vào nhánh này thì màn hình kẹt hẳn — không ô nhập, không lối ra,
        // chuyển tab khác rồi quay lại vẫn thế vì state không tự phục hồi.
        // closeTab/closeAllTabs đã tắt cờ, nhưng chặn ở đây thì mọi đường dẫn
        // tới trạng thái đó đều an toàn.
        (hasTabs && newTabOpen) ? (
          <div className="bt-home">
            <p className="small" style={{ color: 'var(--muted)' }}>
              Tab mới — gõ địa chỉ ở ô phía trên rồi Enter.
            </p>
          </div>
        ) : (
          <div className="bt-home">
            <div className="bt-home-title">🌐 Mở một trang web</div>
            {addressForm}
            {marksList}
            <p className="small" style={{ color: 'var(--muted)' }}>
              Nhiều tab mở song song; mỗi profile giữ phiên đăng nhập riêng.{' '}
              <button className="ghost sm" onClick={() => setPwOpen(true)}
                title="Xem/sửa mật khẩu đã lưu — tự điền khi mở lại trang">🔑 Mật khẩu đã lưu</button>{' '}
              <button className="ghost sm" onClick={() => setExtOpen(true)}
                title="Extension — thêm/bật/tắt cho tab Browser">🧩 Extension</button>{' '}
              {/* Cùng công tắc với menu ⋯, nhưng menu ⋯ chỉ có khi đã mở tab —
                  ở trang chủ mà tắt thanh dấu trang thì không còn chỗ nào bật
                  lại được ngoài phím tắt. */}
              <button className="ghost sm" onClick={toggleMarks}
                title="Ẩn/hiện thanh dấu trang (Ctrl+Shift+B)">
                🔖 {showMarks ? 'Ẩn' : 'Hiện'} thanh dấu trang
              </button>
            </p>
          </div>
        )
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

      {/* Menu cấu hình ⋯ — portal ra <body> để thoát khỏi khung cắt
          `overflow-x: auto` của thanh tab. Neo theo rect của nút. */}
      {mounted && menuOpen && createPortal(
        <>
          <div className="bt-menu-backdrop" onMouseDown={() => setMenuOpen(false)} />
          <div
            className="bt-menu bt-menu-fixed"
            role="menu"
            style={(() => {
              const r = menuBtnRef.current?.getBoundingClientRect();
              const W = 250;
              return {
                // Canh phải theo nút, kẹp trong màn hình để không tràn mép.
                left: Math.max(6, Math.min((r?.right ?? window.innerWidth) - W, window.innerWidth - W - 6)),
                top: (r?.bottom ?? 40) + 4,
              };
            })()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Mục bật/tắt kiểu Chrome: có dấu ✓ cho biết trạng thái hiện tại,
                nhãn KHÔNG đổi theo trạng thái. Nhãn kiểu "Ẩn/Hiện" đọc mơ hồ —
                không rõ đang mô tả trạng thái hay hành động sắp làm. */}
            <button role="menuitemcheckbox" aria-checked={showMarks}
              onClick={() => { toggleMarks(); setMenuOpen(false); }}>
              <span className="bt-menu-check">{showMarks ? '✓' : ''}</span>
              Hiện thanh dấu trang
              <span className="bt-menu-key">Ctrl+Shift+B</span>
            </button>
            <div className="bt-menu-sep" />
            {/* Nhân đôi tab ĐANG XEM. Chỉ bấm được khi thật có tab đang xem:
                ở trang new-tab (activeId = null) thì chẳng có gì để nhân. */}
            <button disabled={!activeId}
              onClick={() => { const cur = activeId; setMenuOpen(false); if (cur) duplicateTab(cur); }}>
              <span className="bt-menu-check" />⧉ Nhân đôi tab
            </button>
            <div className="bt-menu-sep" />
            <button onClick={() => { const t = tabs.find((x) => x.id === activeId); setEdit({ id: '', name: t?.name ?? '', url: t?.url ?? '', profile: t?.profile ?? '', kind: 'link', order: 0, addedAt: '' }); setMenuOpen(false); }}>
              <span className="bt-menu-check" />☆ Lưu trang hiện tại…
            </button>
            <button onClick={() => { setMarks(true); setMenuOpen(false); void dropUrl(tabs.find((x) => x.id === activeId)?.url ?? ''); }}>
              <span className="bt-menu-check" />🔖 Lưu nhanh vào thanh dấu trang
            </button>
            <button onClick={() => { setMarks(true); setMenuOpen(false); newFolder(); }}>
              <span className="bt-menu-check" />📁 Thư mục mới…
            </button>
            <div className="bt-menu-sep" />
            <button onClick={() => { setHistOpen(true); setMenuOpen(false); }}>
              <span className="bt-menu-check" />🕘 Lịch sử
              <span className="bt-menu-key">Ctrl+H</span>
            </button>
            <button onClick={() => { setPwOpen(true); setMenuOpen(false); }}>
              <span className="bt-menu-check" />🔑 Mật khẩu đã lưu
            </button>
            <button onClick={() => { setExtOpen(true); setMenuOpen(false); }}>
              <span className="bt-menu-check" />🧩 Extension
            </button>
            <button role="menuitemcheckbox" aria-checked={full}
              onClick={() => { setFull((v) => !v); setMenuOpen(false); }}>
              <span className="bt-menu-check">{full ? '✓' : ''}</span>
              Tràn viền
            </button>
            <div className="bt-menu-sep" />
            <button className="danger" onClick={() => { closeAllTabs(); setMenuOpen(false); }}>
              <span className="bt-menu-check" />✕ Đóng tất cả tab
            </button>
          </div>
        </>,
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

      {/* Menu chuột phải TRÊN MỘT TAB của dải tab — như trình duyệt thật. */}
      {tabCtx && (() => {
        const t = tabs.find((x) => x.id === tabCtx.id);
        if (!t) return null;
        return (
          <div className="bt-ctx" style={{ left: tabCtx.x, top: tabCtx.y }} onClick={(e) => e.stopPropagation()}>
            <div className="bt-ctx-head" title={t.url}>{t.name}</div>
            <button onClick={() => { duplicateTab(t.id); setTabCtx(null); }}>
              ⧉ Nhân đôi tab
            </button>
            <button onClick={() => {
              setTabCtx(null);
              setReloadNonces((m) => ({ ...m, [t.id]: (m[t.id] ?? 0) + 1 }));
            }}>
              ↻ Tải lại
            </button>
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
            {/* "Đóng các tab khác" chỉ có nghĩa khi thật có tab khác. */}
            {tabs.length > 1 && (
              <button className="danger" onClick={() => {
                const keep = t.id;
                setTabCtx(null);
                setTabs((cur) => cur.filter((x) => x.id === keep));
                setActiveId(keep);
                setNewTabOpen(false);
              }}>
                ✕ Đóng các tab khác
              </button>
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
            <div className="mail-compose-head"><b>🔖 Dấu trang</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setEdit(null)}>✕</button></div>
            <input className="input" placeholder="URL (vd sso.example.com)" value={edit.url}
              onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
            <input className="input" placeholder="Tên hiển thị (mặc định: hostname)" value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <input className="input" list="bt-profiles" placeholder="Profile phiên đăng nhập (optional)" value={edit.profile ?? ''}
              onChange={(e) => setEdit({ ...edit, profile: e.target.value })} />
            <div className="glink-meta-pair">
              <input className="input" placeholder="Username (optional)" value={edit.username ?? ''}
                autoComplete="off" onChange={(e) => setEdit({ ...edit, username: e.target.value })} />
              <PasswordInput value={edit.password ?? ''} onChange={(v) => setEdit({ ...edit, password: v })}
                placeholder="Password (optional — 🔑 tự điền)" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void saveEdit()} disabled={!edit.url.trim()}>💾 Lưu</button>
              <button className="ghost" onClick={() => setEdit(null)}>Hủy</button>
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
const BrowserTab = memo(function BrowserTab({ tab, hidden, onClose, onSaveBookmark, onOpenNewTab, onUrlChange }: {
  tab: Tab; hidden: boolean;
  onClose: (id: string) => void;
  onSaveBookmark: (name: string, url: string, tab: Tab) => Promise<void>;
  onOpenNewTab: (url: string, tab: Tab) => void;
  /** Guest điều hướng → báo lên để cha giữ `tab.url` luôn là trang ĐANG xem
   *  ("nhân đôi tab" cần đúng trang đó, không phải trang lúc mở tab). */
  onUrlChange: (url: string, tab: Tab) => void;
}) {
  const close = useCallback(() => onClose(tab.id), [onClose, tab.id]);
  const openNew = useCallback((u: string) => onOpenNewTab(u, tab), [onOpenNewTab, tab]);
  const save = useCallback((name: string, url: string) => onSaveBookmark(name, url, tab), [onSaveBookmark, tab]);
  const track = useCallback((u: string) => onUrlChange(u, tab), [onUrlChange, tab]);

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
      opener={tab.opener}
      onOpenNewTab={openNew}
      onUrlChange={track}
      onClose={close}
      onSaveLink={save}
    />
  );
});

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
