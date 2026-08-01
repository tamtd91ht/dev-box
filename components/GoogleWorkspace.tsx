'use client';

// Google workspace — quản lý tài liệu Google Drive cho dev/techlead nhiều dự án,
// MULTI-ACCOUNT: đăng nhập nhiều tài khoản Google song song, chuyển bằng chip
// trên toolbar; roots/danh sách/duyệt thư mục đều theo tài khoản đang chọn.
// Ba phân vùng: 📁 Dự án (đăng ký link thư mục Drive gốc của từng dự án, duyệt
// cây con), 📝 Docs và 📊 Sheets (danh sách toàn Drive — My Drive + Shared
// Drives — mới sửa trước, tìm theo tên, lọc ⭐). Mọi thứ READ-ONLY: mở file là
// nhảy sang Google trong browser; DevBox chỉ điều hướng.
//
// Đăng nhập: OAuth loopback — server giữ token (.googleauth.json, danh sách
// accounts), UI chỉ mở URL consent trong tab mới rồi poll status. "＋ Thêm tài
// khoản" chạy lại flow với prompt=select_account.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  gStatus, gAuthUrl, gLogout, gRoots, gRootAdd, gRootRemove, gBrowse, gList,
  mimeIcon, fmtRel, G_MIME,
  type GFile, type GList as GListT, type GoogleAccount, type GoogleStatus, type GRoot,
} from '@/lib/google';

type Section = 'projects' | 'docs' | 'sheets';

const ACTIVE_ACCOUNT_KEY = 'google.activeAccount';

const SECTIONS: { key: Section; icon: string; label: string; hint: string }[] = [
  { key: 'projects', icon: '📁', label: 'Dự án', hint: 'thư mục Drive đã đăng ký' },
  { key: 'docs', icon: '📝', label: 'Docs', hint: 'toàn bộ Google Docs' },
  { key: 'sheets', icon: '📊', label: 'Sheets', hint: 'toàn bộ Google Sheets' },
];

/** Row for one Drive file — name + owner + modified, opens in a new tab. */
function FileRow({ f }: { f: GFile }) {
  const owner = f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? '';
  return (
    <a className="g-row" href={f.webViewLink} target="_blank" rel="noreferrer" title={`${f.name} — mở trong Drive`}>
      <span className="g-ico" aria-hidden>{mimeIcon(f.mimeType)}</span>
      <span className="g-name">
        <span className="g-base">{f.starred && <span className="g-star" aria-hidden>⭐</span>}{f.name}</span>
        <span className="g-meta">{owner}{owner && f.modifiedTime ? ' · ' : ''}{fmtRel(f.modifiedTime)}</span>
      </span>
      <span className="g-open" aria-hidden>↗</span>
    </a>
  );
}

/** 📝/📊 section — self-contained list with search + ⭐ filter + pagination.
 *  Mounted with key=accountId, so switching accounts starts a fresh list. */
function KindList({ accountId, kind }: { accountId: string; kind: 'docs' | 'sheets' }) {
  const [q, setQ] = useState('');
  const [starred, setStarred] = useState(false);
  const [files, setFiles] = useState<GFile[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async (opts: { q: string; starred: boolean; pageToken?: string; append?: boolean }) => {
    setLoading(true); setErr(null);
    try {
      const res = await gList(accountId, kind, { q: opts.q || undefined, starred: opts.starred, pageToken: opts.pageToken });
      setFiles((cur) => (opts.append ? [...cur, ...res.files] : res.files));
      setNext(res.nextPageToken);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [accountId, kind]);

  useEffect(() => {
    if (!loadedOnce.current) { loadedOnce.current = true; void load({ q: '', starred: false }); }
  }, [load]);

  const search = () => void load({ q, starred });

  return (
    <div className="g-list-wrap">
      <div className="g-toolbar">
        <input
          className="input g-search"
          placeholder={`Tìm ${kind === 'docs' ? 'Google Docs' : 'Google Sheets'} theo tên…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button
          className={`chip-btn${starred ? ' on' : ''}`}
          onClick={() => { const s = !starred; setStarred(s); void load({ q, starred: s }); }}
          title="Chỉ hiện file đã gắn sao trên Drive"
        >
          ⭐ Đã gắn sao
        </button>
        <button className="ghost sm" onClick={search} disabled={loading} title="Tìm / tải lại">
          {loading ? <span className="spinner" aria-hidden /> : '🔍'} Tìm
        </button>
      </div>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
      <div className="g-list">
        {files.map((f) => <FileRow key={f.id} f={f} />)}
        {!loading && files.length === 0 && !err && (
          <div className="empty" style={{ padding: '24px 8px' }}><p className="small">Không có kết quả.</p></div>
        )}
      </div>
      {next && (
        <div style={{ padding: '8px 0' }}>
          <button className="ghost sm" disabled={loading} onClick={() => void load({ q, starred, pageToken: next, append: true })}>
            ↓ Tải thêm
          </button>
        </div>
      )}
    </div>
  );
}

/** 📁 section — one account's registered roots (left) + folder browser (right). */
function ProjectsView({ accountId }: { accountId: string }) {
  const [roots, setRoots] = useState<GRoot[]>([]);
  const [activeRoot, setActiveRoot] = useState<GRoot | null>(null);
  /** Breadcrumb path inside the active root; [0] is the root itself. */
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [listing, setListing] = useState<GListT | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [addUrl, setAddUrl] = useState('');
  const [addName, setAddName] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    gRoots(accountId).then(setRoots).catch((e) => setErr((e as Error).message));
  }, [accountId]);

  const openFolder = useCallback(async (id: string, name: string, root?: GRoot) => {
    setLoading(true); setErr(null);
    try {
      const res = await gBrowse(accountId, id);
      setListing(res);
      if (root) { setActiveRoot(root); setTrail([{ id, name }]); }
      else setTrail((t) => {
        const at = t.findIndex((x) => x.id === id);
        return at >= 0 ? t.slice(0, at + 1) : [...t, { id, name }];
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  const add = async () => {
    if (!addUrl.trim()) return;
    setAdding(true); setErr(null);
    try {
      const list = await gRootAdd(accountId, addUrl, addName);
      setRoots(list);
      setAddUrl(''); setAddName('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (r: GRoot) => {
    if (!window.confirm(`Bỏ "${r.name}" khỏi danh sách? (không đụng gì tới Drive)`)) return;
    try {
      await gRootRemove(r.id);
      setRoots(await gRoots(accountId));
      if (activeRoot?.id === r.id) { setActiveRoot(null); setListing(null); setTrail([]); }
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const folders = listing?.files.filter((f) => f.mimeType === G_MIME.folder) ?? [];
  const files = listing?.files.filter((f) => f.mimeType !== G_MIME.folder) ?? [];

  return (
    <div className="g-projects">
      <aside className="g-rail">
        <div className="group-title" style={{ margin: '0 4px 6px' }}>Thư mục dự án</div>
        {roots.map((r) => (
          <div key={r.id} className={`g-root${activeRoot?.id === r.id ? ' on' : ''}`}>
            <button className="g-root-btn" onClick={() => void openFolder(r.folderId, r.name, r)} title={r.url}>
              <span aria-hidden>📁</span>
              <span className="g-root-name">{r.name}</span>
            </button>
            <a className="ghost sm g-root-act" href={r.url} target="_blank" rel="noreferrer" title="Mở trong Drive">↗</a>
            <button className="ghost sm g-root-act" onClick={() => void remove(r)} title="Bỏ khỏi danh sách">✕</button>
          </div>
        ))}
        {roots.length === 0 && (
          <p className="small" style={{ color: 'var(--muted)', margin: '4px 6px 10px' }}>
            Dán link thư mục Drive của dự án (thuộc tài khoản này) để bắt đầu — vd folder tài liệu OMICX.
          </p>
        )}
        <div className="g-add">
          <input className="input" placeholder="Link thư mục Drive…" value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
          <input className="input" placeholder="Tên hiển thị (mặc định: tên folder)" value={addName}
            onChange={(e) => setAddName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
          <button className="sm" onClick={() => void add()} disabled={adding || !addUrl.trim()}>
            {adding ? <span className="spinner" aria-hidden /> : '＋'} Đăng ký
          </button>
        </div>
      </aside>

      <div className="g-main">
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        {!activeRoot ? (
          <div className="empty" style={{ margin: 'auto' }}>
            <p className="small">Chọn một dự án bên trái để duyệt tài liệu.</p>
          </div>
        ) : (
          <>
            <div className="g-crumbs">
              {trail.map((t, i) => (
                <span key={t.id} className="g-crumb-wrap">
                  {i > 0 && <span className="g-crumb-sep" aria-hidden>›</span>}
                  <button
                    className={`g-crumb${i === trail.length - 1 ? ' on' : ''}`}
                    onClick={() => void openFolder(t.id, t.name)}
                  >
                    {t.name}
                  </button>
                </span>
              ))}
              {loading && <span className="spinner" aria-hidden />}
            </div>
            <div className="g-list">
              {folders.map((f) => (
                <button key={f.id} className="g-row" onClick={() => void openFolder(f.id, f.name)} title={f.name}>
                  <span className="g-ico" aria-hidden>📁</span>
                  <span className="g-name"><span className="g-base">{f.name}</span></span>
                  <span className="g-open" aria-hidden>›</span>
                </button>
              ))}
              {files.map((f) => <FileRow key={f.id} f={f} />)}
              {!loading && listing && listing.files.length === 0 && (
                <div className="empty" style={{ padding: '24px 8px' }}><p className="small">Thư mục trống.</p></div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Compact label for an account chip: phần trước @ (đủ nhận ra trong team). */
function accLabel(a: GoogleAccount): string {
  if (!a.email) return a.id.slice(0, 8);
  return a.email.split('@')[0];
}

export default function GoogleWorkspace() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [activeId, setActiveId] = useState<string>('');
  const [section, setSection] = useState<Section>('projects');
  const [err, setErr] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await gStatus();
      setSt(s); setEnabled(true);
      setActiveId((cur) => {
        const remembered = typeof window !== 'undefined' ? window.localStorage.getItem(ACTIVE_ACCOUNT_KEY) ?? '' : '';
        const pick = [cur, remembered].find((id) => id && s.accounts.some((a) => a.id === id));
        return pick || s.accounts[0]?.id || '';
      });
      return s;
    } catch (e) {
      if ((e as Error & { status?: number }).status === 403) setEnabled(false);
      else { setEnabled(true); setErr((e as Error).message); }
      return null;
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);
  useEffect(() => {
    if (activeId && typeof window !== 'undefined') window.localStorage.setItem(ACTIVE_ACCOUNT_KEY, activeId);
  }, [activeId]);

  /** Mở consent flow — dùng cho đăng nhập đầu tiên VÀ "＋ Thêm tài khoản". */
  const addAccount = async () => {
    setErr(null);
    try {
      const { url } = await gAuthUrl();
      window.open(url, '_blank', 'noopener');
      setWaiting(true);
      const before = st?.accounts.length ?? 0;
      if (pollRef.current) clearInterval(pollRef.current);
      let tries = 0;
      pollRef.current = setInterval(async () => {
        tries += 1;
        const s = await refreshStatus();
        if ((s && s.accounts.length > before) || tries > 60) {
          if (pollRef.current) clearInterval(pollRef.current);
          setWaiting(false);
          // Tài khoản mới thêm trở thành tài khoản đang chọn.
          if (s && s.accounts.length > before) {
            const known = new Set((st?.accounts ?? []).map((a) => a.id));
            const fresh = s.accounts.find((a) => !known.has(a.id));
            if (fresh) setActiveId(fresh.id);
          }
        }
      }, 2000);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const removeAccount = async (a: GoogleAccount) => {
    if (!window.confirm(`Đăng xuất ${a.email ?? a.id}? (revoke + xóa token trên máy này)`)) return;
    try {
      await gLogout(a.id);
      await refreshStatus();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', width: 'min(560px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>Ⓖ</div>
          <div className="office-hero-title">Google tab đang tắt</div>
          <p className="office-hero-sub">
            Đặt <code>GOOGLE_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
          </p>
        </div>
      </div>
    );
  }
  if (enabled === null || !st) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  // ── Setup / first-login screens ─────────────────────────────────────────────

  if (!st.configured) {
    return (
      <div className="panel office-hero-panel" style={{ margin: 'auto', width: 'min(680px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>Ⓖ</div>
          <div className="office-hero-title">Kết nối Google Drive</div>
          <p className="office-hero-sub">Cần một OAuth client (5 phút, một lần cho mỗi máy — dùng chung cho mọi tài khoản):</p>
        </div>
        <ol className="g-setup">
          <li>Mở <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">console.cloud.google.com/apis/credentials</a> → <b>Create credentials → OAuth client ID</b> (type <b>Web application</b>).</li>
          <li>Thêm redirect URI: <code>{st.redirectUri}</code></li>
          <li>Bật <b>Google Drive API</b> cho project (APIs &amp; Services → Library).</li>
          <li>Thêm vào <code>.env.local</code>:
            <pre className="code">GOOGLE_CLIENT_ID=…{'\n'}GOOGLE_CLIENT_SECRET=…</pre>
          </li>
          <li>Khởi động lại dev server rồi quay lại tab này.</li>
        </ol>
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
      </div>
    );
  }

  if (st.accounts.length === 0) {
    return (
      <div className="panel office-hero-panel" style={{ margin: 'auto', width: 'min(680px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>Ⓖ</div>
          <div className="office-hero-title">Đăng nhập Google</div>
          <p className="office-hero-sub">
            Quản lý tài liệu Drive theo dự án — duyệt thư mục, tìm Docs/Sheets, mở nhanh.
            Hỗ trợ NHIỀU tài khoản song song; quyền chỉ-đọc (<code>drive.readonly</code>); token lưu trên máy này.
          </p>
          <div className="office-hero-points">
            <span className="office-point">👥 Nhiều tài khoản</span>
            <span className="office-point">📁 Thư mục theo dự án</span>
            <span className="office-point">📝 Docs · 📊 Sheets</span>
            <span className="office-point">🔒 Chỉ đọc</span>
          </div>
          <button className="office-cta" onClick={() => void addAccount()} disabled={waiting}>
            {waiting ? <span className="spinner" aria-hidden /> : 'Ⓖ'} {waiting ? 'Đang chờ đăng nhập…' : 'Đăng nhập Google'}
          </button>
          {waiting && <p className="small" style={{ color: 'var(--muted)' }}>Hoàn tất đăng nhập ở tab vừa mở — DevBox sẽ tự nhận.</p>}
          {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        </div>
      </div>
    );
  }

  // ── Signed in (≥1 account) ──────────────────────────────────────────────────

  const active = st.accounts.find((a) => a.id === activeId) ?? st.accounts[0];

  return (
    <div className="panel sheet-panel">
      <div className="sheet-toolbar">
        <div className="office-subnav" role="tablist" aria-label="Google sections" style={{ flex: 1 }}>
          {SECTIONS.map((s) => (
            <button key={s.key} role="tab" aria-selected={section === s.key}
              className={`office-subnav-btn${section === s.key ? ' on' : ''}`}
              onClick={() => setSection(s.key)}>
              <span className="office-subnav-ico" aria-hidden>{s.icon}</span>
              <span className="office-subnav-text">
                {s.label}
                <span className="office-subnav-hint">{s.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {/* Account switcher — một chip mỗi tài khoản, ✕ trên chip đang chọn. */}
        <div className="g-accounts" role="tablist" aria-label="Google accounts">
          {st.accounts.map((a) => (
            <span key={a.id} className={`g-acc${a.id === active.id ? ' on' : ''}`} title={a.email ?? a.id}>
              <button className="g-acc-btn" role="tab" aria-selected={a.id === active.id} onClick={() => setActiveId(a.id)}>
                Ⓖ {accLabel(a)}
              </button>
              {a.id === active.id && (
                <button className="g-acc-x" onClick={() => void removeAccount(a)} title={`Đăng xuất ${a.email ?? a.id}`}>✕</button>
              )}
            </span>
          ))}
          <button className="ghost sm" onClick={() => void addAccount()} disabled={waiting} title="Đăng nhập thêm một tài khoản Google khác">
            {waiting ? <span className="spinner" aria-hidden /> : '＋'} Tài khoản
          </button>
        </div>
      </div>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '6px 0' }}>{err}</pre>}

      {/* key=account id → đổi tài khoản là remount sạch dữ liệu của account đó */}
      <div className="office-body">
        {section === 'projects' && <ProjectsView key={`p-${active.id}`} accountId={active.id} />}
        {section === 'docs' && <KindList key={`d-${active.id}`} accountId={active.id} kind="docs" />}
        {section === 'sheets' && <KindList key={`s-${active.id}`} accountId={active.id} kind="sheets" />}
      </div>
    </div>
  );
}
