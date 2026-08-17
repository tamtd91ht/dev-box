'use client';

// Google workspace — quản lý tài liệu Google Drive cho dev/techlead nhiều dự án,
// MULTI-ACCOUNT: đăng nhập nhiều tài khoản Google song song, chuyển bằng chip
// trên toolbar; mọi thứ bên dưới đều theo tài khoản đang chọn.
//
// Cây phân cấp đi từ trên xuống, đúng như Drive thật:
//   tài khoản → Drive (🏠 My Drive · 👥 Shared Drive) → thư mục con → tài liệu
// và TẠO MỚI được (thư mục / Google Docs / Google Sheets) ngay tại thư mục đang
// đứng. Bốn phân vùng: 📁 Drive (cây + tạo mới), 🔗 Được share (dán link file
// người khác share — không nằm trong Drive của mình nên cây không thấy), 📝 Docs
// và 📊 Sheets (danh sách phẳng toàn Drive, mới sửa trước, tìm/lọc ⭐).
//
// QUYỀN: drive.readonly để DUYỆT + drive.file để TẠO. drive.file chỉ cho sửa file
// do chính app tạo, nên tài liệu cũ không có đường nào bị DevBox sửa hay xoá —
// giới hạn này do Google giữ ở tầng token. Sửa nội dung vẫn mở editor của Google.
//
// Đăng nhập: OAuth loopback — server giữ token (.googleauth.json, danh sách
// accounts), UI chỉ mở URL consent trong tab mới rồi poll status. "＋ Thêm tài
// khoản" chạy lại flow với prompt=select_account.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  gStatus, gAuthUrl, gLogout, gRoots, gRootAdd, gRootRemove, gBrowse, gList,
  mimeIcon, fmtRel, withAuthuser, gDownload, gCanDownload, G_MIME,
  gDocLinks, gDocResolve, gDocLinkRemove, gDocLinkRename, gDocLinkPin, gDocLinkTouch, gDocDownload,
  gDrives, gCreate, isReauthError,
  type GFile, type GList as GListT, type GoogleAccount, type GoogleStatus, type GRoot, type GDocLink,
  type GDriveRoot,
} from '@/lib/google';
import { lAdd } from '@/lib/links';
import GoogleDocViewer from './GoogleDocViewer';
import GoogleFilePreview from './GoogleFilePreview';
import GoogleAuthWindow from './GoogleAuthWindow';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

/**
 * Liên kết Google chết được PHÁT HIỆN ở tầng sâu (một lệnh browse/list bất kỳ
 * trong view con), nhưng nút sửa nằm ở banner trên toolbar — nơi biết danh sách
 * tài khoản. Cầu nối là event này: view con chỉ cần báo "có ca reauth", component
 * gốc nghe được thì refresh status để cờ `invalid` (server vừa ghi lúc refresh
 * thất bại) hiện thành banner ngay, không phải chờ người dùng F5.
 *
 * Dùng event của window thay vì thread callback qua 4 view × chục chỗ catch: các
 * view con không cần biết gì về khái niệm "liên kết lại".
 */
const REAUTH_EVENT = 'devbox:google-reauth';

/**
 * Lỗi để hiện trong các view con. Khi liên kết Google đã chết thì KHÔNG in lại
 * cả câu dài ở đây: banner "🔗 Liên kết lại" trên toolbar đã nói rõ và có nút
 * sửa, in hai lần chỉ làm người đọc tưởng là hai vấn đề khác nhau.
 */
const gErrText = (e: unknown) => {
  if (!isReauthError(e)) return (e as Error).message;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(REAUTH_EVENT));
  return 'Liên kết Google đã hết hiệu lực — bấm "🔗 Liên kết lại" ở thanh trên.';
};

/** What the in-app viewer is currently showing (desktop shell only). */
interface ViewerTarget { name: string; url: string }

/** File đang xem bằng API-preview (GoogleFilePreview). */
interface PreviewTarget { fileId: string; name: string; webViewLink?: string }

/** Mở THƯ MỤC Drive bằng URL: desktop → webview (giao diện Drive đầy đủ);
 *  browser thường → tab mới. */
type OpenInApp = (name: string, url: string) => void;

/** Mở FILE Drive: luôn đi đường API-preview (file private không mở được
 *  trong webview vì Google chặn đăng nhập embedded browser). */
type OpenFile = (f: GFile) => void;

type Section = 'projects' | 'shared' | 'docs' | 'sheets';

const ACTIVE_ACCOUNT_KEY = 'google.activeAccount';

const SECTIONS: { key: Section; icon: string; label: string; hint: string }[] = [
  { key: 'projects', icon: '📁', label: 'Drive', hint: 'duyệt cây · tạo mới' },
  { key: 'shared', icon: '🔗', label: 'Được share', hint: 'dán link tài liệu để xem' },
  { key: 'docs', icon: '📝', label: 'Docs', hint: 'toàn bộ Google Docs' },
  { key: 'sheets', icon: '📊', label: 'Sheets', hint: 'toàn bộ Google Sheets' },
];

/** Row for one Drive file — name + owner + modified. Click = xem TRONG APP
 *  (API-preview, chỉ đọc); ⬇ = tải về máy; ↗ = mở browser ngoài (editor thật). */
function FileRow({ accountId, f, onOpen }: { accountId: string; f: GFile; onOpen: OpenFile }) {
  const owner = f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? '';
  return (
    <a
      className="g-row"
      href={f.webViewLink}
      onClick={(e) => {
        e.preventDefault();
        onOpen(f);
      }}
      title={`${f.name} — xem trong app (chỉ đọc)`}
    >
      <span className="g-ico" aria-hidden>{mimeIcon(f.mimeType)}</span>
      <span className="g-name">
        <span className="g-base">{f.starred && <span className="g-star" aria-hidden>⭐</span>}{f.name}</span>
        <span className="g-meta">{owner}{owner && f.modifiedTime ? ' · ' : ''}{fmtRel(f.modifiedTime)}</span>
      </span>
      {gCanDownload(f.mimeType) && (
        <span
          className="g-open"
          title="Tải về máy (Docs→.docx, Sheets→.xlsx, Slides→.pdf) — tự lưu vào thư mục Downloads"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            gDownload(accountId, f.id);
          }}
        >
          ⬇
        </span>
      )}
      <span
        className="g-open"
        title="Mở bằng trình duyệt ngoài"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (f.webViewLink) window.open(f.webViewLink, '_blank');
        }}
      >
        ↗
      </span>
    </a>
  );
}

/** 📝/📊 section — self-contained list with search + ⭐ filter + pagination.
 *  Mounted with key=accountId, so switching accounts starts a fresh list. */
function KindList({ accountId, kind, onOpen }: { accountId: string; kind: 'docs' | 'sheets'; onOpen: OpenFile }) {
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
      setErr(gErrText(e));
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
        <button className="ghost sm" onClick={search} disabled={loading} title="Tìm theo tên">
          🔍 Tìm
        </button>
        <button className="ghost sm" onClick={search} disabled={loading} title="Tải lại danh sách">
          {loading ? <span className="spinner" aria-hidden /> : '↻'}
        </button>
      </div>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
      <div className="g-list">
        {files.map((f) => <FileRow key={f.id} accountId={accountId} f={f} onOpen={onOpen} />)}
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

/** Hộp thoại tạo mới: chọn loại + đặt tên, tạo vào thư mục đang đứng. */
function CreateBox({ parentName, busy, onCreate, onClose }: {
  parentName: string;
  busy: boolean;
  onCreate: (kind: 'folder' | 'doc' | 'sheet', name: string) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'folder' | 'doc' | 'sheet'>('doc');
  const [name, setName] = useState('');
  /** Tên để trống thì dùng nhãn mặc định, đúng như Google (tài liệu "Không có
   *  tiêu đề") — bắt đặt tên trước mới cho tạo là thêm một bước không cần thiết.
   *  Thư mục thì vẫn nên có tên, nhưng cũng không chặn. */
  const fallback = kind === 'folder' ? 'Thư mục không có tiêu đề' : 'Không có tiêu đề';
  const submit = () => onCreate(kind, name.trim() || fallback);
  return (
    <div className="g-create">
      <div className="g-create-head">
        Tạo mới trong <b>{parentName}</b>
        <span style={{ flex: 1 }} />
        <button className="ghost sm" onClick={onClose} title="Đóng">✕</button>
      </div>
      <div className="g-create-kinds">
        {([
          { k: 'doc' as const, ico: '📝', label: 'Google Docs' },
          { k: 'sheet' as const, ico: '📊', label: 'Google Sheets' },
          { k: 'folder' as const, ico: '📁', label: 'Thư mục' },
        ]).map((o) => (
          <button
            key={o.k}
            className={`g-create-kind${kind === o.k ? ' on' : ''}`}
            onClick={() => setKind(o.k)}
            aria-pressed={kind === o.k}
          >
            <span aria-hidden>{o.ico}</span> {o.label}
          </button>
        ))}
      </div>
      <div className="g-create-row">
        <input
          className="input"
          autoFocus
          placeholder={`${fallback} (để trống cũng được)`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') onClose();
          }}
        />
        <button className="sm" onClick={submit} disabled={busy}>
          {busy ? <span className="spinner" aria-hidden /> : '＋'} Tạo
        </button>
      </div>
    </div>
  );
}

/**
 * 📁 section — cây Drive của MỘT tài khoản: My Drive / Shared Drives → thư mục
 * con → tài liệu, tạo mới ngay tại thư mục đang đứng.
 *
 * Cột trái có hai cụm, khác nhau về bản chất nên không trộn:
 *   • "Drive của tài khoản" — cây THẬT, luôn đúng, không cần đăng ký gì
 *   • "Lối tắt" — link thư mục đã dán tay, để nhảy thẳng vào folder sâu (kể cả
 *     folder người khác share mà không nằm trong Drive của mình)
 */
function ProjectsView({ accountId, accountEmail, canWrite, onGrantWrite, onOpen, onOpenUrl }: {
  accountId: string;
  /** Email tài khoản — gắn ?authuser= khi mở file mới, để Google mở đúng profile
   *  thay vì profile đăng nhập gần nhất trong webview. */
  accountEmail?: string;
  /** Tài khoản đã có quyền tạo file chưa (drive.file). */
  canWrite: boolean;
  /** Mời cấp quyền tạo file — tài khoản đăng nhập từ trước chỉ có readonly. */
  onGrantWrite: () => void;
  /** Mở file → API-preview. */
  onOpen: OpenFile;
  /** Mở folder bằng giao diện Drive (webview) — "Quản lý trong Drive". */
  onOpenUrl: OpenInApp;
}) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--gp-rail', min: 170, max: 520, gap: 12 });
  const [drives, setDrives] = useState<GDriveRoot[]>([]);
  const [roots, setRoots] = useState<GRoot[]>([]);
  /** Gốc đang duyệt — một Drive, hoặc một lối tắt đã đăng ký. */
  const [activeRoot, setActiveRoot] = useState<{ key: string; name: string } | null>(null);
  /** Breadcrumb path inside the active root; [0] is the root itself. */
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [listing, setListing] = useState<GListT | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [addUrl, setAddUrl] = useState('');
  const [addName, setAddName] = useState('');
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const reloadRoots = useCallback(() => {
    gRoots(accountId).then(setRoots).catch((e) => setErr(gErrText(e)));
  }, [accountId]);
  useEffect(() => { reloadRoots(); }, [reloadRoots]);

  /** Duyệt vào một thư mục. `root` đặt lại breadcrumb từ đầu. */
  const openFolder = useCallback(async (
    id: string,
    name: string,
    root?: { key: string; name: string },
  ) => {
    // KHÔNG đóng hộp "Tạo mới" ở đây: nó nằm ngoài nhánh duyệt và đích tạo đi
    // theo thư mục đang đứng, nên người dùng có thể mở hộp rồi đi tìm chỗ tạo.
    // Đóng nó lúc điều hướng là xoá luôn tên vừa gõ.
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
      setErr(gErrText(e));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  // Tầng gốc: My Drive + Shared Drives. Đây là thứ làm cây "thật" — không phụ
  // thuộc vào việc người dùng có đăng ký link nào hay chưa.
  //
  // MỞ SẴN My Drive: vào mục này mà thấy khung trống rỗng thì không rõ phải làm
  // gì tiếp; mở sẵn thư mục gốc là thấy ngay nội dung thật.
  // (Đặt DƯỚI openFolder vì effect gọi nó — const không hoist.)
  useEffect(() => {
    let alive = true;
    gDrives(accountId)
      .then((d) => {
        if (!alive) return;
        setDrives(d);
        const my = d[0];
        if (my) void openFolder(my.id, my.name, { key: `drive:${my.id}`, name: my.name });
      })
      .catch((e) => { if (alive) setErr(gErrText(e)); });
    return () => { alive = false; };
  }, [accountId, openFolder]);

  /** Thư mục đang đứng — đích của "Tạo mới" và của nút tải lại. */
  const cwd = trail[trail.length - 1] ?? null;

  /** Trang tiếp của thư mục đang đứng (thư mục >200 mục). */
  const loadMore = useCallback(async () => {
    if (!cwd || !listing?.nextPageToken) return;
    setLoading(true);
    try {
      const res = await gBrowse(accountId, cwd.id, listing.nextPageToken);
      setListing((prev) => prev
        ? { files: [...prev.files, ...res.files], nextPageToken: res.nextPageToken }
        : res);
    } catch (e) {
      setErr(gErrText(e));
    } finally {
      setLoading(false);
    }
  }, [accountId, cwd, listing?.nextPageToken]);

  /**
   * Tạo xong thì mở luôn tài liệu vừa tạo — tạo ra rồi để đó thì người dùng
   * phải tự đi tìm. Thư mục thì bước vào; Docs/Sheets mở editor thật của Google
   * (file trống, việc tiếp theo chắc chắn là gõ vào đó).
   */
  const create = useCallback(async (kind: 'folder' | 'doc' | 'sheet', name: string) => {
    // Không đứng trong thư mục nào thì tạo vào My Drive — Google cũng cho tạo
    // tài liệu mà không cần chọn folder trước, nên đừng bắt người dùng phải
    // duyệt vào đâu đó chỉ để bấm được nút Tạo.
    const parentId = cwd?.id ?? 'root';
    setCreating(true); setErr(null);
    try {
      const f = await gCreate(accountId, kind, name, parentId);
      setCreateOpen(false);
      if (kind === 'folder') {
        await openFolder(f.id, f.name);
      } else {
        // Tải lại thư mục đang mở để file mới hiện trong danh sách…
        if (cwd) {
          const res = await gBrowse(accountId, cwd.id);
          setListing(res);
        }
        // …rồi mở editor. webViewLink của file vừa tạo luôn có.
        if (f.webViewLink) onOpenUrl(f.name, withAuthuser(f.webViewLink, accountEmail));
      }
    } catch (e) {
      setErr(gErrText(e));
    } finally {
      setCreating(false);
    }
  }, [accountId, accountEmail, cwd, openFolder, onOpenUrl]);

  const add = async () => {
    if (!addUrl.trim()) return;
    setAdding(true); setErr(null);
    try {
      const list = await gRootAdd(accountId, addUrl, addName);
      setRoots(list);
      setAddUrl(''); setAddName('');
    } catch (e) {
      setErr(gErrText(e));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (r: GRoot) => {
    if (!window.confirm(`Bỏ lối tắt "${r.name}"? (không đụng gì tới Drive)`)) return;
    try {
      await gRootRemove(r.id);
      setRoots(await gRoots(accountId));
      if (activeRoot?.key === `root:${r.id}`) { setActiveRoot(null); setListing(null); setTrail([]); }
    } catch (e) {
      setErr(gErrText(e));
    }
  };

  const folders = listing?.files.filter((f) => f.mimeType === G_MIME.folder) ?? [];
  const files = listing?.files.filter((f) => f.mimeType !== G_MIME.folder) ?? [];

  return (
    <div className="g-projects" ref={railSplit.ref} style={railSplit.style}>
      <aside className="g-rail">
        {/* Cụm 1: cây thật của tài khoản. Không cần đăng ký gì cũng có. */}
        <div className="group-title" style={{ margin: '0 4px 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1 }}>Drive của tài khoản</span>
        </div>
        {drives.map((d) => {
          const key = `drive:${d.id}`;
          return (
            <div key={key} className={`g-root${activeRoot?.key === key ? ' on' : ''}`}>
              <button
                className="g-root-btn"
                onClick={() => void openFolder(d.id, d.name, { key, name: d.name })}
                title={d.kind === 'my' ? 'Ổ cá nhân của tài khoản này' : 'Shared Drive (ổ dùng chung của team)'}
              >
                <span aria-hidden>{d.kind === 'my' ? '🏠' : '👥'}</span>
                <span className="g-root-name">{d.name}</span>
              </button>
            </div>
          );
        })}
        {drives.length === 0 && (
          <p className="small" style={{ color: 'var(--muted)', margin: '4px 6px 10px' }}>
            Đang đọc danh sách Drive…
          </p>
        )}

        {/* Cụm 2: lối tắt đã dán tay. Vẫn cần — nhảy thẳng vào folder sâu, hoặc
            folder người khác share mà không nằm trong Drive của mình. */}
        <div className="group-title" style={{ margin: '14px 4px 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1 }}>Lối tắt</span>
          <button className="ghost sm" onClick={reloadRoots} title="Tải lại danh sách lối tắt">↻</button>
          <button
            className={`ghost sm${showAdd ? ' on' : ''}`}
            onClick={() => setShowAdd((v) => !v)}
            title="Dán link một thư mục Drive để ghim làm lối tắt"
          >
            ＋
          </button>
        </div>
        {roots.map((r) => {
          const key = `root:${r.id}`;
          return (
            <div key={r.id} className={`g-root${activeRoot?.key === key ? ' on' : ''}`}>
              <button
                className="g-root-btn"
                onClick={() => void openFolder(r.folderId, r.name, { key, name: r.name })}
                title={r.url}
              >
                <span aria-hidden>🔖</span>
                <span className="g-root-name">{r.name}</span>
              </button>
              <a className="ghost sm g-root-act" href={r.url} target="_blank" rel="noreferrer" title="Mở trong Drive">↗</a>
              <button className="ghost sm g-root-act" onClick={() => void remove(r)} title="Bỏ lối tắt">✕</button>
            </div>
          );
        })}
        {roots.length === 0 && !showAdd && (
          <p className="small" style={{ color: 'var(--muted)', margin: '4px 6px 10px' }}>
            Chưa ghim lối tắt nào — duyệt cây phía trên là đủ dùng. Bấm ＋ nếu muốn ghim một thư mục hay dùng.
          </p>
        )}
        {showAdd && (
          <div className="g-add">
            <input className="input" placeholder="Link thư mục Drive…" value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
            <input className="input" placeholder="Tên hiển thị (mặc định: tên folder)" value={addName}
              onChange={(e) => setAddName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
            <button className="sm" onClick={() => void add()} disabled={adding || !addUrl.trim()}>
              {adding ? <span className="spinner" aria-hidden /> : '＋'} Ghim
            </button>
          </div>
        )}
      </aside>

      <div className="g-main">
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}

        {/* Thanh tạo mới đứng NGOÀI nhánh activeRoot, luôn bấm được — Google cũng
            cho tạo tài liệu mà không cần chọn thư mục trước. Chưa đứng ở đâu thì
            tạo vào My Drive (xem `create`). */}
        <div className="g-main-bar">
          {canWrite ? (
            <button
              className={`sm g-create-btn${createOpen ? ' on' : ''}`}
              title={`Tạo Google Docs / Sheets / thư mục mới trong "${cwd?.name ?? 'My Drive'}"`}
              onClick={() => setCreateOpen((v) => !v)}
            >
              ＋ Tạo mới
            </button>
          ) : (
            <button
              className="sm g-create-btn"
              title="Tài khoản này chưa có quyền tạo file — cần consent lại một lần"
              onClick={onGrantWrite}
            >
              🔓 Cấp quyền tạo file
            </button>
          )}
          <span className="small" style={{ color: 'var(--muted)' }}>
            vào <b>{cwd?.name ?? 'My Drive'}</b>
          </span>
        </div>
        {createOpen && (
          <CreateBox
            parentName={cwd?.name ?? 'My Drive'}
            busy={creating}
            onCreate={(kind, name) => void create(kind, name)}
            onClose={() => setCreateOpen(false)}
          />
        )}

        {!activeRoot ? (
          <div className="empty" style={{ margin: 'auto' }}>
            <p className="small">Chọn một Drive bên trái để duyệt tài liệu — hoặc một lối tắt đã ghim.</p>
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
              <span style={{ flex: 1 }} />
              <button
                className="ghost sm"
                title="Tải lại thư mục hiện tại"
                disabled={loading}
                onClick={() => { if (cwd) void openFolder(cwd.id, cwd.name); }}
              >
                ↻
              </button>
              <button
                className="ghost sm"
                title="Mở thư mục này bằng giao diện Drive trong app — upload / tạo mới / đổi tên / xóa"
                onClick={() => {
                  if (cwd) onOpenUrl(cwd.name, `https://drive.google.com/drive/folders/${cwd.id}`);
                }}
              >
                🗂 Quản lý trong Drive
              </button>
            </div>
            <div className="g-list">
              {folders.map((f) => (
                <button key={f.id} className="g-row" onClick={() => void openFolder(f.id, f.name)} title={f.name}>
                  <span className="g-ico" aria-hidden>📁</span>
                  <span className="g-name"><span className="g-base">{f.name}</span></span>
                  <span className="g-open" aria-hidden>›</span>
                </button>
              ))}
              {files.map((f) => <FileRow key={f.id} accountId={accountId} f={f} onOpen={onOpen} />)}
              {!loading && listing && listing.files.length === 0 && (
                <div className="empty" style={{ padding: '24px 8px' }}>
                  <p className="small">
                    Thư mục trống.{canWrite ? ' Bấm "＋ Tạo mới" để tạo tài liệu đầu tiên.' : ''}
                  </p>
                </div>
              )}
              {listing?.nextPageToken && (
                <button className="ghost sm" style={{ margin: '8px auto' }} onClick={() => void loadMore()} disabled={loading}>
                  {loading ? <span className="spinner" aria-hidden /> : '↓'} Tải thêm
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <Splitter {...railSplit.grip} />
    </div>
  );
}

/** 🔗 section — dán link MỘT tài liệu được share (không cần thư mục dự án).
 *
 *  Quyền Drive tính theo từng file và link share thường thuộc tài khoản khác,
 *  nên server dò lần lượt mọi tài khoản đang đăng nhập để tìm cái đọc được —
 *  người dùng chỉ việc dán. Mở ra là API-preview (xem + ⬇ tải), giống hệt file
 *  trong thư mục dự án. Danh sách lưu trên máy: ghim ⭐ / đổi tên / xóa. */
function SharedView({ accountId, onOpen }: { accountId: string; onOpen: OpenFile }) {
  const [links, setLinks] = useState<GDocLink[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    gDocLinks().then(setLinks).catch((e) => setErr(gErrText(e)));
  }, []);

  /** Dán link → nhận diện + lưu + MỞ LUÔN (dán là để xem, không phải để lưu). */
  const paste = async () => {
    if (!url.trim() || busy) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const res = await gDocResolve(url, { accountId });
      setLinks(res.links);
      setUrl('');
      setNote(`Mở "${res.file.name}" bằng ${res.usedBy}.`);
      onOpen({ id: res.file.id, name: res.file.name, mimeType: res.file.mimeType, webViewLink: res.file.webViewLink });
    } catch (e) {
      setErr(gErrText(e));
    } finally {
      setBusy(false);
    }
  };

  const open = (l: GDocLink) => {
    void gDocLinkTouch(l.id).then(setLinks).catch(() => { /* thứ tự sắp xếp thôi, hỏng cũng không sao */ });
    onOpen({ id: l.fileId, name: l.name, mimeType: l.mimeType, webViewLink: l.url });
  };

  const act = async (fn: () => Promise<GDocLink[]>) => {
    try { setLinks(await fn()); } catch (e) { setErr(gErrText(e)); }
  };

  const remove = (l: GDocLink) => {
    if (!window.confirm(`Bỏ "${l.name}" khỏi danh sách? (không đụng gì tới Drive)`)) return;
    void act(() => gDocLinkRemove(l.id));
  };

  return (
    <div className="g-list-wrap">
      <div className="g-toolbar">
        <input
          className="input g-search"
          placeholder="Dán link tài liệu được share (Docs / Sheets / Slides / PDF trên Drive)…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void paste()}
        />
        <button className="sm" onClick={() => void paste()} disabled={busy || !url.trim()}
          title="Nhận diện link, tự dò tài khoản đọc được rồi mở xem ngay">
          {busy ? <span className="spinner" aria-hidden /> : '＋'} Mở &amp; lưu
        </button>
      </div>

      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
      {note && <p className="small" style={{ color: 'var(--muted)', margin: '2px 4px' }}>{note}</p>}

      <div className="g-list">
        {links.map((l) => (
          <div key={l.id} className="g-row" style={{ cursor: 'default' }}>
            <span className="g-ico" aria-hidden>{mimeIcon(l.mimeType)}</span>
            {editing === l.id ? (
              <input
                className="input"
                autoFocus
                defaultValue={l.name}
                style={{ flex: 1, minWidth: 0 }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = (e.target as HTMLInputElement).value.trim();
                    if (v && v !== l.name) void act(() => gDocLinkRename(l.id, v));
                    setEditing(null);
                  } else if (e.key === 'Escape') setEditing(null);
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== l.name) void act(() => gDocLinkRename(l.id, v));
                  setEditing(null);
                }}
              />
            ) : (
              <button
                className="g-name"
                style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }}
                onClick={() => open(l)}
                title={`${l.name} — xem trong app (chỉ đọc)`}
              >
                <span className="g-base">{l.pinned && <span className="g-star" aria-hidden>⭐</span>}{l.name}</span>
                <span className="g-meta">{fmtRel(l.lastOpened ?? l.addedAt)}</span>
              </button>
            )}
            {gCanDownload(l.mimeType) && (
              <span className="g-open" title="Tải về máy — tự dò tài khoản đọc được"
                onClick={(e) => { e.stopPropagation(); void gDocDownload(l.fileId); }}>
                ⬇
              </span>
            )}
            <span className="g-open" title={l.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}
              onClick={(e) => { e.stopPropagation(); void act(() => gDocLinkPin(l.id, !l.pinned)); }}>
              {l.pinned ? '☆' : '⭐'}
            </span>
            <span className="g-open" title="Đổi tên hiển thị"
              onClick={(e) => { e.stopPropagation(); setEditing(l.id); }}>
              ✎
            </span>
            <span className="g-open" title="Mở bằng trình duyệt ngoài"
              onClick={(e) => { e.stopPropagation(); window.open(l.url, '_blank'); }}>
              ↗
            </span>
            <span className="g-open" title="Bỏ khỏi danh sách"
              onClick={(e) => { e.stopPropagation(); remove(l); }}>
              ✕
            </span>
          </div>
        ))}
        {links.length === 0 && !err && (
          <div className="empty" style={{ padding: '24px 8px' }}>
            <p className="small">
              Chưa có tài liệu nào. Dán link ai đó share cho bạn vào ô trên — DevBox tự tìm tài khoản
              đọc được rồi mở xem, tải về ngay trong app.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Nhãn ngắn cho chip tài khoản: phần trước @ cho gọn, NHƯNG nếu có tài khoản
 *  khác cùng prefix (user@example.com vs user@gmail.com) thì hiện cả email
 *  — hai chip giống hệt nhau thì không biết đang chọn cái nào. */
function accLabel(a: GoogleAccount, all: GoogleAccount[] = []): string {
  if (!a.email) return a.id.slice(0, 8);
  const prefix = a.email.split('@')[0];
  const clash = all.some((o) => o.id !== a.id && o.email && o.email.split('@')[0] === prefix);
  return clash ? a.email : prefix;
}

export default function GoogleWorkspace() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [activeId, setActiveId] = useState<string>('');
  const [section, setSection] = useState<Section>('projects');
  const [err, setErr] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null); // consent trong app
  /**
   * Đang consent LẠI cho một tài khoản ĐÃ CÓ (cấp thêm quyền ghi, hoặc liên kết
   * lại khi token hết hạn) — không phải thêm tài khoản mới. Số tài khoản không
   * đổi nên phải poll theo cờ của chính nó (`until`), lấy số lượng làm mốc thì
   * poll chạy hết lượt rồi im và người dùng tưởng treo.
   */
  const [pendingReconsent, setPendingReconsent] =
    useState<{ id: string; until: 'write' | 'valid' } | null>(null);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const openInApp = useCallback<OpenInApp>((name, url) => {
    // Route link Google về đúng tài khoản đang chọn trong DevBox — phiên
    // webview nhúng có thể đang đăng nhập nhiều account, thiếu authuser là
    // Docs/Sheets mở bằng account mặc định (có thể sai → "không thể mở tệp").
    const email = st?.accounts.find((a) => a.id === activeId)?.email;
    const target = withAuthuser(url, email);
    if (typeof window !== 'undefined' && window.workspace?.isDesktop) setViewer({ name, url: target });
    else window.open(target, '_blank'); // plain browser — <webview> không tồn tại
  }, [st, activeId]);

  /** Mở FILE — API-preview (đọc); editUrl do panel tự dựng theo account
   *  THỰC SỰ đọc được file (multi-account fallback). */
  const openFile = useCallback<OpenFile>((f) => {
    setPreview({ fileId: f.id, name: f.name, webViewLink: f.webViewLink });
  }, []);

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
      else { setEnabled(true); setErr(gErrText(e)); }
      return null;
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // Một view con vừa ăn lỗi "liên kết hết hiệu lực" → đọc lại status để cờ
  // `invalid` server vừa ghi hiện thành banner có nút "🔗 Liên kết lại".
  useEffect(() => {
    const onReauth = () => { void refreshStatus(); };
    window.addEventListener(REAUTH_EVENT, onReauth);
    return () => window.removeEventListener(REAUTH_EVENT, onReauth);
  }, [refreshStatus]);
  useEffect(() => {
    if (activeId && typeof window !== 'undefined') window.localStorage.setItem(ACTIVE_ACCOUNT_KEY, activeId);
  }, [activeId]);

  /** Poll status tới khi thấy tài khoản mới — dùng cho cả luồng trong app lẫn
   *  luồng mở trình duyệt ngoài. */
  const pollForNewAccount = () => {
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
  };

  /**
   * Chờ MỘT tài khoản đã có consent lại xong.
   *
   * Khác `pollForNewAccount`: consent lại cho tài khoản CŨ không làm số tài
   * khoản tăng, nên điều kiện dừng phải là cờ của chính nó đổi —
   *   'write' → `canWrite` bật (vừa cấp quyền tạo file),
   *   'valid' → `invalid` tắt (liên kết đã sống lại).
   */
  const pollForReconsent = (accountId: string, until: 'write' | 'valid') => {
    setWaiting(true);
    if (pollRef.current) clearInterval(pollRef.current);
    let tries = 0;
    pollRef.current = setInterval(async () => {
      tries += 1;
      const s = await refreshStatus();
      const a = s?.accounts.find((x) => x.id === accountId);
      const done = until === 'write' ? a?.canWrite === true : a?.invalid !== true;
      if (done || tries > 60) {
        if (pollRef.current) clearInterval(pollRef.current);
        setWaiting(false);
      }
    }, 2000);
  };

  /**
   * Consent LẠI cho một tài khoản đã đăng nhập — dùng cho cả hai việc:
   *   · cấp thêm quyền tạo file (`until: 'write'`),
   *   · liên kết lại khi refresh_token hết hạn/bị thu hồi (`until: 'valid'`).
   *
   * Cùng một luồng vì `exchangeCode` upsert THEO EMAIL: consent lại cùng email
   * chỉ thay token của bản ghi cũ, giữ nguyên accountId → mọi lối tắt 📁 và link
   * đã ghim theo accountId vẫn còn. Đó là lý do tồn tại của nút này: không phải
   * gỡ tài khoản rồi thêm lại từ đầu.
   *
   * `login_hint` = email của chính nó, để Google khỏi bắt chọn lại tài khoản và
   * để chắc chắn token mới gắn vào ĐÚNG tài khoản đang xem (không có hint thì
   * người dùng dễ chọn nhầm sang account khác, xác thực xong vẫn báo lỗi cũ).
   */
  const reconsent = async (a: GoogleAccount, until: 'write' | 'valid') => {
    setErr(null);
    try {
      const { url } = await gAuthUrl(a.email);
      if (typeof window !== 'undefined' && window.workspace?.isDesktop) {
        setPendingReconsent({ id: a.id, until });
        setAuthUrl(url);
        return;
      }
      window.open(url, '_blank', 'noopener');
      pollForReconsent(a.id, until);
    } catch (e) {
      setErr(gErrText(e));
    }
  };

  /** Mở consent flow — đăng nhập đầu tiên VÀ "＋ Thêm tài khoản".
   *  Desktop: mở TRONG APP (khỏi phụ thuộc trình duyệt mặc định / profile).
   *  Web thuần: không có <webview> → vẫn mở tab mới như trước. */
  const addAccount = async () => {
    setErr(null);
    try {
      const { url } = await gAuthUrl();
      if (typeof window !== 'undefined' && window.workspace?.isDesktop) {
        setAuthUrl(url);
        return;
      }
      window.open(url, '_blank', 'noopener');
      pollForNewAccount();
    } catch (e) {
      setErr(gErrText(e));
    }
  };

  /** Lối thoát: vẫn cho mở bằng trình duyệt ngoài nếu ai thích cách cũ. */
  const addAccountExternal = async () => {
    setErr(null);
    try {
      const { url } = await gAuthUrl();
      const ext = window.workspace?.openExternal;
      if (ext) await ext(url); else window.open(url, '_blank', 'noopener');
      pollForNewAccount();
    } catch (e) {
      setErr(gErrText(e));
    }
  };

  const removeAccount = async (a: GoogleAccount) => {
    if (!window.confirm(`Đăng xuất ${a.email ?? a.id}? (revoke + xóa token trên máy này)`)) return;
    try {
      await gLogout(a.id);
      await refreshStatus();
    } catch (e) {
      setErr(gErrText(e));
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
            Duyệt Drive theo cây — My Drive và Shared Drives, vào thư mục con, tạo Docs/Sheets mới ngay tại chỗ.
            Hỗ trợ NHIỀU tài khoản song song; token lưu trên máy này.
          </p>
          <div className="office-hero-points">
            <span className="office-point">👥 Nhiều tài khoản</span>
            <span className="office-point">🏠 My Drive · 👥 Shared Drives</span>
            <span className="office-point">＋ Tạo Docs · Sheets · thư mục</span>
            <span className="office-point">🛡 Không sửa được file cũ</span>
          </div>
          <button className="office-cta" onClick={() => void addAccount()} disabled={waiting}>
            {waiting ? <span className="spinner" aria-hidden /> : 'Ⓖ'} {waiting ? 'Đang chờ đăng nhập…' : 'Đăng nhập Google'}
          </button>
          {waiting && <p className="small" style={{ color: 'var(--muted)' }}>Hoàn tất đăng nhập ở tab vừa mở — DevBox sẽ tự nhận.</p>}
          <p className="small" style={{ color: 'var(--faint)' }}>
            Đăng nhập mở ngay trong app — không phụ thuộc trình duyệt mặc định của máy.{' '}
            <button className="ghost sm" onClick={() => void addAccountExternal()} disabled={waiting}
              title="Mở trang consent bằng trình duyệt mặc định của máy (cách cũ)">
              Dùng trình duyệt ngoài
            </button>
          </p>
          {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        </div>
        {authUrl && (
          <GoogleAuthWindow url={authUrl}
            onDone={() => { setAuthUrl(null); pollForNewAccount(); }}
            onCancel={() => setAuthUrl(null)} />
        )}
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
            <span key={a.id} className={`g-acc${a.id === active.id ? ' on' : ''}${a.invalid ? ' bad' : ''}`}
              title={a.invalid ? `${a.email ?? a.id} — liên kết hết hiệu lực, cần "Liên kết lại"` : (a.email ?? a.id)}>
              <button className="g-acc-btn" role="tab" aria-selected={a.id === active.id} onClick={() => setActiveId(a.id)}>
                {/* Chấm ⚠ để thấy tài khoản chết NGAY trên chip, không phải chọn
                    vào mới biết — có nhiều tài khoản thì đó là khác biệt lớn. */}
                {a.invalid ? '⚠' : 'Ⓖ'} {accLabel(a, st.accounts)}
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

      {/* LIÊN KẾT HẾT HIỆU LỰC — refresh_token bị Google từ chối (hết hạn, bị thu
          hồi ở myaccount.google.com, hoặc đổi mật khẩu). Trước đây chỗ này chỉ đổ
          ra "invalid_grant Token has been expired or revoked" và cách duy nhất là
          gỡ tài khoản rồi thêm lại — mất luôn lối tắt đã ghim. Nút dưới đây
          consent lại vào ĐÚNG tài khoản đó nên mọi thứ đã ghim vẫn còn. */}
      {active.invalid && (
        <div className="g-scope-warn">
          <span aria-hidden>🔗</span>
          <span style={{ flex: 1 }}>
            Liên kết Google với <b>{active.email ?? active.id}</b> đã hết hiệu lực — cần xác thực lại
            để lấy token mới. Lối tắt và link đã ghim <b>vẫn giữ nguyên</b>, không cần gỡ tài khoản.
            {active.invalidReason && (
              <>
                {' '}
                <span className="small" style={{ color: 'var(--muted)' }}>
                  (Google: {active.invalidReason})
                </span>
              </>
            )}
          </span>
          <button className="sm" onClick={() => void reconsent(active, 'valid')} disabled={waiting}
            title={`Xác thực lại ${active.email ?? active.id} — token mới, giữ nguyên mọi thứ đã ghim`}>
            {waiting ? <span className="spinner" aria-hidden /> : '🔗'} Liên kết lại
          </button>
        </div>
      )}

      {/* Token KHÔNG có quyền Drive nào: mọi thứ bên dưới sẽ chết bằng
          "insufficient authentication scopes". Nói trước ở đây, kèm nút sửa —
          để lỗi tự hiện ra lúc duyệt thì không ai đoán được là do đăng nhập. */}
      {!active.invalid && active.canRead === false && active.canWrite === false && (
        <div className="g-scope-warn">
          <span aria-hidden>⚠️</span>
          <span style={{ flex: 1 }}>
            <b>{active.email ?? active.id}</b> chưa được cấp quyền Drive — duyệt hay tạo file đều sẽ lỗi.
            Đăng nhập lại và <b>tick các ô quyền Google Drive</b> ở màn hình Google trước khi bấm Tiếp tục.
          </span>
          <button className="sm" onClick={() => void reconsent(active, 'write')} disabled={waiting}>
            {waiting ? <span className="spinner" aria-hidden /> : '🔓'} Cấp quyền lại
          </button>
        </div>
      )}

      {/* key=account id → đổi tài khoản là remount sạch dữ liệu của account đó */}
      <div className="office-body">
        {section === 'projects' && (
          <ProjectsView
            key={`p-${active.id}`}
            accountId={active.id}
            accountEmail={active.email}
            canWrite={active.canWrite === true}
            onGrantWrite={() => void reconsent(active, 'write')}
            onOpen={openFile}
            onOpenUrl={openInApp}
          />
        )}
        {/* Không key theo account: link được share vốn không thuộc riêng
            tài khoản nào — danh sách dùng chung, viewer tự dò quyền. */}
        {section === 'shared' && <SharedView accountId={active.id} onOpen={openFile} />}
        {section === 'docs' && <KindList key={`d-${active.id}`} accountId={active.id} kind="docs" onOpen={openFile} />}
        {section === 'sheets' && <KindList key={`s-${active.id}`} accountId={active.id} kind="sheets" onOpen={openFile} />}
      </div>

      {preview && (
        <GoogleFilePreview
          accountId={active.id}
          accounts={st.accounts}
          fileId={preview.fileId}
          name={preview.name}
          webViewLink={preview.webViewLink}
          onClose={() => setPreview(null)}
          onOpenWeb={
            typeof window !== 'undefined' && window.workspace?.isDesktop
              ? (editUrl) => {
                  // Chuyển sang editor webview — cần phiên nhúng đã login (Ⓖ).
                  const p = preview;
                  setPreview(null);
                  setViewer({ name: p.name, url: editUrl });
                }
              : undefined
          }
        />
      )}

      {viewer && (
        <GoogleDocViewer
          name={viewer.name}
          url={viewer.url}
          onClose={() => setViewer(null)}
          // 💾 trong viewer lưu vào registry của tab Links (dùng chung toàn app).
          onSaveLink={async (name, url) => {
            await lAdd(url, { name });
          }}
        />
      )}

      {/* Consent Google trong app — "＋ Tài khoản" (thêm mới) và "Cấp quyền tạo
          file" (tài khoản cũ) dùng chung cửa sổ này, chỉ khác cách chờ kết quả. */}
      {authUrl && (
        <GoogleAuthWindow url={authUrl}
          onDone={() => {
            setAuthUrl(null);
            if (pendingReconsent) {
              pollForReconsent(pendingReconsent.id, pendingReconsent.until);
              setPendingReconsent(null);
            } else pollForNewAccount();
          }}
          onCancel={() => { setAuthUrl(null); setPendingReconsent(null); }} />
      )}
    </div>
  );
}
