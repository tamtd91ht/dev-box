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

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import FolderPicker from './FolderPicker';
import OfficeNewFileModal from './OfficeNewFileModal';
import { evaluateGrid } from '@/lib/formulaEval';
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
  type WireStyle,
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

interface SelRange { r1: number; c1: number; r2: number; c2: number } // 1-based, inclusive

function normRange(a: Pos, b: Pos): SelRange {
  return {
    r1: Math.min(a.r, b.r), r2: Math.max(a.r, b.r),
    c1: Math.min(a.c, b.c), c2: Math.max(a.c, b.c),
  };
}

/** WireStyle (server đọc từ xlsx) → CSS inline cho <td>. nc = màu từ numFmt. */
function cellCss(st: WireStyle | undefined, nc: string | undefined): CSSProperties | undefined {
  if (!st && !nc) return undefined;
  const css: CSSProperties = {};
  if (st) {
    if (st.b) css.fontWeight = 700;
    if (st.i) css.fontStyle = 'italic';
    const deco = [st.u ? 'underline' : '', st.st ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco) css.textDecoration = deco;
    if (st.fc) css.color = st.fc;
    if (st.bg) css.background = st.bg;
    if (st.fs) css.fontSize = `${st.fs}pt`;
    if (st.ff) css.fontFamily = `'${st.ff}', var(--mono)`;
    if (st.ha) css.textAlign = st.ha === 'l' ? 'left' : st.ha === 'c' ? 'center' : st.ha === 'r' ? 'right' : 'justify';
    if (st.va) css.verticalAlign = st.va === 't' ? 'top' : st.va === 'm' ? 'middle' : 'bottom';
    if (st.wr) css.whiteSpace = 'pre-wrap';
    if (st.in) css.paddingLeft = 8 + st.in * 10;
    if (st.bt) css.borderTop = st.bt;
    if (st.br) css.borderRight = st.br;
    if (st.bb) css.borderBottom = st.bb;
    if (st.bl) css.borderLeft = st.bl;
  }
  if (nc) css.color = nc; // [Red] số âm… thắng màu font tĩnh
  return css;
}

const DEFAULT_COL_PX = 96;

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
  // Vùng chọn nhiều ô (kéo chuột / Shift+click) — cho thanh Sum/Avg/Count.
  const [selRange, setSelRange] = useState<SelRange | null>(null);
  const selDragRef = useRef<Pos | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [rowLimit, setRowLimit] = useState(RENDER_STEP);
  /** Lưới nở thêm khi đi tới mép (giữ cảm giác "vô tận" của Excel). */
  const [padR, setPadR] = useState(0);
  const [padC, setPadC] = useState(0);

  const gridRef = useRef<HTMLDivElement | null>(null);

  // ── Point mode (chèn tham chiếu bằng chuột khi đang gõ công thức) ──────────
  // Gõ "=" rồi CLICK ô → chèn "A1"; gõ "+" click ô khác → "=A1+B1"; gõ
  // "=SUM(" rồi QUÉT chuột qua vùng → "=SUM(A2:D9". Giống hệt Excel.
  const cellInputRef = useRef<HTMLInputElement | null>(null);
  const fxInputRef = useRef<HTMLInputElement | null>(null);
  const pointDragRef = useRef<{ anchor: Pos; input: HTMLInputElement } | null>(null);
  /** Chặn onClick chọn ô ngay sau một mousedown đã dùng cho point mode. */
  const pointGuardRef = useRef(false);
  const [pointRange, setPointRange] = useState<{ r1: number; c1: number; r2: number; c2: number } | null>(null);

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
    setSel(null); setSelRange(null); setEditing(null); setRowLimit(RENDER_STEP); setPadR(0); setPadC(0);
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

  // Ô công thức hiển thị KẾT QUẢ tính live (engine client) — derivation thuần,
  // working copy + op log vẫn giữ công thức gốc. numFmt của ô công thức được
  // truyền vào để kết quả hiện đúng định dạng (SUM tiền → "2,079,568").
  const nfTable = file?.sheets[active]?.styles;
  const displayGrid = useMemo(
    () => evaluateGrid(grid, (r, c) => {
      const si = grid[r - 1]?.[c - 1]?.s;
      return si !== undefined ? nfTable?.[si]?.nf : undefined;
    }),
    [grid, nfTable],
  );

  const cellAt = useCallback(
    (r: number, c: number): WireCell => displayGrid[r - 1]?.[c - 1] ?? EMPTY_CELL,
    [displayGrid],
  );
  /** Text để SỬA một ô: công thức "=...", số/ngày đã format → giá trị THÔ. */
  const editText = useCallback((r: number, c: number): string => {
    const cell = grid[r - 1]?.[c - 1];
    if (!cell) return '';
    return cell.t === 'f' && cell.f ? `=${cell.f}` : (cell.raw ?? cell.v);
  }, [grid]);

  // ── Metadata trình bày từ file: style / merge / kích thước / ẩn ────────────
  const sheetMeta = file?.sheets[active];
  const styleTable = sheetMeta?.styles;

  /** Đã thêm/xóa dòng-cột trong phiên → dữ liệu dịch chỗ, vùng merge của file
   *  không còn khớp toạ độ — TẮT render merge để không vẽ sai (widths giữ). */
  const structShifted = (ops[active] ?? []).some((o) => o.op !== 'set');

  const mergeInfo = useMemo(() => {
    const master = new Map<string, { rs: number; cs: number }>();
    const covered = new Set<string>();
    if (!structShifted) {
      for (const m of sheetMeta?.merges ?? []) {
        master.set(`${m.r1}:${m.c1}`, { rs: m.r2 - m.r1 + 1, cs: m.c2 - m.c1 + 1 });
        for (let r = m.r1; r <= m.r2; r++) {
          for (let c = m.c1; c <= m.c2; c++) {
            if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`);
          }
        }
      }
    }
    return { master, covered };
  }, [sheetMeta, structShifted]);

  const hiddenRowSet = useMemo(() => new Set(structShifted ? [] : sheetMeta?.hiddenRows ?? []), [sheetMeta, structShifted]);
  const hiddenColSet = useMemo(() => new Set(structShifted ? [] : sheetMeta?.hiddenCols ?? []), [sheetMeta, structShifted]);

  /** Thống kê vùng chọn — Sum/Avg/Count như status bar Excel. */
  const rangeStats = useMemo(() => {
    if (!selRange) return null;
    let count = 0; let nums = 0; let sum = 0;
    for (let r = selRange.r1; r <= selRange.r2; r++) {
      for (let c = selRange.c1; c <= selRange.c2; c++) {
        const cell = displayGrid[r - 1]?.[c - 1];
        if (!cell || cell.v === '') continue;
        count++;
        const src = cell.raw ?? cell.v;
        const n = Number(src.replace(/,/g, ''));
        if (Number.isFinite(n) && /\d/.test(src) && !/[^\d\s.,%+-eE]/.test(src)) { nums++; sum += n; }
      }
    }
    return { count, nums, sum, avg: nums > 0 ? sum / nums : 0 };
  }, [selRange, displayGrid]);

  // ── Edit ops (all r/c are 1-based, matching what the server replays) ────────

  const commitEdit = useCallback((r: number, c: number, value: string) => {
    setEditing(null);
    setPointRange(null);
    const cur = grids[active]?.[r - 1]?.[c - 1];
    // So với TEXT SỬA hiện tại: ô công thức là "=f", ô số/ngày format là raw.
    const curText = cur?.t === 'f' && cur.f ? `=${cur.f}` : cur?.raw ?? cur?.v ?? '';
    if (curText === value) return; // no-op edit (kể cả ô đệm để trống)
    const isFormula = value.startsWith('=') && value.trim().length > 1;
    // Giữ style index — server chỉ set value nên format của ô vẫn nguyên trong file.
    const keepS = cur?.s !== undefined ? { s: cur.s } : {};
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      // Nở working copy tới đúng ô (r,c) — gõ vào vùng đệm là hợp lệ.
      while (ng.length < r) ng.push([]);
      const row = ng[r - 1].slice();
      while (row.length < c) row.push({ ...EMPTY_CELL });
      row[c - 1] = isFormula
        ? { v: '', t: 'f', f: value.slice(1).trim(), d: true, ...keepS } // v do engine tính khi hiển thị
        : { v: value, t: 's', d: true, ...keepS };
      ng[r - 1] = row;
      return ng;
    }));
    setOps((os) => os.map((o, i) => (
      // hadFormula = ghi đè công thức CŨ bằng GIÁ TRỊ thường (để cảnh báo lúc lưu).
      i === active ? [...o, { op: 'set', r, c, value, ...(cur?.t === 'f' && !isFormula ? { hadFormula: true } : {}) }] : o
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
        row.some((c) => c.d)
          ? row.map((c) => (c.d ? { v: c.v, t: c.t, ...(c.f ? { f: c.f } : {}), ...(c.s !== undefined ? { s: c.s } : {}) } : c))
          : row
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

  /** Góc "xa" của vùng chọn khi mở rộng bằng Shift (anchor luôn là sel). */
  const selExtentRef = useRef<Pos | null>(null);

  const clearRange = useCallback(() => {
    selExtentRef.current = null;
    setSelRange(null);
  }, []);

  /** Shift+mũi tên: nới vùng chọn từ anchor (sel) — như Excel. */
  const extendSel = useCallback((dr: number, dc: number) => {
    if (!sel) return;
    const base = selExtentRef.current ?? sel;
    const ext = { r: Math.max(1, base.r + dr), c: Math.max(1, base.c + dc) };
    selExtentRef.current = ext;
    setSelRange(normRange(sel, ext));
  }, [sel]);

  const moveSel = useCallback((dr: number, dc: number) => {
    clearRange();
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
    if (k === 'ArrowDown') { e.preventDefault(); if (e.shiftKey) extendSel(1, 0); else moveSel(1, 0); }
    else if (k === 'ArrowUp') { e.preventDefault(); if (e.shiftKey) extendSel(-1, 0); else moveSel(-1, 0); }
    else if (k === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) extendSel(0, 1); else moveSel(0, 1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); if (e.shiftKey) extendSel(0, -1); else moveSel(0, -1); }
    else if (k === 'Escape') { clearRange(); }
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
  }, [editing, sel, moveSel, extendSel, clearRange, cellAt, commitEdit]);

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

  // ── Point mode helpers ───────────────────────────────────────────────────

  const refText = useCallback((r: number, c: number) => `${colLetter(c - 1)}${r}`, []);

  /** Tham chiếu (A1 hoặc A1:B5) đứng CUỐI công thức — để replace khi click/quét tiếp. */
  const REF_TAIL = /(\$?[A-Z]{1,3}\$?\d{1,7})(:\$?[A-Z]{1,3}\$?\d{1,7})?$/;

  /** Input công thức đang focus (in-cell editor hoặc thanh fx), nếu có. */
  const activeFormulaInput = useCallback((): HTMLInputElement | null => {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    for (const inp of [cellInputRef.current, fxInputRef.current]) {
      if (inp && el === inp && inp.value.startsWith('=')) return inp;
    }
    return null;
  }, []);

  const placeRef = useCallback((input: HTMLInputElement, text: string) => {
    const v = input.value;
    input.value = REF_TAIL.test(v) ? v.replace(REF_TAIL, text) : v + text;
    const L = input.value.length;
    input.setSelectionRange(L, L);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** mousedown trên một ô: đang gõ công thức → chèn ref (GIỮ focus input);
   *  bình thường → bắt đầu kéo-chọn vùng. */
  const onCellMouseDown = useCallback((r: number, c: number, e: React.MouseEvent) => {
    const input = activeFormulaInput();
    if (!input) {
      // Bắt đầu drag-select; click đơn thuần vẫn đi qua onClick đặt sel.
      if (!e.shiftKey) {
        selDragRef.current = { r, c };
        clearRange();
      }
      return;
    }
    const v = input.value;
    // Chỉ chèn khi vị trí đang "chờ tham chiếu": cuối là toán tử/(,=… hoặc là
    // một ref vừa chèn (click tiếp là ĐỔI ref, như Excel). Ngoài ra — ví dụ
    // "=A1+B1)" — thì để mặc định: blur → commit → chọn ô như thường.
    const ready = REF_TAIL.test(v) || /[=+\-*/(,%^&<>:;]\s*$/.test(v);
    if (!ready) return;
    e.preventDefault(); // giữ focus input → không blur-commit
    pointGuardRef.current = true;
    placeRef(input, refText(r, c));
    pointDragRef.current = { anchor: { r, c }, input };
    setPointRange({ r1: r, c1: c, r2: r, c2: c });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFormulaInput, placeRef, refText, clearRange]);

  /** Quét chuột (giữ phím trái) qua các ô: point mode → nới ref công thức;
   *  bình thường → nới vùng chọn (Sum/Avg/Count). */
  const onCellMouseEnter = useCallback((r: number, c: number) => {
    const d = pointDragRef.current;
    if (d) {
      const r1 = Math.min(d.anchor.r, r); const r2 = Math.max(d.anchor.r, r);
      const c1 = Math.min(d.anchor.c, c); const c2 = Math.max(d.anchor.c, c);
      placeRef(d.input, r1 === r2 && c1 === c2 ? refText(r1, c1) : `${refText(r1, c1)}:${refText(r2, c2)}`);
      setPointRange({ r1, c1, r2, c2 });
      return;
    }
    const anchor = selDragRef.current;
    if (anchor) {
      selExtentRef.current = { r, c };
      setSelRange(normRange(anchor, { r, c }));
    }
  }, [placeRef, refText]);

  useEffect(() => {
    const up = () => { pointDragRef.current = null; selDragRef.current = null; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // Hết phiên sửa (commit/Escape) → tắt highlight vùng đã quét.
  useEffect(() => {
    if (!editing) setPointRange(null);
  }, [editing]);

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
          ref={fxInputRef}
          className="sheet-fx-input"
          placeholder={sel ? 'Nhập giá trị hoặc công thức =SUM(A1:B2)… (gõ = rồi click/quét ô để chèn tham chiếu)' : 'Chọn một ô để sửa'}
          disabled={!sel}
          // key đổi theo ô chọn → input tự nhận defaultValue của ô mới.
          key={sel ? `${active}:${sel.r}:${sel.c}:${editText(sel.r, sel.c)}` : 'none'}
          defaultValue={sel ? editText(sel.r, sel.c) : ''}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && sel) {
              commitEdit(sel.r, sel.c, e.currentTarget.value);
              gridRef.current?.focus();
            } else if (e.key === 'Escape') {
              gridRef.current?.focus();
            }
          }}
          title={selCell?.t === 'f' ? `Kết quả: ${selCell.v}` : undefined}
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
        {/* xlsx: nền "giấy trắng" như Excel thật — màu chữ/nền của file vốn
            thiết kế cho giấy trắng, render trên dark theme sẽ chìm nghỉm. */}
        <table className={`sheet-table sheet-grid${file.kind === 'xlsx' ? ' fixed paper' : ''}`}>
          {/* Độ rộng cột THẬT của file (table-layout fixed) — cột ẩn → width 0. */}
          {file.kind === 'xlsx' && (
            <colgroup>
              <col style={{ width: 44 }} />
              {Array.from({ length: dispCols }, (_, ci) => {
                const w = hiddenColSet.has(ci + 1) ? 0 : sheetMeta?.colW?.[ci] ?? DEFAULT_COL_PX;
                return <col key={ci} style={{ width: w ?? DEFAULT_COL_PX }} />;
              })}
            </colgroup>
          )}
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
              const rh = sheetMeta?.rowH?.[ri] ?? null;
              return (
                <tr
                  key={r}
                  style={{
                    ...(rh !== null ? { height: rh } : {}),
                    ...(hiddenRowSet.has(r) ? { display: 'none' } : {}),
                  }}
                >
                  <th
                    className={`sheet-rownum${sel?.r === r ? ' sel' : ''}`}
                    onClick={() => { setSel({ r, c: 1 }); gridRef.current?.focus(); }}
                    title={`Chọn dòng ${r}`}
                  >
                    {r}
                  </th>
                  {Array.from({ length: dispCols }, (_, ci) => {
                    const c = ci + 1;
                    // Ô bị merge che → không render (ô master span qua).
                    if (mergeInfo.covered.has(`${r}:${c}`)) return null;
                    const span = mergeInfo.master.get(`${r}:${c}`);
                    const cell = cellAt(r, c);
                    const isSel = sel?.r === r && sel?.c === c;
                    const isEditing = editing?.r === r && editing?.c === c;
                    const inRef = pointRange
                      && r >= pointRange.r1 && r <= pointRange.r2
                      && c >= pointRange.c1 && c <= pointRange.c2;
                    const inSel = !isSel && selRange
                      && r >= selRange.r1 && r <= selRange.r2
                      && c >= selRange.c1 && c <= selRange.c2;
                    return (
                      <td
                        key={c}
                        {...(span ? { rowSpan: span.rs, colSpan: span.cs } : {})}
                        style={cellCss(cell.s !== undefined ? styleTable?.[cell.s] : undefined, cell.nc)}
                        className={[
                          'sheet-cell',
                          cell.d ? 'sheet-cell-dirty' : '',
                          cell.t === 'n' ? 'num' : '',
                          isSel ? 'selc' : '',
                          inRef ? 'inref' : '',
                          inSel ? 'insel' : '',
                        ].filter(Boolean).join(' ')}
                        onMouseDown={(e) => { if (!isEditing) onCellMouseDown(r, c, e); }}
                        onMouseEnter={() => onCellMouseEnter(r, c)}
                        onClick={(e) => {
                          if (isEditing) return;
                          // mousedown vừa chèn ref vào công thức → không đổi ô chọn.
                          if (pointGuardRef.current) { pointGuardRef.current = false; return; }
                          // Shift+click: nới vùng chọn từ anchor như Excel.
                          if (e.shiftKey && sel) {
                            selExtentRef.current = { r, c };
                            setSelRange(normRange(sel, { r, c }));
                            gridRef.current?.focus();
                            return;
                          }
                          clearRange();
                          setSel({ r, c });
                          gridRef.current?.focus();
                        }}
                        onDoubleClick={() => { setSel({ r, c }); setEditing({ r, c }); }}
                        title={cell.t === 'f' ? `= ${cell.f}` : (cell.s !== undefined && styleTable?.[cell.s]?.nf ? `Định dạng: ${styleTable[cell.s].nf}` : undefined)}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            ref={cellInputRef}
                            defaultValue={editing.seed ?? editText(r, c)}
                            onFocus={(e) => { if (!editing.seed) e.currentTarget.select(); }}
                            onBlur={(e) => commitEdit(r, c, e.currentTarget.value)}
                            onKeyDown={(e) => {
                              const isFormula = e.currentTarget.value.startsWith('=');
                              if (e.key === 'Enter') commitAndMove(e.currentTarget.value, 1, 0);
                              else if (e.key === 'Tab') { e.preventDefault(); commitAndMove(e.currentTarget.value, 0, e.shiftKey ? -1 : 1); }
                              // Đang gõ công thức thì mũi tên di chuyển CON TRỎ CHỮ,
                              // không commit — kẻo đứt tay giữa chừng "=A1+".
                              else if (e.key === 'ArrowDown' && !isFormula) commitAndMove(e.currentTarget.value, 1, 0);
                              else if (e.key === 'ArrowUp' && !isFormula) commitAndMove(e.currentTarget.value, -1, 0);
                              else if (e.key === 'Escape') { setEditing(null); gridRef.current?.focus(); }
                            }}
                          />
                        ) : (
                          <>
                            {cell.v}
                            {/* Ô công thức: chỉ một tam giác bé ở góc, hover mới hiện ƒ
                                (nội dung là KẾT QUẢ, không phải cái badge). */}
                            {cell.t === 'f' && <span className="sheet-fx-mark" aria-hidden />}
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

      {/* Status bar kiểu Excel: quét vùng là thấy Sum/Avg/Count ngay. */}
      {rangeStats && rangeStats.count > 0 && (
        <div className="sheet-statusbar">
          <span title="Vùng đang chọn">
            {colLetter(selRange!.c1 - 1)}{selRange!.r1}:{colLetter(selRange!.c2 - 1)}{selRange!.r2}
          </span>
          {rangeStats.nums > 0 && (
            <>
              <span><b>Sum:</b> {rangeStats.sum.toLocaleString('vi-VN', { maximumFractionDigits: 6 })}</span>
              <span><b>Avg:</b> {rangeStats.avg.toLocaleString('vi-VN', { maximumFractionDigits: 6 })}</span>
            </>
          )}
          <span><b>Count:</b> {rangeStats.count}</span>
        </div>
      )}

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
