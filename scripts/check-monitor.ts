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

// ── Ghi đè ngưỡng ──
const ov: Overrides = { 'redis.memUsedPct': { warn: 40, crit: 60 } };
check(evaluate('redis', probe({ memUsedPct: 50 }), ov).level === 'warn', 'ghi đè hạ ngưỡng → 50% thành warn');
check(evaluate('redis', probe({ memUsedPct: 50 })).level === 'ok', 'không ghi đè → vẫn ok');
const rule = RULES.redis.find((r) => r.metric === 'memUsedPct')!;
check(effectiveRule('redis', rule, { 'redis.memUsedPct': { crit: null } }).crit === undefined, 'null bỏ hẳn một ngưỡng');
check(effectiveRule('redis', rule, { 'redis.memUsedPct': { warn: 10 } }).crit === 90, 'chỉ ghi đè warn thì crit giữ mặc định');

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
