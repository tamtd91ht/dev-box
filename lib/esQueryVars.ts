// BIẾN TRUY VẤN cho tab ES → Dữ liệu: body _search được phép chứa `{{q1.tenantId}}`, trong đó `q1` là một query
// khai sẵn chạy ở NƠI KHÁC (ES · Mongo · PG, kết nối nào cũng được). Bấm Search thì:
//   1. chạy q1 → lấy mọi giá trị của field `tenantId` trong kết quả, bỏ trùng
//   2. thay vào body rồi mới gửi _search
//
// Cách thay (theo VỊ TRÍ của placeholder):
//   · đứng trần        "terms": { "tenantId": {{q1.tenantId}} }   → mảng JSON  ["t1","t2"]   (PG: 't1', 't2' — dùng trong IN (…))
//   · nguyên một chuỗi "term":  { "tenantId": "{{q1.tenantId}}" } → giá trị ĐẦU TIÊN, giữ kiểu (số vẫn là số)
//   · lẫn trong chuỗi  "abc-{{q1.tenantId}}"                      → giá trị đầu tiên, dán vào chuỗi
// `{{q1}}` (không ghi field) = dùng field mặc định khai ở biến.
//
// CHUỖI BIẾN: query của q2 cũng được chứa `{{q1…}}` — chạy theo thứ tự phụ thuộc, vòng lặp bị chặn và báo rõ.
// Mỗi biến chạy MỘT lần cho mỗi lượt resolve dù được dùng ở nhiều chỗ / nhiều field.
//
// Giới hạn: số giá trị khác nhau tối đa của một field (mặc định 10.000; `terms` của ES mặc định nhận tối đa 65.536)
// và số dòng quét tối đa của query nguồn. VƯỢT là báo lỗi — không cắt bớt âm thầm, vì kết quả thiếu mà trông như đủ
// còn tệ hơn không có kết quả.
//
// Danh sách biến lưu như preset (configs/presets.json, nhóm 'es.queryvars'). Browser-only.

import { readLocal } from './localKeys';
import { persistPresets } from './presetSync';
import { findMongo, aggregateMongo, withIdCursor } from './mongo';
import { scrollStartEs, scrollNextEs, scrollClearEs } from './es';
import { queryPg } from './pg';
import { parseRows } from '@/components/export/exportRun';
import { collectByPath } from './mongoReport';

const STORE_KEY = 'es.queryvars';

export type QueryVarKind = 'es' | 'mongo' | 'pg';

export interface QueryVar {
  id: string;
  /** Tên dùng trong placeholder: chữ cái/gạch dưới rồi tới chữ/số/gạch dưới. */
  name: string;
  connectionId: string;
  kind: QueryVarKind;
  /** Mongo / PG: database. ES: trống. */
  db: string;
  /** ES: index/alias · Mongo: collection · PG: không dùng (bảng nằm trong SQL). */
  object: string;
  /** ES: body _search (trống = match_all) · Mongo: filter EJSON, hoặc pipeline `[…]` để aggregate · PG: SELECT. */
  query: string;
  /** Field lấy giá trị khi placeholder không ghi field (`{{q1}}`). */
  field: string;
  /** Số giá trị khác nhau tối đa của một field (trống = DEFAULT_MAX). */
  max?: number;
}

export const DEFAULT_MAX = 10_000;
/** Trần cứng — `terms` của ES mặc định không nhận quá 65.536 giá trị. */
export const HARD_MAX = 65_536;
/** Số dòng quét tối đa của một query nguồn. */
const SCAN_MAX = 200_000;
const PAGE = 200;
/** PG: queryPg tự cắt ở 500 dòng/lần (QUERY_ROWS_MAX) — lật trang theo đúng cỡ đó. */
const PG_PAGE = 500;

const NAME_RE = /^[A-Za-z_]\w*$/;
/** `{{ name }}` hoặc `{{ name.field.path }}`. */
const REF_RE = /\{\{\s*([A-Za-z_]\w*)(?:\.([^\s{}]+?))?\s*\}\}/y;

export type Prim = string | number | boolean;

// ── Lưu trữ ────────────────────────────────────────────────────────────────────

function isVar(v: unknown): v is QueryVar {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === 'string' && typeof p.name === 'string' && typeof p.connectionId === 'string'
    && (p.kind === 'es' || p.kind === 'mongo' || p.kind === 'pg') && typeof p.query === 'string';
}

export function loadQueryVars(): QueryVar[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(readLocal(STORE_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(isVar).map((v) => ({ ...v, db: v.db ?? '', object: v.object ?? '', field: v.field ?? '' }))
      : [];
  } catch {
    return [];
  }
}

export function saveQueryVars(list: QueryVar[]): void {
  if (typeof window === 'undefined') return;
  persistPresets(STORE_KEY, list);
}

export function newQueryVar(existing: QueryVar[]): QueryVar {
  let n = existing.length + 1;
  while (existing.some((v) => v.name === `q${n}`)) n++;
  return {
    id: `qv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: `q${n}`, connectionId: '', kind: 'es', db: '', object: '', query: '', field: '',
  };
}

/** Lỗi cấu hình của một biến (null = hợp lệ). */
export function queryVarProblem(v: QueryVar, all: QueryVar[]): string | null {
  if (!NAME_RE.test(v.name)) return 'tên chỉ gồm chữ, số, gạch dưới và không bắt đầu bằng số';
  if (all.some((x) => x.id !== v.id && x.name === v.name)) return `trùng tên "${v.name}"`;
  if (!v.connectionId) return 'chưa chọn kết nối';
  if ((v.kind === 'mongo' || v.kind === 'pg') && !v.db.trim()) return 'chưa chọn database';
  if (v.kind === 'es' && !v.object.trim()) return 'chưa chọn index';
  if (v.kind === 'mongo' && !v.object.trim()) return 'chưa chọn collection';
  if (v.kind === 'pg' && !v.query.trim()) return 'chưa có câu SQL';
  return null;
}

const maxOf = (v: QueryVar) => Math.min(v.max && v.max > 0 ? v.max : DEFAULT_MAX, HARD_MAX);

// ── Quét placeholder ───────────────────────────────────────────────────────────

export interface VarRef {
  name: string;
  /** '' = field mặc định của biến. */
  path: string;
  start: number;
  end: number;
  /** Placeholder nằm trong chuỗi: 'whole' = chiếm trọn chuỗi (start/end ôm cả hai dấu nháy) · 'part' = một phần. */
  inString: 'whole' | 'part' | null;
}

/**
 * Tìm placeholder, phân biệt trong/ngoài chuỗi. `quote` = ký tự mở chuỗi: `"` cho JSON, `'` cho SQL.
 * JSON có thoát bằng `\`; SQL thoát bằng `''` — quét bật/tắt hai lần liên tiếp nên tự đúng.
 */
export function findRefs(text: string, quote: '"' | "'"): VarRef[] {
  const out: VarRef[] = [];
  let strStart = -1; // vị trí dấu nháy mở của chuỗi đang ở trong, -1 = ngoài chuỗi
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' && text[i + 1] === '{') {
      REF_RE.lastIndex = i;
      const m = REF_RE.exec(text);
      if (m) {
        const end = i + m[0].length;
        const ref = { name: m[1], path: m[2] ?? '' };
        if (strStart < 0) out.push({ ...ref, start: i, end, inString: null });
        else if (strStart === i - 1 && text[end] === quote) {
          out.push({ ...ref, start: i - 1, end: end + 1, inString: 'whole' });
          strStart = -1;
          i = end; // đã ăn luôn dấu nháy đóng
          continue;
        } else out.push({ ...ref, start: i, end, inString: 'part' });
        i = end - 1;
        continue;
      }
    }
    if (strStart >= 0) {
      if (quote === '"' && c === '\\') { i++; continue; }
      if (c === quote) strStart = -1;
    } else if (c === quote) strStart = i;
  }
  return out;
}

export const hasRefs = (text: string) => /\{\{\s*[A-Za-z_]/.test(text);

/**
 * Đổi placeholder trần thành chuỗi giữ chỗ để body vẫn là JSON hợp lệ — cho Format và kiểm tra cú pháp.
 * `restore` trả placeholder về đúng chỗ sau khi format.
 */
export function maskRefs(text: string): { masked: string; restore: (formatted: string) => string } {
  const refs = findRefs(text, '"').filter((r) => r.inString === null);
  if (!refs.length) return { masked: text, restore: (s) => s };
  const originals: string[] = [];
  let masked = '';
  let at = 0;
  for (const r of refs) {
    masked += `${text.slice(at, r.start)}"⁣var${originals.length}⁣"`;
    originals.push(text.slice(r.start, r.end));
    at = r.end;
  }
  masked += text.slice(at);
  return {
    masked,
    restore: (s) => s.replace(/"⁣var(\d+)⁣"/g, (_, n: string) => originals[Number(n)] ?? ''),
  };
}

// ── Chạy query nguồn ───────────────────────────────────────────────────────────

/** `name.keyword` → `name`: giá trị lấy từ _source, không có field con `.keyword`. */
const sourcePath = (p: string) => p.trim().replace(/\.keyword$/i, '');

/** Gom giá trị primitive (bỏ trùng, giữ thứ tự gặp) theo từng path. */
class Collector {
  readonly sets = new Map<string, Map<string, Prim>>();
  scanned = 0;
  constructor(private readonly v: QueryVar, paths: string[]) {
    for (const p of paths) this.sets.set(p, new Map());
  }
  add(doc: unknown) {
    if (++this.scanned > SCAN_MAX) {
      throw new Error(`query nguồn trả hơn ${SCAN_MAX.toLocaleString('en-US')} dòng — thu hẹp điều kiện lại`);
    }
    for (const [path, set] of this.sets) {
      const raw = collectByPath(doc, sourcePath(path));
      for (const x of Array.isArray(raw) ? raw.flat(Infinity) : [raw]) {
        if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') continue;
        const k = `${typeof x}:${x}`;
        if (set.has(k)) continue;
        if (set.size >= maxOf(this.v)) {
          throw new Error(`field "${path}" có hơn ${maxOf(this.v).toLocaleString('en-US')} giá trị khác nhau — thu hẹp query nguồn hoặc nâng "tối đa giá trị" của biến`);
        }
        set.set(k, x);
      }
    }
  }
}

async function scanEs(v: QueryVar, body: string, paths: string[], col: Collector): Promise<void> {
  // Chỉ kéo về đúng các field cần; `_id` không nằm trong _source nhưng server luôn gắn kèm.
  const source = JSON.stringify([...new Set(paths.map(sourcePath))]);
  let scrollId: string | null = null;
  try {
    let page = await scrollStartEs(v.connectionId, v.object, { body, size: PAGE, source });
    for (;;) {
      scrollId = page.scrollId;
      for (const d of parseRows(page.docs)) col.add(d);
      if (page.docs.length === 0 || !page.scrollId) return;
      page = await scrollNextEs(v.connectionId, page.scrollId);
    }
  } finally {
    if (scrollId) void scrollClearEs(v.connectionId, scrollId);
  }
}

async function scanMongo(v: QueryVar, query: string, paths: string[], col: Collector): Promise<void> {
  const q = query.trim();
  if (q.startsWith('[')) {
    // Pipeline aggregate — server trả tối đa 500 dòng, không lật trang được.
    const r = await aggregateMongo(v.connectionId, v.db, v.object, q);
    if (r.capped) throw new Error('pipeline trả hơn 500 dòng — thêm $group / $limit để gọn lại');
    for (const d of parseRows(r.docs)) col.add(d);
    return;
  }
  const filter = q || '{}';
  // _id luôn về theo mặc định của Mongo (cần cho cursor). Bỏ path con khi đã có path cha — "a" và "a.b" cùng lúc
  // là lỗi "Path collision".
  const top = [...new Set(paths.map(sourcePath))];
  const keep = top.filter((p) => !top.some((o) => o !== p && p.startsWith(`${o}.`)));
  const projection = JSON.stringify(Object.fromEntries(keep.map((p) => [p, 1])));
  // Lật trang theo _id (keyset) — xem withIdCursor.
  let lastId: unknown;
  for (;;) {
    const r = await findMongo(v.connectionId, v.db, v.object, {
      filter: lastId === undefined ? filter : withIdCursor(filter, lastId),
      projection, sort: '{"_id":1}', limit: PAGE, skip: 0,
    });
    const rows = parseRows(r.docs);
    for (const d of rows) col.add(d);
    const next = rows.length ? rows[rows.length - 1]._id : undefined;
    if (!r.hasMore || next === undefined || JSON.stringify(next) === JSON.stringify(lastId)) return;
    lastId = next;
  }
}

async function scanPg(v: QueryVar, sql: string, col: Collector): Promise<void> {
  const inner = sql.trim().replace(/;+\s*$/, '');
  // ORDER BY 1 cho thứ tự ổn định giữa các trang; cột đầu không sắp được (json…) thì bỏ.
  let order = ' ORDER BY 1';
  for (let offset = 0; ; offset += PG_PAGE) {
    const run = () => queryPg(v.connectionId, v.db, `SELECT * FROM (\n${inner}\n) __v${order} LIMIT ${PG_PAGE} OFFSET ${offset}`);
    let r;
    try { r = await run(); }
    catch (e) {
      if (!order || offset > 0) throw e;
      order = '';
      r = await run();
    }
    for (const d of parseRows(r.rows)) col.add(d);
    if (r.rows.length < PG_PAGE) return;
  }
}

// ── Resolve ────────────────────────────────────────────────────────────────────

export interface VarStat {
  name: string;
  path: string;
  count: number;
  /** Số dòng query nguồn đã quét. */
  scanned: number;
  tookMs: number;
}

export interface ResolveResult {
  text: string;
  stats: VarStat[];
}

const quoteOf = (kind: QueryVarKind) => (kind === 'pg' ? "'" : '"');

const pgLit = (x: Prim) => (typeof x === 'number' ? String(x) : typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : `'${x.replace(/'/g, "''")}'`);

/** Thay placeholder trong `text` bằng giá trị đã có. */
function substitute(text: string, quote: '"' | "'", lookup: (r: VarRef) => Prim[]): string {
  const refs = findRefs(text, quote);
  let out = '';
  let at = 0;
  for (const r of refs) {
    const vals = lookup(r);
    const label = `{{${r.name}${r.path ? `.${r.path}` : ''}}}`;
    let rep: string;
    if (r.inString === null) {
      rep = quote === "'" ? (vals.length ? vals.map(pgLit).join(', ') : 'NULL') : JSON.stringify(vals);
    } else {
      if (!vals.length) throw new Error(`${label} không có giá trị nào (query nguồn không trả dòng nào có field này)`);
      if (r.inString === 'whole') rep = quote === "'" ? pgLit(vals[0]) : JSON.stringify(vals[0]);
      else rep = quote === "'" ? String(vals[0]).replace(/'/g, "''") : JSON.stringify(String(vals[0])).slice(1, -1);
    }
    out += text.slice(at, r.start) + rep;
    at = r.end;
  }
  return out + text.slice(at);
}

/**
 * Chạy các biến mà `text` cần (kể cả biến mà biến đó cần), rồi trả `text` đã thay.
 * `quote`: `"` khi `text` là JSON (body ES / filter Mongo), `'` khi là SQL.
 * Lỗi luôn có tiền tố tên biến để biết hỏng ở đâu.
 */
export async function resolveVars(
  text: string,
  vars: QueryVar[],
  opts: { quote?: '"' | "'"; onProgress?: (msg: string) => void } = {},
): Promise<ResolveResult> {
  const quote = opts.quote ?? '"';
  if (!hasRefs(text)) return { text, stats: [] };
  const byName = new Map(vars.map((v) => [v.name, v]));
  const pathOf = (r: VarRef) => r.path || byName.get(r.name)?.field.trim() || '';

  // 1. Các field cần của từng biến + kiểm tra khai báo / vòng lặp.
  const need = new Map<string, Set<string>>();
  const visit = (src: string, q: '"' | "'", stack: string[]) => {
    for (const r of findRefs(src, q)) {
      const v = byName.get(r.name);
      if (!v) throw new Error(`Biến {{${r.name}}} chưa được khai báo (mở "𝑥 Biến" để thêm)`);
      if (stack.includes(r.name)) throw new Error(`Biến tham chiếu vòng: ${[...stack, r.name].join(' → ')}`);
      const p = pathOf(r);
      if (!p) throw new Error(`{{${r.name}}} không ghi field và biến cũng chưa khai field mặc định — viết {{${r.name}.tên_field}}`);
      const first = !need.has(r.name);
      if (first) need.set(r.name, new Set());
      need.get(r.name)!.add(p);
      if (first) {
        const problem = queryVarProblem(v, vars);
        if (problem) throw new Error(`Biến ${r.name}: ${problem}`);
        visit(v.query, quoteOf(v.kind), [...stack, r.name]);
      }
    }
  };
  visit(text, quote, []);

  // 2. Chạy mỗi biến đúng một lần; biến phụ thuộc chờ biến nó cần. Các nhánh độc lập chạy song song.
  const runs = new Map<string, Promise<{ sets: Map<string, Prim[]>; stat: Omit<VarStat, 'path' | 'count'> }>>();
  const values = new Map<string, Map<string, Prim[]>>();
  const exec = (name: string) => {
    let p = runs.get(name);
    if (!p) {
      p = (async () => {
        const v = byName.get(name)!;
        const q = quoteOf(v.kind);
        const deps = [...new Set(findRefs(v.query, q).map((r) => r.name))];
        await Promise.all(deps.map(exec));
        const query = substitute(v.query, q, (r) => values.get(r.name)?.get(pathOf(r)) ?? []);
        const paths = [...need.get(name)!];
        const col = new Collector(v, paths);
        opts.onProgress?.(`Đang chạy biến ${name}…`);
        const t0 = Date.now();
        try {
          if (v.kind === 'es') await scanEs(v, query, paths, col);
          else if (v.kind === 'mongo') await scanMongo(v, query, paths, col);
          else await scanPg(v, query, col);
        } catch (e) {
          throw new Error(`Biến ${name}: ${(e as Error).message}`);
        }
        const sets = new Map([...col.sets].map(([k, m]) => [k, [...m.values()]]));
        values.set(name, sets);
        return { sets, stat: { name, scanned: col.scanned, tookMs: Date.now() - t0 } };
      })();
      runs.set(name, p);
    }
    return p;
  };
  const done = await Promise.all([...need.keys()].map(exec));

  const stats: VarStat[] = [];
  for (const { sets, stat } of done) {
    for (const [path, list] of sets) stats.push({ ...stat, path, count: list.length });
  }
  return { text: substitute(text, quote, (r) => values.get(r.name)?.get(pathOf(r)) ?? []), stats };
}

/** "q1.tenantId: 37 giá trị (quét 120 dòng, 85ms)" — dòng tóm tắt cho thanh trạng thái. */
export function describeStats(stats: VarStat[]): string {
  return stats
    .map((s) => `${s.name}.${s.path}: ${s.count.toLocaleString('en-US')} giá trị (quét ${s.scanned.toLocaleString('en-US')} dòng, ${s.tookMs}ms)`)
    .join(' · ');
}
