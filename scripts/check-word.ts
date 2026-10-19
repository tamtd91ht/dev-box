// Kiểm tra phần server của tab Word: tạo .docx, lưu thao tác pageSetup (khổ giấy / hướng / lề),
// đọc lại, kiểm tra XML hợp lệ về thứ tự, và các rào an toàn (stat, từ chối đường dẫn lạ).
// Chạy: npm run check:word   (cần OFFICE_ALLOW_WRITE=true — script npm đã đặt sẵn).
// Ghi vào thư mục tạm, không đụng file thật của bạn.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createDocx, openDocx, saveDocx, statDocx, openDocxExternal } from '../lib/wordClient';

const dir = path.join(os.tmpdir(), `word-check-${Date.now()}`);
let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log('  ✓', name); });

async function main() {
  await fs.mkdir(dir, { recursive: true });
  const created = await createDocx({ dir, name: 'a.docx', template: 'blank' });
  const f = created.path;

  await ok('tạo file trắng: khổ A4 dọc mặc định', () => {
    assert.ok(Math.abs(created.page.w - 595) < 2 && Math.abs(created.page.h - 842) < 2);
    assert.ok(!created.page.landscape);
  });

  await ok('statDocx trả mtime/dung lượng; từ chối file lạ', async () => {
    const st = await statDocx(f);
    assert.equal(st.mtimeMs, created.mtimeMs);
    assert.ok(st.sizeBytes > 500);
    await assert.rejects(() => statDocx(path.join(dir, 'x.txt')), /Chỉ hỗ trợ/);
    await assert.rejects(() => statDocx(path.join(dir, 'old.doc')), /Word 97/);
    await assert.rejects(() => openDocxExternal(path.join(dir, 'x.txt')), /Chỉ hỗ trợ/);
    await assert.rejects(() => openDocxExternal(path.join(dir, 'khong-co.docx')), /Không đọc được file/);
  });

  // ── pageSetup: A4 nằm ngang + lề hành chính VN (T2 D2 Tr3 Ph1.5 cm) ─────────
  const cm = (x: number) => Math.round(x * 28.3465 * 20) / 20;
  const op = { op: 'pageSetup', w: 841.9, h: 595.3, mt: cm(2), mb: cm(2), ml: cm(3), mr: cm(1.5), landscape: 1 };
  const r1 = await saveDocx({ path: f, mtimeMs: created.mtimeMs, ops: [op, { op: 'insert', i: 0, runs: [{ t: 'Xin chào' }] }] });

  await ok('lưu pageSetup + một thao tác khác trong cùng lần: đọc lại đúng cả hai', async () => {
    const re = await openDocx(f);
    assert.equal(re.page.landscape, true);
    assert.ok(Math.abs(re.page.w - 841.9) < 0.1 && Math.abs(re.page.h - 595.3) < 0.1);
    assert.ok(Math.abs(re.page.ml - cm(3)) < 0.1 && Math.abs(re.page.mr - cm(1.5)) < 0.1);
    assert.ok(Math.abs(re.page.mt - cm(2)) < 0.1 && Math.abs(re.page.mb - cm(2)) < 0.1);
    assert.equal(re.blocks[0].kind, 'p');
    assert.ok(JSON.stringify(re.blocks[0]).includes('Xin chào'));
    await fs.access(`${f}.bak`);
  });

  await ok('XML hợp lệ: w:pgSz đứng trước w:pgMar trong w:sectPr, pgMar đủ header/footer/gutter', async () => {
    const zip = await JSZip.loadAsync(await fs.readFile(f));
    const xml = await zip.file('word/document.xml')!.async('string');
    const sect = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(xml)![0];
    assert.ok(sect.indexOf('<w:pgSz') < sect.indexOf('<w:pgMar'), sect);
    assert.match(sect, /w:orient="landscape"/);
    assert.match(sect, /w:header="\d+"/); assert.match(sect, /w:footer="\d+"/); assert.match(sect, /w:gutter="\d+"/);
    // sectPr vẫn là con CUỐI của body.
    assert.ok(xml.lastIndexOf('</w:sectPr>') > xml.lastIndexOf('</w:p>'));
  });

  await ok('đổi lại dọc: orient bị bỏ, khổ/lề cập nhật', async () => {
    const st = await statDocx(f);
    await saveDocx({ path: f, mtimeMs: st.mtimeMs, ops: [{ op: 'pageSetup', w: 595.3, h: 841.9, mt: 72, mr: 72, mb: 72, ml: 72 }] });
    const re = await openDocx(f);
    assert.ok(!re.page.landscape);
    assert.ok(Math.abs(re.page.w - 595.3) < 0.1 && Math.abs(re.page.h - 841.9) < 0.1);
    assert.equal(re.page.mt, 72);
    const zip = await JSZip.loadAsync(await fs.readFile(f));
    assert.doesNotMatch(await zip.file('word/document.xml')!.async('string'), /w:orient/);
  });

  await ok('thao tác pageSetup xấu bị từ chối (không ghi gì)', async () => {
    const st = await statDocx(f);
    const bad = (o: Record<string, unknown>) => saveDocx({ path: f, mtimeMs: st.mtimeMs, ops: [{ op: 'pageSetup', w: 595, h: 842, mt: 72, mr: 72, mb: 72, ml: 72, ...o }] });
    await assert.rejects(() => bad({ w: -5 }), /Chiều rộng giấy/);
    await assert.rejects(() => bad({ mt: 9999 }), /Lề trên/);
    await assert.rejects(() => bad({ ml: 'abc' }), /Lề trái/);
    await assert.rejects(() => bad({ mt: 420, mb: 420 }), /Lề quá lớn/);
    await assert.rejects(() => bad({ ml: 300, mr: 300 }), /Lề quá lớn/);
    assert.equal((await statDocx(f)).mtimeMs, st.mtimeMs, 'file không bị đụng tới');
  });

  await ok('file bị sửa ngoài app (mtime lệch) → từ chối lưu', async () => {
    await assert.rejects(
      () => saveDocx({ path: f, mtimeMs: 1, ops: [{ op: 'pageSetup', w: 595, h: 842, mt: 72, mr: 72, mb: 72, ml: 72 }] }),
      /mtime khác|thay đổi từ khi mở/,
    );
  });

  // ── Ảnh ───────────────────────────────────────────────────────────────────
  // PNG 1×1 hợp lệ.
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const img = (o: Record<string, unknown> = {}) => ({ op: 'imgInsert', i: 0, name: 'Logo công ty', mime: 'image/png', b64: PNG_B64, w: 120, h: 60, ...o });

  await ok('chèn ảnh: đọc lại thấy ảnh (data URL, kích thước pt), đoạn bị khóa, file media + rel + content type đủ', async () => {
    const st = await statDocx(f);
    await saveDocx({ path: f, mtimeMs: st.mtimeMs, ops: [img()] });
    const re = await openDocx(f);
    const b = re.blocks[0] as { kind: string; imgs?: { src: string; w: number; h: number }[]; locked?: boolean };
    assert.equal(b.kind, 'p');
    assert.ok(b.imgs && b.imgs.length === 1);
    assert.ok(b.imgs![0].src.startsWith('data:image/png;base64,'));
    assert.ok(Math.abs(b.imgs![0].w - 120) < 0.1 && Math.abs(b.imgs![0].h - 60) < 0.1);
    assert.equal(b.locked, true);
    const zip = await JSZip.loadAsync(await fs.readFile(f));
    const media = await zip.file('word/media/devbox_image1.png')!.async('nodebuffer');
    assert.equal(media.toString('base64'), PNG_B64);
    assert.match(await zip.file('[Content_Types].xml')!.async('string'), /<Default [^>]*Extension="png"/);
    assert.match(await zip.file('word/_rels/document.xml.rels')!.async('string'), /relationships\/image"[^>]*Target="media\/devbox_image1\.png"|Target="media\/devbox_image1\.png"[^>]*relationships\/image"/);
  });

  await ok('chèn ảnh thứ hai: tên file, rId và docPr id không trùng', async () => {
    const st = await statDocx(f);
    await saveDocx({ path: f, mtimeMs: st.mtimeMs, ops: [img({ i: 1, name: 'Ảnh 2' })] });
    const zip = await JSZip.loadAsync(await fs.readFile(f));
    assert.ok(zip.file('word/media/devbox_image2.png'));
    const xml = await zip.file('word/document.xml')!.async('string');
    const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.sort(), ['1', '2']);
    const rids = [...xml.matchAll(/r:embed="(rId\d+)"/g)].map((m) => m[1]);
    assert.equal(new Set(rids).size, 2);
  });

  await ok('trình đọc docx độc lập (mammoth) cũng thấy 2 ảnh trong file đã ghi', async () => {
    const mammoth = (await import('mammoth')).default;
    const out = await mammoth.convertToHtml({ path: f });
    assert.equal((out.value.match(/<img /g) ?? []).length, 2, out.value.slice(0, 300));
  });

  await ok('ảnh xấu bị từ chối: sai chữ ký, định dạng lạ, quá lớn, kích thước vô lý', async () => {
    const st = await statDocx(f);
    const run = (o: Record<string, unknown>) => saveDocx({ path: f, mtimeMs: st.mtimeMs, ops: [img(o)] });
    await assert.rejects(() => run({ mime: 'image/jpeg' }), /không đúng định dạng/);        // bytes PNG khai là JPEG
    await assert.rejects(() => run({ mime: 'image/webp' }), /PNG, JPEG, GIF/);
    await assert.rejects(() => run({ b64: '' }), /Thiếu nội dung/);
    await assert.rejects(() => run({ b64: 'A'.repeat(12 * 1024 * 1024) }), /quá lớn/);
    await assert.rejects(() => run({ w: 0 }), /Chiều rộng/);
    await assert.rejects(() => run({ h: 99999 }), /Chiều cao/);
    assert.equal((await statDocx(f)).mtimeMs, st.mtimeMs, 'file không bị đụng tới');
  });

  void r1;
  await fs.rm(dir, { recursive: true, force: true });
  console.log(`\n${n} kiểm tra đạt.`);
}

main().catch(async (e) => {
  await fs.rm(dir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
