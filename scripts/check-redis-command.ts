// Kiểm phần soát lệnh của tab "⚡ Chạy lệnh" Redis (lib/redisCommands).
//
// Vì sao cần: đây là chốt chặn duy nhất giữa ô nhập và client.call() — tách
// argv sai hay để lọt một lệnh quản trị (FLUSHALL, CONFIG…) là xoá/đổi cả
// instance. Chạy: npm run check:redis-cmd

import { splitArgs, parseCommand, parseScript } from '../lib/redisCommands';

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function refused(text: string, expect: RegExp, label: string) {
  try {
    parseCommand(text, 1);
    check(false, `${label} (không bị chặn)`);
  } catch (e) {
    check(expect.test((e as Error).message), `${label} — ${(e as Error).message}`);
  }
}

// ── tách argv ──
check(eq(splitArgs('SET a b'), ['SET', 'a', 'b']), 'tách cơ bản');
check(eq(splitArgs('  SET   a\tb  '), ['SET', 'a', 'b']), 'khoảng trắng thừa');
check(eq(splitArgs('SET k "hello world"'), ['SET', 'k', 'hello world']), 'nháy kép');
check(eq(splitArgs('SET k "a\\"b\nc"'), ['SET', 'k', 'a"b\nc']), 'escape trong nháy kép');
check(eq(splitArgs("SET k 'x\ny'"), ['SET', 'k', 'x\ny']), 'nháy đơn giữ nguyên văn');
check(eq(splitArgs('SET k ""'), ['SET', 'k', '']), 'chuỗi rỗng');
check(eq(splitArgs('SET user:"a b":x v'), ['SET', 'user:a b:x', 'v']), 'nháy giữa từ');
try { splitArgs('SET k "abc'); check(false, 'thiếu nháy đóng'); } catch { check(true, 'thiếu nháy đóng → lỗi'); }

// ── danh sách cho phép ──
refused('FLUSHALL', /FLUSHALL/, 'chặn FLUSHALL');
refused('flushdb', /FLUSHDB/, 'chặn flushdb (chữ thường)');
refused('CONFIG SET maxmemory 1', /không có trong danh sách/, 'chặn CONFIG');
refused('KEYS *', /SCAN/, 'chặn KEYS');
refused('EVAL "return 1" 0', /không có trong danh sách/, 'chặn EVAL');
refused('DEBUG SLEEP 10', /không có trong danh sách/, 'chặn DEBUG');
refused('SHUTDOWN', /không có trong danh sách/, 'chặn SHUTDOWN');
refused('PERSIST k', /PERSIST/, 'chặn PERSIST');
refused('GETEX k PERSIST', /PERSIST/, 'chặn GETEX PERSIST');
refused('SET k', /ít nhất 2/, 'SET thiếu tham số');
refused('MSET a 1 b', /cặp/, 'MSET lẻ');

// ── luật TTL ──
refused('EXPIRE k 2592001', /30 ngày/, 'EXPIRE > 30 ngày');
refused('EXPIRE k 0', /≥ 1/, 'EXPIRE 0');
refused('SETEX k 9999999 v', /30 ngày/, 'SETEX > 30 ngày');
refused('SET k v EX 9999999', /30 ngày/, 'SET EX > 30 ngày');
refused('SET k v PX 9999999999', /30 ngày/, 'SET PX > 30 ngày');
refused(`EXPIREAT k ${Math.floor(Date.now() / 1000) + 40 * 86400}`, /30 ngày/, 'EXPIREAT quá 30 ngày');
check(parseCommand('SET k v EX 60', 1).inlineTtl, 'SET EX 60 hợp lệ, có TTL');
check(parseCommand('SET k v KEEPTTL', 1).keepTtl, 'SET KEEPTTL');
check(parseCommand('PEXPIRE k 60000', 1).write, 'PEXPIRE hợp lệ');

// ── key bị đụng ──
check(eq(parseCommand('MSET a 1 b 2', 1).keys, ['a', 'b']), 'MSET keys');
check(eq(parseCommand('DEL a b c', 1).keys, ['a', 'b', 'c']), 'DEL keys');
check(eq(parseCommand('RENAME a b', 1).keys, ['a', 'b']), 'RENAME keys');
check(eq(parseCommand('HSET h f v', 1).keys, ['h']), 'HSET key');
check(!parseCommand('GET a', 1).write, 'GET là lệnh đọc');

// ── cả ô nhập ──
const s = parseScript('# ghi chú\n\nSET a 1 EX 10\n  hset h f v  \n');
check(s.length === 2 && s[0].line === 3 && s[1].line === 4 && s[1].name === 'HSET', 'bỏ ghi chú + dòng trống, giữ số dòng');
try { parseScript('SET a 1\nFLUSHALL'); check(false, 'một dòng xấu chặn cả ô'); }
catch (e) { check(/Dòng 2/.test((e as Error).message), 'một dòng xấu chặn cả ô (báo đúng dòng)'); }
try { parseScript('# chỉ ghi chú'); check(false, 'ô rỗng'); } catch { check(true, 'ô chỉ có ghi chú → lỗi'); }
try { parseScript(Array.from({ length: 51 }, () => 'GET a').join('\n')); check(false, '> 50 lệnh'); } catch { check(true, '> 50 lệnh → lỗi'); }

if (failures) {
  console.error(`\n${failures} kiểm tra hỏng`);
  process.exit(1);
}
console.log('\nOK');
