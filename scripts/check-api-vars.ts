// Kiểm tra logic thuần của tab API: biến (kể cả biến động), Params ⇄ URL, Auth,
// và việc chuyển environment cũ thành biến chung. Chạy: npm run check:api
//
// Phần kho lưu ghi vào một file TẠM (API_COLLECTIONS_PATH) — không đụng cấu hình thật.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = path.join(os.tmpdir(), `apicol-${Date.now()}.json`);
process.env.API_COLLECTIONS_PATH = tmp;

import { resolveVars, findVarNames, splitQuery, joinQuery, setQueryParam, basicAuthValue, applyAuth, dynamicVar } from '../lib/apiVars';

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log('  ✓', name); });

async function main() {
  await ok('resolveVars: biến thường + biến lạ giữ nguyên', () => {
    assert.equal(resolveVars('{{host}}/x/{{ id }}/{{nope}}', { host: 'h', id: '7' }), 'h/x/7/{{nope}}');
  });
  await ok('resolveVars: biến động sinh giá trị, mỗi chỗ một giá trị mới', () => {
    const out = resolveVars('{{$guid}}|{{$guid}}|{{$timestamp}}|{{$randomInt}}', {});
    const [a, b, ts, ri] = out.split('|');
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.notEqual(a, b);
    assert.match(ts, /^\d{10}$/);
    assert.ok(Number(ri) >= 0 && Number(ri) <= 1000);
    assert.equal(dynamicVar('$nope'), null);
    assert.equal(resolveVars('{{$nope}}', {}), '{{$nope}}');
  });
  await ok('biến khai trong env thắng biến động cùng tên', () => {
    assert.equal(resolveVars('{{$guid}}', { $guid: 'fixed' }), 'fixed');
  });
  await ok('findVarNames bỏ biến động, gộp trùng', () => {
    assert.deepEqual(findVarNames('{{a}} {{b}} {{a}}', '{{$guid}}', undefined).sort(), ['a', 'b']);
  });

  await ok('splitQuery / joinQuery: khứ hồi không đổi chữ, giữ {{biến}} và #fragment', () => {
    for (const u of ['http://h/p', 'http://h/p?a=1&b={{x}}', 'http://h/p?a=1#frag', 'http://h/p?flag&k=v=w']) {
      const s = splitQuery(u);
      assert.equal(joinQuery(s.base, s.rows, s.hash), u.replace('?flag&', '?flag=&'));
    }
  });
  await ok('joinQuery: dòng tắt và dòng không key bị bỏ', () => {
    const url = joinQuery('http://h', [
      { key: 'a', value: '1', on: true }, { key: 'b', value: '2', on: false }, { key: '', value: 'x', on: true },
    ]);
    assert.equal(url, 'http://h?a=1');
  });
  await ok('setQueryParam thay giá trị cũ cùng tên', () => {
    assert.equal(setQueryParam('http://h?k=old&z=1', 'k', 'a b'), 'http://h?z=1&k=a%20b');
  });

  await ok('basicAuthValue hỗ trợ tiếng Việt', () => {
    assert.equal(basicAuthValue('user', 'pass'), 'Basic dXNlcjpwYXNz');
    assert.doesNotThrow(() => basicAuthValue('Nguyễn', 'mật khẩu'));
  });
  await ok('applyAuth: bearer / header gõ tay thắng / apikey query', () => {
    const env = { t: 'TOK' };
    assert.deepEqual(applyAuth('u', [], { type: 'bearer', token: '{{t}}' }, env).headers, [{ key: 'Authorization', value: 'Bearer TOK' }]);
    const manual = [{ key: 'authorization', value: 'mine' }];
    assert.deepEqual(applyAuth('u', manual, { type: 'bearer', token: 'x' }, env).headers, manual);
    const q = applyAuth('http://h?a=1', [], { type: 'apikey', keyName: 'k', keyValue: '{{t}}', keyIn: 'query' }, env);
    assert.equal(q.url, 'http://h?a=1&k=TOK');
    assert.deepEqual(applyAuth('u', [], { type: 'none' }, env), { url: 'u', headers: [] });
  });

  // ── Kho lưu: environment cũ → biến chung ───────────────────────────────
  const store = await import('../lib/apiStore');
  await fs.writeFile(tmp, JSON.stringify({
    requests: [{ id: 'r1', name: 'A', folder: 'P1', method: 'GET', url: 'x', headers: [], body: '', bodyType: 'none', updatedAt: '' }],
    environments: [
      { id: 'e1', name: 'dev', vars: [{ key: 'host', value: 'dev.local' }] },
      { id: 'e2', name: 'prod', vars: [{ key: 'host', value: 'prod.local' }] },
    ],
    activeEnvId: 'e2',
  }), 'utf8');

  await ok('chưa có globalVars: lấy environment đang chọn làm biến chung, không xoá environments', async () => {
    const d = await store.getData();
    assert.deepEqual(d.globalVars, [{ key: 'host', value: 'prod.local', on: true }]);
    assert.equal(d.environments.length, 2);
    assert.deepEqual(d.projectVars, {});
  });
  await ok('saveGlobals: bỏ dòng không key, trim key, lưu bền', async () => {
    await store.saveGlobals([{ key: ' a ', value: '1' }, { key: '', value: 'x' }, { key: 'b', value: '2', on: false }]);
    const d = await store.getData();
    assert.deepEqual(d.globalVars, [{ key: 'a', value: '1', on: true }, { key: 'b', value: '2', on: false }]);
    assert.equal(d.environments.length, 2); // vẫn còn
    assert.equal(d.requests.length, 1); // request không bị đụng
  });
  await ok('saveGlobals rỗng KHÔNG seed lại từ environment cũ', async () => {
    await store.saveGlobals([]);
    assert.deepEqual((await store.getData()).globalVars, []);
  });
  await ok('saveProjectVars: ghi, rồi rỗng thì xoá khoá', async () => {
    await store.saveProjectVars('P1', [{ key: 'host', value: 'p1.local' }]);
    assert.deepEqual((await store.getData()).projectVars, { P1: [{ key: 'host', value: 'p1.local', on: true }] });
    await store.saveProjectVars('P1', []);
    assert.deepEqual((await store.getData()).projectVars, {});
    await assert.rejects(() => store.saveProjectVars('  ', []), /Thiếu tên dự án/);
  });
  await ok('saveRequest mang params/auth/opts; auth none không lưu', async () => {
    await store.saveRequest({ name: 'B', url: 'u', params: [{ key: 'a', value: '1', on: false }], auth: { type: 'bearer', token: 't' }, opts: { timeoutSec: 5, follow: false } });
    await store.saveRequest({ name: 'C', url: 'u', auth: { type: 'none' } });
    const d = await store.getData();
    const b = d.requests.find((r) => r.name === 'B')!;
    assert.deepEqual(b.params, [{ key: 'a', value: '1', on: false }]);
    assert.equal(b.auth?.token, 't');
    assert.equal(b.opts?.follow, false);
    assert.equal(d.requests.find((r) => r.name === 'C')!.auth, undefined);
  });

  await fs.rm(tmp, { force: true });
  console.log(`\n${n} kiểm tra đạt.`);
}

main().catch(async (e) => {
  await fs.rm(tmp, { force: true });
  console.error(e);
  process.exit(1);
});
