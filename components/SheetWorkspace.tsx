'use client';

// Sheet editor (Office tab) — Excel (.xlsx) / CSV viewer-editor, local dev
// only (server gates on OFFICE_TOOL_ENABLED). Pick a file with the shared
// FolderPicker (file mode), view it as a grid, edit cells / add / delete rows,
// then save.
//
// Editing model: the grid is a local working copy + an OP LOG per sheet
// (set / insertRow / deleteRow, 1-based). Save ships the ops; the server
// re-reads the file and replays them, so untouched cells keep styles and
// formulas. Save = the ONLY write, behind OFFICE_ALLOW_WRITE (server) + a
// confirm modal here, and always backs up to `<file>.bak` first.

import { useCallback, useEffect, useRef, useState } from 'react';
import FolderPicker from './FolderPicker';
import OfficeNewFileModal from './OfficeNewFileModal';
import {
  fetchSheetFlags,
  openSheetFile,
  createSheetFile,
  saveSheetFile,
  colLetter,
  fmtBytes,
  type SheetFlags,
  type SheetOp,
  type SheetOpenResult,
  type WireCell,
} from '@/lib/sheet';

const RECENT_KEY = 'sheet.recent';
const RENDER_STEP = 500; // rows rendered at a time (the DOM, not the data, is the bottleneck)

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
  } catch { /* quota/private mode — recents are a nicety */ }
}

interface EditPos { r: number; c: number; } // 1-based

/** Folder part of an absolute path (for pre-filling the create-new dialog). */
function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, '');
}

export default function SheetWorkspace() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flags, setFlags] = useState<SheetFlags | null>(null);

  const [file, setFile] = useState<SheetOpenResult | null>(null);
  /** Local working copy of every sheet's visible grid. */
  const [grids, setGrids] = useState<WireCell[][][]>([]);
  /** Op log per sheet — replayed server-side on save. */
  const [ops, setOps] = useState<SheetOp[][]>([]);
  const [active, setActive] = useState(0);

  const [selRow, setSelRow] = useState<number | null>(null);
  const [editing, setEditing] = useState<EditPos | null>(null);
  const [rowLimit, setRowLimit] = useState(RENDER_STEP);

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
    fetchSheetFlags()
      .then((f) => { setFlags(f); setEnabled(true); })
      .catch((e) => {
        if ((e as Error & { status?: number }).status === 403) setEnabled(false);
        else { setEnabled(true); setErr((e as Error).message); }
      });
  }, []);

  const dirtyCount = ops.reduce((n, o) => n + o.length, 0);

  const applyOpen = useCallback((res: SheetOpenResult) => {
    setFile(res);
    setGrids(res.sheets.map((s) => s.rows.map((row) => row.slice())));
    setOps(res.sheets.map(() => []));
    setActive(0); setSelRow(null); setEditing(null); setRowLimit(RENDER_STEP);
    setPickerOpen(false);
    const list = [res.path, ...loadRecent().filter((x) => x !== res.path)];
    saveRecent(list); setRecent(list.slice(0, 10));
  }, []);

  const openPath = useCallback(async (p: string) => {
    setBusy(true); setErr(null);
    try {
      applyOpen(await openSheetFile(p));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [applyOpen]);

  const doCreate = useCallback(async (dir: string, name: string) => {
    setBusy(true); setErr(null);
    try {
      const res = await createSheetFile(dir, name);
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

  const switchSheet = useCallback((i: number) => {
    setActive(i); setSelRow(null); setEditing(null); setRowLimit(RENDER_STEP);
  }, []);

  const reload = useCallback(() => {
    if (!file) return;
    if (dirtyCount > 0 && !window.confirm(`Đang có ${dirtyCount} thay đổi chưa lưu — tải lại sẽ mất hết. Tiếp tục?`)) return;
    void openPath(file.path);
  }, [file, dirtyCount, openPath]);

  // ── Edit ops (all r/c are 1-based, matching what the server replays) ────────

  const commitEdit = useCallback((r: number, c: number, value: string) => {
    setEditing(null);
    const grid = grids[active];
    const cell = grid?.[r - 1]?.[c - 1];
    if (!cell || cell.v === value) return; // no-op edit
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      const row = ng[r - 1].slice();
      row[c - 1] = { v: value, t: 's', d: true };
      ng[r - 1] = row;
      return ng;
    }));
    setOps((os) => os.map((o, i) => (
      i === active ? [...o, { op: 'set', r, c, value, ...(cell.t === 'f' ? { hadFormula: true } : {}) }] : o
    )));
  }, [grids, active]);

  const colCount = Math.max(1, grids[active]?.[0]?.length ?? 0);

  const insertRow = useCallback((at: number) => {
    const empty: WireCell[] = Array.from({ length: colCount }, () => ({ v: '', t: 's' as const, d: true }));
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      ng.splice(Math.min(at - 1, ng.length), 0, empty);
      return ng;
    }));
    setOps((os) => os.map((o, i) => (i === active ? [...o, { op: 'insertRow', r: at }] : o)));
    setSelRow(at); setEditing(null);
    setRowLimit((l) => (at > l ? at : l));
  }, [active, colCount]);

  const deleteRow = useCallback(() => {
    if (selRow === null) return;
    const at = selRow;
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      ng.splice(at - 1, 1);
      return ng;
    }));
    setOps((os) => os.map((o, i) => (i === active ? [...o, { op: 'deleteRow', r: at }] : o)));
    setSelRow(null); setEditing(null);
  }, [active, selRow]);

  const doSave = useCallback(async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const payload = file.sheets
        .map((s, i) => ({ name: s.name, ops: ops[i] ?? [] }))
        .filter((s) => s.ops.length > 0);
      const res = await saveSheetFile(file.path, file.mtimeMs, payload);
      setFile((f) => (f ? { ...f, mtimeMs: res.mtimeMs, sizeBytes: res.sizeBytes } : f));
      setOps(file.sheets.map(() => []));
      // Drop the dirty highlights — the file now matches what's on screen.
      setGrids((gs) => gs.map((g) => g.map((row) => (
        row.some((c) => c.d) ? row.map((c) => (c.d ? { v: c.v, t: c.t, ...(c.f ? { f: c.f } : {}) } : c)) : row
      ))));
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
          <div className="office-hero-ico" aria-hidden>▦</div>
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

  const sheet = file?.sheets[active];
  const grid = grids[active] ?? [];
  const allowWrite = flags?.allowWrite === true;

  // ── Empty state: recents + Browse ───────────────────────────────────────────

  if (!file) {
    return (
      <div className="panel office-hero-panel" style={{ margin: 'auto', width: 'min(680px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>▦</div>
          <div className="office-hero-title">Excel / CSV Editor</div>
          <p className="office-hero-sub">
            Mở file <code>.xlsx</code> hoặc <code>.csv</code> trên máy — xem dạng bảng,
            sửa trực tiếp rồi lưu ghi đè an toàn.
          </p>
          <div className="office-hero-points">
            <span className="office-point">✎ Sửa ô ngay trên lưới</span>
            <span className="office-point">▦ Nhiều sheet</span>
            <span className="office-point">➕ Thêm / xóa dòng</span>
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
              title={!allowWrite ? 'Tạo file cần quyền ghi — đặt OFFICE_ALLOW_WRITE=true trong .env.local' : 'Tạo file .xlsx / .csv trống rồi mở ngay'}
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
                    <span className="picker-ico" aria-hidden>{p.toLowerCase().endsWith('.csv') ? '📄' : '📊'}</span>
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
            title="Chọn file .xlsx / .csv"
            fileExts={['xlsx', 'csv']}
            onPickFile={(p) => void openPath(p)}
            onPick={() => {}}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {createOpen && (
          <OfficeNewFileModal
            title="＋ Tạo bảng tính mới"
            exts={['xlsx', 'csv']}
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

  const activeOps = ops[active] ?? [];
  const totalRowOps = ops.flat().filter((o) => o.op !== 'set').length;
  const totalFormulaHits = ops.flat().filter((o) => o.op === 'set' && o.hadFormula).length;

  return (
    <div className="panel sheet-panel">
      <div className="sheet-toolbar">
        <span className="picker-cwd small" title={file.path}>{file.path}</span>
        <span className="badge" title={file.kind === 'csv' ? `delimiter "${file.csv?.delimiter}"` : undefined}>
          {file.kind === 'csv' ? 'CSV' : 'XLSX'}
        </span>
        <span className="badge" title="Kích thước file">{fmtBytes(file.sizeBytes)}</span>
        <button className="ghost sm" onClick={reload} disabled={busy} title="Đọc lại file từ đĩa">↻ Tải lại</button>
        <button className="ghost sm" onClick={() => setPickerOpen(true)} disabled={busy} title="Mở file khác">📂 File khác</button>
        <button
          className="ghost sm"
          onClick={openCreate}
          disabled={busy || !allowWrite}
          title={!allowWrite ? 'Tạo file cần quyền ghi — đặt OFFICE_ALLOW_WRITE=true trong .env.local' : 'Tạo file .xlsx / .csv trống rồi mở ngay'}
        >
          ＋ File mới
        </button>
        <span style={{ flex: 1 }} />
        {dirtyCount > 0 && <span className="badge sheet-dirty-badge">● {dirtyCount} thay đổi</span>}
        <button
          className="ghost sm"
          onClick={() => selRow !== null ? insertRow(selRow + 1) : insertRow(grid.length + 1)}
          disabled={busy}
          title={selRow !== null ? `Thêm dòng mới dưới dòng ${selRow}` : 'Thêm dòng mới ở cuối'}
        >
          ＋ Thêm dòng
        </button>
        <button className="ghost sm" onClick={deleteRow} disabled={busy || selRow === null}
          title={selRow === null ? 'Bấm vào số dòng bên trái để chọn dòng cần xóa' : `Xóa dòng ${selRow}`}>
          ✕ Xóa dòng
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

      {file.sheets.length > 1 && (
        <div className="sheet-tabs">
          {file.sheets.map((s, i) => (
            <button key={s.name} className={`sheet-tab${i === active ? ' on' : ''}`} onClick={() => switchSheet(i)}>
              {s.name}
              {(ops[i]?.length ?? 0) > 0 && <span className="sheet-tab-dot" title={`${ops[i].length} thay đổi`}>●</span>}
            </button>
          ))}
        </div>
      )}

      {sheet?.truncated && (
        <div className="sheet-banner">
          ⚠ Hiển thị {Math.min(sheet.rowCount, grid.length).toLocaleString('vi')} / {sheet.rowCount.toLocaleString('vi')} dòng
          {sheet.colCount > colCount ? ` và ${colCount} / ${sheet.colCount} cột` : ''} —
          sửa trong vùng hiển thị vẫn an toàn cho phần còn lại của file.
        </div>
      )}
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '6px 0' }}>{err}</pre>}
      {notice && <div className="badge" style={{ color: 'var(--ok)', margin: '6px 0' }}>{notice}</div>}

      <div className="sheet-scroll">
        <table className="sheet-table sheet-grid">
          <thead>
            <tr>
              <th className="sheet-rownum-h">#</th>
              {Array.from({ length: colCount }, (_, c) => <th key={c}>{colLetter(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {grid.slice(0, rowLimit).map((row, ri) => {
              const r = ri + 1;
              return (
                <tr key={r} className={selRow === r ? 'sel' : undefined}>
                  <th
                    className={`sheet-rownum${selRow === r ? ' sel' : ''}`}
                    onClick={() => setSelRow(selRow === r ? null : r)}
                    title="Bấm để chọn / bỏ chọn dòng"
                  >
                    {r}
                  </th>
                  {row.map((cell, ci) => {
                    const c = ci + 1;
                    const isEditing = editing?.r === r && editing?.c === c;
                    return (
                      <td
                        key={c}
                        className={`sheet-cell${cell.d ? ' sheet-cell-dirty' : ''}${cell.t === 'n' ? ' num' : ''}`}
                        onClick={() => { if (!isEditing) setEditing({ r, c }); }}
                        title={cell.t === 'f' ? `= ${cell.f}` : undefined}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            defaultValue={cell.v}
                            onFocus={(e) => e.currentTarget.select()}
                            onBlur={(e) => commitEdit(r, c, e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit(r, c, e.currentTarget.value);
                              else if (e.key === 'Escape') setEditing(null);
                              else if (e.key === 'Tab') {
                                e.preventDefault();
                                commitEdit(r, c, e.currentTarget.value);
                                if (c < colCount) setEditing({ r, c: c + 1 });
                              }
                            }}
                          />
                        ) : (
                          <>
                            {cell.t === 'f' && <span className="sheet-fx" aria-hidden>ƒ</span>}
                            {cell.v}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {grid.length > rowLimit && (
          <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="ghost sm" onClick={() => setRowLimit((l) => l + RENDER_STEP)}>
              ↓ Hiện thêm {RENDER_STEP} dòng
            </button>
            <span className="small" style={{ color: 'var(--muted)' }}>
              đang hiện {rowLimit.toLocaleString('vi')} / {grid.length.toLocaleString('vi')} dòng
            </span>
          </div>
        )}
        {grid.length === 0 && (
          <div className="empty" style={{ padding: 20 }}>
            <p className="small">Sheet trống — bấm “＋ Thêm dòng” để bắt đầu.</p>
          </div>
        )}
      </div>

      {pickerOpen && (
        <FolderPicker
          title="Chọn file .xlsx / .csv"
          fileExts={['xlsx', 'csv']}
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
          title="＋ Tạo bảng tính mới"
          exts={['xlsx', 'csv']}
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
              {file.sheets.map((s, i) => {
                const so = ops[i] ?? [];
                if (so.length === 0) return null;
                const set = so.filter((o) => o.op === 'set').length;
                const ins = so.filter((o) => o.op === 'insertRow').length;
                const del = so.filter((o) => o.op === 'deleteRow').length;
                return (
                  <li key={s.name}>
                    <b>{s.name}</b>: {set > 0 && `${set} ô sửa`}{set > 0 && (ins > 0 || del > 0) && ' · '}
                    {ins > 0 && `${ins} dòng thêm`}{ins > 0 && del > 0 && ' · '}{del > 0 && `${del} dòng xóa`}
                  </li>
                );
              })}
            </ul>

            <div className="sheet-save-note">
              Bản gốc được sao lưu thành <code>{file.path.split(/[\\/]/).pop()}.bak</code> trước khi ghi đè
              (ghi file tạm rồi rename — không có trạng thái ghi dở).
              {file.kind === 'xlsx' && ' Ô không sửa giữ nguyên style/công thức; chart/pivot/macro nâng cao có thể mất khi lưu bằng ExcelJS.'}
            </div>
            {totalFormulaHits > 0 && (
              <div className="sheet-save-warn">⚠ {totalFormulaHits} ô có công thức sẽ bị ghi đè bằng giá trị bạn nhập.</div>
            )}
            {totalRowOps > 0 && file.kind === 'xlsx' && (
              <div className="sheet-save-warn">
                ⚠ Có thêm/xóa dòng: công thức tham chiếu tới các dòng bị dịch chuyển và các vùng merge cell
                sẽ KHÔNG được dịch theo tự động (giới hạn ExcelJS) — kiểm tra lại file sau khi lưu.
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
