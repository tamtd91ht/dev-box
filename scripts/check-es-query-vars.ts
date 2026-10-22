// Kiểm tra biến truy vấn của tab ES → Dữ liệu (lib/esQueryVars): quét placeholder trong/ngoài chuỗi, cách thay
// (mảng / giá trị đầu / dán vào chuỗi / SQL), chuỗi biến, vòng lặp, giới hạn số giá trị.
// Chạy: npm run check:es-vars — fetch được giả lập, không gọi server hay cluster nào.

import assert from 'node:assert/strict';
import { findRefs, maskRefs, resolveVars, type QueryVar } from '../lib/esQueryVars';

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log('  ✓', name); });

/** Dữ liệu giả theo connectionId; ghi lại mọi request để kiểm query đã thay biến. */
const DATA: Record<string, Record<string, unknown>[]> = {
  esTenants: [{ _id: 'a', tenantId: 't1' }, { _id: 'b', tenantId: 't2' }, { _id: 'c', tenantId: 't1' }, { _id: 'd', tags: ['x', 'y'] }],
  mongoUsers: [{ _id: { $oid: '64b000000000000000000001' }, tenantId: 't9', n: 3 }, { _id: { $oid: '64b000000000000000000002' }, tenantId: 't8', n: 4 }],
  pgOrgs: [{ id: 7, code: "o'1" }, { id: 8, code: 'o2' }],
};
const calls: { url: string; body: Record<string, unknown> }[] = [];
const wire = (rows: Record<string, unknown>[]) => rows.map((r) => ({ json: JSON.stringify(r), truncated: false }));

globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
  calls.push({ url, body });
  const rows = DATA[String(body.connectionId)] ?? [];
  let result: unknown;
  if (url === '/api/es') result = body.mode === 'start' ? { docs: wire(rows), tookMs: 1, scrollId: 's1' } : body.mode === 'next' ? { docs: [], tookMs: 1, scrollId: null } : { ok: true };
  else if (url === '/api/mongo') result = { docs: wire(rows), limit: 200, skip: 0, hasMore: false, tookMs: 1 };
  else result = { columns: [], rows: wire(Number(String(body.sql).match(/OFFSET (\d+)/)?.[1] ?? 0) > 0 ? [] : rows), rowCount: rows.length, capped: false, tookMs: 1 };
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) } as Response;
}) as typeof fetch;

const v = (p: Partial<QueryVar> & Pick<QueryVar, 'name' | 'connectionId' | 'kind'>): QueryVar => ({
  id: p.name, db: p.kind === 'es' ? '' : 'db', object: p.kind === 'pg' ? '' : 'obj', query: '', field: '', ...p,
});

async function main() {
  await ok('findRefs phân biệt trần / nguyên chuỗi / một phần chuỗi', () => {
    const t = '{"a": {{q1.x}}, "b": "{{q1}}", "c": "p-{{q2.y}}", "d": "\\"{{q3}}"}';
    const refs = findRefs(t, '"');
    assert.deepEqual(refs.map((r) => [r.name, r.path, r.inString]), [
      ['q1', 'x', null], ['q1', '', 'whole'], ['q2', 'y', 'part'], ['q3', '', 'part'],
    ]);
    assert.equal(t.slice(refs[1].start, refs[1].end), '"{{q1}}"');
  });

  await ok('maskRefs → JSON hợp lệ, restore trả lại nguyên placeholder', () => {
    const t = '{"terms": {"tenantId": {{q1.tenantId}}}}';
    const { masked, restore } = maskRefs(t);
    const pretty = JSON.stringify(JSON.parse(masked), null, 2);
    assert.match(restore(pretty), /"tenantId": \{\{q1\.tenantId\}\}/);
  });

  const vars = [
    v({ name: 'q1', connectionId: 'esTenants', kind: 'es', field: 'tenantId' }),
    v({ name: 'm', connectionId: 'mongoUsers', kind: 'mongo', query: '{"tenantId": {"$in": {{q1}}}}' }),
    v({ name: 'p', connectionId: 'pgOrgs', kind: 'pg', query: 'SELECT * FROM orgs WHERE tenant IN ({{q1}}) AND x = \'{{m.tenantId}}\'' }),
  ];

  await ok('trần → mảng bỏ trùng; nguyên chuỗi → giá trị đầu giữ kiểu; một phần → dán vào chuỗi', async () => {
    const r = await resolveVars('{"a": {{q1}}, "b": "{{m.n}}", "c": "x-{{p.code}}", "t": {{q1.tags}}}', vars);
    assert.deepEqual(JSON.parse(r.text), { a: ['t1', 't2'], b: 3, c: "x-o'1", t: ['x', 'y'] });
    assert.equal(r.stats.find((s) => s.name === 'q1' && s.path === 'tenantId')?.count, 2);
  });

  await ok('chuỗi biến: query của m / p được thay trước khi chạy, mỗi biến chạy một lần', async () => {
    calls.length = 0;
    await resolveVars('{"a": {{p.id}}, "b": {{m.tenantId}}}', vars);
    const mongo = calls.find((c) => c.url === '/api/mongo');
    assert.deepEqual(JSON.parse(String(mongo?.body.filter)), { tenantId: { $in: ['t1', 't2'] } });
    const pg = calls.find((c) => c.url === '/api/pg');
    assert.match(String(pg?.body.sql), /tenant IN \('t1', 't2'\) AND x = 't9'/);
    assert.equal(calls.filter((c) => c.url === '/api/es' && c.body.mode === 'start').length, 1);
  });

  await ok('SQL: danh sách rỗng → NULL, chuỗi có nháy đơn được thoát', async () => {
    const empty = [...vars, v({ name: 'z', connectionId: 'none', kind: 'es', field: 'k' }), v({ name: 'w', connectionId: 'pgOrgs', kind: 'pg', query: 'SELECT 1 WHERE a IN ({{z}}) OR b IN ({{p.code}})' })];
    calls.length = 0;
    await resolveVars('{{w.id}}', empty);
    assert.match(String(calls.find((c) => String(c.body.sql).includes('SELECT 1'))?.body.sql), /a IN \(NULL\) OR b IN \('o''1', 'o2'\)/);
  });

  await ok('lỗi rõ ràng: biến chưa khai, vòng lặp, thiếu field, chuỗi rỗng, vượt tối đa', async () => {
    await assert.rejects(resolveVars('{{nope}}', vars), /chưa được khai báo/);
    const loop = [v({ name: 'a', connectionId: 'esTenants', kind: 'es', field: 'x', query: '{{b}}' }), v({ name: 'b', connectionId: 'esTenants', kind: 'es', field: 'x', query: '{{a}}' })];
    await assert.rejects(resolveVars('{{a}}', loop), /vòng: a → b → a/);
    await assert.rejects(resolveVars('{{m}}', vars), /field mặc định/);
    await assert.rejects(resolveVars('"{{q1.missing}}"', vars), /không có giá trị nào/);
    const small = [v({ name: 'q1', connectionId: 'esTenants', kind: 'es', field: 'tenantId', max: 1 })];
    await assert.rejects(resolveVars('{{q1}}', small), /hơn 1 giá trị/);
  });

  await ok('không có placeholder → giữ nguyên, không gọi gì', async () => {
    calls.length = 0;
    const r = await resolveVars('{"size": 5}', vars);
    assert.equal(r.text, '{"size": 5}');
    assert.equal(calls.length, 0);
  });

  console.log(`\n${n} kiểm tra đều qua.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
