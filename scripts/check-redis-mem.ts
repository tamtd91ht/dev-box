// scripts/check-redis-mem.ts — kiểm luật phân tích RAM đã dùng của Redis.
//
// VÌ SAO CÓ FILE NÀY: "RAM 85%" có cách xử lý rất khác nhau — noeviction sắp từ chối
// ghi, volatile-* mà ít key có TTL (đầy là từ chối ghi dù tưởng có evict), bộ đệm
// client phình vì subscriber chậm, hay dữ liệu không TTL tích dần. Khuyên "tăng RAM"
// cho mọi trường hợp là sửa sai chỗ; và số từ mẫu key phải luôn là ước lượng.
//
//   npx tsx scripts/check-redis-mem.ts

import { analyzeRedisMem, growthPerHour, type MemNode, type MemSample, type RedisMemFacts } from '../lib/redisMemRules';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else { failures += 1; console.error(`✗ ${m}`); }
};

const MB = 1024 * 1024;
const GB = 1024 * MB;
const node = (over: Partial<MemNode>): MemNode => ({
  addr: '10.0.0.1:6379', version: '7.2.4', role: 'master',
  used: 3.4 * GB, maxmemory: 4 * GB, system: 16 * GB, rss: 3.6 * GB, peak: 3.5 * GB, dataset: 3 * GB,
  parts: { clientsNormal: 20 * MB, clientsReplicas: 0, replBacklog: 1 * MB, aofBuffer: 0, scripts: 1 * MB, hashtables: 200 * MB },
  keys: 2_000_000, expires: 1_800_000, bytesPerKey: 1700, clients: 300,
  policy: 'allkeys-lru', save: '', aof: false,
  evictedPerSec: 0, expiredPerSec: 50, expiredStalePct: 2, oomErrors: 0, lastCowBytes: null, topClients: null,
  ...over,
});
const facts = (nodes: MemNode[], over: Partial<RedisMemFacts> = {}): RedisMemFacts => ({ nodes, history: [], sample: null, skipped: [], sampleSec: 3, ...over });
const find = (f: RedisMemFacts, id: string) => analyzeRedisMem(f).findings.find((x) => x.id === id);

// ── Đầy thì sao ──
{
  const f = find(facts([node({ policy: 'noeviction' })]), 'noeviction')!;
  check(f.level === 'warn' && f.title.includes('từ chối'), 'noeviction ở 85% → cảnh báo sẽ từ chối ghi');
  check(find(facts([node({ policy: 'noeviction', oomErrors: 1234 })]), 'noeviction')!.level === 'crit', 'đã có lệnh bị từ chối vì OOM → đỏ');
  check(!find(facts([node({ policy: 'noeviction', used: 1 * GB })]), 'noeviction'), 'noeviction ở 25%, chưa từ chối → không báo');
}
check(find(facts([node({ policy: 'volatile-lru', expires: 100_000 })]), 'volatile-no-ttl')?.level === 'crit', 'volatile-lru mà 5% key có TTL ở 85% → đỏ');
check(find(facts([node({ maxmemory: 0 })]), 'no-maxmemory')?.sql?.includes('mb') === true, 'không đặt maxmemory → đề xuất con số cụ thể theo RAM máy');
check(find(facts([node({ evictedPerSec: 400 })]), 'evicting')?.level === 'crit', 'evict 400 key/s → đỏ');

// ── RAM nằm ở đâu ──
{
  const f = find(facts([node({ parts: { ...node({}).parts, clientsNormal: 900 * MB }, topClients: [{ addr: '10.1.1.9:5122', name: 'notifier', cmd: 'psubscribe', bytes: 850 * MB, omem: 840 * MB }] })]), 'client-buffers')!;
  check(f.level === 'crit' && f.evidence.some((e) => e.includes('notifier') && e.includes('psubscribe')), 'bộ đệm client 26% RAM → đỏ, chỉ ra client nào');
  check(f.sql!.includes('pubsub'), 'đề xuất giới hạn output buffer pubsub');
}
check(find(facts([node({ parts: { ...node({}).parts, clientsNormal: 200 * MB }, topClients: null, clients: 8000 })]), 'client-buffers')!.evidence.some((e) => e.includes('Không chạy CLIENT LIST')),
  'nhiều client → nói rõ không chạy CLIENT LIST');
check(find(facts([node({ parts: { ...node({}).parts, scripts: 300 * MB } })]), 'scripts')?.fix?.includes('ARGV') === true, 'cache Lua phình → sửa ứng dụng dùng ARGV');
check(analyzeRedisMem(facts([node({})])).breakdown[0].label.startsWith('Dữ liệu'), 'bảng phân bổ: dữ liệu lớn nhất đứng đầu');

// ── Key không TTL / hết hạn ──
check(find(facts([node({ expires: 200_000 })]), 'no-ttl')?.level === 'warn', '90% key không TTL ở 85% → cảnh báo');
check(find(facts([node({ expiredStalePct: 40 })]), 'expire-lag')?.sql?.includes('active-expire-effort 2') === true, 'key hết hạn dọn không kịp → active-expire-effort từng bước');

// ── Fork ──
check(find(facts([node({ used: 10 * GB, maxmemory: 12 * GB, save: '3600 1 300 100' })]), 'fork')?.level === 'warn', 'dữ liệu 62% RAM máy + BGSAVE → cảnh báo fork');
check(!find(facts([node({ used: 10 * GB, maxmemory: 12 * GB, save: '', aof: false })]), 'fork'), 'không lưu đĩa → không báo fork');

// ── Xu hướng ──
{
  const t0 = Date.parse('2026-10-22T08:00:00Z');
  const hist = Array.from({ length: 40 }, (_, i) => ({ at: t0 + i * 30_000, mb: 3400 + i * 5 })); // +5 MB / 30s = 600 MB/giờ
  check(Math.round(growthPerHour(hist)!) === 600, 'hồi quy: +5 MB mỗi 30s = 600 MB/giờ');
  const f = find(facts([node({})], { history: hist }), 'trend')!;
  check(f.level === 'crit' && f.title.includes('600'), 'còn ~0.6 GB, tăng 600 MB/giờ → chạm sau ~1 giờ → đỏ');
  check(growthPerHour(hist.slice(0, 3)) === null, 'lịch sử quá ngắn → không ngoại suy');
}

// ── Lấy mẫu key ──
{
  const sample: MemSample = {
    scanned: 50_000, dbsize: 2_000_000, measured: 2_000, bytes: 4_000_000,
    patterns: [
      { db: 0, pattern: 'feed:{n}', count: 400, bytes: 2_800_000, noTtl: 390, maxKey: 'feed:42', maxBytes: 60_000 },
      { db: 0, pattern: 'sess:{uuid}', count: 1_600, bytes: 1_200_000, noTtl: 0, maxKey: 'sess:x', maxBytes: 900 },
    ],
    topKeys: [{ db: 0, key: 'feed:all', bytes: 64 * MB, type: 'zset' }],
  };
  const d = analyzeRedisMem(facts([node({})], { sample }));
  check(d.patterns![0].pattern === 'feed:{n}' && d.patterns![0].sharePct === 70, 'dạng chiếm nhiều byte nhất đứng đầu (70%), không phải dạng nhiều key nhất');
  check(d.findings.find((x) => x.id === 'pat:0:feed:{n}')!.title.includes('không TTL'), 'dạng chiếm nhiều + phần lớn không TTL → nêu rõ');
  const big = d.findings.find((x) => x.id === 'big-keys')!;
  check(big.fix!.includes('UNLINK') && big.evidence.some((e) => e.includes('RƠI VÀO MẪU')), 'key lớn → UNLINK thay DEL, nói rõ chỉ là trong mẫu');
  check(!d.findings.some((x) => x.id === 'no-sample'), 'đã có mẫu → không nhắc lấy mẫu');
}
check(find(facts([node({})], { sampleRefused: 'CPU luồng chính 85%' }), 'no-sample')!.title.includes('CPU'), 'từ chối lấy mẫu → nêu lý do');

// ── Kết luận chính ──
check(analyzeRedisMem(facts([node({ policy: 'noeviction', oomErrors: 5 })])).headline.includes('bị từ chối'), 'kết luận chính nêu việc nặng nhất');
{
  const d = analyzeRedisMem(facts([node({ addr: 'a:1', used: 1 * GB }), node({ addr: 'b:2' })]));
  check(d.used === node({}).used && d.limit === 4 * GB, 'cụm: lấy node căng nhất (giống Monitor)');
}

if (failures) {
  console.error(`\n${failures} ca hỏng`);
  process.exit(1);
}
console.log('\nTất cả ca đều qua');
