// scripts/check-pg-diagnose.ts — kiểm luật phân tích cache hit PostgreSQL.
//
// VÌ SAO CÓ FILE NÀY: nút "Phân tích" chỉ có giá trị khi kết luận ĐÚNG. Báo
// "thiếu index" cho bảng đã dùng index tốt, bịa ra cột không có trong bảng, hay
// bắt người ta tăng RAM khi con số thấp chỉ là cộng dồn từ một đợt quét cũ —
// đều dẫn tới sửa sai chỗ trên production. Các ca ở đây khoá những chỗ đó.
//
//   npx tsx scripts/check-pg-diagnose.ts

import { analyzeCacheHit, explainFor, guessIndexColumns, mentionsTable, type CacheHitFacts, type DiagTable } from '../lib/pgDiagnoseRules';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else { failures += 1; console.error(`✗ ${m}`); }
};

const GB = 1024 ** 3;
const table = (over: Partial<DiagTable>): DiagTable => ({
  db: 'app', schema: 'public', table: 'orders',
  heapRead: 0, heapHit: 0, idxRead: 0, idxHit: 0, toastRead: 0,
  seqScan: 0, seqTupRead: 0, idxScan: 0, liveTup: 0, deadTup: 0,
  sizeBytes: 10 * GB, lastVacuum: null, columns: ['id', 'customer_id', 'status', 'created_at'],
  ...over,
});
const facts = (over: Partial<CacheHitFacts>): CacheHitFacts => ({
  versionNum: 160000, blockSize: 8192, user: 'app', canReadAllStats: true,
  sharedBuffersBytes: 4 * GB, effectiveCacheBytes: 12 * GB, trackIoTiming: null, hostMemBytes: 16 * GB,
  cumulative: { hit: 70_000, read: 30_000 },
  window: null,
  dbs: [{ name: 'app', hit: 70_000, read: 30_000, readTimeMs: null, sizeBytes: 20 * GB, statsReset: null }],
  tables: [], analyzedDbs: ['app'], skippedDbs: [],
  statements: [], statementsTotalRead: 0, statementsState: 'ok', activeQueries: [],
  ...over,
});
const ids = (f: CacheHitFacts): string[] => analyzeCacheHit(f).findings.map((x) => x.id);

// ── Hiện tại hay chuyện cũ ──
{
  const d = analyzeCacheHit(facts({ window: { hit: 9_900, read: 100, sec: 6 } }));
  check(d.currentPct === 99 && d.cumulativePct === 70, 'tính đúng tỉ lệ hiện tại và cộng dồn');
  check(d.findings[0]?.id === 'stale' || d.findings.some((x) => x.id === 'stale'), 'hiện tại 99% / cộng dồn 70% → báo "chuyện cũ"');
  check(d.headline.startsWith('Không có sự cố hiện tại'), 'kết luận chính nói rõ không có sự cố hiện tại');
}
{
  const d = analyzeCacheHit(facts({ window: { hit: 7_000, read: 3_000, sec: 6 } }));
  const cur = d.findings.find((x) => x.id === 'current-low');
  check(cur?.level === 'crit', 'hiện tại 70% → đang xảy ra, mức đỏ');
  check(!d.findings.some((x) => x.id === 'stale'), 'đang thấp thì không nói "chuyện cũ"');
}
check(ids(facts({ window: { hit: 100, read: 50, sec: 6 } })).includes('window-low'), 'tải quá thấp → không kết luận tỉ lệ hiện tại');
check(analyzeCacheHit(facts({ window: { hit: 100, read: 50, sec: 6 } })).currentPct === null, 'tải quá thấp → currentPct = null (không bịa số)');

// ── Bảng bị quét toàn bộ ──
{
  const t = table({ heapRead: 25_000, seqScan: 4_000, seqTupRead: 4_000 * 900_000, idxScan: 10, liveTup: 1_000_000 });
  const stmts = [{ db: 'app', query: 'SELECT * FROM orders o WHERE o.customer_id = $1 AND status = $2', calls: 4000, sharedRead: 25_000, sharedHit: 0 }];
  const d = analyzeCacheHit(facts({ tables: [t], statements: stmts, statementsTotalRead: 25_000 }));
  const f = d.findings.find((x) => x.id.startsWith('seq:'));
  check(!!f && f.level === 'crit', 'bảng chiếm 83% đọc ngoài + seq scan toàn bảng → thiếu index, mức đỏ');
  check(!!f?.sql?.includes('CREATE INDEX CONCURRENTLY ON public.orders (customer_id, status)'), 'gợi ý index đúng cột lọc, CONCURRENTLY');
  check(d.headline.includes('thiếu index'), 'kết luận chính chỉ ra thiếu index (không phải triệu chứng)');
}
{
  // Bảng đọc qua index tốt: KHÔNG được bảo thiếu index.
  const t = table({ idxRead: 25_000, seqScan: 3, seqTupRead: 3 * 1_000_000, idxScan: 5_000_000, liveTup: 1_000_000 });
  const d = analyzeCacheHit(facts({ tables: [t] }));
  check(!d.findings.some((x) => x.id.startsWith('seq:')), 'bảng dùng index tốt → không báo thiếu index');
  check(d.findings.some((x) => x.id.startsWith('big:')), 'bảng dùng index nhưng vẫn đọc ngoài nhiều → báo bảng lớn hơn bộ nhớ');
}
{
  // Bảng nhỏ chiếm ít đọc ngoài: không nêu tên.
  const t = table({ heapRead: 500, seqScan: 9_000, seqTupRead: 9_000 * 50, liveTup: 50 });
  check(!ids(facts({ tables: [t] })).some((x) => x.startsWith('seq:') || x.startsWith('big:')), 'bảng chiếm < 10% đọc ngoài → không nêu');
}

// ── Suy cột: chỉ cột có thật, chỉ trong điều kiện lọc ──
{
  const t = table({});
  const cols = guessIndexColumns(t, [
    { db: 'app', query: 'SELECT customer_id, total FROM orders WHERE created_at > $1 AND nonexistent = 1', calls: 1, sharedRead: 10, sharedHit: 0 },
  ]);
  check(cols.join(',') === 'created_at', 'chỉ lấy cột trong WHERE (bỏ cột ở SELECT list) và bỏ cột không có trong bảng');
  check(guessIndexColumns(t, [{ db: 'app', query: 'SELECT * FROM orders_archive WHERE status = 1', calls: 1, sharedRead: 9, sharedHit: 0 }]).length === 0,
    'query đọc bảng khác tên gần giống (orders_archive) không tính cho orders');
  check(mentionsTable('select 1 from public."orders" x', t) && !mentionsTable('select 1 from my_orders', t), 'nhận ra tên bảng có schema / ngoặc kép, không nhầm tiền tố');
}

// ── Bộ nhớ ──
check(ids(facts({ sharedBuffersBytes: 128 * 1024 ** 2, hostMemBytes: 16 * GB })).includes('sb-small'), 'shared_buffers 128MB trên máy 16GB → báo nhỏ');
check(analyzeCacheHit(facts({ sharedBuffersBytes: 128 * 1024 ** 2, hostMemBytes: 16 * GB })).findings.find((x) => x.id === 'sb-small')?.sql?.includes("'4GB'") === true, 'gợi ý shared_buffers = 25% RAM (4GB)');
check(!ids(facts({ sharedBuffersBytes: 4 * GB, hostMemBytes: 16 * GB })).includes('sb-small'), 'shared_buffers 25% RAM → không báo');
check(ids(facts({ sharedBuffersBytes: 128 * 1024 ** 2, hostMemBytes: null })).includes('sb-default'), 'không biết RAM + đang mặc định 128MB → báo mặc định, không bịa con số');

// ── I/O thật hay page cache ──
check(ids(facts({ trackIoTiming: true, dbs: [{ name: 'app', hit: 1, read: 100_000, readTimeMs: 1_000, sizeBytes: GB, statsReset: null }] })).includes('io-pagecache'), '10 µs/block → page cache OS');
check(ids(facts({ trackIoTiming: true, dbs: [{ name: 'app', hit: 1, read: 100_000, readTimeMs: 200_000, sizeBytes: GB, statsReset: null }] })).includes('io-disk'), '2 ms/block → đĩa thật');
check(ids(facts({ trackIoTiming: false })).includes('io-unknown'), 'track_io_timing off → nói rõ chưa phân biệt được + cách bật');

// ── Giới hạn của lần phân tích ──
check(ids(facts({ statementsState: 'missing', statements: [] })).includes('stmt-missing'), 'thiếu pg_stat_statements → nói rõ + cách bật');
check(ids(facts({ canReadAllStats: false })).includes('priv'), 'thiếu quyền đọc thống kê → hướng dẫn GRANT pg_monitor');
{
  const t = table({ deadTup: 600_000, liveTup: 400_000 });
  const f = analyzeCacheHit(facts({ tables: [t] })).findings.find((x) => x.id.startsWith('bloat:'));
  check(f?.level === 'warn' && f.title.includes('60%'), '60% dòng chết → bloat, mức vàng');
}

// ── EXPLAIN chạy được ngay ──
{
  const q = 'SELECT * FROM jobs WHERE status = $1';
  check(explainFor(q, 160000, 'omicrm').includes('EXPLAIN (GENERIC_PLAN)'), 'query có $1 trên PG16+ → GENERIC_PLAN (không cần giá trị)');
  check(!explainFor(q, 140000, null).includes('GENERIC_PLAN') && explainFor(q, 140000, null).includes('Thay $1'), 'PG < 16 → nhắc thay giá trị, không dùng GENERIC_PLAN');
  const w = explainFor('UPDATE jobs SET status = 2 WHERE id = 5', 160000, null);
  check(w.startsWith('BEGIN;') && w.trim().endsWith('ROLLBACK;'), 'câu lệnh ghi → bọc BEGIN … ROLLBACK vì ANALYZE chạy thật');
  check(explainFor('select 1;', 160000, 'omicrm').startsWith('-- trong database omicrm\nEXPLAIN (ANALYZE, BUFFERS)\nselect 1;'), 'query không tham số → EXPLAIN ANALYZE thẳng, ghi rõ database');
}
{
  const jobs = table({ db: 'omicrm', table: 'jobs', heapRead: 25_000, seqScan: 4_000, seqTupRead: 4_000 * 900_000, idxScan: 0, liveTup: 1_000_000,
    columns: ['id', 'state'], indexes: [{ name: 'jobs_pkey', def: 'CREATE UNIQUE INDEX jobs_pkey ON public.jobs USING btree (id)', scans: 12, sizeBytes: 1 }] });
  const none = analyzeCacheHit(facts({ tables: [jobs], statementsState: 'missing' })).findings.find((x) => x.id.startsWith('seq:'))!;
  check(!none.sql!.includes('<query đọc') && none.sql!.includes("ILIKE '%jobs%'") && none.sql!.includes("tablename = 'jobs'"), 'không biết query → kịch bản điều tra điền sẵn tên bảng (không để chỗ trống)');
  check(none.evidence.some((e) => e.includes('jobs_pkey (id) · dùng 12 lần')), 'nêu index hiện có + số lần dùng');
  const live = analyzeCacheHit(facts({ tables: [jobs], statementsState: 'missing',
    activeQueries: [{ db: 'omicrm', query: 'SELECT * FROM jobs WHERE state = $1 ORDER BY id', ageSec: 3 }] })).findings.find((x) => x.id.startsWith('seq:'))!;
  check(live.sql!.includes('CREATE INDEX CONCURRENTLY ON public.jobs (state)') && live.sql!.includes('GENERIC_PLAN'), 'query đang chạy → suy được cột + EXPLAIN đúng query đó');
  const other = analyzeCacheHit(facts({ tables: [jobs], statementsState: 'missing',
    activeQueries: [{ db: 'khac', query: 'SELECT * FROM jobs WHERE state = $1', ageSec: 3 }] })).findings.find((x) => x.id.startsWith('seq:'))!;
  check(!other.sql!.includes('CREATE INDEX'), 'query đang chạy ở database KHÁC không tính cho bảng này');
}

// ── Đề xuất hướng xử lý ──
{
  const t = table({ heapRead: 25_000, seqScan: 4_000, seqTupRead: 4_000 * 900_000, idxScan: 10, liveTup: 1_000_000 });
  const d = analyzeCacheHit(facts({ tables: [t], trackIoTiming: false, sharedBuffersBytes: 128 * 1024 ** 2,
    statements: [{ db: 'app', query: 'SELECT * FROM orders WHERE customer_id = $1', calls: 9, sharedRead: 25_000, sharedHit: 0 }], statementsTotalRead: 25_000 }));
  const phases = d.plan.map((s) => s.phase);
  const order = { now: 0, restart: 1, long: 2, observe: 3 } as const;
  check(phases.every((p, i) => i === 0 || order[phases[i - 1]] <= order[p]), 'kế hoạch: làm ngay → cần restart → dài hạn → theo dõi');
  check(d.plan[0]?.text.includes('Tạo index (customer_id)'), 'bước đầu tiên là việc hiệu quả nhất, không downtime (tạo index)');
  check(d.plan.some((s) => s.phase === 'restart' && s.text.includes('shared_buffers')), 'tăng shared_buffers xếp vào nhóm cần restart');
  check(d.plan[d.plan.length - 1]?.text.startsWith('Phân tích lại'), 'kết thúc bằng bước đo lại để xác nhận');
  check(d.plan.every((s) => !s.findingId || d.findings.some((x) => x.id === s.findingId)), 'mỗi bước trỏ về đúng kết luận có bằng chứng');
}
{
  const d = analyzeCacheHit(facts({ window: { hit: 9_900, read: 100, sec: 6 } }));
  check(d.plan.length === 1 && d.plan[0].text.startsWith('Không cần xử lý gấp'), 'chuyện cũ → kế hoạch là "không cần xử lý gấp", không bày việc');
}

// ── Thứ tự ──
{
  const d = analyzeCacheHit(facts({ trackIoTiming: false, sharedBuffersBytes: 128 * 1024 ** 2, window: { hit: 7_000, read: 3_000, sec: 6 } }));
  const ranks = d.findings.map((x) => ({ crit: 3, warn: 2, info: 1, ok: 0 })[x.level]);
  check(ranks.every((r, i) => i === 0 || ranks[i - 1] >= r), 'kết luận xếp nặng → nhẹ');
}

if (failures) {
  console.error(`\n${failures} ca hỏng`);
  process.exit(1);
}
console.log('\nTất cả ca đều qua');
