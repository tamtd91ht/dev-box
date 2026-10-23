// Server-only: phân tích MongoDB (tab Phân tích) — phần GOM SỐ LIỆU.
//
// AN TOÀN CHO PRODUCTION — chỉ lệnh ĐỌC thống kê, mọi lệnh có maxTimeMS:
//   • serverStatus hai lần cách SAMPLE_SEC giây (cùng lệnh tab Tổng quan gọi mỗi 30s)
//     → tốc độ quét / trả, collection scan, đọc vào cache, kết nối mới mỗi giây.
//   • $currentOp lọc ngay trên server (active, ≥ 1s, $limit) — không kill gì. Gom kết
//     nối theo máy / app chỉ khi ≤ CONN_GROUP_MAX kết nối (O(số kết nối)).
//   • hostInfo, dbStats từng db (tối đa DB_MAX), replSetGetStatus / replSetGetConfig.
//   • Oplog: đọc ĐÚNG một bản ghi đầu và một bản ghi cuối theo $natural (không quét).
//   • $indexStats + $collStats từng collection, tối đa COLL_MAX collection,
//     nghỉ COLL_PAUSE_MS giữa các collection, trần INDEX_TIME_MS cho cả lượt.
// Không ghi, không bật profiler, không đổi cấu hình, không kill op.
// Luật biến số liệu thành kết luận nằm ở lib/mongoDiagnoseRules (thuần, kiểm được).

import type { Document, MongoClient } from 'mongodb';
import type { MongoConnection } from '@/lib/mongoConnections';
import { diagnoseClient } from '@/lib/mongoClient';
import { clampLongRunningSec, type LongRunningResult } from '@/lib/diagnose';
import {
  analyzeMongoConnections, analyzeMongoIndexes, analyzeMongoMemory, analyzeMongoQueries, analyzeMongoRepl,
  type MdCollection, type MdIndex, type MdMember, type MdOp, type MongoDiagKind, type MongoDiagnosis,
} from '@/lib/mongoDiagnoseRules';

const SAMPLE_SEC = 5;
const MAX_TIME_MS = 10_000;
const OPS_LIMIT = 30;
const CONN_GROUP_MAX = 5_000;
const DB_MAX = 50;
const COLL_MAX = 300;
const COLL_PAUSE_MS = 20;
const INDEX_TIME_MS = 25_000;
const SYSTEM_DBS = new Set(['admin', 'local', 'config']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
const path = (o: Document | undefined, p: string): unknown => p.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Document)[k] : undefined), o);
const adminCmd = (c: MongoClient, cmd: Document) => c.db('admin').command({ ...cmd, maxTimeMS: MAX_TIME_MS });

export async function diagnoseMongo(conn: MongoConnection, kind: MongoDiagKind): Promise<MongoDiagnosis> {
  const client = await diagnoseClient(conn);
  switch (kind) {
    case 'queries': return queries(client);
    case 'indexes': return indexes(client);
    case 'memory': return memory(client);
    case 'repl': return repl(client);
    case 'connections': return connections(client);
    default: throw new Error(`Không có mục phân tích "${String(kind)}"`);
  }
}

/** serverStatus hai lần → hàm lấy tốc độ mỗi giây của một đường dẫn số. */
async function twoStatus(client: MongoClient) {
  const a = await adminCmd(client, { serverStatus: 1 });
  const t0 = Date.now();
  await sleep(SAMPLE_SEC * 1000);
  const b = await adminCmd(client, { serverStatus: 1 });
  const sec = Math.max(0.001, (Date.now() - t0) / 1000);
  const rate = (p: string) => Math.max(0, num(path(b, p)) - num(path(a, p))) / sec;
  const rateOrNull = (p: string) => (path(b, p) === undefined ? null : rate(p));
  return { a, b, sec: Math.round(sec), rate, rateOrNull };
}

// ── 1. Hiệu năng truy vấn ──

async function queries(client: MongoClient): Promise<MongoDiagnosis> {
  const s = await twoStatus(client);
  let ops: MdOp[] | null = null;
  let opsError: string | undefined;
  try {
    const rows = await client.db('admin').aggregate([
      { $currentOp: { allUsers: true, idleConnections: false } },
      {
        $match: {
          active: true, secs_running: { $gte: 1 }, op: { $ne: 'none' },
          // Bỏ việc nội bộ chạy dài theo thiết kế: replication đọc oplog, change stream / tailable cursor, hello.
          $nor: [{ ns: /^local\./ }, { 'cursor.tailable': true }, { 'command.hello': { $exists: true } }, { 'command.isMaster': { $exists: true } }, { 'command.getMore': { $exists: true }, 'cursor.awaitData': true }],
        },
      },
      { $sort: { secs_running: -1 } },
      { $limit: OPS_LIMIT },
      { $project: { opid: 1, op: 1, ns: 1, secs_running: 1, planSummary: 1, client: 1, appName: 1, waitingForLock: 1, command: 1 } },
    ], { maxTimeMS: MAX_TIME_MS }).toArray();
    ops = rows.map((r) => ({
      opid: String(r.opid ?? ''),
      op: String(r.op ?? ''),
      ns: String(r.ns ?? ''),
      secs: num(r.secs_running),
      planSummary: String(r.planSummary ?? ''),
      client: String(r.client ?? '').replace(/:\d+$/, ''),
      appName: String(r.appName ?? ''),
      waitingForLock: r.waitingForLock === true,
      command: JSON.stringify(r.command ?? {}).slice(0, 300),
    }));
  } catch (e) {
    opsError = (e as Error).message;
  }
  return analyzeMongoQueries({
    sec: s.sec,
    scannedKeys: s.rate('metrics.queryExecutor.scanned'),
    scannedDocs: s.rate('metrics.queryExecutor.scannedObjects'),
    returnedDocs: s.rate('metrics.document.returned'),
    collScans: s.rateOrNull('metrics.queryExecutor.collectionScans.total'),
    scanAndOrder: s.rate('metrics.operation.scanAndOrder'),
    queries: s.rate('opcounters.query'),
    queueReaders: num(path(s.b, 'globalLock.currentQueue.readers')),
    queueWriters: num(path(s.b, 'globalLock.currentQueue.writers')),
    ops,
    opsError,
  });
}

// ── 2. Index ──

async function indexes(client: MongoClient): Promise<MongoDiagnosis> {
  const notes: string[] = [];
  const deadline = Date.now() + INDEX_TIME_MS;
  const dbs = ((await adminCmd(client, { listDatabases: 1, nameOnly: true })).databases as Document[])
    .map((d) => String(d.name)).filter((n) => !SYSTEM_DBS.has(n)).slice(0, DB_MAX);

  // Danh sách collection (không view / system.*), xét lần lượt tới COLL_MAX.
  const all: { db: string; coll: string }[] = [];
  for (const db of dbs) {
    const cs = await client.db(db).listCollections({ type: 'collection' }, { nameOnly: true }).toArray();
    for (const c of cs) if (!String(c.name).startsWith('system.')) all.push({ db, coll: String(c.name) });
  }

  const collections: MdCollection[] = [];
  for (const { db, coll } of all) {
    if (collections.length >= COLL_MAX) break;
    if (Date.now() > deadline) { notes.push(`Hết ${INDEX_TIME_MS / 1000}s — dừng ở ${collections.length} collection`); break; }
    try {
      const c = client.db(db).collection(coll);
      const [st] = await c.aggregate([{ $collStats: { storageStats: {} } }, { $project: { 'storageStats.count': 1, 'storageStats.size': 1, 'storageStats.indexSizes': 1 } }], { maxTimeMS: MAX_TIME_MS }).toArray();
      const sizes = (path(st, 'storageStats.indexSizes') ?? {}) as Record<string, number>;
      const listed = await c.listIndexes().toArray();
      let usage = new Map<string, { ops: number; since: number | null }>();
      try {
        const rows = await c.aggregate([{ $indexStats: {} }, { $project: { name: 1, 'accesses.ops': 1, 'accesses.since': 1 } }], { maxTimeMS: MAX_TIME_MS }).toArray();
        usage = new Map(rows.map((r) => [String(r.name), { ops: num(path(r, 'accesses.ops')), since: r.accesses?.since ? new Date(r.accesses.since).getTime() : null }]));
      } catch (e) {
        if (!notes.some((n) => n.startsWith('$indexStats'))) notes.push(`$indexStats lỗi (${(e as Error).message}) — không xét index không dùng`);
      }
      const ixs: MdIndex[] = listed.map((ix) => {
        const key = (ix.key ?? {}) as Record<string, unknown>;
        const u = usage.get(String(ix.name));
        return {
          name: String(ix.name),
          key,
          ops: u ? u.ops : null,
          since: u?.since ?? null,
          bytes: numOrNull(sizes[String(ix.name)]),
          unique: ix.unique === true,
          special: !!(ix.partialFilterExpression || ix.sparse || ix.expireAfterSeconds !== undefined || ix.hidden
            || Object.values(key).some((v) => typeof v === 'string')),
          keep: ix.unique === true || ix.expireAfterSeconds !== undefined || ix.hidden === true,
        };
      });
      collections.push({ ns: `${db}.${coll}`, count: num(path(st, 'storageStats.count')), bytes: num(path(st, 'storageStats.size')), indexes: ixs });
    } catch (e) {
      if (notes.length < 5) notes.push(`${db}.${coll}: ${(e as Error).message}`);
    }
    await sleep(COLL_PAUSE_MS);
  }
  return analyzeMongoIndexes({ collections, totalCollections: all.length, notes });
}

// ── 3. RAM & WiredTiger cache ──

async function memory(client: MongoClient): Promise<MongoDiagnosis> {
  const s = await twoStatus(client);
  const cache = 'wiredTiger.cache';
  const appEvictKey = ['pages evicted by application threads', 'application threads page eviction count']
    .find((k) => path(s.b, cache) && (path(s.b, cache) as Document)[k] !== undefined);
  const wtRate = (k: string) => {
    const a = num((path(s.a, cache) as Document | undefined)?.[k]);
    const b = num((path(s.b, cache) as Document | undefined)?.[k]);
    return Math.max(0, b - a) / Math.max(1, s.sec);
  };
  const wt = (k: string) => num((path(s.b, cache) as Document | undefined)?.[k]);

  // Ticket: ≥ 7.0 ở queues.execution, bản cũ ở wiredTiger.concurrentTransactions.
  const tickets = (['read', 'write'] as const).flatMap((kind) => {
    const q = (path(s.b, `queues.execution.${kind}`) ?? path(s.b, `wiredTiger.concurrentTransactions.${kind}`)) as Document | undefined;
    return q ? [{ kind, out: num(q.out), total: num(q.totalTickets) }] : [];
  });

  const host = await adminCmd(client, { hostInfo: 1 }).catch(() => null);
  let indexBytes: number | null = 0;
  let dataBytes: number | null = 0;
  try {
    const dbs = ((await adminCmd(client, { listDatabases: 1, nameOnly: true })).databases as Document[])
      .map((d) => String(d.name)).filter((n) => !SYSTEM_DBS.has(n)).slice(0, DB_MAX);
    for (const db of dbs) {
      const st = await client.db(db).command({ dbStats: 1, maxTimeMS: MAX_TIME_MS });
      indexBytes += num(st.indexSize);
      dataBytes += num(st.dataSize);
    }
  } catch {
    indexBytes = null;
    dataBytes = null;
  }

  return analyzeMongoMemory({
    sec: s.sec,
    cacheMax: wt('maximum bytes configured'),
    cacheUsed: wt('bytes currently in the cache'),
    cacheDirty: wt('tracked dirty bytes in the cache'),
    pagesReadIn: wtRate('pages read into cache'),
    appEvict: appEvictKey ? wtRate(appEvictKey) : null,
    tickets,
    residentBytes: num(path(s.b, 'mem.resident')) * 1024 * 1024,
    systemBytes: host ? num(path(host, 'system.memSizeMB')) * 1024 * 1024 || null : null,
    indexBytes,
    dataBytes,
  });
}

// ── 4. Replica set & oplog ──

async function repl(client: MongoClient): Promise<MongoDiagnosis> {
  let st: Document;
  try {
    st = await adminCmd(client, { replSetGetStatus: 1 });
  } catch (e) {
    return analyzeMongoRepl({ set: null, members: [], oplogWindowSec: null, oplogBytes: null, oplogMaxBytes: null, error: (e as Error).message });
  }
  const cfg = await adminCmd(client, { replSetGetConfig: 1 }).then((r) => r.config as Document).catch(() => null);
  const cfgOf = new Map(((cfg?.members ?? []) as Document[]).map((m) => [String(m.host), m]));
  const rows = (st.members ?? []) as Document[];
  const primary = rows.find((m) => m.stateStr === 'PRIMARY');
  const pOpt = primary?.optimeDate ? new Date(primary.optimeDate).getTime() : null;
  const members: MdMember[] = rows.map((m) => {
    const c = cfgOf.get(String(m.name));
    const opt = m.optimeDate ? new Date(m.optimeDate).getTime() : null;
    return {
      name: String(m.name),
      state: String(m.stateStr ?? '?'),
      health: num(m.health) === 1,
      lagSec: m.stateStr === 'SECONDARY' && pOpt !== null && opt !== null ? Math.max(0, Math.round((pOpt - opt) / 1000)) : null,
      votes: c ? num(c.votes ?? 1) : 1,
      priority: c ? num(c.priority ?? 1) : 1,
      hidden: c?.hidden === true,
      arbiter: c?.arbiterOnly === true || m.stateStr === 'ARBITER',
      electionAt: m.electionDate ? new Date(m.electionDate).getTime() : null,
      self: m.self === true,
    };
  });

  // Cửa sổ oplog: đúng một bản ghi đầu + một bản ghi cuối theo thứ tự tự nhiên.
  let oplogWindowSec: number | null = null;
  let oplogBytes: number | null = null;
  let oplogMaxBytes: number | null = null;
  try {
    const oplog = client.db('local').collection('oplog.rs');
    const [first] = await oplog.find({}, { projection: { ts: 1 }, sort: { $natural: 1 }, limit: 1, maxTimeMS: MAX_TIME_MS }).toArray();
    const [last] = await oplog.find({}, { projection: { ts: 1 }, sort: { $natural: -1 }, limit: 1, maxTimeMS: MAX_TIME_MS }).toArray();
    const sec = (d: Document | undefined) => (d?.ts && typeof d.ts.getHighBits === 'function' ? d.ts.getHighBits() : null);
    if (sec(first) !== null && sec(last) !== null) oplogWindowSec = Math.max(0, sec(last)! - sec(first)!);
    const [cs] = await oplog.aggregate([{ $collStats: { storageStats: {} } }, { $project: { 'storageStats.size': 1, 'storageStats.maxSize': 1 } }], { maxTimeMS: MAX_TIME_MS }).toArray();
    oplogBytes = numOrNull(path(cs, 'storageStats.size'));
    oplogMaxBytes = numOrNull(path(cs, 'storageStats.maxSize'));
  } catch { /* thiếu quyền đọc local — bỏ phần oplog */ }

  return analyzeMongoRepl({ set: String(st.set ?? ''), members, oplogWindowSec, oplogBytes, oplogMaxBytes });
}

// ── 5. Kết nối ──

async function connections(client: MongoClient): Promise<MongoDiagnosis> {
  const s = await twoStatus(client);
  const current = num(path(s.b, 'connections.current'));
  let byClient: { host: string; app: string; count: number; active: number }[] | null = null;
  let byClientNote: string | undefined;
  if (current > CONN_GROUP_MAX) {
    byClientNote = `${current} kết nối — không gom theo máy / app (> ${CONN_GROUP_MAX}) để không thêm tải`;
  } else {
    try {
      const rows = await client.db('admin').aggregate([
        { $currentOp: { allUsers: true, idleConnections: true } },
        { $match: { client: { $exists: true } } },
        { $group: { _id: { host: { $arrayElemAt: [{ $split: ['$client', ':'] }, 0] }, app: { $ifNull: ['$appName', ''] } }, count: { $sum: 1 }, active: { $sum: { $cond: ['$active', 1, 0] } } } },
        { $sort: { count: -1 } },
        { $limit: 30 },
      ], { maxTimeMS: MAX_TIME_MS }).toArray();
      byClient = rows.map((r) => ({ host: String(r._id?.host ?? '?'), app: String(r._id?.app ?? ''), count: num(r.count), active: num(r.active) }));
    } catch (e) {
      byClientNote = `Không gom được theo máy / app: ${(e as Error).message} (cần quyền inprog)`;
    }
  }
  return analyzeMongoConnections({
    sec: s.sec,
    current,
    available: num(path(s.b, 'connections.available')),
    active: numOrNull(path(s.b, 'connections.active')),
    createdPerSec: s.rate('connections.totalCreated'),
    byClient,
    byClientNote,
  });
}

// ── Thao tác đang chạy lâu hơn N giây (mục riêng, không chờ serverStatus) ──
// Một lệnh $currentOp, lọc + sắp + cắt ngay trên server — rẻ, không khoá gì.

const LONG_ROWS_MAX = 100;

export async function mongoLongRunning(conn: MongoConnection, minSecIn: unknown): Promise<LongRunningResult> {
  const minSec = clampLongRunningSec(minSecIn);
  const client = await diagnoseClient(conn);
  const notes: string[] = [];
  let rows: Document[] = [];
  try {
    rows = await client.db('admin').aggregate([
      { $currentOp: { allUsers: true, idleConnections: false } },
      {
        $match: {
          active: true, op: { $ne: 'none' }, microsecs_running: { $gte: Math.round(minSec * 1e6) },
          // Việc nội bộ chạy dài theo thiết kế: replication đọc oplog, change stream / tailable cursor, hello.
          $nor: [{ ns: /^local\./ }, { 'cursor.tailable': true }, { 'command.hello': { $exists: true } }, { 'command.isMaster': { $exists: true } }, { 'command.getMore': { $exists: true }, 'cursor.awaitData': true }],
        },
      },
      { $sort: { microsecs_running: -1 } },
      { $limit: LONG_ROWS_MAX + 1 },
      { $project: { opid: 1, op: 1, ns: 1, microsecs_running: 1, planSummary: 1, client: 1, appName: 1, waitingForLock: 1, command: 1, desc: 1 } },
    ], { maxTimeMS: MAX_TIME_MS }).toArray();
  } catch (e) {
    notes.push(`Không đọc được $currentOp: ${(e as Error).message} (cần quyền inprog)`);
  }
  if (rows.length > LONG_ROWS_MAX) notes.push(`Hơn ${LONG_ROWS_MAX} thao tác — chỉ hiện ${LONG_ROWS_MAX} lâu nhất`);
  const show = rows.slice(0, LONG_ROWS_MAX);
  return {
    at: Date.now(),
    minSec,
    notes,
    tables: [{
      title: `Thao tác đang chạy ≥ ${minSec}s (${rows.length > LONG_ROWS_MAX ? `> ${LONG_ROWS_MAX}` : rows.length})`,
      note: 'Bỏ việc nội bộ chạy dài theo thiết kế (replication, change stream). Dừng (nếu chắc chắn): db.killOp(<opid>)',
      columns: ['Giây', 'Loại', 'Namespace', 'Plan', 'Client', 'opid', 'Lệnh'],
      right: [0],
      code: [5, 6],
      total: show.length,
      rows: show.map((r) => {
        const sec = num(r.microsecs_running) / 1e6;
        return {
          cells: [
            String(sec >= 100 ? Math.round(sec) : Math.round(sec * 10) / 10),
            `${String(r.op ?? '')}${r.waitingForLock === true ? ' · chờ lock' : ''}`,
            String(r.ns ?? ''),
            String(r.planSummary ?? ''),
            `${String(r.client ?? '').replace(/:\d+$/, '')}${r.appName ? ` (${String(r.appName)})` : ''}`,
            String(r.opid ?? ''),
            JSON.stringify(r.command ?? {}).slice(0, 1000),
          ],
          tone: sec >= 60 || r.waitingForLock === true ? 'down' as const : sec >= 30 || /COLLSCAN/.test(String(r.planSummary ?? '')) ? 'warn' as const : undefined,
        };
      }),
    }],
  };
}
