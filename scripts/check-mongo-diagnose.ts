// Kiểm luật lib/mongoDiagnoseRules bằng số liệu giả (thuần, không kết nối MongoDB).
// Chạy: npm run check:mongo-diagnose
import {
  analyzeMongoConnections, analyzeMongoIndexes, analyzeMongoMemory, analyzeMongoQueries, analyzeMongoRepl,
  type MdIndex, type MdMember, type MongoQueryFacts, type MongoMemoryFacts, type MongoReplFacts,
} from '../lib/mongoDiagnoseRules';

let fail = 0;
const check = (cond: boolean, msg: string) => { if (cond) console.log('✓', msg); else { fail++; console.error('✗', msg); } };
const ids = (d: { findings: { id: string }[] }) => d.findings.map((x) => x.id);
const NOW = Date.UTC(2026, 9, 23);
const GB = 1024 ** 3;

// ── Truy vấn ──
const q0: MongoQueryFacts = { sec: 5, scannedKeys: 100, scannedDocs: 100, returnedDocs: 100, collScans: 0, scanAndOrder: 0, queries: 50, queueReaders: 0, queueWriters: 0, ops: [] };
check(ids(analyzeMongoQueries(q0, NOW)).join() === 'ok', 'truy vấn khoẻ → ok');
const q1 = analyzeMongoQueries({
  ...q0, scannedDocs: 500_000, returnedDocs: 200, collScans: 4, scanAndOrder: 3, queueReaders: 12,
  ops: [
    { opid: '1', op: 'query', ns: 'shop.orders', secs: 95, planSummary: 'COLLSCAN', client: '10.0.0.5', appName: 'api', waitingForLock: false, command: '{}' },
    { opid: '2', op: 'update', ns: 'shop.users', secs: 3, planSummary: 'IXSCAN { _id: 1 }', client: '10.0.0.6', appName: '', waitingForLock: true, command: '{}' },
  ],
}, NOW);
const i1 = ids(q1);
check(['scan-ratio', 'collscan', 'scan-and-order', 'long-ops', 'lock-wait', 'queue'].every((x) => i1.includes(x)), `quét thừa + COLLSCAN + sort RAM + op lâu + chờ lock + hàng đợi (${i1.join()})`);
check(q1.findings[0].id === 'long-ops' && q1.findings[0].level === 'crit', 'op 95s → crit, đứng đầu');
check(q1.tables[0].rows[0].tone === 'down', 'bảng op: 95s tô đỏ');
check(ids(analyzeMongoQueries({ ...q0, scannedDocs: 5000, returnedDocs: 2 }, NOW)).join() === 'ok', 'tỉ lệ cao nhưng trả quá ít doc → không kết luận');

// ── Index ──
const ix = (name: string, key: Record<string, unknown>, ops: number | null, extra: Partial<MdIndex> = {}): MdIndex =>
  ({ name, key, ops, since: NOW - 30 * 86400_000, bytes: 200 * 1024 ** 2, unique: false, special: false, keep: false, ...extra });
const d2 = analyzeMongoIndexes({
  totalCollections: 3, notes: [],
  collections: [
    { ns: 'shop.orders', count: 1e6, bytes: 5 * GB, indexes: [ix('_id_', { _id: 1 }, 0), ix('a_1', { a: 1 }, 0), ix('a_1_b_1', { a: 1, b: 1 }, 50), ix('new_1', { n: 1 }, 0, { since: NOW - 3600_000 })] },
    { ns: 'shop.logs', count: 2e6, bytes: 3 * GB, indexes: [ix('_id_', { _id: 1 }, 10)] },
    { ns: 'shop.users', count: 10, bytes: 1000, indexes: [ix('_id_', { _id: 1 }, 5), ix('email_1', { email: 1 }, 0, { unique: true, keep: true }), ix('ttl_1', { at: 1 }, 0, { special: true, keep: true }), ix('old_1', { o: 1 }, 0)] },
  ],
}, NOW);
const i2 = ids(d2);
check(i2.includes('unused') && i2.includes('redundant') && i2.includes('only-id'), `không dùng + thừa + chỉ _id (${i2.join()})`);
const unusedEv = d2.findings.find((x) => x.id === 'unused')!.evidence.join('\n');
check(unusedEv.includes('a_1') && unusedEv.includes('old_1') && !unusedEv.includes('_id_') && !unusedEv.includes('new_1'), 'index không dùng: bỏ _id_, bỏ index mới tạo < 7 ngày');
check(!unusedEv.includes('email_1') && !unusedEv.includes('ttl_1'), 'index unique / TTL không bao giờ bị nêu là không dùng');
check(d2.notes.some((n) => n.includes('< 7 ngày')), 'ghi chú index mới đếm < 7 ngày');
check(!d2.findings.find((x) => x.id === 'redundant')!.evidence.join().includes('email'), 'index unique không bị coi là thừa');

// ── Bộ nhớ ──
const m0: MongoMemoryFacts = { sec: 5, cacheMax: 8 * GB, cacheUsed: 6 * GB, cacheDirty: 0.1 * GB, pagesReadIn: 50, appEvict: 0, tickets: [{ kind: 'read', out: 2, total: 128 }, { kind: 'write', out: 1, total: 128 }], residentBytes: 9 * GB, systemBytes: 16 * GB, indexBytes: 2 * GB, dataBytes: 20 * GB };
check(ids(analyzeMongoMemory(m0, NOW)).join() === 'ok', 'bộ nhớ khoẻ → ok');
const i3 = ids(analyzeMongoMemory({ ...m0, cacheUsed: 7.9 * GB, appEvict: 300, cacheDirty: 1.8 * GB, tickets: [{ kind: 'write', out: 127, total: 128 }], indexBytes: 10 * GB, residentBytes: 15.5 * GB }, NOW));
check(['app-evict', 'dirty', 'tickets-write', 'index-gt-cache', 'resident'].every((x) => i3.includes(x)), `cache đầy tự evict + dirty + hết ticket ghi + index > cache + RAM máy (${i3.join()})`);
check(ids(analyzeMongoMemory({ ...m0, pagesReadIn: 5000 }, NOW)).includes('read-in'), 'đọc vào cache nhiều → read-in');

// ── Replica set ──
const mem = (name: string, state: string, x: Partial<MdMember> = {}): MdMember => ({ name, state, health: true, lagSec: state === 'SECONDARY' ? 0 : null, votes: 1, priority: 1, hidden: false, arbiter: false, electionAt: null, self: false, ...x });
const r0: MongoReplFacts = { set: 'rs0', members: [mem('a', 'PRIMARY'), mem('b', 'SECONDARY'), mem('c', 'SECONDARY')], oplogWindowSec: 72 * 3600, oplogBytes: GB, oplogMaxBytes: 2 * GB };
check(ids(analyzeMongoRepl(r0, NOW)).join() === 'ok', 'replica set khoẻ → ok');
check(ids(analyzeMongoRepl({ set: null, members: [], oplogWindowSec: null, oplogBytes: null, oplogMaxBytes: null }, NOW)).join() === 'standalone', 'standalone → chỉ báo thông tin');
const i4 = ids(analyzeMongoRepl({ ...r0, members: [mem('a', 'PRIMARY'), mem('b', 'SECONDARY', { lagSec: 3 * 3600 }), mem('c', '(not reachable/healthy)', { health: false })], oplogWindowSec: 4 * 3600 }, NOW));
check(['unhealthy', 'lag', 'lag-vs-oplog', 'oplog-window'].every((x) => i4.includes(x)), `member hỏng + lag + lag quá nửa oplog + oplog ngắn (${i4.join()})`);
check(ids(analyzeMongoRepl({ ...r0, members: [mem('a', 'SECONDARY'), mem('b', 'SECONDARY'), mem('c', 'SECONDARY'), mem('d', 'SECONDARY')] }, NOW)).includes('no-primary'), 'không có primary → no-primary');
check(ids(analyzeMongoRepl({ ...r0, members: [...r0.members, mem('d', 'SECONDARY')] }, NOW)).includes('even-voters'), '4 member bỏ phiếu → even-voters');

// ── Kết nối ──
const i5 = ids(analyzeMongoConnections({ sec: 5, current: 900, available: 100, active: 20, createdPerSec: 40, byClient: [{ host: '10.0.0.5', app: 'api', count: 700, active: 10 }, { host: '10.0.0.6', app: 'job', count: 200, active: 10 }] }, NOW));
check(['conn-used', 'churn', 'one-host', 'idle'].every((x) => i5.includes(x)), `90% + mở/đóng dồn + một máy giữ nhiều + rảnh (${i5.join()})`);
check(ids(analyzeMongoConnections({ sec: 5, current: 50, available: 50_000, active: 5, createdPerSec: 1, byClient: null }, NOW)).join() === 'ok', 'kết nối khoẻ → ok');

if (fail) { console.error(`\n${fail} ca hỏng`); process.exit(1); }
console.log('\nTất cả ca đều qua');
