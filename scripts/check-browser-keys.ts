// scripts/check-browser-keys.ts — phím tắt kiểu Chrome của tab Browser.
//
// VÌ SAO CÓ FILE NÀY: bảng phím nằm ở HAI nơi — lib/browserKeys.ts (host page)
// và electron/main.cjs · browserKeyOf (bắt hộ khi con trỏ ở trong trang web).
// Lệch nhau là lỗi âm thầm kiểu "Ctrl+L ăn khi bấm vào thanh tab nhưng không ăn
// khi đang đọc trang". Ở đây chạy CẢ HAI bản trên cùng một loạt tổ hợp và so.
//
//   npx tsx scripts/check-browser-keys.ts

import fs from 'node:fs';
import path from 'node:path';
import { browserKeyOf, stepZoom, RESERVED_KEYS, type KeyInput } from '../lib/browserKeys';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else { failures += 1; console.error(`✗ ${m}`); }
};

// Bóc nguyên hàm browserKeyOf ra khỏi main.cjs (không require được: file đó kéo
// cả electron vào) rồi dựng lại bằng new Function.
const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const m = src.match(/function browserKeyOf\(input\) \{[\s\S]*?\r?\n\}\r?\n/);
if (!m) { console.error('✗ không tìm thấy browserKeyOf trong electron/main.cjs'); process.exit(1); }
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const mainKeyOf = new Function(`${m[0]}; return browserKeyOf;`)() as (i: Record<string, unknown>) => string | null;

const asMain = (k: KeyInput) => mainKeyOf({
  key: k.key, code: k.code, control: k.ctrl, shift: k.shift, alt: k.alt, meta: k.meta,
});

// Mọi tổ hợp đáng kể: chữ, số, phím chức năng, mũi tên, +/-/0, với mọi bộ modifier.
const keys: [string, string][] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c): [string, string] => [c.toLowerCase(), `Key${c}`]),
  ...'0123456789'.split('').map((d): [string, string] => [d, `Digit${d}`]),
  ['F3', 'F3'], ['F5', 'F5'], ['F6', 'F6'], ['F12', 'F12'],
  ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'],
  ['=', 'Equal'], ['+', 'Equal'], ['-', 'Minus'], ['+', 'NumpadAdd'], ['-', 'NumpadSubtract'], ['0', 'Numpad0'],
  ['Tab', 'Tab'], ['`', 'Backquote'], ['Enter', 'Enter'], ['Escape', 'Escape'],
];
let diff = 0;
for (const [key, code] of keys) {
  for (let mask = 0; mask < 16; mask++) {
    const k: KeyInput = { key, code, ctrl: !!(mask & 1), shift: !!(mask & 2), alt: !!(mask & 4), meta: !!(mask & 8) };
    const a = browserKeyOf(k);
    const b = asMain(k);
    if (a !== b) {
      diff += 1;
      if (diff <= 10) console.error(`  lệch: ${JSON.stringify(k)} → renderer=${a} main=${b}`);
    }
  }
}
check(diff === 0, 'renderer và main.cjs cho CÙNG kết quả trên mọi tổ hợp');

const rs = src.match(/const BROWSER_RESERVED_KEYS = new Set\(\[([\s\S]*?)\]\);/);
const mainReserved = new Set(
  [...(rs?.[1] ?? '').replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((x) => x[1]),
);
check(mainReserved.size === RESERVED_KEYS.size && [...RESERVED_KEYS].every((k) => mainReserved.has(k)),
  'danh sách phím GIỮ CHẶT khớp giữa renderer và main.cjs');
check(!RESERVED_KEYS.has('find') && !RESERVED_KEYS.has('print') && !RESERVED_KEYS.has('bookmark'),
  'Ctrl+F / Ctrl+P / Ctrl+D KHÔNG giữ chặt — trang (Google Docs, Monaco…) được dùng trước');

const K = (code: string, key: string, mods: Partial<KeyInput> = {}): KeyInput =>
  ({ key, code, ctrl: false, shift: false, alt: false, meta: false, ...mods });
check(browserKeyOf(K('KeyT', 't', { ctrl: true })) === 'newTab', 'Ctrl+T = tab mới');
check(browserKeyOf(K('KeyT', 'T', { ctrl: true, shift: true })) === 'reopenTab', 'Ctrl+Shift+T = mở lại tab đã đóng');
check(browserKeyOf(K('Tab', 'Tab', { ctrl: true })) === null, 'Ctrl+Tab KHÔNG thuộc tab Browser (phím của khung app)');
check(browserKeyOf(K('Backquote', '`', { ctrl: true })) === null, 'Ctrl+` KHÔNG thuộc tab Browser');
check(browserKeyOf(K('KeyU', 'U', { ctrl: true, shift: true })) === null, 'Ctrl+Shift+U KHÔNG thuộc tab Browser');
check(browserKeyOf(K('KeyY', 'Y', { ctrl: true, shift: true })) === null, 'Ctrl+Shift+Y (dịch nhanh) không bị cướp');
check(browserKeyOf(K('KeyC', 'c', { ctrl: true })) === null && browserKeyOf(K('KeyV', 'v', { ctrl: true })) === null,
  'Ctrl+C / Ctrl+V để nguyên cho trang');
check(browserKeyOf(K('Digit3', '3', { ctrl: true })) === 'tab3' && browserKeyOf(K('Digit9', '9', { ctrl: true })) === 'lastTab',
  'Ctrl+1..8 = tab thứ n, Ctrl+9 = tab cuối');
check(browserKeyOf(K('KeyA', 'a', { ctrl: true })) === null, 'Ctrl+A (chọn hết) để nguyên cho trang');
check(browserKeyOf(K('ArrowLeft', 'ArrowLeft', { alt: true })) === 'back', 'Alt+← = quay lại');

check(stepZoom(1, 1) === 1.1 && stepZoom(1, -1) === 0.9, 'zoom: 100% → 110% / 90% như Chrome');
check(stepZoom(5, 1) === 5 && stepZoom(0.25, -1) === 0.25, 'zoom: kẹp ở 25% và 500%');
check(stepZoom(1.05, 1) === 1.1 && stepZoom(1.05, -1) === 1, 'zoom: mức lẻ nhảy về mức chuẩn gần nhất');

if (failures) { console.error(`\n${failures} kiểm tra KHÔNG đạt.`); process.exit(1); }
console.log('\nTất cả kiểm tra đạt.');
