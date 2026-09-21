// scripts/check-query-tabs.ts — kiểm phần ĐỌC LẠI bộ tab query của tab MongoDB
// và PostgreSQL (lib/queryTabs.ts, hàm restoreTabs).
//
// VÌ SAO CÓ FILE NÀY: đây là chỗ duy nhất trong tính năng "nhiều tab query" có
// thể âm thầm NUỐT MẤT việc của người dùng. Mọi đường hỏng đều kết thúc bằng
// một tab trống trông y như bình thường — không báo lỗi, không cảnh báo — nên
// bấm thử trong app không phát hiện được: người ta chỉ thấy câu SQL viết dở tối
// qua "tự nhiên biến mất" và không có cách nào lấy lại.
//
// Các rủi ro bám theo những ca dưới đây:
//   1. Người đang nâng cấp từ bản CŨ (một phiên đơn, khoá `<ns>.session.<conn>`)
//      phải thấy câu query dở của mình thành tab đầu tiên, không phải tab trống.
//   2. Một tab hỏng hình dạng (bản app cũ ghi thiếu field) không được kéo theo
//      cả bộ tab xuống hố — chỉ tab hỏng bị bỏ.
//   3. JSON rách / localStorage bị chặn → vẫn ra một tab dùng được.
//   4. activeId trỏ vào tab đã biến mất → rơi về tab đầu, không phải chuỗi rỗng
//      (activeId rỗng = không tab nào được chọn = màn hình chết).
//   5. Trần MAX_TABS được tôn trọng kể cả khi localStorage bị sửa tay.
//
//   npx tsx scripts/check-query-tabs.ts

import { restoreTabs, MAX_TABS } from '../lib/queryTabs';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string, extra?: string): void => {
  failures += 1;
  console.error(`✗ ${m}${extra ? `\n    ${extra}` : ''}`);
};

/** State giả lập, đủ giống PgTabState để có cái mà kiểm. */
interface Demo { sql: string; table: string }

let seq = 0;
const FNS = {
  blank: (): Demo => ({ sql: '', table: '' }),
  isValid: (v: unknown): v is Demo => {
    if (!v || typeof v !== 'object') return false;
    const x = v as Record<string, unknown>;
    return typeof x.sql === 'string' && typeof x.table === 'string';
  },
  titleOf: (s: Demo): string => s.table || 'Tab mới',
  // id tất định để kỳ vọng viết ra đọc được, thay cho chuỗi ngẫu nhiên.
  newId: (): string => `n${++seq}`,
};

const tabsJson = (activeId: string, tabs: unknown[]): string =>
  JSON.stringify({ activeId, tabs });

// ── 1. Bộ tab bình thường: giữ nguyên thứ tự và tab đang xem ─────────────────
{
  const raw = tabsJson('b', [
    { id: 'a', title: 'users', state: { sql: 'SELECT 1', table: 'users' } },
    { id: 'b', title: 'orders', state: { sql: 'SELECT 2', table: 'orders' } },
  ]);
  const r = restoreTabs<Demo>(raw, null, FNS);
  if (r.tabs.length === 2 && r.tabs[0].id === 'a' && r.tabs[1].id === 'b' && r.activeId === 'b') {
    ok('đọc lại đủ 2 tab, giữ đúng tab đang xem');
  } else {
    fail('bộ tab bình thường bị đọc sai', JSON.stringify(r));
  }
}

// ── 2. Câu query đang dở của tab đang xem phải còn nguyên ───────────────────
{
  const sql = 'SELECT *\nFROM "public"."orders"\nWHERE status = \'NEW\'';
  const raw = tabsJson('a', [{ id: 'a', title: 'orders', state: { sql, table: 'orders' } }]);
  const r = restoreTabs<Demo>(raw, null, FNS);
  if (r.tabs[0].state.sql === sql) ok('câu query nhiều dòng còn nguyên từng ký tự');
  else fail('câu query bị đổi khi đọc lại', JSON.stringify(r.tabs[0].state.sql));
}

// ── 3. Nâng cấp từ bản cũ (một phiên đơn) — KHÔNG được mất việc đang dở ──────
{
  const legacy = JSON.stringify({ sql: 'SELECT * FROM invoices', table: 'invoices' });
  const r = restoreTabs<Demo>(null, legacy, FNS);
  if (r.tabs.length === 1 && r.tabs[0].state.sql === 'SELECT * FROM invoices'
    && r.tabs[0].title === 'invoices' && r.activeId === r.tabs[0].id) {
    ok('phiên đơn đời cũ được vớt thành tab đầu tiên, có nhãn theo bảng');
  } else {
    fail('phiên đơn đời cũ bị mất khi nâng cấp', JSON.stringify(r));
  }
}

// ── 4. Đã có bộ tab thì KHÔNG vớt lại phiên cũ (tránh mọc ra tab trùng) ─────
{
  const raw = tabsJson('a', [{ id: 'a', title: 'users', state: { sql: 'S1', table: 'users' } }]);
  const legacy = JSON.stringify({ sql: 'S-cũ', table: 'old' });
  const r = restoreTabs<Demo>(raw, legacy, FNS);
  if (r.tabs.length === 1 && r.tabs[0].state.sql === 'S1') ok('có bộ tab rồi thì bỏ qua phiên đơn đời cũ');
  else fail('phiên đời cũ chen vào dù đã có bộ tab', JSON.stringify(r));
}

// ── 5. Một tab hỏng hình dạng không được kéo theo cả bộ ─────────────────────
{
  const raw = tabsJson('c', [
    { id: 'a', title: 'ok', state: { sql: 'S1', table: 'users' } },
    { id: 'b', title: 'hỏng', state: { sql: 123 } },       // sql sai kiểu
    { id: 'c', title: 'cũng ok', state: { sql: 'S2', table: 'orders' } },
  ]);
  const r = restoreTabs<Demo>(raw, null, FNS);
  if (r.tabs.length === 2 && r.tabs.map((t) => t.id).join(',') === 'a,c' && r.activeId === 'c') {
    ok('chỉ tab hỏng bị bỏ, các tab lành còn nguyên');
  } else {
    fail('một tab hỏng làm hỏng cả bộ', JSON.stringify(r));
  }
}

// ── 6. JSON rách / khoá trống → vẫn ra một tab dùng được ────────────────────
for (const [label, raw] of [
  ['JSON rách', '{"tabs": [{"id"'],
  ['không phải object', '"chuỗi thôi"'],
  ['thiếu mảng tabs', '{"activeId":"a"}'],
  ['mảng tabs rỗng', '{"activeId":"a","tabs":[]}'],
  ['chưa có gì', null],
] as [string, string | null][]) {
  const r = restoreTabs<Demo>(raw, null, FNS);
  if (r.tabs.length === 1 && r.activeId === r.tabs[0].id && r.tabs[0].state.sql === '') {
    ok(`${label} → một tab trống dùng được`);
  } else {
    fail(`${label} cho ra trạng thái không dùng được`, JSON.stringify(r));
  }
}

// ── 7. activeId trỏ vào tab đã biến mất → rơi về tab đầu, KHÔNG để rỗng ─────
{
  const raw = tabsJson('đã-đóng', [
    { id: 'a', title: 'users', state: { sql: 'S1', table: 'users' } },
    { id: 'b', title: 'orders', state: { sql: 'S2', table: 'orders' } },
  ]);
  const r = restoreTabs<Demo>(raw, null, FNS);
  if (r.activeId === 'a') ok('activeId lạc → rơi về tab đầu');
  else fail('activeId lạc không được sửa', JSON.stringify(r.activeId));
}

// activeId của tab bị loại vì hỏng cũng phải rơi về tab lành.
{
  const raw = tabsJson('b', [
    { id: 'a', title: 'ok', state: { sql: 'S1', table: 'users' } },
    { id: 'b', title: 'hỏng', state: null },
  ]);
  const r = restoreTabs<Demo>(raw, null, FNS);
  if (r.tabs.length === 1 && r.activeId === 'a') ok('activeId trỏ vào tab hỏng → rơi về tab lành');
  else fail('activeId trỏ vào tab đã bị loại', JSON.stringify(r));
}

// ── 8. Trần MAX_TABS được tôn trọng kể cả khi localStorage bị sửa tay ───────
{
  const many = Array.from({ length: MAX_TABS + 7 }, (_, i) => ({
    id: `t${i}`, title: `t${i}`, state: { sql: `S${i}`, table: `tb${i}` },
  }));
  const r = restoreTabs<Demo>(tabsJson('t0', many), null, FNS);
  if (r.tabs.length === MAX_TABS) ok(`cắt về đúng trần ${MAX_TABS} tab`);
  else fail('trần số tab không được tôn trọng', `${r.tabs.length} tab`);
}

// Tab đang xem nằm NGOÀI phần bị cắt → phải rơi về tab đầu chứ không rỗng.
{
  const many = Array.from({ length: MAX_TABS + 3 }, (_, i) => ({
    id: `t${i}`, title: `t${i}`, state: { sql: `S${i}`, table: `tb${i}` },
  }));
  const r = restoreTabs<Demo>(tabsJson(`t${MAX_TABS + 2}`, many), null, FNS);
  if (r.activeId === 't0') ok('tab đang xem bị cắt mất → rơi về tab đầu');
  else fail('tab đang xem bị cắt để lại activeId lạc', JSON.stringify(r.activeId));
}

// ── 9. Phiên đời cũ hỏng hình dạng → vẫn ra tab trống, không crash ──────────
{
  const r = restoreTabs<Demo>(null, '{"sql": 42}', FNS);
  if (r.tabs.length === 1 && r.tabs[0].state.sql === '') ok('phiên đời cũ hỏng → tab trống, không crash');
  else fail('phiên đời cũ hỏng lọt qua bộ kiểm', JSON.stringify(r));
}

console.log(failures === 0 ? '\nTất cả đều đạt.' : `\n${failures} ca hỏng.`);
process.exit(failures === 0 ? 0 : 1);
