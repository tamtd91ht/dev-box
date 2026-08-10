// Server-only engine for the Sheet workspace (Excel/CSV viewer-editor).
//
// Safety model (mirrors the other tools):
//   1. Whole tool behind SHEET_TOOL_ENABLED (route returns 403 when off).
//   2. `save` — the ONLY write — additionally requires SHEET_ALLOW_WRITE, plus
//      a confirm modal in the UI. Every save is audit-logged (SHEET_AUDIT).
//   3. Paths are path.resolve()'d, extension-whitelisted (.xlsx/.csv — .xlsm is
//      refused because ExcelJS drops VBA), stat'ed as a real file, size-capped.
//   4. Save is READ-MODIFY-WRITE with an op log: the file is re-read fresh and
//      the client's ops (set cell / insert-delete row-col / định dạng vùng /
//      trộn-bỏ trộn ô / độ rộng cột - chiều cao dòng) are replayed in
//      order. Untouched cells keep styles/widths/merges/formulas — sending the
//      whole grid back instead would flatten every formula to its value.
//      Known ExcelJS limits: charts/pivots/slicers may not round-trip.
//   5. Overwrite is atomic-ish: write temp file in the same dir → copy the
//      original to `<file>.bak` → rename temp over the original.
//   6. Stale check: the client sends the mtime it opened; a mismatch refuses
//      the save (the file changed underneath — reload first).

import { promises as fs } from 'fs';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import type { BorderPreset, CellType, SheetOp, SheetOpenResult, SheetSaveResult, StylePatch, WireCell, WireMerge, WireSheet, WireStyle } from './sheet';
import {
  borderEdges,
  colWidthToPx,
  pxToColWidth,
  rowHeightToPx,
  pxToRowHeight,
  MIN_COL_PX,
  MAX_COL_PX,
  MIN_ROW_PX,
  MAX_ROW_PX,
} from './sheet';
import { formatNumFmt, isDateFmt } from './numFmt';
import { OFFICE_ALLOW_WRITE } from './officeFlags';
import {
  MAX_FILE_BYTES,
  resolveOfficeFile,
  resolveNewOfficeFile,
  writeNewFile,
  assertNotStale,
  atomicBackupWrite,
  type OfficeTarget,
} from './officeFiles';

// Gates are shared across the whole Office tab (Sheet + Word).
export { OFFICE_ENABLED as SHEET_ENABLED, OFFICE_ALLOW_WRITE as SHEET_ALLOW_WRITE } from './officeFlags';
export { MAX_FILE_BYTES };

export const MAX_ROWS = 5000; // per sheet, view window (file may hold more)
export const MAX_COLS = 256;

// ── Path validation ──────────────────────────────────────────────────────────

interface ResolvedTarget extends OfficeTarget {
  kind: 'xlsx' | 'csv';
}

async function resolveTarget(raw: unknown): Promise<ResolvedTarget> {
  const t = await resolveOfficeFile(raw, ['.xlsx', '.csv'], {
    '.xlsm': '.xlsm (file có macro) không được hỗ trợ — lưu qua ExcelJS sẽ mất VBA. Hãy Save As .xlsx trước.',
  });
  return { ...t, kind: t.ext === '.csv' ? 'csv' : 'xlsx' };
}

// ── xlsx → wire ──────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ExcelJS reads date serials as UTC-based Dates — format with UTC getters so
 *  the displayed value matches what Excel shows (no local-TZ shift). */
function fmtDate(d: Date): string {
  const date = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0;
  return hasTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : date;
}

/** Flatten a formula RESULT (or any plain value) to display text. */
function plainText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('error' in o) return String(o.error);
    if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if ('text' in o) return String(o.text ?? '');
    return JSON.stringify(v);
  }
  return String(v);
}

// ── Styles: màu / border / font → CSS-ready wire ────────────────────────────

/** Bảng theme màu Office mặc định (index như trong xlsx <clrScheme>). */
const THEME_COLORS = [
  'FFFFFF', '000000', 'E7E6E6', '44546A', // lt1 dk1 lt2 dk2
  '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', // accent1-6
];

/** Palette indexed legacy (đủ dải 0-63 hay gặp trong file cũ). */
const INDEXED_COLORS = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

/** Tint của theme color: >0 sáng dần về trắng, <0 tối dần về đen. */
function applyTint(hex: string, tint: number): string {
  const ch = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  const mix = (c: number) => {
    const v = tint > 0 ? c + (255 - c) * tint : c * (1 + tint);
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  return [ch(0), ch(2), ch(4)].map((c) => mix(c).toString(16).padStart(2, '0')).join('');
}

/** ExcelJS color ({argb} | {theme,tint} | {indexed}) → CSS #rrggbb. */
function resolveColor(c: unknown): string | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const o = c as { argb?: string; theme?: number; tint?: number; indexed?: number };
  if (typeof o.argb === 'string' && o.argb.length >= 6) {
    const rgb = o.argb.slice(-6);
    // Alpha 00 = "no color" (auto).
    if (o.argb.length === 8 && o.argb.slice(0, 2) === '00') return undefined;
    return `#${rgb.toLowerCase()}`;
  }
  if (typeof o.theme === 'number') {
    const base = THEME_COLORS[o.theme];
    if (!base) return undefined;
    const rgb = typeof o.tint === 'number' && o.tint !== 0 ? applyTint(base, o.tint) : base;
    return `#${rgb.toLowerCase()}`;
  }
  if (typeof o.indexed === 'number') {
    const rgb = INDEXED_COLORS[o.indexed];
    return rgb ? `#${rgb.toLowerCase()}` : undefined;
  }
  return undefined;
}

const BORDER_CSS: Record<string, string> = {
  hair: '1px solid', thin: '1px solid', dotted: '1px dotted', dashed: '1px dashed',
  dashDot: '1px dashed', dashDotDot: '1px dotted', slantDashDot: '1px dashed',
  medium: '2px solid', mediumDashed: '2px dashed', mediumDashDot: '2px dashed',
  mediumDashDotDot: '2px dotted', thick: '3px solid', double: '3px double',
};

function borderCss(b: unknown): string | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const o = b as { style?: string; color?: unknown };
  const base = o.style ? BORDER_CSS[o.style] : undefined;
  if (!base) return undefined;
  return `${base} ${resolveColor(o.color) ?? '#666666'}`;
}

const H_ALIGN: Record<string, WireStyle['ha']> = {
  left: 'l', center: 'c', centerContinuous: 'c', right: 'r', justify: 'j', distributed: 'j',
};
const V_ALIGN: Record<string, WireStyle['va']> = {
  top: 't', middle: 'm', center: 'm', bottom: 'b', justify: 'm', distributed: 'm',
};

/** Style hiệu dụng của ExcelJS → WireStyle. Trả null khi không có gì đáng ship. */
function styleWire(st: Partial<ExcelJS.Style>, nf: string | undefined): WireStyle | null {
  const w: WireStyle = {};
  const f = st.font;
  if (f) {
    if (f.bold) w.b = 1;
    if (f.italic) w.i = 1;
    if (f.underline) w.u = 1;
    if (f.strike) w.st = 1;
    const fc = resolveColor(f.color);
    if (fc) w.fc = fc;
    if (typeof f.size === 'number' && f.size !== 11) w.fs = f.size;
    if (f.name && f.name !== 'Calibri') w.ff = f.name;
  }
  const fill = st.fill as { type?: string; pattern?: string; fgColor?: unknown } | undefined;
  if (fill?.type === 'pattern' && fill.pattern && fill.pattern !== 'none') {
    const bg = resolveColor(fill.fgColor);
    if (bg && bg !== '#ffffff') w.bg = bg;
  }
  const al = st.alignment;
  if (al) {
    const ha = al.horizontal ? H_ALIGN[al.horizontal] : undefined;
    if (ha) w.ha = ha;
    const va = al.vertical ? V_ALIGN[al.vertical] : undefined;
    if (va && va !== 'b') w.va = va; // bottom là mặc định Excel
    if (al.wrapText) w.wr = 1;
    if (typeof al.indent === 'number' && al.indent > 0) w.in = al.indent;
  }
  const bd = st.border;
  if (bd) {
    const bt = borderCss(bd.top); if (bt) w.bt = bt;
    const br = borderCss(bd.right); if (br) w.br = br;
    const bb = borderCss(bd.bottom); if (bb) w.bb = bb;
    const bl = borderCss(bd.left); if (bl) w.bl = bl;
  }
  if (nf && !/^general$/i.test(nf)) w.nf = nf;
  // Chữ đen là MẶC ĐỊNH của Excel — không ship khi ô không có nền màu, để
  // dark theme của app vẫn tự chọn màu chữ đọc được.
  if (w.fc === '#000000' && !w.bg) delete w.fc;
  return Object.keys(w).length > 0 ? w : null;
}

/** Cell value → wire, ÁP numFmt cho hiển thị (v) và giữ raw để sửa. */
function toWire(cell: ExcelJS.Cell, nf: string | undefined): WireCell {
  const raw = cell.value;
  if (raw === null || raw === undefined) return { v: '', t: 's' };
  if (raw instanceof Date) {
    const plain = fmtDate(raw);
    if (nf && isDateFmt(nf)) {
      const d = formatNumFmt(raw, nf);
      return { v: d.text, t: 'd', ...(d.text !== plain ? { raw: plain } : {}), ...(d.color ? { nc: d.color } : {}) };
    }
    return { v: plain, t: 'd' };
  }
  if (typeof raw === 'number') {
    if (nf) {
      const d = formatNumFmt(raw, nf);
      return { v: d.text, t: 'n', ...(d.text !== String(raw) ? { raw: String(raw) } : {}), ...(d.color ? { nc: d.color } : {}) };
    }
    return { v: String(raw), t: 'n' };
  }
  if (typeof raw === 'boolean') return { v: raw ? 'TRUE' : 'FALSE', t: 'b' };
  if (typeof raw === 'string') return { v: raw, t: 's' };
  if (typeof raw === 'object') {
    const o = raw as unknown as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) {
      const f = typeof o.formula === 'string' ? o.formula : (cell.formula ?? '');
      const res = (o as { result?: unknown }).result;
      // Kết quả cache là số/ngày → cũng áp numFmt như ô thường (SUM ra "1,234").
      if (nf && (typeof res === 'number' || res instanceof Date)) {
        const d = formatNumFmt(res, nf);
        return { v: d.text, t: 'f', f: String(f), ...(d.color ? { nc: d.color } : {}) };
      }
      return { v: plainText(res), t: 'f', f: String(f) };
    }
    // Rich text / hyperlink / error → flattened text; editing turns it into plain text.
    return { v: plainText(raw), t: 'x' };
  }
  return { v: String(raw), t: 'x' };
}

/** "BC12" → {r:12, c:55} (1-based). */
function decodeAddr(addr: string): { r: number; c: number } | null {
  const m = addr.match(/^\$?([A-Z]+)\$?(\d+)$/i);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]), c };
}

function sheetToWire(ws: ExcelJS.Worksheet): WireSheet {
  // rowCount/columnCount are the POSITIONS of the last used row/column — keep
  // gaps intact (actualRowCount would compact sheets that start lower down).
  const totalRows = ws.rowCount ?? 0;
  const totalCols = ws.columnCount ?? 0;
  const rc = Math.min(totalRows, MAX_ROWS);
  const cc = Math.min(totalCols, MAX_COLS);

  // Style cột (fallback khi ô/dòng không có style riêng) + độ rộng + ẩn.
  const colStyles: (Partial<ExcelJS.Style> | undefined)[] = [];
  const colW: (number | null)[] = [];
  const hiddenCols: number[] = [];
  for (let c = 1; c <= cc; c++) {
    const col = ws.getColumn(c);
    colStyles[c] = col?.style;
    // Excel width tính theo ký tự font mặc định — quy ra px (xem lib/sheet.ts).
    colW.push(typeof col?.width === 'number' ? colWidthToPx(col.width) : null);
    if (col?.hidden) hiddenCols.push(c);
  }

  const styles: WireStyle[] = [];
  const styleIdx = new Map<string, number>();
  const rows: WireCell[][] = [];
  const rowH: (number | null)[] = [];
  const hiddenRows: number[] = [];

  for (let r = 1; r <= rc; r++) {
    const row = ws.getRow(r);
    rowH.push(typeof row.height === 'number' ? rowHeightToPx(row.height) : null);
    if (row.hidden) hiddenRows.push(r);
    // ExcelJS Row có .style ở runtime nhưng typings không khai — cast hẹp.
    const rowStyle = (row as unknown as { style?: Partial<ExcelJS.Style> }).style;
    const cells: WireCell[] = [];
    for (let c = 1; c <= cc; c++) {
      const cell = row.getCell(c);
      const cs = cell.style;
      // Ưu tiên: ô → dòng → cột (mỗi thuộc tính top-level).
      const eff: Partial<ExcelJS.Style> = {
        font: cs?.font ?? rowStyle?.font ?? colStyles[c]?.font,
        fill: cs?.fill ?? rowStyle?.fill ?? colStyles[c]?.fill,
        border: cs?.border ?? rowStyle?.border ?? colStyles[c]?.border,
        alignment: cs?.alignment ?? rowStyle?.alignment ?? colStyles[c]?.alignment,
      };
      const nf = cs?.numFmt ?? rowStyle?.numFmt ?? colStyles[c]?.numFmt;
      const wire = toWire(cell, nf);
      const sw = styleWire(eff, nf);
      if (sw) {
        const key = JSON.stringify(sw);
        let idx = styleIdx.get(key);
        if (idx === undefined) {
          idx = styles.length;
          styles.push(sw);
          styleIdx.set(key, idx);
        }
        wire.s = idx;
      }
      cells.push(wire);
    }
    rows.push(cells);
  }

  // Merge ranges — clamp vào cửa sổ hiển thị, bỏ vùng 1×1.
  const merges: WireMerge[] = [];
  const rawMerges = (ws.model as { merges?: string[] }).merges ?? [];
  for (const m of rawMerges) {
    const [a, b] = String(m).split(':');
    const p1 = decodeAddr(a ?? '');
    const p2 = decodeAddr(b ?? '');
    if (!p1 || !p2) continue;
    const r1 = Math.min(p1.r, p2.r); const r2 = Math.min(Math.max(p1.r, p2.r), rc);
    const c1 = Math.min(p1.c, p2.c); const c2 = Math.min(Math.max(p1.c, p2.c), cc);
    if (r1 > rc || c1 > cc || (r1 === r2 && c1 === c2)) continue;
    merges.push({ r1, c1, r2, c2 });
  }

  return {
    name: ws.name,
    rows,
    rowCount: totalRows,
    colCount: totalCols,
    truncated: totalRows > MAX_ROWS || totalCols > MAX_COLS,
    ...(styles.length > 0 ? { styles } : {}),
    ...(merges.length > 0 ? { merges } : {}),
    colW,
    rowH,
    ...(hiddenRows.length > 0 ? { hiddenRows } : {}),
    ...(hiddenCols.length > 0 ? { hiddenCols } : {}),
  };
}

// ── CSV encode/decode ────────────────────────────────────────────────────────

interface CsvDoc {
  grid: string[][];
  delimiter: string;
  newline: '\r\n' | '\n';
  hasBom: boolean;
  encoding: 'utf8' | 'utf16le';
  endsWithNewline: boolean;
}

function decodeCsvBuffer(buf: Buffer): { text: string; hasBom: boolean; encoding: 'utf8' | 'utf16le' } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), hasBom: true, encoding: 'utf16le' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    // The classic Vietnamese-Excel export: UTF-8 with BOM.
    return { text: buf.subarray(3).toString('utf8'), hasBom: true, encoding: 'utf8' };
  }
  return { text: buf.toString('utf8'), hasBom: false, encoding: 'utf8' };
}

function parseCsv(buf: Buffer): CsvDoc {
  const { text, hasBom, encoding } = decodeCsvBuffer(buf);
  const parsed = Papa.parse<string[]>(text, { delimiter: '' /* auto-detect */ });
  const grid = parsed.data;
  // A trailing newline makes Papa emit one final [''] row — an artifact, not data.
  const endsWithNewline = /\r?\n$/.test(text);
  if (endsWithNewline && grid.length > 0) {
    const last = grid[grid.length - 1];
    if (last.length === 0 || (last.length === 1 && last[0] === '')) grid.pop();
  }
  const newline: '\r\n' | '\n' = parsed.meta.linebreak === '\r\n' ? '\r\n' : '\n';
  return { grid, delimiter: parsed.meta.delimiter || ',', newline, hasBom, encoding, endsWithNewline };
}

function encodeCsv(doc: CsvDoc): Buffer {
  let text = Papa.unparse(doc.grid, { delimiter: doc.delimiter, newline: doc.newline });
  if (doc.endsWithNewline) text += doc.newline;
  if (doc.encoding === 'utf16le') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  }
  const body = Buffer.from(text, 'utf8');
  return doc.hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

// ── open ─────────────────────────────────────────────────────────────────────

export async function openFile(rawPath: unknown): Promise<SheetOpenResult> {
  const t = await resolveTarget(rawPath);

  if (t.kind === 'csv') {
    const doc = parseCsv(await fs.readFile(t.abs));
    const totalRows = doc.grid.length;
    const totalCols = doc.grid.reduce((m, r) => Math.max(m, r.length), 0);
    const rc = Math.min(totalRows, MAX_ROWS);
    const cc = Math.min(totalCols, MAX_COLS);
    const rows: WireCell[][] = [];
    for (let r = 0; r < rc; r++) {
      const src = doc.grid[r];
      const cells: WireCell[] = [];
      // No type guessing on CSV — everything is text, edit fidelity beats cleverness.
      for (let c = 0; c < cc; c++) cells.push({ v: src[c] ?? '', t: 's' as CellType });
      rows.push(cells);
    }
    return {
      path: t.abs,
      kind: 'csv',
      sizeBytes: t.sizeBytes,
      mtimeMs: t.mtimeMs,
      sheets: [{
        name: 'CSV',
        rows,
        rowCount: totalRows,
        colCount: totalCols,
        truncated: totalRows > MAX_ROWS || totalCols > MAX_COLS,
      }],
      csv: { delimiter: doc.delimiter, hasBom: doc.hasBom, newline: doc.newline },
    };
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(t.abs);
  } catch (e) {
    throw new Error(`Không parse được file Excel: ${(e as Error).message}`);
  }
  const sheets = wb.worksheets.map(sheetToWire);
  if (sheets.length === 0) throw new Error('File không có worksheet nào.');
  return { path: t.abs, kind: 'xlsx', sizeBytes: t.sizeBytes, mtimeMs: t.mtimeMs, sheets };
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateSheetInput {
  dir: unknown;
  name: unknown;
}

/** Create a NEW empty .xlsx (one blank "Sheet1") or .csv (0 bytes), then open
 *  it. Never overwrites — an existing file refuses the create. Gated by
 *  OFFICE_ALLOW_WRITE like every other write in the tab. */
export async function createFile(input: CreateSheetInput): Promise<SheetOpenResult> {
  if (!OFFICE_ALLOW_WRITE) {
    throw new Error('Ghi file đang tắt cho toàn tool. Set OFFICE_ALLOW_WRITE=true trong .env.local (local dev only).');
  }
  const { abs, ext } = await resolveNewOfficeFile(input.dir, input.name, ['.xlsx', '.csv']);

  let buf: Buffer;
  if (ext === '.csv') {
    buf = Buffer.alloc(0);
  } else {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1');
    buf = Buffer.from(await wb.xlsx.writeBuffer());
  }
  await writeNewFile(abs, buf);

  // eslint-disable-next-line no-console
  console.log(`SHEET_AUDIT operation=CREATE path=${abs} ts=${new Date().toISOString()}`);
  return openFile(abs);
}

// ── save ─────────────────────────────────────────────────────────────────────

/** '' → clear · "=…" → CÔNG THỨC Excel thật · canonical numbers → number ·
 *  true/false → boolean · else text.
 *  "012"/"1.10" stay TEXT on purpose (leading/trailing zeros carry meaning). */
function parseInput(s: string): string | number | boolean | null | { formula: string } {
  if (s === '') return null;
  // Không ghi kèm result — fullCalcOnLoad (set lúc save) bắt Excel tự tính lại.
  if (s.startsWith('=') && s.trim().length > 1) return { formula: s.slice(1).trim() };
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) && String(Number(s)) === s) return Number(s);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  return s;
}

// ── Style ops: validate + áp lên ExcelJS ────────────────────────────────────

const MAX_STYLE_CELLS = 200_000; // trần một op định dạng (chống vùng khổng lồ)

const HEX = /^#[0-9a-fA-F]{6}$/;
const BORDER_PRESETS: BorderPreset[] = ['all', 'outer', 'none', 'top', 'bottom', 'left', 'right'];

/** Vùng 1-based inclusive từ payload thô. */
function sanitizeRange(op: Record<string, unknown>): { r1: number; c1: number; r2: number; c2: number } {
  const [r1, c1, r2, c2] = (['r1', 'c1', 'r2', 'c2'] as const).map((k) => Number(op[k]));
  const ok = [r1, c1, r2, c2].every((n) => Number.isInteger(n) && n >= 1);
  if (!ok || r1 > r2 || c1 > c2 || r2 > 1_048_576 || c2 > 16_384) {
    throw new Error(`op ${String(op.op)} có vùng không hợp lệ: ${r1},${c1},${r2},${c2}`);
  }
  if ((r2 - r1 + 1) * (c2 - c1 + 1) > MAX_STYLE_CELLS) {
    throw new Error(`Vùng quá lớn (> ${MAX_STYLE_CELLS.toLocaleString('vi')} ô) cho một thao tác định dạng.`);
  }
  return { r1, c1, r2, c2 };
}

/** Chỉ nhận đúng các field/kiểu đã khai trong StylePatch (null = xóa). */
function sanitizePatch(raw: unknown): StylePatch {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: StylePatch = {};
  if (o.clear) return { clear: 1 };
  for (const k of ['b', 'i', 'u', 'st', 'wr'] as const) {
    if (o[k] === null) out[k] = null;
    else if (o[k] !== undefined) out[k] = 1;
  }
  for (const k of ['fc', 'bg'] as const) {
    if (o[k] === null) out[k] = null;
    else if (typeof o[k] === 'string') {
      if (!HEX.test(o[k] as string)) throw new Error(`Màu không hợp lệ: ${String(o[k])}`);
      out[k] = (o[k] as string).toLowerCase();
    }
  }
  if (o.fs === null) out.fs = null;
  else if (o.fs !== undefined) {
    const n = Number(o.fs);
    if (!Number.isFinite(n) || n < 1 || n > 409) throw new Error(`Cỡ chữ không hợp lệ: ${String(o.fs)}`);
    out.fs = Math.round(n * 2) / 2; // Excel cho phép nửa point
  }
  if (o.ff === null) out.ff = null;
  else if (typeof o.ff === 'string' && o.ff.trim()) out.ff = o.ff.trim().slice(0, 64);
  if (o.ha === null) out.ha = null;
  else if (typeof o.ha === 'string' && 'lcrj'.includes(o.ha)) out.ha = o.ha as StylePatch['ha'];
  if (o.va === null) out.va = null;
  else if (typeof o.va === 'string' && 'tmb'.includes(o.va)) out.va = o.va as StylePatch['va'];
  if (o.nf === null) out.nf = null;
  else if (typeof o.nf === 'string' && o.nf.trim()) out.nf = o.nf.slice(0, 200);
  if (typeof o.bd === 'string' && BORDER_PRESETS.includes(o.bd as BorderPreset)) out.bd = o.bd as BorderPreset;
  return out;
}

/** '#rrggbb' → 'FFRRGGBB' (ARGB của xlsx). */
function toArgb(css: string): string {
  return `FF${css.slice(1).toUpperCase()}`;
}

const H_ALIGN_X = { l: 'left', c: 'center', r: 'right', j: 'justify' } as const;
const V_ALIGN_X = { t: 'top', m: 'middle', b: 'bottom' } as const;
/** Viền mảnh xám — khớp BORDER_THIN mà client vẽ. */
const BORDER_XL = { style: 'thin', color: { argb: 'FF9CA3AF' } } as const;

/**
 * Áp một op định dạng lên vùng ô.
 *
 * QUAN TRỌNG: ExcelJS chia sẻ CHUNG object style (và cả font/fill/border bên
 * trong) giữa mọi ô có cùng xf khi đọc file — mutate tại chỗ (cell.font.bold =
 * true) sẽ đổi luôn định dạng của các ô khác. Nên ở đây luôn clone rồi GÁN LẠI
 * cell.style bằng object mới.
 */
function applyStyleOp(ws: ExcelJS.Worksheet, op: Extract<SheetOp, { op: 'style' }>): void {
  const p = op.st;
  for (let r = op.r1; r <= op.r2; r++) {
    const row = ws.getRow(r);
    for (let c = op.c1; c <= op.c2; c++) {
      const cell = row.getCell(c);
      if (p.clear) {
        cell.style = {} as ExcelJS.Style;
        continue;
      }
      const cur = (cell.style ?? {}) as Partial<ExcelJS.Style>;
      const next: Partial<ExcelJS.Style> = { ...cur };

      if (p.b !== undefined || p.i !== undefined || p.u !== undefined || p.st !== undefined
        || p.fc !== undefined || p.fs !== undefined || p.ff !== undefined) {
        const f: Record<string, unknown> = { ...(cur.font ?? {}) };
        const flag = (key: string, v: 1 | null | undefined) => {
          if (v === undefined) return;
          if (v === null) delete f[key]; else f[key] = true;
        };
        flag('bold', p.b); flag('italic', p.i); flag('underline', p.u); flag('strike', p.st);
        if (p.fc !== undefined) { if (p.fc === null) delete f.color; else f.color = { argb: toArgb(p.fc) }; }
        if (p.fs !== undefined) { if (p.fs === null) delete f.size; else f.size = p.fs; }
        if (p.ff !== undefined) { if (p.ff === null) delete f.name; else f.name = p.ff; }
        // Typings của ExcelJS đòi Font/Alignment/Borders đủ field, runtime nhận
        // partial (chỉ những gì có mặt được ghi ra xlsx).
        if (Object.keys(f).length > 0) next.font = f as unknown as ExcelJS.Font; else delete next.font;
      }

      if (p.bg !== undefined) {
        if (p.bg === null) delete next.fill;
        else next.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: toArgb(p.bg) } } as ExcelJS.Fill;
      }

      if (p.ha !== undefined || p.va !== undefined || p.wr !== undefined) {
        const a: Record<string, unknown> = { ...(cur.alignment ?? {}) };
        if (p.ha !== undefined) { if (p.ha === null) delete a.horizontal; else a.horizontal = H_ALIGN_X[p.ha]; }
        if (p.va !== undefined) { if (p.va === null) delete a.vertical; else a.vertical = V_ALIGN_X[p.va]; }
        if (p.wr !== undefined) { if (p.wr === null) delete a.wrapText; else a.wrapText = true; }
        if (Object.keys(a).length > 0) next.alignment = a as unknown as ExcelJS.Alignment; else delete next.alignment;
      }

      if (p.bd) {
        const e = borderEdges(p.bd, { t: r === op.r1, b: r === op.r2, l: c === op.c1, r: c === op.c2 });
        const bd: Record<string, unknown> = { ...(cur.border ?? {}) };
        const side = (key: 'top' | 'right' | 'bottom' | 'left', v: string | null | undefined) => {
          if (v === undefined) return;
          if (v === null) delete bd[key]; else bd[key] = { ...BORDER_XL };
        };
        side('top', e.bt); side('right', e.br); side('bottom', e.bb); side('left', e.bl);
        if (Object.keys(bd).length > 0) next.border = bd as unknown as ExcelJS.Borders; else delete next.border;
      }

      if (p.nf !== undefined) next.numFmt = p.nf === null ? 'General' : p.nf;

      cell.style = next as ExcelJS.Style;
    }
  }
}

/** px của op đổi kích thước: null (về mặc định) hoặc số đã kẹp vào [min,max]. */
function sanitizeSizePx(raw: unknown, min: number, max: number, what: string): number | null {
  if (raw === null || raw === undefined) return null;
  const px = Number(raw);
  if (!Number.isFinite(px)) throw new Error(`op ${what} có px không hợp lệ: ${String(raw)}`);
  return Math.min(max, Math.max(min, Math.round(px)));
}

function sanitizeOps(raw: unknown): SheetOp[] {
  if (!Array.isArray(raw)) throw new Error('ops phải là mảng.');
  return raw.map((o): SheetOp => {
    const op = (o ?? {}) as Record<string, unknown>;
    // Ops theo VÙNG (định dạng / trộn ô) — validate riêng.
    if (op.op === 'style') return { op: 'style', ...sanitizeRange(op), st: sanitizePatch(op.st) };
    if (op.op === 'merge' || op.op === 'unmerge') return { op: op.op, ...sanitizeRange(op) };
    // Col ops không có r — validate riêng từng nhánh.
    if (op.op === 'insertCol' || op.op === 'deleteCol') {
      const c = Number(op.c);
      if (!Number.isInteger(c) || c < 1 || c > 16_384) throw new Error(`op ${op.op} có c không hợp lệ: ${op.c}`);
      return { op: op.op, c };
    }
    if (op.op === 'colWidth') {
      const c = Number(op.c);
      if (!Number.isInteger(c) || c < 1 || c > 16_384) throw new Error(`op colWidth có c không hợp lệ: ${op.c}`);
      return { op: 'colWidth', c, px: sanitizeSizePx(op.px, MIN_COL_PX, MAX_COL_PX, 'colWidth') };
    }
    if (op.op === 'rowHeight') {
      const r = Number(op.r);
      if (!Number.isInteger(r) || r < 1 || r > 1_048_576) throw new Error(`op rowHeight có r không hợp lệ: ${op.r}`);
      return { op: 'rowHeight', r, px: sanitizeSizePx(op.px, MIN_ROW_PX, MAX_ROW_PX, 'rowHeight') };
    }
    const r = Number(op.r);
    if (!Number.isInteger(r) || r < 1 || r > 1_048_576) throw new Error(`op có r không hợp lệ: ${op.r}`);
    if (op.op === 'set') {
      const c = Number(op.c);
      if (!Number.isInteger(c) || c < 1 || c > 16_384) throw new Error(`op set có c không hợp lệ: ${op.c}`);
      return { op: 'set', r, c, value: String(op.value ?? '') };
    }
    if (op.op === 'insertRow') return { op: 'insertRow', r };
    if (op.op === 'deleteRow') return { op: 'deleteRow', r };
    throw new Error(`op không hợp lệ: ${String(op.op)}`);
  });
}

export interface SaveSheetInput {
  path: unknown;
  mtimeMs: unknown;
  sheets: unknown;
}

export async function saveFile(input: SaveSheetInput): Promise<SheetSaveResult> {
  if (!OFFICE_ALLOW_WRITE) {
    throw new Error('Ghi file đang tắt cho toàn tool. Set OFFICE_ALLOW_WRITE=true trong .env.local (local dev only).');
  }
  const t = await resolveTarget(input.path);
  assertNotStale(t, input.mtimeMs);

  const rawSheets = Array.isArray(input.sheets) ? (input.sheets as unknown[]) : [];
  const sheetOps = rawSheets.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return { name: String(o.name ?? ''), ops: sanitizeOps(o.ops) };
  }).filter((s) => s.ops.length > 0);
  if (sheetOps.length === 0) throw new Error('Không có thay đổi nào để lưu.');

  let outBuf: Buffer;
  if (t.kind === 'csv') {
    if (sheetOps.length > 1) throw new Error('CSV chỉ có một sheet.');
    const doc = parseCsv(await fs.readFile(t.abs));
    for (const op of sheetOps[0].ops) {
      if (op.op === 'set') {
        while (doc.grid.length < op.r) doc.grid.push([]);
        const row = doc.grid[op.r - 1];
        while (row.length < op.c) row.push('');
        row[op.c - 1] = op.value; // CSV cells are text as-is, no coercion
      } else if (op.op === 'insertRow') {
        doc.grid.splice(Math.min(op.r - 1, doc.grid.length), 0, []);
      } else if (op.op === 'deleteRow') {
        doc.grid.splice(op.r - 1, 1);
      } else if (op.op === 'insertCol') {
        for (const row of doc.grid) {
          if (row.length >= op.c) row.splice(op.c - 1, 0, '');
        }
      } else if (op.op === 'deleteCol') {
        for (const row of doc.grid) {
          if (row.length >= op.c) row.splice(op.c - 1, 1);
        }
      }
      // style/merge/unmerge: CSV không có định dạng — bỏ qua (UI cũng ẩn).
    }
    outBuf = encodeCsv(doc);
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(t.abs);
    for (const { name, ops } of sheetOps) {
      const ws = wb.getWorksheet(name);
      if (!ws) throw new Error(`Không tìm thấy sheet "${name}" trong file (file đã đổi cấu trúc?).`);
      for (const op of ops) {
        if (op.op === 'set') {
          ws.getRow(op.r).getCell(op.c).value = parseInput(op.value);
        } else if (op.op === 'insertRow') {
          // NOTE: like Excel's raw XML edit, formulas referencing shifted rows
          // and merged ranges are NOT rewritten/moved (verified: a merge can be
          // dropped when rows shift) — the UI warns before saving row ops.
          ws.insertRow(op.r, []);
        } else if (op.op === 'deleteRow') {
          ws.spliceRows(op.r, 1);
        } else if (op.op === 'insertCol') {
          // Same caveat as row ops: formulas/merges are not shifted (ExcelJS).
          ws.spliceColumns(op.c, 0, []);
        } else if (op.op === 'deleteCol') {
          ws.spliceColumns(op.c, 1);
        } else if (op.op === 'style') {
          applyStyleOp(ws, op);
        } else if (op.op === 'merge') {
          // ExcelJS throws khi vùng chồng lên merge cũ → bỏ trộn trước cho chắc.
          // Ô không phải trên-trái mất nội dung (đúng như Excel làm khi trộn).
          ws.unMergeCells(op.r1, op.c1, op.r2, op.c2);
          ws.mergeCells(op.r1, op.c1, op.r2, op.c2);
        } else if (op.op === 'unmerge') {
          ws.unMergeCells(op.r1, op.c1, op.r2, op.c2);
        } else if (op.op === 'colWidth') {
          // undefined = bỏ width riêng → cột về mặc định của sheet.
          ws.getColumn(op.c).width = op.px === null ? undefined : pxToColWidth(op.px);
        } else if (op.op === 'rowHeight') {
          // Setter của ExcelJS nhận undefined để BỎ chiều cao riêng (dòng về
          // mặc định), nhưng typings khai là number — cast hẹp đúng chỗ này.
          (ws.getRow(op.r) as { height?: number }).height = op.px === null ? undefined : pxToRowHeight(op.px);
        }
      }
    }
    // Có công thức mới ghi vào (không kèm cached result) → bắt Excel tính lại
    // toàn bộ khi mở file, kẻo ô công thức hiện trống.
    wb.calcProperties.fullCalcOnLoad = true;
    outBuf = Buffer.from(await wb.xlsx.writeBuffer());
  }

  const backupPath = await atomicBackupWrite(t.abs, outBuf);

  const counts = sheetOps.map((s) => {
    const n = (k: SheetOp['op']) => s.ops.filter((o) => o.op === k).length;
    return `${s.name}(set=${n('set')},insRow=${n('insertRow')},delRow=${n('deleteRow')}`
      + `,insCol=${n('insertCol')},delCol=${n('deleteCol')}`
      + `,style=${n('style')},merge=${n('merge')},unmerge=${n('unmerge')}`
      + `,colW=${n('colWidth')},rowH=${n('rowHeight')})`;
  }).join(' ');
  // Audit line → server stdout (same convention as PG_AUDIT / MONGO_AUDIT).
  // eslint-disable-next-line no-console
  console.log(`SHEET_AUDIT operation=SAVE path=${t.abs} ${counts} backup=${backupPath} ts=${new Date().toISOString()}`);

  const st = await fs.stat(t.abs);
  return { backupPath, sizeBytes: st.size, mtimeMs: st.mtimeMs };
}
