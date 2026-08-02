// Client-side helpers + shared wire types for the Sheet workspace (Excel/CSV
// viewer-editor). All calls go to the same-origin /api/sheet route — the Next
// server does the actual file parsing/writing. Browser-safe module.

/** Cell type tag: number, string, boolean, date, formula, other (rich text /
 *  hyperlink / error — displayed read-flattened, editing turns it into text). */
export type CellType = 'n' | 's' | 'b' | 'd' | 'f' | 'x';

export interface WireCell {
  /** Display text ('' = empty cell). For formulas this is the computed result. */
  v: string;
  t: CellType;
  /** Formula source (without '='), present when t === 'f'. */
  f?: string;
  /** Client-only: cell was edited in this session (dirty highlight). */
  d?: boolean;
}

export interface WireSheet {
  name: string;
  /** Dense rowCount×colCount grid of the VISIBLE window (may be truncated). */
  rows: WireCell[][];
  /** Actual dimensions in the file (may exceed the shipped window). */
  rowCount: number;
  colCount: number;
  /** True when the view was capped at the server's MAX_ROWS/MAX_COLS. */
  truncated: boolean;
}

export interface SheetOpenResult {
  path: string;
  kind: 'xlsx' | 'csv';
  sizeBytes: number;
  /** File mtime at open — sent back on save to detect concurrent edits. */
  mtimeMs: number;
  sheets: WireSheet[];
  /** CSV only — detected on open, reused on save for round-trip fidelity. */
  csv?: { delimiter: string; hasBom: boolean; newline: '\r\n' | '\n' };
}

/** Edit operations, replayed server-side IN ORDER on the freshly re-read file.
 *  r/c are 1-based positions AT THE TIME of the op (matching what the user saw). */
export type SheetOp =
  | { op: 'set'; r: number; c: number; value: string; hadFormula?: boolean }
  | { op: 'insertRow'; r: number }
  | { op: 'deleteRow'; r: number }
  | { op: 'insertCol'; c: number }
  | { op: 'deleteCol'; c: number };

export interface SheetSaveResult {
  backupPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface SheetFlags {
  allowWrite: boolean;
  maxFileBytes: number;
  maxRows: number;
  maxCols: number;
}

async function sheetAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/sheet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    const err = new Error((data as { error?: string }).error || `HTTP ${r.status}`);
    (err as Error & { status?: number }).status = r.status;
    throw err;
  }
  return (data as { result: T }).result;
}

export function fetchSheetFlags(): Promise<SheetFlags> {
  return sheetAction<SheetFlags>('flags', {});
}

export function openSheetFile(path: string): Promise<SheetOpenResult> {
  return sheetAction<SheetOpenResult>('open', { path });
}

/** Create a new empty .xlsx/.csv in `dir` (never overwrites) and open it. */
export function createSheetFile(dir: string, name: string): Promise<SheetOpenResult> {
  return sheetAction<SheetOpenResult>('create', { dir, name });
}

export function saveSheetFile(
  path: string,
  mtimeMs: number,
  sheets: { name: string; ops: SheetOp[] }[],
): Promise<SheetSaveResult> {
  return sheetAction<SheetSaveResult>('save', { path, mtimeMs, sheets });
}

/** 0-based column index → spreadsheet letters: 0→A, 25→Z, 26→AA… */
export function colLetter(i: number): string {
  let s = '';
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/** Compact byte size: 731 B · 24 KB · 3.2 MB. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
