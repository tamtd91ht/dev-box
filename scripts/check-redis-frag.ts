// scripts/check-redis-frag.ts — kiểm luật phân tích phân mảnh bộ nhớ Redis.
//
// VÌ SAO CÓ FILE NÀY: cùng một tỉ lệ phân mảnh 2.5 có bốn cách xử lý khác nhau tuỳ
// phần thừa nằm ở đâu — bảo "bật activedefrag" khi thật ra là trang chưa trả OS hay
// THP, hoặc bảo xử lý khi dữ liệu chỉ vài chục MB, đều là sửa sai chỗ. Và vì mọi
// Redis là production: lệnh đề xuất chạy trên luồng chính phải có trần / lưu ý giờ.
//
//   npx tsx scripts/check-redis-frag.ts

import { analyzeRedisFrag, classifyNode, type FragNode, type RedisFragFacts } from '../lib/redisFragRules';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else { failures += 1; console.error(`✗ ${m}`); }
};

const MB = 1024 * 1024;
const GB = 1024 * MB;
const node = (over: Partial<FragNode>): FragNode => ({
  addr: '10.0.0.1:6379', version: '7.2.4', allocator: 'jemalloc-5.3.0',
  used: 4 * GB, rss: 10 * GB, peak: 4 * GB, maxmemory: 0, system: 32 * GB,
  ratio: 2.5, fragBytes: 6 * GB,
  allocFragRatio: 2.4, allocFragBytes: 5.6 * GB, allocRssRatio: 1.02, allocRssBytes: 0.2 * GB,
  rssOverheadRatio: 1.02, rssOverheadBytes: 0.2 * GB,
  lazyfreePending: 0, forking: false, lastCowBytes: null,
  defrag: { enabled: false, running: false, hitsPerSec: null, ignoreBytes: 100 * MB, thresholdLowerPct: 10, cycleMax: 25 },
  ...over,
});
const facts = (nodes: FragNode[], over: Partial<RedisFragFacts> = {}): RedisFragFacts => ({ nodes, sampleSec: 3, skipped: [], ...over });
const find = (f: RedisFragFacts, id: string) => analyzeRedisFrag(f).findings.find((x) => x.id === id);

// ── Phân loại ──
check(classifyNode(node({})) === 'allocFrag', 'phần lớn nhất là allocator_frag → lỗ giữa object');
check(classifyNode(node({ allocFragRatio: 1.02, allocFragBytes: 0.1 * GB, allocRssRatio: 2.3, allocRssBytes: 5 * GB })) === 'allocRss', 'allocator_rss lớn nhất → trang chưa trả OS');
check(classifyNode(node({ allocFragRatio: 1.02, allocFragBytes: 0.1 * GB, rssOverheadRatio: 2.2, rssOverheadBytes: 5 * GB })) === 'rssOverhead', 'rss_overhead lớn nhất → ngoài allocator');
check(classifyNode(node({ used: 40 * MB, rss: 120 * MB, ratio: 3, fragBytes: 80 * MB })) === 'small', 'dữ liệu 40 MB, tỉ lệ 3 → không đáng kể');
check(classifyNode(node({ used: 2 * GB, rss: 1.2 * GB, ratio: 0.6, fragBytes: -0.8 * GB })) === 'swap', 'tỉ lệ 0.6 → swap');
check(classifyNode(node({ ratio: 1.3, fragBytes: 1.2 * GB })) === 'ok', 'dưới ngưỡng cảnh báo → ổn');
check(classifyNode(node({ allocFragRatio: null, allocFragBytes: null, allocRssRatio: null, allocRssBytes: null, rssOverheadRatio: null, rssOverheadBytes: null })) === 'unsplit', 'Redis cũ không tách số → không đoán bừa');

// ── Lỗ giữa object: đề xuất theo trạng thái activedefrag ──
{
  const f = find(facts([node({})]), 'alloc-frag')!;
  check(f.level === 'warn' && f.sql!.includes('activedefrag yes'), 'defrag tắt → đề xuất bật');
  check(f.sql!.includes('active-defrag-cycle-max 10') && f.sql!.includes('activedefrag no'), 'production: trần CPU 10% + lệnh dừng ngay');
}
{
  const f = find(facts([node({ defrag: { enabled: true, running: true, hitsPerSec: 1200, ignoreBytes: 100 * MB, thresholdLowerPct: 10, cycleMax: 25 } })]), 'alloc-frag')!;
  check(f.level === 'info' && f.fix!.includes('đang chạy') && f.step?.phase === 'observe', 'defrag đang chạy → chờ, chỉ theo dõi');
}
{
  const f = find(facts([node({ allocFragRatio: 1.12, allocFragBytes: 80 * MB, defrag: { enabled: true, running: false, hitsPerSec: 0, ignoreBytes: 100 * MB, thresholdLowerPct: 15, cycleMax: 25 } })]), 'alloc-frag')!;
  check(f.fix!.includes('ignore-bytes') && f.fix!.includes('threshold-lower'), 'defrag bật mà không chạy → chỉ đúng ngưỡng đang chặn');
}
check(find(facts([node({ allocator: 'libc', defrag: { enabled: false, running: false, hitsPerSec: null, ignoreBytes: null, thresholdLowerPct: null, cycleMax: null } })]), 'alloc-frag')!.step?.phase === 'restart',
  'libc không có activedefrag → failover / restart');
check(find(facts([node({ defrag: { enabled: null, running: false, hitsPerSec: null, ignoreBytes: null, thresholdLowerPct: null, cycleMax: null } })], { configError: 'unknown command CONFIG' }), 'alloc-frag')!.fix!.includes('parameter group'),
  'CONFIG bị chặn → bật qua cấu hình nhà cung cấp');
check(find(facts([node({ peak: 12 * GB })]), 'alloc-frag')!.evidence.some((e) => e.includes('Đỉnh từng dùng')), 'đỉnh ≫ hiện tại → nêu là đã xoá hàng loạt');

// ── Các phần khác ──
{
  const f = find(facts([node({ allocFragRatio: 1.02, allocFragBytes: 0.1 * GB, allocRssRatio: 2.3, allocRssBytes: 5 * GB })]), 'alloc-rss')!;
  check(f.sql!.startsWith('MEMORY PURGE') && f.fix!.includes('thấp điểm'), 'trang chưa trả OS → MEMORY PURGE lúc thấp điểm');
  check(!find(facts([node({ allocFragRatio: 1.02, allocFragBytes: 0.1 * GB, allocRssRatio: 2.3, allocRssBytes: 5 * GB })]), 'alloc-frag'), 'không khuyên activedefrag khi lỗ không phải thủ phạm');
}
{
  const ovh = { allocFragRatio: 1.02, allocFragBytes: 0.1 * GB, rssOverheadRatio: 2.2, rssOverheadBytes: 5 * GB };
  check(find(facts([node({ ...ovh, forking: true })]), 'rss-overhead')!.level === 'info', 'đang BGSAVE → tạm thời, mức thông tin');
  check(find(facts([node(ovh)]), 'rss-overhead')!.sql!.includes('transparent_hugepage'), 'ngoài allocator, không fork → kiểm THP');
}
{
  const d = analyzeRedisFrag(facts([node({ used: 2 * GB, rss: 1.2 * GB, ratio: 0.6, fragBytes: -0.8 * GB })]));
  check(d.findings[0]?.id === 'swap' && d.headline.includes('swap'), 'swap đứng đầu, kết luận nói rõ không phải phân mảnh');
}
{
  const d = analyzeRedisFrag(facts([node({ used: 40 * MB, rss: 120 * MB, ratio: 3, fragBytes: 80 * MB })]));
  check(d.headline.includes('không cần xử lý') && d.plan.length === 0, 'dữ liệu nhỏ → không bày việc sửa');
}
check(find(facts([node({ system: 11 * GB })]), 'ram')?.level === 'crit', 'RSS 91% RAM máy (10/11 GB) → đỏ');

// ── Cụm nhiều node ──
{
  const d = analyzeRedisFrag(facts([
    node({ addr: 'a:1', ratio: 1.2, fragBytes: 0.8 * GB, allocFragRatio: 1.05, allocFragBytes: 0.1 * GB }),
    node({ addr: 'b:2' }),
  ], { skipped: [{ addr: 'c:3', error: 'quá 5s' }] }));
  check(d.nodes[0].addr === 'b:2' && d.headline.includes('b:2'), 'node nặng nhất lên đầu, kết luận nêu tên node');
  check(d.skipped.length === 1, 'node không trả lời được báo lại, không làm hỏng cả lần phân tích');
}

if (failures) {
  console.error(`\n${failures} ca hỏng`);
  process.exit(1);
}
console.log('\nTất cả ca đều qua');
