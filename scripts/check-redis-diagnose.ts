// scripts/check-redis-diagnose.ts — kiểm luật phân tích hit rate Redis.
//
// VÌ SAO CÓ FILE NÀY: "dạng key nào miss" chỉ có ích khi (1) gom đúng dạng —
// tách nhầm thì mỗi key một dạng, gộp nhầm thì trộn hai loại cache khác nhau —
// và (2) phán đoán đúng vì sao: bảo "tăng TTL" cho dạng key không bao giờ được
// ghi, hay bảo "sửa chỗ ghi" cho dữ liệu dài đuôi, đều là sửa sai chỗ.
//
//   npx tsx scripts/check-redis-diagnose.ts

import { analyzeRedisMisses, keyPattern, type MissPattern, type RedisMissFacts } from '../lib/redisDiagnoseRules';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else { failures += 1; console.error(`✗ ${m}`); }
};

// ── Chuẩn hoá tên key ──
const pat = (k: string) => keyPattern(k).pattern;
check(pat('user:12345:profile') === 'user:{n}:profile', 'số → {n}');
check(pat('sess:3f2a9c1e-8b7d-4c6e-9f1a-2b3c4d5e6f70') === 'sess:{uuid}', 'UUID → {uuid}');
check(pat('otp:someone@vihat.vn') === 'otp:{email}', 'email → {email}');
check(pat('order_98765:items') === 'order_{n}:items', 'chữ lẫn số dài → giữ phần chữ');
check(pat('report:2026-10-21:daily') === 'report:{date}:daily', 'ngày → {date}');
check(pat('obj:65f1c2a9b3e4d5f6a7b8c9d0') === 'obj:{hex}', 'ObjectId / hex dài → {hex}');
check(pat('tok:eyJhbGciOiJIUzI1NiJ9abc123') === 'tok:{token}', 'token dài → {token}');
check(pat('cache/v2/items') === 'cache/v2/items', 'phần cố định ngắn giữ nguyên (v2 không bị thay)');
check(pat('user:1:profile') === pat('user:987654:profile'), 'hai key cùng loại → cùng một dạng');
check(pat('user:1:profile') !== pat('user:1:settings'), 'khác hậu tố → khác dạng');
check(keyPattern('user:42:profile').glob === 'user:*:profile', 'glob cho SCAN MATCH');
check(keyPattern('a*b:7').glob === 'a\\*b:*', 'ký tự glob trong phần cố định được thoát');

// ── Phán đoán ──
const pattern = (over: Partial<MissPattern>): MissPattern => ({
  db: 0, pattern: 'user:{n}:profile', glob: 'user:*:profile', misses: 800, distinct: 600,
  topKey: 'user:42:profile', topKeyMisses: 2, samples: ['user:42:profile', 'user:43:profile'],
  refilled: 0, checked: 20, existing: 0, ttl: null, ...over,
});
const facts = (over: Partial<RedisMissFacts>): RedisMissFacts => ({
  version: '7.2.4', nodes: 1, capture: { ok: true }, originalFlags: '', durationSec: 10,
  cumulative: { hits: 40_000, misses: 60_000 }, window: { hits: 2_000, misses: 1_000, sec: 10 },
  captured: 1_000, distinctCapped: false, patterns: [],
  evicted: { total: 0, window: 0 }, expired: { total: 0, window: 0 },
  memory: { used: 1e9, max: 4e9, policy: 'allkeys-lru' }, scan: { scanned: 50_000, dbsize: 50_000 },
  ...over,
});
const find = (f: RedisMissFacts, prefix: string) => analyzeRedisMisses(f).findings.find((x) => x.id.startsWith(prefix));

{
  const f = find(facts({ patterns: [pattern({})] }), 'pat:')!;
  check(f.level === 'crit' && f.title.includes('không bao giờ được ghi'), 'dạng chiếm 80% miss, không key nào tồn tại, không được nạp lại → "không bao giờ được ghi", mức đỏ');
  check(!f.fix!.includes('Tăng TTL'), '"không bao giờ được ghi" không khuyên tăng TTL');
  check(f.sql!.includes('SCAN 0 MATCH "user:*:profile"') && f.sql!.includes('EX 60'), 'lệnh kiểm tra đúng dạng (glob trong ngoặc kép, không bị shell mở rộng) + negative cache có TTL');
}
{
  const f = find(facts({ patterns: [pattern({ topKey: 'user:0:profile', topKeyMisses: 120, distinct: 5 })] }), 'pat:')!;
  check(f.title.includes('miss lặp lại') && f.title.includes('120'), 'cùng key miss 120 lần → "miss lặp lại, không ai nạp lại"');
}
{
  const f = find(facts({ patterns: [pattern({ existing: 3_000, refilled: 15, ttl: { withTtl: 30, noTtl: 0, medianSec: 30, minSec: 5 } })] }), 'pat:')!;
  check(f.title.includes('TTL quá ngắn') && !!f.step?.text.includes('tăng TTL'), 'key có thật nhưng TTL trung vị 30s → TTL quá ngắn');
}
{
  const f = find(facts({ patterns: [pattern({ misses: 800, distinct: 790, existing: 9_000, refilled: 19, ttl: { withTtl: 30, noTtl: 0, medianSec: 3_600, minSec: 900 } })] }), 'pat:')!;
  check(f.level === 'info' && f.title.includes('đọc ~1 lần'), 'mỗi key miss 1 lần, được nạp lại, TTL dài → dữ liệu dài đuôi (mức thông tin)');
  check(f.fix!.includes('Tăng TTL không giúp'), 'dài đuôi: nói rõ tăng TTL không giúp');
}
check(!find(facts({ captured: 1_000, patterns: [pattern({ misses: 10 })] }), 'pat:'), 'dạng chiếm 1% miss → không nêu riêng');

// ── Nguyên nhân toàn cục ──
{
  const f = find(facts({ evicted: { total: 90_000, window: 500 }, memory: { used: 3.9e9, max: 4e9, policy: 'volatile-lru' } }), 'evict')!;
  check(f.level === 'crit' && f.title.includes('500 key'), 'evict 50 key/s trong cửa sổ → đỏ');
  check(analyzeRedisMisses(facts({ evicted: { total: 90_000, window: 500 } })).plan[0]?.text.startsWith('Giảm áp lực bộ nhớ'), 'evict đứng đầu kế hoạch');
}
check(!find(facts({ evicted: { total: 90_000, window: 0 }, memory: { used: 1e9, max: 4e9, policy: 'allkeys-lru' } }), 'evict'), 'chỉ evict trong quá khứ, bộ nhớ còn rộng → không báo');

// ── Không bắt được ──
{
  const d = analyzeRedisMisses(facts({ version: '5.0.7', capture: { ok: false, reason: 'version' }, captured: 0 }));
  check(d.findings.some((x) => x.id === 'no-capture' && x.title.includes('5.0.7')), 'Redis 5 → nói rõ chưa hỗ trợ keymiss');
  check(d.headline.includes('chưa bắt được'), 'kết luận chính không bịa dạng key');
}
check(find(facts({ capture: { ok: false, reason: 'config', detail: 'unknown command CONFIG' }, captured: 0 }), 'no-capture')!.fix!.includes('parameter group'),
  'CONFIG bị khoá → hướng dẫn bật qua cấu hình nhà cung cấp');

{
  const d = analyzeRedisMisses(facts({ capture: { ok: false, reason: 'load', detail: '48.000 miss/giây' }, captured: 0 }));
  const f = d.findings.find((x) => x.id === 'no-capture')!;
  check(f.title.includes('bảo vệ production') && f.fix!.includes('phía ứng dụng'), 'miss quá cao → không bật sự kiện, đề xuất đếm phía ứng dụng');
}

// ── Hiện tại hay chuyện cũ ──
{
  const d = analyzeRedisMisses(facts({ window: { hits: 9_500, misses: 500, sec: 10 }, patterns: [pattern({})] }));
  check(d.currentPct === 95 && d.cumulativePct === 40, 'tính đúng hit rate hiện tại / cộng dồn');
  check(d.headline.startsWith('Không có sự cố hiện tại') && d.plan.every((s) => s.phase === 'observe'), 'chuyện cũ → không bày việc sửa');
}
check(analyzeRedisMisses(facts({ window: { hits: 50, misses: 20, sec: 10 } })).currentPct === null, 'tải quá thấp → không bịa tỉ lệ hiện tại');

// ── An toàn: không trả lại được cấu hình ──
{
  const d = analyzeRedisMisses(facts({ restoreError: '10.0.0.5:6379 — READONLY', originalFlags: 'Ex' }));
  check(d.findings[0]?.id === 'restore' && d.findings[0].sql === 'CONFIG SET notify-keyspace-events "Ex"', 'trả lại thất bại → mục đỏ đầu tiên + lệnh khôi phục đúng giá trị cũ');
  check(d.plan[0]?.text.startsWith('Trả lại notify-keyspace-events'), 'khôi phục cấu hình là bước đầu của kế hoạch');
}

// ── Kết luận chính ──
check(analyzeRedisMisses(facts({ patterns: [pattern({})] })).headline.includes('dạng user:{n}:profile'), 'kết luận chính nêu tên dạng key trội');

if (failures) {
  console.error(`\n${failures} ca hỏng`);
  process.exit(1);
}
console.log('\nTất cả ca đều qua');
