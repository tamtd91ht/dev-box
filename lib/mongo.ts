// Client-side helpers + shared types for the MongoDB workspace. All calls go to
// the same-origin /api/mongo* routes (the Next server holds the driver client —
// the browser never connects to MongoDB directly). This file is browser-safe:
// NO `fs`, NO `mongodb`, no server-only imports.

// Dùng chung phần gõ JSON với ô body raw của tab API — cùng một bài toán "text
// đổi thì con trỏ đi đâu", không nên có hai bản lệch nhau.
import { isCompletePair, remapCaret } from './jsonEdit';

export type MongoScheme = 'mongodb' | 'mongodb+srv';

/** A connection as returned to the browser — password is never sent, only its presence. */
export interface PublicMongoConnection {
  id: string;
  name: string;
  project: string;
  scheme: MongoScheme;
  hosts: string[];
  replicaSet?: string;
  authSource?: string;
  username?: string;
  tls: boolean;
  directConnection: boolean;
  readOnly: boolean;
  hasPassword: boolean;
}

export interface MongoConnectionsResponse {
  enabled: boolean;
  /** MONGO_ALLOW_WRITE env flag — false greys out every write control up front. */
  allowWrite: boolean;
  connections: PublicMongoConnection[];
}

export interface TestResult {
  latencyMs: number;
  version: string;
  topology: string;
}

export interface ServerInfoResult extends TestResult {
  hosts: string[];
}

export interface MongoMemberStats {
  name: string;
  state: string;
  healthy: boolean;
  lagSec: number | null;
}

export interface MongoMonitorResult {
  uptimeSec: number;
  memResidentBytes: number;
  memVirtualBytes: number;
  fsUsedBytes: number | null;
  fsTotalBytes: number | null;
  connectionsCurrent: number;
  connectionsAvailable: number;
  cacheUsedBytes: number;
  cacheMaxBytes: number;
  opcounters: { insert: number; query: number; update: number; delete: number; command: number };
  at: number;
  members: MongoMemberStats[];
}

export interface DatabaseInfo {
  name: string;
  sizeOnDisk: number;
  empty: boolean;
}

export interface CollectionInfo {
  name: string;
  type: string;
}

export interface CollStatsResult {
  count: number;
  size: number;
  storageSize: number;
  avgObjSize: number;
  nindexes: number;
  totalIndexSize: number;
}

export interface IndexInfo {
  name: string;
  keyJson: string;
  unique: boolean;
  sparse: boolean;
  ttlSeconds?: number;
  partial: boolean;
}

export interface FieldInfo {
  path: string;
  type: string;
  seen: number;
}

export interface WireDoc {
  json: string;
  truncated: boolean;
}

export interface FindResult {
  docs: WireDoc[];
  limit: number;
  skip: number;
  hasMore: boolean;
  tookMs: number;
}

export interface CountResult {
  count: number;
  estimated: boolean;
  tookMs: number;
}

export interface AggregateResult {
  docs: WireDoc[];
  capped: boolean;
  tookMs: number;
}

export interface UpdateResult {
  matched: number;
  modified: number;
  mode: 'one' | 'many';
}

// ── Connection registry (CRUD) ────────────────────────────────────────────────

/** GET the connection list — never throws; returns disabled on any error. */
export async function fetchMongoConnections(): Promise<MongoConnectionsResponse> {
  try {
    const r = await fetch('/api/mongo-connections');
    if (!r.ok) return { enabled: false, allowWrite: false, connections: [] };
    return (await r.json()) as MongoConnectionsResponse;
  } catch {
    return { enabled: false, allowWrite: false, connections: [] };
  }
}

/** POST/PUT/DELETE a connection mutation. Throws Error(message) on a non-2xx. */
export async function mutateMongoConnection(
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<PublicMongoConnection[]> {
  const r = await fetch('/api/mongo-connections', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { connections: PublicMongoConnection[] }).connections;
}

// ── MongoDB operations ────────────────────────────────────────────────────────

/** POST one Mongo action. Throws Error(message) on a non-2xx (surfaces the driver error). */
async function mongoAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/mongo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

/** Test a not-yet-saved connection straight from the form. */
export function testMongoConnection(input: {
  scheme: MongoScheme;
  hosts: string;
  replicaSet?: string;
  authSource?: string;
  username?: string;
  password?: string;
  tls?: boolean;
  directConnection?: boolean;
}): Promise<TestResult> {
  return mongoAction<TestResult>('test', input);
}

export function pingMongo(connectionId: string): Promise<{ latencyMs: number }> {
  return mongoAction<{ latencyMs: number }>('ping', { connectionId });
}

export function mongoServerInfo(connectionId: string): Promise<ServerInfoResult> {
  return mongoAction<ServerInfoResult>('serverInfo', { connectionId });
}

export function mongoMonitor(connectionId: string): Promise<MongoMonitorResult> {
  return mongoAction<MongoMonitorResult>('monitor', { connectionId });
}

export function listMongoDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  return mongoAction<DatabaseInfo[]>('databases', { connectionId });
}

export function listMongoCollections(connectionId: string, db: string): Promise<CollectionInfo[]> {
  return mongoAction<CollectionInfo[]>('collections', { connectionId, db });
}

export function mongoCollectionStats(connectionId: string, db: string, coll: string): Promise<CollStatsResult> {
  return mongoAction<CollStatsResult>('stats', { connectionId, db, coll });
}

export function listMongoIndexes(connectionId: string, db: string, coll: string): Promise<IndexInfo[]> {
  return mongoAction<IndexInfo[]>('indexes', { connectionId, db, coll });
}

/** Sampled field paths of a collection — powers the query-bar autocomplete. */
export function sampleMongoFields(connectionId: string, db: string, coll: string): Promise<FieldInfo[]> {
  return mongoAction<FieldInfo[]>('fields', { connectionId, db, coll });
}

export interface FindParams {
  filter: string;
  projection: string;
  sort: string;
  limit: number;
  skip: number;
}

export function findMongo(connectionId: string, db: string, coll: string, p: FindParams): Promise<FindResult> {
  return mongoAction<FindResult>('find', { connectionId, db, coll, ...p });
}

export function countMongo(connectionId: string, db: string, coll: string, filter: string): Promise<CountResult> {
  return mongoAction<CountResult>('count', { connectionId, db, coll, filter });
}

/**
 * Ghép điều kiện cursor `_id > last` vào một filter EJSON để phân trang keyset.
 *
 * Vì sao BỌC $and thay vì nhét thẳng khoá `_id` vào object filter: filter là
 * EJSON người dùng tự gõ, có thể đã có sẵn `_id`, hoặc là `{$or: [...]}` ở cấp
 * cao nhất. Nhét thẳng sẽ ghi đè điều kiện của họ hoặc đổi nghĩa cả câu query.
 * `{$and: [<filter gốc>, {_id: {$gt: last}}]}` đúng với MỌI hình dạng filter.
 *
 * Dùng cho export: sort theo `_id` tăng dần rồi lật trang bằng `_id` của dòng
 * cuối — không dùng skip sâu dần (càng về sau Mongo càng phải bỏ qua nhiều
 * document, chậm dần đều trên collection lớn).
 */
export function withIdCursor(filter: string, lastId: unknown): string {
  const base = filter.trim();
  let parsed: unknown = {};
  if (base) {
    try { parsed = JSON.parse(base); } catch { return base; } // filter hỏng — để server báo lỗi
  }
  const hasFilter = parsed && typeof parsed === 'object' && Object.keys(parsed as object).length > 0;
  const cursor = { _id: { $gt: lastId } };
  return JSON.stringify(hasFilter ? { $and: [parsed, cursor] } : cursor);
}

export function aggregateMongo(connectionId: string, db: string, coll: string, pipeline: string): Promise<AggregateResult> {
  return mongoAction<AggregateResult>('aggregate', { connectionId, db, coll, pipeline });
}

export function updateMongo(
  connectionId: string,
  db: string,
  coll: string,
  p: { filter: string; update: string; mode: 'one' | 'many' },
): Promise<UpdateResult> {
  return mongoAction<UpdateResult>('update', { connectionId, db, coll, ...p });
}

// ── Small shared formatters (used by the workspace UI) ───────────────────────

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}

/** Pretty-print one wire document (relaxed EJSON string) for display. */
export function prettyDoc(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json; // truncated docs are not valid JSON — show raw
  }
}

// ── Query-bar JSON formatting ────────────────────────────────────────────────
// The query boxes accept what people actually paste: shell-style objects with
// unquoted keys, single quotes and trailing commas. `relaxedJsonParse` accepts
// those without ever calling eval — it rewrites the text into strict JSON, then
// hands it to JSON.parse (which stays the only thing that interprets it).

/** Rewrite lenient JSON5-ish text into strict JSON. Strings are copied verbatim. */
function strictify(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    // Strings: copy through, converting '…' to "…" with proper escaping.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let body = '';
      i++;
      for (; i < src.length && src[i] !== quote; i++) {
        if (src[i] === '\\') { body += src[i] + (src[i + 1] ?? ''); i++; continue; }
        body += src[i];
      }
      if (quote === '"') {
        out += `"${body}"`;
      } else {
        // Re-quoting '…' as "…": bare `"` must gain an escape, and `\'` must
        // lose one (\' is not a legal JSON escape).
        out += `"${body.replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"')}"`;
      }
      continue;
    }

    // Line / block comments — drop them.
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }

    // Bare identifier: a key (→ quote it) or a literal like true/null (→ keep).
    if (/[A-Za-z_$]/.test(ch)) {
      let word = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) { word += src[i]; i++; }
      const rest = src.slice(i);
      const isKey = /^\s*:/.test(rest);
      out += isKey ? `"${word}"` : word;
      i--;
      continue;
    }

    // Trailing comma before a closer.
    if (ch === ',' && /^\s*[}\]]/.test(src.slice(i + 1))) continue;

    out += ch;
  }
  return out;
}

/** Parse lenient JSON text. Throws the underlying SyntaxError when unfixable. */
export function relaxedJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (first) {
    try {
      return JSON.parse(strictify(text));
    } catch {
      throw first; // report the original, more meaningful position
    }
  }
}

export interface FormatResult {
  text: string;
  error: string | null;
}

/**
 * Pretty-print a query box. Empty text stays empty; invalid text is returned
 * unchanged with the parser message so the field never eats what you typed.
 */
export function formatJsonInput(text: string, indent = 2): FormatResult {
  if (!text.trim()) return { text, error: null };
  try {
    return { text: JSON.stringify(relaxedJsonParse(text), null, indent), error: null };
  } catch (e) {
    return { text, error: (e as Error).message };
  }
}

/** Collapse a query box onto one line (the inverse of Format). */
export function minifyJsonInput(text: string): FormatResult {
  if (!text.trim()) return { text, error: null };
  try {
    return { text: JSON.stringify(relaxedJsonParse(text)), error: null };
  } catch (e) {
    return { text, error: (e as Error).message };
  }
}

// ── Enter trong ô query: tự đóng ngoặc rồi format ────────────────────────────

/** Kết quả xử lý Enter. `null` = không can thiệp, để Enter xuống dòng như thường. */
export interface EnterFixResult {
  text: string;
  /** Vị trí con trỏ sau khi thay text. */
  caret: number;
}

/**
 * Đếm ngoặc/nháy còn hở của một đoạn JSON đang gõ dở.
 * Bỏ qua ngoặc nằm TRONG chuỗi — `{"a": "}"}` không phải là ngoặc hở.
 */
function scanOpen(src: string): { need: string; inString: boolean; quote: string } {
  const stack: string[] = [];
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] === ch) stack.pop();
    }
  }
  return { need: stack.reverse().join(''), inString: !!quote, quote };
}

/**
 * Enter trong ô query JSON: ĐÓNG NGOẶC CÒN HỞ rồi format lại.
 *
 * Gõ `{` rồi Enter thì ra thẳng khung nhiều dòng có sẵn cặp `"": ""` (con trỏ
 * nằm trong nháy, gõ tên field là xong); `[` rồi Enter ra khung mảng trống —
 * chứ không phải một dấu `{` lẻ cộng một dòng trống, vì người dùng dùng Enter
 * như "hoàn tất khối này".
 * Chỉ can thiệp khi đoạn đang gõ THẬT SỰ còn ngoặc hở và con trỏ ở cuối; mọi
 * trường hợp khác trả null để Enter xuống dòng như bình thường (còn cần xuống
 * dòng thủ công khi soạn pipeline nhiều tầng).
 *
 * @param text  Nội dung ô hiện tại.
 * @param caret Vị trí con trỏ.
 * @returns Text mới + vị trí con trỏ, hoặc null nếu không nên can thiệp.
 */
export function closeAndFormatOnEnter(text: string, caret: number): EnterFixResult | null {
  // Chỉ xử lý khi con trỏ ở cuối phần có nội dung — giữa dòng thì Enter là Enter.
  if (text.slice(caret).trim() !== '') return null;
  const head = text.slice(0, caret);
  if (!head.trim()) return null;

  const { need, inString } = scanOpen(head);
  // Đang ở giữa một chuỗi chưa đóng nháy → chưa phải lúc đóng khối.
  if (inString) return null;
  if (!need) {
    // Không hở gì: chỉ format lại cho gọn nếu parse được.
    const f = formatJsonInput(head.trim());
    if (f.error) return null;
    return skeletonIfEmpty(f.text) ?? { text: f.text, caret: f.text.length };
  }

  const closed = head.trim() + need;
  const f = formatJsonInput(closed);
  // Đóng ngoặc mà vẫn không parse được (vd `{"a"` thiếu value) → để nguyên.
  if (f.error) return null;

  return skeletonIfEmpty(f.text) ?? { text: f.text, caret: f.text.length };
}

/**
 * Kết quả là khối RỖNG → bung thành khung nhiều dòng để gõ tiếp ngay:
 * `{}` → `{\n  "": ""\n}` (con trỏ trong nháy đầu — gõ tên field là xong),
 * `[]` → `[\n  \n]` (con trỏ ở dòng giữa). Không rỗng → null (giữ format thường).
 */
function skeletonIfEmpty(text: string): EnterFixResult | null {
  // caret 5 = GIỮA hai nháy của key (`{\n  "|": ""`), không phải 4 (trước dấu
  // nháy mở). Lệch một ô ở đây là gõ tên field ra ngoài chuỗi: `{"tenant"": ""}`
  // — và autocomplete sau đó cũng chèn trật theo.
  if (/^\{\s*\}$/.test(text)) return { text: '{\n  "": ""\n}', caret: 5 };
  if (/^\[\s*\]$/.test(text)) return { text: '[\n  \n]', caret: 4 };
  return null;
}

// ── Enter GIỮA câu query: xuống dòng đã thụt lề sẵn ─────────────────────────

/** Một cấp thụt lề — bằng đúng cấp `JSON.stringify(x, null, 2)` sinh ra. */
const INDENT = '  ';
const indentOf = (depth: number): string => INDENT.repeat(Math.max(depth, 0));

/** Ký tự khác khoảng trắng gần nhất về phía trước `pos`. */
const prevNonSpace = (t: string, pos: number): string => {
  for (let i = pos - 1; i >= 0; i -= 1) if (!/\s/.test(t[i])) return t[i];
  return '';
};
/** Vị trí ký tự khác khoảng trắng đầu tiên từ `pos` trở đi (= t.length nếu hết). */
const nextNonSpaceAt = (t: string, pos: number): number => {
  let i = pos;
  while (i < t.length && /\s/.test(t[i])) i += 1;
  return i;
};

/**
 * Enter trong ô query — MỘT cửa duy nhất, gồm ba việc theo thứ tự:
 *
 *   1. Con trỏ ở cuối phần có nội dung → đóng ngoặc còn hở + format cả ô
 *      (closeAndFormatOnEnter, hành vi cũ: Enter = "hoàn tất khối này").
 *   2. Ô parse được → format lại cả ô rồi dời con trỏ theo. Đây là chỗ câu
 *      query lệch lề được nắn về chuẩn, kể cả khi nó vừa được dán vào hay gõ
 *      dồn một dòng.
 *   3. Xuống dòng THEO ĐỘ SÂU NGOẶC, không phải cột 0.
 *
 * Bước 3 đếm ngoặc còn hở chứ không chép thụt lề của dòng trên: dòng trên có
 * thể đang lệch (gõ tay, vừa dán vào), chép theo là nhân cái lệch ra cả ô.
 * Trong chuỗi thì trả null — Enter ở đó là ký tự xuống dòng thật, không phải
 * lúc bày bố cục.
 *
 * Ba ca riêng, đều nhắm vào "gõ tiếp được ngay" chứ không chỉ là xuống dòng:
 *   • Giữa `{}` → banh ba dòng, có sẵn `"": ""` để autocomplete bật lên.
 *   • Cuối một cặp `"key": value` trong object → thêm phẩy (cả phẩy đuôi nếu
 *     phía sau còn cặp khác) rồi mở dòng field mới.
 *   • Ngay trước `}`/`]` → dòng mới lùi một cấp, vì nó sẽ chứa dấu đóng.
 */
export function smartEnter(text: string, caret: number): EnterFixResult | null {
  // Con trỏ đang TRONG chuỗi: Enter ở đây nghĩa là "gõ xong giá trị rồi", chứ
  // không phải chèn ký tự xuống dòng vào giữa chuỗi — JSON không cho, mà đó lại
  // đúng là chỗ con trỏ nằm sau khi autocomplete chèn `"field": "|"`. Nhảy ra
  // sau nháy đóng rồi xử lý như thường. Chuỗi chưa đóng nháy thì chịu, trả null.
  const here = scanOpen(text.slice(0, caret));
  let from = caret;
  if (here.inString) {
    let i = caret;
    while (i < text.length && text[i] !== here.quote) i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) return null;
    from = i + 1;
  }

  const closed = closeAndFormatOnEnter(text, from);
  if (closed) return closed;

  // Nắn cả ô về chuẩn trước, rồi mới xuống dòng — có vậy dòng mới mới nằm đúng
  // cấp so với phần xung quanh. Parse không được thì cứ để nguyên mà xuống dòng.
  //
  // CHỈ nhận khi format đơn thuần xê dịch khoảng trắng: `remapCaret` neo con trỏ
  // theo số ký tự không-trắng đứng trước nó, nên format mà THÊM/BỚT ký tự thật
  // là con trỏ trượt đi. Ca kinh điển: vừa gõ dấu phẩy cuối dòng rồi Enter —
  // format bỏ phẩy đuôi, đếm hụt một ký tự, con trỏ văng ra ngoài dấu `}`.
  let t = text;
  let at = from;
  const f = formatJsonInput(text);
  const bare = (s: string): string => s.replace(/\s+/g, '');
  if (!f.error && f.text !== text && bare(f.text) === bare(text)) {
    at = remapCaret(text, from, f.text);
    t = f.text;
  }

  const nl = t.indexOf('\n', at);
  const lineEnd = nl === -1 ? t.length : nl;
  const line = t.slice(t.lastIndexOf('\n', at - 1) + 1, lineEnd);

  // Cuối dòng chỉ còn mỗi dấu phẩy → coi như con trỏ đã ở cuối dòng. Vừa gõ
  // phẩy xong mà Enter là muốn MỞ FIELD MỚI, không phải cắt dòng trước dấu phẩy
  // để nó nằm trơ một mình.
  if (t.slice(at, lineEnd).trim() === ',') at = lineEnd;

  const open = scanOpen(t.slice(0, at)).need;
  const depth = open.length;
  const prev = prevNonSpace(t, at);
  const nextAt = nextNonSpaceAt(t, at);
  const next = t[nextAt] ?? '';
  const atLineEnd = t.slice(at, lineEnd).trim() === '';
  const splice = (ins: string, until: number, caretIn: number): EnterFixResult =>
    ({ text: t.slice(0, at) + ins + t.slice(until), caret: at + caretIn });

  // 1. Giữa cặp ngoặc rỗng → banh ra, nuốt luôn khoảng trắng tới dấu đóng.
  if ((prev === '{' && next === '}') || (prev === '[' && next === ']')) {
    const body = prev === '{' ? `${indentOf(depth)}"": ""` : indentOf(depth);
    const ins = `\n${body}\n${indentOf(depth - 1)}`;
    return splice(ins, nextAt, 1 + indentOf(depth).length + (prev === '{' ? 1 : 0));
  }

  // 2. Cuối một cặp hoàn chỉnh trong object → mở sẵn field mới.
  //
  // Chỉ làm trong object. Trong MẢNG thì không tự thêm phẩy: phần tử cuối mà
  // thêm phẩy là ra phẩy đuôi trước `]`, mà server parse bằng EJSON.parse thật
  // — nó không tha phẩy đuôi như ô nhập. Xuống dòng đúng cấp là đủ.
  if (atLineEnd && open[0] === '}' && isCompletePair(line)) {
    const lead = /,\s*$/.test(line) ? '' : ',';
    // Phía sau còn cặp nữa thì cặp mới phải có phẩy đuôi, không thì hỏng JSON.
    const tail = next === '}' || next === '' ? '' : ',';
    return splice(`${lead}\n${indentOf(depth)}"": ""${tail}`, lineEnd, lead.length + 1 + indentOf(depth).length + 1);
  }

  // 3. Xuống dòng thường. Dấu đóng đang nằm NGAY SAU trên cùng dòng → nó sẽ bị
  // đẩy xuống dòng mới, nên dòng mới lùi một cấp. Dấu đóng ở dòng dưới rồi thì
  // giữ nguyên cấp — chỗ đó là để gõ phần tử/field tiếp theo.
  const closerFollows = (next === '}' || next === ']') && !t.slice(at, nextAt).includes('\n');
  const level = closerFollows ? depth - 1 : depth;
  return splice(`\n${indentOf(level)}`, at, 1 + indentOf(level).length);
}
