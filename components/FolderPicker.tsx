'use client';

// Shared server-backed folder picker.
//
// A browser can never hand us an absolute path (a file input only yields the
// basename + a sandboxed File), so folder choosing is done by letting the SERVER
// list directories (/api/fs-browse) and the user click through them.
//
// Used by the Git workspace (pick a project root), by ＋ Projects (pick the
// folder holding devbox.api.json) and by the Sheet tab (pick an .xlsx/.csv
// file via `fileExts` + `onPickFile`). Pass `marker` to have the picker flag
// folders that contain a given file — that turns "type the right path" into
// "see the ▤ badge and click it".

import { useCallback, useEffect, useRef, useState } from 'react';

interface DirEntry {
  name: string;
  path: string;
  /** Directory is itself a git working tree. */
  isRepo: boolean;
  /** Directory contains the requested `marker` file. Only set when marker asked. */
  hasMarker?: boolean;
}

interface FileEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

interface QuickPlace {
  name: string;
  /** Absolute path, or "" for the Windows drive list. */
  path: string;
  icon: string;
}

interface BrowseResult {
  /** Absolute path being listed. "" = the drive list (Windows). */
  path: string;
  parent: string | null;
  entries: DirEntry[];
  isDriveList: boolean;
  /** Does the listed folder ITSELF contain `marker`? */
  markerHere?: boolean;
  /** Files matching `fileExts` — only present when the picker asked for files. */
  files?: FileEntry[];
  /** Quick-access places (Desktop, Documents, …) như hộp thoại Windows. */
  shortcuts?: QuickPlace[];
}

/** `path`: undefined → server start folder · "" → drive list · absolute → that dir.
 *  `allFiles`: bỏ lọc đuôi, liệt kê mọi file trong thư mục. */
async function browseFolders(
  path?: string,
  marker?: string,
  exts?: string[],
  allFiles?: boolean,
): Promise<BrowseResult> {
  const body: Record<string, string | string[] | boolean> = {};
  if (path !== undefined) body.path = path;
  if (marker) body.marker = marker;
  if (exts && exts.length > 0) body.exts = exts;
  if (allFiles) body.allFiles = true;
  const r = await fetch('/api/fs-browse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as BrowseResult;
}

export interface FolderPickerProps {
  /** Optional starting path; falls back to the server's configured start folder. */
  initial?: string;
  /** Modal heading. */
  title?: string;
  /** Footer hint line. */
  hint?: string;
  /** File name that marks a folder as a valid pick, e.g. `devbox.api.json`. */
  marker?: string;
  /** List files with these extensions (e.g. ['xlsx','csv']) below the folders.
   *  When set, the picker becomes a FILE picker: the "Chọn thư mục này" button
   *  is hidden and clicking a file fires `onPickFile`. */
  fileExts?: string[];
  /** Called when the user clicks a listed file (requires `fileExts`). */
  onPickFile?: (path: string) => void;
  /** Keep the "Chọn thư mục này" button even in file mode — for SAVE dialogs,
   *  where the user may either pick an existing file (overwrite) or just pick
   *  the folder and type a new name. */
  allowPickFolder?: boolean;
  onPick: (path: string) => void;
  onClose: () => void;
}

/** Icon theo đuôi file cho các dòng file trong picker. */
function fileIcon(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'xlsx' || ext === 'xls') return '📊';
  if (ext === 'docx' || ext === 'doc') return '🗎';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdown' || ext === 'mkd' || ext === 'mdx') return '📝';
  if (ext === 'json') return '🧾';
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg') return '🌐';
  return '📄';
}

/** Compact size for the file rows: 731 B · 24 KB · 3.2 MB. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FolderPicker({
  initial,
  title = 'Chọn thư mục',
  hint,
  marker,
  fileExts,
  onPickFile,
  allowPickFolder,
  onPick,
  onClose,
}: FolderPickerProps) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  /** Bỏ lọc đuôi file — hiện MỌI file trong thư mục. Cứu trường hợp file có
   *  thật nhưng đuôi không nằm trong `fileExts` (vd .markdown, .yaml, .conf). */
  const [showAll, setShowAll] = useState(false);

  // `undefined` on first load → server start folder; thereafter an explicit path
  // (including "" for the Windows drive list).
  // fileExts is typically an inline array literal — keep the dep stable by key.
  const extsKey = (fileExts ?? []).join(',');
  const load = useCallback(async (target?: string) => {
    setLoading(true);
    setErr(null);
    try {
      setData(await browseFolders(
        target,
        marker,
        extsKey ? extsKey.split(',') : undefined,
        showAll,
      ));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [marker, extsKey, showAll]);

  // Lần đầu vào `initial`; đổi công tắc "mọi file" thì đọc lại đúng thư mục
  // đang mở (ref giữ path hiện tại để không nhảy về `initial`).
  const curPath = useRef<string | undefined>(initial);
  useEffect(() => { load(curPath.current); }, [load]);
  useEffect(() => { if (data) curPath.current = data.isDriveList ? '' : data.path; }, [data]);

  // Esc = thoát hộp thoại (ngoài nút ✕ / Hủy / bấm ra nền).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canPick = !!data && !data.isDriveList && !!data.path && !loading;
  const markerMissing = !!marker && canPick && data?.markerHere === false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{title}</h3>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        {/* Current path + up navigation */}
        <div className="picker-path">
          <button
            className="ghost sm"
            onClick={() => data && data.parent !== null && load(data.parent)}
            disabled={!data || data.parent === null || loading}
            title="Lên thư mục cha"
          >
            ↑ Lên
          </button>
          <code className="small picker-cwd" title={data?.path || ''}>
            {data?.isDriveList ? '(chọn ổ đĩa)' : data?.path || '…'}
          </code>
          <button
            className="ghost sm"
            onClick={() => load(data?.isDriveList ? '' : data?.path)}
            disabled={loading}
            title="Đọc lại thư mục này (file vừa tạo/copy chưa thấy thì bấm đây)"
          >
            {loading ? <span className="spinner" aria-hidden /> : '↻'}
          </button>
          {marker && canPick && (
            <span
              className="badge"
              style={{ color: data?.markerHere ? 'var(--ok)' : 'var(--warn)', whiteSpace: 'nowrap' }}
              title={data?.markerHere ? `Thư mục này có ${marker}` : `Thư mục này chưa có ${marker}`}
            >
              {data?.markerHere ? `✓ ${marker}` : `⚠ chưa có ${marker}`}
            </span>
          )}
        </div>

        {(data?.shortcuts?.length ?? 0) > 0 && (
          <div className="picker-quick">
            {data?.shortcuts?.map((s) => {
              const active = s.path === '' ? data.isDriveList : data.path === s.path;
              return (
                <button
                  key={s.name}
                  className={`picker-quick-btn${active ? ' on' : ''}`}
                  onClick={() => load(s.path)}
                  disabled={loading}
                  title={s.path || 'Danh sách ổ đĩa'}
                >
                  <span aria-hidden>{s.icon}</span> {s.name}
                </button>
              );
            })}
          </div>
        )}

        {err && <pre className="code" style={{ color: 'var(--err)', margin: '8px 0 0' }}>{err}</pre>}

        <div className="picker-list">
          {loading ? (
            <div className="empty" style={{ padding: '20px 8px' }}><p className="small">Đang tải…</p></div>
          ) : data && (data.entries.length > 0 || (data.files?.length ?? 0) > 0) ? (
            <>
              {data.entries.map((e) => (
                <button key={e.path} className="picker-row" onClick={() => load(e.path)} title={e.path}>
                  <span className="picker-ico" aria-hidden>{data.isDriveList ? '🖴' : '📁'}</span>
                  <span className="picker-name">{e.name}</span>
                  {e.hasMarker && (
                    <span className="picker-repo" style={{ color: 'var(--ok)' }} title={`có ${marker}`}>▤ pack</span>
                  )}
                  {e.isRepo && <span className="picker-repo" title="thư mục này là git repo">⎇ repo</span>}
                  <span className="picker-into" aria-hidden>›</span>
                </button>
              ))}
              {(data.files ?? []).map((f) => (
                <button key={f.path} className="picker-row" onClick={() => onPickFile?.(f.path)} title={f.path}>
                  <span className="picker-ico" aria-hidden>{fileIcon(f.name)}</span>
                  <span className="picker-name">{f.name}</span>
                  <span className="small" style={{ color: 'var(--muted)', flex: 'none' }}>{fmtSize(f.sizeBytes)}</span>
                </button>
              ))}
            </>
          ) : (
            <div className="empty" style={{ padding: '20px 8px' }}>
              <p className="small">{fileExts ? 'Không có thư mục con hay file phù hợp.' : 'Không có thư mục con.'}</p>
            </div>
          )}
        </div>

        <div className="picker-actions">
          <span className="small" style={{ color: markerMissing ? 'var(--warn)' : 'var(--muted)', flex: 1 }}>
            {markerMissing
              ? `Thư mục đang mở chưa có ${marker} — vào đúng repo có manifest, hoặc chọn rồi tạo file sau.`
              : hint || (fileExts
                ? 'Bấm vào thư mục để đi vào; bấm vào file để mở.'
                : 'Bấm vào thư mục để đi vào; “Chọn thư mục này” để lấy thư mục đang mở.')}
          </span>
          {fileExts && (
            <button
              className={`chip-btn${showAll ? ' on' : ''}`}
              onClick={() => setShowAll((v) => !v)}
              title={showAll
                ? 'Chỉ hiện file đúng loại đang cần'
                : 'Hiện MỌI file trong thư mục (kể cả đuôi khác)'}
            >
              {showAll ? '✓ Mọi file' : 'Mọi file'}
            </button>
          )}
          <button className="ghost sm" onClick={onClose}>Hủy</button>
          {(!fileExts || allowPickFolder) && (
            <button
              className="sm"
              onClick={() => data && canPick && onPick(data.path)}
              disabled={!canPick}
              title={data?.isDriveList ? 'Hãy vào một ổ đĩa trước' : 'Dùng thư mục đang mở'}
            >
              ✓ Chọn thư mục này
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
