// scripts/check-es-export.ts — kiểm đường XUẤT BÁO CÁO của tab Elasticsearch.
//
// VÌ SAO CÓ FILE NÀY: tính năng xuất ES vừa chết sạch vì MỘT khoá sort tự chèn
// vào body (`_id` làm khoá phá hoà cho search_after). Không ai soát được khoá
// đó — nó nằm trong code, không hiện trên màn hình — và cụm trả về đúng một
// câu "all shards failed" nên cũng không lần ra. Hai bài học thành hai nhóm ca
// dưới đây:
//
//   1. buildScrollBody: body gửi đi phải ĐÚNG NHỮNG GÌ KHAI, không tự thêm sort
//      và phải bỏ sạch những khoá không đi chung với scroll (from/search_after/
//      aggs). Sort rỗng = KHÔNG sort, không phải "sort mặc định gì đó".
//   2. esErrorMessage: lỗi ES phải lòi ra NGUYÊN NHÂN GỐC, không dừng ở câu
//      "all shards failed".
//
//   npx tsx scripts/check-es-export.ts

import { buildScrollBody, esErrorMessage, SEARCH_SIZE_MAX } from '../lib/esClient';
import { smartEnter } from '../lib/mongo';
import { tokenAt } from '../lib/mongoSuggest';
import { buildSortMatches } from '../lib/esSortSuggest';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string, extra?: string): void => {
  failures += 1;
  console.error(`✗ ${m}${extra ? `\n    ${extra}` : ''}`);
};
const eq = (name: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(name);
  else fail(name, `kỳ vọng ${JSON.stringify(want)}\n    nhận về  ${JSON.stringify(got)}`);
};

// ── 1. Body của một vòng scroll ─────────────────────────────────────────────

{
  const body = buildScrollBody({ query: '{"term":{"tenant":"t1"}}', size: 200 });
  eq('query rời đi thẳng vào body', body.query, { term: { tenant: 't1' } });
  eq('KHÔNG tự chèn sort (đây là lỗi làm chết cả tính năng)', body.sort, undefined);
  eq('không có search_after — scroll không dùng con trỏ sort', body.search_after, undefined);
  eq('size theo khai báo', body.size, 200);
}

eq('không khai query → match_all, không phải body rỗng',
  buildScrollBody({}).query, { match_all: {} });

{
  const body = buildScrollBody({ sort: '[{"created_at":"desc"}]' });
  eq('sort người dùng khai đi nguyên vào body', body.sort, [{ created_at: 'desc' }]);
}
{
  const body = buildScrollBody({ sort: '{"created_at":"desc"}' });
  eq('sort khai kiểu object đơn được bọc thành mảng', body.sort, [{ created_at: 'desc' }]);
}

// Body nguyên bản của tab Dữ liệu: giữ query, bỏ những khoá không hợp với scroll.
{
  const raw = JSON.stringify({
    query: { match_all: {} },
    sort: [{ '@timestamp': 'desc' }],
    aggs: { theo_ngay: { date_histogram: { field: '@timestamp' } } },
    from: 9980,
    size: 20,
    track_total_hits: true,
    search_after: [123],
  });
  const body = buildScrollBody({ body: raw, sort: '', source: '["a","b"]', size: 200 });
  eq('giữ nguyên query của body', body.query, { match_all: {} });
  eq('bỏ aggs — xuất là bảng dòng', body.aggs, undefined);
  eq('bỏ from — scroll không đi chung với from', body.from, undefined);
  eq('bỏ search_after còn sót trong body', body.search_after, undefined);
  eq('bỏ track_total_hits', body.track_total_hits, undefined);
  eq('ô sort để TRỐNG thì bỏ luôn sort trong body (người dùng đã xoá)', body.sort, undefined);
  eq('_source theo cột đã khai', body._source, ['a', 'b']);
  eq('size của lần xuất đè size trong body', body.size, 200);
}
{
  const raw = JSON.stringify({ query: { match_all: {} }, sort: [{ a: 'asc' }] });
  const body = buildScrollBody({ body: raw, sort: '[{"b":"desc"}]' });
  eq('ô sort của modal đè sort trong body', body.sort, [{ b: 'desc' }]);
}

// Trần size: server vẫn là chốt cuối dù client gửi gì.
eq('size vượt trần bị kẹp lại', buildScrollBody({ size: 100000 }).size, SEARCH_SIZE_MAX);
eq('size rác → dùng trần', buildScrollBody({ size: 'abc' }).size, SEARCH_SIZE_MAX);
eq('size 0 không hợp lệ cho scroll → tối thiểu 1', buildScrollBody({ size: 0 }).size, 1);

// Chốt an toàn cũ vẫn giữ: scripting bị chặn kể cả trên đường xuất.
{
  let threw = '';
  try { buildScrollBody({ query: '{"script":{"source":"1"}}' }); } catch (e) { threw = (e as Error).message; }
  if (threw.includes('script')) ok('scripting vẫn bị chặn trên đường xuất');
  else fail('scripting vẫn bị chặn trên đường xuất', `ném ra: ${threw || '(không ném)'}`);
}

// ── 2. Thông điệp lỗi phải lòi ra nguyên nhân gốc ───────────────────────────

{
  // Đúng payload ES 8 trả về cho ca đã gặp: sort `_id` khi fielddata bị tắt.
  const payload = {
    error: {
      root_cause: [{
        type: 'illegal_argument_exception',
        reason: 'Fielddata access on the _id field is disallowed, you can re-enable it by updating the dynamic cluster setting: indices.id_field_data.enabled',
      }],
      type: 'search_phase_execution_exception',
      reason: 'all shards failed',
      failed_shards: [{ reason: { type: 'illegal_argument_exception', reason: 'Fielddata access on the _id field is disallowed' } }],
    },
  };
  const msg = esErrorMessage(payload, 400);
  if (msg.includes('all shards failed') && msg.includes('id_field_data.enabled')) ok('"all shards failed" đi kèm nguyên nhân gốc');
  else fail('"all shards failed" đi kèm nguyên nhân gốc', msg);
}

eq('không có root_cause thì lấy failed_shards',
  esErrorMessage({ error: { reason: 'all shards failed', failed_shards: [{ reason: { reason: 'circuit_breaking_exception' } }] } }, 500),
  'all shards failed — circuit_breaking_exception');
eq('caused_by cũng được lấy',
  esErrorMessage({ error: { reason: 'lỗi ngoài', caused_by: { reason: 'lỗi trong' } } }, 500),
  'lỗi ngoài — lỗi trong');
eq('nguyên nhân trùng câu ngoài thì không lặp lại',
  esErrorMessage({ error: { reason: 'x', root_cause: [{ reason: 'x' }] } }, 500), 'x');
eq('không parse được lỗi → còn mã HTTP', esErrorMessage({ raw: '<html>' }, 502), 'ES trả HTTP 502');
eq('chỉ có type → dùng type', esErrorMessage({ error: { type: 'index_not_found_exception' } }, 404), 'index_not_found_exception');

// ── 3. Ô SẮP XẾP: trợ lý gõ JSON + gợi ý field/chiều ────────────────────────
//
// Quy ước ca kiểm: `|` = con trỏ, `‹…›` = đoạn được bôi đen sau khi chèn.

const SORT_FIELDS = ['created_at', 'updated_at', 'doc_created', 'name.keyword'];

/** Chọn gợi ý `label` tại con trỏ, trả về text mới có đánh dấu con trỏ/bôi đen. */
function sortPick(name: string, input: string, label: string, expected: string): void {
  const caret = input.indexOf('|');
  const value = input.replace('|', '');
  const token = tokenAt(value, caret);
  const matches = buildSortMatches(SORT_FIELDS, value, token);
  const m = matches.find((x) => x.label === label);
  if (!m) {
    fail(name, `không có gợi ý "${label}" (có: ${matches.map((x) => x.label).join(', ') || 'rỗng'})`);
    return;
  }
  const next = value.slice(0, m.from) + m.insert + value.slice(m.to);
  const at = m.from + m.caretOffset;
  const got = m.selectLen
    ? `${next.slice(0, at)}‹${next.slice(at, at + m.selectLen)}›${next.slice(at + m.selectLen)}`
    : `${next.slice(0, at)}|${next.slice(at)}`;
  if (got === expected) ok(name);
  else fail(name, `kỳ vọng ${JSON.stringify(expected)}\n    nhận về  ${JSON.stringify(got)}`);
}

// Ô còn trống / trong mảng → phải chèn CẢ `{…}`, chèn trần vào giữa `[ ]` là JSON hỏng.
sortPick('ô trống: chèn cả object, bôi đen chiều để gõ đè', 'crea|', 'created_at', '{"created_at": "‹desc›"}');
sortPick('trong mảng: cũng chèn cả object', '[\n  crea|\n]', 'created_at', '[\n  {"created_at": "‹desc›"}\n]');
// Trong object rồi thì chỉ là cặp key-value.
sortPick('trong object: chỉ chèn cặp key-value', '[{ crea| }]', 'created_at', '[{ "created_at": "‹desc›" }]');
sortPick('khung `{"": ""}` có sẵn: thay cả cặp, không đẻ thêm',
  '{\n  "crea|": ""\n}', 'created_at', '{\n  "created_at": "‹desc›"\n}');

// Sau dấu `:` chỉ còn asc/desc — không gợi ý tên field ở đó.
sortPick('sau dấu hai chấm: gợi ý chiều, giữ nháy đã gõ',
  '[{"created_at": "de|"}]', 'desc', '[{"created_at": "desc|"}]');
sortPick('gõ `as` ra asc', '[{"created_at": "as|"}]', 'asc', '[{"created_at": "asc|"}]');
{
  const value = '[{"created_at": "d"}]';
  const names = buildSortMatches(SORT_FIELDS, value, tokenAt(value, value.indexOf('"}]'))).map((m) => m.label);
  eq('chỗ đặt giá trị KHÔNG gợi ý tên field', names, ['desc']);
}

// Khớp từ ĐẦU tên phải đứng trên.
{
  const names = buildSortMatches(SORT_FIELDS, 'crea', tokenAt('crea', 4)).map((m) => m.label);
  eq('khớp từ đầu tên xếp trước', names, ['created_at', 'doc_created']);
}

// Cả một PHIÊN GÕ: `[` → Enter → tên field → Enter → gõ đè chiều.
{
  let text = '[';
  let caret = 1;
  let sel = 0;
  const type = (t: string) => { text = text.slice(0, caret) + t + text.slice(caret + sel); caret += t.length; sel = 0; };
  const enter = () => {
    const matches = buildSortMatches(SORT_FIELDS, text, tokenAt(text, caret));
    if (matches.length) {
      const m = matches[0];
      text = text.slice(0, m.from) + m.insert + text.slice(m.to);
      caret = m.from + m.caretOffset;
      sel = m.selectLen;
      return;
    }
    const r = smartEnter(text, caret);
    if (r) { text = r.text; caret = r.caret; sel = 0; }
  };
  enter();          // `[` + Enter → khung mảng
  type('created');  // gõ tên field
  enter();          // → chọn created_at, `desc` được bôi đen sẵn
  type('asc');      // gõ đè chiều
  eq('phiên gõ: `[` → Enter → field → Enter → đổi chiều', text, '[\n  {"created_at": "asc"}\n]');
  eq('phiên gõ: kết quả là sort ES hợp lệ', JSON.parse(text), [{ created_at: 'asc' }]);
}

console.log(failures === 0 ? '\nTất cả ca đều đạt.' : `\n${failures} ca KHÔNG đạt.`);
process.exit(failures === 0 ? 0 : 1);
