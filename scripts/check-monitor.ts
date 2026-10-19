// scripts/check-monitor.ts — kiểm luật xanh/vàng/đỏ của tab Monitor.
//
// VÌ SAO CÓ FILE NÀY: Monitor chỉ có giá trị khi màu ĐÚNG. Một ngưỡng so sai
// chiều (lt/gt), một chỉ số vắng mặt bị coi là 0, hay một lần probe lỗi bị tô
// xanh đều làm bảng "xanh cả" trong khi hạ tầng đang cháy — và nhìn từ UI thì
// khó phân biệt "ổn thật" với "không đo được". Các ca ở đây khoá những chỗ đó.
//
//   npx tsx scripts/check-monitor.ts

import { evaluate, effectiveRule, levelOf, rollup, RULES, STACK_ORDER, type Overrides } from '../lib/monitor/status';
import type { ProbeResult } from '../lib/automation/sources/infra';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else { failures += 1; console.error(`✗ ${m}`); }
};

const probe = (metrics: Record<string, number>, error?: string): ProbeResult => ({ at: 1, metrics: { up: 1, ...metrics }, ...(error ? { error } : {}) });

// ── Chưa đo / mất kết nối ──
check(evaluate('redis', undefined).level === 'unknown', 'chưa đo → unknown (không phải ok)');
check(evaluate('redis', { at: 1, metrics: { up: 0 } }).level === 'down', 'up=0 → down');
const withErr = evaluate('kafka', { at: 1, metrics: {}, error: 'ECONNREFUSED' });
check(withErr.level === 'down' && withErr.reasons[0].text.includes('ECONNREFUSED'), 'probe lỗi → down, nêu lỗi gốc');
check(evaluate('pg', { at: 1, metrics: {}, error: 'x' }).kpis.length === 0, 'down không hiện KPI cũ');

// ── Chiều so sánh ──
check(evaluate('redis', probe({ memUsedPct: 50 })).level === 'ok', 'redis RAM 50% → ok');
check(evaluate('redis', probe({ memUsedPct: 85 })).level === 'warn', 'redis RAM 85% → warn');
check(evaluate('redis', probe({ memUsedPct: 95 })).level === 'crit', 'redis RAM 95% → crit');
check(evaluate('redis', probe({ memUsedPct: 80 })).level === 'ok', 'đúng ngưỡng 80 chưa vượt → ok (gt, không phải gte)');
check(evaluate('redis', probe({ hitRatePct: 30 })).level === 'warn', 'hit rate 30% (dir lt) → warn');
check(evaluate('redis', probe({ hitRatePct: 99 })).level === 'ok', 'hit rate 99% → ok');

// ── Chỉ số vắng mặt không bị coi là 0 / vi phạm ──
check(evaluate('redis', probe({})).level === 'ok', 'không có chỉ số nào → ok, không báo giả');
check(evaluate('redis', probe({ hitRatePct: undefined as unknown as number })).level === 'ok', 'hit rate undefined (chưa có traffic) → ok');

// ── Chỉ số cờ ──
check(evaluate('kafka', probe({ noController: 1 })).level === 'crit', 'kafka không controller → crit');
check(evaluate('kafka', probe({ noController: 0, offline: 0, underReplicated: 0 })).level === 'ok', 'kafka khoẻ → ok');
check(evaluate('kafka', probe({ underReplicated: 3 })).level === 'warn', 'under-replicated nhỏ → warn');
check(evaluate('kafka', probe({ offline: 1 })).level === 'crit', 'partition offline → crit');
check(evaluate('rabbit', probe({ memAlarm: 1 })).level === 'crit', 'rabbit memory alarm → crit');
check(evaluate('rabbit', probe({ nodesDown: 1 })).level === 'crit', 'rabbit node down → crit');
check(evaluate('es', probe({ statusLevel: 0 })).level === 'ok', 'ES green → ok');
check(evaluate('es', probe({ statusLevel: 1 })).level === 'warn', 'ES yellow → warn');
check(evaluate('es', probe({ statusLevel: 2 })).level === 'crit', 'ES red → crit');
check(evaluate('es', probe({ statusLevel: 1 })).reasons[0].text.includes('yellow'), 'ES nêu màu cụm bằng chữ');
check(evaluate('mongo', probe({ membersUnhealthy: 1 })).level === 'crit', 'mongo member unhealthy → crit');

// ── Gộp nhiều vi phạm: mức tệ nhất, đỏ đứng trước ──
const multi = evaluate('es', probe({ unassignedShards: 2, heapPct: 97, statusLevel: 1 }));
check(multi.level === 'crit', 'nhiều vi phạm → lấy mức nặng nhất');
check(multi.reasons[0].level === 'crit' && multi.reasons.length === 3, 'lý do đỏ xếp trước, đủ 3 lý do');

// ── KPI mang màu của chính chỉ số ──
const kp = evaluate('redis', probe({ memUsedPct: 95, opsPerSec: 100, clients: 10 }));
check(kp.kpis.find((k) => k.metric === 'memUsedPct')?.level === 'crit', 'KPI RAM đỏ');
check(kp.kpis.find((k) => k.metric === 'opsPerSec')?.level === 'ok', 'KPI không có luật → ok');

// ── Cổng điều kiện (Rule.when): phân mảnh Redis chỉ có nghĩa khi dữ liệu đủ lớn ──
check(evaluate('redis', probe({ fragmentation: 9.4, memUsedMb: 12 })).level === 'ok', 'phân mảnh 9.4 nhưng chỉ dùng 12MB → bỏ qua (instance mới)');
check(evaluate('redis', probe({ fragmentation: 9.4, memUsedMb: 2048 })).level === 'crit', 'phân mảnh 9.4 với 2GB dữ liệu → crit');
check(evaluate('redis', probe({ fragmentation: 9.4 })).level === 'crit', 'không có chỉ số cổng → vẫn đánh giá (không có cơ sở bỏ qua)');
check(evaluate('redis', probe({ fragmentation: 9.4, memUsedMb: 12, memUsedPct: 95 })).level === 'crit', 'bỏ qua phân mảnh không làm mất luật khác (RAM 95% vẫn đỏ)');

// ── Ghi đè ngưỡng cổng ──
const fragRule = RULES.redis.find((r) => r.metric === 'fragmentation')!;
check(fragRule.when?.min === 256, 'mặc định cổng phân mảnh = 256MB');
check(evaluate('redis', probe({ fragmentation: 9.4, memUsedMb: 12 }), { 'redis.fragmentation': { whenMin: 0 } }).level === 'crit', 'whenMin=0 → luôn xét phân mảnh');
check(evaluate('redis', probe({ fragmentation: 9.4, memUsedMb: 500 }), { 'redis.fragmentation': { whenMin: 1024 } }).level === 'ok', 'whenMin=1024 → 500MB vẫn bị bỏ qua');
check(effectiveRule('redis', fragRule, { 'redis.fragmentation': { warn: 5 } }).when?.min === 256, 'ghi đè warn không đụng tới cổng');

// ── Ghi đè ngưỡng ──
const ov: Overrides = { 'redis.memUsedPct': { warn: 40, crit: 60 } };
check(evaluate('redis', probe({ memUsedPct: 50 }), ov).level === 'warn', 'ghi đè hạ ngưỡng → 50% thành warn');
check(evaluate('redis', probe({ memUsedPct: 50 })).level === 'ok', 'không ghi đè → vẫn ok');
const rule = RULES.redis.find((r) => r.metric === 'memUsedPct')!;
check(effectiveRule('redis', rule, { 'redis.memUsedPct': { crit: null } }).crit === undefined, 'null bỏ hẳn một ngưỡng');
check(effectiveRule('redis', rule, { 'redis.memUsedPct': { warn: 10 } }).crit === 90, 'chỉ ghi đè warn thì crit giữ mặc định');

// ── PostgreSQL ──
check(evaluate('pg', probe({ up: 1, latencyMs: 5 })).level === 'ok', 'pg chỉ có latency → ok');
check(evaluate('pg', probe({ up: 1, connectionsUsedPct: 85 })).level === 'warn', 'pg kết nối 85% → warn');
check(evaluate('pg', probe({ up: 1, connectionsUsedPct: 95 })).level === 'crit', 'pg kết nối 95% → crit');
check(evaluate('pg', probe({ up: 1, cacheHitPct: 85 })).level === 'warn', 'pg cache hit 85% → warn (luật lt)');
check(evaluate('pg', probe({ up: 1, cacheHitPct: 99.5 })).level === 'ok', 'pg cache hit cao → ok');
check(evaluate('pg', probe({ up: 1, wraparoundPct: 75 })).level === 'crit', 'pg XID 75% → crit');
check(evaluate('pg', probe({ up: 1, hostDiskUsedPct: 92 })).level === 'crit', 'pg đĩa máy chủ 92% → crit');
check(evaluate('pg', probe({ up: 1, inactiveSlots: 1 })).level === 'warn', 'pg slot không hoạt động → warn');
check(evaluate('pg', probe({ up: 1, connectionsUsedPct: 10, cacheHitPct: 99 })).kpis.length === 2, 'pg KPI chỉ gồm chỉ số có mặt');

// ── MinIO ──
check(evaluate('minio', probe({ up: 1, latencyMs: 40, buckets: 3, clusterDown: 0 })).level === 'ok', 'minio khoẻ → ok');
check(evaluate('minio', probe({ up: 1, clusterDown: 1 })).level === 'crit', 'minio thiếu quorum → crit');
check(evaluate('minio', probe({ up: 1, diskUsedPct: 85 })).level === 'warn', 'minio đĩa 85% → warn');
check(evaluate('minio', probe({ up: 1, drivesOffline: 1 })).level === 'warn', 'minio mất 1 ổ → warn');
check(evaluate('minio', probe({ up: 0 })).level === 'down', 'minio up=0 → down');
check(evaluate('minio', probe({ up: 1, hostDiskUsedPct: 93 })).level === 'crit', 'minio đĩa máy chủ 93% → crit');
check(evaluate('minio', probe({ up: 1, hostsDown: 1 })).level === 'warn', 'minio mất exporter → warn');
check(evaluate('minio', probe({ up: 1, nodesOffline: 1 })).level === 'warn', 'minio mất 1 node → warn');
check(evaluate('minio', probe({ up: 1, nodesOffline: 2 })).level === 'crit', 'minio mất 2 node → crit');
check(evaluate('minio', probe({ up: 1, latencyMs: 5, buckets: 2 })).kpis.some((k) => k.metric === 'buckets'), 'minio KPI có số bucket');

// ── rollup ──
check(rollup([]) === 'unknown', 'nhóm rỗng → unknown');
check(rollup(['ok', 'warn', 'ok']) === 'warn', 'rollup lấy mức xấu nhất');
check(rollup(['ok', 'down', 'crit']) === 'down', 'down nặng hơn crit');
check(rollup(['unknown', 'ok']) === 'ok', 'chưa đo không kéo nhóm xuống');

// ── Toàn vẹn bảng luật ──
for (const s of STACK_ORDER) {
  for (const r of RULES[s]) {
    check(r.warn !== undefined || r.crit !== undefined, `${s}.${r.metric} có ít nhất một ngưỡng`);
    if (r.warn !== undefined && r.crit !== undefined) {
      const ordered = r.dir === 'gt' ? r.crit > r.warn : r.crit < r.warn;
      check(ordered, `${s}.${r.metric}: ngưỡng đỏ nặng hơn ngưỡng vàng`);
    }
  }
}
check(levelOf(rule, 91) === 'crit', 'levelOf trực tiếp');

if (failures > 0) { console.error(`\n${failures} ca hỏng`); process.exit(1); }
console.log('\nTất cả ca đạt');
