// scripts/check-browser-session.ts — kiểm cất/khôi phục phiên tab Browser
// (lib/browserSession.ts): đóng app mở lại thì các trang chưa đóng hiện lại.
//
// VÌ SAO CÓ FILE NÀY: mọi lỗi ở đây đều ÂM THẦM và chỉ lộ ra sau khi đóng app
// mở lại — không tái hiện được trong một phiên chạy, mà lúc lộ ra thì rất khó
// lần vì trạng thái đã nằm trong localStorage từ lần chạy TRƯỚC.
//   • cất `creds` → mật khẩu bị rải xuống localStorage dạng plaintext. Đây là
//     ca nguy hiểm nhất và nhìn giao diện thì KHÔNG thấy gì bất thường.
//   • đọc lại `partition` đã cất thay vì dựng từ profile → tab khôi phục vào
//     sai phiên đăng nhập (hiện ra là "tự nhiên bị đăng xuất").
//   • giữ nguyên id cũ → tab mở thêm sau đó trùng id với tab khôi phục.
//
//   npx tsx scripts/check-browser-session.ts

import {
  serialize, restore, TABS_KEY, type SessionTab,
} from '../lib/browserSession';
import { bmPartition } from '../lib/bookmarks';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string): void => {
  failures += 1;
  console.error(`✗ ${m}`);
};
const check = (cond: boolean, m: string): void => (cond ? ok(m) : fail(m));

const hostOf = (u: string): string => { try { return new URL(u).hostname; } catch { return u; } };

/** Cấp id như component (tabSeqRef). */
const idGen = () => { let n = 0; return () => `tab-${++n}`; };

const tabA: SessionTab = {
  id: 'tab-1', name: 'Kibana', url: 'https://kibana.noc.vn/app#/discover',
  profile: 'noc', partition: bmPartition('noc'),
};
const tabB: SessionTab = {
  id: 'tab-2', name: 'GitLab', url: 'https://git.vihat.vn/dash',
  partition: bmPartition(undefined),
  // Tab mở từ dấu trang có user/pass đi kèm — ĐÚNG ca cần chặn khi cất.
  creds: { username: 'tamtd', password: 'sieu-mat-khau' },
};

check(TABS_KEY === 'devbox.browser.tabs', 'TABS_KEY ổn định (đổi là mất phiên cũ của người dùng)');

// ── Cất ─────────────────────────────────────────────────────────────────────
const saved = serialize([tabA, tabB], 'tab-2');
const blob = JSON.stringify(saved);

check(!blob.includes('sieu-mat-khau'), 'serialize: KHÔNG cất password xuống localStorage');
check(!blob.includes('tamtd'), 'serialize: KHÔNG cất username');
check(!blob.includes('creds'), 'serialize: không có field creds nào lọt xuống');
check(saved.tabs.length === 2 && saved.tabs[0].url === tabA.url, 'serialize: giữ đúng danh sách + địa chỉ đang xem');
check(saved.active === 1, 'serialize: cất tab đang xem theo VỊ TRÍ (id được cấp lại khi khôi phục)');
check(serialize([tabA, tabB], null).active === 0,
  'serialize: đang ở trang new-tab (activeId null) → mở lại nổi tab đầu');

// ── Khôi phục ───────────────────────────────────────────────────────────────
const r = restore(blob, idGen(), hostOf);
check(r.tabs.length === 2, 'restore: dựng lại đủ số tab');
check(r.tabs[0].url === tabA.url, 'restore: đúng địa chỉ ĐANG XEM, không phải trang khởi đầu');
check(r.active === r.tabs[1].id, 'restore: nổi lại đúng tab đang xem trước khi đóng app');
check(r.tabs.every((t) => t.creds === undefined), 'restore: tab khôi phục KHÔNG mang theo creds');
check(r.tabs[0].partition === bmPartition('noc'),
  'restore: partition dựng LẠI từ profile (khớp phiên đăng nhập cũ)');
check(r.tabs[1].partition === bmPartition(undefined), 'restore: tab không profile → partition mặc định');

// Id phải đến TỪ `nextId` của phiên mới. Bộ đếm ở đây bắt đầu lại từ 1 nên
// hai tab là tab-1/tab-2; điều đáng kiểm là chúng do generator cấp và không
// trùng nhau, chứ không phải trùng hợp giống id cũ.
const ids = r.tabs.map((t) => t.id);
check(ids.join(',') === 'tab-1,tab-2', 'restore: cấp id mới bằng bộ đếm của phiên mới');
check(new Set(ids).size === ids.length, 'restore: id không trùng nhau');

// Cấp id tiếp SAU khi khôi phục (mở thêm tab) không được trùng tab đã khôi phục.
const gen = idGen();
const r2 = restore(blob, gen, hostOf);
check(!r2.tabs.some((t) => t.id === gen()), 'restore: tab mở thêm sau đó không trùng id với tab đã khôi phục');

// ── Dữ liệu rác / bản cũ ────────────────────────────────────────────────────
check(restore(null, idGen(), hostOf).tabs.length === 0, 'restore: chưa có gì cất → bàn trắng');
check(restore('{ hong', idGen(), hostOf).tabs.length === 0, 'restore: JSON hỏng → bàn trắng, không nổ');
check(restore('{}', idGen(), hostOf).tabs.length === 0, 'restore: thiếu field → bàn trắng');
check(restore('{"tabs":null}', idGen(), hostOf).tabs.length === 0, 'restore: tabs không phải mảng → bàn trắng');
check(restore('{"tabs":[{"url":"javascript:alert(1)"}]}', idGen(), hostOf).tabs.length === 0,
  'restore: bỏ URL không phải http(s) — không khôi phục thành một trang thực thi script');
check(restore('{"tabs":[{"url":"https://a.vn/x"}]}', idGen(), hostOf).tabs[0].name === 'a.vn',
  'restore: thiếu name → lấy hostname (bản cất từ app cũ vẫn dùng được)');
check(restore('{"tabs":[{"url":"https://a.vn/x"}],"active":99}', idGen(), hostOf).active !== null,
  'restore: active trỏ ra ngoài danh sách → nổi tab đầu, không trả null');

// Trần số tab: 200 tab mở cùng lúc thì mở lại app là dựng 200 <webview>.
const many = Array.from({ length: 200 }, (_, i): SessionTab => ({
  id: `tab-${i}`, name: `t${i}`, url: `https://a${i}.vn/`, partition: bmPartition(undefined),
}));
check(serialize(many, 'tab-0').tabs.length === 30, 'serialize: chặn trần 30 tab (khỏi treo máy lúc mở lại)');
check(restore(JSON.stringify({ tabs: serialize(many, 'tab-0').tabs, active: 0 }), idGen(), hostOf).tabs.length === 30,
  'restore: cũng chặn trần, kể cả khi file cất bằng tay có nhiều hơn');

if (failures) {
  console.error(`\n${failures} kiểm tra KHÔNG đạt.`);
  process.exit(1);
}
console.log('\nTất cả kiểm tra đạt.');
