// Kiểm phần soát lệnh của màn "⚡ Thực thi SQL" (lib/pgClient executeSql).
//
// Vì sao cần: "chạy thử" chỉ an toàn khi KHÔNG có COMMIT nào lọt vào khối lệnh
// — tách lệnh sai (vd. coi `;` trong chuỗi là hết lệnh, hoặc bỏ sót COMMIT sau
// comment) là chạy thử thành ghi thật. Chạy: npm run check:pg-exec

import { splitStatements, txControlStatement } from '../lib/pgClient';

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

check(eq(splitStatements('SELECT 1'), ['SELECT 1']), 'một lệnh');
check(eq(splitStatements('INSERT INTO t VALUES (1); DELETE FROM t WHERE id = 2;'), ['INSERT INTO t VALUES (1)', 'DELETE FROM t WHERE id = 2']), 'hai lệnh, ; cuối');
check(splitStatements("UPDATE t SET a = 'x;y' WHERE b = 'it''s'").length === 1, '; trong chuỗi + nháy kép escape');
check(splitStatements('SELECT "we;ird" FROM t').length === 1, '; trong định danh');
check(splitStatements('CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END $$ LANGUAGE plpgsql').length === 1, 'thân $$…$$');
check(splitStatements('DO $x$ BEGIN PERFORM 1; END $x$').length === 1, 'thân $tag$…$tag$');
check(splitStatements("SELECT E'a\\'; b'").length === 1, "E-string với \\'");
check(txControlStatement(splitStatements("SELECT E'\\''; COMMIT; --'")) !== null, "E'\\'' không che được COMMIT phía sau");
check(splitStatements('  ;  ; ').length === 0, 'chỉ toàn ;');

check(txControlStatement(splitStatements('UPDATE t SET a=1 WHERE id=1; COMMIT')) !== null, 'chặn COMMIT');
check(txControlStatement(splitStatements('delete from t where id=1;\n-- xong\ncommit;')) !== null, 'chặn commit sau comment');
check(txControlStatement(splitStatements('/* c */ BEGIN; UPDATE t SET a=1 WHERE id=1')) !== null, 'chặn BEGIN sau block comment');
check(txControlStatement(splitStatements('ROLLBACK')) !== null, 'chặn ROLLBACK');
check(txControlStatement(splitStatements('SAVEPOINT s1')) !== null, 'chặn SAVEPOINT');
check(txControlStatement(splitStatements('START TRANSACTION')) !== null, 'chặn START TRANSACTION');
check(txControlStatement(splitStatements('END')) !== null, 'chặn END');
check(txControlStatement(splitStatements("INSERT INTO log(msg) VALUES ('COMMIT')")) === null, 'COMMIT trong chuỗi không bị chặn');
check(txControlStatement(splitStatements('CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql')) === null, 'BEGIN trong thân hàm không bị chặn');
check(txControlStatement(splitStatements('UPDATE t SET ended = true WHERE id = 1')) === null, 'cột "ended" không bị nhầm END');

if (failures) {
  console.error(`\n${failures} kiểm tra hỏng`);
  process.exit(1);
}
console.log('\nOK');
