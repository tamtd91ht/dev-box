'use client';

// Sheet editor (Office tab) — Excel (.xlsx) / CSV viewer-editor, local dev
// only (server gates on OFFICE_TOOL_ENABLED).
//
// GRID KIỂU EXCEL: lưới luôn đệm sẵn ô trống quanh vùng dữ liệu (file mới =
// lưới trống 12 cột × 30 dòng, tự nở khi đi tới mép) — click ô nào gõ ô đó,
// KHÔNG phải "thêm dòng" từng dòng nữa. Điều hướng bàn phím như Excel: mũi
// tên/Tab/Enter di chuyển, gõ chữ là sửa luôn, F2 sửa tại chỗ, Delete xóa nội
// dung. Name box (B7) + thanh giá trị phía trên. Thêm/xóa cả DÒNG lẫn CỘT.
//
// Editing model giữ nguyên: working copy + OP LOG per sheet (set / insertRow /
// deleteRow / insertCol / deleteCol, 1-based). Save ships the ops; server
// re-reads file rồi replay — ô không đụng giữ nguyên style/công thức. Save
// luôn backup `<file>.bak` trước, gated bởi OFFICE_ALLOW_WRITE.

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
const MIN_COLS = 12;     // lưới trống tối thiểu — như mở Excel mới
const MIN_ROWS = 30;
const PAD_COLS = 4;      // ô trống đệm quanh vùng dữ liệu
const PAD_ROWS = 12;

const EMPTY_CELL: WireCell = { v: '', t: 's' };

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

interface Pos { r: number; c: number } // 1-based

interface Editing extends Pos {
  /** Ký tự vừa gõ để bắt đầu sửa (thay nội dung cũ, kiểu Excel). */
  seed?: string;
}

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

  const [sel, setSel] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [rowLimit, setRowLimit] = useState(RENDER_STEP);
  /** Lưới nở thêm khi đi tới mép (giữ cảm giác "vô tận" của Excel). */
  const [padR, setPadR] = useState(0);
  const [padC, setPadC] = useState(0);

  const gridRef = useRef<HTMLDivElement | null>(null);

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

  const resetView = useCallback(() => {
    setSel(null); setEditing(null); setRowLimit(RENDER_STEP); setPadR(0); setPadC(0);
  }, []);

  const applyOpen = useCallback((res: SheetOpenResult) => {
    setFile(res);
    setGrids(res.sheets.map((s) => s.rows.map((row) => row.slice())));
    setOps(res.sheets.map(() => []));
    setActive(0);
    resetView();
    setPickerOpen(false);
    const list = [res.path, ...loadRecent().filter((x) => x !== res.path)];
    saveRecent(list); setRecent(list.slice(0, 10));
  }, [resetView]);

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
    setActive(i);
    resetView();
  }, [resetView]);

  const reload = useCallback(() => {
    if (!file) return;
    if (dirtyCount > 0 && !window.confirm(`Đang có ${dirtyCount} thay đổi chưa lưu — tải lại sẽ mất hết. Tiếp tục?`)) return;
    void openPath(file.path);
  }, [file, dirtyCount, openPath]);

  // ── Grid dimensions (data extent + padding = "lưới Excel") ─────────────────

  const grid = grids[active] ?? [];
  const usedRows = grid.length;
  const usedCols = grid.reduce((m, row) => Math.max(m, row.length), 0);
  const dispCols = Math.max(MIN_COLS, usedCols + PAD_COLS, padC);
  const dispRows = Math.max(MIN_ROWS, usedRows + PAD_ROWS, padR);
  const shownRows = Math.min(dispRows, rowLimit);

  const cellAt = useCallback((r: number, c: number): WireCell => grid[r - 1]?.[c - 1] ?? EMPTY_CELL, [grid]);

  // ── Edit ops (all r/c are 1-based, matching what the server replays) ────────

  const commitEdit = useCallback((r: number, c: number, value: string) => {
    setEditing(null);
    const cur = grids[active]?.[r - 1]?.[c - 1];
    if ((cur?.v ?? '') === value) return; // no-op edit (kể cả ô đệm để trống)
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      // Nở working copy tới đúng ô (r,c) — gõ vào vùng đệm là hợp lệ.
      while (ng.length < r) ng.push([]);
      const row = ng[r - 1].slice();
      while (row.length < c) row.push({ ...EMPTY_CELL });
      row[c - 1] = { v: value, t: 's', d: true };
      ng[r - 1] = row;
      return ng;
    }));
    setOps((os) => os.map((o, i) => (
      i === active ? [...o, { op: 'set', r, c, value, ...(cur?.t === 'f' ? { hadFormula: true } : {}) }] : o
    )));
  }, [grids, active]);

  const insertRowAt = useCallback((at: number) => {
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      ng.splice(Math.min(at - 1, ng.length), 0, []);
      return ng;
    }));
    setOps((os) => os.map((o, i) => (i === active ? [...o, { op: 'insertRow', r: at }] : o)));
    setSel({ r: at, c: sel?.c ?? 1 });
    setEditing(null);
    setRowLimit((l) => (at > l ? at + RENDER_STEP : l));
  }, [active, sel]);

  const deleteRowAt = useCallback((at: number) => {
    const row = grid[at - 1];
    if (row?.some((c) => c.v !== '') && !window.confirm(`Xóa dòng ${at} (đang có dữ liệu)?`)) return;
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      if (at - 1 < ng.length) ng.splice(at - 1, 1);
      return ng;
    }));
    setOps((os) => os.map((o, i) => (i === active ? [...o, { op: 'deleteRow', r: at }] : o)));
    setEditing(null);
  }, [active, grid]);

  const insertColAt = useCallback((at: number) => {
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      return g.map((row) => {
        if (row.length < at) return row; // dòng ngắn: cột ảo phía sau tự dịch
        const nr = row.slice();
        nr.splice(at - 1, 0, { ...EMPTY_CELL });
        return nr;
      });
    }));
    setOps((os) => os.map((o, i) => (i === active ? [...o, { op: 'insertCol', c: at }] : o)));
    setSel({ r: sel?.r ?? 1, c: at });
    setEditing(null);
  }, [active, sel]);

  const deleteColAt = useCallback((at: number) => {
    const hasData = grid.some((row) => (row[at - 1]?.v ?? '') !== '');
    if (hasData && !window.confirm(`Xóa cột ${colLetter(at - 1)} (đang có dữ liệu)?`)) return;
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      return g.map((row) => {
        if (row.length < at) return row;
        const nr = row.slice();
        nr.splice(at - 1, 1);
        return nr;
      });
    }));
    setOps((os) => os.map((o, i) => (i === active ? [...o, { op: 'deleteCol', c: at }] : o)));
    setEditing(null);
  }, [active, grid]);

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

  // ── Selection / keyboard (Excel-style) ──────────────────────────────────────

  const moveSel = useCallback((dr: number, dc: number) => {
    setSel((s) => {
      const r = Math.max(1, (s?.r ?? 1) + dr);
      const c = Math.max(1, (s?.c ?? 1) + dc);
      // Đi tới mép → lưới nở thêm (cảm giác lưới vô tận của Excel).
      if (r >= dispRows - 1) setPadR(r + PAD_ROWS);
      if (c >= dispCols - 1) setPadC(c + PAD_COLS);
      if (r > rowLimit - 3) setRowLimit(r + RENDER_STEP);
      return { r, c };
    });
  }, [dispRows, dispCols, rowLimit]);

  const onGridKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editing || !sel) return;
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); moveSel(1, 0); }
    else if (k === 'ArrowUp') { e.preventDefault(); moveSel(-1, 0); }
    else if (k === 'ArrowRight') { e.preventDefault(); moveSel(0, 1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); moveSel(0, -1); }
    else if (k === 'Tab') { e.preventDefault(); moveSel(0, e.shiftKey ? -1 : 1); }
    else if (k === 'Enter' || k === 'F2') { e.preventDefault(); setEditing({ ...sel }); }
    else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      if (cellAt(sel.r, sel.c).v !== '') commitEdit(sel.r, sel.c, '');
    }
    else if (k === 'Home' && e.ctrlKey) { e.preventDefault(); setSel({ r: 1, c: 1 }); }
    else if (k === 'PageDown') { e.preventDefault(); moveSel(20, 0); }
    else if (k === 'PageUp') { e.preventDefault(); moveSel(-20, 0); }
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Gõ chữ/số là sửa luôn, thay nội dung cũ — đúng thói quen Excel.
      e.preventDefault();
      setEditing({ ...sel, seed: k });
    }
  }, [editing, sel, moveSel, cellAt, commitEdit]);

  // Giữ ô chọn trong khung nhìn.
  useEffect(() => {
    if (!sel) return;
    gridRef.current?.querySelector('.sheet-cell.selc')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [sel]);

  /** Commit từ ô đang sửa rồi di chuyển (Enter ↓ / Tab → / mũi tên). */
  const commitAndMove = useCallback((value: string, dr: number, dc: number) => {
    if (!editing) return;
    commitEdit(editing.r, editing.c, value);
    setSel({ r: editing.r, c: editing.c });
    if (dr !== 0 || dc !== 0) moveSel(dr, dc);
    gridRef.current?.focus();
  }, [editing, commitEdit, moveSel]);

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
  const allowWrite = flags?.allowWrite === true;

  // ── Empty state: recents + Browse ───────────────────────────────────────────

  if (!file) {
    return (
      <div className="panel office-hero-panel" style={{ margin: 'auto', width: 'min(680px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>▦</div>
          <div className="office-hero-title">Excel / CSV Editor</div>
          <p className="office-hero-sub">
            Mở file <code>.xlsx</code> hoặc <code>.csv</code> trên máy — lưới ô như Excel,
            click ô nào gõ ô đó, điều hướng bằng phím, rồi lưu ghi đè an toàn.
          </p>
          <div className="office-hero-points">
            <span className="office-point">▦ Lưới ô kiểu Excel</span>
            <span className="office-point">⌨ Mũi tên / Tab / Enter</span>
            <span className="office-point">➕ Thêm dòng &amp; cột</span>
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

  const totalRowColOps = ops.flat().filter((o) => o.op !== 'set').length;
  const totalFormulaHits = ops.flat().filter((o) => o.op === 'set' && o.hadFormula).length;
  const selCell = sel ? cellAt(sel.r, sel.c) : null;

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

      {/* ── Name box + thanh giá trị + thao tác dòng/cột (kiểu Excel) ── */}
      <div className="sheet-fxbar">
        <span className="sheet-namebox" title="Ô đang chọn">
          {sel ? `${colLetter(sel.c - 1)}${sel.r}` : '—'}
        </span>
        <span className="sheet-fx-ico" aria-hidden>ƒx</span>
        <input
          className="sheet-fx-input"
          placeholder={sel ? 'Nhập giá trị cho ô đang chọn…' : 'Chọn một ô để sửa'}
          disabled={!sel}
          // key đổi theo ô chọn → input tự nhận defaultValue của ô mới.
          key={sel ? `${active}:${sel.r}:${sel.c}:${selCell?.v}` : 'none'}
          defaultValue={selCell?.t === 'f' ? `= ${selCell.f ?? ''} → ${selCell.v}` : selCell?.v ?? ''}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && sel) {
              commitEdit(sel.r, sel.c, e.currentTarget.value);
              gridRef.current?.focus();
            } else if (e.key === 'Escape') {
              gridRef.current?.focus();
            }
          }}
          title={selCell?.t === 'f' ? 'Ô công thức — sửa sẽ ghi đè công thức bằng giá trị mới' : undefined}
        />
        <span className="sheet-fxbar-sep" aria-hidden />
        <button className="ghost sm" disabled={busy || !sel} onClick={() => sel && insertRowAt(sel.r + 1)}
          title={sel ? `Chèn dòng mới dưới dòng ${sel.r}` : 'Chọn một ô trước'}>＋ Dòng</button>
        <button className="ghost sm" disabled={busy || !sel || (sel?.r ?? 0) > usedRows} onClick={() => sel && deleteRowAt(sel.r)}
          title={sel ? `Xóa dòng ${sel.r}` : 'Chọn một ô trước'}>✕ Dòng</button>
        <button className="ghost sm" disabled={busy || !sel} onClick={() => sel && insertColAt(sel.c + 1)}
          title={sel ? `Chèn cột mới bên phải cột ${colLetter(sel.c - 1)}` : 'Chọn một ô trước'}>＋ Cột</button>
        <button className="ghost sm" disabled={busy || !sel || (sel?.c ?? 0) > usedCols} onClick={() => sel && deleteColAt(sel.c)}
          title={sel ? `Xóa cột ${colLetter(sel.c - 1)}` : 'Chọn một ô trước'}>✕ Cột</button>
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
          ⚠ Hiển thị {Math.min(sheet.rowCount, usedRows).toLocaleString('vi')} / {sheet.rowCount.toLocaleString('vi')} dòng
          {sheet.colCount > usedCols ? ` và ${usedCols} / ${sheet.colCount} cột` : ''} —
          sửa trong vùng hiển thị vẫn an toàn cho phần còn lại của file.
        </div>
      )}
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '6px 0' }}>{err}</pre>}
      {notice && <div className="badge" style={{ color: 'var(--ok)', margin: '6px 0' }}>{notice}</div>}

      <div className="sheet-scroll" ref={gridRef} tabIndex={0} onKeyDown={onGridKeyDown}>
        <table className="sheet-table sheet-grid">
          <thead>
            <tr>
              <th className="sheet-rownum-h">#</th>
              {Array.from({ length: dispCols }, (_, c) => (
                <th key={c} className={sel?.c === c + 1 ? 'on' : undefined}>{colLetter(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: shownRows }, (_, ri) => {
              const r = ri + 1;
              return (
                <tr key={r}>
                  <th
                    className={`sheet-rownum${sel?.r === r ? ' sel' : ''}`}
                    onClick={() => { setSel({ r, c: 1 }); gridRef.current?.focus(); }}
                    title={`Chọn dòng ${r}`}
                  >
                    {r}
                  </th>
                  {Array.from({ length: dispCols }, (_, ci) => {
                    const c = ci + 1;
                    const cell = cellAt(r, c);
                    const isSel = sel?.r === r && sel?.c === c;
                    const isEditing = editing?.r === r && editing?.c === c;
                    return (
                      <td
                        key={c}
                        className={[
                          'sheet-cell',
                          cell.d ? 'sheet-cell-dirty' : '',
                          cell.t === 'n' ? 'num' : '',
                          isSel ? 'selc' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => {
                          if (isEditing) return;
                          setSel({ r, c });
                          gridRef.current?.focus();
                        }}
                        onDoubleClick={() => { setSel({ r, c }); setEditing({ r, c }); }}
                        title={cell.t === 'f' ? `= ${cell.f}` : undefined}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            defaultValue={editing.seed ?? cell.v}
                            onFocus={(e) => { if (!editing.seed) e.currentTarget.select(); }}
                            onBlur={(e) => commitEdit(r, c, e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitAndMove(e.currentTarget.value, 1, 0);
                              else if (e.key === 'Tab') { e.preventDefault(); commitAndMove(e.currentTarget.value, 0, e.shiftKey ? -1 : 1); }
                              else if (e.key === 'ArrowDown') commitAndMove(e.currentTarget.value, 1, 0);
                              else if (e.key === 'ArrowUp') commitAndMove(e.currentTarget.value, -1, 0);
                              else if (e.key === 'Escape') { setEditing(null); gridRef.current?.focus(); }
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
        {dispRows > rowLimit && (
          <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="ghost sm" onClick={() => setRowLimit((l) => l + RENDER_STEP)}>
              ↓ Hiện thêm {RENDER_STEP} dòng
            </button>
            <span className="small" style={{ color: 'var(--muted)' }}>
              đang hiện {rowLimit.toLocaleString('vi')} / {dispRows.toLocaleString('vi')} dòng
            </span>
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
                const parts: string[] = [];
                const n = (k: SheetOp['op']) => so.filter((o) => o.op === k).length;
                if (n('set') > 0) parts.push(`${n('set')} ô sửa`);
                if (n('insertRow') > 0) parts.push(`${n('insertRow')} dòng thêm`);
                if (n('deleteRow') > 0) parts.push(`${n('deleteRow')} dòng xóa`);
                if (n('insertCol') > 0) parts.push(`${n('insertCol')} cột thêm`);
                if (n('deleteCol') > 0) parts.push(`${n('deleteCol')} cột xóa`);
                return <li key={s.name}><b>{s.name}</b>: {parts.join(' · ')}</li>;
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
            {totalRowColOps > 0 && file.kind === 'xlsx' && (
              <div className="sheet-save-warn">
                ⚠ Có thêm/xóa dòng hoặc cột: công thức tham chiếu tới vùng bị dịch chuyển và các vùng merge cell
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
