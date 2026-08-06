// Client-side helpers + shared wire types for the Word editor (Office tab).
// All calls go to the same-origin /api/word route — the Next server unzips and
// edits word/document.xml directly. Browser-safe module.
//
// Model: a document is an ordered list of BLOCKS (paragraph | table | page
// break). A paragraph is a list of RUNS (text + character formatting) plus a
// ParaFormat (alignment, spacing, indent, style, list level). Tables are a
// grid of cells, each cell being a list of paragraphs. Editing is an OP LOG
// replayed server-side on the freshly re-read file, so untouched content keeps
// its exact original XML.

// ── Character formatting (one run) ──────────────────────────────────────────

/** Character formatting of a run. Absent field = inherit from the style. */
export interface RunFormat {
  /** bold / italic / underline / strikethrough */
  b?: 1; i?: 1; u?: 1; st?: 1;
  /** font color — CSS #rrggbb */
  fc?: string;
  /** highlight (Word's marker pen) — a w:highlight name, e.g. 'yellow' */
  hl?: string;
  /** shading background — CSS #rrggbb (Word's "text background") */
  bg?: string;
  /** font size in points (half-points in OOXML, converted here) */
  fs?: number;
  /** font family */
  ff?: string;
  /** superscript / subscript */
  va?: 'sup' | 'sub';
  /** ALL CAPS / small caps */
  caps?: 1; smallCaps?: 1;
}

/** A contiguous stretch of text sharing one RunFormat.
 *  '\n' = line break inside the paragraph, '\t' = tab. */
export interface RunSpan {
  t: string;
  f?: RunFormat;
}

/** Non-text payload we cannot rebuild — carried through untouched. */
export type OpaqueKind = 'ảnh/hình vẽ' | 'đối tượng nhúng' | 'liên kết' | 'field tự động'
  | 'content control' | 'công thức toán' | 'footnote' | 'endnote';

// ── Paragraph formatting ────────────────────────────────────────────────────

/** Paragraph-level formatting. Absent field = inherit from the style. */
export interface ParaFormat {
  /** Named Word style id: 'Title', 'Heading1'…'Heading6', 'Normal', 'Quote'. */
  style?: string;
  /** Horizontal alignment. */
  jc?: 'l' | 'c' | 'r' | 'j';
  /** Line spacing multiple: 1 · 1.15 · 1.5 · 2 … */
  ls?: number;
  /** Space before / after the paragraph, in points. */
  sb?: number; sa?: number;
  /** Left indent / first-line indent, in points. */
  il?: number; ifl?: number;
  /** List membership: bulleted or numbered, with a 0-based level. */
  list?: 'bullet' | 'number';
  lvl?: number;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

export interface ParaBlock {
  kind: 'p';
  runs: RunSpan[];
  fmt?: ParaFormat;
  /** Paragraph holds content we can't rebuild — text edits are refused. */
  locked?: boolean;
  lockReason?: string;
}

/** One table cell: its paragraphs plus cell-level formatting. */
export interface TableCell {
  /** Cell content, one entry per paragraph (usually exactly one). */
  paras: { runs: RunSpan[]; fmt?: ParaFormat }[];
  /** Horizontal cells this one spans (w:gridSpan). */
  span?: number;
  /** Cell is covered by a vertical merge above it — rendered as part of it. */
  vMerged?: 1;
  /** Shading background — CSS #rrggbb. */
  bg?: string;
  /** Vertical alignment within the cell. */
  va?: 't' | 'm' | 'b';
  /** Cell width in points. */
  w?: number;
  /** Cell contains something we can't rebuild — refuse text edits. */
  locked?: boolean;
}

export interface TableBlock {
  kind: 'tbl';
  rows: TableCell[][];
  /** Table has a visible border grid (drives the default rendering). */
  bordered?: boolean;
  /** First row repeats as a header on each page (w:tblHeader). */
  headerRow?: boolean;
}

/** An explicit page break sitting on its own — shown as a divider. */
export interface BreakBlock {
  kind: 'br';
}

export type WordBlock = ParaBlock | TableBlock | BreakBlock;

// ── Header / footer ─────────────────────────────────────────────────────────

/** A header or footer part. `paras` mirrors paragraph blocks; `hasPageNum`
 *  flags an auto page-number field so the UI can show it as «số trang». */
export interface HeaderFooter {
  /** 'default' | 'first' | 'even' — which section reference this is. */
  type: 'default' | 'first' | 'even';
  paras: { runs: RunSpan[]; fmt?: ParaFormat }[];
  hasPageNum?: boolean;
}

/** Page setup of the (last) section — drives the on-screen page frame. */
export interface PageSetup {
  /** Page size in points. */
  w: number; h: number;
  /** Margins in points. */
  mt: number; mr: number; mb: number; ml: number;
  landscape?: boolean;
}

// ── Open / save ─────────────────────────────────────────────────────────────

export interface WordOpenResult {
  path: string;
  sizeBytes: number;
  /** File mtime at open — sent back on save to detect concurrent edits. */
  mtimeMs: number;
  blocks: WordBlock[];
  /** True when the view was capped at the server's MAX_BLOCKS. */
  truncated: boolean;
  headers: HeaderFooter[];
  footers: HeaderFooter[];
  page: PageSetup;
}

// ── Edit operations ─────────────────────────────────────────────────────────
//
// `i` is the 0-based BLOCK index at the time of the op — the server replays in
// order against the same evolving block list, so indexes always line up.

export type WordOp =
  /** Replace a paragraph's whole content with these runs (keeps its fmt). */
  | { op: 'set'; i: number; runs: RunSpan[] }
  /** Patch character formatting over a run range of one paragraph.
   *  `from`/`to` are character offsets into the paragraph's plain text. */
  | { op: 'runFmt'; i: number; from: number; to: number; f: RunFormatPatch }
  /** Patch paragraph formatting (alignment, spacing, indent, style, list). */
  | { op: 'paraFmt'; i: number; f: ParaFormatPatch }
  | { op: 'insert'; i: number; runs: RunSpan[]; fmt?: ParaFormat }
  | { op: 'delete'; i: number }
  /** Move a block (report reordering). `i` indexes the list as the user sees
   *  it; `to` is the destination index AFTER that block has been taken out —
   *  i.e. splice(i, 1) then splice(to, 0, block). So "down one" is to = i + 1. */
  | { op: 'move'; i: number; to: number }
  /** Insert an explicit page break block. */
  | { op: 'pageBreak'; i: number }
  // ── Tables ────────────────────────────────────────────────────────────────
  /** Insert a fresh r×c table at block index `i`. */
  | { op: 'tblInsert'; i: number; rows: number; cols: number; header?: 1 }
  /** Replace one cell's text (single paragraph, uniform formatting). */
  | { op: 'cellSet'; i: number; r: number; c: number; runs: RunSpan[] }
  /** Patch character formatting across a whole cell. */
  | { op: 'cellFmt'; i: number; r: number; c: number; f: RunFormatPatch; bg?: string | null; va?: 't' | 'm' | 'b' | null }
  | { op: 'tblRowInsert'; i: number; r: number; where: 'above' | 'below' }
  | { op: 'tblRowDelete'; i: number; r: number }
  | { op: 'tblColInsert'; i: number; c: number; where: 'left' | 'right' }
  | { op: 'tblColDelete'; i: number; c: number }
  /** Toggle the table's border grid. */
  | { op: 'tblBorder'; i: number; on: 0 | 1 }
  // ── Header / footer ───────────────────────────────────────────────────────
  /** Set the default header/footer text. `pageNum` appends an auto page field. */
  | { op: 'hfSet'; part: 'header' | 'footer'; text: string; jc?: 'l' | 'c' | 'r'; pageNum?: 0 | 1 }
  // ── Whole-document ────────────────────────────────────────────────────────
  /** Find & replace across every paragraph and table cell. */
  | { op: 'replaceAll'; find: string; replace: string; matchCase?: 0 | 1; whole?: 0 | 1 };

/** Patch semantics, same as the Sheet editor:
 *    · undefined = keep the run's existing value
 *    · null      = clear the attribute (back to the style default)
 *    · value     = set it */
export interface RunFormatPatch {
  b?: 1 | null; i?: 1 | null; u?: 1 | null; st?: 1 | null;
  fc?: string | null; hl?: string | null; bg?: string | null;
  fs?: number | null; ff?: string | null;
  va?: 'sup' | 'sub' | null;
  caps?: 1 | null; smallCaps?: 1 | null;
  /** Strip ALL character formatting (wins over every other field). */
  clear?: 1;
}

export interface ParaFormatPatch {
  style?: string | null;
  jc?: 'l' | 'c' | 'r' | 'j' | null;
  ls?: number | null;
  sb?: number | null; sa?: number | null;
  il?: number | null; ifl?: number | null;
  list?: 'bullet' | 'number' | null;
  lvl?: number | null;
  /** Strip ALL paragraph formatting (back to Normal). */
  clear?: 1;
}

export interface WordSaveResult {
  backupPath: string;
  sizeBytes: number;
  mtimeMs: number;
  /** replaceAll ops report how many hits they rewrote. */
  replaced?: number;
}

export interface WordFlags {
  allowWrite: boolean;
  maxFileBytes: number;
  maxBlocks: number;
}

// ── Patch application (client-side preview of what the server will do) ──────

/** Apply a RunFormatPatch to one run's formatting. */
export function applyRunPatch(base: RunFormat | undefined, p: RunFormatPatch): RunFormat | undefined {
  if (p.clear) return undefined;
  const f: RunFormat = { ...(base ?? {}) };
  const set = <K extends keyof RunFormat>(k: K, v: RunFormat[K] | null | undefined) => {
    if (v === undefined) return;
    if (v === null) delete f[k];
    else f[k] = v;
  };
  set('b', p.b); set('i', p.i); set('u', p.u); set('st', p.st);
  set('fc', p.fc); set('hl', p.hl); set('bg', p.bg);
  set('fs', p.fs); set('ff', p.ff); set('va', p.va);
  set('caps', p.caps); set('smallCaps', p.smallCaps);
  return Object.keys(f).length > 0 ? f : undefined;
}

/** Apply a ParaFormatPatch to one paragraph's formatting. */
export function applyParaPatch(base: ParaFormat | undefined, p: ParaFormatPatch): ParaFormat | undefined {
  if (p.clear) return undefined;
  const f: ParaFormat = { ...(base ?? {}) };
  const set = <K extends keyof ParaFormat>(k: K, v: ParaFormat[K] | null | undefined) => {
    if (v === undefined) return;
    if (v === null) delete f[k];
    else f[k] = v;
  };
  set('style', p.style); set('jc', p.jc); set('ls', p.ls);
  set('sb', p.sb); set('sa', p.sa); set('il', p.il); set('ifl', p.ifl);
  set('list', p.list); set('lvl', p.lvl);
  if (p.list === null) delete f.lvl;
  return Object.keys(f).length > 0 ? f : undefined;
}

/** Two RunFormats are interchangeable (used to merge adjacent runs). */
export function sameRunFormat(a: RunFormat | undefined, b: RunFormat | undefined): boolean {
  const ka = a ? Object.keys(a) : [];
  const kb = b ? Object.keys(b) : [];
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/** Collapse adjacent runs with identical formatting, dropping empty ones. */
export function mergeRuns(runs: RunSpan[]): RunSpan[] {
  const out: RunSpan[] = [];
  for (const r of runs) {
    if (r.t === '') continue;
    const last = out[out.length - 1];
    if (last && sameRunFormat(last.f, r.f)) last.t += r.t;
    else out.push({ t: r.t, ...(r.f ? { f: { ...r.f } } : {}) });
  }
  return out;
}

/** Plain text of a run list. */
export function runsText(runs: RunSpan[]): string {
  return runs.map((r) => r.t).join('');
}

/** Split a run list at a character offset, returning [before, after]. */
export function splitRuns(runs: RunSpan[], at: number): [RunSpan[], RunSpan[]] {
  const before: RunSpan[] = [];
  const after: RunSpan[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.t.length;
    if (end <= at) before.push(r);
    else if (pos >= at) after.push(r);
    else {
      before.push({ t: r.t.slice(0, at - pos), ...(r.f ? { f: r.f } : {}) });
      after.push({ t: r.t.slice(at - pos), ...(r.f ? { f: r.f } : {}) });
    }
    pos = end;
  }
  return [before, after];
}

/** Apply a character-format patch to the [from,to) slice of a run list. */
export function patchRunRange(runs: RunSpan[], from: number, to: number, p: RunFormatPatch): RunSpan[] {
  const [head, rest] = splitRuns(runs, from);
  const [mid, tail] = splitRuns(rest, to - from);
  const patched = mid.map((r) => {
    const f = applyRunPatch(r.f, p);
    return { t: r.t, ...(f ? { f } : {}) };
  });
  return mergeRuns([...head, ...patched, ...tail]);
}

/** Effective formatting shared by every run in [from,to) — fields that differ
 *  across the range are dropped, so the ribbon only lights up on agreement. */
export function commonRunFormat(runs: RunSpan[], from: number, to: number): RunFormat | undefined {
  const [, rest] = splitRuns(runs, from);
  const [mid] = splitRuns(rest, Math.max(0, to - from));
  const spans = mid.length > 0 ? mid : runs.slice(0, 1);
  if (spans.length === 0) return undefined;
  let acc: RunFormat | undefined = spans[0].f ? { ...spans[0].f } : {};
  for (const s of spans.slice(1)) {
    const cur = (s.f ?? {}) as Record<string, unknown>;
    const a = acc as Record<string, unknown>;
    for (const k of Object.keys(a)) if (a[k] !== cur[k]) delete a[k];
  }
  if (acc && Object.keys(acc).length === 0) acc = undefined;
  return acc;
}

// ── Transport ───────────────────────────────────────────────────────────────

async function wordAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/word', {
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

export function fetchWordFlags(): Promise<WordFlags> {
  return wordAction<WordFlags>('flags', {});
}

export function openWordFile(path: string): Promise<WordOpenResult> {
  return wordAction<WordOpenResult>('open', { path });
}

/** Blank document, or one of the built-in report templates. */
export type WordTemplate = 'blank' | 'report' | 'minutes' | 'proposal';

/** Create a new .docx in `dir` (never overwrites) and open it. */
export function createWordFile(dir: string, name: string, template: WordTemplate = 'blank'): Promise<WordOpenResult> {
  return wordAction<WordOpenResult>('create', { dir, name, template });
}

export function saveWordFile(path: string, mtimeMs: number, ops: WordOp[]): Promise<WordSaveResult> {
  return wordAction<WordSaveResult>('save', { path, mtimeMs, ops });
}
