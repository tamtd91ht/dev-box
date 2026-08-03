'use client';

// Browser workspace — trình duyệt web đa tab TRONG app: gõ URL bất kỳ (tự thêm
// https:// nếu thiếu → tránh 404), mở nhiều tab song song, mỗi tab gán PROFILE
// để đăng nhập nhiều tài khoản SSO/SaaS khác nhau. Dấu trang (bookmark) để
// chọn nhanh khỏi gõ lại + nhớ user/pass (nút 🔑 tự điền form login).
//
// Tách khỏi tab Links (Links = bookmark tài liệu có tổ chức, dự án/tags).
// Viewer tái dùng LinkViewer (webview + fill login + save session).

import { useCallback, useEffect, useState } from 'react';
import { bmList, bmAdd, bmUpdate, bmRemove, normalizeUrl, bmPartition, type Bookmark } from '@/lib/bookmarks';
import LinkViewer from './LinkViewer';

interface Tab { id: string; name: string; url: string; profile?: string; partition: string; creds?: { username?: string; password?: string } }

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

  // Esc thoát tràn viền (chỉ host document; phím trong guest không bubble ra).
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const reload = useCallback(() => { bmList().then(setBookmarks).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { reload(); }, [reload]);

  const profiles = [...new Set(bookmarks.map((b) => b.profile).filter(Boolean) as string[])].sort();

  /** Mở một URL thành tab (dùng lại tab nếu trùng url+profile). */
  const openTab = useCallback((rawUrl: string, opts: { name?: string; profile?: string; creds?: Tab['creds'] } = {}) => {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    if (typeof window === 'undefined' || !window.workspace?.isDesktop) { window.open(url, '_blank'); return; }
    const prof = (opts.profile ?? '').trim() || undefined;
    const partition = bmPartition(prof);
    const id = `${partition}|${url}`;
    setTabs((cur) => cur.some((t) => t.id === id)
      ? cur
      : [...cur, { id, name: opts.name || hostOf(url), url, profile: prof, partition, creds: opts.creds }]);
    setActiveId(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((cur) => {
      const idx = cur.findIndex((t) => t.id === id);
      const next = cur.filter((t) => t.id !== id);
      setActiveId((a) => (a === id ? next[Math.max(0, idx - 1)]?.id ?? null : a));
      return next;
    });
  }, []);

  const go = () => {
    if (!addr.trim()) return;
    openTab(addr, { profile });
    setAddr(''); setNewTabOpen(false);
  };

  const openBookmark = (b: Bookmark) => {
    openTab(b.url, { name: b.name, profile: b.profile, creds: { username: b.username, password: b.password } });
    setNewTabOpen(false); setShowMarks(false);
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
  // Panel nhập URL hiện khi: chưa có tab nào, HOẶC người dùng bấm ＋ (new tab).
  const showAddress = !hasTabs || newTabOpen;

  /** Ô nhập URL + profile — dùng cho cả trang new-tab lẫn panel ＋. */
  const addressForm = (
    <div className="bt-addr">
      <input className="input bt-addr-input" placeholder="Gõ địa chỉ web (vd sso.example.com) rồi Enter…"
        value={addr} autoFocus onChange={(e) => setAddr(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape' && hasTabs) setNewTabOpen(false); }} />
      <input className="input" style={{ width: 130 }} list="bt-profiles" placeholder="Profile"
        value={profile} onChange={(e) => setProfile(e.target.value)}
        title="Cùng profile = chung phiên đăng nhập. Hai tài khoản SSO khác nhau → hai profile." />
      <datalist id="bt-profiles">{profiles.map((p) => <option key={p} value={p} />)}</datalist>
      <button onClick={go} disabled={!addr.trim()}>▶ Mở</button>
      {hasTabs && <button className="ghost sm" onClick={() => setNewTabOpen(false)}>Hủy</button>}
    </div>
  );

  return (
    <div className={`bt-root${full ? ' bt-full' : ''}`}>
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
          <button className="bt-newtab" onClick={() => { setNewTabOpen(true); setAddr(''); }} title="Tab mới (mở ô nhập địa chỉ)">＋</button>
          <span style={{ flex: 1 }} />
          {/* Menu ⋯ gom các nút phụ như trình duyệt thật */}
          <div className="bt-menu-wrap">
            <button className={`ghost sm${menuOpen ? ' on' : ''}`} onClick={() => setMenuOpen((v) => !v)} title="Thêm">⋯</button>
            {menuOpen && (
              <>
                <div className="bt-menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="bt-menu">
                  <button onClick={() => { setShowMarks((v) => !v); setMenuOpen(false); }}>🔖 Dấu trang ({bookmarks.length})</button>
                  <button onClick={() => { const t = tabs.find((x) => x.id === activeId); setEdit({ id: '', name: t?.name ?? '', url: t?.url ?? '', profile: t?.profile ?? '', addedAt: '' }); setMenuOpen(false); }}>☆ Lưu trang hiện tại</button>
                  <button onClick={() => { setFull((v) => !v); setMenuOpen(false); }}>{full ? '🗕 Thoát tràn viền' : '🗖 Tràn viền'}</button>
                  <div className="bt-menu-sep" />
                  <button onClick={() => { setTabs([]); setActiveId(null); setMenuOpen(false); }}>✕ Đóng tất cả tab</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Panel new-tab (＋) — ô nhập địa chỉ đè lên trên, đóng lại khi mở xong. */}
      {hasTabs && newTabOpen && <div className="bt-newtab-panel">{addressForm}</div>}

      {/* Dải dấu trang — bật từ menu ⋯ */}
      {showMarks && (
        <div className="bt-marks">
          {bookmarks.map((b) => (
            <span key={b.id} className="bt-mark" title={`${b.url}${b.profile ? ` · ${b.profile}` : ''}`}>
              <button className="bt-mark-go" onClick={() => openBookmark(b)}>
                🔖 {b.name}{b.profile && <span className="bt-mark-prof">{b.profile}</span>}
              </button>
              <button className="bt-mark-act" onClick={() => setEdit(structuredClone(b))} title="Sửa">✎</button>
              <button className="bt-mark-act" onClick={() => void removeBookmark(b)} title="Xóa">✕</button>
            </span>
          ))}
          {bookmarks.length === 0 && <span className="small" style={{ color: 'var(--muted)', padding: '4px 6px' }}>Chưa có dấu trang — mở trang rồi ☆ Lưu trang.</span>}
        </div>
      )}

      {/* ── Vùng nội dung ── */}
      {hasTabs ? (
        <div className="lv-wrap bt-viewer">
          <div className="lv-body">
            {tabs.map((t) => (
              <BrowserTab key={t.id} tab={t} hidden={t.id !== activeId} onClose={() => closeTab(t.id)}
                onSaveBookmark={async (name, url) => {
                  await bmAdd(url, { name, profile: t.profile, ...t.creds });
                  reload();
                }} />
            ))}
          </div>
        </div>
      ) : (
        /* CHƯA có tab: trang "new tab" — ô nhập địa chỉ + dấu trang chọn nhanh. */
        <div className="bt-home">
          <div className="bt-home-title">🌐 Mở một trang web</div>
          {addressForm}
          {bookmarks.length > 0 && (
            <div className="bt-home-marks">
              <div className="small" style={{ color: 'var(--muted)', width: '100%', marginBottom: 4 }}>Dấu trang</div>
              {bookmarks.map((b) => (
                <span key={b.id} className="bt-mark" title={`${b.url}${b.profile ? ` · ${b.profile}` : ''}`}>
                  <button className="bt-mark-go" onClick={() => openBookmark(b)}>
                    🔖 {b.name}{b.profile && <span className="bt-mark-prof">{b.profile}</span>}
                  </button>
                  <button className="bt-mark-act" onClick={() => setEdit(structuredClone(b))} title="Sửa">✎</button>
                  <button className="bt-mark-act" onClick={() => void removeBookmark(b)} title="Xóa">✕</button>
                </span>
              ))}
            </div>
          )}
          <p className="small" style={{ color: 'var(--muted)' }}>Nhiều tab mở song song; mỗi profile giữ phiên đăng nhập riêng.</p>
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
              <input className="input" type="password" placeholder="Password (optional — 🔑 tự điền)" value={edit.password ?? ''}
                autoComplete="new-password" onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
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
function BrowserTab({ tab, hidden, onClose, onSaveBookmark }: {
  tab: Tab; hidden: boolean; onClose: () => void; onSaveBookmark: (name: string, url: string) => Promise<void>;
}) {
  return (
    <LinkViewer
      name={tab.name}
      url={tab.url}
      partition={tab.partition}
      hidden={hidden}
      creds={tab.creds}
      onClose={onClose}
      onSaveLink={onSaveBookmark}
    />
  );
}

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
