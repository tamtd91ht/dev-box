// scripts/check-export-map.ts — kiểm bảng ĐỔI GIÁ TRỊ của cột báo cáo Excel.
//
// VÌ SAO CÓ FILE NÀY: sai ở đây không làm gãy gì cả — file .xlsx vẫn mở được,
// vẫn đủ dòng đủ cột, chỉ là VÀI Ô GHI SAI NỘI DUNG. Không ai soát tay 100.000
// dòng để phát hiện; báo cáo cứ thế gửi đi.
//
// Các ca dưới đây bám vào mấy quy ước dễ hiểu nhầm nhất:
//   1. So khớp bỏ hoa/thường + khoảng trắng (người ta gõ `True` cho `true`).
//   2. `false` và `0` là GIÁ TRỊ THẬT, không phải ô rỗng — khớp luật của chúng,
//      không rơi vào nhánh "còn lại".
//   3. Nhánh "còn lại" bỏ trống = GIỮ NGUYÊN, không phải xoá trắng cột.
//   4. Ô nhiều giá trị (list object) phải đổi TỪNG phần tử rồi mới nối.
//
//   npx tsx scripts/check-export-map.ts

import { applyValueMap, hasValueMap, typeCell, NO_COLUMN_PATH, type ValueMap } from '../lib/mongoReport';
import { hasDataColumn, initialColumns, toReportColumns } from '../components/export/ColumnMapper';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string, extra?: string): void => {
  failures += 1;
  console.error(`✗ ${m}${extra ? `\n    ${extra}` : ''}`);
};
const eq = (name: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(name);
  else fail(name, `kỳ vọng ${JSON.stringify(want)}, nhận về ${JSON.stringify(got)}`);
};

/** Bảng của ca kinh điển: cột is_deleted. */
const DELETED: ValueMap = {
  rules: [{ when: 'true', to: 'Đã xoá' }, { when: 'false', to: 'Đang dùng' }],
};

eq('true → Đã xoá', applyValueMap(true, DELETED), 'Đã xoá');
eq('false → Đang dùng (false KHÔNG phải ô rỗng)', applyValueMap(false, DELETED), 'Đang dùng');
eq('chuỗi "true" cũng khớp như boolean', applyValueMap('true', DELETED), 'Đã xoá');
eq('hoa/thường + khoảng trắng thừa vẫn khớp', applyValueMap('  TRUE ', DELETED), 'Đã xoá');

eq('số 0 là giá trị thật, khớp luật của nó',
  applyValueMap(0, { rules: [{ when: '0', to: 'Không' }] }), 'Không');

// Nhánh "còn lại".
eq('không khớp + không khai "còn lại" → giữ nguyên',
  applyValueMap('PENDING', DELETED), 'PENDING');
eq('không khớp + có khai "còn lại" → dùng nhánh đó',
  applyValueMap('PENDING', { ...DELETED, fallback: 'Khác' }), 'Khác');
eq('ô rỗng rơi vào nhánh "còn lại" như mọi giá trị không khớp',
  applyValueMap(undefined, { ...DELETED, fallback: 'Khác' }), 'Khác');

// Ô rỗng / ô muốn để trống.
eq('luật có vế trái RỖNG khớp đúng ô thiếu field',
  applyValueMap(null, { rules: [{ when: '', to: 'Chưa có' }] }), 'Chưa có');
eq('vế phải rỗng → ô Excel trống',
  applyValueMap('x', { rules: [{ when: 'x', to: '' }] }), '');

// Thứ tự luật + bảng rỗng.
eq('luật khai trước thắng',
  applyValueMap('a', { rules: [{ when: 'a', to: 'đầu' }, { when: 'a', to: 'sau' }] }), 'đầu');
eq('bảng rỗng → không đụng vào giá trị', applyValueMap('a', { rules: [] }), 'a');
eq('không khai gì → không đụng vào giá trị', applyValueMap('a', undefined), 'a');

// hasValueMap — quyết định nút ⋯ có sáng lên không, và có mang map xuống file không.
eq('hasValueMap: chưa gõ gì', hasValueMap({ rules: [{ when: '', to: '' }] }), false);
eq('hasValueMap: chỉ khai "còn lại"', hasValueMap({ rules: [], fallback: 'X' }), true);
eq('hasValueMap: có luật thật', hasValueMap(DELETED), true);

// Ô NHIỀU GIÁ TRỊ (field con của list object) — đổi từng phần tử rồi mới nối.
{
  const got = applyValueMap([true, false, true], DELETED);
  eq('list object: đổi từng phần tử', got, ['Đã xoá', 'Đang dùng', 'Đã xoá']);
  eq('list object: nối lại bằng sep sau khi đã đổi',
    typeCell(got, 'auto', ' | ').value, 'Đã xoá | Đang dùng | Đã xoá');
}

// Giá trị sau khi đổi vẫn đi qua định kiểu ô như thường.
eq('đổi ra chuỗi số thì ô vẫn là SỐ thật (cột format số)',
  typeCell(applyValueMap('A', { rules: [{ when: 'A', to: '10' }] }), 'number').value, 10);
eq('đổi ra chữ thì ô là text',
  typeCell(applyValueMap(true, DELETED), 'auto').value, 'Đã xoá');

// ── Bảng khai cột (ColumnMapper) ────────────────────────────────────────────
eq('mở modal chỉ dựng sẵn STT + một dòng trống, không đoán cột theo dữ liệu',
  initialColumns().map((c) => c.path), [NO_COLUMN_PATH, '']);

{
  const out = toReportColumns([
    { key: 0, header: 'STT', path: NO_COLUMN_PATH, format: 'number' },
    { key: 1, header: '', path: ' is_deleted ', format: 'auto', map: { rules: [{ when: '', to: '' }, { when: 'true', to: 'Đã xoá' }] } },
    { key: 2, header: 'Chưa khai', path: '   ', format: 'auto' },
  ]);
  eq('cột chưa khai field code thì không xuống file', out.length, 2);
  eq('path + header được cắt khoảng trắng hai đầu', [out[1].path, out[1].header], ['is_deleted', 'is_deleted']);
  eq('luật trống (dòng chờ gõ) không xuống file', out[1].map?.rules, [{ when: 'true', to: 'Đã xoá' }]);
}

eq('chỉ mỗi cột STT thì chưa cho xuất', hasDataColumn(initialColumns()), false);
eq('khai thêm một field thật là xuất được',
  hasDataColumn([...initialColumns(), { key: 9, header: '', path: 'domain', format: 'auto' }]), true);

console.log(failures === 0 ? '\nTất cả ca đều đạt.' : `\n${failures} ca KHÔNG đạt.`);
process.exit(failures === 0 ? 0 : 1);
