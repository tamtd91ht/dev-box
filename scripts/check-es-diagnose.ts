// scripts/check-es-diagnose.ts — kiểm luật phân tích cụm Elasticsearch.
//
// VÌ SAO CÓ FILE NÀY: cùng một triệu chứng có nhiều nguyên nhân với cách sửa
// trái ngược. Shard chưa gán vì tắt allocation thì chỉ cần bật lại; vì hết
// bản sao primary thì "reroute" bừa là MẤT DỮ LIỆU. CPU cao vì GC thì tối ưu
// query không giúp gì. Các ca ở đây khoá việc đọc đúng lời ES nói và chọn đúng
// cách sửa — kể cả không bịa watermark / ngưỡng khi cụm cấu hình khác mặc định.
//
//   npx tsx scripts/check-es-diagnose.ts

import { analyzeEs, expensiveFlags, parseSearchDescription, threadKind, watermarkUsedPct, type EsFacts, type EsNodeFacts } from '../lib/esDiagnoseRules';
import { parseHotThreads } from '../lib/esDiagnose';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else { failures += 1; console.error(`✗ ${m}`); }
};

const GB = 1024 ** 3;
const node = (over: Partial<EsNodeFacts>): EsNodeFacts => ({
  name: 'es-1', roles: 'data,ingest,master', heapPct: 50, heapMax: 16 * GB, ramTotal: 32 * GB, cpu: 30,
  oldGcCount: 0, oldGcMs: 0, rejected: { search: 0, write: 0 }, queue: { search: 0, write: 0 },
  breakers: [], fielddata: 0, segmentsMem: 0, diskTotal: 1000 * GB, diskAvail: 600 * GB, shards: 100, hotThreads: [],
  ...over,
});
const facts = (over: Partial<EsFacts>): EsFacts => ({
  version: '7.17.9', status: 'green', dataNodes: 3, activeShards: 300, unassigned: 0, initializing: 0, relocating: 0, delayedUnassigned: 0,
  windowSec: 5, nodes: [node({ name: 'es-1' }), node({ name: 'es-2' }), node({ name: 'es-3' })],
  unassignedList: [], explain: null, shardSizes: [], overReplicated: [],
  watermarks: { low: '85%', high: '90%', flood: '95%' }, allocationEnable: null, maxShardsPerNode: null,
  readOnlyIndices: [], pending: [], ...over,
});
const get = (f: EsFacts, prefix: string) => analyzeEs(f).findings.find((x) => x.id.startsWith(prefix));

// ── Đọc watermark / luồng ──
check(watermarkUsedPct('85%', null) === 85 && watermarkUsedPct('0.9', null) === 90, 'watermark % và tỉ lệ');
check(watermarkUsedPct('50gb', 1000 * GB) === 95, 'watermark tuyệt đối 50gb trống trên đĩa 1000GB → 95% đã dùng');
check(watermarkUsedPct('500mb', null) === null, 'watermark tuyệt đối mà không biết dung lượng đĩa → không bịa');
check(threadKind('elasticsearch[es-1][search][T#5]') === 'search' && threadKind('elasticsearch[es-1][write][T#2]') === 'write', 'luồng search / write');
check(threadKind('elasticsearch[es-1][[logs][0]: Lucene Merge Thread #3]') === 'merge' && threadKind('VM Thread') === 'gc', 'luồng merge / GC');
check(threadKind('elasticsearch[es-1][[gcp-logs][0]: Lucene Merge Thread #1]') === 'merge' && threadKind('elasticsearch[es-1][search][T#1] gcp') === 'search',
  'tên index chứa "gc" không bị nhầm thành GC');
check(threadKind('G1 Young RemSet Sampling') === 'gc' && threadKind('GC Thread#3') === 'gc', 'luồng GC G1 / ParallelGC');
{
  const txt = [
    '::: {es-1}{abc}{10.0.0.1}{10.0.0.1:9300}',
    '   Hot threads at 2026-10-21T08:00:00Z, interval=500ms, busiestThreads=3:',
    '   91.2% [cpu=91.2%, other=0.0%] (456ms out of 500ms) cpu usage by thread \'elasticsearch[es-1][search][T#3]\'',
    '   12.0% [cpu=12.0%, other=0.0%] (60ms out of 500ms) cpu usage by thread \'elasticsearch[es-1][write][T#1]\'',
    '::: {es-2}{def}{10.0.0.2}{10.0.0.2:9300}',
    '   40.5% (202ms out of 500ms) cpu usage by thread \'VM Thread\'',
  ].join('\n');
  const h = parseHotThreads(txt);
  check(h.get('es-1')?.[0].kind === 'search' && h.get('es-1')?.[0].pct === 91.2 && h.get('es-2')?.[0].kind === 'gc', 'đọc hot_threads (cả định dạng có / không có [cpu=…])');
}

// ── Đĩa ──
{
  const f = facts({ nodes: [node({ name: 'es-1', diskAvail: 30 * GB }), node({ name: 'es-2' })], readOnlyIndices: ['logs-2026.10.20', 'logs-2026.10.21'] });
  const d = get(f, 'disk:es-1')!;
  check(d.level === 'crit' && d.title.includes('flood-stage'), 'đĩa 97% → vượt flood-stage, đỏ');
  const r = get(f, 'readonly')!;
  check(!!r.sql?.includes('"index.blocks.read_only_allow_delete": null') && r.fix!.includes('Giải phóng đĩa TRƯỚC'), 'index bị khoá ghi → mở khoá SAU khi giải phóng đĩa');
}
check(!get(facts({ watermarks: { low: '95%', high: '97%', flood: '99%' }, nodes: [node({ diskAvail: 120 * GB })] }), 'disk:'), 'dùng watermark THẬT của cụm (95%) — 88% không báo');

// ── Shard chưa gán: đọc đúng lời ES ──
const unassigned = (over: Partial<EsFacts>) => facts({ status: 'yellow', unassigned: 4, unassignedList: [{ index: 'orders', shard: 0, primary: false, reason: 'NODE_LEFT' }], ...over });
{
  const u = get(unassigned({ allocationEnable: 'primaries' }), 'unassigned')!;
  check(u.evidence[0].includes('"primaries"') && !!u.sql?.includes('"cluster.routing.allocation.enable": null'), 'allocation.enable=primaries → bật lại phân bổ');
}
{
  const u = get(unassigned({
    status: 'red', unassignedList: [{ index: 'orders', shard: 2, primary: true, reason: 'NODE_LEFT' }],
    explain: { index: 'orders', shard: 2, primary: true, reason: 'NODE_LEFT', details: null, decision: 'no_valid_shard_copy', explanation: null, deciders: [] },
  }), 'unassigned')!;
  check(u.level === 'crit' && u.title.includes('PRIMARY'), 'primary chưa gán → đỏ, nêu rõ dữ liệu không truy cập được');
  check(u.fix!.startsWith('Đưa node cũ') && !!u.sql?.includes('accept_data_loss'), 'hết bản sao → ưu tiên đưa node cũ về; lệnh mất dữ liệu ghi rõ CHẤP NHẬN MẤT');
}
check(get(unassigned({ explain: { index: 'orders', shard: 0, primary: false, reason: 'ALLOCATION_FAILED', details: 'failed to create shard', decision: 'no', explanation: null, deciders: [{ decider: 'max_retry', explanation: 'shard has exceeded the maximum number of retries', nodes: 3 }] } }), 'unassigned')!.sql === 'POST _cluster/reroute?retry_failed=true',
  'max_retry → reroute retry_failed');
check(get(unassigned({ explain: { index: 'orders', shard: 0, primary: false, reason: 'NODE_LEFT', details: null, decision: 'no', explanation: null, deciders: [{ decider: 'disk_threshold', explanation: 'the node is above the high watermark', nodes: 3 }] } }), 'unassigned')!.evidence[0].includes('watermark đĩa'),
  'disk_threshold → nguyên nhân là đĩa');
{
  const u = get(unassigned({ dataNodes: 2, overReplicated: [{ index: 'orders', replicas: 2 }] }), 'unassigned')!;
  check(!!u.sql?.includes('"index.number_of_replicas": 1'), 'replica ≥ số node data → giảm replica về số node − 1');
}
check(get(unassigned({ initializing: 3, explain: { index: 'orders', shard: 0, primary: false, reason: 'NODE_LEFT', details: null, decision: 'throttled', explanation: null, deciders: [] } }), 'unassigned')!.step?.phase === 'long',
  'đang khôi phục (throttled) → chờ, không phải việc làm ngay');

// ── Heap ──
{
  const h = get(facts({ nodes: [node({ name: 'es-1', heapPct: 93, fielddata: 5 * GB })] }), 'heap:es-1')!;
  check(h.evidence.some((e) => e.includes('fielddata')) && !!h.sql?.includes('fielddata=true') && h.fix!.includes('keyword'), 'fielddata 31% heap → nguyên nhân fielddata, đổi sang keyword');
}
{
  const h = get(facts({ nodes: [node({ name: 'es-1', heapPct: 88, shards: 600, heapMax: 8 * GB })] }), 'heap:es-1')!;
  check(h.evidence.some((e) => e.includes('600 shard')) && h.fix!.includes('Giảm số shard'), '600 shard trên 8GB heap → quá nhiều shard');
}
check(get(facts({ nodes: [node({ name: 'es-1', heapPct: 70, oldGcCount: 6, oldGcMs: 1200 })] }), 'heap:es-1')?.level === 'crit', 'GC old 24% thời gian → đỏ dù heap% chưa cao');
check(get(facts({ nodes: [node({ name: 'es-1', heapMax: 40 * GB, ramTotal: 128 * GB })] }), 'oops:es-1')?.step?.phase === 'restart', 'heap 40GB → mất compressed oops, cần restart');

// ── CPU: việc gì đang ăn ──
{
  const c = get(facts({ nodes: [node({ name: 'es-1', cpu: 97, hotThreads: [{ pct: 91, kind: 'search', thread: 'elasticsearch[es-1][search][T#3]' }] })] }), 'cpu:es-1')!;
  check(c.level === 'crit' && c.title.includes('truy vấn') && !!c.sql?.includes('slowlog'), 'CPU 97% do search → đỏ, gợi ý slowlog + _tasks');
}
check(get(facts({ nodes: [node({ name: 'es-1', cpu: 90, hotThreads: [{ pct: 80, kind: 'gc', thread: 'VM Thread' }] })] }), 'cpu:es-1')!.fix!.includes('triệu chứng của heap'),
  'CPU do GC → chỉ sang heap, không khuyên tối ưu query');

// ── Thread pool ──
check(get(facts({ nodes: [node({ name: 'es-1', rejected: { search: 0, write: 340 } })] }), 'rejected')!.fix!.includes('khi ghi'), 'write bị từ chối → lời khuyên phía ghi');

// ── Shard ──
check(get(facts({ shardSizes: Array.from({ length: 2600 }, (_, i) => ({ index: `i${i}`, shard: 0, bytes: 10 * GB })) }), 'shard-limit')?.level === 'warn', '2600 shard / 3 node ≈ 87% max_shards_per_node → vàng');
check(!!get(facts({ shardSizes: Array.from({ length: 200 }, (_, i) => ({ index: `d${i}`, shard: 0, bytes: 50 * 1024 ** 2 })) }), 'small-shards'), '200 shard 50MB → quá nhiều shard nhỏ');
check(get(facts({ shardSizes: [{ index: 'big', shard: 0, bytes: 120 * GB }] }), 'huge-shards')!.evidence[0].includes('big[0]'), 'shard 120GB → nêu tên');

// ── CPU khi KHÔNG chạy hot_threads: dựa vào luồng đang chạy của thread pool ──
{
  const c = get(facts({ nodes: [node({ name: 'es-1', cpu: 96, poolActive: { search: 13, write: 1, management: 1 } })] }), 'cpu:es-1')!;
  check(c.title.includes('truy vấn') && c.evidence[0].includes('search 13'), 'không có hot_threads → CPU do search (13 luồng search đang chạy)');
}

// ── Truy vấn chậm khi cụm XANH ──
const srch = (queries: number, queryMs: number, over: Partial<NonNullable<EsNodeFacts['search']>> = {}) =>
  ({ queries, queryMs, storeBytes: 50 * GB, segments: 2000, indexing: 0, qcHit: 0, qcMiss: 0, qcEvictions: 0, ...over });
{
  const p = parseSearchDescription('indices[orders,logs-*], search_type[QUERY_THEN_FETCH], source[{"query":{"wildcard":{"name":{"value":"*abc"}}},"from":5000,"size":20}]');
  check(p.indices === 'orders,logs-*' && p.query.startsWith('{"query"'), 'đọc index + nguồn query từ description của _tasks');
  const fl = expensiveFlags(p.query, p.indices);
  check(fl.includes('wildcard đầu chuỗi') && fl.some((x) => x.startsWith('phân trang sâu')), 'nhận ra wildcard đầu chuỗi + phân trang sâu');
  check(expensiveFlags('{"query":{"match":{"name":"abc"}},"size":10}', 'orders').length === 0, 'query bình thường → không gắn cờ');
  check(expensiveFlags('{"query":{"match_all":{}}}', '*').includes('quét mọi index (*)'), 'quét "*" → gắn cờ');
}
{
  const r = get(facts({ running: [{ node: 'es-2', taskId: 'abc:123', ms: 45_000, description: 'indices[orders], source[{"query":{"regexp":{"sku":".*x"}}}]' }] }), 'running')!;
  check(r.level === 'crit' && r.title.includes('45s') && !!r.sql?.includes('POST _tasks/abc:123/_cancel') && r.evidence.some((e) => e.includes('regexp')),
    'query chạy 45s → đỏ, nêu dấu hiệu đắt + lệnh huỷ đúng task');
}
check(!get(facts({ running: [{ node: 'es-2', taskId: 'a:1', ms: 800, description: 'indices[orders]' }] }), 'running'), 'query < 5s → không nêu');
{
  const f = facts({ nodes: [node({ name: 'es-1', ramTotal: 32 * GB, heapMax: 16 * GB, search: srch(200, 160_000, { storeBytes: 300 * GB }) })] });
  const s = get(f, 'slow-search')!;
  check(s.level === 'crit' && s.evidence[0].includes('filesystem cache') && s.step?.phase === 'long', '800ms/query, dữ liệu gấp ~19 lần RAM cache → đọc đĩa (dài hạn: RAM / node / ILM)');
}
{
  const f = facts({ nodes: [node({ name: 'es-1', queue: { search: 120, write: 0 }, search: srch(500, 100_000) })] });
  check(get(f, 'slow-search')!.fix!.includes('msearch'), 'hàng đợi search đầy → quá nhiều query đồng thời');
}
check(!get(facts({ nodes: [node({ search: srch(10, 9_000) })] }), 'slow-search'), '< 20 lượt query trong cửa sổ → không kết luận tốc độ');
check(!get(facts({ nodes: [node({ search: srch(5_000, 50_000) })] }), 'slow-search'), '10ms/query → không báo chậm');
{
  const f = facts({ nodes: [
    node({ name: 'es-1', search: srch(300, 180_000) }), node({ name: 'es-2', search: srch(300, 15_000) }), node({ name: 'es-3', search: srch(300, 18_000) }),
  ] });
  const s = get(f, 'slow-node:es-1')!;
  check(!!s && s.title.includes('es-1') && !!s.sql?.includes('"cluster.routing.allocation.exclude._name": "es-1"'), 'một node chậm gấp ~12 lần → nêu đích danh, gợi ý tạm dời shard');
}
{
  const f = facts({ indexSearch: [{ index: 'orders', queries: 400, queryMs: 360_000 }, { index: 'logs', queries: 4000, queryMs: 40_000 }], slowlogIndices: [] });
  const s = get(f, 'slow-index')!;
  check(s.title.includes('orders') && s.evidence.some((e) => e.includes('Chưa bật search slowlog')) && !!s.sql?.includes('PUT orders/_settings'), 'index chậm nhất + chưa bật slowlog → lệnh bật slowlog đúng index');
}

// ── Pending task ──
check(get(facts({ pending: [{ source: 'put-mapping', count: 140 }] }), 'pending')!.fix!.includes('mapping explosion'), 'pending put-mapping → mapping explosion');

// ── Cụm khoẻ ──
{
  const d = analyzeEs(facts({}));
  check(d.findings.length === 0 && d.plan.length === 0 && d.headline.includes('không thấy vấn đề'), 'cụm khoẻ → không bịa vấn đề');
}

if (failures) {
  console.error(`\n${failures} ca hỏng`);
  process.exit(1);
}
console.log('\nTất cả ca đều qua');
