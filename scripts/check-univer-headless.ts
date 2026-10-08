// Xác nhận Univer THẬT đọc đúng dữ liệu do lib/sheetUniver sinh ra: giá trị, style, numFmt,
// công thức, freeze, gộp ô. Chạy "headless" (không DOM/canvas) bằng lõi Univer trong Node.
// Chạy: npm run check:univer-load

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

(async () => {
  const dir = path.join(os.tmpdir(), `uh-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws.getCell('A1').value = 'Tiêu đề'; ws.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } };
  ws.mergeCells('A1:C1');
  ws.getCell('A2').value = 10; ws.getCell('B2').value = 20;
  ws.getCell('C2').value = { formula: 'A2+B2', result: 30 };
  ws.getCell('A3').value = 1234.5; ws.getCell('A3').numFmt = '#,##0.00';
  const f = path.join(dir, 'a.xlsx');
  await wb.xlsx.writeFile(f);
  const doc = await openUniverFile(f);

  const univer = new Univer({ locale: LocaleType.EN_US });
  univer.registerPlugin(UniverFormulaEnginePlugin);
  univer.registerPlugin(UniverSheetsPlugin);
  univer.registerPlugin(UniverSheetsFormulaPlugin);
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, doc.workbook as never);
  const api = FUniver.newAPI(univer);
  const book = api.getActiveWorkbook()!;
  const sheet = book.getActiveSheet();
  assert.equal(sheet.getSheetName(), 'S');
  assert.equal(sheet.getRange('A2').getValue(), 10);
  assert.equal(sheet.getRange('A1').getValue(), 'Tiêu đề');
  const st = sheet.getRange('A1').getCellStyle();
  assert.equal((st as any) // eslint-disable-line @typescript-eslint/no-explicit-any
  ._style.bl, 1);
  assert.equal((st as any) // eslint-disable-line @typescript-eslint/no-explicit-any
  ._style.cl.rgb, '#ff0000');
  assert.equal((sheet.getRange('A3').getCellStyle() as any)._style.n.pattern, '#,##0.00');
  assert.ok(sheet.getRange('C2').getFormula().includes('A2+B2'), 'công thức giữ nguyên');
  const frozen = sheet.getFreeze();
  assert.equal(frozen.xSplit, 1); assert.equal(frozen.ySplit, 1);
  const merges = sheet.getMergedRanges?.() ?? [];
  assert.ok(merges.length >= 1, 'gộp ô A1:C1');
  console.log('headless ok: giá trị, style, numFmt, công thức, freeze, merge đều được Univer đọc đúng');
  univer.dispose();
  await fs.rm(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
