// Gợi ý SQL cho ô query của tab PostgreSQL — hàm THUẦN, không đụng DOM.
//
// Vì sao tách khỏi component: đây là phần dễ sai âm thầm nhất (cắt từ đang gõ,
// đoán ngữ cảnh, xếp hạng), mà sai thì biểu hiện chỉ là "gợi ý hơi ngu" chứ
// không ném lỗi — không ai phát hiện. Ở đây thì scripts/check-sql-complete.ts
// kiểm được từng ca bằng chuỗi vào/ra, không cần mở app.
//
// Thiết kế bám đúng thói quen IDE:
//   · gõ `se`        → SELECT          (tiền tố, không phân biệt hoa thường)
//   · gõ `WHERE ten` → cột `tenantId`  (sau WHERE ưu tiên CỘT, không phải từ khoá)
//   · gõ `FROM `     → bảng            (sau FROM/JOIN/UPDATE/INTO ưu tiên BẢNG)
//   · khớp rời rạc   → `tid` cũng ra `tenantId`, nhưng xếp sau khớp tiền tố

/** Một mục gợi ý đã sẵn sàng để vẽ. */
export interface SqlSuggestion {
  /** Chuỗi thay vào ô. */
  value: string;
  /** Nhãn hiển thị (thường trùng `value`). */
  label: string;
  /** Loại — UI dùng để chọn icon/màu. */
  kind: 'keyword' | 'column' | 'table' | 'function';
  /** Chú thích bên phải: kiểu dữ liệu của cột, schema của bảng… */
  detail?: string;
  /**
   * Chuỗi ghép THÊM sau khi nhận, con trỏ lùi lại `caretBack` ký tự.
   * Ví dụ cột sau WHERE: nhận `tenantId` rồi tự thêm ` = ''` và đặt con trỏ
   * vào giữa hai nháy — đúng ý "tự động fill field".
   */
  append?: string;
  /** Lùi con trỏ bấy nhiêu ký tự sau khi chèn `append`. */
  caretBack?: number;
}

/** Bảng dùng cho gợi ý — chỉ cần hai trường này. */
export interface SqlTableRef {
  schema: string;
  name: string;
}

/** Cột dùng cho gợi ý. */
export interface SqlColumnRef {
  name: string;
  dataType: string;
}

/**
 * Từ khoá SQL hay dùng nhất khi soi dữ liệu. Viết HOA vì đó là quy ước đọc.
 *
 * THỨ TỰ TRONG MẢNG LÀ ĐỘ PHỔ BIẾN, và nó được dùng làm tiêu chí xếp hạng
 * (xem `_ord` trong completeSql) — không phải trang trí. Nếu xếp theo bảng chữ
 * cái hay theo độ dài thì gõ `se` sẽ ra `SET` trước `SELECT` (ngắn hơn, đứng
 * trước theo alphabet) — sai hoàn toàn thứ người ta muốn 99% số lần.
 */
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL',
  'LIKE', 'ILIKE', 'BETWEEN', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'ON', 'AS',
  'DISTINCT', 'UNION', 'UNION ALL', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'ASC', 'DESC', 'WITH', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'RETURNING', 'COALESCE', 'NULLIF', 'CAST',
];

/** Hàm tổng hợp — tách khỏi KEYWORDS để gắn sẵn cặp ngoặc khi nhận. */
const FUNCTIONS = [
  'count', 'sum', 'avg', 'min', 'max', 'now', 'date_trunc', 'to_char',
  'to_timestamp', 'extract', 'length', 'lower', 'upper', 'trim', 'json_agg',
];

/**
 * Từ đang gõ tại vị trí con trỏ: đoạn [đầu-từ, caret).
 *
 * Ranh giới là mọi thứ KHÔNG phải chữ/số/_/$/. — dấu chấm nằm trong từ để
 * `public.use` còn biết đường gợi ý tiếp, còn `"` KHÔNG tính là ký tự từ nên
 * gõ trong ngoặc kép vẫn ra gợi ý.
 */
export function wordAt(text: string, caret: number): { word: string; start: number } {
  let start = Math.max(0, Math.min(caret, text.length));
  while (start > 0 && /[A-Za-z0-9_$.]/.test(text[start - 1])) start--;
  return { word: text.slice(start, caret), start };
}

/**
 * Từ khoá ĐỨNG NGAY TRƯỚC từ đang gõ (đã hoa hoá), để đoán "chỗ này cần gì".
 * Trả '' khi đầu câu.
 */
export function prevKeyword(text: string, wordStart: number): string {
  const before = text.slice(0, wordStart);
  // Dấu phẩy ngay trước = đang liệt kê tiếp (cột trong SELECT, cột trong SET).
  if (/,\s*$/.test(before)) return ',';
  // Hai từ cuối: đủ bắt các cụm hai chữ ('ORDER BY', 'LEFT JOIN', 'INSERT INTO')
  // mà không phải tách câu đầy đủ.
  const toks = before.trim().split(/[\s(,]+/).filter(Boolean);
  if (!toks.length) return '';
  const last = (toks[toks.length - 1] ?? '').toUpperCase();
  const prev2 = toks.length > 1 ? `${(toks[toks.length - 2] ?? '').toUpperCase()} ${last}` : '';
  const TWO = ['ORDER BY', 'GROUP BY', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN',
    'INSERT INTO', 'DELETE FROM', 'UNION ALL'];
  if (TWO.includes(prev2)) return prev2;
  return last;
}

/** Sau mấy từ này thì người ta đang gõ TÊN BẢNG. */
const WANT_TABLE = new Set(['FROM', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
  'FULL JOIN', 'UPDATE', 'INSERT INTO', 'DELETE FROM', 'INTO']);

/** Sau mấy từ này thì người ta đang gõ TÊN CỘT. */
const WANT_COLUMN = new Set(['SELECT', 'WHERE', 'AND', 'OR', 'NOT', 'ON',
  'ORDER BY', 'GROUP BY', 'HAVING', 'SET', 'DISTINCT', 'RETURNING', ',']);

/** Sau mấy từ này thì cột nhận được sẽ tự thêm ` = …` (fill field). */
const WANT_PREDICATE = new Set(['WHERE', 'AND', 'OR', 'ON', 'SET', 'HAVING']);

/**
 * Chấm điểm một ứng viên với chuỗi đang gõ.
 * -1 = không khớp. Điểm CÀNG NHỎ càng khớp sát (sort tăng dần).
 *
 *   0  trùng tiền tố, đúng cả hoa thường  (`ten` → `tenantId`)
 *   1  trùng tiền tố, khác hoa thường     (`se`  → `SELECT`)
 *   2  khớp rời rạc (subsequence)         (`tid` → `tenantId`)
 */
export function score(cand: string, typed: string): number {
  if (!typed) return 1;
  const c = cand.toLowerCase();
  const t = typed.toLowerCase();
  if (cand.startsWith(typed)) return 0;
  if (c.startsWith(t)) return 1;
  // Subsequence: mọi ký tự của `typed` xuất hiện đúng thứ tự trong `cand`.
  let i = 0;
  for (const ch of c) {
    if (ch === t[i]) i++;
    if (i === t.length) break;
  }
  return i === t.length ? 2 : -1;
}

export interface CompleteCtx {
  text: string;
  caret: number;
  columns?: SqlColumnRef[];
  tables?: SqlTableRef[];
  /** Trần số gợi ý trả về. */
  limit?: number;
}

/**
 * Giá trị mẫu điền sau một cột trong mệnh đề điều kiện — phần "tự động fill
 * field": nhận `tenantId` trong `WHERE` là ra luôn `tenantId = ''` với con trỏ
 * nằm giữa hai nháy, gõ tiếp giá trị là xong.
 *
 * Kiểu số/boolean thì KHÔNG thêm nháy — thêm vào là câu lệnh sai ngay.
 */
function predicateAppend(dataType: string): { append: string; caretBack: number } {
  const t = (dataType || '').toLowerCase();
  if (/int|numeric|decimal|real|double|serial|money/.test(t)) return { append: ' = ', caretBack: 0 };
  if (/bool/.test(t)) return { append: ' = true', caretBack: 0 };
  return { append: " = ''", caretBack: 1 };
}

/**
 * Danh sách gợi ý cho vị trí con trỏ hiện tại.
 *
 * Trả rỗng khi không có gì đáng gợi (giữa câu, chưa gõ chữ nào) — UI dựa vào đó
 * để ẩn hẳn bảng gợi ý thay vì hiện một danh sách dài vô nghĩa.
 */
export function completeSql(ctx: CompleteCtx): SqlSuggestion[] {
  const { text, caret } = ctx;
  const limit = ctx.limit ?? 12;
  const { word, start } = wordAt(text, caret);
  const prev = prevKeyword(text, start);

  // Chưa gõ ký tự nào: chỉ gợi ý khi vừa gõ xong một từ khoá cần tên (FROM,
  // WHERE…). Giữa câu mà bung cả trăm mục thì vướng mắt hơn là giúp.
  if (!word && !WANT_TABLE.has(prev) && !WANT_COLUMN.has(prev)) return [];

  const cols = ctx.columns ?? [];
  const tbls = ctx.tables ?? [];
  const out: (SqlSuggestion & { _s: number; _rank: number; _ord: number })[] = [];
  const push = (s: SqlSuggestion, sc: number, rank: number, ord: number) => {
    if (sc < 0) return;
    out.push({ ...s, _s: sc, _rank: rank, _ord: ord });
  };

  // `_rank` là ưu tiên theo NGỮ CẢNH (nhỏ hơn = nổi lên trên), tách khỏi `_s`
  // là độ khớp chuỗi. Sau WHERE thì cột phải đứng trên từ khoá kể cả khi từ
  // khoá khớp sát hơn — đó chính là ca `WHERE ten` → `tenantId`.
  const wantCol = WANT_COLUMN.has(prev);
  const wantTbl = WANT_TABLE.has(prev);
  const colRank = wantCol ? 0 : 2;
  const tblRank = wantTbl ? 0 : 3;
  const kwRank = wantTbl || wantCol ? 1 : 0;

  // Cột/bảng giữ nguyên thứ tự schema trả về (thường là thứ tự định nghĩa,
  // tức `id` trước `createdAt` — hợp trực giác hơn xếp theo bảng chữ cái).
  cols.forEach((c, i) => {
    const extra = WANT_PREDICATE.has(prev) ? predicateAppend(c.dataType) : null;
    push({ value: c.name, label: c.name, kind: 'column', detail: c.dataType, ...(extra ?? {}) },
      score(c.name, word), colRank, i);
  });
  tbls.forEach((t, i) => {
    // Tên đủ điều kiện, dán thẳng vào câu lệnh được.
    const qualified = `"${t.schema}"."${t.name}"`;
    push({ value: qualified, label: t.name, kind: 'table', detail: t.schema },
      Math.max(score(t.name, word), score(`${t.schema}.${t.name}`, word)), tblRank, i);
  });
  KEYWORDS.forEach((k, i) => push({ value: k, label: k, kind: 'keyword' }, score(k, word), kwRank, i));
  FUNCTIONS.forEach((f, i) => push(
    { value: f, label: `${f}()`, kind: 'function', append: '()', caretBack: 1 },
    score(f, word), kwRank + 1, i));

  // `_ord` (thứ tự khai báo = độ phổ biến) đứng TRƯỚC độ dài: gõ `se` phải ra
  // SELECT, không phải SET — xem chú thích ở KEYWORDS.
  out.sort((a, b) => a._rank - b._rank
    || a._s - b._s
    || a._ord - b._ord
    || a.label.length - b.label.length
    || a.label.localeCompare(b.label));
  return out.slice(0, limit).map(({ _s: _s0, _rank: _r0, _ord: _o0, ...s }) => s);
}

/**
 * Áp một gợi ý vào chuỗi: thay từ đang gõ bằng `value` (+ `append`).
 * Trả chuỗi mới và vị trí con trỏ — caller set lại cả hai vào ô.
 */
export function applySuggestion(
  text: string,
  caret: number,
  s: SqlSuggestion,
): { text: string; caret: number } {
  const { start } = wordAt(text, caret);
  const insert = s.value + (s.append ?? '');
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length - (s.caretBack ?? 0) };
}
