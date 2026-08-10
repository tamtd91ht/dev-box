// Elasticsearch Query DSL — bảng tra cứu clause + bộ đoán ngữ cảnh dùng cho ô
// nhập query (components/es/QueryEditor.tsx). Thuần dữ liệu + hàm string:
// KHÔNG import monaco ở đây để file còn dùng được cho test/logic khác.
//
// Ba việc file này làm:
//   1. Mô tả các clause của Query DSL (bool/term/terms/match/range/…) kèm snippet
//      để gợi ý chèn sẵn khung JSON — giống trải nghiệm autocomplete của Kibana.
//   2. esQueryContext(): quét JSON đang gõ dở (JSON hỏng cũng quét được) để biết
//      con trỏ đang ở đâu — trong bool? trong mảng filter? đang gõ tên field? —
//      từ đó chỉ gợi ý đúng thứ hợp lệ tại chỗ đó.
//   3. flattenEsMapping(): trải mapping của index thành danh sách field path để
//      gợi ý tên field thật (cả sub-field kiểu `name.keyword`).

// ── Clause catalogue ─────────────────────────────────────────────────────────

export interface EsClauseSpec {
  name: string;
  /** Nhãn phụ hiện bên phải trong danh sách gợi ý. */
  detail: string;
  /** Mô tả ngắn (markdown) hiện ở panel doc. */
  doc: string;
  /** Phần JSON đứng sau `"name": ` — snippet syntax của monaco (${1:…}, $0). */
  body: string;
}

/** Clause truy vấn — hợp lệ ở gốc query, trong must/filter/should/must_not… */
export const ES_CLAUSES: EsClauseSpec[] = [
  {
    name: 'bool',
    detail: 'gộp nhiều điều kiện',
    doc: 'Gộp điều kiện: `filter` (AND, không tính điểm — nhanh nhất), `must` (AND, có tính điểm), `should` (OR), `must_not` (NOT).',
    body: '{\n  "filter": [\n    $0\n  ]\n}',
  },
  {
    name: 'term',
    detail: 'khớp CHÍNH XÁC 1 giá trị',
    doc: 'So khớp nguyên vẹn, **không phân tích** chuỗi. Dùng cho `keyword` / id / số / boolean.\n\n⚠ Với field `text` hãy dùng `match`, hoặc trỏ vào sub-field `field.keyword`.',
    body: '{ "${1:field}": "${2:value}" }',
  },
  {
    name: 'terms',
    detail: 'khớp 1 trong nhiều giá trị (IN)',
    doc: 'Như `term` nhưng nhận danh sách: document khớp nếu field bằng **một trong** các giá trị.',
    body: '{ "${1:field}": ["${2:a}", "${3:b}"] }',
  },
  {
    name: 'match',
    detail: 'tìm full-text',
    doc: 'Phân tích chuỗi tìm kiếm rồi khớp theo từ. Dùng cho field `text`.',
    body: '{ "${1:field}": "${2:text}" }',
  },
  {
    name: 'match_phrase',
    detail: 'khớp đúng cụm từ',
    doc: 'Các từ phải xuất hiện liền nhau, đúng thứ tự.',
    body: '{ "${1:field}": "${2:cụm từ}" }',
  },
  {
    name: 'match_phrase_prefix',
    detail: 'cụm từ, từ cuối là tiền tố',
    doc: 'Như `match_phrase` nhưng từ cuối cùng chỉ cần khớp tiền tố — hợp cho gợi ý khi gõ.',
    body: '{ "${1:field}": "${2:tiền tố}" }',
  },
  {
    name: 'multi_match',
    detail: 'match trên nhiều field',
    doc: 'Chạy `match` trên nhiều field một lúc. `fields` nhận cả wildcard (`"name.*"`) và boost (`"title^3"`).',
    body: '{\n  "query": "${1:text}",\n  "fields": ["${2:field_a}", "${3:field_b}"]\n}',
  },
  {
    name: 'range',
    detail: 'khoảng giá trị / thời gian',
    doc: '`gte` ≥ · `gt` > · `lte` ≤ · `lt` <. Với date dùng được date-math: `"now-7d/d"`.',
    body: '{\n  "${1:field}": {\n    "gte": "${2:now-7d/d}",\n    "lte": "${3:now}"\n  }\n}',
  },
  {
    name: 'exists',
    detail: 'field có giá trị',
    doc: 'Khớp document có field tồn tại và khác `null` / mảng rỗng.',
    body: '{ "field": "${1:field}" }',
  },
  {
    name: 'prefix',
    detail: 'bắt đầu bằng…',
    doc: 'Khớp term bắt đầu bằng tiền tố. Chậm hơn `term` — nên dùng trên `keyword`.',
    body: '{ "${1:field}": "${2:tiền tố}" }',
  },
  {
    name: 'wildcard',
    detail: 'khớp mẫu * ?',
    doc: '`*` = nhiều ký tự, `?` = một ký tự. Tránh đặt `*` ở đầu — quét rất nặng.',
    body: '{ "${1:field}": "${2:abc*}" }',
  },
  {
    name: 'regexp',
    detail: 'khớp biểu thức chính quy',
    doc: 'Regex của Lucene (luôn khớp toàn bộ term, không có `^`/`$`).',
    body: '{ "${1:field}": "${2:pattern}" }',
  },
  {
    name: 'fuzzy',
    detail: 'khớp gần đúng (sai chính tả)',
    doc: 'Cho phép lệch vài ký tự (khoảng cách Levenshtein), mặc định `fuzziness: "AUTO"`.',
    body: '{ "${1:field}": { "value": "${2:value}", "fuzziness": "AUTO" } }',
  },
  {
    name: 'ids',
    detail: 'lọc theo _id',
    doc: 'Lấy document theo danh sách `_id`.',
    body: '{ "values": ["${1:id}"] }',
  },
  {
    name: 'nested',
    detail: 'truy vấn field kiểu nested',
    doc: 'Bắt buộc khi field được map là `nested` — các điều kiện con phải khớp **cùng một** phần tử.',
    body: '{\n  "path": "${1:parent}",\n  "query": {\n    "bool": {\n      "filter": [\n        $0\n      ]\n    }\n  }\n}',
  },
  {
    name: 'query_string',
    detail: 'cú pháp Lucene (field:value AND …)',
    doc: 'Chuỗi query kiểu Lucene: `status:active AND age:>30`. Cú pháp sai → lỗi 400.',
    body: '{ "query": "${1:field:value AND other:*}" }',
  },
  {
    name: 'simple_query_string',
    detail: 'Lucene rút gọn, không lỗi cú pháp',
    doc: 'Như `query_string` nhưng bỏ qua phần cú pháp sai thay vì báo lỗi — an toàn khi nhận input người dùng.',
    body: '{ "query": "${1:text}", "fields": ["${2:field}"] }',
  },
  {
    name: 'match_all',
    detail: 'lấy tất cả',
    doc: 'Khớp mọi document. Để trống ô query cũng tương đương.',
    body: '{}',
  },
  {
    name: 'match_none',
    detail: 'không khớp gì',
    doc: 'Không khớp document nào — hữu ích khi ráp query động.',
    body: '{}',
  },
  {
    name: 'constant_score',
    detail: 'bọc filter, điểm cố định',
    doc: 'Chạy phần `filter` và gán mọi kết quả cùng một điểm.',
    body: '{\n  "filter": {\n    $0\n  },\n  "boost": ${1:1.0}\n}',
  },
  {
    name: 'dis_max',
    detail: 'lấy điểm cao nhất trong nhiều query',
    doc: 'Chạy nhiều query, điểm cuối = điểm cao nhất (cộng thêm `tie_breaker` × các điểm còn lại).',
    body: '{\n  "queries": [\n    $0\n  ],\n  "tie_breaker": 0.3\n}',
  },
  {
    name: 'boosting',
    detail: 'hạ điểm nhóm không mong muốn',
    doc: 'Giữ document khớp `positive`, nhưng hạ điểm những cái khớp `negative`.',
    body: '{\n  "positive": {\n    $0\n  },\n  "negative": {\n  },\n  "negative_boost": 0.2\n}',
  },
];

const CLAUSE_BY_NAME = new Map(ES_CLAUSES.map((c) => [c.name, c]));

/** Clause mà KEY con của nó là tên field (`{"term": {"<field>": …}}`). */
const FIELD_KEYED = new Set([
  'term', 'terms', 'match', 'match_phrase', 'match_phrase_prefix', 'match_bool_prefix',
  'prefix', 'wildcard', 'regexp', 'fuzzy', 'range',
]);

/** Key mà GIÁ TRỊ của nó là một clause (hoặc mảng clause). */
const CLAUSE_SLOTS = new Set([
  'must', 'must_not', 'should', 'filter', 'query', 'queries', 'positive', 'negative',
]);

interface OptionSpec { name: string; detail: string; body: string }

const opt = (name: string, detail: string, body: string): OptionSpec => ({ name, detail, body });

/** Key con của `bool`. */
const BOOL_OPTIONS: OptionSpec[] = [
  opt('filter', 'AND — không tính điểm (nhanh nhất)', '[\n  $0\n]'),
  opt('must', 'AND — có tính điểm', '[\n  $0\n]'),
  opt('should', 'OR — khớp càng nhiều điểm càng cao', '[\n  $0\n]'),
  opt('must_not', 'NOT — loại bỏ', '[\n  $0\n]'),
  opt('minimum_should_match', 'số nhánh should tối thiểu phải khớp', '${1:1}'),
  opt('boost', 'nhân điểm của cả nhóm', '${1:1.0}'),
];

/** Key con theo từng clause không-field-keyed. */
const CLAUSE_OPTIONS: Record<string, OptionSpec[]> = {
  bool: BOOL_OPTIONS,
  multi_match: [
    opt('query', 'chuỗi cần tìm', '"${1:text}"'),
    opt('fields', 'danh sách field (hỗ trợ * và ^boost)', '["${1:field}"]'),
    opt('type', 'cách gộp điểm giữa các field', '"${1:best_fields}"'),
    opt('operator', 'and / or giữa các từ', '"${1:and}"'),
    opt('fuzziness', 'cho phép sai chính tả', '"AUTO"'),
    opt('minimum_should_match', 'số từ tối thiểu phải khớp', '"${1:75%}"'),
    opt('tie_breaker', 'trọng số các field phụ', '${1:0.3}'),
  ],
  nested: [
    opt('path', 'field cha kiểu nested', '"${1:parent}"'),
    opt('query', 'điều kiện áp lên phần tử con', '{\n  $0\n}'),
    opt('score_mode', 'gộp điểm các phần tử con', '"${1:avg}"'),
    opt('ignore_unmapped', 'bỏ qua nếu index không có path này', '${1:true}'),
    opt('inner_hits', 'trả về phần tử con đã khớp', '{}'),
  ],
  exists: [opt('field', 'tên field cần kiểm tra', '"${1:field}"')],
  ids: [opt('values', 'danh sách _id', '["${1:id}"]')],
  query_string: [
    opt('query', 'chuỗi cú pháp Lucene', '"${1:field:value}"'),
    opt('default_field', 'field mặc định khi không ghi rõ', '"${1:field}"'),
    opt('fields', 'danh sách field áp dụng', '["${1:field}"]'),
    opt('default_operator', 'AND / OR mặc định', '"${1:AND}"'),
    opt('analyze_wildcard', 'phân tích cả term có wildcard', '${1:true}'),
    opt('lenient', 'bỏ qua lỗi ép kiểu', '${1:true}'),
  ],
  simple_query_string: [
    opt('query', 'chuỗi cần tìm', '"${1:text}"'),
    opt('fields', 'danh sách field', '["${1:field}"]'),
    opt('default_operator', 'AND / OR mặc định', '"${1:AND}"'),
  ],
  constant_score: [
    opt('filter', 'điều kiện lọc', '{\n  $0\n}'),
    opt('boost', 'điểm gán cho mọi kết quả', '${1:1.0}'),
  ],
  dis_max: [
    opt('queries', 'danh sách query', '[\n  $0\n]'),
    opt('tie_breaker', 'trọng số các query còn lại', '${1:0.3}'),
  ],
  boosting: [
    opt('positive', 'query giữ lại', '{\n  $0\n}'),
    opt('negative', 'query bị hạ điểm', '{\n  $0\n}'),
    opt('negative_boost', 'hệ số hạ điểm (0–1)', '${1:0.2}'),
  ],
};

/** Key con của `{"<clause>": {"<field>": { … }}}` — dạng object của từng clause. */
const FIELD_LEVEL_OPTIONS: Record<string, OptionSpec[]> = {
  range: [
    opt('gte', '≥ giá trị', '"${1:now-7d/d}"'),
    opt('gt', '> giá trị', '"${1:value}"'),
    opt('lte', '≤ giá trị', '"${1:now}"'),
    opt('lt', '< giá trị', '"${1:value}"'),
    opt('format', 'định dạng date của giá trị', '"${1:yyyy-MM-dd}"'),
    opt('time_zone', 'múi giờ khi so date', '"${1:+07:00}"'),
    opt('boost', 'nhân điểm', '${1:1.0}'),
  ],
  term: [
    opt('value', 'giá trị cần khớp', '"${1:value}"'),
    opt('case_insensitive', 'không phân biệt hoa thường', '${1:true}'),
    opt('boost', 'nhân điểm', '${1:1.0}'),
  ],
  match: [
    opt('query', 'chuỗi cần tìm', '"${1:text}"'),
    opt('operator', 'and / or giữa các từ', '"${1:and}"'),
    opt('fuzziness', 'cho phép sai chính tả', '"AUTO"'),
    opt('minimum_should_match', 'số từ tối thiểu phải khớp', '"${1:75%}"'),
    opt('analyzer', 'analyzer dùng cho chuỗi tìm', '"${1:standard}"'),
    opt('zero_terms_query', 'xử lý khi chuỗi rỗng sau phân tích', '"${1:none}"'),
    opt('boost', 'nhân điểm', '${1:1.0}'),
  ],
  prefix: [
    opt('value', 'tiền tố', '"${1:abc}"'),
    opt('case_insensitive', 'không phân biệt hoa thường', '${1:true}'),
    opt('boost', 'nhân điểm', '${1:1.0}'),
  ],
  wildcard: [
    opt('value', 'mẫu có * ?', '"${1:abc*}"'),
    opt('case_insensitive', 'không phân biệt hoa thường', '${1:true}'),
    opt('boost', 'nhân điểm', '${1:1.0}'),
  ],
  regexp: [
    opt('value', 'biểu thức chính quy', '"${1:.*}"'),
    opt('flags', 'cờ regex của Lucene', '"ALL"'),
    opt('case_insensitive', 'không phân biệt hoa thường', '${1:true}'),
  ],
  fuzzy: [
    opt('value', 'giá trị gốc', '"${1:value}"'),
    opt('fuzziness', 'mức lệch cho phép', '"AUTO"'),
    opt('prefix_length', 'số ký tự đầu phải đúng', '${1:1}'),
    opt('max_expansions', 'số biến thể tối đa', '${1:50}'),
    opt('transpositions', 'cho phép đảo 2 ký tự', '${1:true}'),
  ],
};
FIELD_LEVEL_OPTIONS.match_phrase = FIELD_LEVEL_OPTIONS.match;
FIELD_LEVEL_OPTIONS.match_phrase_prefix = FIELD_LEVEL_OPTIONS.match;
FIELD_LEVEL_OPTIONS.match_bool_prefix = FIELD_LEVEL_OPTIONS.match;

/** Giá trị gợi ý (enum) theo tên key. */
const ENUM_VALUES: Record<string, string[]> = {
  type: ['best_fields', 'most_fields', 'cross_fields', 'phrase', 'phrase_prefix', 'bool_prefix'],
  operator: ['and', 'or'],
  default_operator: ['AND', 'OR'],
  score_mode: ['avg', 'sum', 'min', 'max', 'none'],
  fuzziness: ['AUTO', '0', '1', '2'],
  zero_terms_query: ['none', 'all'],
  flags: ['ALL', 'COMPLEMENT', 'INTERVAL', 'INTERSECTION', 'ANYSTRING'],
};

const BOOL_LITERAL_KEYS = new Set([
  'case_insensitive', 'analyze_wildcard', 'lenient', 'ignore_unmapped', 'transpositions',
]);

/** Giá trị mặc định chèn kèm khi chọn một FIELD làm key con của clause. */
function fieldValueBody(clause: string): string {
  switch (clause) {
    case 'terms': return '["$0"]';
    case 'range': return '{ "gte": "${1:from}", "lte": "${2:to}" }';
    case 'fuzzy': return '{ "value": "$0", "fuzziness": "AUTO" }';
    default: return '"$0"';
  }
}

// ── Mẫu chèn nhanh (chips trên thanh công cụ) ────────────────────────────────

export interface EsTemplate {
  label: string;
  title: string;
  /** Snippet một clause hoàn chỉnh (đã bọc `{ }`) để chèn tại con trỏ. */
  body: string;
}

export const ES_TEMPLATES: EsTemplate[] = [
  {
    label: 'bool',
    title: 'Khung bool: filter (AND) + must_not (NOT) + should (OR)',
    body: '{\n  "bool": {\n    "filter": [\n      { "term": { "${1:field}": "${2:value}" } }\n    ],\n    "must_not": [],\n    "should": []\n  }\n}',
  },
  {
    label: 'term',
    title: 'Khớp chính xác một giá trị (keyword / id / số)',
    body: '{ "term": { "${1:field}": "${2:value}" } }',
  },
  {
    label: 'terms',
    title: 'Khớp một trong nhiều giá trị (IN)',
    body: '{ "terms": { "${1:field}": ["${2:a}", "${3:b}"] } }',
  },
  {
    label: 'match',
    title: 'Tìm full-text trên field text',
    body: '{ "match": { "${1:field}": "${2:text}" } }',
  },
  {
    label: 'range',
    title: 'Khoảng giá trị / thời gian (date-math dùng được)',
    body: '{ "range": { "${1:createdAt}": { "gte": "${2:now-7d/d}", "lte": "${3:now}" } } }',
  },
  {
    label: 'exists',
    title: 'Field có giá trị',
    body: '{ "exists": { "field": "${1:field}" } }',
  },
  {
    label: 'wildcard',
    title: 'Khớp mẫu có * và ?',
    body: '{ "wildcard": { "${1:field}": "${2:abc*}" } }',
  },
  {
    label: 'nested',
    title: 'Truy vấn field kiểu nested',
    body: '{\n  "nested": {\n    "path": "${1:parent}",\n    "query": {\n      "bool": {\n        "filter": [\n          { "term": { "${1:parent}.${2:child}": "${3:value}" } }\n        ]\n      }\n    }\n  }\n}',
  },
  {
    label: 'match_all',
    title: 'Lấy tất cả document',
    body: '{ "match_all": {} }',
  },
];

/**
 * Mẫu chèn nhanh cho ô BODY _search (tab Dữ liệu — kiểu Kibana Dev Tools).
 * Mẫu `khung` là body trọn vẹn; các mẫu còn lại là MỘT key cấp body để chèn
 * thêm vào body đang có (đặt con trỏ vào trong `{ }` rồi bấm).
 */
export const ES_BODY_TEMPLATES: EsTemplate[] = [
  {
    label: 'khung',
    title: 'Body đầy đủ: query + sort + size',
    body: '{\n  "query": {\n    "bool": {\n      "filter": [\n        { "term": { "${1:field}": "${2:value}" } }\n      ]\n    }\n  },\n  "sort": [{ "${3:createdAt}": "desc" }],\n  "size": ${4:50}\n}',
  },
  {
    label: 'query',
    title: 'Phần query (bool filter)',
    body: '"query": {\n  "bool": {\n    "filter": [\n      $0\n    ]\n  }\n}',
  },
  {
    label: 'aggs',
    title: 'Thống kê gom nhóm — thêm "size": 0 nếu chỉ cần số liệu',
    body: '"aggs": {\n  "${1:ten_agg}": {\n    "terms": { "field": "${2:field.keyword}", "size": ${3:10} }\n  }\n}',
  },
  {
    label: 'date_histogram',
    title: 'Đếm document theo mốc thời gian',
    body: '"aggs": {\n  "${1:theo_ngay}": {\n    "date_histogram": { "field": "${2:createdAt}", "calendar_interval": "${3:1d}", "time_zone": "+07:00" }\n  }\n}',
  },
  {
    label: 'sort',
    title: 'Sắp xếp kết quả',
    body: '"sort": [{ "${1:createdAt}": "${2:desc}" }]',
  },
  {
    label: '_source',
    title: 'Chỉ trả về các field cần xem',
    body: '"_source": ["${1:field}"]',
  },
];

// ── Bộ quét ngữ cảnh ─────────────────────────────────────────────────────────

export interface EsQueryContext {
  /** Chuỗi key từ gốc tới container đang chứa con trỏ (bỏ phần tử mảng). */
  path: string[];
  /** Con trỏ nằm trực tiếp trong mảng — hoặc ở gốc document (chưa có container). */
  inArray: boolean;
  /** 'key' = đang chờ tên thuộc tính · 'value' = đã qua dấu `:` (hoặc trong mảng). */
  expecting: 'key' | 'value';
  /** Key đang chờ giá trị (khi expecting = 'value'). */
  valueKey: string | null;
  /** Ký tự khác khoảng trắng ngay trước vùng thay thế — để biết có cần chèn dấu phẩy. */
  prevChar: string;
  /** Con trỏ đứng ngay sau một chuỗi CHƯA có dấu `:` — tức key đang gõ dở, không phải phần tử đã xong. */
  danglingKey: boolean;
  /** Vùng text sẽ bị completion thay thế (gồm cả cặp nháy nếu đang gõ trong chuỗi). */
  replaceStart: number;
  replaceEnd: number;
}

interface Frame {
  arr: boolean;
  /** Key ở object cha dẫn tới container này (null nếu là phần tử mảng / gốc). */
  owner: string | null;
  key: string | null;
  afterColon: boolean;
}

/**
 * Quét JSON (kể cả đang gõ dở / sai cú pháp) tới `offset` và mô tả vị trí con trỏ.
 * Không dùng JSON.parse — cả điểm mạnh của completion là chạy trên JSON chưa hợp lệ.
 */
export function esQueryContext(text: string, offset: number): EsQueryContext {
  const stack: Frame[] = [];
  let pending: string | null = null; // chuỗi vừa đóng, chờ xem có dấu `:` phía sau
  let pendingStart = -1;
  let pendingEnd = -1;
  let prevChar = '';
  let i = 0;
  let replaceStart = offset;
  let replaceEnd = offset;

  const top = () => (stack.length ? stack[stack.length - 1] : null);
  const push = (arr: boolean) => {
    const p = top();
    const owner = !p ? null : p.arr ? null : p.key;
    stack.push({ arr, owner, key: null, afterColon: false });
  };

  /** Một giá trị vừa kết thúc → object cha quay lại trạng thái chờ key mới. */
  const valueDone = () => {
    const t = top();
    if (t && !t.arr && t.afterColon) { t.afterColon = false; t.key = null; }
  };

  while (i < offset) {
    const c = text[i];

    if (c === '"') {
      // Đọc tới nháy đóng. JSON không cho xuống dòng trong chuỗi → gặp \n là chuỗi hở.
      let j = i + 1;
      let closed = false;
      let buf = '';
      while (j < text.length) {
        const d = text[j];
        if (d === '\\') { buf += text[j + 1] ?? ''; j += 2; continue; }
        if (d === '"') { closed = true; break; }
        if (d === '\n') break;
        buf += d;
        j += 1;
      }
      if (!closed || j >= offset) {
        // Con trỏ nằm TRONG chuỗi này → đây chính là token đang gõ.
        replaceStart = i;
        replaceEnd = closed ? j + 1 : offset;
        break;
      }
      const t = top();
      if (t && !t.arr && t.afterColon) valueDone(); // chuỗi này là GIÁ TRỊ, không phải key
      else { pending = buf; pendingStart = i; pendingEnd = j + 1; }
      prevChar = '"';
      i = j + 1;
      continue;
    }

    if (c === '{' || c === '[') {
      push(c === '[');
      prevChar = c;
      pending = null;
      i += 1;
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      valueDone(); // container vừa đóng chính là giá trị của key ở object cha
      prevChar = c;
      pending = null;
      i += 1;
      continue;
    }
    if (c === ':') {
      const t = top();
      if (t && !t.arr) { t.key = pending; t.afterColon = true; }
      pending = null;
      prevChar = c;
      i += 1;
      continue;
    }
    if (c === ',') {
      const t = top();
      if (t && !t.arr) { t.key = null; t.afterColon = false; }
      pending = null;
      prevChar = c;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }

    // Literal trần: số, true/false/null (hoặc chữ người dùng đang gõ thiếu nháy).
    let k = i;
    while (k < text.length && /[A-Za-z0-9_+.-]/.test(text[k])) k += 1;
    if (k === i) { prevChar = c; i += 1; continue; }
    if (k >= offset) { i = offset; break; } // con trỏ trong literal → để hậu xử lý bắt token
    valueDone();
    prevChar = text[k - 1];
    i = k;
  }

  const t0 = stack.length ? stack[stack.length - 1] : null;
  const danglingKey = pending !== null && !!t0 && !t0.arr && !t0.afterColon && pendingEnd === offset;

  if (danglingKey) {
    // `{"bool"│}` — key đã đóng nháy nhưng chưa có `:`; gợi ý phải THAY nó,
    // không phải chèn thêm bên cạnh (sẽ thành `"bool""filter": …`).
    replaceStart = pendingStart;
    replaceEnd = offset;
    let k = pendingStart - 1;
    while (k >= 0 && /\s/.test(text[k])) k -= 1;
    prevChar = k >= 0 ? text[k] : '';
  } else if (i >= offset) {
    // Không đứng trong chuỗi: nuốt ngược phần định danh trần đang gõ (vd. `boo`).
    let s = offset;
    while (s > 0 && /[A-Za-z0-9_.*-]/.test(text[s - 1])) s -= 1;
    replaceStart = s;
    replaceEnd = offset;
    if (s < offset) {
      let k = s - 1;
      while (k >= 0 && /\s/.test(text[k])) k -= 1;
      prevChar = k >= 0 ? text[k] : '';
    }
  } else {
    // Đang trong chuỗi: prevChar là ký tự trước dấu nháy mở.
    let k = replaceStart - 1;
    while (k >= 0 && /\s/.test(text[k])) k -= 1;
    prevChar = k >= 0 ? text[k] : '';
  }

  const t = top();
  const inArray = !t || t.arr;
  const expecting: 'key' | 'value' = !t ? 'value' : t.arr ? 'value' : t.afterColon ? 'value' : 'key';
  const valueKey = !t ? null : t.arr ? t.owner : t.afterColon ? t.key : null;
  const path = stack.map((f) => f.owner).filter((o): o is string => !!o);

  return { path, inArray, expecting, valueKey, prevChar, danglingKey, replaceStart, replaceEnd };
}

// ── Sinh gợi ý ───────────────────────────────────────────────────────────────

export interface EsSuggestion {
  label: string;
  kind: 'clause' | 'option' | 'field' | 'value';
  detail: string;
  doc?: string;
  /** Snippet đã sẵn sàng chèn (đã có dấu nháy, dấu phẩy nếu cần). */
  insert: string;
  sort: string;
}

export interface EsField {
  path: string;
  type: string;
}

function clauseItem(spec: EsClauseSpec, wrap: boolean, order: number): EsSuggestion {
  const inner = `"${spec.name}": ${spec.body}`;
  return {
    label: spec.name,
    kind: 'clause',
    detail: spec.detail,
    doc: spec.doc,
    insert: wrap ? `{ ${inner} }` : inner,
    sort: `1${String(order).padStart(3, '0')}`,
  };
}

function optionItems(specs: OptionSpec[]): EsSuggestion[] {
  return specs.map((o, n) => ({
    label: o.name,
    kind: 'option' as const,
    detail: o.detail,
    insert: `"${o.name}": ${o.body}`,
    sort: `0${String(n).padStart(3, '0')}`,
  }));
}

/** `$` và `\` là ký tự điều khiển của snippet monaco — phải escape khi chèn text thật. */
const snipLit = (s: string) => s.replace(/[\\$]/g, '\\$&');

function fieldItems(fields: EsField[], body: (f: EsField) => string): EsSuggestion[] {
  return fields.map((f, n) => ({
    label: f.path,
    kind: 'field' as const,
    detail: f.type,
    doc: `Field của index — kiểu \`${f.type}\`.`,
    insert: body({ path: snipLit(f.path), type: f.type }),
    sort: `2${String(n).padStart(4, '0')}`,
  }));
}

function valueItems(values: string[], quoted: boolean): EsSuggestion[] {
  return values.map((v, n) => ({
    label: v,
    kind: 'value' as const,
    detail: '',
    insert: quoted ? `"${v}"` : v,
    sort: `0${String(n).padStart(3, '0')}`,
  }));
}

/**
 * Gợi ý hợp lệ tại vị trí con trỏ. `fields` là field thật lấy từ mapping của
 * index (rỗng cũng không sao — khi đó chỉ gợi ý cú pháp).
 */
export function esSuggestions(ctx: EsQueryContext, fields: EsField[]): EsSuggestion[] {
  const { path, expecting, inArray, valueKey } = ctx;
  const last = path.length ? path[path.length - 1] : null;
  const parent = path.length > 1 ? path[path.length - 2] : null;

  if (expecting === 'key') {
    // Trong `{"<clause>": {"<field>": {│}}}` → option cấp field.
    if (parent && FIELD_KEYED.has(parent) && FIELD_LEVEL_OPTIONS[parent]) {
      return optionItems(FIELD_LEVEL_OPTIONS[parent]);
    }
    // Trong `{"<clause>": {│}}` mà clause nhận field làm key → gợi ý field thật.
    if (last && FIELD_KEYED.has(last)) {
      const body = fieldValueBody(last);
      return fieldItems(fields, (f) => `"${f.path}": ${body}`);
    }
    if (last && CLAUSE_OPTIONS[last]) return optionItems(CLAUSE_OPTIONS[last]);
    // Gốc document, hoặc trong phần tử của must/filter/should/… → tên clause.
    return ES_CLAUSES.map((c, n) => clauseItem(c, false, n));
  }

  // ── expecting === 'value' ──────────────────────────────────────────────────
  if (valueKey && ENUM_VALUES[valueKey]) return valueItems(ENUM_VALUES[valueKey], true);
  if (valueKey && BOOL_LITERAL_KEYS.has(valueKey)) return valueItems(['true', 'false'], false);

  // `"field": │` của exists, `"path": │` của nested, phần tử của mảng `fields`.
  if (valueKey === 'field' || valueKey === 'path' || (inArray && valueKey === 'fields')) {
    return fieldItems(fields, (f) => `"${f.path}"`);
  }

  // Giá trị của một key CHÍNH LÀ clause (vd. gõ tay `"bool": │`).
  if (valueKey && CLAUSE_BY_NAME.has(valueKey) && !inArray) {
    const spec = CLAUSE_BY_NAME.get(valueKey)!;
    return [{
      label: `${valueKey} — khung mẫu`,
      kind: 'clause',
      detail: spec.detail,
      doc: spec.doc,
      insert: spec.body,
      sort: '0000',
    }];
  }

  // Trong mảng clause (`filter: [│]`) hoặc ở gốc → clause bọc sẵn `{ }`.
  if (inArray || !valueKey || CLAUSE_SLOTS.has(valueKey)) {
    return ES_CLAUSES.map((c, n) => clauseItem(c, true, n));
  }
  return [];
}

// ── Gợi ý cho BODY đầy đủ của _search (tab Console) ──────────────────────────
//
// Ô Query DSL ở tab Dữ liệu chỉ nhận phần `query`, còn console gõ nguyên body
// nên có thêm một tầng key ngoài cùng (size/sort/aggs/_source…). Hàm dưới xử lý
// tầng đó rồi mới uỷ quyền xuống esSuggestions cho phần trong `query`.

/** Key cấp cao nhất của body `_search`. */
export const ES_SEARCH_BODY_KEYS: { name: string; detail: string; body: string }[] = [
  opt('query', 'điều kiện lọc document', '{\n  $0\n}'),
  opt('size', 'số document trả về (0 = chỉ lấy aggs)', '${1:10}'),
  opt('from', 'bỏ qua bao nhiêu document', '${1:0}'),
  opt('sort', 'sắp xếp kết quả', '[\n  { "${1:field}": "${2:desc}" }\n]'),
  opt('_source', 'chọn field trả về', '["${1:field}"]'),
  opt('aggs', 'thống kê / gom nhóm', '{\n  "${1:ten_agg}": {\n    "terms": { "field": "${2:field}", "size": 10 }\n  }\n}'),
  opt('track_total_hits', 'đếm đủ tổng số khớp (thay vì dừng ở 10000)', '${1:true}'),
  opt('highlight', 'tô đoạn khớp trong kết quả', '{ "fields": { "${1:field}": {} } }'),
  opt('collapse', 'gộp kết quả theo field', '{ "field": "${1:field}" }'),
  opt('search_after', 'phân trang sâu (thay from)', '[${1:value}]'),
  opt('min_score', 'bỏ kết quả điểm thấp', '${1:1.0}'),
  opt('timeout', 'giới hạn thời gian phía ES', '"${1:10s}"'),
];

/** Các loại aggregation hay dùng. */
export const ES_AGG_TYPES: { name: string; detail: string; body: string }[] = [
  opt('terms', 'gom nhóm theo giá trị field', '{ "field": "${1:field}", "size": ${2:10} }'),
  opt('date_histogram', 'gom nhóm theo mốc thời gian', '{ "field": "${1:createdAt}", "calendar_interval": "${2:1d}" }'),
  opt('histogram', 'gom nhóm theo khoảng số', '{ "field": "${1:field}", "interval": ${2:10} }'),
  opt('range', 'gom nhóm theo khoảng tự định nghĩa', '{ "field": "${1:field}", "ranges": [{ "to": 10 }, { "from": 10 }] }'),
  opt('cardinality', 'đếm số giá trị khác nhau', '{ "field": "${1:field}" }'),
  opt('value_count', 'đếm số giá trị', '{ "field": "${1:field}" }'),
  opt('avg', 'trung bình', '{ "field": "${1:field}" }'),
  opt('sum', 'tổng', '{ "field": "${1:field}" }'),
  opt('min', 'nhỏ nhất', '{ "field": "${1:field}" }'),
  opt('max', 'lớn nhất', '{ "field": "${1:field}" }'),
  opt('stats', 'min/max/avg/sum/count một lượt', '{ "field": "${1:field}" }'),
  opt('percentiles', 'phân vị', '{ "field": "${1:field}" }'),
  opt('filter', 'lọc trước khi thống kê', '{ "term": { "${1:field}": "${2:value}" } }'),
  opt('nested', 'thống kê trong field nested', '{ "path": "${1:parent}" }'),
  opt('top_hits', 'vài document tiêu biểu mỗi nhóm', '{ "size": ${1:1} }'),
];

const AGG_TYPE_NAMES = new Set(ES_AGG_TYPES.map((a) => a.name));
const AGG_CONTAINERS = new Set(['aggs', 'aggregations']);

const AGG_OPTIONS: Record<string, OptionSpec[]> = {
  terms: [
    opt('field', 'field để gom nhóm (nên là keyword)', '"${1:field}"'),
    opt('size', 'số nhóm trả về', '${1:10}'),
    opt('order', 'thứ tự nhóm', '{ "_count": "desc" }'),
    opt('min_doc_count', 'bỏ nhóm quá ít document', '${1:1}'),
    opt('missing', 'giá trị thay cho document thiếu field', '"${1:N/A}"'),
  ],
  date_histogram: [
    opt('field', 'field kiểu date', '"${1:createdAt}"'),
    opt('calendar_interval', 'mốc theo lịch (1d, 1M, 1y)', '"${1:1d}"'),
    opt('fixed_interval', 'mốc cố định (30m, 12h)', '"${1:1h}"'),
    opt('time_zone', 'múi giờ khi chia mốc', '"${1:+07:00}"'),
    opt('format', 'định dạng nhãn mốc', '"${1:yyyy-MM-dd}"'),
    opt('min_doc_count', 'giữ cả mốc rỗng khi = 0', '${1:0}'),
  ],
};
const AGG_OPTIONS_DEFAULT: OptionSpec[] = [
  opt('field', 'field áp dụng', '"${1:field}"'),
  opt('missing', 'giá trị thay cho document thiếu field', '"${1:0}"'),
];

/**
 * Gợi ý cho body `_search` đầy đủ. Nhận đúng ngữ cảnh mà `esQueryContext` trả
 * về, nhưng hiểu thêm tầng ngoài (size/sort/aggs…) trước khi rơi xuống các
 * clause của Query DSL.
 */
export function esBodySuggestions(ctx: EsQueryContext, fields: EsField[]): EsSuggestion[] {
  const { path, expecting, inArray, valueKey } = ctx;
  const last = path.length ? path[path.length - 1] : null;
  const parent = path.length > 1 ? path[path.length - 2] : null;

  // Đang ở TRONG "sort": [...] (kể cả sort của top_hits) → bộ gợi ý sort riêng.
  // Bỏ qua khi "sort" chỉ là TÊN FIELD trong một clause (vd. {"term": {"sort": …}}).
  const si = path.lastIndexOf('sort');
  if (si !== -1 && (si === 0 || !FIELD_KEYED.has(path[si - 1]))) {
    return esSortSuggestions({ ...ctx, path: path.slice(si + 1) }, fields);
  }

  if (expecting === 'key') {
    if (path.length === 0) return optionItems(ES_SEARCH_BODY_KEYS);

    // `"aggs": {│}` — key ở đây là TÊN agg do người dùng đặt.
    if (last && AGG_CONTAINERS.has(last)) {
      return ES_AGG_TYPES.map((a, n) => ({
        label: a.name,
        kind: 'option' as const,
        detail: `agg mới — ${a.detail}`,
        insert: `"\${1:${a.name}_agg}": { "${a.name}": ${a.body.replace(/\$\{(\d+)/g, (_m, d) => `\${${Number(d) + 1}`)} }`,
        sort: `0${String(n).padStart(3, '0')}`,
      }));
    }
    // `"aggs": {"ten": {│}}` — chọn loại agg (hoặc lồng thêm aggs con).
    if (parent && AGG_CONTAINERS.has(parent)) {
      return [
        ...ES_AGG_TYPES.map((a, n) => ({
          label: a.name,
          kind: 'option' as const,
          detail: a.detail,
          insert: `"${a.name}": ${a.body}`,
          sort: `0${String(n).padStart(3, '0')}`,
        })),
        ...optionItems([opt('aggs', 'agg con lồng bên trong', '{\n  $0\n}')]).map((s) => ({ ...s, sort: '1000' })),
      ];
    }
    // `"aggs": {"ten": {"terms": {│}}}` — tuỳ chọn của loại agg đó.
    if (last && AGG_TYPE_NAMES.has(last) && path.length >= 2) {
      return optionItems(AGG_OPTIONS[last] ?? AGG_OPTIONS_DEFAULT);
    }
    return esSuggestions(ctx, fields);
  }

  // ── expecting === 'value' ──────────────────────────────────────────────────
  if (valueKey === 'track_total_hits') return valueItems(['true', 'false'], false);
  if (valueKey === 'size' || valueKey === 'from' || valueKey === 'min_score') return [];
  if (valueKey === '_source' && inArray) return fieldItems(fields, (f) => `"${f.path}"`);
  if (valueKey === 'calendar_interval') return valueItems(['1m', '1h', '1d', '1w', '1M', '1q', '1y'], true);
  return esSuggestions(ctx, fields);
}

// ── Gợi ý cho phần sort ──────────────────────────────────────────────────────

/** Tuỳ chọn khi sort một field viết dạng object: `{"createdAt": {│}}`. */
const SORT_FIELD_OPTIONS: OptionSpec[] = [
  opt('order', 'asc / desc', '"${1:desc}"'),
  opt('missing', 'document thiếu field xếp ở đâu', '"${1:_last}"'),
  opt('mode', 'field nhiều giá trị thì lấy gì để so', '"${1:min}"'),
  opt('unmapped_type', 'kiểu giả định khi index không có field', '"${1:keyword}"'),
  opt('format', 'định dạng date trong kết quả sort', '"${1:yyyy-MM-dd}"'),
  opt('nested', 'sort theo field trong nested', '{ "path": "${1:parent}" }'),
];

/** Enum riêng của sort — để cục bộ, không nhét vào ENUM_VALUES kẻo lây sang query/aggs. */
const SORT_ENUMS: Record<string, string[]> = {
  order: ['desc', 'asc'],
  mode: ['min', 'max', 'sum', 'avg', 'median'],
  missing: ['_last', '_first'],
};

/**
 * Gợi ý cho ô Sort (tab Dữ liệu) — nội dung ô là giá trị của `"sort"` trong
 * body _search: `[{"field": "desc"}]`, `{"field": "desc"}` hay `["_score"]`.
 */
export function esSortSuggestions(ctx: EsQueryContext, fields: EsField[]): EsSuggestion[] {
  const { path, expecting, inArray, valueKey } = ctx;

  if (expecting === 'key') {
    // `{"createdAt": {│}}` (path sâu ≥1) → tuỳ chọn sort của field đó.
    if (path.length >= 1) return optionItems(SORT_FIELD_OPTIONS);
    // `{│}` — key chính là tên field.
    return fieldItems(fields, (f) => `"${f.path}": "\${1:desc}"`);
  }

  // ── expecting === 'value' ──────────────────────────────────────────────────
  if (valueKey && SORT_ENUMS[valueKey]) return valueItems(SORT_ENUMS[valueKey], true);
  if (valueKey === 'path') return fieldItems(fields, (f) => `"${f.path}"`);
  if (valueKey && !inArray) {
    // `{"createdAt": │}` — hướng sắp xếp, hoặc dạng object đầy đủ.
    return [
      ...valueItems(['desc', 'asc'], true),
      {
        label: 'tuỳ chọn đầy đủ',
        kind: 'clause',
        detail: 'order + missing…',
        insert: '{ "order": "${1:desc}", "missing": "${2:_last}" }',
        sort: '0100',
      },
    ];
  }
  // Gốc ô / phần tử mảng mới → một mục sort hoàn chỉnh.
  return [
    { label: '_score', kind: 'value', detail: 'theo điểm khớp', insert: '"_score"', sort: '0000' },
    ...fieldItems(fields, (f) => `{ "${f.path}": "\${1:desc}" }`),
  ];
}

/** Có cần chèn dấu phẩy trước gợi ý không (con trỏ ngay sau một phần tử khác). */
export function needsLeadingComma(ctx: EsQueryContext): boolean {
  if (ctx.expecting === 'value' && !ctx.inArray) return false; // ngay sau dấu `:`
  if (ctx.danglingKey) return false; // gợi ý sẽ THAY key đang gõ dở, không đứng cạnh nó
  const p = ctx.prevChar;
  return !!p && p !== '{' && p !== '[' && p !== ',' && p !== ':';
}

// ── Mapping → danh sách field ────────────────────────────────────────────────

const MAX_FIELDS = 500;

interface MappingNode {
  type?: string;
  properties?: Record<string, MappingNode>;
  fields?: Record<string, MappingNode>;
}

function walkProps(
  props: Record<string, MappingNode>,
  prefix: string,
  out: EsField[],
  depth: number,
): void {
  if (depth > 12) return;
  for (const [name, def] of Object.entries(props)) {
    if (out.length >= MAX_FIELDS) return;
    const p = prefix ? `${prefix}.${name}` : name;
    const type = def?.type ?? (def?.properties ? 'object' : 'unknown');
    out.push({ path: p, type });
    if (def?.fields) {
      for (const [sub, sdef] of Object.entries(def.fields)) {
        if (out.length >= MAX_FIELDS) return;
        out.push({ path: `${p}.${sub}`, type: sdef?.type ?? 'unknown' });
      }
    }
    if (def?.properties) walkProps(def.properties, p, out, depth + 1);
  }
}

/**
 * Trải JSON mapping (`GET /<index>/_mapping`) thành danh sách field path.
 * Chịu được cả ES 6 (`mappings._doc.properties`) lẫn ES 7+ (`mappings.properties`),
 * và giữ luôn sub-field (`name.keyword`) vì đó mới là thứ dùng cho `term`.
 */
export function flattenEsMapping(json: string): EsField[] {
  let root: unknown;
  try { root = JSON.parse(json); } catch { return []; }
  if (!root || typeof root !== 'object') return [];

  const out: EsField[] = [];
  for (const idxBody of Object.values(root as Record<string, { mappings?: unknown }>)) {
    const mappings = idxBody?.mappings as Record<string, MappingNode> | undefined;
    if (!mappings || typeof mappings !== 'object') continue;
    if (mappings.properties) {
      walkProps(mappings.properties as Record<string, MappingNode>, '', out, 0);
      continue;
    }
    // ES 6: một cấp doc-type ở giữa.
    for (const typeBody of Object.values(mappings)) {
      if (typeBody && typeof typeBody === 'object' && typeBody.properties) {
        walkProps(typeBody.properties, '', out, 0);
      }
    }
  }

  const seen = new Set<string>();
  return out
    .filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ── Format ───────────────────────────────────────────────────────────────────

export interface EsFormatResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Pretty-print query. Nhận cả JSON "lỏng" hay gặp khi copy từ log/Kibana:
 * key không nháy, nháy đơn, dấu phẩy thừa — sửa xong mới parse.
 * `style: 'compact'` gọn về MỘT dòng (cho ô nhỏ như Sort) — an toàn vì
 * JSON.stringify đã escape hết xuống-dòng trong chuỗi.
 */
export function formatEsQuery(raw: string, style: 'pretty' | 'compact' = 'pretty'): EsFormatResult {
  const src = raw.trim();
  if (!src) return { ok: true, text: '' };

  const attempts = [src, relaxJson(src)];
  for (const candidate of attempts) {
    try {
      const v: unknown = JSON.parse(candidate);
      const text = style === 'compact'
        ? JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ')
        : JSON.stringify(v, null, 2);
      return { ok: true, text };
    } catch { /* thử biến thể tiếp theo */ }
  }
  try { JSON.parse(src); } catch (e) {
    return { ok: false, text: raw, error: (e as Error).message };
  }
  return { ok: false, text: raw, error: 'JSON không hợp lệ' };
}

/** Nới lỏng JSON: bỏ comment, bỏ dấu phẩy thừa, nháy đơn → nháy kép, key trần → có nháy. */
function relaxJson(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let body = '';
      while (j < src.length) {
        if (src[j] === '\\') { body += src[j] + (src[j + 1] ?? ''); j += 2; continue; }
        if (src[j] === quote) break;
        body += src[j];
        j += 1;
      }
      out += `"${quote === "'" ? body.replace(/"/g, '\\"') : body}"`;
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    out += c;
    i += 1;
  }
  return out
    .replace(/([{,]\s*)([A-Za-z_$][\w$.-]*)(\s*:)/g, '$1"$2"$3') // key trần → "key"
    .replace(/,(\s*[}\]])/g, '$1');                               // dấu phẩy thừa
}
