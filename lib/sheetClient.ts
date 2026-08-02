// Server-only engine for the Sheet workspace (Excel/CSV viewer-editor).
//
// Safety model (mirrors the other tools):
//   1. Whole tool behind SHEET_TOOL_ENABLED (route returns 403 when off).
//   2. `save` — the ONLY write — additionally requires SHEET_ALLOW_WRITE, plus
//      a confirm modal in the UI. Every save is audit-logged (SHEET_AUDIT).
//   3. Paths are path.resolve()'d, extension-whitelisted (.xlsx/.csv — .xlsm is
//      refused because ExcelJS drops VBA), stat'ed as a real file, size-capped.
//   4. Save is READ-MODIFY-WRITE with an op log: the file is re-read fresh and
//      the client's ops (set cell / insert row / delete row) are replayed in
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
import type { CellType, SheetOp, SheetOpenResult, SheetSaveResult, WireCell, WireSheet } from './sheet';
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

function toWire(cell: ExcelJS.Cell): WireCell {
  const raw = cell.value;
  if (raw === null || raw === undefined) return { v: '', t: 's' };
  if (raw instanceof Date) return { v: fmtDate(raw), t: 'd' };
  if (typeof raw === 'number') return { v: String(raw), t: 'n' };
  if (typeof raw === 'boolean') return { v: raw ? 'TRUE' : 'FALSE', t: 'b' };
  if (typeof raw === 'string') return { v: raw, t: 's' };
  if (typeof raw === 'object') {
    const o = raw as unknown as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) {
      const f = typeof o.formula === 'string' ? o.formula : (cell.formula ?? '');
      return { v: plainText((o as { result?: unknown }).result), t: 'f', f: String(f) };
    }
    // Rich text / hyperlink / error → flattened text; editing turns it into plain text.
    return { v: plainText(raw), t: 'x' };
  }
  return { v: String(raw), t: 'x' };
}

function sheetToWire(ws: ExcelJS.Worksheet): WireSheet {
  // rowCount/columnCount are the POSITIONS of the last used row/column — keep
  // gaps intact (actualRowCount would compact sheets that start lower down).
  const totalRows = ws.rowCount ?? 0;
  const totalCols = ws.columnCount ?? 0;
  const rc = Math.min(totalRows, MAX_ROWS);
  const cc = Math.min(totalCols, MAX_COLS);
  const rows: WireCell[][] = [];
  for (let r = 1; r <= rc; r++) {
    const row = ws.getRow(r);
    const cells: WireCell[] = [];
    for (let c = 1; c <= cc; c++) cells.push(toWire(row.getCell(c)));
    rows.push(cells);
  }
  return {
    name: ws.name,
    rows,
    rowCount: totalRows,
    colCount: totalCols,
    truncated: totalRows > MAX_ROWS || totalCols > MAX_COLS,
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

function sanitizeOps(raw: unknown): SheetOp[] {
  if (!Array.isArray(raw)) throw new Error('ops phải là mảng.');
  return raw.map((o): SheetOp => {
    const op = (o ?? {}) as Record<string, unknown>;
    // Col ops không có r — validate riêng từng nhánh.
    if (op.op === 'insertCol' || op.op === 'deleteCol') {
      const c = Number(op.c);
      if (!Number.isInteger(c) || c < 1 || c > 16_384) throw new Error(`op ${op.op} có c không hợp lệ: ${op.c}`);
      return { op: op.op, c };
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
      } else {
        for (const row of doc.grid) {
          if (row.length >= op.c) row.splice(op.c - 1, 1);
        }
      }
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
        } else {
          ws.spliceColumns(op.c, 1);
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
    const set = s.ops.filter((o) => o.op === 'set').length;
    const ins = s.ops.filter((o) => o.op === 'insertRow').length;
    const del = s.ops.filter((o) => o.op === 'deleteRow').length;
    const insC = s.ops.filter((o) => o.op === 'insertCol').length;
    const delC = s.ops.filter((o) => o.op === 'deleteCol').length;
    return `${s.name}(set=${set},insRow=${ins},delRow=${del},insCol=${insC},delCol=${delC})`;
  }).join(' ');
  // Audit line → server stdout (same convention as PG_AUDIT / MONGO_AUDIT).
  // eslint-disable-next-line no-console
  console.log(`SHEET_AUDIT operation=SAVE path=${t.abs} ${counts} backup=${backupPath} ts=${new Date().toISOString()}`);

  const st = await fs.stat(t.abs);
  return { backupPath, sizeBytes: st.size, mtimeMs: st.mtimeMs };
}
