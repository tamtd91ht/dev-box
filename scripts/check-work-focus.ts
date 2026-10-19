// Kiểm tra Nhiệm vụ trọng tâm: tính kỳ tuần/tháng, validate, và kho LOCAL (file).
// Chạy: npm run check:focus. Không đụng Mongo — kho chọn local vì tool Mongo tắt;
// file ghi vào đường dẫn tạm (WORK_FOCUS_PATH).

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = path.join(os.tmpdir(), `workfocus-${Date.now()}.json`);
process.env.WORK_FOCUS_PATH = tmp;
delete process.env.MONGO_TOOL_ENABLED;

import {
  mondayOf, addDays, keyOf, shiftKey, periodEnd, periodLabel, isoWeek, validKey, cleanTags, buildItem, patchItem,
} from '../lib/workFocusCore';

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log('  ✓', name); });

async function main() {
  await ok('mondayOf: tuần bắt đầu Thứ 2, Chủ nhật thuộc tuần trước', () => {
    assert.equal(mondayOf('2026-10-07'), '2026-10-05'); // Thứ 4
    assert.equal(mondayOf('2026-10-05'), '2026-10-05'); // chính Thứ 2
    assert.equal(mondayOf('2026-10-11'), '2026-10-05'); // Chủ nhật
    assert.equal(mondayOf('2026-10-12'), '2026-10-12');
    assert.equal(mondayOf('2026-01-01'), '2025-12-29'); // qua năm
  });
  await ok('addDays / keyOf / shiftKey / periodEnd', () => {
    assert.equal(addDays('2026-02-27', 3), '2026-03-02');
    assert.equal(keyOf('week', '2026-10-08'), '2026-10-05');
    assert.equal(keyOf('month', '2026-10-08'), '2026-10');
    assert.equal(shiftKey('week', '2026-10-05', 1), '2026-10-12');
    assert.equal(shiftKey('week', '2026-10-05', -1), '2026-09-28');
    assert.equal(shiftKey('month', '2026-12', 1), '2027-01');
    assert.equal(shiftKey('month', '2026-01', -1), '2025-12');
    assert.equal(periodEnd('week', '2026-10-05'), '2026-10-11');
    assert.equal(periodEnd('month', '2026-02'), '2026-02-28');
    assert.equal(periodEnd('month', '2028-02'), '2028-02-29');
  });
  await ok('isoWeek + nhãn kỳ', () => {
    assert.equal(isoWeek('2026-10-05'), 41);
    assert.equal(isoWeek('2026-01-01'), 1);
    assert.equal(isoWeek('2021-01-03'), 53);
    assert.equal(periodLabel('week', '2026-10-05'), 'Tuần 41 · 05/10 – 11/10/2026');
    assert.equal(periodLabel('month', '2026-10'), 'Tháng 10/2026');
  });
  await ok('validKey', () => {
    assert.ok(validKey('week', '2026-10-05') && !validKey('week', '2026-13-05') && !validKey('week', 'abc'));
    assert.ok(validKey('month', '2026-10') && !validKey('month', '2026-13') && !validKey('month', '2026-1'));
  });
  await ok('cleanTags: mảng hoặc chuỗi, bỏ #, trùng, rỗng', () => {
    assert.deepEqual(cleanTags('a, #b ,a,,c'), ['a', 'b', 'c']);
    assert.deepEqual(cleanTags([' x ', 'x', '']), ['x']);
  });

  await ok('buildItem: mặc định deadline = cuối kỳ, tuần lệch ngày kéo về Thứ 2', () => {
    const w = buildItem({ period: 'week', periodKey: '2026-10-08', title: ' Làm báo cáo ' });
    assert.equal(w.title, 'Làm báo cáo');
    assert.equal(w.periodKey, '2026-10-05');
    assert.equal(w.deadline, '2026-10-11');
    assert.equal(w.status, 'todo');
    assert.equal(buildItem({ period: 'month', periodKey: '2026-10', title: 'x' }).deadline, '2026-10-31');
  });
  await ok('buildItem: deadline null = cố ý không đặt; sai thì báo lỗi', () => {
    assert.equal(buildItem({ period: 'week', periodKey: '2026-10-05', title: 'x', deadline: null }).deadline, null);
    assert.throws(() => buildItem({ period: 'week', periodKey: '2026-10-05', title: 'x', deadline: '2026-02-30' }), /Deadline/);
    assert.throws(() => buildItem({ period: 'week', periodKey: '2026-10-05', title: '  ' }), /Tên nhiệm vụ/);
    assert.throws(() => buildItem({ period: 'year', periodKey: '2026', title: 'x' }), /Kỳ phải/);
  });
  await ok('patchItem: doneAt theo trạng thái, chỉ đổi field có mặt', () => {
    const it = buildItem({ period: 'week', periodKey: '2026-10-05', title: 'x', tags: ['a'] }, 1000);
    const done = patchItem(it, { status: 'done' }, 2000);
    assert.equal(done.doneAt, 2000);
    assert.deepEqual(done.tags, ['a']);
    assert.equal(patchItem(done, { status: 'doing' }, 3000).doneAt, null);
    assert.equal(patchItem(done, { status: 'done' }, 4000).doneAt, 2000); // đã done thì giữ mốc cũ
  });
  await ok('patchItem: chuyển sang kỳ sau → carried+1 và deadline dời theo; lùi thì không đếm', () => {
    const it = buildItem({ period: 'week', periodKey: '2026-10-05', title: 'x' });
    const next = patchItem(it, { periodKey: '2026-10-12' });
    assert.equal(next.carried, 1);
    assert.equal(next.deadline, '2026-10-18');
    const custom = patchItem({ ...it, deadline: '2026-10-09' }, { periodKey: '2026-10-12' });
    assert.equal(custom.deadline, '2026-10-18'); // deadline cũ nằm trong kỳ cũ → dời
    const later = patchItem({ ...it, deadline: '2026-11-30' }, { periodKey: '2026-10-12' });
    assert.equal(later.deadline, '2026-11-30'); // vượt ngoài kỳ cũ → người dùng chủ ý, giữ
    assert.equal(patchItem(next, { periodKey: '2026-10-05' }).carried, 1);
  });

  // ── Kho local ──────────────────────────────────────────────────────────
  const store = await import('../lib/workFocus');
  await ok('list rỗng: chọn kho local, không có localPending', async () => {
    const r = await store.listFocus();
    assert.equal(r.storage.mode, 'local');
    assert.deepEqual(r.items, []);
    assert.equal(r.localPending, 0);
  });
  await ok('add → list → update → remove', async () => {
    const a = await store.addFocus({ period: 'week', periodKey: '2026-10-05', title: 'A', tags: 'x,y', priority: 'urgent' });
    const b = await store.addFocus({ period: 'month', periodKey: '2026-10', title: 'B' });
    assert.equal((await store.listFocus()).items.length, 2);
    const u = await store.updateFocus(a.id, { status: 'doing', subtasks: [{ text: 's1', done: true }, { text: '' }] });
    assert.equal(u.status, 'doing');
    assert.equal(u.subtasks.length, 1);
    assert.ok(u.subtasks[0].id);
    const listed = (await store.listFocus()).items.find((i) => i.id === a.id)!;
    assert.equal(listed.priority, 'urgent');
    assert.deepEqual(listed.tags, ['x', 'y']);
    await store.removeFocus(b.id);
    assert.equal((await store.listFocus()).items.length, 1);
    await assert.rejects(() => store.updateFocus('nope', { title: 'x' }), /Không tìm thấy/);
  });
  await ok('ghi đồng thời không mất bản ghi (hàng đợi khoá)', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.addFocus({ period: 'week', periodKey: '2026-10-12', title: `P${i}` })));
    assert.equal((await store.listFocus()).items.filter((i) => i.title.startsWith('P')).length, 12);
  });
  await ok('đưa local lên Mongo khi chưa cấu hình Mongo → báo lỗi, không mất dữ liệu', async () => {
    await assert.rejects(() => store.importLocalFocus(), /Chưa cấu hình Mongo/);
    assert.equal((await store.listFocus()).items.length, 13);
  });
  await ok('file hỏng/thiếu field: đọc không vỡ', async () => {
    await fs.writeFile(tmp, JSON.stringify({ items: [{ id: 'z', title: 'cũ', period: 'month', periodKey: '2026-10' }] }), 'utf8');
    const it = (await store.listFocus()).items[0];
    assert.equal(it.status, 'todo');
    assert.deepEqual(it.tags, []);
    assert.equal(it.deadline, null);
    await fs.writeFile(tmp, '{not json', 'utf8');
    assert.deepEqual((await store.listFocus()).items, []);
  });

  await fs.rm(tmp, { force: true });
  console.log(`\n${n} kiểm tra đạt.`);
}

main().catch(async (e) => {
  await fs.rm(tmp, { force: true });
  console.error(e);
  process.exit(1);
});
