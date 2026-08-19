'use client';

// Browser workspace — trình duyệt web đa tab TRONG app: ô địa chỉ kiểu trình
// duyệt thật (URL thì tự thêm https://, KHÔNG phải URL thì tìm Google luôn),
// mở nhiều tab song song, mỗi tab gán PROFILE
// để đăng nhập nhiều tài khoản SSO/SaaS khác nhau. Dấu trang (bookmark) để
// chọn nhanh khỏi gõ lại + nhớ user/pass (nút 🔑 tự điền form login).
//
// Tách khỏi tab Links (Links = bookmark tài liệu có tổ chức, dự án/tags).
// Viewer tái dùng LinkViewer (webview + fill login + save session).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bmList, bmAdd, bmAddFolder, bmUpdate, bmMove, bmRemove,
  normalizeUrl, bmPartition, type Bookmark,
} from '@/lib/bookmarks';
import BrowserExtensions from './BrowserExtensions';
import BrowserExtBar from './BrowserExtBar';
import BookmarkBar from './BookmarkBar';
import LinkViewer from './LinkViewer';
import PasswordManager from './PasswordManager';
import { onOpenUrl } from '@/lib/openTarget';
import PasswordInput from './PasswordInput';

interface Tab { id: string; name: string; url: string; profile?: string; partition: string; creds?: { username?: string; password?: string } }

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
  const [showMarks, setShowMarks] = useState(false); // dải dấu trang gập lại mặc định
  const [menuOpen, setMenuOpen] = useState(false); // menu ⋯ (lưu/dấu trang/tràn viền)
  const [newTabOpen, setNewTabOpen] = useState(false); // panel nhập URL khi đã có tab
  const [ctx, setCtx] = useState<Ctx | null>(null); // menu chuột phải trên dấu trang
  const [pwOpen, setPwOpen] = useState(false); // modal 🔑 Mật khẩu đã lưu
  const [extOpen, setExtOpen] = useState(false); // modal 🧩 Extension (chỉ tab Browser)
  /** Tăng lên để BUỘC remount viewer của tab đang xem (nút ↻ trên thanh
   *  extension). Đổi `key` là React dựng <webview> mới → trang tải lại từ đầu
   *  → content script của extension được chèn lại. Không có cách nào nhẹ hơn:
   *  content script chỉ chèn vào lúc trang tải. */
  const [reloadNonce, setReloadNonce] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Id các tab đang mở — đọc đồng bộ trong openTab để biết tab đã tồn tại chưa
  // (state `tabs` trong closure có thể cũ khi mở liên tiếp nhiều tab).
  const existedRef = useRef<Set<string>>(new Set());
  // Ảnh chụp mới nhất của tabs/activeId — listener IPC (đăng ký MỘT lần) đọc ra
  // để biết tab nào đang xem, khỏi phải gỡ/gắn lại mỗi lần đổi tab.
  const tabsRef = useRef<Tab[]>([]);
  const activeRef = useRef<string | null>(null);
  // openTab được useCallback([]) nên đọc state qua ref, không qua closure.
  const newTabOpenRef = useRef(false);
  tabsRef.current = tabs;
  activeRef.current = activeId;
  newTabOpenRef.current = newTabOpen;

  // Esc thoát tràn viền (chỉ host document; phím trong guest không bubble ra).
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  // Click bất kỳ đâu (hoặc chuột phải chỗ khác) → đóng menu ngữ cảnh.
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close, true);
    };
  }, [ctx]);

  const reload = useCallback(() => { bmList().then(setBookmarks).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { reload(); }, [reload]);

  const profiles = [...new Set(bookmarks.map((b) => b.profile).filter(Boolean) as string[])].sort();

  /** Mở một URL thành tab (dùng lại tab nếu trùng url+profile).
   *  background: thêm tab nhưng KHÔNG nhảy sang — như "mở trong tab mới" của
   *  trình duyệt thật; tab đã mở sẵn thì vẫn chỉ kích hoạt lại (id = partition|url). */
  const openTab = useCallback((rawUrl: string, opts: { name?: string; profile?: string; creds?: Tab['creds']; background?: boolean } = {}) => {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    if (typeof window === 'undefined' || !window.workspace?.isDesktop) { window.open(url, '_blank'); return; }
    const prof = (opts.profile ?? '').trim() || undefined;
    const partition = bmPartition(prof);
    const id = `${partition}|${url}`;
    const existed = existedRef.current.has(id);
    existedRef.current.add(id);
    setTabs((cur) => (cur.some((t) => t.id === id)
      ? cur
      : [...cur, { id, name: opts.name || hostOf(url), url, profile: prof, partition, creds: opts.creds }]));
    // Tab mới ở chế độ background: giữ nguyên tab đang xem. Nhưng nếu chưa có
    // tab nào nổi, hoặc tab đó đã mở sẵn, thì đưa lên cho khỏi bấm mò.
    //
    // `newTabOpenRef`: đang ở trang new-tab thì activeId = null một cách CÓ CHỦ
    // Ý, không phải "chưa có gì để xem" — kéo tab nền lên lúc này là hất người
    // dùng khỏi ô địa chỉ họ đang gõ dở.
    if (!opts.background) { setActiveId(id); setNewTabOpen(false); }
    else setActiveId((a) => ((a === null && !newTabOpenRef.current) || existed ? id : a));
  }, []);

  // Link bấm trong tin nhắn Zalo/Telegram đã chọn "Mở trong Browser của app".
  // OpenLinkDialog phát event hai lần (lo tab vừa mount chưa kịp nghe); openTab
  // dựng id từ partition+url nên gọi trùng chỉ kích hoạt lại đúng tab đó.
  useEffect(() => onOpenUrl('browser', (u) => openTab(u)), [openTab]);

  // Link target=_blank / window.open bấm TRONG một tab → tab MỚI ngay ở đây,
  // như trình duyệt thật (main.cjs, nhánh BROWSER_PARTITION). Mở nền: trang
  // đang xem giữ nguyên, đúng thói quen "mở ngầm rồi đọc sau".
  // Profile lấy theo tab đang hoạt động để tab con dùng chung phiên đăng nhập.
  useEffect(() => {
    if (!window.workspace?.onOpenInBrowserTab) return;
    return window.workspace.onOpenInBrowserTab((u) => {
      const from = tabsRef.current.find((t) => t.id === activeRef.current);
      openTab(u, { profile: from?.profile, background: true });
    });
  }, [openTab]);

  const closeTab = useCallback((id: string) => {
    existedRef.current.delete(id);
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
   * chrome.tabs.update tu popup extension → doi dia chi TAB DANG XEM.
   *
   * Id cua tab la `${partition}|${url}` nen doi URL la doi ca id — phai doi
   * ca activeId theo, khong thi tab vua doi khong con la tab dang xem nua va
   * khung duoi nhay ve trang new-tab.
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
      const nextId = `${t.partition}|${url}`;
      // Da o dung dia chi roi thi khong dung vao — tranh tai lai trang.
      if (nextId === t.id) return list;
      const next = [...list];
      next[i] = { ...t, id: nextId, url, name: hostOf(url) };
      existedRef.current.delete(cur);
      existedRef.current.add(nextId);
      setActiveId(nextId);
      return next;
    });
  }, [openTab]);

  // Popup extension goi chrome.tabs.create → mo tab moi that.
  useEffect(() => {
    const off = window.browserExt?.onOpenTab?.((url: string) => openTab(url));
    return () => { off?.(); };
  }, [openTab]);

  const go = () => {
    if (!addr.trim()) return;
    openTab(addr, { profile });
    setAddr(''); setNewTabOpen(false);
  };

  /** Mở dấu trang. background = chuột phải → "Mở trong tab mới": thêm tab
   *  nhưng giữ nguyên trang đang xem, và giữ dải dấu trang/panel mở để chọn tiếp. */
  const openBookmark = (b: Bookmark, background = false) => {
    openTab(b.url, {
      name: b.name, profile: b.profile, background,
      creds: { username: b.username, password: b.password },
    });
    if (!background) { setNewTabOpen(false); setShowMarks(false); }
  };

  const closeAllTabs = () => {
    existedRef.current.clear();
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

  /** Tạo thư mục — hỏi tên rồi lưu. */
  const newFolder = useCallback(async (parentId?: string) => {
    const name = window.prompt('Tên thư mục mới:');
    if (!name || !name.trim()) return;
    try { setBookmarks(await bmAddFolder(name.trim(), parentId)); }
    catch (e) { setErr((e as Error).message); }
  }, []);

  /** Kéo thả: chuyển một mục sang thư mục khác / đổi vị trí. */
  const moveBookmarkTo = useCallback(async (id: string, parentId?: string, beforeId?: string) => {
    try { setBookmarks(await bmMove(id, parentId, beforeId)); }
    catch (e) { setErr((e as Error).message); }
  }, []);

  /** Thả một URL (kéo từ ô địa chỉ) vào thanh hoặc vào một thư mục. */
  const dropUrl = useCallback(async (rawUrl: string, parentId?: string) => {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    try {
      setBookmarks(await bmAdd(url, { parentId, name: hostOf(url) }));
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

  /** Danh sách dấu trang chọn nhanh — dùng cho cả trang new-tab lẫn panel ＋. */
  const marksList = bookmarks.some((b) => b.kind === 'link') && (
    <div className="bt-home-marks">
      <div className="small" style={{ color: 'var(--muted)', width: '100%', marginBottom: 4 }}>
        Dấu trang <span style={{ color: 'var(--faint)' }}>— chuột phải: mở trong tab mới</span>
      </div>
      {/* Chỉ LINK: folder không có URL để mở, đưa vào đây chỉ tổ bấm nhầm.
          Cấu trúc thư mục xem ở thanh dấu trang phía trên. */}
      {bookmarks.filter((b) => b.kind === 'link').map(markChip)}
    </div>
  );

  /** Ô nhập URL + profile — dùng cho cả trang new-tab lẫn panel ＋. */
  const addressForm = (
    <div className="bt-addr">
      <input className="input bt-addr-input" placeholder="Gõ địa chỉ web hoặc từ khóa tìm Google rồi Enter…"
        value={addr} autoFocus onChange={(e) => setAddr(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape' && hasTabs) cancelNewTab(); }} />
      <input className="input" style={{ width: 130 }} list="bt-profiles" placeholder="Profile"
        value={profile} onChange={(e) => setProfile(e.target.value)}
        title="Cùng profile = chung phiên đăng nhập. Hai tài khoản SSO khác nhau → hai profile." />
      <datalist id="bt-profiles">{profiles.map((p) => <option key={p} value={p} />)}</datalist>
      <button onClick={go} disabled={!addr.trim()}>▶ Mở</button>
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
            <span key={t.id} className={`lv-tab${t.id === activeId ? ' on' : ''}`} title={t.url}>
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
            onReloadPage={() => setReloadNonce((n) => n + 1)}
          />
          {/* Menu ⋯ gom các nút phụ như trình duyệt thật */}
          <div className="bt-menu-wrap">
            <button className={`ghost sm${menuOpen ? ' on' : ''}`} onClick={() => setMenuOpen((v) => !v)} title="Thêm">⋯</button>
            {menuOpen && (
              <>
                <div className="bt-menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="bt-menu">
                  <button onClick={() => { setShowMarks((v) => !v); setMenuOpen(false); }}>
                    🔖 {showMarks ? 'Ẩn' : 'Hiện'} thanh dấu trang ({bookmarks.filter((b) => b.kind === 'link').length})
                  </button>
                  <button onClick={() => { const t = tabs.find((x) => x.id === activeId); setEdit({ id: '', name: t?.name ?? '', url: t?.url ?? '', profile: t?.profile ?? '', kind: 'link', order: 0, addedAt: '' }); setMenuOpen(false); }}>☆ Lưu trang hiện tại</button>
                  <button onClick={() => { setShowMarks(true); void newFolder(); setMenuOpen(false); }}>📁 Thư mục mới</button>
                  <button onClick={() => { setPwOpen(true); setMenuOpen(false); }}>🔑 Mật khẩu đã lưu</button>
                  <button onClick={() => { setFull((v) => !v); setMenuOpen(false); }}>{full ? '🗕 Thoát tràn viền' : '🗖 Tràn viền'}</button>
                  <div className="bt-menu-sep" />
                  <button onClick={() => { closeAllTabs(); setMenuOpen(false); }}>✕ Đóng tất cả tab</button>
                </div>
              </>
            )}
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
          onNewFolder={(pid) => void newFolder(pid)}
          onMove={(id, pid, before) => void moveBookmarkTo(id, pid, before)}
          onDropUrl={(url, pid) => void dropUrl(url, pid)}
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
                // Nonce CHỈ áp cho tab đang xem: đưa vào key của mọi tab thì
                // bấm ↻ sẽ tải lại cả những tab nền, mất hết trạng thái của
                // chúng dù người dùng không đụng tới.
                key={t.id === activeId ? `${t.id}#${reloadNonce}` : t.id}
                tab={t} hidden={t.id !== activeId} onClose={() => closeTab(t.id)}
                onOpenNewTab={(u) => openTab(u, { profile: t.profile, background: true })}
                onSaveBookmark={async (name, url) => {
                  await bmAdd(url, { name, profile: t.profile, ...t.creds });
                  reload();
                }} />
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
                title="Extension — thêm/bật/tắt cho tab Browser">🧩 Extension</button>
            </p>
          </div>
        )
      )}

      {/* Trình quản lý mật khẩu đã lưu */}
      {pwOpen && <PasswordManager onClose={() => setPwOpen(false)} />}
      {extOpen && <BrowserExtensions onClose={() => setExtOpen(false)} />}

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

/** Một tab = LinkViewer với partition theo profile. */
function BrowserTab({ tab, hidden, onClose, onSaveBookmark, onOpenNewTab }: {
  tab: Tab; hidden: boolean; onClose: () => void; onSaveBookmark: (name: string, url: string) => Promise<void>;
  onOpenNewTab: (url: string) => void;
}) {
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
      onOpenNewTab={onOpenNewTab}
      onClose={onClose}
      onSaveLink={onSaveBookmark}
    />
  );
}

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
