// (đã chuyển từ vhs-monitor — xem lib/exportJoin.ts bên đó để đối chiếu)
// NỐI CỘT khi xuất Excel: bảng/index A (đang xuất) có field X khớp field Y của bảng/index B (cùng hoặc KHÁC kết nối,
// khác loại: ES · Mongo · PG đi chéo thoải mái) → lấy thêm các field của B thành cột của file.
//
// Cách làm — "làm giàu dòng" rồi để cơ chế cột sẵn có lo phần còn lại:
//   dòng A  →  row['~b'] = [các document B khớp]   (không khớp thì không có khoá)
//   cột     →  path "~b.name": collectByPath đi xuyên mảng, gom mọi giá trị; nhiều document B khớp một dòng A thì
//              ô Excel nhận NHIỀU giá trị và nối bằng ký tự phân cách của CỘT (đã cấu hình được) — cùng định dạng,
//              đổi giá trị, thời gian theo pattern như mọi cột khác.
//
// TỐI ƯU TRUY VẤN: không hỏi B từng dòng A. Sau khi tải xong A, gom các khoá KHÁC NHAU (bỏ trùng) rồi hỏi B theo lô
// BATCH_KEYS khoá/lần (Mongo `$in`, ES `terms`, PG `IN`), vài lô chạy song song. 100.000 dòng A mà chỉ có 3.000 khoá
// khác nhau thì chỉ tốn 15 request. Chỉ kéo về đúng các field B mà cột đang dùng (projection / _source).
// Chỉ nối khi có cột thật sự dùng `~alias.…` — khai nối mà không dùng thì không tốn request nào.

import { findMongo, type FindParams } from '@/lib/mongo';
import { scrollStartEs, scrollNextEs, scrollClearEs } from '@/lib/es';
import { queryPg } from '@/lib/pg';
import { parseRows } from '@/components/export/exportRun';
import { collectByPath } from './mongoReport';

/** Trang tải mỗi lượt — Mongo find trần 200/lần (FIND_LIMIT_MAX), ES scroll và PG dùng cùng cỡ cho đơn giản. */
const PAGE = 200;

export type JoinKind = 'es' | 'mongo' | 'pg';
/** Kiểu của khoá khi hỏi B. `auto` = tự đoán theo giá trị (Mongo hỏi cả dạng text lẫn ObjectId/số). */
export type JoinKeyType = 'auto' | 'text' | 'number' | 'objectId' | 'uuid';

export const JOIN_KEY_TYPES: { value: JoinKeyType; label: string }[] = [
  { value: 'auto', label: 'Tự nhận' },
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Số' },
  { value: 'objectId', label: 'ObjectId (Mongo)' },
  { value: 'uuid', label: 'UUID (PG)' },
];

/** Toán tử của điều kiện lọc bên nối. Phủ định: `ne` / `nin` / `missing` — KHÔNG loại bản ghi thiếu field (is_deleted ≠ true vẫn lấy dòng chưa có is_deleted). */
export type JoinOp = 'eq' | 'ne' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists' | 'missing';
export type JoinValType = 'text' | 'number' | 'boolean';

export const JOIN_OPS: { value: JoinOp; label: string }[] = [
  { value: 'eq', label: '= bằng' },
  { value: 'ne', label: '≠ không bằng (phủ định)' },
  { value: 'in', label: '∈ thuộc danh sách' },
  { value: 'nin', label: '∉ không thuộc danh sách' },
  { value: 'gt', label: '> lớn hơn' },
  { value: 'gte', label: '≥ lớn hơn hoặc bằng' },
  { value: 'lt', label: '< nhỏ hơn' },
  { value: 'lte', label: '≤ nhỏ hơn hoặc bằng' },
  { value: 'contains', label: 'chứa chuỗi' },
  { value: 'exists', label: 'có giá trị' },
  { value: 'missing', label: 'không có giá trị (null)' },
];

export const JOIN_VAL_TYPES: { value: JoinValType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Số' },
  { value: 'boolean', label: 'Boolean' },
];

/** Một điều kiện lọc bên nối; các điều kiện của một phép nối gộp bằng AND. */
export interface JoinFilter {
  field: string;
  op: JoinOp;
  /** Luôn là text khi nhập; `in`/`nin` cách nhau dấu phẩy. Bỏ qua với exists/missing. */
  value: string;
  type: JoinValType;
}

export const filterNeedsValue = (op: JoinOp) => op !== 'exists' && op !== 'missing';

/** Kiểu giá trị gợi ý từ kiểu field (mapping ES / BSON / kiểu cột PG). */
export function valTypeOfField(fieldType: string | undefined): JoinValType {
  const t = (fieldType ?? '').toLowerCase();
  if (t.startsWith('bool')) return 'boolean';
  if (/^(int|long|short|byte|double|float|half_float|scaled_float|number|numeric|decimal|bigint|smallint|real|serial|money|unsigned)/.test(t)) return 'number';
  return 'text';
}

export interface JoinDraft {
  id: string;
  /** Tên dùng trong field code của cột: "~alias.field". Chữ/số/gạch dưới. */
  alias: string;
  connectionId: string;
  kind: JoinKind;
  /** Mongo: database · PG: database (schema nằm trong `object` dạng schema.table) · ES: để trống. */
  db: string;
  /** ES: index/alias · Mongo: collection · PG: table. */
  object: string;
  /** Field của A chứa khoá (có thể trỏ vào list object — nhiều khoá). */
  sourceField: string;
  /** Field của B để so khớp. */
  targetField: string;
  keyType: JoinKeyType;
  /** Lọc bớt dữ liệu bên nối (AND). Trống = lấy mọi document khớp khoá. */
  filters?: JoinFilter[];
  /** Số document bên nối tối đa được nối vào MỘT dòng của file (0/trống = không giới hạn). */
  maxPerRow?: number;
  /** Thứ tự các document bên nối trong một ô (nối theo thứ tự này; kết hợp với maxPerRow = "N dòng đầu theo sắp xếp"). */
  sort?: JoinSort[];
}

export interface JoinSort {
  field: string;
  dir: 'asc' | 'desc';
}

/** Giá trị đầu tiên của field (list → phần tử đầu) để so sánh. */
function sortValue(doc: unknown, field: string): unknown {
  const v = collectByPath(doc, field.trim());
  const x = Array.isArray(v) ? v[0] : v;
  return x === undefined || x === null || typeof x === 'object' ? undefined : x;
}

/** Sắp xếp phía client — các document của một dòng đến từ nhiều lô/khoá nên chỉ sắp sau khi đã gom mới đúng thứ tự. Thiếu giá trị luôn xếp cuối. */
function sortDocs(docs: Record<string, unknown>[], keys: JoinSort[]): Record<string, unknown>[] {
  const ks = keys.filter((k) => k.field.trim());
  if (!ks.length || docs.length < 2) return docs;
  const cmp = (a: unknown, b: unknown) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
  return [...docs].sort((x, y) => {
    for (const k of ks) {
      const a = sortValue(x, k.field);
      const b = sortValue(y, k.field);
      if (a === undefined || b === undefined) { if (a === b) continue; return a === undefined ? 1 : -1; }
      const c = cmp(a, b);
      if (c) return k.dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

/** Số khoá khác nhau gửi sang B mỗi lần. */
export const BATCH_KEYS = 200;
/** Số lô chạy song song. */
const CONCURRENCY = 3;
/** Trần số document B kéo về cho MỘT lô — chặn khoá quá "rộng" (một khoá khớp cả triệu dòng). */
const MAX_DOCS_PER_BATCH = 20_000;

export const JOIN_PREFIX = '~';
export const joinKeyOf = (alias: string) => `${JOIN_PREFIX}${alias}`;
export const isJoinPath = (p: string) => p.startsWith(JOIN_PREFIX);
/** "~b.name.first" → { alias: 'b', rest: 'name.first' } · "~b" → rest ''. */
export function splitJoinPath(p: string): { alias: string; rest: string } | null {
  if (!isJoinPath(p)) return null;
  const body = p.slice(1);
  const i = body.indexOf('.');
  return i < 0 ? { alias: body, rest: '' } : { alias: body.slice(0, i), rest: body.slice(i + 1) };
}

const ALIAS_RE = /^[A-Za-z0-9_]+$/;

export function newJoin(existing: JoinDraft[]): JoinDraft {
  let n = existing.length;
  let alias = '';
  do { alias = n < 26 ? String.fromCharCode(98 + (n % 25)) : `j${n}`; n++; } while (existing.some((j) => j.alias === alias));
  return {
    id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    alias, connectionId: '', kind: 'mongo', db: '', object: '', sourceField: '', targetField: '', keyType: 'auto', filters: [],
  };
}

/** Lỗi cấu hình của một phép nối (null = hợp lệ). `all` để kiểm tra trùng alias. */
export function joinProblem(j: JoinDraft, all: JoinDraft[]): string | null {
  if (!ALIAS_RE.test(j.alias)) return 'tên ngắn (alias) chỉ gồm chữ, số, gạch dưới';
  if (all.some((x) => x.id !== j.id && x.alias === j.alias)) return `trùng tên ngắn "${j.alias}"`;
  if (!j.connectionId) return 'chưa chọn kết nối đích';
  if ((j.kind === 'mongo' || j.kind === 'pg') && !j.db.trim()) return 'chưa chọn database';
  if (!j.object.trim()) return j.kind === 'es' ? 'chưa chọn index' : j.kind === 'mongo' ? 'chưa chọn collection' : 'chưa chọn bảng';
  if (!j.sourceField.trim()) return 'chưa khai field khoá ở bên xuất';
  if (!j.targetField.trim()) return 'chưa khai field khoá ở bên nối';
  if ((j.sort ?? []).some((s) => !s.field.trim())) return 'sắp xếp: thiếu field';
  for (const f of j.filters ?? []) {
    if (!f.field.trim()) return 'điều kiện lọc: thiếu field';
    if (filterNeedsValue(f.op) && !f.value.trim()) return `điều kiện lọc "${f.field}": thiếu giá trị`;
    try { filterValues(f); } catch (e) { return `điều kiện lọc "${f.field}": ${(e as Error).message}`; }
  }
  return null;
}

// ── Điều kiện lọc → từng loại backend ──────────────────────────────────────────

function convertVal(raw: string, type: JoinValType): string | number | boolean {
  const v = raw.trim();
  if (type === 'number') {
    const n = Number(v);
    if (v === '' || !Number.isFinite(n)) throw new Error(`"${raw}" không phải số`);
    return n;
  }
  if (type === 'boolean') {
    const l = v.toLowerCase();
    if (l !== 'true' && l !== 'false') throw new Error(`"${raw}" không phải true/false`);
    return l === 'true';
  }
  return v;
}

/** Giá trị đã đổi kiểu của điều kiện: danh sách cho in/nin, một giá trị cho các toán tử còn lại, [] khi không cần giá trị. */
function filterValues(f: JoinFilter): (string | number | boolean)[] {
  if (!filterNeedsValue(f.op)) return [];
  if (f.op === 'in' || f.op === 'nin') {
    const list = f.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => convertVal(s, f.type));
    if (!list.length) throw new Error('danh sách rỗng');
    return list;
  }
  return [convertVal(f.value, f.type)];
}

const escRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
const escWildcard = (s: string) => s.replace(/[\\*?]/g, (c) => `\\${c}`);

/** Mongo: `{field: …}` cho một điều kiện. `$ne`/`$nin`/`null` khớp cả document thiếu field — đúng nghĩa phủ định. */
function mongoCond(f: JoinFilter): Record<string, unknown> {
  const k = f.field.trim();
  const v = filterValues(f);
  switch (f.op) {
    case 'eq': return { [k]: v[0] };
    case 'ne': return { [k]: { $ne: v[0] } };
    case 'in': return { [k]: { $in: v } };
    case 'nin': return { [k]: { $nin: v } };
    case 'gt': return { [k]: { $gt: v[0] } };
    case 'gte': return { [k]: { $gte: v[0] } };
    case 'lt': return { [k]: { $lt: v[0] } };
    case 'lte': return { [k]: { $lte: v[0] } };
    case 'contains': return { [k]: { $regex: escRegex(String(v[0])), $options: 'i' } };
    case 'exists': return { [k]: { $exists: true, $ne: null } };
    default: return { [k]: null }; // missing: null hoặc thiếu field
  }
}

/** ES: điều kiện vào mảng `filter` hoặc `must_not` của bool. */
function esCond(f: JoinFilter): { must: boolean; q: unknown } {
  const k = f.field.trim();
  const v = filterValues(f);
  switch (f.op) {
    case 'eq': return { must: true, q: { term: { [k]: v[0] } } };
    case 'ne': return { must: false, q: { term: { [k]: v[0] } } };
    case 'in': return { must: true, q: { terms: { [k]: v } } };
    case 'nin': return { must: false, q: { terms: { [k]: v } } };
    case 'gt': return { must: true, q: { range: { [k]: { gt: v[0] } } } };
    case 'gte': return { must: true, q: { range: { [k]: { gte: v[0] } } } };
    case 'lt': return { must: true, q: { range: { [k]: { lt: v[0] } } } };
    case 'lte': return { must: true, q: { range: { [k]: { lte: v[0] } } } };
    case 'contains': return { must: true, q: { wildcard: { [k]: { value: `*${escWildcard(String(v[0]))}*`, case_insensitive: true } } } };
    case 'exists': return { must: true, q: { exists: { field: k } } };
    default: return { must: false, q: { exists: { field: k } } };
  }
}

// ── Khoá ───────────────────────────────────────────────────────────────────────

const HEX24 = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dạng so khớp của một giá trị: chuỗi, bỏ khoảng trắng; ObjectId/UUID không phân biệt hoa thường. */
function norm(v: unknown): string {
  const s = (typeof v === 'string' ? v : String(v)).trim();
  return HEX24.test(s) || UUID.test(s) ? s.toLowerCase() : s;
}

/** Các khoá (đã chuẩn hoá) của một document theo `path`; list → nhiều khoá. */
function keysOf(doc: unknown, path: string, out: Map<string, boolean>): string[] {
  const raw = collectByPath(doc, path);
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const keys: string[] = [];
  for (const v of list) {
    if (v === undefined || v === null || typeof v === 'object') continue;
    const k = norm(v);
    if (!k) continue;
    if (!out.has(k)) out.set(k, typeof v === 'number');
    keys.push(k);
  }
  return keys;
}

/** `name.keyword` → `name`: so khớp phía client đọc _source, không có field con `.keyword`. */
const sourcePath = (p: string) => p.trim().replace(/\.keyword$/i, '');

// ── Truy vấn B theo lô ─────────────────────────────────────────────────────────

interface BatchResult { docs: Record<string, unknown>[]; truncated: boolean }

async function fetchMongo(j: JoinDraft, keys: string[], numeric: Set<string>, fields: string[] | null): Promise<BatchResult> {
  const values: unknown[] = [];
  for (const k of keys) {
    if (j.keyType === 'number') { const n = Number(k); if (Number.isFinite(n)) values.push(n); }
    else if (j.keyType === 'objectId') values.push({ $oid: k });
    else if (j.keyType === 'text') values.push(k);
    else {
      // Tự nhận: dữ liệu Mongo hay lẫn kiểu (_id ObjectId nhưng khoá tham chiếu lưu text…) → hỏi mọi dạng có thể.
      values.push(k);
      if (HEX24.test(k)) values.push({ $oid: k });
      if (numeric.has(k) || /^-?\d+(\.\d+)?$/.test(k)) { const n = Number(k); if (Number.isFinite(n)) values.push(n); }
    }
  }
  const keyCond = { [sourcePath(j.targetField)]: { $in: values } };
  const extra = (j.filters ?? []).map(mongoCond);
  const filter = JSON.stringify(extra.length ? { $and: [keyCond, ...extra] } : keyCond);
  const projection = fields ? JSON.stringify(Object.fromEntries(fields.map((f) => [f, 1]))) : '';
  const docs: Record<string, unknown>[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const p: FindParams = { filter, projection, sort: '{"_id":1}', limit: PAGE, skip };
    const r = await findMongo(j.connectionId, j.db, j.object, p);
    docs.push(...parseRows(r.docs));
    if (!r.hasMore) return { docs, truncated: false };
    if (docs.length >= MAX_DOCS_PER_BATCH) return { docs, truncated: true };
  }
}

/** ES: đi bằng scroll (không vướng max_result_window 10.000 như from/size). */
async function fetchEs(j: JoinDraft, keys: string[], fields: string[] | null): Promise<BatchResult> {
  const values = j.keyType === 'number' ? keys.map(Number).filter(Number.isFinite) : keys;
  const conds = (j.filters ?? []).map(esCond);
  const query = conds.length
    ? { bool: { filter: [{ terms: { [j.targetField.trim()]: values } }, ...conds.filter((c) => c.must).map((c) => c.q)], must_not: conds.filter((c) => !c.must).map((c) => c.q) } }
    : { terms: { [j.targetField.trim()]: values } };
  const body = JSON.stringify({ query });
  const docs: Record<string, unknown>[] = [];
  let scrollId: string | null = null;
  try {
    let page = await scrollStartEs(j.connectionId, j.object, { body, size: PAGE, ...(fields ? { source: JSON.stringify(fields) } : {}) });
    for (;;) {
      scrollId = page.scrollId;
      docs.push(...parseRows(page.docs));
      if (page.docs.length === 0 || !page.scrollId) return { docs, truncated: false };
      if (docs.length >= MAX_DOCS_PER_BATCH) return { docs, truncated: true };
      page = await scrollNextEs(j.connectionId, page.scrollId);
    }
  } finally {
    if (scrollId) void scrollClearEs(j.connectionId, scrollId);
  }
}

const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const pgLit = (v: string | number | boolean) =>
  typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${v.replace(/'/g, "''")}'`;

/** Một điều kiện lọc → mệnh đề SQL. ≠ / ∉ giữ cả dòng NULL (đúng nghĩa phủ định). So khớp bằng ::text cho cột khác kiểu text/number. */
function pgCond(f: JoinFilter): string {
  const col = pgIdent(f.field.trim());
  const v = filterValues(f);
  switch (f.op) {
    case 'eq': return `${col} = ${pgLit(v[0])}`;
    case 'ne': return `(${col} IS NULL OR ${col} <> ${pgLit(v[0])})`;
    case 'in': return `${col} IN (${v.map(pgLit).join(', ')})`;
    case 'nin': return `(${col} IS NULL OR ${col} NOT IN (${v.map(pgLit).join(', ')}))`;
    case 'gt': return `${col} > ${pgLit(v[0])}`;
    case 'gte': return `${col} >= ${pgLit(v[0])}`;
    case 'lt': return `${col} < ${pgLit(v[0])}`;
    case 'lte': return `${col} <= ${pgLit(v[0])}`;
    case 'contains': return `${col}::text ILIKE ${pgLit(`%${String(v[0]).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`;
    case 'exists': return `${col} IS NOT NULL`;
    default: return `${col} IS NULL`;
  }
}

async function fetchPg(j: JoinDraft, keys: string[], numeric: Set<string>): Promise<BatchResult> {
  const asNumber = j.keyType === 'number' || (j.keyType === 'auto' && keys.every((k) => numeric.has(k)));
  const keyList = asNumber ? keys.map(Number).filter(Number.isFinite).map(String) : keys.map((k) => pgLit(k));
  if (!keyList.length) return { docs: [], truncated: false };
  // object dạng "schema.table"; thiếu schema → public.
  const dot = j.object.indexOf('.');
  const schema = dot > 0 ? j.object.slice(0, dot) : 'public';
  const table = dot > 0 ? j.object.slice(dot + 1) : j.object.trim();
  // ::text ở cột khoá khi khoá là text: cột uuid / varchar đều so khớp được bằng chuỗi.
  const keyCol = pgIdent(j.targetField.trim());
  const where = [`${asNumber ? keyCol : `${keyCol}::text`} IN (${keyList.join(', ')})`, ...(j.filters ?? []).map(pgCond)].join(' AND ');
  const docs: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const r = await queryPg(j.connectionId, j.db, `SELECT * FROM ${pgIdent(schema)}.${pgIdent(table)} WHERE ${where} ORDER BY 1 LIMIT ${PAGE} OFFSET ${offset}`);
    docs.push(...parseRows(r.rows));
    if (r.rows.length < PAGE) return { docs, truncated: false };
    if (docs.length >= MAX_DOCS_PER_BATCH) return { docs, truncated: true };
  }
}

/** Chạy `tasks` với tối đa `n` việc cùng lúc, giữ thứ tự kết quả. */
async function pool<T>(tasks: (() => Promise<T>)[], n: number, onDone: () => void, cancelled: () => boolean): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !cancelled()) {
      const i = next++;
      out[i] = await tasks[i]();
      onDone();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

export interface JoinStat {
  alias: string;
  /** Số khoá khác nhau đã hỏi. */
  keys: number;
  /** Số dòng A có ít nhất một document B khớp. */
  matched: number;
  /** Có lô bị cắt (một khoá khớp quá nhiều document). */
  truncated: boolean;
}

/**
 * Gắn `row['~alias']` cho từng dòng. `need[alias]` = các field cấp 1 của B cần kéo về (null = lấy hết).
 * Ném lỗi có tiền tố "Nối cột <alias>: …" nếu B truy vấn hỏng — không xuất file thiếu cột âm thầm.
 */
export async function enrichRows(
  rows: Record<string, unknown>[],
  joins: JoinDraft[],
  need: Record<string, string[] | null>,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<JoinStat[]> {
  const stats: JoinStat[] = [];
  for (const j of joins) {
    const label = `Nối cột ${j.alias}`;
    // Khoá của từng dòng A + tập khoá khác nhau.
    const numeric = new Map<string, boolean>();
    const perRow = rows.map((r) => keysOf(r, j.sourceField, numeric));
    const distinct = [...numeric.keys()];
    const numericSet = new Set([...numeric].filter(([, isNum]) => isNum).map(([k]) => k));
    const batches: string[][] = [];
    for (let i = 0; i < distinct.length; i += BATCH_KEYS) batches.push(distinct.slice(i, i + BATCH_KEYS));

    const fields = need[j.alias] === undefined ? null : need[j.alias];
    // Field khoá của B luôn phải về (để so khớp phía client).
    const keyTop = sourcePath(j.targetField).split('.')[0];
    const want = fields ? [...new Set([...fields, keyTop, ...(j.sort ?? []).map((s) => s.field.trim().split('.')[0]).filter(Boolean)])] : null;

    let done = 0;
    opts.onProgress?.(`${label}… 0/${batches.length} lô (${distinct.length.toLocaleString('en-US')} khoá)`);
    let truncated = false;
    let results: BatchResult[];
    try {
      results = await pool(
        batches.map((keys) => () =>
          j.kind === 'mongo' ? fetchMongo(j, keys, numericSet, want)
          : j.kind === 'es' ? fetchEs(j, keys, want)
          : fetchPg(j, keys, numericSet)),
        CONCURRENCY,
        () => opts.onProgress?.(`${label}… ${++done}/${batches.length} lô`),
        () => false,
      );
    } catch (e) {
      throw new Error(`${label} (${j.object}): ${(e as Error).message}`);
    }

    // Chỉ mục B: khoá → các document.
    const index = new Map<string, Record<string, unknown>[]>();
    const tpath = sourcePath(j.targetField);
    for (const res of results) {
      truncated ||= res.truncated;
      for (const doc of res.docs) {
        const raw = collectByPath(doc, tpath);
        if (raw === undefined || raw === null) continue;
        for (const v of Array.isArray(raw) ? raw : [raw]) {
          if (v === undefined || v === null || typeof v === 'object') continue;
          const k = norm(v);
          const list = index.get(k);
          if (list) { if (list[list.length - 1] !== doc) list.push(doc); } else index.set(k, [doc]);
        }
      }
    }

    // Gắn vào dòng A, bỏ trùng document khi một dòng có nhiều khoá cùng trỏ về một document B.
    const key = joinKeyOf(j.alias);
    let matched = 0;
    rows.forEach((row, i) => {
      const seen = new Set<Record<string, unknown>>();
      for (const k of perRow[i]) for (const d of index.get(k) ?? []) seen.add(d);
      if (seen.size) {
        const all = sortDocs([...seen], j.sort ?? []);
        row[key] = j.maxPerRow && j.maxPerRow > 0 ? all.slice(0, j.maxPerRow) : all;
        matched++;
      }
    });
    stats.push({ alias: j.alias, keys: distinct.length, matched, truncated });
  }
  return stats;
}
