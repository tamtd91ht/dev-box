// Client-side helpers + shared wire types for the Word editor (Office tab).
// All calls go to the same-origin /api/word route — the Next server unzips and
// edits word/document.xml directly. Browser-safe module.

/** One block-level element of the document body, in order. */
export interface WordBlock {
  /** 'p' = paragraph (editable) · 'tbl' = table (read-only in v1). */
  kind: 'p' | 'tbl';
  /** Paragraph text ('\n' = line break, '\t' = tab). For tables: flattened preview. */
  text: string;
  /** Paragraph style id (Heading1, Title, …) — display hint only. */
  style?: string;
  /** Paragraph belongs to a numbered/bulleted list. */
  bullet?: boolean;
  /** Editing would destroy non-text content (image / field / link) — refused server-side. */
  locked?: boolean;
  /** Why it's locked, e.g. 'ảnh', 'liên kết', 'field'. */
  lockReason?: string;
}

export interface WordOpenResult {
  path: string;
  sizeBytes: number;
  /** File mtime at open — sent back on save to detect concurrent edits. */
  mtimeMs: number;
  blocks: WordBlock[];
  /** True when the view was capped at the server's MAX_BLOCKS. */
  truncated: boolean;
}

/** Edit operations, replayed server-side IN ORDER on the freshly re-read file.
 *  `i` is the 0-based BLOCK index at the time of the op (tables count too). */
export type WordOp =
  | { op: 'set'; i: number; text: string }
  | { op: 'insert'; i: number; text: string }
  | { op: 'delete'; i: number };

export interface WordSaveResult {
  backupPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface WordFlags {
  allowWrite: boolean;
  maxFileBytes: number;
  maxBlocks: number;
}

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

/** Create a new blank .docx in `dir` (never overwrites) and open it. */
export function createWordFile(dir: string, name: string): Promise<WordOpenResult> {
  return wordAction<WordOpenResult>('create', { dir, name });
}

export function saveWordFile(path: string, mtimeMs: number, ops: WordOp[]): Promise<WordSaveResult> {
  return wordAction<WordSaveResult>('save', { path, mtimeMs, ops });
}
