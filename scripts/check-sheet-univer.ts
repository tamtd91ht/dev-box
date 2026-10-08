// Kiểm tra bộ chuyển xlsx/csv → dữ liệu Univer (lib/sheetUniver). Chạy: npm run check:univer
// Tạo file thật trong thư mục tạm rồi đi qua đúng đường mở của route (openUniverFile).

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { openUniverFile, type UniverOpenResult } from '../lib/sheetUniver';

const dir = path.join(os.tmpdir(), `univer-check-${Date.now()}`);
let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log('  ✓', name); });

const sheetOf = (r: UniverOpenResult, i = 0) => r.workbook.sheets[r.workbook.sheetOrder[i]];
const styleOf = (r: UniverOpenResult, cell: { s?: string } | undefined) => (cell?.s ? r.workbook.styles[cell.s] : undefined) as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any

async function main() {
  await fs.mkdir(dir, { recursive: true });

  // ── xlsx có định dạng ────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Báo cáo', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
  ws.getCell('A1').value = 'Tiêu đề';
  ws.getCell('A1').font = { bold: true, italic: true, size: 14, name: 'Arial', color: { argb: 'FFFF0000' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
  ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getCell('A1').border = { top: { style: 'thin', color: { argb: 'FF00FF00' } }, bottom: { style: 'double' } };
  ws.mergeCells('A1:C1');
  ws.getCell('A3').value = 1234.5; ws.getCell('A3').numFmt = '#,##0.00';
  ws.getCell('B3').value = new Date(Date.UTC(2026, 9, 8)); ws.getCell('B3').numFmt = 'dd/mm/yyyy';
  ws.getCell('C3').value = new Date(Date.UTC(2026, 9, 9)); // ngày không có numFmt
  ws.getCell('A4').value = 10; ws.getCell('B4').value = 20;
  ws.getCell('C4').value = { formula: 'A4+B4', result: 30 };
  ws.getCell('D4').value = true;
  ws.getCell('E4').value = { richText: [{ text: 'Xin ' }, { text: 'chào', font: { bold: true } }] };
  ws.getColumn(1).width = 20;
  ws.getColumn(2).hidden = true;
  ws.getRow(3).height = 30;
  ws.getRow(5).hidden = true;
  ws.getCell('A5').value = 'ẩn';
  ws.properties.tabColor = { argb: 'FF0000FF' };
  const hid = wb.addWorksheet('Ẩn'); hid.state = 'hidden'; hid.getCell('A1').value = 'x';
  const f1 = path.join(dir, 'a.xlsx');
  await wb.xlsx.writeFile(f1);

  const r = await openUniverFile(f1);
  const s = sheetOf(r);

  await ok('tên sheet, thứ tự, sheet ẩn, màu tab', () => {
    assert.equal(r.kind, 'xlsx');
    assert.equal(r.workbook.sheetOrder.length, 2);
    assert.equal(s.name, 'Báo cáo');
    assert.equal(s.tabColor, '#0000ff');
    assert.equal(sheetOf(r, 1).hidden, 1);
  });
  await ok('freeze panes (1 cột, 2 dòng)', () => {
    assert.deepEqual(s.freeze, { xSplit: 1, ySplit: 2, startRow: 2, startColumn: 1 });
  });
  await ok('gộp ô A1:C1 → 0-based', () => {
    assert.deepEqual(s.mergeData, [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 }]);
  });
  await ok('font / màu / nền / căn lề / wrap / viền', () => {
    const st = styleOf(r, s.cellData[0][0])!;
    assert.equal(st.bl, 1); assert.equal(st.it, 1); assert.equal(st.fs, 14); assert.equal(st.ff, 'Arial');
    assert.equal(st.cl.rgb, '#ff0000');
    assert.equal(st.bg.rgb, '#ffff00');
    assert.equal(st.ht, 2); assert.equal(st.vt, 2); assert.equal(st.tb, 3);
    assert.equal(st.bd.t.s, 1); assert.equal(st.bd.t.cl.rgb, '#00ff00');
    assert.equal(st.bd.b.s, 7);
  });
  await ok('số + numFmt; ngày → serial; ngày thiếu numFmt vẫn có định dạng ngày', () => {
    assert.equal(s.cellData[2][0].v, 1234.5);
    assert.equal(styleOf(r, s.cellData[2][0])!.n.pattern, '#,##0.00');
    assert.equal(s.cellData[2][1].v, 46303); // 2026-10-08
    assert.equal(styleOf(r, s.cellData[2][1])!.n.pattern, 'dd/mm/yyyy');
    assert.equal(s.cellData[2][2].v, 46304);
    // ExcelJS tự gán 'mm-dd-yy' cho ô ngày không có numFmt — vẫn là định dạng ngày, không để lộ số serial.
    assert.match(styleOf(r, s.cellData[2][2])!.n.pattern, /d/i);
  });
  await ok('công thức giữ dấu = + kết quả cache; boolean; rich text phẳng', () => {
    assert.equal(s.cellData[3][2].f, '=A4+B4');
    assert.equal(s.cellData[3][2].v, 30);
    assert.equal(s.cellData[3][3].t, 3); assert.equal(s.cellData[3][3].v, 1);
    assert.equal(s.cellData[3][4].v, 'Xin chào');
  });
  await ok('độ rộng cột / chiều cao dòng / ẩn dòng-cột', () => {
    assert.ok(s.columnData[0].w! > 100);
    assert.equal(s.columnData[1].hd, 1);
    assert.ok(s.rowData[2].h! >= 39 && s.rowData[2].h! <= 41); // 30pt ≈ 40px
    assert.equal(s.rowData[4].hd, 1);
  });
  await ok('lưới đệm sẵn ô trống, kích thước mặc định gần Excel', () => {
    assert.ok(s.rowCount >= 200 && s.columnCount >= 26);
    assert.equal(s.defaultRowHeight, 20);
  });

  // ── Không còn trần 5.000 dòng ────────────────────────────────────────────
  const big = new ExcelJS.Workbook();
  const bs = big.addWorksheet('Big');
  for (let i = 1; i <= 60_000; i++) { bs.addRow([i, `Dòng ${i}`, i * 1.5]); }
  const f2 = path.join(dir, 'big.xlsx');
  await big.xlsx.writeFile(f2);
  await ok('file 60.000 dòng: mở đủ, không cắt', async () => {
    const t0 = Date.now();
    const rb = await openUniverFile(f2);
    const sb = sheetOf(rb);
    assert.equal(rb.truncated, false);
    assert.equal(Object.keys(sb.cellData).length, 60_000);
    assert.equal(sb.cellData[59_999][1].v, 'Dòng 60000');
    console.log(`      (${rb.cells.toLocaleString('en-US')} ô, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  });

  // ── CSV ───────────────────────────────────────────────────────────────────
  const f3 = path.join(dir, 'c.csv');
  await fs.writeFile(f3, '﻿mã,tên,tiền\n0123,An,1500.5\n9,Bình,x\n', 'utf8');
  await ok('CSV: giữ số 0 đầu dạng chuỗi, số thường thành số, nhớ dấu phân cách + BOM', async () => {
    const rc = await openUniverFile(f3);
    const sc = sheetOf(rc);
    assert.equal(rc.kind, 'csv');
    assert.equal(sc.cellData[1][0].v, '0123'); assert.equal(sc.cellData[1][0].t, 1);
    assert.equal(sc.cellData[1][2].v, 1500.5); assert.equal(sc.cellData[1][2].t, 2);
    assert.equal(sc.cellData[2][0].v, 9);
    assert.equal(rc.csv?.delimiter, ','); assert.equal(rc.csv?.hasBom, true);
  });

  await ok('CSV nhỏ dùng dấu ; (kiểu Excel tiếng Việt) không bị dò nhầm thành dấu phẩy', async () => {
    const f4 = path.join(dir, 'semi.csv');
    await fs.writeFile(f4, 'mã;tên\r\n0123;An\r\n0456;Bình\r\n', 'utf8');
    const r4 = await openUniverFile(f4);
    assert.equal(r4.csv?.delimiter, ';');
    assert.equal(sheetOf(r4).cellData[1][1].v, 'An');
    assert.equal(sheetOf(r4).cellData[2][0].v, '0456');
  });

  await ok('từ chối đường dẫn lạ / .xlsm', async () => {
    await assert.rejects(() => openUniverFile(path.join(dir, 'x.txt')), /Chỉ hỗ trợ/);
    await fs.writeFile(path.join(dir, 'm.xlsm'), 'x');
    await assert.rejects(() => openUniverFile(path.join(dir, 'm.xlsm')), /macro/);
  });

  await fs.rm(dir, { recursive: true, force: true });
  console.log(`\n${n} kiểm tra đạt.`);
}

main().catch(async (e) => {
  await fs.rm(dir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
