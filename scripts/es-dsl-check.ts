// Kiểm tra nhanh bộ gợi ý Query DSL — chạy: npx tsx scripts/es-dsl-check.ts
import { esQueryContext, esSuggestions, esBodySuggestions, type EsField } from '../lib/esDsl';

const FIELDS: EsField[] = [
  { path: 'sipNumber', type: 'text' },
  { path: 'sipNumber.keyword', type: 'keyword' },
  { path: 'createdAt', type: 'date' },
];

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
}

// ── Ca của bug: sửa TÊN FIELD trong term đã có giá trị ───────────────────────
// `{ "term": { "sipNum│": "value" } }` — chọn sipNumber.keyword phải chỉ thay
// tên key, KHÔNG kèm `: "$0"` (trước đây ra `"sipNumber.keyword": "": "value"`).
{
  const text = '{ "term": { "sipNum": "value" } }';
  const off = text.indexOf('sipNum') + 'sipNum'.length;
  const ctx = esQueryContext(text, off);
  check('keyOnly bật khi sau vùng thay thế là `:`', ctx.keyOnly, true);
  const hit = esSuggestions(ctx, FIELDS).find((s) => s.label === 'sipNumber.keyword');
  check('chèn key trần, không kèm giá trị', hit?.insert, '"sipNumber.keyword"');

  // Ráp lại text như monaco sẽ làm để thấy kết quả cuối.
  const applied = text.slice(0, ctx.replaceStart) + hit!.insert + text.slice(ctx.replaceEnd);
  check('text sau khi chèn', applied, '{ "term": { "sipNumber.keyword": "value" } }');
}

// ── Key MỚI (chưa có `:`) vẫn phải kèm giá trị mẫu ──────────────────────────
{
  const text = '{ "term": { "" } }';
  const off = text.indexOf('""') + 1; // con trỏ trong cặp nháy rỗng
  const ctx = esQueryContext(text, off);
  check('keyOnly tắt khi chưa có `:`', ctx.keyOnly, false);
  const hit = esSuggestions(ctx, FIELDS).find((s) => s.label === 'sipNumber.keyword');
  check('key mới vẫn kèm giá trị mẫu', hit?.insert, '"sipNumber.keyword": "$0"');
}

// ── Đổi tên key cấp body (`"size": 10` → chọn "from") ───────────────────────
{
  const text = '{ "size": 10 }';
  const off = text.indexOf('size') + 4;
  const ctx = esQueryContext(text, off);
  const hit = esBodySuggestions(ctx, FIELDS).find((s) => s.label === 'from');
  check('option cấp body cũng chèn key trần', hit?.insert, '"from"');
}

// ── Giá trị (không phải key) không bị cắt ───────────────────────────────────
{
  const text = '{ "query": { "match": { "sipNumber": "" } } }';
  const off = text.lastIndexOf('""') + 1;
  const ctx = esQueryContext(text, off);
  check('đang gõ GIÁ TRỊ thì keyOnly tắt', ctx.keyOnly, false);
}

console.log(fails === 0 ? '\nTất cả đều đạt.' : `\n${fails} ca lỗi.`);
process.exit(fails === 0 ? 0 : 1);
