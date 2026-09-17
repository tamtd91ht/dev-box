// scripts/check-mongo-query.ts — kiểm phần trợ lý gõ của ô query Mongo:
// autocomplete field (lib/mongoSuggest.ts) + phím Enter (lib/mongo.ts, smartEnter).
//
// VÌ SAO CÓ FILE NÀY: lỗi ở đây luôn hiện ra dưới dạng "chèn xong câu query
// hỏng" — thừa `: ""`, thừa dấu phẩy, mất dấu nháy, dòng mới nằm sai cấp — và
// mỗi ca chỉ tái hiện đúng ở MỘT vị trí con trỏ. Bấm thử trong app chỉ soát
// được ca mình nhớ ra; các ca còn lại đợi người dùng gặp.
//
// Các rủi ro chính bám theo những ca dưới đây:
//   1. Chèn cặp key-value vào chỗ ĐÃ có cặp → `{"tenant_id": "",: ""}`.
//   2. Dấu nháy: người dùng tự gõ `"` rồi chọn gợi ý → `{""tenant_id": ""}`.
//   3. Con trỏ không rơi vào chỗ gõ tiếp (trong nháy value, trong `{"$oid": ""}`).
//   4. Enter đẻ ra JSON hỏng: phẩy đuôi trước `]` (server parse EJSON thật,
//      không tha), thiếu phẩy giữa hai cặp, dòng mới lệch cấp thụt lề.
//
//   npx tsx scripts/check-mongo-query.ts

import type { FieldInfo } from '../lib/mongo';
import { formatJsonInput, smartEnter } from '../lib/mongo';
import { isInsideString } from '../lib/jsonEdit';
import { expandSnippet, FILTER_SNIPPETS, PIPELINE_SNIPPETS } from '../lib/mongoSnippets';
import { buildMatches, tokenAt } from '../lib/mongoSuggest';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string, extra?: string): void => {
  failures += 1;
  console.error(`✗ ${m}${extra ? `\n    ${extra}` : ''}`);
};

const FIELDS: FieldInfo[] = [
  { path: 'tenant_id', type: 'string', seen: 10 },
  { path: 'owner_id', type: 'objectId', seen: 10 },
  { path: 'age', type: 'number', seen: 10 },
  { path: 'createdAt', type: 'date', seen: 10 },
  { path: 'tags', type: 'array', seen: 10 },
];

/**
 * Viết ca kiểm bằng chuỗi có dấu `|` = vị trí con trỏ, cả đầu vào lẫn kỳ vọng.
 * `label` là mục được chọn trong danh sách gợi ý (đúng cái người dùng Enter).
 */
function pickCase(name: string, input: string, label: string, expected: string): void {
  const caret = input.indexOf('|');
  const value = input.replace('|', '');
  const token = tokenAt(value, caret);
  const matches = buildMatches(FIELDS, value, token);
  const m = matches.find((x) => x.label === label);
  if (!token || !m) {
    fail(name, `không có gợi ý "${label}" (có: ${matches.map((x) => x.label).join(', ') || 'rỗng'})`);
    return;
  }
  const next = value.slice(0, m.from) + m.insert + value.slice(m.to);
  const at = m.from + m.caretOffset;
  const got = `${next.slice(0, at)}|${next.slice(at)}`;
  if (got === expected) ok(name);
  else fail(name, `kỳ vọng ${JSON.stringify(expected)}\n    nhận về  ${JSON.stringify(got)}`);
}

/** Ca "không được gợi ý gì" — vd ô trống, hoặc từ không khớp field nào. */
function noneCase(name: string, input: string): void {
  const caret = input.indexOf('|');
  const value = input.replace('|', '');
  const matches = buildMatches(FIELDS, value, tokenAt(value, caret));
  if (matches.length === 0) ok(name);
  else fail(name, `kỳ vọng rỗng, nhận về ${matches.map((m) => m.insert).join(' | ')}`);
}

// ── 1. Khung `{"": ""}` do Enter bung ra — ca người dùng báo lỗi ─────────────
// Gõ `{` + Enter ra khung, gõ `tenant` vào nháy đầu, Enter chọn `tenant_id`.
// Trước đây ra `{\n  "tenant_id": "",: ""\n}`: thừa cả cặp cũ lẫn dấu phẩy.
pickCase(
  'khung có sẵn `: ""` → thay cả cặp, không đẻ thêm',
  '{\n  "tenant|": ""\n}',
  'tenant_id',
  '{\n  "tenant_id": "|"\n}',
);
pickCase(
  'khung có sẵn + field objectId → value thành {"$oid": ""}',
  '{\n  "own|": ""\n}',
  'owner_id',
  '{\n  "owner_id": {"$oid": "|"}\n}',
);
pickCase(
  'khung có sẵn + field số → value thành 0, con trỏ đứng trước để gõ đè',
  '{\n  "ag|": ""\n}',
  'age',
  '{\n  "age": |0\n}',
);
pickCase(
  'khung một dòng `{"": ""}` cũng vậy',
  '{"ten|": ""}',
  'tenant_id',
  '{"tenant_id": "|"}',
);
pickCase(
  'khoảng trắng lạ quanh dấu hai chấm vẫn nhận ra là cặp sẵn có',
  '{ "ten|"   :   "" }',
  'tenant_id',
  '{ "tenant_id": "|" }',
);

// ── 2. Value ĐÃ có nội dung → chỉ đổi tên key, không đạp lên cái đã gõ ───────
pickCase(
  'value đã gõ dở → chỉ thay tên field',
  '{"ten|": "t_123"}',
  'tenant_id',
  '{"tenant_id"|: "t_123"}',
);
pickCase(
  'value là object → chỉ thay tên field',
  '{"created|": {"$gte": {"$date": "2026-01-01T00:00:00Z"}}}',
  'createdAt',
  '{"createdAt"|: {"$gte": {"$date": "2026-01-01T00:00:00Z"}}}',
);

// ── 3. Chỗ TRỐNG (chưa có cặp) → chèn nguyên cặp như cũ ──────────────────────
pickCase(
  'ô trống trong `{}` → chèn cả cặp, con trỏ trong nháy value',
  '{ten|}',
  'tenant_id',
  '{"tenant_id": "|"}',
);
pickCase(
  'người dùng tự gõ dấu nháy mở → không dư nháy',
  '{"ten|',
  'tenant_id',
  '{"tenant_id": "|"',
);
pickCase(
  'field mảng → khuôn []',
  '{tag|}',
  'tags',
  '{"tags": [|]}',
);
pickCase(
  'đã có cặp phía sau, ngăn bằng dấu phẩy → không thêm phẩy nữa',
  '{ten|, "age": 1}',
  'tenant_id',
  '{"tenant_id": "|", "age": 1}',
);
pickCase(
  'còn nội dung dính ngay sau, chưa có phẩy → tự thêm phẩy',
  '{ten| "age": 1}',
  'tenant_id',
  '{"tenant_id": "|", "age": 1}',
);

// ── 4. Chỗ đặt GIÁ TRỊ → chỉ tên trần (vd `"$field"` của $group) ─────────────
pickCase(
  'sau dấu hai chấm → chèn tên trần, giữ nháy người dùng đã gõ',
  '{"_id": "ten|"}',
  'tenant_id',
  '{"_id": "tenant_id|"}',
);
pickCase(
  'sau dấu hai chấm, chưa có nháy → tên trần không nháy',
  '{"_id": ten|}',
  'tenant_id',
  '{"_id": tenant_id|}',
);

// ── 5. Toán tử `$…` ─────────────────────────────────────────────────────────
pickCase(
  'toán tử ở chỗ trống → cặp `"$gte": ""`',
  '{"age": {$gt|}}',
  '$gte',
  '{"age": {"$gte": "|"}}',
);
pickCase(
  'toán tử vào khung có sẵn `: ""` → không đẻ thêm cặp',
  '{"age": {"$gt|": ""}}',
  '$gte',
  '{"age": {"$gte": "|"}}',
);
pickCase(
  'toán tử nhận mảng → khuôn []',
  '{"tags": {$i|}}',
  '$in',
  '{"tags": {"$in": [|]}}',
);
pickCase(
  '$exists → khuôn true',
  '{"tags": {$exi|}}',
  '$exists',
  '{"tags": {"$exists": |true}}',
);

// ── 6. Không gợi ý ──────────────────────────────────────────────────────────
noneCase('ô trống → không gợi ý', '|');
noneCase('vừa mở ngoặc, chưa gõ chữ nào → không gợi ý', '{|}');
noneCase('từ không khớp field nào → không gợi ý', '{zzz|}');

// ── 7. Phím Enter (smartEnter) ──────────────────────────────────────────────

/** Ca Enter: cùng quy ước `|` = con trỏ, cho cả đầu vào lẫn kỳ vọng. */
function enterCase(name: string, input: string, expected: string): void {
  const caret = input.indexOf('|');
  const value = input.replace('|', '');
  const r = smartEnter(value, caret);
  if (!r) {
    fail(name, 'smartEnter trả null (Enter rơi về mặc định của trình duyệt)');
    return;
  }
  const got = `${r.text.slice(0, r.caret)}|${r.text.slice(r.caret)}`;
  if (got === expected) ok(name);
  else fail(name, `kỳ vọng ${JSON.stringify(expected)}\n    nhận về  ${JSON.stringify(got)}`);
}

/** Ca "để Enter xuống dòng như thường". */
function enterNullCase(name: string, input: string): void {
  const caret = input.indexOf('|');
  const r = smartEnter(input.replace('|', ''), caret);
  if (r === null) ok(name);
  else fail(name, `kỳ vọng null, nhận về ${JSON.stringify(r.text)}`);
}

// Hành vi cũ giữ nguyên: con trỏ ở cuối → đóng ngoặc hở + format.
enterCase('`{` rồi Enter → khung có sẵn cặp trống', '{|', '{\n  "|": ""\n}');
enterCase('`[` rồi Enter → khung mảng trống', '[|', '[\n  |\n]');
enterCase(
  'câu query một dòng, con trỏ ở cuối → format cả ô',
  '{"a":1,"b":2}|',
  '{\n  "a": 1,\n  "b": 2\n}|',
);

// Xuống dòng GIỮA câu query — phần người dùng báo: dòng mới phải đúng cấp.
enterCase(
  'cuối một cặp, phía sau là `}` → thêm phẩy + mở field mới cùng cấp',
  '{\n  "a": 1|\n}',
  '{\n  "a": 1,\n  "|": ""\n}',
);
enterCase(
  'giữa hai cặp → field mới có phẩy đuôi, không làm hỏng JSON',
  '{\n  "a": 1,|\n  "b": 2\n}',
  '{\n  "a": 1,\n  "|": "",\n  "b": 2\n}',
);
enterCase(
  'cặp lồng trong object con → thụt theo ĐỘ SÂU, không phải cột 0',
  '{\n  "a": {\n    "b": 1|\n  }\n}',
  '{\n  "a": {\n    "b": 1,\n    "|": ""\n  }\n}',
);
enterCase(
  'trong mảng → chỉ xuống dòng đúng cấp, KHÔNG tự thêm phẩy đuôi',
  '[\n  {\n    "$match": {}\n  }|\n]',
  '[\n  {\n    "$match": {}\n  }\n  |\n]',
);
// Câu chưa đóng ngoặc thì không format được → đi thẳng nhánh xuống dòng trần.
enterCase(
  'ngay trước dấu đóng cùng dòng → dấu đóng xuống dòng, lùi một cấp',
  '{"a": [1|]',
  '{"a": [1\n  |]',
);
enterCase(
  'giữa `{}` lồng bên trong → banh ba dòng, có sẵn cặp trống',
  '{\n  "a": {|}\n}',
  '{\n  "a": {\n    "|": ""\n  }\n}',
);
enterCase(
  'ô lệch lề / gõ dồn một dòng → Enter nắn lại cả ô rồi mới xuống dòng',
  '{"a":1,|"b":2}',
  '{\n  "a": 1,\n  "|": "",\n  "b": 2\n}',
);
// Ca người dùng báo: gõ xong dòng đầu rồi Enter. Con trỏ có thể đang ở BỐN chỗ
// khác nhau (trong chuỗi giá trị, sau nháy đóng, trước hoặc sau dấu phẩy vừa
// gõ) — cả bốn đều phải ra CÙNG một kết quả: field mới nằm TRONG `{}`.
enterCase(
  'gõ xong giá trị, con trỏ còn trong nháy → nhảy ra rồi mở field mới',
  '{\n  "tenant_id": "ab|c"\n}',
  '{\n  "tenant_id": "abc",\n  "|": ""\n}',
);
enterCase(
  'con trỏ ngay sau nháy đóng của giá trị',
  '{\n  "tenant_id": "abc"|\n}',
  '{\n  "tenant_id": "abc",\n  "|": ""\n}',
);
enterCase(
  'đã tự gõ dấu phẩy, con trỏ đứng TRƯỚC nó → không cắt dòng trước phẩy',
  '{\n  "tenant_id": "abc"|,\n}',
  '{\n  "tenant_id": "abc",\n  "|": ""\n}',
);
enterCase(
  'đã tự gõ dấu phẩy, con trỏ đứng SAU nó → không văng ra ngoài `}`',
  '{\n  "tenant_id": "abc",|\n}',
  '{\n  "tenant_id": "abc",\n  "|": ""\n}',
);
enterNullCase('chuỗi chưa đóng nháy → chịu, để Enter xuống dòng như thường', '{"a": "abc|');

// ── 8. Cả một PHIÊN GÕ, không phải từng hàm rời ─────────────────────────────
//
// Các ca trên soát từng hàm ở đúng một vị trí con trỏ. Ca người dùng báo lại
// nằm ở CHỖ NỐI: autocomplete đặt con trỏ ở đâu thì Enter kế tiếp mới xử đúng
// hay sai ở đó. Nên phần này gõ lại nguyên một câu query như người dùng gõ.

interface Box { text: string; caret: number; sel: number }

/** Gõ chữ — thay luôn đoạn đang bôi đen, đúng như textarea thật. */
function typeIn(b: Box, s: string): void {
  b.text = b.text.slice(0, b.caret) + s + b.text.slice(b.caret + b.sel);
  b.caret += s.length;
  b.sel = 0;
}

/**
 * Bấm Enter. Danh sách gợi ý đang mở thì Enter là CHỌN mục đầu (FieldSuggest
 * nghe ở capture phase và preventDefault); không thì mới tới smartEnter.
 */
function pressEnter(b: Box): void {
  const matches = buildMatches(FIELDS, b.text, tokenAt(b.text, b.caret));
  if (matches.length > 0) {
    const m = matches[0];
    b.text = b.text.slice(0, m.from) + m.insert + b.text.slice(m.to);
    b.caret = m.from + m.caretOffset;
    b.sel = m.selectLen;
    return;
  }
  const r = smartEnter(b.text, b.caret);
  if (r) { b.text = r.text; b.caret = r.caret; b.sel = 0; } else typeIn(b, '\n');
}

{
  const b: Box = { text: '', caret: 0, sel: 0 };
  typeIn(b, '{');       // mở ngoặc
  pressEnter(b);        //   → khung `{ "": "" }`
  typeIn(b, 'tenant');  // gõ tên field
  pressEnter(b);        //   → chọn tenant_id, con trỏ vào nháy value
  typeIn(b, 'abc');     // gõ giá trị
  pressEnter(b);        //   → CA BÁO LỖI: phải mở field mới TRONG `{}`
  typeIn(b, 'ag');
  pressEnter(b);        //   → chọn age (number), `0` được bôi đen sẵn
  typeIn(b, '30');      //   → gõ đè thành 30, không phải 300
  pressEnter(b);

  const want = '{\n  "tenant_id": "abc",\n  "age": 30,\n  "": ""\n}';
  const wantCaret = want.indexOf('"": ""') + 1;
  const got = `${b.text.slice(0, b.caret)}|${b.text.slice(b.caret)}`;
  const expected = `${want.slice(0, wantCaret)}|${want.slice(wantCaret)}`;
  if (got === expected) ok('phiên gõ: `{` → field → giá trị → field kế tiếp');
  else fail('phiên gõ: `{` → field → giá trị → field kế tiếp', `kỳ vọng ${JSON.stringify(expected)}\n    nhận về  ${JSON.stringify(got)}`);
}

// ── 9. Khung dựng sẵn trên thanh snippet ────────────────────────────────────
//
// Soát bằng BẤT BIẾN chứ không so từng chuỗi: khuôn còn được sửa dài dài, mà
// cái hỏng luôn là một trong ba điều dưới đây.
for (const s of [...FILTER_SNIPPETS, ...PIPELINE_SNIPPETS]) {
  const { text, caret, selectLen } = expandSnippet(s.src);
  const name = `khung "${s.label}"`;

  // 1. Chèn vào là ra JSON chạy được ngay (server parse EJSON thật, không tha).
  const f = formatJsonInput(text);
  if (f.error) { fail(`${name} — parse được`, f.error); } else ok(`${name} — parse được`);

  // 2. Đoạn bôi đen phải nằm TRONG chuỗi và không chứa dấu nháy: gõ đè xong
  //    vẫn còn nguyên cặp nháy (`"«field»"` → `"email"`, không phải `email`).
  if (selectLen > 0) {
    const sel = text.slice(caret, caret + selectLen);
    const inside = isInsideString(text, caret) && isInsideString(text, caret + selectLen);
    if (inside && !sel.includes('"')) ok(`${name} — chỗ bôi đen nằm trong nháy`);
    else fail(`${name} — chỗ bôi đen nằm trong nháy`, `bôi đen ${JSON.stringify(sel)}`);
  } else {
    // 3. Con trỏ trần phải rơi vào chỗ gõ tiếp được: giữa hai nháy của một
    //    chuỗi rỗng, hoặc trong một khối `{ }` / `[ ]` còn trống.
    const before = text.slice(0, caret).trimEnd().slice(-1);
    const after = text.slice(caret).trimStart().slice(0, 1);
    const emptyString = text[caret - 1] === '"' && text[caret] === '"';
    const emptySlot = (before === '{' && after === '}') || (before === '[' && after === ']');
    if (emptyString || emptySlot) ok(`${name} — con trỏ vào đúng chỗ gõ tiếp`);
    else fail(`${name} — con trỏ vào đúng chỗ gõ tiếp`, `…${JSON.stringify(text.slice(Math.max(caret - 12, 0), caret))}|${JSON.stringify(text.slice(caret, caret + 12))}…`);
  }
}

console.log(failures === 0 ? '\nTất cả ca đều đạt.' : `\n${failures} ca KHÔNG đạt.`);
process.exit(failures === 0 ? 0 : 1);
