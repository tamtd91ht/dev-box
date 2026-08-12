// check:automation — chốt chặn drift giữa CATALOG (bản khai báo cho UI) và
// EMISSION thật (sources/ + meta.ts).
//
// Bài học dẫn tới script này: catalog từng thiếu severity/stackLabel/
// metricLabel/watchId… trong khi config thật đã template chúng — hai danh sách
// duy trì tay thì TẤT sẽ lệch. sampleEvent() gọi chính builder thật, nên so
// keys của nó với FieldDef của catalog là so "UI hứa gì" với "engine phát gì".
//
// Chạy: npm run check:automation (tsx). Exit 1 kèm diff khi lệch.

import { GROUPS, STACKS, triggerDef } from '../lib/automation/catalog';
import { sampleEvent } from '../lib/automation/sample';
import type { TriggerType } from '../lib/automation/types';

let failures = 0;

function fail(msg: string): void {
  failures += 1;
  console.error(`✗ ${msg}`);
}

function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

/** Tên field catalog HỨA nằm trong event.fields của một trigger (bỏ derived). */
function declaredFields(trigger: TriggerType): Set<string> {
  const def = triggerDef(trigger);
  return new Set((def?.fields ?? []).filter((f) => !f.derived).map((f) => f.name));
}

function diffSets(label: string, emitted: Set<string>, declared: Set<string>): void {
  const missing = [...emitted].filter((k) => !declared.has(k)).sort();
  const stale = [...declared].filter((k) => !emitted.has(k)).sort();
  if (!missing.length && !stale.length) {
    ok(label);
    return;
  }
  if (missing.length) fail(`${label}: emission có mà catalog THIẾU: ${missing.join(', ')}`);
  if (stale.length) fail(`${label}: catalog khai mà emission KHÔNG phát: ${stale.join(', ')}`);
}

// ── 1. Trigger infra: emission ≡ catalog, cho TỪNG stack ────────────────────

const INFRA_TRIGGERS: TriggerType[] = ['infra.metric', 'infra.recovered'];
const AT = 1700000000000; // cố định để chạy lặp lại được

for (const trigger of INFRA_TRIGGERS) {
  const declared = declaredFields(trigger);
  for (const stack of STACKS.map((st) => st.id)) {
    const emitted = new Set(Object.keys(sampleEvent(trigger, stack, AT).fields ?? {}));
    diffSets(`${trigger} × ${stack}`, emitted, declared);
  }
}

// ── 2. message.received: mẫu Zalo API (đủ field nhất) ≡ catalog ─────────────

diffSets(
  'message.received × zaloapi',
  new Set(Object.keys(sampleEvent('message.received', undefined, AT).fields ?? {})),
  declaredFields('message.received'),
);

// ── 3. system.test: field tự do — catalog không được khai field cứng nào ────

diffSets(
  'system.test',
  new Set(Object.keys(sampleEvent('system.test', undefined, AT).fields ?? {})),
  declaredFields('system.test'),
);

// ── 4. MetricDef: mọi metric phải tự giải thích được ────────────────────────
// description tự sinh (meta.ts buildDescription) dựa vào meaning + probe;
// alertType dựa vào alertCode (trừ `up` — đặc cách `stack.down`).

for (const st of STACKS) {
  for (const m of st.metrics) {
    const miss: string[] = [];
    if (!m.meaning) miss.push('meaning');
    if (!m.probe) miss.push('probe');
    if (!m.alertCode && m.key !== 'up') miss.push('alertCode');
    if (miss.length) fail(`MetricDef ${st.id}.${m.key}: thiếu ${miss.join(', ')}`);
  }
}
ok(`MetricDef: ${STACKS.reduce((a, st) => a + st.metrics.length, 0)} metric đã soát meaning/probe/alertCode`);

// ── 5. FieldDef non-derived phải có sample (bảng biến cần ví dụ cụ thể) ─────

for (const g of GROUPS) {
  for (const t of g.triggers) {
    for (const f of t.fields) {
      if (!f.derived && f.sample === undefined) fail(`FieldDef ${t.type}.${f.name}: thiếu sample`);
    }
  }
}

// ── Kết ─────────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\ncheck:automation THẤT BẠI — ${failures} chỗ lệch. Catalog và sources/ phải cùng kể một câu chuyện.`);
  process.exit(1);
}
console.log('\ncheck:automation OK — catalog khớp emission.');
