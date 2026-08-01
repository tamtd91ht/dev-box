'use client';

// Word editor (Office tab) — .docx viewer-editor, local dev only (server gates
// on OFFICE_TOOL_ENABLED). The document renders as a page of paragraphs; click
// the ¶ gutter to select, click text to edit (textarea — Ctrl+Enter/blur saves
// the draft, Esc cancels), add/delete paragraphs from the toolbar.
//
// Editing model mirrors the Sheet editor: local working copy + an OP LOG
// (set/insert/delete by block index). Save ships the ops; the server re-reads
// the .docx and replays them on word/document.xml, so untouched paragraphs
// keep their exact styling. Paragraphs holding images/links/fields are LOCKED
// (server refuses to rewrite them); tables are read-only blocks. Save = the
// ONLY write, behind OFFICE_ALLOW_WRITE + confirm modal + `.bak` backup.

import { useCallback, useEffect, useRef, useState } from 'react';
import FolderPicker from './FolderPicker';
import OfficeNewFileModal from './OfficeNewFileModal';
import { fmtBytes } from '@/lib/sheet';
import {
  fetchWordFlags,
  openWordFile,
  createWordFile,
  saveWordFile,
  type WordBlock,
  type WordFlags,
  type WordOp,
  type WordOpenResult,
} from '@/lib/word';

const RECENT_KEY = 'word.recent';

/** Client-side block: wire block + dirty flag for highlighting. */
type Block = WordBlock & { d?: boolean };

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
  } catch { /* recents are a nicety */ }
}

/** Folder part of an absolute path (for pre-filling the create-new dialog). */
function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, '');
}

/** Visual class for a paragraph from its Word style id. */
function paraClass(b: WordBlock): string {
  const s = (b.style ?? '').toLowerCase();
  if (s === 'title') return ' word-p-title';
  if (s.startsWith('heading')) {
    const n = Number.parseInt(s.slice(7), 10);
    if (n === 1) return ' word-p-h1';
    if (n === 2) return ' word-p-h2';
    return ' word-p-h3';
  }
  return '';
}

export default function WordWorkspace() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flags, setFlags] = useState<WordFlags | null>(null);

  const [file, setFile] = useState<WordOpenResult | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [ops, setOps] = useState<WordOp[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  const [recent, setRecent] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((m: string) => {
    setNotice(m);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  useEffect(() => {
    setRecent(loadRecent());
    fetchWordFlags()
      .then((f) => { setFlags(f); setEnabled(true); })
      .catch((e) => {
        if ((e as Error & { status?: number }).status === 403) setEnabled(false);
        else { setEnabled(true); setErr((e as Error).message); }
      });
  }, []);

  const dirtyCount = ops.length;

  const applyOpen = useCallback((res: WordOpenResult) => {
    setFile(res);
    setBlocks(res.blocks.slice());
    setOps([]); setSel(null); setEditing(null);
    setPickerOpen(false);
    const list = [res.path, ...loadRecent().filter((x) => x !== res.path)];
    saveRecent(list); setRecent(list.slice(0, 10));
  }, []);

  const openPath = useCallback(async (p: string) => {
    setBusy(true); setErr(null);
    try {
      applyOpen(await openWordFile(p));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [applyOpen]);

  const doCreate = useCallback(async (dir: string, name: string) => {
    setBusy(true); setErr(null);
    try {
      const res = await createWordFile(dir, name);
      applyOpen(res);
      setCreateOpen(false);
      flash(`Đã tạo file mới: ${res.path}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [applyOpen, flash]);

  const openCreate = useCallback(() => {
    if (dirtyCount > 0 && !window.confirm(`Đang có ${dirtyCount} thay đổi chưa lưu — tạo file mới sẽ mất hết. Tiếp tục?`)) return;
    setErr(null); setCreateOpen(true);
  }, [dirtyCount]);

  const reload = useCallback(() => {
    if (!file) return;
    if (dirtyCount > 0 && !window.confirm(`Đang có ${dirtyCount} thay đổi chưa lưu — tải lại sẽ mất hết. Tiếp tục?`)) return;
    void openPath(file.path);
  }, [file, dirtyCount, openPath]);

  // ── Edit ops (block indexes at time of op, mirroring server replay) ─────────

  const commitEdit = useCallback((i: number, text: string) => {
    setEditing(null);
    setBlocks((bs) => {
      const cur = bs[i];
      if (!cur || cur.text === text) return bs;
      const nb = bs.slice();
      nb[i] = { ...cur, text, d: true };
      return nb;
    });
    setOps((os) => (blocks[i] && blocks[i].text !== text ? [...os, { op: 'set', i, text }] : os));
  }, [blocks]);

  const insertPara = useCallback((at: number) => {
    setBlocks((bs) => {
      const nb = bs.slice();
      nb.splice(Math.min(at, nb.length), 0, { kind: 'p', text: '', d: true });
      return nb;
    });
    setOps((os) => [...os, { op: 'insert', i: at, text: '' }]);
    setSel(at); setEditing(at); // start typing right away
  }, []);

  const deletePara = useCallback(() => {
    if (sel === null) return;
    const at = sel;
    const b = blocks[at];
    if (!b || b.kind !== 'p') return; // tables are read-only in v1
    setBlocks((bs) => {
      const nb = bs.slice();
      nb.splice(at, 1);
      return nb;
    });
    setOps((os) => [...os, { op: 'delete', i: at }]);
    setSel(null); setEditing(null);
  }, [sel, blocks]);

  const doSave = useCallback(async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const res = await saveWordFile(file.path, file.mtimeMs, ops);
      setFile((f) => (f ? { ...f, mtimeMs: res.mtimeMs, sizeBytes: res.sizeBytes } : f));
      setOps([]);
      setBlocks((bs) => bs.map((b) => (b.d ? { ...b, d: undefined } : b)));
      setSaveOpen(false);
      flash(`Đã lưu ✓ backup: ${res.backupPath}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [file, ops, flash]);

  // ── Gate / loading states ───────────────────────────────────────────────────

  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', width: 'min(560px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>🗎</div>
          <div className="office-hero-title">Office tab đang tắt</div>
          <p className="office-hero-sub">
            Đặt <code>OFFICE_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
            Muốn LƯU (ghi đè file, luôn kèm backup <code>.bak</code>) thì đặt thêm <code>OFFICE_ALLOW_WRITE=true</code> — chỉ dùng local.
          </p>
        </div>
      </div>
    );
  }
  if (enabled === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  const allowWrite = flags?.allowWrite === true;

  // ── Empty state: hero + recents ─────────────────────────────────────────────

  if (!file) {
    return (
      <div className="panel office-hero-panel" style={{ margin: 'auto', width: 'min(680px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>🗎</div>
          <div className="office-hero-title">Word Editor</div>
          <p className="office-hero-sub">
            Mở file <code>.docx</code> trên máy — xem theo đoạn văn, sửa nội dung
            rồi lưu ghi đè an toàn.
          </p>
          <div className="office-hero-points">
            <span className="office-point">✎ Sửa theo đoạn văn</span>
            <span className="office-point">🎨 Đoạn không sửa giữ nguyên định dạng</span>
            <span className="office-point">➕ Thêm / xóa đoạn</span>
            <span className="office-point">🛟 Tự backup .bak khi lưu</span>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="office-cta" onClick={() => setPickerOpen(true)} disabled={busy}>
              {busy ? <span className="spinner" aria-hidden /> : '📂'} Chọn file…
            </button>
            <button
              className="office-cta ghost"
              onClick={openCreate}
              disabled={busy || !allowWrite}
              title={!allowWrite ? 'Tạo file cần quyền ghi — đặt OFFICE_ALLOW_WRITE=true trong .env.local' : 'Tạo file .docx trống rồi mở ngay'}
            >
              ＋ Tạo file mới
            </button>
          </div>
          {err && !createOpen && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', maxWidth: '100%' }}>{err}</pre>}
        </div>
        {recent.length > 0 && (
          <div className="office-recent-wrap">
            <div className="group-title" style={{ margin: '0 4px 6px' }}>Mở gần đây</div>
            <div className="office-recent">
              {recent.map((p) => {
                const base = p.split(/[\\/]/).pop() ?? p;
                const dir = p.slice(0, p.length - base.length).replace(/[\\/]$/, '');
                return (
                  <button key={p} className="office-recent-row" onClick={() => void openPath(p)} title={p}>
                    <span className="picker-ico" aria-hidden>📝</span>
                    <span className="office-recent-name">
                      <span className="office-recent-base">{base}</span>
                      <span className="office-recent-dir">{dir}</span>
                    </span>
                    <span className="picker-into" aria-hidden>›</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {pickerOpen && (
          <FolderPicker
            title="Chọn file .docx"
            fileExts={['docx']}
            onPickFile={(p) => void openPath(p)}
            onPick={() => {}}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {createOpen && (
          <OfficeNewFileModal
            title="＋ Tạo văn bản mới"
            exts={['docx']}
            initialDir={recent[0] ? dirOf(recent[0]) : undefined}
            busy={busy}
            err={err}
            onCreate={(dir, name) => void doCreate(dir, name)}
            onClose={() => { setCreateOpen(false); setErr(null); }}
          />
        )}
      </div>
    );
  }

  // ── Main editor ─────────────────────────────────────────────────────────────

  const setCount = ops.filter((o) => o.op === 'set').length;
  const insCount = ops.filter((o) => o.op === 'insert').length;
  const delCount = ops.filter((o) => o.op === 'delete').length;
  const selBlock = sel !== null ? blocks[sel] : undefined;

  return (
    <div className="panel sheet-panel">
      <div className="sheet-toolbar">
        <span className="picker-cwd small" title={file.path}>{file.path}</span>
        <span className="badge">DOCX</span>
        <span className="badge" title="Kích thước file">{fmtBytes(file.sizeBytes)}</span>
        <button className="ghost sm" onClick={reload} disabled={busy} title="Đọc lại file từ đĩa">↻ Tải lại</button>
        <button className="ghost sm" onClick={() => setPickerOpen(true)} disabled={busy} title="Mở file khác">📂 File khác</button>
        <button
          className="ghost sm"
          onClick={openCreate}
          disabled={busy || !allowWrite}
          title={!allowWrite ? 'Tạo file cần quyền ghi — đặt OFFICE_ALLOW_WRITE=true trong .env.local' : 'Tạo file .docx trống rồi mở ngay'}
        >
          ＋ File mới
        </button>
        <span style={{ flex: 1 }} />
        {dirtyCount > 0 && <span className="badge sheet-dirty-badge">● {dirtyCount} thay đổi</span>}
        <button
          className="ghost sm"
          onClick={() => insertPara(sel !== null ? sel + 1 : blocks.length)}
          disabled={busy}
          title={sel !== null ? `Thêm đoạn mới dưới đoạn ${sel + 1}` : 'Thêm đoạn mới ở cuối tài liệu'}
        >
          ＋ Thêm đoạn
        </button>
        <button
          className="ghost sm"
          onClick={deletePara}
          disabled={busy || sel === null || selBlock?.kind !== 'p'}
          title={sel === null
            ? 'Bấm vào số ¶ bên trái để chọn đoạn cần xóa'
            : selBlock?.kind !== 'p' ? 'Không xóa được bảng' : `Xóa đoạn ${sel + 1}`}
        >
          ✕ Xóa đoạn
        </button>
        <button
          className="sm"
          onClick={() => setSaveOpen(true)}
          disabled={busy || dirtyCount === 0 || !allowWrite}
          title={!allowWrite
            ? 'Ghi file đang tắt — đặt OFFICE_ALLOW_WRITE=true trong .env.local'
            : dirtyCount === 0 ? 'Chưa có thay đổi nào' : 'Ghi đè file (backup .bak trước)'}
        >
          💾 Lưu (ghi đè)
        </button>
      </div>

      {file.truncated && (
        <div className="sheet-banner">
          ⚠ Tài liệu quá dài — chỉ hiển thị {blocks.length.toLocaleString('vi')} block đầu.
          Sửa trong vùng hiển thị vẫn an toàn cho phần còn lại.
        </div>
      )}
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '6px 0' }}>{err}</pre>}
      {notice && <div className="badge" style={{ color: 'var(--ok)', margin: '6px 0' }}>{notice}</div>}

      <div className="word-scroll">
        <div className="word-doc">
          {blocks.length === 0 && (
            <div className="empty" style={{ padding: 20 }}>
              <p className="small">Tài liệu trống — bấm “＋ Thêm đoạn” để bắt đầu.</p>
            </div>
          )}
          {blocks.map((b, i) => (
            <div key={i} className={`word-row${sel === i ? ' sel' : ''}${b.d ? ' dirty' : ''}`}>
              <button
                className="word-gutter"
                onClick={() => setSel(sel === i ? null : i)}
                title="Bấm để chọn / bỏ chọn đoạn"
              >
                {i + 1}
              </button>
              {b.kind === 'tbl' ? (
                <div className="word-tbl" title="Bảng — chưa hỗ trợ sửa trong DevBox">
                  <span className="word-lock-badge">▦ Bảng · chỉ xem</span>
                  {b.text && <span className="word-tbl-preview">{b.text}…</span>}
                </div>
              ) : editing === i ? (
                <textarea
                  className="word-edit"
                  autoFocus
                  defaultValue={b.text}
                  rows={Math.min(12, Math.max(2, b.text.split('\n').length + 1))}
                  onBlur={(e) => commitEdit(i, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEdit(i, e.currentTarget.value);
                    else if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <div
                  className={`word-p${paraClass(b)}${b.locked ? ' locked' : ''}`}
                  onClick={() => { if (!b.locked) { setSel(i); setEditing(i); } }}
                  title={b.locked ? `Đoạn chứa ${b.lockReason} — khóa sửa để không phá hỏng nội dung đó (vẫn xóa được cả đoạn)` : 'Bấm để sửa'}
                >
                  {b.bullet && <span className="word-bullet" aria-hidden>•</span>}
                  {b.locked && <span className="word-lock-badge">🔒 {b.lockReason}</span>}
                  {b.text === '' ? <span className="word-p-empty">¶</span> : b.text}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {pickerOpen && (
        <FolderPicker
          title="Chọn file .docx"
          fileExts={['docx']}
          onPickFile={(p) => {
            if (dirtyCount > 0 && !window.confirm(`Đang có ${dirtyCount} thay đổi chưa lưu — mở file khác sẽ mất hết. Tiếp tục?`)) return;
            void openPath(p);
          }}
          onPick={() => {}}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {createOpen && (
        <OfficeNewFileModal
          title="＋ Tạo văn bản mới"
          exts={['docx']}
          initialDir={dirOf(file.path)}
          busy={busy}
          err={err}
          onCreate={(dir, name) => void doCreate(dir, name)}
          onClose={() => { setCreateOpen(false); setErr(null); }}
        />
      )}

      {saveOpen && (
        <div className="modal-backdrop" onClick={() => !busy && setSaveOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(620px, 94vw)' }}>
            <div className="status-line" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>💾 Lưu — ghi đè file gốc</h3>
              <button className="ghost sm" onClick={() => setSaveOpen(false)} disabled={busy}>✕</button>
            </div>

            <code className="small picker-cwd" style={{ display: 'block', marginBottom: 10 }} title={file.path}>
              {file.path}
            </code>

            <ul className="sheet-save-summary">
              <li>
                {setCount > 0 && `${setCount} đoạn sửa`}{setCount > 0 && (insCount > 0 || delCount > 0) && ' · '}
                {insCount > 0 && `${insCount} đoạn thêm`}{insCount > 0 && delCount > 0 && ' · '}
                {delCount > 0 && `${delCount} đoạn xóa`}
              </li>
            </ul>

            <div className="sheet-save-note">
              Bản gốc được sao lưu thành <code>{file.path.split(/[\\/]/).pop()}.bak</code> trước khi ghi đè
              (ghi file tạm rồi rename — không có trạng thái ghi dở). Đoạn không sửa giữ nguyên 100% định dạng.
            </div>
            {setCount > 0 && (
              <div className="sheet-save-warn">
                ⚠ Đoạn ĐÃ SỬA được ghi lại theo định dạng ở đầu đoạn — chữ đậm/nghiêng nằm giữa đoạn đó sẽ về cùng một kiểu.
              </div>
            )}

            {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost sm" onClick={() => setSaveOpen(false)} disabled={busy}>Huỷ</button>
              <button className="sm" onClick={() => void doSave()} disabled={busy}>
                {busy ? <span className="spinner" aria-hidden /> : '💾'} Ghi đè ({dirtyCount} thay đổi)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
