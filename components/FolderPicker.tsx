'use client';

// Shared server-backed folder picker.
//
// A browser can never hand us an absolute path (a file input only yields the
// basename + a sandboxed File), so folder choosing is done by letting the SERVER
// list directories (/api/fs-browse) and the user click through them.
//
// Used by the Git workspace (pick a project root) and by ＋ Projects (pick the
// folder holding devbox.api.json). Pass `marker` to have the picker flag folders
// that contain a given file — that turns "type the right path" into "see the ▤
// badge and click it".

import { useCallback, useEffect, useState } from 'react';

interface DirEntry {
  name: string;
  path: string;
  /** Directory is itself a git working tree. */
  isRepo: boolean;
  /** Directory contains the requested `marker` file. Only set when marker asked. */
  hasMarker?: boolean;
}

interface BrowseResult {
  /** Absolute path being listed. "" = the drive list (Windows). */
  path: string;
  parent: string | null;
  entries: DirEntry[];
  isDriveList: boolean;
  /** Does the listed folder ITSELF contain `marker`? */
  markerHere?: boolean;
}

/** `path`: undefined → server start folder · "" → drive list · absolute → that dir. */
async function browseFolders(path?: string, marker?: string): Promise<BrowseResult> {
  const body: Record<string, string> = {};
  if (path !== undefined) body.path = path;
  if (marker) body.marker = marker;
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
  onPick: (path: string) => void;
  onClose: () => void;
}

export default function FolderPicker({
  initial,
  title = 'Chọn thư mục',
  hint,
  marker,
  onPick,
  onClose,
}: FolderPickerProps) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // `undefined` on first load → server start folder; thereafter an explicit path
  // (including "" for the Windows drive list).
  const load = useCallback(async (target?: string) => {
    setLoading(true);
    setErr(null);
    try {
      setData(await browseFolders(target, marker));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [marker]);

  useEffect(() => { load(initial); }, [load, initial]);

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

        {err && <pre className="code" style={{ color: 'var(--err)', margin: '8px 0 0' }}>{err}</pre>}

        <div className="picker-list">
          {loading ? (
            <div className="empty" style={{ padding: '20px 8px' }}><p className="small">Đang tải…</p></div>
          ) : data && data.entries.length > 0 ? (
            data.entries.map((e) => (
              <button key={e.path} className="picker-row" onClick={() => load(e.path)} title={e.path}>
                <span className="picker-ico" aria-hidden>{data.isDriveList ? '🖴' : '📁'}</span>
                <span className="picker-name">{e.name}</span>
                {e.hasMarker && (
                  <span className="picker-repo" style={{ color: 'var(--ok)' }} title={`có ${marker}`}>▤ pack</span>
                )}
                {e.isRepo && <span className="picker-repo" title="thư mục này là git repo">⎇ repo</span>}
                <span className="picker-into" aria-hidden>›</span>
              </button>
            ))
          ) : (
            <div className="empty" style={{ padding: '20px 8px' }}>
              <p className="small">Không có thư mục con.</p>
            </div>
          )}
        </div>

        <div className="picker-actions">
          <span className="small" style={{ color: markerMissing ? 'var(--warn)' : 'var(--muted)', flex: 1 }}>
            {markerMissing
              ? `Thư mục đang mở chưa có ${marker} — vào đúng repo có manifest, hoặc chọn rồi tạo file sau.`
              : hint || 'Bấm vào thư mục để đi vào; “Chọn thư mục này” để lấy thư mục đang mở.'}
          </span>
          <button className="ghost sm" onClick={onClose}>Hủy</button>
          <button
            className="sm"
            onClick={() => data && canPick && onPick(data.path)}
            disabled={!canPick}
            title={data?.isDriveList ? 'Hãy vào một ổ đĩa trước' : 'Dùng thư mục đang mở'}
          >
            ✓ Chọn thư mục này
          </button>
        </div>
      </div>
    </div>
  );
}
