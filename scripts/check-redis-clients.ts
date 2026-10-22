// scripts/check-redis-clients.ts — kiểm luật phân tích số client kết nối Redis.
//
// VÌ SAO CÓ FILE NÀY: cảnh báo client của Monitor dùng ngưỡng cố định, nên "6.000
// client" có thể là sắp sập (maxclients 6.500) hoặc chẳng sao (maxclients 50.000). Và
// cách sửa khác hẳn nhau: ứng dụng mở-đóng liên tục, pool quá to ở một máy, kết nối
// rảnh không bị ngắt — khuyên "nâng maxclients" cho mọi trường hợp là sửa sai chỗ.
//
//   npx tsx scripts/check-redis-clients.ts

import { analyzeRedisClients, type ClientGroup, type ClientList, type ClientsNode, type RedisClientsFacts } from '../lib/redisClientsRules';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else { failures += 1; console.error(`✗ ${m}`); }
};

const node = (over: Partial<ClientsNode>): ClientsNode => ({
  addr: '10.0.0.1:6379', version: '7.2.4', clients: 6_000, maxclients: 10_000, blocked: 0, pubsub: 0,
  newPerSec: 2, rejectedTotal: 0, rejectedWindow: 0, timeout: 0, keepalive: 300, ...over,
});
const group = (over: Partial<ClientGroup>): ClientGroup => ({ key: '10.1.1.1', count: 100, idle: 0, young: 0, pubsub: 0, blocked: 0, topCmd: 'get', ...over });
const list = (over: Partial<ClientList>): ClientList => ({
  total: 6_000, bySource: [group({ count: 6_000 })], byName: [group({ key: '(không đặt tên)', count: 6_000 })],
  idle: { lt60: 6_000, lt600: 0, lt3600: 0, ge3600: 0 }, young: 0, pubsub: 0, blocked: 0, durationMs: 9, ...over,
});
const facts = (nodes: ClientsNode[], over: Partial<RedisClientsFacts> = {}): RedisClientsFacts => ({ nodes, list: null, skipped: [], sampleSec: 3, ...over });
const find = (f: RedisClientsFacts, id: string) => analyzeRedisClients(f).findings.find((x) => x.id === id);

// ── So với trần thật ──
{
  const d = analyzeRedisClients(facts([node({ rejectedTotal: 900, rejectedWindow: 40, clients: 10_000 })]));
  check(d.findings[0]?.id === 'rejected' && d.findings[0].level === 'crit', 'đang từ chối trong cửa sổ đo → đỏ, đứng đầu');
  check(d.headline.toLowerCase().includes('từ chối'), 'kết luận chính nói đang từ chối');
}
check(find(facts([node({ rejectedTotal: 900, rejectedWindow: 0 })]), 'rejected')?.level === 'warn', 'chỉ có số cộng dồn cũ → vàng, ghi rõ không chắc đang xảy ra');
check(find(facts([node({ clients: 9_700 })]), 'near-max')?.level === 'crit', '97% maxclients → đỏ');
check(find(facts([node({ clients: 8_200 })]), 'near-max')?.level === 'warn', '82% maxclients → vàng');
{
  const d = analyzeRedisClients(facts([node({ maxclients: 50_000 })]));
  const t = d.findings.find((x) => x.id === 'threshold')!;
  check(!!t && t.level === 'info' && t.fix!.includes('40.000'), '6.000 / 50.000 → cảnh báo do ngưỡng cố định, gợi ý ngưỡng theo maxclients');
  check(d.headline.includes('ngưỡng cố định'), 'kết luận chính: còn xa trần thật');
  check(!d.findings.some((x) => x.id === 'near-max'), 'không báo gần trần khi còn xa');
}

// ── Mở / đóng liên tục ──
check(find(facts([node({ newPerSec: 800 })]), 'churn')?.level === 'crit', '800 kết nối mới/s → đỏ');
{
  const f = find(facts([node({ newPerSec: 120 })], { list: list({ bySource: [group({ key: '10.2.2.2', count: 3_000, young: 900 }), group({ count: 3_000 })] }) }), 'churn')!;
  check(f.level === 'warn' && f.evidence.some((e) => e.includes('10.2.2.2') && e.includes('900')), 'có danh sách → chỉ ra máy đang mở kết nối mới');
}
check(!find(facts([node({ newPerSec: 5 })]), 'churn'), '5 kết nối mới/s → bình thường');

// ── Từ danh sách client ──
{
  const f = find(facts([node({ clients: 8_500 })], { list: list({ total: 8_500, bySource: [group({ key: '10.9.9.9', count: 6_000 }), group({ count: 2_500 })] }) }), 'source')!;
  check(f.level === 'crit' && f.title.includes('10.9.9.9'), 'một máy giữ 71% kết nối khi đã 85% maxclients → đỏ, nêu máy');
  check(f.fix!.includes('pool size'), 'đề xuất giảm pool size');
}
{
  const L = list({ idle: { lt60: 1_000, lt600: 1_000, lt3600: 2_000, ge3600: 2_000 }, bySource: [group({ count: 6_000, idle: 4_000 })] });
  const f = find(facts([node({})], { list: L }), 'idle')!;
  check(f.title.includes('timeout = 0') && f.sql!.includes('timeout 600'), '67% kết nối rảnh ≥ 10 phút + timeout 0 → đề xuất timeout rộng');
  check(f.fix!.includes('pub/sub') && f.fix!.includes('staging'), 'nói rõ timeout không ngắt pub/sub và cần thử trước');
}
check(find(facts([node({})], { list: list({ pubsub: 3_000 }) }), 'pubsub')?.level === 'info', 'nhiều subscriber → gợi ý dùng chung kết nối');
check(find(facts([node({ keepalive: 0 })]), 'keepalive')?.sql?.includes('tcp-keepalive 300') === true, 'tcp-keepalive 0 → bật lại 300');

// ── Chưa có danh sách ──
{
  const f = find(facts([node({})]), 'no-list')!;
  check(f.evidence[0].includes('12 ms'), 'chưa bấm → nêu ước tính thời gian CLIENT LIST chiếm luồng chính');
  check(find(facts([node({})], { listRefused: '10.0.0.1:6379 có 15.000 client' }), 'no-list')!.title.includes('15.000'), 'bị từ chối → nêu lý do');
  check(!find(facts([node({})], { list: list({}) }), 'no-list'), 'đã có danh sách → không nhắc');
}

// ── Cụm ──
{
  const d = analyzeRedisClients(facts([node({ addr: 'a:1', clients: 2_000 }), node({ addr: 'b:2', clients: 9_000 })]));
  check(d.clients === 9_000 && d.findings.find((x) => x.id === 'near-max')!.title.includes('b:2'), 'cụm: node gần trần nhất quyết định, nêu tên node');
}

if (failures) {
  console.error(`\n${failures} ca hỏng`);
  process.exit(1);
}
console.log('\nTất cả ca đều qua');
