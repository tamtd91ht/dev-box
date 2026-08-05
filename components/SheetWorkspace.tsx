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
// ĐỊNH DẠNG (chỉ .xlsx): ribbon phía trên — font/cỡ/B I U S, màu chữ, màu nền,
// kẻ viền, căn lề ngang-dọc, wrap, định dạng số (numFmt + thêm/bớt thập phân),
// trộn ô & bỏ trộn, xóa định dạng. Áp cho Ô ĐANG CHỌN hoặc CẢ VÙNG đã quét.
// Chèn/xóa dòng-cột có đủ 4 hướng (trên/dưới/trái/phải) — cả ở ribbon lẫn
// menu chuột phải trên đầu dòng/cột.
//
// Editing model giữ nguyên: working copy + OP LOG per sheet (set / insertRow /
// deleteRow / insertCol / deleteCol / style / merge / unmerge, 1-based). Save
// ships the ops; server re-reads file rồi replay — ô không đụng giữ nguyên
// style/công thức. Save luôn backup `<file>.bak` trước, gated bởi
// OFFICE_ALLOW_WRITE.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import FolderPicker from './FolderPicker';
import OfficeNewFileModal from './OfficeNewFileModal';
import SheetFormatBar from './SheetFormatBar';
import { evaluateGrid } from '@/lib/formulaEval';
import { formatNumFmt } from '@/lib/numFmt';
import {
  fetchSheetFlags,
  openSheetFile,
  createSheetFile,
  saveSheetFile,
  colLetter,
  fmtBytes,
  applyStylePatch,
  type SheetFlags,
  type SheetOp,
  type SheetOpenResult,
  type StylePatch,
  type WireCell,
  type WireMerge,
  type WireStyle,
} from '@/lib/sheet';

const RECENT_KEY = 'sheet.recent';
const RENDER_STEP = 500; // rows rendered at a time (the DOM, not the data, is the bottleneck)
const MIN_COLS = 12;     // lưới trống tối thiểu — như mở Excel mới
const MIN_ROWS = 30;
const PAD_COLS = 4;      // ô trống đệm quanh vùng dữ liệu
const PAD_ROWS = 12;
const MAX_STRUCT_STEP = 200; // trần dòng/cột chèn-xóa một lần (chống lỡ tay chọn cả cột)

const EMPTY_CELL: WireCell = { v: '', t: 's' };

/** Số "chuẩn" — khớp parseInput của server (chuỗi này lưu vào file là NUMBER). */
const CANON_NUM = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Gán / bỏ style index của một ô (không mutate ô cũ). */
function withStyle(cell: WireCell, s: number | undefined): WireCell {
  if (s === undefined) {
    if (cell.s === undefined) return cell;
    const rest = { ...cell };
    delete rest.s;
    return rest;
  }
  return cell.s === s ? cell : { ...cell, s };
}

/** Hai vùng có giao nhau? (1-based, inclusive) */
function overlaps(a: SelRange, b: WireMerge): boolean {
  return a.r1 <= b.r2 && a.r2 >= b.r1 && a.c1 <= b.c2 && a.c2 >= b.c1;
}

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

  // Bảng style LÀM VIỆC per-sheet (seed từ file, thêm dần khi user định dạng).
  // Dùng ref chứ không phải state vì một thao tác định dạng đổi cả grid lẫn
  // bảng style — hai state riêng không cập nhật nguyên tử được. Mảng chỉ được
  // APPEND (index đã phát ra cho ô không bao giờ đổi nghĩa), nên mutate an
  // toàn; re-render do setGrids đi kèm luôn kích hoạt.
  const styleRef = useRef<WireStyle[][]>([]);
  const styleIdxRef = useRef<Map<string, number>[]>([]);
  /** Vùng merge làm việc per-sheet (file + do user trộn trong phiên). */
  const [mergesW, setMergesW] = useState<WireMerge[][]>([]);
  /** Menu chuột phải: trên đầu dòng, đầu cột, hay trong lưới. */
  const [ctx, setCtx] = useState<{ x: number; y: number; kind: 'row' | 'col' | 'cell' } | null>(null);

  const [sel, setSel] = useState<Pos | null>(null);
  // Vùng chọn nhiều ô (kéo chuột / Shift+click) — cho thanh Sum/Avg/Count.
  const [selRange, setSelRange] = useState<SelRange | null>(null);
  /** Vùng được chọn KIỂU gì: quét ô, bấm đầu dòng, hay bấm đầu cột. Chọn cả
   *  cột thì "chèn dòng" chỉ nên chèn 1 dòng (chứ không phải mấy nghìn dòng). */
  const [selKind, setSelKind] = useState<'cells' | 'row' | 'col'>('cells');
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
    // Mở file/đổi sheet là chọn sẵn A1 như Excel — ribbon định dạng dùng được ngay.
    setSel({ r: 1, c: 1 }); setSelRange(null); setSelKind('cells');
    setEditing(null); setRowLimit(RENDER_STEP); setPadR(0); setPadC(0);
    setCtx(null);
  }, []);

  /** Style mới → index trong bảng làm việc của sheet (dedupe, append-only). */
  const internStyle = useCallback((sheetIdx: number, st: WireStyle | undefined): number | undefined => {
    if (!st) return undefined;
    const table = styleRef.current[sheetIdx] ?? (styleRef.current[sheetIdx] = []);
    const idx = styleIdxRef.current[sheetIdx] ?? (styleIdxRef.current[sheetIdx] = new Map());
    const key = JSON.stringify(st);
    const hit = idx.get(key);
    if (hit !== undefined) return hit;
    table.push(st);
    idx.set(key, table.length - 1);
    return table.length - 1;
  }, []);

  const applyOpen = useCallback((res: SheetOpenResult) => {
    setFile(res);
    setGrids(res.sheets.map((s) => s.rows.map((row) => row.slice())));
    setOps(res.sheets.map(() => []));
    styleRef.current = res.sheets.map((s) => (s.styles ?? []).slice());
    styleIdxRef.current = styleRef.current.map((tbl) => {
      const m = new Map<string, number>();
      tbl.forEach((st, i) => { if (!m.has(JSON.stringify(st))) m.set(JSON.stringify(st), i); });
      return m;
    });
    setMergesW(res.sheets.map((s) => (s.merges ?? []).map((m) => ({ ...m }))));
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

  /** Bảng style đang dùng để VẼ (file + định dạng user vừa áp trong phiên). */
  const styleTable = styleRef.current[active] ?? [];

  // Ô công thức hiển thị KẾT QUẢ tính live (engine client) — derivation thuần,
  // working copy + op log vẫn giữ công thức gốc. numFmt của ô công thức được
  // truyền vào để kết quả hiện đúng định dạng (SUM tiền → "2,079,568").
  // Bảng style là ref append-only nên không nằm trong deps: mọi thay đổi định
  // dạng đều đi kèm setGrids → `grid` đổi identity → memo tính lại.
  const displayGrid = useMemo(
    () => evaluateGrid(grid, (r, c) => {
      const si = grid[r - 1]?.[c - 1]?.s;
      return si !== undefined ? styleRef.current[active]?.[si]?.nf : undefined;
    }),
    [grid, active],
  );

  /** Ô để HIỂN THỊ — áp numFmt của style HIỆN TẠI lên giá trị thô, nên đổi
   *  định dạng số là thấy ngay (1234 → "1,234 ₫") mà không cần lưu/mở lại. */
  const cellAt = useCallback((r: number, c: number): WireCell => {
    const cell = displayGrid[r - 1]?.[c - 1] ?? EMPTY_CELL;
    if (cell.v === '') return cell;
    const nf = cell.s !== undefined ? styleRef.current[active]?.[cell.s]?.nf : undefined;
    // Ô công thức đã được engine format theo nf; rich text/hyperlink để nguyên.
    if (cell.t === 'f' || cell.t === 'x') return cell;
    // Không có nf và server cũng không format gì (raw trống) → chẳng có gì đổi.
    if (!nf && cell.raw === undefined) return cell;
    const src = cell.raw ?? cell.v;
    if (cell.t === 'd') {
      // raw của ô ngày là dạng thô "dd/mm/yyyy [hh:mm:ss]" → dựng lại Date (UTC
      // như ExcelJS) rồi format theo nf hiện tại.
      const m = src.match(/^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/);
      if (!m) return cell;
      const text = !nf || nf === '@'
        ? src
        : formatNumFmt(new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))), nf).text;
      return text === cell.v ? cell : { ...cell, v: text };
    }
    const num = cell.t === 'n' || CANON_NUM.test(src) ? Number(src) : NaN;
    if (!Number.isFinite(num)) return cell;
    // '@' (Văn bản) → hiện số thô, không nhồi số vào pattern text.
    const text = formatNumFmt(num, nf === '@' ? undefined : nf).text;
    return text === cell.v ? cell : { ...cell, v: text, raw: String(num) };
  }, [displayGrid, active]);
  /** Text để SỬA một ô: công thức "=...", số/ngày đã format → giá trị THÔ. */
  const editText = useCallback((r: number, c: number): string => {
    const cell = grid[r - 1]?.[c - 1];
    if (!cell) return '';
    return cell.t === 'f' && cell.f ? `=${cell.f}` : (cell.raw ?? cell.v);
  }, [grid]);

  // ── Metadata trình bày từ file: style / merge / kích thước / ẩn ────────────
  const sheetMeta = file?.sheets[active];

  /** Đã thêm/xóa dòng-cột trong phiên → dữ liệu dịch chỗ, vùng merge không còn
   *  khớp toạ độ (ExcelJS không dịch merge khi splice) — TẮT render merge để
   *  không vẽ sai (độ rộng cột vẫn giữ). Modal lưu có cảnh báo tương ứng. */
  const structShifted = (ops[active] ?? []).some((o) => o.op === 'insertRow' || o.op === 'deleteRow' || o.op === 'insertCol' || o.op === 'deleteCol');

  const sheetMerges = mergesW[active] ?? [];

  const mergeInfo = useMemo(() => {
    const master = new Map<string, { rs: number; cs: number }>();
    const covered = new Set<string>();
    if (!structShifted) {
      for (const m of sheetMerges) {
        master.set(`${m.r1}:${m.c1}`, { rs: m.r2 - m.r1 + 1, cs: m.c2 - m.c1 + 1 });
        for (let r = m.r1; r <= m.r2; r++) {
          for (let c = m.c1; c <= m.c2; c++) {
            if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`);
          }
        }
      }
    }
    return { master, covered };
  }, [sheetMerges, structShifted]);

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

  /** Số dòng/cột được phép chèn-xóa một lần (chống lỡ tay chọn cả cột). */
  const clampStep = useCallback((count: number, unit: 'dòng' | 'cột') => {
    if (count <= MAX_STRUCT_STEP) return Math.max(1, count);
    flash(`Một lần chỉ chèn/xóa tối đa ${MAX_STRUCT_STEP} ${unit} — đã giới hạn lại.`);
    return MAX_STRUCT_STEP;
  }, [flash]);

  /** Ghi thêm N op giống nhau vào log của sheet đang mở. */
  const pushOps = useCallback((make: (k: number) => SheetOp, count: number) => {
    setOps((os) => os.map((o, i) => (
      i === active ? [...o, ...Array.from({ length: count }, (_, k) => make(k))] : o
    )));
  }, [active]);

  const insertRowAt = useCallback((at: number, howMany = 1) => {
    const count = clampStep(howMany, 'dòng');
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      ng.splice(Math.min(at - 1, ng.length), 0, ...Array.from({ length: count }, () => [] as WireCell[]));
      return ng;
    }));
    // Chèn N lần tại cùng vị trí = N dòng trống liền nhau (server replay in order).
    pushOps(() => ({ op: 'insertRow', r: at }), count);
    setSel({ r: at, c: sel?.c ?? 1 });
    setSelRange(null);
    setEditing(null);
    setRowLimit((l) => (at > l ? at + RENDER_STEP : l));
  }, [active, sel, pushOps, clampStep]);

  const deleteRowAt = useCallback((at: number, howMany = 1) => {
    const count = clampStep(howMany, 'dòng');
    const hasData = Array.from({ length: count }, (_, k) => grid[at - 1 + k]).some((row) => row?.some((c) => c.v !== ''));
    const what = count > 1 ? `${count} dòng từ dòng ${at}` : `dòng ${at}`;
    if (hasData && !window.confirm(`Xóa ${what} (đang có dữ liệu)?`)) return;
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      if (at - 1 < ng.length) ng.splice(at - 1, count);
      return ng;
    }));
    // Xóa N lần tại cùng vị trí = N dòng liên tiếp (mỗi lần xóa dồn lên).
    pushOps(() => ({ op: 'deleteRow', r: at }), count);
    setSelRange(null);
    setEditing(null);
  }, [active, grid, pushOps, clampStep]);

  const insertColAt = useCallback((at: number, howMany = 1) => {
    const count = clampStep(howMany, 'cột');
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      return g.map((row) => {
        if (row.length < at) return row; // dòng ngắn: cột ảo phía sau tự dịch
        const nr = row.slice();
        nr.splice(at - 1, 0, ...Array.from({ length: count }, () => ({ ...EMPTY_CELL })));
        return nr;
      });
    }));
    pushOps(() => ({ op: 'insertCol', c: at }), count);
    setSel({ r: sel?.r ?? 1, c: at });
    setSelRange(null);
    setEditing(null);
  }, [active, sel, pushOps, clampStep]);

  const deleteColAt = useCallback((at: number, howMany = 1) => {
    const count = clampStep(howMany, 'cột');
    const hasData = grid.some((row) => row.slice(at - 1, at - 1 + count).some((c) => (c?.v ?? '') !== ''));
    const what = count > 1
      ? `${count} cột từ cột ${colLetter(at - 1)}`
      : `cột ${colLetter(at - 1)}`;
    if (hasData && !window.confirm(`Xóa ${what} (đang có dữ liệu)?`)) return;
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      return g.map((row) => {
        if (row.length < at) return row;
        const nr = row.slice();
        nr.splice(at - 1, count);
        return nr;
      });
    }));
    pushOps(() => ({ op: 'deleteCol', c: at }), count);
    setSelRange(null);
    setEditing(null);
  }, [active, grid, pushOps, clampStep]);

  // ── Định dạng (chỉ .xlsx) ───────────────────────────────────────────────────

  /** Vùng đang là đích của mọi thao tác định dạng: vùng đã quét, hoặc ô đang chọn. */
  const fmtRange: SelRange | null = selRange ?? (sel ? { r1: sel.r, c1: sel.c, r2: sel.r, c2: sel.c } : null);

  /**
   * Áp một StylePatch cho cả vùng: cập nhật style index của từng ô trong
   * working copy + ghi MỘT op 'style' cho server replay.
   */
  const applyFormat = useCallback((patch: StylePatch) => {
    const rg = fmtRange;
    if (!rg || file?.kind !== 'xlsx') return;
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      while (ng.length < rg.r2) ng.push([]);
      for (let r = rg.r1; r <= rg.r2; r++) {
        const row = ng[r - 1].slice();
        while (row.length < rg.c2) row.push({ ...EMPTY_CELL });
        for (let c = rg.c1; c <= rg.c2; c++) {
          const cell = row[c - 1];
          const base = cell.s !== undefined ? styleRef.current[active]?.[cell.s] : undefined;
          const next = applyStylePatch(base, patch, {
            t: r === rg.r1, b: r === rg.r2, l: c === rg.c1, r: c === rg.c2,
          });
          row[c - 1] = withStyle(cell, internStyle(active, next));
        }
        ng[r - 1] = row;
      }
      return ng;
    }));
    setOps((os) => os.map((o, i) => {
      if (i !== active) return o;
      const op: SheetOp = { op: 'style', ...rg, st: patch };
      const last = o[o.length - 1];
      // Gộp với op liền trước nếu CÙNG vùng và CÙNG bộ thuộc tính: kéo bảng
      // màu hay bấm đậm rồi bỏ đậm chỉ để lại một op (mỗi thuộc tính là giá
      // trị tuyệt đối nên op sau đè op trước là đúng). Trừ 'bd' — các preset
      // viền cộng dồn cạnh, gộp sẽ mất cạnh đã kẻ trước đó.
      const mergeable = !('bd' in patch) && last?.op === 'style'
        && last.r1 === rg.r1 && last.c1 === rg.c1 && last.r2 === rg.r2 && last.c2 === rg.c2
        && JSON.stringify(Object.keys(last.st).sort()) === JSON.stringify(Object.keys(patch).sort());
      return mergeable ? [...o.slice(0, -1), op] : [...o, op];
    }));
  }, [fmtRange, file, active, internStyle]);

  /** Trộn vùng chọn thành một ô + căn giữa (như nút Merge & Center của Excel). */
  const doMerge = useCallback(() => {
    const rg = selRange;
    if (!rg || (rg.r1 === rg.r2 && rg.c1 === rg.c2)) {
      flash('Quét chọn từ 2 ô trở lên rồi mới trộn được.');
      return;
    }
    let lost = false;
    for (let r = rg.r1; r <= rg.r2 && !lost; r++) {
      for (let c = rg.c1; c <= rg.c2; c++) {
        if ((r !== rg.r1 || c !== rg.c1) && (grid[r - 1]?.[c - 1]?.v ?? '') !== '') { lost = true; break; }
      }
    }
    if (lost && !window.confirm('Trộn ô chỉ giữ nội dung ô trên-trái, dữ liệu các ô còn lại sẽ bị xóa. Tiếp tục?')) return;
    setGrids((gs) => gs.map((g, i) => {
      if (i !== active) return g;
      const ng = g.slice();
      while (ng.length < rg.r2) ng.push([]);
      const masterS = ng[rg.r1 - 1]?.[rg.c1 - 1]?.s;
      for (let r = rg.r1; r <= rg.r2; r++) {
        const row = ng[r - 1].slice();
        while (row.length < rg.c2) row.push({ ...EMPTY_CELL });
        for (let c = rg.c1; c <= rg.c2; c++) {
          if (r === rg.r1 && c === rg.c1) continue;
          // Như ExcelJS/Excel: ô bị trộn mất nội dung, style theo ô trên-trái.
          row[c - 1] = { v: '', t: 's', ...(masterS !== undefined ? { s: masterS } : {}) };
        }
        ng[r - 1] = row;
      }
      return ng;
    }));
    setMergesW((ms) => ms.map((list, i) => (i === active
      ? [...list.filter((m) => !overlaps(rg, m)), { ...rg }]
      : list)));
    setOps((os) => os.map((o, i) => (i === active ? [...o, { op: 'merge', ...rg }] : o)));
    // Merge & Center: căn giữa ngang + dọc như Excel.
    applyFormat({ ha: 'c', va: 'm' });
  }, [selRange, grid, active, flash, applyFormat]);

  const doUnmerge = useCallback(() => {
    const rg = fmtRange;
    if (!rg) return;
    if (!(mergesW[active] ?? []).some((m) => overlaps(rg, m))) {
      flash('Vùng chọn không có ô nào đang bị trộn.');
      return;
    }
    setMergesW((ms) => ms.map((list, i) => (i === active ? list.filter((m) => !overlaps(rg, m)) : list)));
    setOps((os) => os.map((o, i) => (i === active ? [...o, { op: 'unmerge', ...rg }] : o)));
  }, [fmtRange, mergesW, active, flash]);

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
    setSelKind('cells');
  }, []);

  /** Shift+mũi tên: nới vùng chọn từ anchor (sel) — như Excel. */
  const extendSel = useCallback((dr: number, dc: number) => {
    if (!sel) return;
    const base = selExtentRef.current ?? sel;
    const ext = { r: Math.max(1, base.r + dr), c: Math.max(1, base.c + dc) };
    selExtentRef.current = ext;
    setSelRange(normRange(sel, ext));
    setSelKind('cells');
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
    // Ctrl+B / I / U — đậm/nghiêng/gạch chân như Excel (chỉ .xlsx có style).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && 'biu'.includes(k.toLowerCase())) {
      e.preventDefault();
      if (file?.kind !== 'xlsx') return;
      const key = k.toLowerCase() === 'b' ? 'b' : k.toLowerCase() === 'i' ? 'i' : 'u';
      const cur = grid[sel.r - 1]?.[sel.c - 1]?.s;
      const on = cur !== undefined ? styleRef.current[active]?.[cur]?.[key] : undefined;
      applyFormat({ [key]: on ? null : 1 } as StylePatch);
      return;
    }
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
  }, [editing, sel, moveSel, extendSel, clearRange, cellAt, commitEdit, file, grid, active, applyFormat]);

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
      setSelKind('cells');
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

  // Escape đóng menu chuột phải.
  useEffect(() => {
    if (!ctx) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtx(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [ctx]);

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
            <span className="office-point">➕ Chèn dòng &amp; cột 4 hướng</span>
            <span className="office-point">🎨 Font · màu · viền · căn lề</span>
            <span className="office-point">⿴ Trộn ô &amp; định dạng số</span>
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

  const totalRowColOps = ops.flat().filter((o) => (
    o.op === 'insertRow' || o.op === 'deleteRow' || o.op === 'insertCol' || o.op === 'deleteCol'
  )).length;
  const totalFormulaHits = ops.flat().filter((o) => o.op === 'set' && o.hadFormula).length;
  const selCell = sel ? cellAt(sel.r, sel.c) : null;

  // ── Ribbon: style hiệu dụng của ô đang chọn + phạm vi áp dụng ──────────────
  const selStyleIdx = sel ? grid[sel.r - 1]?.[sel.c - 1]?.s : undefined;
  const selStyle = selStyleIdx !== undefined ? styleTable[selStyleIdx] : undefined;
  const rangeLabel = fmtRange
    ? (fmtRange.r1 === fmtRange.r2 && fmtRange.c1 === fmtRange.c2
      ? `${colLetter(fmtRange.c1 - 1)}${fmtRange.r1}`
      : `${colLetter(fmtRange.c1 - 1)}${fmtRange.r1}:${colLetter(fmtRange.c2 - 1)}${fmtRange.r2}`)
    : '—';
  const rowSpan = fmtRange ? fmtRange.r2 - fmtRange.r1 + 1 : 1;
  const colSpan = fmtRange ? fmtRange.c2 - fmtRange.c1 + 1 : 1;
  // Chèn/xóa theo số dòng-cột user đang phủ; nhưng "chọn cả cột" thì thao tác
  // DÒNG chỉ tính 1 (và ngược lại) — không thì bấm nhầm là thêm mấy nghìn dòng.
  const rowOpCount = selKind === 'col' ? 1 : rowSpan;
  const colOpCount = selKind === 'row' ? 1 : colSpan;

  /** Đầu dòng/cột: click chọn cả dòng/cột (để định dạng hàng loạt như Excel). */
  const selectWholeRow = (r: number) => {
    setSel({ r, c: 1 });
    selExtentRef.current = null;
    setSelRange({ r1: r, c1: 1, r2: r, c2: Math.max(usedCols, MIN_COLS) });
    setSelKind('row');
    gridRef.current?.focus();
  };
  const selectWholeCol = (c: number) => {
    setSel({ r: 1, c });
    selExtentRef.current = null;
    setSelRange({ r1: 1, c1: c, r2: Math.max(usedRows, MIN_ROWS), c2: c });
    setSelKind('col');
    gridRef.current?.focus();
  };

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

      {/* ── Ribbon định dạng (xlsx mới có style; CSV là text thuần) ── */}
      {file.kind === 'xlsx' ? (
        <SheetFormatBar
          style={selStyle}
          disabled={!sel || busy}
          rangeLabel={rangeLabel}
          rowSpan={rowOpCount}
          colSpan={colOpCount}
          canMerge={!!selRange && !(selRange.r1 === selRange.r2 && selRange.c1 === selRange.c2)}
          canUnmerge={!!fmtRange && sheetMerges.some((m) => overlaps(fmtRange, m))}
          canDeleteRow={!!sel && sel.r <= usedRows}
          canDeleteCol={!!sel && sel.c <= usedCols}
          onFormat={applyFormat}
          onMerge={doMerge}
          onUnmerge={doUnmerge}
          onInsertRow={(dir) => sel && insertRowAt(dir === 'above' ? fmtRange!.r1 : fmtRange!.r2 + 1, rowOpCount)}
          onDeleteRow={() => fmtRange && deleteRowAt(fmtRange.r1, Math.min(rowOpCount, Math.max(usedRows - fmtRange.r1 + 1, 1)))}
          onInsertCol={(dir) => sel && insertColAt(dir === 'left' ? fmtRange!.c1 : fmtRange!.c2 + 1, colOpCount)}
          onDeleteCol={() => fmtRange && deleteColAt(fmtRange.c1, Math.min(colOpCount, Math.max(usedCols - fmtRange.c1 + 1, 1)))}
        />
      ) : (
        <div className="sheet-fmtbar csv-note">
          <div className="sheet-fmt-group">
            <button className="sheet-fmt-btn" disabled={!sel || busy} onMouseDown={(e) => e.preventDefault()}
              onClick={() => sel && insertRowAt(fmtRange!.r1, rowOpCount)} title="Chèn dòng lên trên">
              <span aria-hidden>⤒</span> Dòng
            </button>
            <button className="sheet-fmt-btn" disabled={!sel || busy} onMouseDown={(e) => e.preventDefault()}
              onClick={() => sel && insertRowAt(fmtRange!.r2 + 1, rowOpCount)} title="Chèn dòng xuống dưới">
              <span aria-hidden>⤓</span> Dòng
            </button>
            <button className="sheet-fmt-btn danger" disabled={!sel || busy || (sel?.r ?? 0) > usedRows} onMouseDown={(e) => e.preventDefault()}
              onClick={() => fmtRange && deleteRowAt(fmtRange.r1, Math.min(rowOpCount, Math.max(usedRows - fmtRange.r1 + 1, 1)))} title="Xóa dòng">
              <span aria-hidden>✕</span> Dòng
            </button>
            <button className="sheet-fmt-btn" disabled={!sel || busy} onMouseDown={(e) => e.preventDefault()}
              onClick={() => sel && insertColAt(fmtRange!.c1, colOpCount)} title="Chèn cột bên trái">
              <span aria-hidden>⇤</span> Cột
            </button>
            <button className="sheet-fmt-btn" disabled={!sel || busy} onMouseDown={(e) => e.preventDefault()}
              onClick={() => sel && insertColAt(fmtRange!.c2 + 1, colOpCount)} title="Chèn cột bên phải">
              <span aria-hidden>⇥</span> Cột
            </button>
            <button className="sheet-fmt-btn danger" disabled={!sel || busy || (sel?.c ?? 0) > usedCols} onMouseDown={(e) => e.preventDefault()}
              onClick={() => fmtRange && deleteColAt(fmtRange.c1, Math.min(colOpCount, Math.max(usedCols - fmtRange.c1 + 1, 1)))} title="Xóa cột">
              <span aria-hidden>✕</span> Cột
            </button>
          </div>
          <span className="small" style={{ color: 'var(--muted)' }}>
            CSV là văn bản thuần — không có font/màu/định dạng. Mở hoặc tạo file <code>.xlsx</code> để định dạng.
          </span>
        </div>
      )}

      {/* ── Name box + thanh giá trị (kiểu Excel) ── */}
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
        {fmtRange && (rowSpan > 1 || colSpan > 1) && (
          <>
            <span className="sheet-fxbar-sep" aria-hidden />
            <span className="small" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }} title="Mọi thao tác định dạng áp cho cả vùng này">
              Vùng {rangeLabel} · {rowSpan}×{colSpan}
            </span>
          </>
        )}
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
              {Array.from({ length: dispCols }, (_, ci) => {
                const c = ci + 1;
                const inSel = selRange ? c >= selRange.c1 && c <= selRange.c2 : sel?.c === c;
                return (
                  <th
                    key={ci}
                    className={`sheet-colhead${inSel ? ' on' : ''}`}
                    onClick={() => selectWholeCol(c)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!selRange || c < selRange.c1 || c > selRange.c2) selectWholeCol(c);
                      setCtx({ x: e.clientX, y: e.clientY, kind: 'col' });
                    }}
                    title={`Chọn cả cột ${colLetter(ci)} · chuột phải để chèn/xóa cột`}
                  >
                    {colLetter(ci)}
                  </th>
                );
              })}
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
                    className={`sheet-rownum${(selRange ? r >= selRange.r1 && r <= selRange.r2 : sel?.r === r) ? ' sel' : ''}`}
                    onClick={() => selectWholeRow(r)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!selRange || r < selRange.r1 || r > selRange.r2) selectWholeRow(r);
                      setCtx({ x: e.clientX, y: e.clientY, kind: 'row' });
                    }}
                    title={`Chọn cả dòng ${r} · chuột phải để chèn/xóa dòng`}
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
                            setSelKind('cells');
                            gridRef.current?.focus();
                            return;
                          }
                          clearRange();
                          setSel({ r, c });
                          gridRef.current?.focus();
                        }}
                        onDoubleClick={() => { setSel({ r, c }); setEditing({ r, c }); }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          // Chuột phải ngoài vùng đang chọn → chọn ô đó trước, như Excel.
                          const inside = selRange
                            ? r >= selRange.r1 && r <= selRange.r2 && c >= selRange.c1 && c <= selRange.c2
                            : sel?.r === r && sel?.c === c;
                          if (!inside) { clearRange(); setSel({ r, c }); gridRef.current?.focus(); }
                          setCtx({ x: e.clientX, y: e.clientY, kind: 'cell' });
                        }}
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

      {/* Menu chuột phải: chèn/xóa dòng-cột (+ trộn ô khi bấm trong lưới). */}
      {ctx && fmtRange && (
        <>
          <div
            className="sheet-ctx-backdrop"
            onMouseDown={() => setCtx(null)}
            onContextMenu={(e) => { e.preventDefault(); setCtx(null); }}
          />
          <div
            className="sheet-ctx"
            role="menu"
            style={{
              left: Math.min(ctx.x, Math.max(8, window.innerWidth - 248)),
              top: Math.min(ctx.y, Math.max(8, window.innerHeight - 300)),
            }}
          >
            {ctx.kind !== 'col' && (
              <>
                <button onClick={() => { insertRowAt(fmtRange.r1, rowOpCount); setCtx(null); }}>
                  <span aria-hidden>⤒</span> Chèn {rowOpCount > 1 ? `${rowOpCount} dòng` : 'dòng'} lên trên
                </button>
                <button onClick={() => { insertRowAt(fmtRange.r2 + 1, rowOpCount); setCtx(null); }}>
                  <span aria-hidden>⤓</span> Chèn {rowOpCount > 1 ? `${rowOpCount} dòng` : 'dòng'} xuống dưới
                </button>
                <button
                  className="danger"
                  disabled={fmtRange.r1 > usedRows}
                  onClick={() => { deleteRowAt(fmtRange.r1, Math.min(rowOpCount, Math.max(usedRows - fmtRange.r1 + 1, 1))); setCtx(null); }}
                >
                  <span aria-hidden>✕</span> Xóa {rowOpCount > 1 ? `${rowOpCount} dòng` : `dòng ${fmtRange.r1}`}
                </button>
              </>
            )}
            {ctx.kind === 'cell' && <span className="sheet-ctx-sep" aria-hidden />}
            {ctx.kind !== 'row' && (
              <>
                <button onClick={() => { insertColAt(fmtRange.c1, colOpCount); setCtx(null); }}>
                  <span aria-hidden>⇤</span> Chèn {colOpCount > 1 ? `${colOpCount} cột` : 'cột'} bên trái
                </button>
                <button onClick={() => { insertColAt(fmtRange.c2 + 1, colOpCount); setCtx(null); }}>
                  <span aria-hidden>⇥</span> Chèn {colOpCount > 1 ? `${colOpCount} cột` : 'cột'} bên phải
                </button>
                <button
                  className="danger"
                  disabled={fmtRange.c1 > usedCols}
                  onClick={() => { deleteColAt(fmtRange.c1, Math.min(colOpCount, Math.max(usedCols - fmtRange.c1 + 1, 1))); setCtx(null); }}
                >
                  <span aria-hidden>✕</span> Xóa {colOpCount > 1 ? `${colOpCount} cột` : `cột ${colLetter(fmtRange.c1 - 1)}`}
                </button>
              </>
            )}
            {file.kind === 'xlsx' && (
              <>
                <span className="sheet-ctx-sep" aria-hidden />
                <button
                  disabled={!selRange || (selRange.r1 === selRange.r2 && selRange.c1 === selRange.c2)}
                  onClick={() => { doMerge(); setCtx(null); }}
                >
                  <span aria-hidden>⿴</span> Trộn ô &amp; căn giữa
                </button>
                <button
                  disabled={!sheetMerges.some((m) => overlaps(fmtRange, m))}
                  onClick={() => { doUnmerge(); setCtx(null); }}
                >
                  <span aria-hidden>⿲</span> Bỏ trộn ô
                </button>
                <button onClick={() => { applyFormat({ clear: 1 }); setCtx(null); }}>
                  <span aria-hidden>🧹</span> Xóa định dạng
                </button>
              </>
            )}
          </div>
        </>
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
                if (n('style') > 0) parts.push(`${n('style')} lần định dạng`);
                if (n('merge') > 0) parts.push(`${n('merge')} vùng trộn`);
                if (n('unmerge') > 0) parts.push(`${n('unmerge')} vùng bỏ trộn`);
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
