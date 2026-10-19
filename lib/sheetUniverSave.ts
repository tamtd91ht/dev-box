// Server-only: ghi "bản vá" của giao diện Univer (lib/sheetUniverDiff) vào file gốc.
//
// Cùng rào an toàn với `saveFile` của lưới cũ:
//   1. Cổng ghi toàn tool (OFFICE_ALLOW_WRITE).
//   2. Đường dẫn qua resolveTarget (chỉ .xlsx/.csv có thật, trần dung lượng).
//   3. Kiểm tra mtime: file đã đổi từ lúc mở thì từ chối.
//   4. Ghi bằng atomicBackupWrite: file tạm → copy bản gốc sang <file>.bak → đổi tên đè.
//   5. Audit log (SHEET_AUDIT).
//
// Đọc LẠI file từ đĩa rồi chỉ chạm vào đúng ô/định dạng/gộp ô/kích thước có trong bản
// vá — phần còn lại của file giữ nguyên như ExcelJS đọc được.

import { promises as fs } from 'fs';
import ExcelJS from 'exceljs';
import { pxToColWidth, pxToRowHeight, MAX_COL_PX, MAX_ROW_PX, MIN_COL_PX, MIN_ROW_PX } from './sheet';
import { OFFICE_ALLOW_WRITE } from './officeFlags';
import { assertNotStale, atomicBackupWrite } from './officeFiles';
import { resolveTarget, parseCsv, encodeCsv } from './sheetClient';
import type { UStyle } from './sheetUniver';
import type { CellPatch, Rect, SheetPatch, UniverPatch } from './sheetUniverDiff';

const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;
const MAX_PATCH_CELLS = 2_000_000;
const MAX_TEXT = 32_767; // giới hạn ký tự của một ô Excel

// ── Univer style → ExcelJS ──────────────────────────────────────────────────

const BORDER_NAME: Record<number, ExcelJS.BorderStyle> = {
  1: 'thin', 2: 'hair', 3: 'dotted', 4: 'dashed', 5: 'dashDot', 6: 'dashDotDot', 7: 'double',
  8: 'medium', 9: 'mediumDashed', 10: 'mediumDashDot', 11: 'mediumDashDotDot', 12: 'slantDashDot', 13: 'thick',
};
const H_ALIGN: Record<number, ExcelJS.Alignment['horizontal']> = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify', 5: 'justify', 6: 'distributed' };
const V_ALIGN: Record<number, ExcelJS.Alignment['vertical']> = { 1: 'top', 2: 'middle', 3: 'bottom' };

/** '#rgb' | '#rrggbb' | 'rgb(r,g,b)' → 'FFRRGGBB'. undefined nếu không đọc được (vd màu theme). */
export function toArgb(css: unknown): string | undefined {
  if (typeof css !== 'string') return undefined;
  const s = css.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return `FF${m[1].toUpperCase()}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return `FF${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toUpperCase();
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(s);
  if (m) return `FF${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return undefined;
}

const color = (c: unknown): string | undefined => toArgb((c as { rgb?: unknown } | undefined)?.rgb);

/** Style Univer → các nhóm style của ExcelJS. Chỉ đọc các khoá biết rõ (không tin dữ liệu lạ). */
export function fromUStyle(u: UStyle): Partial<ExcelJS.Style> {
  const out: Partial<ExcelJS.Style> = {};
  const font: Partial<ExcelJS.Font> = { name: typeof u.ff === 'string' && u.ff ? u.ff : 'Calibri', size: typeof u.fs === 'number' ? u.fs : 11 };
  if (u.bl === 1) font.bold = true;
  if (u.it === 1) font.italic = true;
  if ((u.ul as { s?: number } | undefined)?.s === 1) font.underline = true;
  if ((u.st as { s?: number } | undefined)?.s === 1) font.strike = true;
  const fc = color(u.cl);
  if (fc) font.color = { argb: fc };
  out.font = font;

  const bg = color(u.bg);
  out.fill = bg ? { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } } : { type: 'pattern', pattern: 'none' };

  const al: Partial<ExcelJS.Alignment> = {};
  if (typeof u.ht === 'number' && H_ALIGN[u.ht]) al.horizontal = H_ALIGN[u.ht];
  if (typeof u.vt === 'number' && V_ALIGN[u.vt]) al.vertical = V_ALIGN[u.vt];
  if (u.tb === 3) al.wrapText = true;
  out.alignment = al;

  const bd = u.bd as Record<string, { s?: number; cl?: unknown } | null | undefined> | undefined;
  const border: Partial<ExcelJS.Borders> = {};
  for (const [k, name] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']] as const) {
    const side = bd?.[k];
    const style = side?.s ? BORDER_NAME[side.s] : undefined;
    if (style) border[name] = { style, ...(color(side?.cl) ? { color: { argb: color(side?.cl)! } } : {}) };
  }
  out.border = border;

  const pattern = (u.n as { pattern?: unknown } | undefined)?.pattern;
  out.numFmt = typeof pattern === 'string' && pattern ? pattern : 'General';
  return out;
}

// ── Kiểm tra bản vá ─────────────────────────────────────────────────────────

const isInt = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < max;

function sanitizePatch(raw: unknown): UniverPatch {
  const sheets = (raw as { sheets?: unknown } | null)?.sheets;
  if (!Array.isArray(sheets)) throw new Error('Bản vá không hợp lệ.');
  let cells = 0;
  const out: SheetPatch[] = [];
  for (const s of sheets as Partial<SheetPatch>[]) {
    if (!isInt(s?.index, 4096)) throw new Error('Bản vá không hợp lệ (chỉ số sheet).');
    const sp: SheetPatch = { index: s.index, name: String(s.name ?? ''), cells: [] };
    for (const c of Array.isArray(s.cells) ? s.cells : []) {
      if (!isInt(c?.r, MAX_ROWS) || !isInt(c?.c, MAX_COLS)) throw new Error('Bản vá không hợp lệ (toạ độ ô).');
      if (++cells > MAX_PATCH_CELLS) throw new Error('Quá nhiều ô thay đổi trong một lần lưu.');
      const cp: CellPatch = { r: c.r, c: c.c };
      if (c.value) {
        const v = c.value.v;
        if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Error('Bản vá không hợp lệ (giá trị ô).');
        if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Bản vá không hợp lệ (số).');
        if (typeof v === 'string' && v.length > MAX_TEXT) throw new Error(`Một ô vượt ${MAX_TEXT} ký tự.`);
        cp.value = { v, ...(typeof c.value.t === 'number' ? { t: c.value.t } : {}), ...(typeof c.value.f === 'string' ? { f: c.value.f } : {}) };
      }
      if (c.style !== undefined) cp.style = c.style && typeof c.style === 'object' ? (c.style as UStyle) : null;
      sp.cells.push(cp);
    }
    if (Array.isArray(s.merges)) {
      sp.merges = (s.merges as Rect[]).map((m) => {
        if (!isInt(m?.startRow, MAX_ROWS) || !isInt(m?.endRow, MAX_ROWS) || !isInt(m?.startColumn, MAX_COLS) || !isInt(m?.endColumn, MAX_COLS)) {
          throw new Error('Bản vá không hợp lệ (gộp ô).');
        }
        return { startRow: m.startRow, endRow: m.endRow, startColumn: m.startColumn, endColumn: m.endColumn };
      });
    }
    if (Array.isArray(s.cols)) {
      sp.cols = s.cols.map((x) => {
        if (!isInt(x?.c, MAX_COLS)) throw new Error('Bản vá không hợp lệ (cột).');
        return { c: x.c, w: typeof x.w === 'number' ? Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, x.w)) : null, hd: !!x.hd };
      });
    }
    if (Array.isArray(s.rows)) {
      sp.rows = s.rows.map((x) => {
        if (!isInt(x?.r, MAX_ROWS)) throw new Error('Bản vá không hợp lệ (dòng).');
        return { r: x.r, h: typeof x.h === 'number' ? Math.min(MAX_ROW_PX, Math.max(MIN_ROW_PX, x.h)) : null, hd: !!x.hd };
      });
    }
    if (s.freeze !== undefined) {
      sp.freeze = s.freeze && isInt(s.freeze.xSplit, MAX_COLS) && isInt(s.freeze.ySplit, MAX_ROWS)
        ? { xSplit: s.freeze.xSplit, ySplit: s.freeze.ySplit } : null;
    }
    out.push(sp);
  }
  return { sheets: out };
}

// ── Ghi ─────────────────────────────────────────────────────────────────────

export interface SaveUniverInput {
  path: unknown;
  mtimeMs: unknown;
  /** xlsx: bản vá. */
  patch?: unknown;
  /** csv: toàn bộ lưới giá trị (CSV không có định dạng nên thay hẳn). */
  grid?: unknown;
}

export interface SaveUniverResult { backupPath: string; sizeBytes: number; mtimeMs: number; cells: number }

const addr = (r: number, c: number) => `${colName(c)}${r + 1}`;
function colName(i: number): string {
  let s = '';
  let n = i;
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}
const rectKey = (m: Rect) => `${m.startRow},${m.startColumn},${m.endRow},${m.endColumn}`;
const rangeStr = (m: Rect) => `${addr(m.startRow, m.startColumn)}:${addr(m.endRow, m.endColumn)}`;

function decode(a: string): { r: number; c: number } | null {
  const m = a.match(/^\$?([A-Z]+)\$?(\d+)$/i);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}
function parseRange(s: string): Rect | null {
  const [a, b] = s.split(':');
  const p1 = decode(a ?? ''); const p2 = decode(b ?? a ?? '');
  if (!p1 || !p2) return null;
  return { startRow: Math.min(p1.r, p2.r), endRow: Math.max(p1.r, p2.r), startColumn: Math.min(p1.c, p2.c), endColumn: Math.max(p1.c, p2.c) };
}

function applyCell(cell: ExcelJS.Cell, p: CellPatch): boolean {
  let formula = false;
  if (p.value) {
    const { v, t, f } = p.value;
    if (f) {
      formula = true;
      cell.value = { formula: f.replace(/^=/, ''), result: v === null ? undefined : (t === 3 ? Boolean(v) : v) } as ExcelJS.CellFormulaValue;
    } else if (v === null) cell.value = null;
    else if (t === 3) cell.value = typeof v === 'boolean' ? v : Number(v) !== 0 && v !== 'FALSE' && v !== '';
    else cell.value = v;
  }
  if (p.style !== undefined) {
    if (p.style === null) cell.style = {};
    else {
      const st = fromUStyle(p.style);
      // fromUStyle luôn điền đủ cả 5 nhóm nên các dấu ! ở đây an toàn.
      cell.font = st.font!; cell.fill = st.fill!; cell.alignment = st.alignment!; cell.border = st.border!; cell.numFmt = st.numFmt!;
    }
  }
  return formula;
}

function applySheet(ws: ExcelJS.Worksheet, sp: SheetPatch): { cells: number; formulas: number } {
  // 1) Gộp ô TRƯỚC: ô phụ của vùng gộp không được ghi trực tiếp (ExcelJS sẽ gãy liên kết gộp).
  if (sp.merges) {
    const want = new Map(sp.merges.map((m) => [rectKey(m), m]));
    const have = new Map<string, Rect>();
    for (const s of (ws.model as { merges?: string[] }).merges ?? []) {
      const r = parseRange(String(s));
      if (r) have.set(rectKey(r), r);
    }
    for (const [k, r] of have) if (!want.has(k)) ws.unMergeCells(rangeStr(r));
    for (const [k, r] of want) {
      if (have.has(k) || (r.startRow === r.endRow && r.startColumn === r.endColumn)) continue;
      ws.mergeCells(rangeStr(r));
    }
  }
  const slaves = new Set<string>();
  for (const s of (ws.model as { merges?: string[] }).merges ?? []) {
    const r = parseRange(String(s));
    if (!r) continue;
    for (let rr = r.startRow; rr <= r.endRow; rr++) {
      for (let cc = r.startColumn; cc <= r.endColumn; cc++) if (rr !== r.startRow || cc !== r.startColumn) slaves.add(`${rr},${cc}`);
    }
  }

  // 2) Ô.
  let cells = 0; let formulas = 0;
  for (const p of sp.cells) {
    if (slaves.has(`${p.r},${p.c}`)) continue;
    if (applyCell(ws.getCell(p.r + 1, p.c + 1), p)) formulas++;
    cells++;
  }

  // 3) Kích thước + ẩn.
  for (const x of sp.cols ?? []) {
    const col = ws.getColumn(x.c + 1);
    col.width = x.w === null || x.w === undefined ? undefined : pxToColWidth(x.w);
    col.hidden = !!x.hd;
  }
  for (const x of sp.rows ?? []) {
    const row = ws.getRow(x.r + 1);
    (row as { height?: number }).height = x.h === null || x.h === undefined ? undefined : pxToRowHeight(x.h);
    row.hidden = !!x.hd;
  }

  // 4) Freeze.
  if (sp.freeze !== undefined) {
    const rest = (ws.views?.[0] ?? {}) as Record<string, unknown>;
    ws.views = [sp.freeze
      ? { ...rest, state: 'frozen', xSplit: sp.freeze.xSplit, ySplit: sp.freeze.ySplit } as ExcelJS.WorksheetView
      : { ...rest, state: 'normal', xSplit: undefined, ySplit: undefined } as unknown as ExcelJS.WorksheetView];
  }
  return { cells, formulas };
}

export async function saveUniverFile(input: SaveUniverInput): Promise<SaveUniverResult> {
  if (!OFFICE_ALLOW_WRITE) {
    throw new Error('Ghi file đang tắt cho toàn tool. Set OFFICE_ALLOW_WRITE=true trong .env.local (local dev only).');
  }
  const t = await resolveTarget(input.path);
  assertNotStale(t, input.mtimeMs);

  let outBuf: Buffer;
  let cells = 0;
  let detail = '';

  if (t.kind === 'csv') {
    const g = input.grid;
    if (!Array.isArray(g) || !g.every((r) => Array.isArray(r))) throw new Error('Thiếu dữ liệu CSV để lưu.');
    const doc = parseCsv(await fs.readFile(t.abs));
    doc.grid = (g as unknown[][]).map((r) => r.map((x) => String(x ?? '')));
    cells = doc.grid.reduce((n, r) => n + r.length, 0);
    outBuf = encodeCsv(doc);
    detail = `rows=${doc.grid.length}`;
  } else {
    const patch = sanitizePatch(input.patch);
    if (patch.sheets.length === 0) throw new Error('Không có thay đổi nào để lưu.');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(t.abs);
    let formulas = 0;
    for (const sp of patch.sheets) {
      const ws = wb.worksheets[sp.index];
      if (!ws || ws.name !== sp.name) {
        throw new Error(`Sheet "${sp.name}" không còn ở vị trí ${sp.index + 1} trong file (file đã đổi cấu trúc?). Tải lại rồi sửa tiếp.`);
      }
      const r = applySheet(ws, sp);
      cells += r.cells; formulas += r.formulas;
    }
    // Công thức mới ghi vào có thể thiếu giá trị cache → bắt Excel tính lại khi mở.
    if (formulas > 0) wb.calcProperties.fullCalcOnLoad = true;
    outBuf = Buffer.from(await wb.xlsx.writeBuffer());
    detail = `sheets=${patch.sheets.length},formulas=${formulas}`;
  }

  const backupPath = await atomicBackupWrite(t.abs, outBuf);
  // eslint-disable-next-line no-console
  console.log(`SHEET_AUDIT operation=SAVE_UNIVER path=${t.abs} cells=${cells} ${detail} backup=${backupPath} ts=${new Date().toISOString()}`);
  const st = await fs.stat(t.abs);
  return { backupPath, sizeBytes: st.size, mtimeMs: st.mtimeMs, cells };
}
