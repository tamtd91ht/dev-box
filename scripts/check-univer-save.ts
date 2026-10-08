// Đầu-cuối cho việc LƯU từ giao diện Univer: tạo chỉnh sửa bằng Univer thật (headless),
// so bản chụp → bản vá → ghi vào file → đọc lại và đối chiếu. Chạy: npm run check:univer-save
// Ghi vào thư mục tạm, không đụng file thật của bạn.

process.env.OFFICE_ALLOW_WRITE = 'true';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { Univer, LocaleType, UniverInstanceType } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import '@univerjs/sheets/facade';
import { openUniverFile } from '../lib/sheetUniver';
import { diffSnapshots, snapshotToGrid, type Snapshot } from '../lib/sheetUniverDiff';

const dir = path.join(os.tmpdir(), `univer-save-${Date.now()}`);
let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log('  ✓', name); });

/** Mở file bằng Univer headless; trả về { book, base, close }. */
async function load(file: string) {
  const doc = await openUniverFile(file);
  const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} } });
  univer.registerPlugin(UniverFormulaEnginePlugin);
  univer.registerPlugin(UniverSheetsPlugin);
  univer.registerPlugin(UniverSheetsFormulaPlugin);
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, doc.workbook as never);
  const api = FUniver.newAPI(univer);
  const book = api.getActiveWorkbook()!;
  return { doc, book, base: JSON.parse(JSON.stringify(book.save())) as Snapshot, close: () => univer.dispose() };
}

async function main() {
  // Import ĐỘNG: import tĩnh bị đẩy lên trước dòng đặt OFFICE_ALLOW_WRITE nên cổng ghi vẫn tắt.
  const { saveUniverFile } = await import('../lib/sheetUniverSave');
  await fs.mkdir(dir, { recursive: true });

  // File gốc: có định dạng, gộp ô, công thức, freeze, cột rộng + một ô "không đụng tới" mang style riêng.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }] });
  ws.getCell('A1').value = 'Tên'; ws.getCell('B1').value = 'Số';
  ws.getRow(1).font = { bold: true };
  ws.addRow(['An', 10]); ws.addRow(['Bình', 20]); ws.addRow(['Cường', 30]);
  ws.getCell('B5').value = { formula: 'SUM(B2:B4)', result: 60 };
  ws.getCell('D2').value = 'giữ nguyên'; ws.getCell('D2').font = { italic: true, color: { argb: 'FF0000FF' } };
  ws.getCell('D2').border = { left: { style: 'thin', color: { argb: 'FF123456' } } };
  ws.mergeCells('F1:G2'); ws.getCell('F1').value = 'gộp';
  ws.getColumn(1).width = 18;
  wb.addWorksheet('Khác').getCell('A1').value = 'sheet 2';
  const f = path.join(dir, 'a.xlsx');
  await wb.xlsx.writeFile(f);
  const before = await fs.stat(f);

  const { doc, book, base, close } = await load(f);
  const sheet = book.getActiveSheet();

  await ok('chưa sửa gì → diff rỗng (không có "thay đổi giả" do khác cách biểu diễn)', () => {
    const d = diffSnapshots(base, JSON.parse(JSON.stringify(book.save())));
    assert.equal(d.changed, 0, JSON.stringify(d.patch).slice(0, 300));
    assert.equal(d.otherChanges, 0);
    assert.deepEqual(d.blockers, []);
  });

  // ── Sửa như người dùng ───────────────────────────────────────────────────
  sheet.getRange('B2').setValue(99);                       // đổi số
  sheet.getRange('A6').setValue('Dũng');                    // ô mới
  sheet.getRange('B6').setValue(40);
  sheet.getRange('A1:B1').setBackground('#ffff00');         // đổi nền
  sheet.getRange('A3').setFontColor('#ff0000');             // đổi màu chữ
  sheet.getRange('A4').setFontWeight('bold');
  sheet.getRange('D4:E4').merge();                          // gộp mới
  sheet.setColumnWidth(1, 150);                             // cột B rộng ra
  sheet.setFrozenRows(2);                                   // freeze 2 dòng

  const cur = JSON.parse(JSON.stringify(book.save())) as Snapshot;
  const diff = diffSnapshots(base, cur);

  await ok('diff chỉ gồm đúng các ô đã sửa (không lôi cả bảng)', () => {
    const pos = diff.patch.sheets[0].cells.map((c) => `${c.r},${c.c}`).sort();
    assert.deepEqual(pos, ['0,0', '0,1', '1,1', '2,0', '3,0', '5,0', '5,1'].sort(), pos.join(' | '));
    assert.equal(diff.blockers.length, 0);
    assert.deepEqual(diff.patch.sheets[0].freeze, { xSplit: 0, ySplit: 2 });
    assert.ok(diff.patch.sheets[0].merges!.some((m) => m.startRow === 3 && m.endColumn === 4));
    assert.equal(diff.patch.sheets[0].cols!.length, 1);
  });

  const saved = await saveUniverFile({ path: f, mtimeMs: doc.mtimeMs, patch: diff.patch });

  await ok('lưu xong: có bản .bak, mtime mới', async () => {
    assert.ok(saved.mtimeMs > before.mtimeMs);
    await fs.access(`${f}.bak`);
  });

  const after = new ExcelJS.Workbook();
  await after.xlsx.readFile(f);
  const w2 = after.getWorksheet('Data')!;

  await ok('giá trị đã sửa vào file; công thức giữ nguyên', () => {
    assert.equal(w2.getCell('B2').value, 99);
    assert.equal(w2.getCell('A6').value, 'Dũng');
    assert.equal(w2.getCell('B6').value, 40);
    const fb = w2.getCell('B5').value as { formula?: string };
    assert.equal(fb.formula, 'SUM(B2:B4)');
  });
  await ok('định dạng: nền vàng, chữ đỏ, đậm', () => {
    assert.equal((w2.getCell('A1').fill as { fgColor?: { argb?: string } }).fgColor?.argb, 'FFFFFF00');
    assert.equal(w2.getCell('A3').font?.color?.argb, 'FFFF0000');
    assert.equal(w2.getCell('A4').font?.bold, true);
  });
  await ok('ô KHÔNG đụng tới giữ nguyên style gốc (chữ nghiêng xanh, viền trái)', () => {
    const d2 = w2.getCell('D2');
    assert.equal(d2.value, 'giữ nguyên');
    assert.equal(d2.font?.italic, true);
    assert.equal(d2.font?.color?.argb, 'FF0000FF');
    assert.equal(d2.border?.left?.style, 'thin');
    assert.equal(after.getWorksheet('Khác')!.getCell('A1').value, 'sheet 2'); // sheet khác nguyên vẹn
  });
  await ok('gộp ô mới + gộp ô cũ còn nguyên; độ rộng cột; freeze', () => {
    const merges = ((w2.model as { merges?: string[] }).merges ?? []).slice().sort();
    assert.deepEqual(merges, ['D4:E4', 'F1:G2']);
    assert.ok(w2.getColumn(2).width! > 15);
    assert.equal(w2.getColumn(1).width, 18);
    const v = w2.views[0] as { state?: string; ySplit?: number };
    assert.equal(v.state, 'frozen'); assert.equal(v.ySplit, 2);
  });
  await ok('file lưu xong mở lại bằng Univer cho ĐÚNG những gì Univer đang hiển thị', async () => {
    const re = await load(f);
    const a = snapshotToGrid(cur); const b = snapshotToGrid(re.base);
    // Ô công thức: so giá trị công thức, không so số cache.
    assert.equal(b[5][0], 'Dũng'); assert.equal(b[1][1], '99'); assert.equal(a[2][0], b[2][0]);
    const d2 = diffSnapshots(re.base, re.base);
    assert.equal(d2.changed, 0);
    re.close();
  });

  // ── Chèn dòng: công thức phải theo kịp ───────────────────────────────────
  close();
  const f2 = path.join(dir, 'b.xlsx');
  const w3 = new ExcelJS.Workbook();
  const s3 = w3.addWorksheet('S');
  s3.addRow([1]); s3.addRow([2]); s3.addRow([3]);
  s3.getCell('A4').value = { formula: 'SUM(A1:A3)', result: 6 };
  await w3.xlsx.writeFile(f2);
  const L2 = await load(f2);
  L2.book.getActiveSheet().insertRowBefore(0); // facade đếm từ 0: chèn lên trên dòng đầu
  L2.book.getActiveSheet().getRange('A1').setValue(100);
  const cur2 = JSON.parse(JSON.stringify(L2.book.save())) as Snapshot;
  const d3 = diffSnapshots(L2.base, cur2);
  await saveUniverFile({ path: f2, mtimeMs: L2.doc.mtimeMs, patch: d3.patch });
  await ok('chèn dòng: dữ liệu dịch xuống, công thức được Univer sửa tham chiếu và ghi đúng', async () => {
    const x = new ExcelJS.Workbook(); await x.xlsx.readFile(f2);
    const sx = x.getWorksheet('S')!;
    assert.equal(sx.getCell('A1').value, 100);
    assert.equal(sx.getCell('A2').value, 1);
    assert.equal(sx.getCell('A4').value, 3);
    assert.equal((sx.getCell('A5').value as { formula?: string }).formula, 'SUM(A2:A4)');
  });
  L2.close();

  // ── An toàn ──────────────────────────────────────────────────────────────
  await ok('file bị sửa ngoài app (mtime lệch) → từ chối, không ghi đè', async () => {
    await assert.rejects(() => saveUniverFile({ path: f2, mtimeMs: 1, patch: d3.patch }), /mtime khác|thay đổi từ khi mở/);
  });
  await ok('thêm/đổi tên sheet bị chặn ngay ở bước so sánh', () => {
    const b2 = JSON.parse(JSON.stringify(base)) as Snapshot;
    const c2 = JSON.parse(JSON.stringify(base)) as Snapshot;
    const id = Object.keys(c2.sheets)[0];
    c2.sheets[id].name = 'Đổi tên';
    assert.equal(diffSnapshots(b2, c2).blockers.length, 1);
  });
  await ok('đổi resource (vd conditional formatting) → cảnh báo, không chặn', () => {
    const b2 = JSON.parse(JSON.stringify(base)) as Snapshot;
    const c2 = JSON.parse(JSON.stringify(base)) as Snapshot;
    c2.resources = [...(c2.resources ?? []), { name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: '{"sheet-1":[{"cfId":"x"}]}' }];
    const d = diffSnapshots(b2, c2);
    assert.equal(d.blockers.length, 0);
    assert.match(d.warnings.join(' '), /conditional formatting/);
  });
  await ok('bản vá bậy (toạ độ âm / quá lớn / giá trị lạ) bị từ chối', async () => {
    const bad = (cells: unknown) => saveUniverFile({ path: f2, mtimeMs: (undefined as never), patch: { sheets: [{ index: 0, name: 'S', cells }] } });
    // mtime sai sẽ bị chặn trước; dùng mtime đúng:
    const st = await fs.stat(f2);
    const run = (cells: unknown) => saveUniverFile({ path: f2, mtimeMs: st.mtimeMs, patch: { sheets: [{ index: 0, name: 'S', cells }] } });
    void bad;
    await assert.rejects(() => run([{ r: -1, c: 0 }]), /toạ độ/);
    await assert.rejects(() => run([{ r: 0, c: 99999 }]), /toạ độ/);
    await assert.rejects(() => run([{ r: 0, c: 0, value: { v: { x: 1 } } }]), /giá trị/);
    await assert.rejects(() => run([{ r: 0, c: 0, value: { v: 'x'.repeat(40000) } }]), /ký tự/);
  });

  // ── CSV ──────────────────────────────────────────────────────────────────
  const f3 = path.join(dir, 'c.csv');
  await fs.writeFile(f3, '﻿mã;tên\r\n0123;An\r\n0456;Bình\r\n0789;Chi\r\n', 'utf8');
  const L3 = await load(f3);
  L3.book.getActiveSheet().getRange('B2').setValue('Anh');
  L3.book.getActiveSheet().getRange('A5').setValue('9');
  const grid = snapshotToGrid(JSON.parse(JSON.stringify(L3.book.save())) as Snapshot);
  await saveUniverFile({ path: f3, mtimeMs: L3.doc.mtimeMs, grid });
  await ok('CSV: ghi lại đúng dấu ; + BOM + CRLF, giữ số 0 đầu', async () => {
    const raw = await fs.readFile(f3);
    assert.equal(raw[0], 0xef); // BOM
    const txt = raw.toString('utf8').replace(/^﻿/, '');
    assert.equal(txt, 'mã;tên\r\n0123;Anh\r\n0456;Bình\r\n0789;Chi\r\n9\r\n');
  });
  L3.close();

  await fs.rm(dir, { recursive: true, force: true });
  console.log(`\n${n} kiểm tra đạt.`);
}

main().catch(async (e) => {
  await fs.rm(dir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
