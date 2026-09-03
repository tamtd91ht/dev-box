// scripts/check-json-edit.ts — kiểm trợ lý gõ JSON của ô body raw (tab API).
//
// VÌ SAO CÓ FILE NÀY: lib/jsonEdit.ts sai thì triệu chứng là "con trỏ nhảy lung
// tung" hoặc "nó nuốt mất chữ tôi vừa gõ" — nhìn qua thì tưởng tay mình gõ hụt,
// và mỗi ca chỉ tái hiện được đúng ở một vị trí con trỏ cụ thể. Chạy tay không
// bao giờ soát hết được các vị trí đó.
//
// Ba rủi ro chính bám theo các ca dưới đây:
//   1. Bung khung ngay giữa một chuỗi — phá biến {{token}} của environment.
//   2. Enter đẻ field mới nhầm chỗ (trong mảng, giữa dòng) → JSON hỏng.
//   3. remapCaret trả sai ô → mỗi lần tự format là một lần mất chỗ đang gõ.
//
//   npx tsx scripts/check-json-edit.ts

import { formatText } from '../lib/format';
import {
  backspace, closeBracket, enclosing, enter, isInsideString, lineIndent,
  looksLikeJson, openBrace, openBracket, quote, remapCaret, type EditResult,
} from '../lib/jsonEdit';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string, extra?: string): void => {
  failures += 1;
  console.error(`✗ ${m}${extra ? `\n    ${extra}` : ''}`);
};
const check = (cond: boolean, m: string, extra?: string): void => (cond ? ok(m) : fail(m, extra));

/**
 * Viết ca kiểm bằng chuỗi có dấu `|` = vị trí con trỏ, cả đầu vào lẫn kỳ vọng.
 * Đọc ra là thấy ngay hành vi, khỏi đếm chỉ số bằng tay.
 */
const cut = (s: string): [string, number] => [s.replace('|', ''), s.indexOf('|')];
const show = (r: EditResult): string => `${r.text.slice(0, r.caret)}|${r.text.slice(r.caret)}`;

function expect(name: string, input: string, run: (t: string, p: number) => EditResult | null, want: string | null): void {
  const [text, pos] = cut(input);
  const got = run(text, pos);
  if (want === null) {
    check(got === null, `${name} — để trình duyệt gõ như thường`, got ? `nhưng đã chèn: ${show(got)}` : undefined);
    return;
  }
  if (!got) { fail(`${name}`, 'trả null, đáng lẽ phải xử lý'); return; }
  check(show(got) === want, name, `got: ${JSON.stringify(show(got))}\n    want: ${JSON.stringify(want)}`);
}

// ── 1. Gõ `{` → khung object chuẩn, con trỏ nằm trong nháy của key ──────────

expect('gõ { ở ô trống → khung { "": "" }', '|',
  (t, p) => openBrace(t, p, p), '{\n  "|": ""\n}');

expect('gõ { ở giá trị lồng nhau → khung thụt đúng cấp', '{\n  "a": |\n}',
  (t, p) => openBrace(t, p, p), '{\n  "a": {\n    "|": ""\n  }\n}');

// Khung sinh ra phải là JSON HỢP LỆ — không thì auto-format sẽ bó tay ngay từ
// ký tự đầu tiên người ta gõ.
{
  const [t, p] = cut('|');
  const r = openBrace(t, p, p)!;
  check(formatText('json', r.text).ok, 'khung { } sinh ra parse được (key rỗng vẫn là JSON hợp lệ)');
}

// ── 2. Trong chuỗi thì KHÔNG bung — cứu biến {{var}} ────────────────────────

expect('gõ { trong chuỗi (biến {{var}}) → không bung khung', '{\n  "tok": "|"\n}',
  (t, p) => openBrace(t, p, p), null);

check(isInsideString('{ "a": "x', 9), 'isInsideString: đang giữa chuỗi chưa đóng');
check(!isInsideString('{ "a": "x"', 10), 'isInsideString: chuỗi đã đóng thì ra ngoài');
check(!isInsideString('{ "a": "x\\"y" ', 14), 'isInsideString: dấu nháy escape \\" không tính là đóng');

// ── 3. Nháy kép: đóng cặp, nhảy qua, bọc phần bôi đen ───────────────────────

expect('gõ " ngoài chuỗi → ra cặp ""', '{\n  |\n}',
  (t, p) => quote(t, p, p), '{\n  "|"\n}');
expect('gõ " ngay trước nháy đóng → nhảy qua, không đẻ thêm', '{ "abc|" }',
  (t, p) => quote(t, p, p), '{ "abc"| }');
expect('gõ " trong chuỗi → chèn nháy đóng thật', '{ "ab|c }',
  (t, p) => quote(t, p, p), null);
{
  const r = quote('{ abc }', 2, 5)!;
  check(show(r) === '{ "abc"| }', 'gõ " khi đang bôi đen → bọc chuỗi quanh phần chọn', show(r));
}

// ── 4. Dấu đóng: nhảy qua thay vì đẻ trùng ──────────────────────────────────

expect('gõ } khi kế tiếp đã là } → nhảy qua', '{ "a": 1 |}',
  (t, p) => closeBracket(t, p, p, '}'), '{ "a": 1 }|');
expect('gõ ] khi kế tiếp không phải ] → gõ như thường', '[1, 2|',
  (t, p) => closeBracket(t, p, p, ']'), null);
expect('gõ } trong chuỗi → gõ như thường', '{ "a": "x|" }',
  (t, p) => closeBracket(t, p, p, '}'), null);

// ── 5. Enter: banh ngoặc, thêm field, giữ thụt lề ───────────────────────────

expect('Enter giữa {} rỗng → banh thành khối', '{|}',
  (t, p) => enter(t, p, p), '{\n  |\n}');

expect('Enter cuối một cặp key/value → thêm dấu phẩy + field mới',
  '{\n  "a": 1|\n}', (t, p) => enter(t, p, p), '{\n  "a": 1,\n  "|": ""\n}');

expect('Enter khi dòng đã có sẵn dấu phẩy → không thêm phẩy thứ hai',
  '{\n  "a": 1,|\n}', (t, p) => enter(t, p, p), '{\n  "a": 1,\n  "|": ""\n}');

expect('Enter sau một cặp trong object lồng → field mới đúng cấp thụt lề',
  '{\n  "o": {\n    "a": 1|\n  }\n}', (t, p) => enter(t, p, p),
  '{\n  "o": {\n    "a": 1,\n    "|": ""\n  }\n}');

expect('Enter trong MẢNG → chỉ xuống dòng, không đẻ field',
  '[\n  1|\n]', (t, p) => enter(t, p, p), '[\n  1\n  |\n]');

expect('Enter sau dòng mở object → thụt thêm một cấp',
  '{\n  "o": {|\n', (t, p) => enter(t, p, p), '{\n  "o": {\n    |\n');

expect('Enter giữa dòng (ngoài chuỗi) → chỉ xuống dòng, không chèn field',
  '{\n  "a": 1|23\n}', (t, p) => enter(t, p, p), '{\n  "a": 1\n  |23\n}');

expect('Enter giữa tên key → để mặc định, đừng đụng vào chuỗi đang gõ dở',
  '{\n  "a|bc": 1\n}', (t, p) => enter(t, p, p), null);

expect('Enter trong chuỗi đang mở → để mặc định',
  '{\n  "a": "dở dang|\n}', (t, p) => enter(t, p, p), null);

// Chuỗi thao tác thật: gõ { rồi Enter thêm field — kết quả phải parse được.
{
  let [t, p] = cut('|');
  let r = openBrace(t, p, p)!;
  // gõ tên key + value như người dùng
  t = r.text.slice(0, r.caret) + 'name' + r.text.slice(r.caret);
  p = r.caret + 4;
  const vAt = t.indexOf('""', p) + 1;
  t = t.slice(0, vAt) + 'Tam' + t.slice(vAt);
  p = t.indexOf('\n}', vAt); // cuối dòng cặp đầu tiên
  r = enter(t, p, p)!;
  const parsed = formatText('json', r.text);
  check(parsed.ok, 'gõ { → điền cặp → Enter: JSON vẫn hợp lệ', parsed.error);
  check(r.text.includes('"name": "Tam",'), 'cặp cũ được đóng bằng dấu phẩy', r.text);
}

// ── 6. Backspace xoá cả cặp vừa đóng tự động ────────────────────────────────

expect('Backspace giữa "" → xoá cả hai', '{ "a": "|" }',
  (t, p) => backspace(t, p, p), '{ "a": | }');
expect('Backspace giữa {} → xoá cả hai', '{|}',
  (t, p) => backspace(t, p, p), '|');
expect('Backspace chỗ không phải cặp → để mặc định', '{ "ab|c" }',
  (t, p) => backspace(t, p, p), null);

// ── 7. remapCaret: tự format mà con trỏ vẫn đứng đúng chỗ ───────────────────

{
  const before = '{"name":"Tam","age":3}';
  const after = formatText('json', before).text;
  // con trỏ đứng ngay sau chữ "Tam" (trước dấu nháy đóng)
  const at = before.indexOf('Tam') + 3;
  const mapped = remapCaret(before, at, after);
  check(after.slice(0, mapped).endsWith('Tam'), 'remapCaret: giữ con trỏ ngay sau giá trị đang gõ',
    `${JSON.stringify(after.slice(0, mapped))}`);
}
{
  const before = '{\n  "a": 1\n}';
  const after = '{"a":1}';
  check(remapCaret(before, 0, after) === 0, 'remapCaret: đầu file vẫn là đầu file');
  check(remapCaret(before, before.length, after) === after.length, 'remapCaret: cuối file vẫn là cuối file');
}
{
  // Khoảng trắng NẰM TRONG chuỗi bị bỏ qua ở cả hai bên nên vẫn khớp nhau.
  const before = '{"msg":"xin  chao","n":1}';
  const after = formatText('json', before).text;
  const at = before.indexOf('chao') + 4;
  const mapped = remapCaret(before, at, after);
  check(after.slice(0, mapped).endsWith('chao'), 'remapCaret: chuỗi có khoảng trắng bên trong không làm lệch');
}

// ── 8. Mấy hàm phụ ──────────────────────────────────────────────────────────

check(lineIndent('{\n    "a": 1', 8) === '    ', 'lineIndent: lấy đúng thụt lề dòng hiện tại');
check(enclosing('{ "a": [ 1, ', 12) === '[', 'enclosing: đang trong mảng');
check(enclosing('{ "a": [ 1 ], ', 14) === '{', 'enclosing: mảng đã đóng thì quay về object');
check(enclosing('{ "a": "[ ', 10) === '{', 'enclosing: ngoặc trong chuỗi không tính');
check(looksLikeJson('  {"a":1}') && looksLikeJson('[1]'), 'looksLikeJson: nhận object/mảng');
check(!looksLikeJson('a=1&b=2'), 'looksLikeJson: form-urlencoded thì bỏ qua');

// ── Kết ─────────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\ncheck:json-edit THẤT BẠI — ${failures} ca sai.`);
  process.exit(1);
}
console.log('\ncheck:json-edit OK — trợ lý gõ JSON hành xử đúng trên mọi ca đã soát.');
