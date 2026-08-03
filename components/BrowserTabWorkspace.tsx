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
    setAddr('');
  };

  const openBookmark = (b: Bookmark) =>
    openTab(b.url, { name: b.name, profile: b.profile, creds: { username: b.username, password: b.password } });

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

  return (
    <div className="panel sheet-panel">
      {/* Thanh địa chỉ + profile + dấu trang chọn nhanh */}
      <div className="bt-bar">
        <input className="input" style={{ flex: 1 }} placeholder="Gõ địa chỉ web (vd sso.example.com) rồi Enter…"
          value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
        <input className="input" style={{ width: 150 }} list="bt-profiles" placeholder="Profile (optional)"
          value={profile} onChange={(e) => setProfile(e.target.value)}
          title="Cùng profile = chung phiên đăng nhập. Hai tài khoản SSO khác nhau → hai profile." />
        <datalist id="bt-profiles">{profiles.map((p) => <option key={p} value={p} />)}</datalist>
        <button onClick={go} disabled={!addr.trim()}>▶ Mở</button>
        <button className="ghost sm" onClick={() => setEdit({ id: '', name: '', url: addr.trim(), profile: profile.trim(), addedAt: '' })}
          title="Thêm dấu trang mới">☆ Lưu trang</button>
      </div>

      {/* Dải dấu trang — chọn nhanh khỏi gõ */}
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
        {bookmarks.length === 0 && <span className="small" style={{ color: 'var(--muted)', padding: '4px 6px' }}>Chưa có dấu trang — mở một trang rồi bấm ☆ Lưu trang.</span>}
      </div>

      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '4px 0' }}>{err}</pre>}

      {/* Vùng tab viewer */}
      {tabs.length > 0 ? (
        <div className="lv-wrap" style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <div className="lv-tabbar" role="tablist">
            {tabs.map((t) => (
              <span key={t.id} className={`lv-tab${t.id === activeId ? ' on' : ''}`} title={t.url}>
                <button className="lv-tab-btn" onClick={() => setActiveId(t.id)}>
                  {t.name}{t.profile && <span className="bt-mark-prof">{t.profile}</span>}
                </button>
                <button className="lv-tab-x" onClick={() => closeTab(t.id)} title="Đóng tab">✕</button>
              </span>
            ))}
            <span style={{ flex: 1 }} />
            <button className="ghost sm" onClick={() => { setTabs([]); setActiveId(null); }}>✕ Đóng hết</button>
          </div>
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
        <div className="empty" style={{ margin: 'auto', textAlign: 'center' }}>
          <p className="small">Gõ địa chỉ ở trên hoặc chọn một 🔖 dấu trang để mở tab.</p>
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
