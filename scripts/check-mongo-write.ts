// Kiểm luật chặn của màn "⚡ Thực thi lệnh ghi" Mongo (lib/mongoClient writeOp).
//
// Chỉ thử các ca BỊ TỪ CHỐI — chúng ném lỗi trước khi mở kết nối, nên script
// không cần cụm Mongo nào. Chạy: npm run check:mongo-write

process.env.MONGO_ALLOW_WRITE = 'true';

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

async function main() {
  const { writeOp } = await import('../lib/mongoClient');
  const conn = { id: 'x', name: 'test', readOnly: false } as unknown as Parameters<typeof writeOp>[0];

  async function refused(label: string, input: Parameters<typeof writeOp>[3], expect: RegExp, c = conn) {
    try {
      await writeOp(c, 'db', 'coll', input, false);
      check(false, `${label} (không bị chặn)`);
    } catch (e) {
      const msg = (e as Error).message;
      check(expect.test(msg), `${label} — ${msg}`);
    }
  }

  await refused('connection read-only', { op: 'deleteOne', filter: '{"a":1}' }, /read-only/, { ...conn, readOnly: true } as typeof conn);
  await refused('lệnh lạ', { op: 'drop' }, /không hỗ trợ/);
  await refused('deleteMany filter rỗng', { op: 'deleteMany', filter: '{}' }, /KHÔNG rỗng/);
  await refused('updateMany không có filter', { op: 'updateMany', filter: '', body: '{"$set":{"a":1}}' }, /KHÔNG rỗng/);
  await refused('$where trong filter', { op: 'deleteOne', filter: '{"$where":"1"}' }, /\$where/);
  await refused('update thay cả document', { op: 'updateOne', filter: '{"a":1}', body: '{"b":2}' }, /replaceOne/);
  await refused('update pipeline stage lạ', { op: 'updateOne', filter: '{"a":1}', body: '[{"$merge":"x"}]' }, /pipeline chỉ nhận/);
  await refused('$function trong update pipeline', { op: 'updateOne', filter: '{"a":1}', body: '[{"$set":{"x":{"$function":{}}}}]' }, /\$function/);
  await refused('replace có toán tử $', { op: 'replaceOne', filter: '{"a":1}', body: '{"$set":{"b":2}}' }, /bắt đầu bằng \$/);
  await refused('insertOne nhận mảng', { op: 'insertOne', body: '[{"a":1}]' }, /insertMany/);
  await refused('insertMany mảng rỗng', { op: 'insertMany', body: '[]' }, /không rỗng/);
  await refused('insertMany quá 1000', { op: 'insertMany', body: JSON.stringify(Array.from({ length: 1001 }, () => ({}))) }, /tối đa/);
  await refused('JSON hỏng', { op: 'insertOne', body: '{a:' }, /not valid JSON/);

  if (failures) {
    console.error(`\n${failures} kiểm tra hỏng`);
    process.exit(1);
  }
  console.log('\nOK');
}
void main();
