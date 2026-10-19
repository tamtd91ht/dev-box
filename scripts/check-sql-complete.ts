// Kiểm gợi ý SQL của ô query tab PostgreSQL (lib/sqlComplete.ts).
//
// Vì sao cần: sai ở đây KHÔNG ném lỗi, nó chỉ làm gợi ý "hơi ngu" — gõ `WHERE
// ten` mà ra `THEN` thay vì cột `tenantId` thì người dùng chỉ thấy khó chịu chứ
// không biết là bug. Chạy: npm run check:sql

import { completeSql, applySuggestion, wordAt, prevKeyword, score } from '../lib/sqlComplete';
import type { SqlColumnRef, SqlTableRef } from '../lib/sqlComplete';

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

const COLS: SqlColumnRef[] = [
  { name: 'id', dataType: 'bigint' },
  { name: 'tenantId', dataType: 'text' },
  { name: 'tenantName', dataType: 'text' },
  { name: 'createdAt', dataType: 'timestamptz' },
  { name: 'isActive', dataType: 'boolean' },
  { name: 'amount', dataType: 'numeric' },
];
const TBLS: SqlTableRef[] = [
  { schema: 'public', name: 'users' },
  { schema: 'public', name: 'user_roles' },
  { schema: 'billing', name: 'invoices' },
];

/** Gợi ý với con trỏ đặt ở CUỐI chuỗi (ca thường gặp nhất khi đang gõ). */
const at = (text: string) => completeSql({ text, caret: text.length, columns: COLS, tables: TBLS });
const labels = (text: string) => at(text).map((s) => s.label);
const first = (text: string) => at(text)[0];

console.log('\n── Cắt từ đang gõ ───────────────────────────────────────────────');
check(wordAt('SELECT ten', 10).word === 'ten', 'wordAt: lấy đúng từ đang gõ');
check(wordAt('SELECT ten', 10).start === 7, 'wordAt: đúng vị trí bắt đầu từ');
check(wordAt('SELECT * FROM ', 14).word === '', 'wordAt: sau dấu cách là từ rỗng');
check(wordAt('a.b', 3).word === 'a.b', 'wordAt: dấu chấm nằm TRONG từ (public.users)');

console.log('\n── Đoán từ khoá đứng trước ──────────────────────────────────────');
check(prevKeyword('SELECT ten', 7) === 'SELECT', 'prevKeyword: SELECT');
check(prevKeyword('SELECT * FROM t WHERE ten', 22) === 'WHERE', 'prevKeyword: WHERE');
check(prevKeyword('SELECT * FROM t ORDER BY cre', 25) === 'ORDER BY', 'prevKeyword: cụm hai chữ ORDER BY');
check(prevKeyword('SELECT a, ', 10) === ',', 'prevKeyword: dấu phẩy = đang liệt kê tiếp');
check(prevKeyword('', 0) === '', 'prevKeyword: đầu câu trả rỗng');

console.log('\n── Chấm điểm khớp ──────────────────────────────────────────────');
check(score('tenantId', 'ten') === 0, 'score: trùng tiền tố đúng hoa thường = 0');
check(score('SELECT', 'se') === 1, 'score: trùng tiền tố khác hoa thường = 1');
check(score('tenantId', 'tid') === 2, 'score: khớp rời rạc = 2');
check(score('SELECT', 'xyz') === -1, 'score: không khớp = -1');

console.log('\n── Ca người dùng nêu #1: gõ `se` → SELECT ──────────────────────');
check(first('se')?.value === 'SELECT', `gõ "se" → gợi ý đầu là SELECT (được ${first('se')?.value ?? '∅'})`);
check(first('SE')?.value === 'SELECT', 'gõ "SE" hoa cũng ra SELECT');
check(first('sel')?.value === 'SELECT', 'gõ "sel" vẫn SELECT');

console.log('\n── Ca người dùng nêu #2: `WHERE ten` → cột tenantId ────────────');
const w = first('SELECT * FROM t WHERE ten');
check(w?.value === 'tenantId', `"WHERE ten" → cột tenantId đứng đầu (được ${w?.value ?? '∅'})`);
check(w?.kind === 'column', 'mục đó là CỘT, không phải từ khoá');
check(w?.append === " = ''", `cột text tự thêm " = ''" (được ${JSON.stringify(w?.append)})`);
check(w?.caretBack === 1, 'con trỏ lùi 1 để nằm GIỮA hai nháy');
// Toàn bộ chuỗi sau khi nhận — đúng thứ người dùng mô tả.
const applied = applySuggestion('SELECT * FROM t WHERE ten', 25, w!);
check(
  applied.text === "SELECT * FROM t WHERE tenantId = ''",
  `nhận xong ra: ${JSON.stringify(applied.text)}`,
);
check(applied.caret === applied.text.length - 1, 'con trỏ nằm giữa hai nháy, gõ tiếp là ra giá trị');

console.log('\n── Fill field theo KIỂU dữ liệu ────────────────────────────────');
const numeric = at('WHERE amo').find((s) => s.value === 'amount');
check(numeric?.append === ' = ', `cột số KHÔNG thêm nháy (được ${JSON.stringify(numeric?.append)})`);
const bool = at('WHERE isA').find((s) => s.value === 'isActive');
check(bool?.append === ' = true', `cột boolean ra " = true" (được ${JSON.stringify(bool?.append)})`);
const inSelect = at('SELECT ten').find((s) => s.value === 'tenantId');
check(!inSelect?.append, 'cột trong SELECT thì KHÔNG thêm " = …" (chỉ mệnh đề điều kiện mới thêm)');

console.log('\n── Ngữ cảnh: sau FROM thì ưu tiên BẢNG ─────────────────────────');
const f = first('SELECT * FROM use');
check(f?.kind === 'table', `"FROM use" → gợi ý đầu là BẢNG (được ${f?.kind ?? '∅'})`);
check(f?.value === '"public"."users"', `bảng dán vào là tên đủ điều kiện (được ${f?.value ?? '∅'})`);
check(labels('SELECT * FROM ').length > 0, 'gõ "FROM " (chưa có chữ) vẫn bung danh sách bảng');

console.log('\n── Ngữ cảnh: giữa câu, chưa gõ gì thì IM ───────────────────────');
check(at('').length === 0, 'ô rỗng: không gợi ý');
check(at('SELECT * FROM t ').length === 0, 'sau một câu hoàn chỉnh + dấu cách: không bung danh sách');

console.log('\n── Khớp rời rạc vẫn ra, nhưng xếp SAU khớp tiền tố ─────────────');
const sub = labels('WHERE tid');
check(sub.includes('tenantId'), `"tid" vẫn tìm ra tenantId (được ${sub.slice(0, 3).join(',')})`);
const pref = labels('WHERE tenantN');
check(pref[0] === 'tenantName', `"tenantN" → tenantName đứng đầu (được ${pref[0] ?? '∅'})`);

console.log('\n── Áp gợi ý vào GIỮA chuỗi, không nuốt phần đuôi ───────────────');
const mid = applySuggestion('SELECT ten FROM t', 10, { value: 'tenantId', label: 'tenantId', kind: 'column' });
check(mid.text === 'SELECT tenantId FROM t', `chèn giữa câu giữ nguyên đuôi (được ${JSON.stringify(mid.text)})`);
check(mid.caret === 15, 'con trỏ nằm ngay sau chuỗi vừa chèn');

console.log('\n── Hàm có sẵn cặp ngoặc ────────────────────────────────────────');
const fn = at('SELECT cou').find((s) => s.kind === 'function');
check(fn?.value === 'count' && fn?.append === '()', 'count → chèn "count()" ');
check(fn?.caretBack === 1, 'con trỏ nằm TRONG ngoặc');

console.log('\n── Trần số lượng ───────────────────────────────────────────────');
check(completeSql({ text: 'e', caret: 1, columns: COLS, tables: TBLS, limit: 5 }).length <= 5, 'tôn trọng limit');

console.log(failures ? `\n${failures} kiểm tra THẤT BẠI` : '\nTất cả kiểm tra ĐẠT');
process.exit(failures ? 1 : 0);
