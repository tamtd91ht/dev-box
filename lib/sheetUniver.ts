// Server-only: chuyển workbook ExcelJS (hoặc lưới CSV) sang DỮ LIỆU CỦA UNIVER —
// giao diện bảng tính kiểu Excel (components/sheet/UniverSheet).
//
// Chỉ sinh JSON thuần đúng hình IWorkbookData của Univer. Các hằng enum của Univer
// (căn lề, kiểu viền…) chép lại bên dưới thay vì import: file này chạy ở server,
// không nên kéo cả thư viện giao diện vào.
//
// KHÁC lưới cũ (lib/sheetClient.sheetToWire): KHÔNG cắt ở 5.000 dòng × 256 cột —
// Univer vẽ bằng canvas nên xem được cả file; chỉ chặn ở một trần rất cao để
// JSON gửi về không phình vô hạn.
//
// Phạm vi bước này: giá trị, công thức, kiểu số, font/màu/nền/căn lề/wrap/viền, gộp ô,
// độ rộng cột + chiều cao dòng, ẩn dòng/cột, freeze panes, màu tab, sheet ẩn.
// Chưa mang sang: conditional formatting, data validation, hyperlink, comment, ảnh,
// biểu đồ (Univer có tính năng tương ứng nhưng cần map riêng).

import { promises as fs } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { colWidthToPx, rowHeightToPx } from './sheet';
import { resolveColor, resolveTarget, parseCsv } from './sheetClient';

// ── Hằng chép từ @univerjs/core (enum) ──────────────────────────────────────
const CELL_STRING = 1;
const CELL_NUMBER = 2;
const CELL_BOOLEAN = 3;
const H_ALIGN: Record<string, number> = { left: 1, center: 2, centerContinuous: 2, right: 3, justify: 4, distributed: 6 };
const V_ALIGN: Record<string, number> = { top: 1, middle: 2, center: 2, bottom: 3, justify: 2, distributed: 2 };
const WRAP = 3;
/** ExcelJS tên viền → BorderStyleTypes của Univer. */
const BORDER: Record<string, number> = {
  thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6, slantDashDot: 5, double: 7,
  medium: 8, mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11, thick: 13,
};

/** Trần để JSON gửi về không phình vô hạn (số ô có dữ liệu mỗi workbook). */
export const UNIVER_MAX_CELLS = 2_000_000;
export const UNIVER_MAX_ROWS = 1_048_576;
export const UNIVER_MAX_COLS = 16_384;

// ── Kiểu đầu ra (rút gọn từ IWorkbookData) ──────────────────────────────────

export interface UCell { v?: string | number | boolean; t?: number; f?: string; s?: string }
export interface UStyle { [k: string]: unknown }
export interface USheet {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  defaultColumnWidth: number;
  defaultRowHeight: number;
  cellData: Record<number, Record<number, UCell>>;
  mergeData: { startRow: number; endRow: number; startColumn: number; endColumn: number }[];
  rowData: Record<number, { h?: number; hd?: number }>;
  columnData: Record<number, { w?: number; hd?: number }>;
  freeze?: { xSplit: number; ySplit: number; startRow: number; startColumn: number };
  tabColor?: string;
  hidden?: number;
  showGridlines: number;
}
export interface UWorkbook {
  id: string;
  name: string;
  appVersion: string;
  locale: string;
  styles: Record<string, UStyle>;
  /** Font mặc định của workbook — Excel là Calibri 11 (Univer mặc định Arial). */
  defaultStyle: UStyle;
  sheetOrder: string[];
  sheets: Record<string, USheet>;
}
export interface UniverDoc {
  workbook: UWorkbook;
  /** Số ô có dữ liệu đã chuyển. */
  cells: number;
  /** Đã chạm trần UNIVER_MAX_* nên bỏ bớt phần cuối. */
  truncated: boolean;
}

const rgb = (hex: string) => ({ rgb: hex });
const DEFAULT_STYLE = { ff: 'Calibri', fs: 11 };

// ── Style ───────────────────────────────────────────────────────────────────

function borderSide(b: unknown): { s: number; cl: { rgb: string } } | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const o = b as { style?: string; color?: unknown };
  const s = o.style ? BORDER[o.style] : undefined;
  if (!s) return undefined;
  return { s, cl: rgb(resolveColor(o.color) ?? '#000000') };
}

/** Style hiệu dụng (ô → dòng → cột) → style Univer. Null khi không có gì đáng ship. */
function toUStyle(st: Partial<ExcelJS.Style>, nf: string | undefined): UStyle | null {
  const u: UStyle = {};
  const f = st.font;
  if (f) {
    if (f.bold) u.bl = 1;
    if (f.italic) u.it = 1;
    if (f.underline) u.ul = { s: 1 };
    if (f.strike) u.st = { s: 1 };
    const fc = resolveColor(f.color);
    if (fc && fc !== '#000000') u.cl = rgb(fc);
    if (typeof f.size === 'number' && f.size !== 11) u.fs = f.size;
    if (f.name && f.name !== 'Calibri') u.ff = f.name;
  }
  const fill = st.fill as { type?: string; pattern?: string; fgColor?: unknown } | undefined;
  if (fill?.type === 'pattern' && fill.pattern && fill.pattern !== 'none') {
    const bg = resolveColor(fill.fgColor);
    if (bg && bg !== '#ffffff') u.bg = rgb(bg);
  }
  const al = st.alignment;
  if (al) {
    const ht = al.horizontal ? H_ALIGN[al.horizontal] : undefined;
    if (ht) u.ht = ht;
    const vt = al.vertical ? V_ALIGN[al.vertical] : undefined;
    if (vt && vt !== 3) u.vt = vt; // đáy là mặc định Excel
    if (al.wrapText) u.tb = WRAP;
  }
  const bd = st.border;
  if (bd) {
    const b: Record<string, unknown> = {};
    for (const [k, side] of [['t', bd.top], ['r', bd.right], ['b', bd.bottom], ['l', bd.left]] as const) {
      const v = borderSide(side);
      if (v) b[k] = v;
    }
    if (Object.keys(b).length) u.bd = b;
  }
  if (nf && !/^general$/i.test(nf)) u.n = { pattern: nf };
  return Object.keys(u).length ? u : null;
}

// ── Giá trị ─────────────────────────────────────────────────────────────────

/** Date của ExcelJS (UTC) → số serial của Excel. */
const toSerial = (d: Date): number => d.getTime() / 86_400_000 + 25_569;

const isDateFmt = (nf: string | undefined) => !!nf && /[ymdhs]/i.test(nf.replace(/\[[^\]]*\]|"[^"]*"/g, '')) && !/^general$/i.test(nf);

function plain(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as { richText?: { text?: string }[]; text?: unknown; error?: string; result?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text ?? '').join('');
    if (typeof o.error === 'string') return o.error;
    if (o.text !== undefined) return plain(o.text);
    if (o.result !== undefined) return plain(o.result);
  }
  return String(v);
}

/** Một ô ExcelJS → ô Univer (null = ô trống, bỏ qua). */
function toUCell(cell: ExcelJS.Cell, nf: string | undefined): { c: UCell; forceDateFmt: boolean } | null {
  const raw = cell.value;
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) return { c: { v: toSerial(raw), t: CELL_NUMBER }, forceDateFmt: !isDateFmt(nf) };
  if (typeof raw === 'number') return { c: { v: raw, t: CELL_NUMBER }, forceDateFmt: false };
  if (typeof raw === 'boolean') return { c: { v: raw ? 1 : 0, t: CELL_BOOLEAN }, forceDateFmt: false };
  if (typeof raw === 'string') return { c: { v: raw, t: CELL_STRING }, forceDateFmt: false };
  if (typeof raw === 'object') {
    const o = raw as unknown as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) {
      const src = typeof o.formula === 'string' ? o.formula : (cell.formula ?? '');
      const res = (o as { result?: unknown }).result;
      const c: UCell = { f: `=${src}` };
      // Giá trị cache chỉ để hiện tạm — Univer tính lại công thức khi tải.
      if (typeof res === 'number') { c.v = res; c.t = CELL_NUMBER; }
      else if (res instanceof Date) { c.v = toSerial(res); c.t = CELL_NUMBER; }
      else if (typeof res === 'boolean') { c.v = res ? 1 : 0; c.t = CELL_BOOLEAN; }
      else if (res !== undefined && res !== null) { c.v = plain(res); c.t = CELL_STRING; }
      return { c, forceDateFmt: res instanceof Date && !isDateFmt(nf) };
    }
    // Rich text / hyperlink / lỗi → chữ phẳng.
    const text = plain(raw);
    return text ? { c: { v: text, t: CELL_STRING }, forceDateFmt: false } : null;
  }
  return { c: { v: String(raw), t: CELL_STRING }, forceDateFmt: false };
}

function decodeAddr(addr: string): { r: number; c: number } | null {
  const m = addr.match(/^\$?([A-Z]+)\$?(\d+)$/i);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]), c };
}

// ── Worksheet ───────────────────────────────────────────────────────────────

interface Ctx { styles: Record<string, UStyle>; styleIdx: Map<string, string>; cells: number; truncated: boolean }

function styleId(ctx: Ctx, u: UStyle): string {
  const key = JSON.stringify(u);
  let id = ctx.styleIdx.get(key);
  if (!id) {
    id = `s${ctx.styleIdx.size + 1}`;
    ctx.styleIdx.set(key, id);
    ctx.styles[id] = u;
  }
  return id;
}

function sheetToUniver(ws: ExcelJS.Worksheet, index: number, ctx: Ctx): USheet {
  const totalRows = Math.min(ws.rowCount ?? 0, UNIVER_MAX_ROWS);
  const totalCols = Math.min(ws.columnCount ?? 0, UNIVER_MAX_COLS);
  if ((ws.rowCount ?? 0) > UNIVER_MAX_ROWS || (ws.columnCount ?? 0) > UNIVER_MAX_COLS) ctx.truncated = true;

  const columnData: USheet['columnData'] = {};
  const colStyles: (Partial<ExcelJS.Style> | undefined)[] = [];
  for (let c = 1; c <= totalCols; c++) {
    const col = ws.getColumn(c);
    colStyles[c] = col?.style;
    const d: { w?: number; hd?: number } = {};
    if (typeof col?.width === 'number') d.w = colWidthToPx(col.width);
    if (col?.hidden) d.hd = 1;
    if (d.w !== undefined || d.hd) columnData[c - 1] = d;
  }

  const rowData: USheet['rowData'] = {};
  const cellData: USheet['cellData'] = {};

  // eachRow chỉ đi qua dòng CÓ dữ liệu/style — file nghìn dòng trống không tốn công.
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (r > totalRows || ctx.truncated) return;
    const rd: { h?: number; hd?: number } = {};
    if (typeof row.height === 'number') rd.h = rowHeightToPx(row.height);
    if (row.hidden) rd.hd = 1;
    if (rd.h !== undefined || rd.hd) rowData[r - 1] = rd;
    const rowStyle = (row as unknown as { style?: Partial<ExcelJS.Style> }).style;
    const out: Record<number, UCell> = {};
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      if (c > totalCols) return;
      const cs = cell.style;
      const eff: Partial<ExcelJS.Style> = {
        font: cs?.font ?? rowStyle?.font ?? colStyles[c]?.font,
        fill: cs?.fill ?? rowStyle?.fill ?? colStyles[c]?.fill,
        border: cs?.border ?? rowStyle?.border ?? colStyles[c]?.border,
        alignment: cs?.alignment ?? rowStyle?.alignment ?? colStyles[c]?.alignment,
      };
      const nf = cs?.numFmt ?? rowStyle?.numFmt ?? colStyles[c]?.numFmt;
      const conv = toUCell(cell, nf);
      let u = toUStyle(eff, nf);
      // Ngày mà ô không có định dạng ngày: không thêm thì Univer hiện số serial khó hiểu.
      if (conv?.forceDateFmt) u = { ...(u ?? {}), n: { pattern: 'yyyy-mm-dd' } };
      if (!conv && !u) return;
      const cd: UCell = conv?.c ?? {};
      if (u) cd.s = styleId(ctx, u);
      out[c - 1] = cd;
      if (conv) ctx.cells++;
    });
    if (Object.keys(out).length) cellData[r - 1] = out;
    if (ctx.cells > UNIVER_MAX_CELLS) ctx.truncated = true;
  });

  const mergeData: USheet['mergeData'] = [];
  for (const m of (ws.model as { merges?: string[] }).merges ?? []) {
    const [a, b] = String(m).split(':');
    const p1 = decodeAddr(a ?? '');
    const p2 = decodeAddr(b ?? '');
    if (!p1 || !p2) continue;
    const startRow = Math.min(p1.r, p2.r) - 1; const endRow = Math.max(p1.r, p2.r) - 1;
    const startColumn = Math.min(p1.c, p2.c) - 1; const endColumn = Math.max(p1.c, p2.c) - 1;
    if (startRow === endRow && startColumn === endColumn) continue;
    mergeData.push({ startRow, endRow, startColumn, endColumn });
  }

  const sheet: USheet = {
    id: `sheet-${index + 1}`,
    name: ws.name,
    // Đệm sẵn ô trống quanh dữ liệu như Excel — gõ tiếp ngay được mà không phải thêm dòng.
    rowCount: Math.max(totalRows + 100, 200),
    columnCount: Math.max(totalCols + 10, 26),
    defaultColumnWidth: 64,
    defaultRowHeight: 20,
    cellData,
    mergeData,
    rowData,
    columnData,
    showGridlines: ws.views?.[0]?.showGridLines === false ? 0 : 1,
  };

  // Freeze panes: ExcelJS lưu ở views[0] {state:'frozen', xSplit (cột), ySplit (dòng)}.
  const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
  if (view?.state === 'frozen' && (view.xSplit || view.ySplit)) {
    const xSplit = view.xSplit ?? 0;
    const ySplit = view.ySplit ?? 0;
    sheet.freeze = { xSplit, ySplit, startRow: ySplit, startColumn: xSplit };
  }
  const tab = resolveColor((ws.properties as { tabColor?: unknown } | undefined)?.tabColor);
  if (tab) sheet.tabColor = tab;
  if (ws.state === 'hidden' || ws.state === 'veryHidden') sheet.hidden = 1;
  return sheet;
}

function emptyWorkbook(name: string): UWorkbook {
  return { id: 'wb', name, appVersion: '1.0.0', locale: 'viVN', styles: {}, defaultStyle: DEFAULT_STYLE, sheetOrder: [], sheets: {} };
}

/** Workbook ExcelJS → dữ liệu Univer. */
export function workbookToUniver(wb: ExcelJS.Workbook, name: string): UniverDoc {
  const ctx: Ctx = { styles: {}, styleIdx: new Map(), cells: 0, truncated: false };
  const out = emptyWorkbook(name);
  wb.worksheets.forEach((ws, i) => {
    const s = sheetToUniver(ws, i, ctx);
    out.sheets[s.id] = s;
    out.sheetOrder.push(s.id);
  });
  out.styles = ctx.styles;
  return { workbook: out, cells: ctx.cells, truncated: ctx.truncated };
}

/** Lưới CSV (chuỗi) → dữ liệu Univer. Số "an toàn" thành số, còn lại giữ chuỗi (không làm mất số 0 đầu của mã). */
export function csvToUniver(grid: string[][], name: string): UniverDoc {
  const out = emptyWorkbook(name);
  const cellData: USheet['cellData'] = {};
  let cols = 0;
  let cells = 0;
  const truncated = grid.length > UNIVER_MAX_ROWS;
  const rows = truncated ? grid.slice(0, UNIVER_MAX_ROWS) : grid;
  rows.forEach((row, r) => {
    const o: Record<number, UCell> = {};
    row.forEach((v, c) => {
      if (v === '') return;
      cols = Math.max(cols, c + 1);
      // Số thường (không 0 đầu, không quá 15 chữ số) mới đổi thành số — mã/số điện thoại giữ nguyên chuỗi.
      const isNum = /^-?(0|[1-9]\d*)(\.\d+)?$/.test(v) && v.replace(/[-.]/g, '').length <= 15;
      o[c] = isNum ? { v: Number(v), t: CELL_NUMBER } : { v, t: CELL_STRING };
      cells++;
    });
    if (Object.keys(o).length) cellData[r] = o;
  });
  const sheet: USheet = {
    id: 'sheet-1', name: 'CSV',
    rowCount: Math.max(rows.length + 100, 200), columnCount: Math.max(cols + 10, 26),
    defaultColumnWidth: 64, defaultRowHeight: 20,
    cellData, mergeData: [], rowData: {}, columnData: {}, showGridlines: 1,
  };
  out.sheets[sheet.id] = sheet;
  out.sheetOrder.push(sheet.id);
  return { workbook: out, cells, truncated };
}

// ── Mở file ─────────────────────────────────────────────────────────────────

export interface UniverOpenResult extends UniverDoc {
  path: string;
  kind: 'xlsx' | 'csv';
  sizeBytes: number;
  mtimeMs: number;
  /** Chỉ CSV: để lần lưu sau (khi có) ghi lại đúng dấu phân cách / BOM / xuống dòng. */
  csv?: { delimiter: string; hasBom: boolean; newline: '\r\n' | '\n' };
}

/** Mở .xlsx/.csv (cùng kiểm tra đường dẫn + trần dung lượng như `open`) → dữ liệu Univer. */
export async function openUniverFile(rawPath: unknown): Promise<UniverOpenResult> {
  const t = await resolveTarget(rawPath);
  const name = path.basename(t.abs);
  const head = { path: t.abs, sizeBytes: t.sizeBytes, mtimeMs: t.mtimeMs };

  if (t.kind === 'csv') {
    const doc = parseCsv(await fs.readFile(t.abs));
    return { ...head, kind: 'csv', ...csvToUniver(doc.grid, name), csv: { delimiter: doc.delimiter, hasBom: doc.hasBom, newline: doc.newline } };
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(t.abs);
  } catch (e) {
    throw new Error(`Không parse được file Excel: ${(e as Error).message}`);
  }
  if (wb.worksheets.length === 0) throw new Error('File không có worksheet nào.');
  return { ...head, kind: 'xlsx', ...workbookToUniver(wb, name) };
}
