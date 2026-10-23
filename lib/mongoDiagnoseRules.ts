// Phân tích MongoDB (tab Phân tích của từng kết nối Mongo) — phần LUẬT thuần.
//
// Số liệu do lib/mongoDiagnose.ts gom (chỉ đọc thống kê). File này biến chúng thành
// kết luận có bằng chứng + cách xử lý, theo năm mục:
//   • queries     — hiệu năng truy vấn: quét / trả, collection scan, sort trong RAM,
//                   op đang chạy lâu, chờ lock, hàng đợi.
//   • indexes     — index không dùng, index thừa (tiền tố của index khác), collection
//                   lớn chỉ có _id.
//   • memory      — WiredTiger cache đầy / dirty, luồng ứng dụng phải tự evict, đọc
//                   đĩa, ticket, index không vừa cache, RAM máy.
//   • repl        — member hỏng, không có primary, lag, cửa sổ oplog, cấu hình bỏ phiếu.
//   • connections — % kết nối đã dùng, kết nối mới mỗi giây, theo máy / app.
// Thuần (không I/O) để kiểm bằng script (check:mongo-diagnose) và để client import kiểu.

import { buildPlan, fmtBytes, fmtN, fmtSec, sortFindings, type Finding, type PlanStep } from '@/lib/diagnose';

export type MongoDiagKind = 'queries' | 'indexes' | 'memory' | 'repl' | 'connections';

/** Bảng chung để một UI hiển thị được mọi mục. */
export interface MdTable {
  title: string;
  columns: string[];
  /** Cột căn phải (số). */
  right?: number[];
  rows: { cells: string[]; tone?: 'warn' | 'down' }[];
}

export interface MongoDiagnosis {
  kind: MongoDiagKind;
  at: number;
  headline: string;
  findings: Finding[];
  plan: PlanStep[];
  /** Dòng số liệu dưới câu kết luận. */
  nums: string[];
  tables: MdTable[];
  /** Ghi chú về giới hạn của lần đo (thiếu quyền, bỏ bớt…). */
  notes: string[];
}

const done = (kind: MongoDiagKind, at: number, headline: string, out: Finding[], recheck: string, nums: string[], tables: MdTable[], notes: string[]): MongoDiagnosis => {
  const findings = sortFindings(out);
  return { kind, at, headline: headline || findings[0]?.title || '', findings, plan: buildPlan(findings, recheck), nums, tables, notes };
};
const ok = (id: string, title: string, evidence: string[]): Finding => ({ id, level: 'ok', title, evidence });
const hasIssue = (xs: Finding[]) => xs.some((x) => x.level === 'crit' || x.level === 'warn');
const r1 = (n: number) => Math.round(n * 10) / 10;

// ── 1. Hiệu năng truy vấn ───────────────────────────────────────────────────

export interface MdOp {
  opid: string;
  op: string;
  ns: string;
  secs: number;
  planSummary: string;
  client: string;
  appName: string;
  waitingForLock: boolean;
  /** Lệnh / filter rút gọn (đã cắt). */
  command: string;
}

export interface MongoQueryFacts {
  sec: number;
  /** Mỗi giây, trong cửa sổ đo. */
  scannedKeys: number;
  scannedDocs: number;
  returnedDocs: number;
  collScans: number | null;
  scanAndOrder: number;
  queries: number;
  /** globalLock.currentQueue lúc đo. */
  queueReaders: number;
  queueWriters: number;
  ops: MdOp[] | null;
  opsError?: string;
}

const SCAN_RATIO_WARN = 100;
const SCAN_MIN_RETURNED = 10;
const COLLSCAN_WARN = 1;
const SORT_WARN = 1;
const OP_WARN_SEC = 10;
const OP_CRIT_SEC = 60;
const QUEUE_WARN = 10;

export function analyzeMongoQueries(f: MongoQueryFacts, at = Date.now()): MongoDiagnosis {
  const out: Finding[] = [];
  const ratio = f.returnedDocs > 0 ? f.scannedDocs / f.returnedDocs : null;
  const ops = f.ops ?? [];
  const collscanOps = ops.filter((o) => /COLLSCAN/.test(o.planSummary));

  if (ratio !== null && ratio >= SCAN_RATIO_WARN && f.returnedDocs >= SCAN_MIN_RETURNED) {
    out.push({
      id: 'scan-ratio',
      level: 'warn',
      title: `Quét ${fmtN(ratio)} document để trả về 1 — truy vấn đang thiếu index phù hợp`,
      evidence: [`${fmtN(f.scannedDocs)} doc quét/s · ${fmtN(f.returnedDocs)} doc trả/s · ${fmtN(f.scannedKeys)} key index quét/s (đo ${f.sec}s)`],
      fix: 'Tìm truy vấn quét nhiều (bảng op đang chạy, hoặc bật profiler / xem log slow query), chạy explain("executionStats") và thêm index khớp filter + sort (thứ tự: so bằng → sort → khoảng).',
      sql: 'db.<coll>.find({ … }).explain("executionStats")   // so totalDocsExamined với nReturned',
      step: { phase: 'now', text: 'Tìm truy vấn quét nhiều doc và thêm index khớp filter + sort' },
    });
  }
  if (f.collScans !== null && f.collScans >= COLLSCAN_WARN) {
    out.push({
      id: 'collscan',
      level: 'warn',
      title: `${r1(f.collScans)} collection scan mỗi giây — truy vấn đọc toàn bộ collection`,
      evidence: [
        `metrics.queryExecutor.collectionScans trong ${f.sec}s`,
        ...(collscanOps.length ? [`Đang chạy: ${collscanOps.slice(0, 5).map((o) => `${o.ns} (${o.secs}s)`).join(', ')}`] : []),
      ],
      fix: 'Collection nhỏ thì COLLSCAN vô hại; collection lớn thì cần index cho field lọc. Đặt notablescan chỉ trên môi trường test để bắt truy vấn thiếu index.',
      step: { phase: 'now', text: 'Thêm index cho các truy vấn đang collection scan trên collection lớn' },
    });
  }
  if (f.scanAndOrder >= SORT_WARN) {
    out.push({
      id: 'scan-and-order',
      level: 'info',
      title: `${r1(f.scanAndOrder)} truy vấn/giây phải sort trong RAM (không dùng được index để sort)`,
      evidence: ['metrics.operation.scanAndOrder — sort trong RAM giới hạn 100MB, vượt là lỗi (hoặc phải ghi đĩa với allowDiskUse)'],
      fix: 'Thêm field sort vào cuối index (sau các field so bằng) để index trả đúng thứ tự.',
      step: { phase: 'long', text: 'Cho field sort vào index để bỏ sort trong RAM' },
    });
  }
  const long = ops.filter((o) => o.secs >= OP_WARN_SEC);
  if (long.length) {
    const worst = long[0];
    out.push({
      id: 'long-ops',
      level: worst.secs >= OP_CRIT_SEC ? 'crit' : 'warn',
      title: `${long.length} thao tác đang chạy lâu — lâu nhất ${fmtSec(worst.secs)} trên ${worst.ns || '?'}`,
      evidence: long.slice(0, 5).map((o) => `${o.op} ${o.ns} · ${fmtSec(o.secs)} · ${o.planSummary || '—'}${o.client ? ` · ${o.client}` : ''}${o.appName ? ` (${o.appName})` : ''}`),
      fix: 'Xem bảng bên dưới: COLLSCAN → thiếu index; op ghi lâu → update/delete nhiều doc theo filter không có index. Chỉ kill khi chắc chắn op đó không quan trọng — app không tự kill.',
      sql: `db.currentOp({ opid: ${JSON.stringify(worst.opid)} })\n// nếu chắc chắn: db.killOp(${JSON.stringify(worst.opid)})`,
      step: { phase: 'now', text: `Xem op chạy lâu nhất (${fmtSec(worst.secs)}, ${worst.ns}) — thiếu index hay quét quá rộng` },
    });
  }
  const waiting = ops.filter((o) => o.waitingForLock);
  if (waiting.length) {
    out.push({
      id: 'lock-wait',
      level: 'warn',
      title: `${waiting.length} thao tác đang chờ lock`,
      evidence: waiting.slice(0, 5).map((o) => `${o.op} ${o.ns} · ${fmtSec(o.secs)}`),
      fix: 'Thường do một thao tác giữ lock mức collection / database (build index foreground ở bản cũ, collMod, drop…) hoặc ghi dồn vào một document. Tìm op đang giữ lock trong bảng.',
      step: { phase: 'now', text: 'Tìm thao tác đang giữ lock khiến các op khác phải chờ' },
    });
  }
  const queue = f.queueReaders + f.queueWriters;
  if (queue >= QUEUE_WARN) {
    out.push({
      id: 'queue',
      level: 'warn',
      title: `${queue} thao tác đang xếp hàng chờ (globalLock.currentQueue)`,
      evidence: [`đọc ${f.queueReaders} · ghi ${f.queueWriters}`],
      fix: 'Server không xử lý kịp — xem thêm mục "RAM & WiredTiger cache" (ticket, cache) và các op chạy lâu.',
      step: { phase: 'now', text: 'Giảm tải: xử lý op chạy lâu / truy vấn thiếu index trước' },
    });
  }
  if (!hasIssue(out)) out.push(ok('ok', 'Truy vấn ổn — không thấy quét thừa, collection scan hay op chạy lâu', [`${fmtN(f.queries)} query/s trong ${f.sec}s`]));

  const notes: string[] = [];
  if (f.opsError) notes.push(`Không đọc được $currentOp: ${f.opsError} (cần quyền inprog)`);
  if (f.collScans === null) notes.push('Bản MongoDB này không có metrics.queryExecutor.collectionScans (< 4.4)');
  return done('queries', at, '', out, 'Phân tích lại sau khi thêm index để xác nhận tỉ lệ quét / trả đã giảm',
    [
      `${fmtN(f.queries)} query/s`,
      `quét ${fmtN(f.scannedDocs)} doc/s → trả ${fmtN(f.returnedDocs)} doc/s${ratio !== null ? ` (${fmtN(ratio)}:1)` : ''}`,
      f.collScans !== null ? `${r1(f.collScans)} COLLSCAN/s` : '',
      `hàng đợi ${queue}`,
    ].filter(Boolean),
    ops.length ? [{
      title: `Thao tác đang chạy ≥ 1s (${ops.length})`,
      columns: ['Giây', 'Loại', 'Namespace', 'Plan', 'Client', 'Lệnh'],
      right: [0],
      rows: ops.map((o) => ({
        cells: [String(o.secs), `${o.op}${o.waitingForLock ? ' · chờ lock' : ''}`, o.ns, o.planSummary || '—', `${o.client}${o.appName ? ` (${o.appName})` : ''}`, o.command],
        tone: o.secs >= OP_CRIT_SEC ? 'down' : o.secs >= OP_WARN_SEC || o.waitingForLock || /COLLSCAN/.test(o.planSummary) ? 'warn' : undefined,
      })),
    }] : [],
    notes);
}

// ── 2. Index ────────────────────────────────────────────────────────────────

export interface MdIndex {
  name: string;
  key: Record<string, unknown>;
  /** null = không đọc được $indexStats. */
  ops: number | null;
  /** Thời điểm bắt đầu đếm (restart / tạo index). */
  since: number | null;
  bytes: number | null;
  unique: boolean;
  /** partial / sparse / TTL / text / hashed / 2dsphere — không xét "thừa". */
  special: boolean;
  /**
   * Index vẫn làm việc dù không phục vụ truy vấn đọc nào — unique (giữ ràng buộc), TTL
   * (tự xoá doc hết hạn), hidden (đang ẩn có chủ đích). $indexStats của chúng có thể là
   * 0 mà drop đi là hỏng → không bao giờ nêu là "không dùng".
   */
  keep: boolean;
}

export interface MdCollection {
  ns: string;
  count: number;
  bytes: number;
  indexes: MdIndex[];
}

export interface MongoIndexFacts {
  collections: MdCollection[];
  /** Số collection có trong cụm (trước khi giới hạn). */
  totalCollections: number;
  notes: string[];
}

const UNUSED_MIN_AGE_MS = 7 * 24 * 3600 * 1000;
const UNUSED_BIG = 1024 ** 3;
const ONLY_ID_MIN_DOCS = 100_000;
const MANY_INDEXES = 15;
const LIST_TOP = 20;

const keyStr = (k: Record<string, unknown>) => Object.entries(k).map(([f, d]) => `${f}:${d}`).join(', ');
/** a là tiền tố của b (cùng field, cùng chiều, a ngắn hơn). */
const isPrefix = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ea = Object.entries(a);
  const eb = Object.entries(b);
  return ea.length < eb.length && ea.every(([f, d], i) => eb[i][0] === f && String(eb[i][1]) === String(d));
};

export function analyzeMongoIndexes(f: MongoIndexFacts, at = Date.now()): MongoDiagnosis {
  const out: Finding[] = [];
  const unused: { ns: string; ix: MdIndex }[] = [];
  const young: { ns: string; ix: MdIndex }[] = [];
  const redundant: { ns: string; ix: MdIndex; by: MdIndex }[] = [];
  for (const c of f.collections) {
    for (const ix of c.indexes) {
      if (ix.name === '_id_' || ix.keep || ix.ops === null || ix.ops > 0) continue;
      if (ix.since !== null && at - ix.since < UNUSED_MIN_AGE_MS) young.push({ ns: c.ns, ix });
      else unused.push({ ns: c.ns, ix });
    }
    for (const a of c.indexes) {
      if (a.name === '_id_' || a.unique || a.special) continue;
      const by = c.indexes.find((b) => b !== a && !b.special && isPrefix(a.key, b.key));
      if (by) redundant.push({ ns: c.ns, ix: a, by });
    }
  }
  unused.sort((a, b) => (b.ix.bytes ?? 0) - (a.ix.bytes ?? 0));
  const unusedBytes = unused.reduce((s, x) => s + (x.ix.bytes ?? 0), 0);
  if (unused.length) {
    out.push({
      id: 'unused',
      level: unusedBytes >= UNUSED_BIG ? 'warn' : 'info',
      title: `${unused.length} index không được dùng lần nào (≥ 7 ngày) — tốn ${fmtBytes(unusedBytes)} RAM/đĩa và làm chậm mọi lần ghi`,
      evidence: [
        ...unused.slice(0, LIST_TOP).map((x) => `${x.ns} · ${x.ix.name} {${keyStr(x.ix.key)}} · ${fmtBytes(x.ix.bytes)}`),
        '$indexStats chỉ đếm trên node đang kết nối, từ lần restart gần nhất — index chỉ dùng trên secondary (đọc analytics) hoặc theo mùa vẫn hiện là 0',
        'Đã loại index unique / TTL / đang ẩn — chúng vẫn làm việc dù không phục vụ truy vấn đọc',
      ],
      fix: 'Xác nhận với đội ứng dụng rồi ẩn thử trước (hideIndex — bỏ ẩn lại ngay được, không phải build lại), theo dõi vài ngày rồi mới drop.',
      sql: unused[0] ? `db.getSiblingDB("${unused[0].ns.split('.')[0]}").getCollection("${unused[0].ns.split('.').slice(1).join('.')}").hideIndex("${unused[0].ix.name}")` : undefined,
      step: { phase: 'long', text: `Ẩn thử rồi bỏ ${unused.length} index không dùng (${fmtBytes(unusedBytes)})` },
    });
  }
  if (redundant.length) {
    out.push({
      id: 'redundant',
      level: 'info',
      title: `${redundant.length} index thừa — là tiền tố của một index khác trên cùng collection`,
      evidence: redundant.slice(0, LIST_TOP).map((x) => `${x.ns} · ${x.ix.name} {${keyStr(x.ix.key)}} ⊂ ${x.by.name} {${keyStr(x.by.key)}}`),
      fix: 'Index dài hơn phục vụ được mọi truy vấn của index tiền tố (trừ khi tiền tố unique / partial). Ẩn thử rồi drop index ngắn.',
      step: { phase: 'long', text: 'Bỏ index là tiền tố của index khác' },
    });
  }
  const onlyId = f.collections.filter((c) => c.count >= ONLY_ID_MIN_DOCS && c.indexes.every((i) => i.name === '_id_')).sort((a, b) => b.count - a.count);
  if (onlyId.length) {
    out.push({
      id: 'only-id',
      level: 'info',
      title: `${onlyId.length} collection lớn chỉ có index _id — truy vấn lọc theo field khác sẽ quét toàn bộ`,
      evidence: onlyId.slice(0, LIST_TOP).map((c) => `${c.ns} · ${fmtN(c.count)} doc · ${fmtBytes(c.bytes)}`),
      fix: 'Không phải lỗi nếu chỉ tra theo _id (log, archive). Có truy vấn theo field khác thì xem mục "Hiệu năng truy vấn" để biết có COLLSCAN không.',
    });
  }
  const many = f.collections.filter((c) => c.indexes.length > MANY_INDEXES);
  if (many.length) {
    out.push({
      id: 'many-indexes',
      level: 'info',
      title: `${many.length} collection có hơn ${MANY_INDEXES} index — mỗi lần ghi phải cập nhật tất cả`,
      evidence: many.slice(0, LIST_TOP).map((c) => `${c.ns} · ${c.indexes.length} index`),
      fix: 'Gộp index theo tiền tố chung, bỏ index không dùng.',
    });
  }
  if (!hasIssue(out) && !out.length) out.push(ok('ok', 'Index ổn — không thấy index thừa hay không dùng', [`${fmtN(f.collections.length)} collection`]));

  const totalIx = f.collections.reduce((s, c) => s + c.indexes.reduce((t, i) => t + (i.bytes ?? 0), 0), 0);
  const notes = [...f.notes];
  if (f.totalCollections > f.collections.length) notes.push(`Chỉ xét ${fmtN(f.collections.length)} / ${fmtN(f.totalCollections)} collection đầu tiên (theo thứ tự db / collection)`);
  if (young.length) notes.push(`${young.length} index chưa dùng nhưng mới đếm < 7 ngày (vừa restart / vừa tạo) — chưa kết luận`);
  return done('indexes', at, '', out, 'Phân tích lại sau khi ẩn / bỏ index',
    [`${fmtN(f.collections.length)} collection`, `${fmtN(f.collections.reduce((s, c) => s + c.indexes.length, 0))} index`, `tổng index ${fmtBytes(totalIx)}`],
    [
      ...(unused.length ? [{
        title: `Index không dùng (${unused.length})`,
        columns: ['Collection', 'Index', 'Key', 'Dung lượng'],
        right: [3],
        rows: unused.map((x) => ({ cells: [x.ns, x.ix.name, keyStr(x.ix.key), fmtBytes(x.ix.bytes)], tone: (x.ix.bytes ?? 0) >= 100 * 1024 ** 2 ? 'warn' as const : undefined })),
      }] : []),
      ...(redundant.length ? [{
        title: `Index thừa (${redundant.length})`,
        columns: ['Collection', 'Index thừa', 'Nằm trong', 'Dung lượng'],
        right: [3],
        rows: redundant.map((x) => ({ cells: [x.ns, `${x.ix.name} {${keyStr(x.ix.key)}}`, `${x.by.name} {${keyStr(x.by.key)}}`, fmtBytes(x.ix.bytes)] })),
      }] : []),
    ],
    notes);
}

// ── 3. RAM & WiredTiger cache ───────────────────────────────────────────────

export interface MongoMemoryFacts {
  sec: number;
  cacheMax: number;
  cacheUsed: number;
  cacheDirty: number;
  /** Mỗi giây. */
  pagesReadIn: number;
  /** Trang luồng ứng dụng phải tự evict mỗi giây; null = bản này không có số. */
  appEvict: number | null;
  tickets: { kind: 'read' | 'write'; out: number; total: number }[];
  residentBytes: number;
  systemBytes: number | null;
  /** Tổng index / data (dbStats các db, không gồm admin/local/config). */
  indexBytes: number | null;
  dataBytes: number | null;
}

const CACHE_FULL = 0.95;
const DIRTY_WARN = 0.2;
const DIRTY_INFO = 0.05;
const READIN_WARN = 1_000;
const TICKET_WARN = 0.9;
const RESIDENT_WARN = 0.9;

export function analyzeMongoMemory(f: MongoMemoryFacts, at = Date.now()): MongoDiagnosis {
  const out: Finding[] = [];
  const used = f.cacheMax ? f.cacheUsed / f.cacheMax : 0;
  const dirty = f.cacheMax ? f.cacheDirty / f.cacheMax : 0;
  const pctS = (x: number) => `${Math.round(x * 100)}%`;

  if (f.appEvict !== null && f.appEvict > 0 && used >= CACHE_FULL) {
    out.push({
      id: 'app-evict',
      level: 'crit',
      title: `Cache WiredTiger đầy (${pctS(used)}) — luồng xử lý truy vấn phải tự evict ${fmtN(f.appEvict)} trang/s`,
      evidence: [`cache ${fmtBytes(f.cacheUsed)} / ${fmtBytes(f.cacheMax)} · đọc vào cache ${fmtN(f.pagesReadIn)} trang/s`],
      fix: 'Đây là lúc truy vấn chậm thấy rõ: working set lớn hơn cache. Giảm working set (index thừa, truy vấn quét rộng) hoặc tăng RAM / wiredTigerCacheSizeGB (cần restart).',
      step: { phase: 'now', text: 'Giảm working set: bỏ index không dùng, sửa truy vấn quét rộng' },
    });
  } else if (f.pagesReadIn >= READIN_WARN) {
    out.push({
      id: 'read-in',
      level: 'warn',
      title: `Đọc ${fmtN(f.pagesReadIn)} trang/s từ đĩa vào cache — working set không nằm gọn trong cache`,
      evidence: [`cache ${pctS(used)} (${fmtBytes(f.cacheUsed)} / ${fmtBytes(f.cacheMax)})`],
      fix: 'Truy vấn phải chờ đĩa. Xem mục "Index" (bỏ index thừa) và "Hiệu năng truy vấn" (quét thừa); nếu dữ liệu nóng thật sự lớn thì cần thêm RAM.',
      step: { phase: 'long', text: 'Thu nhỏ working set hoặc tăng RAM cho cache' },
    });
  }
  if (dirty >= DIRTY_WARN) {
    out.push({
      id: 'dirty',
      level: 'crit',
      title: `Dữ liệu bẩn chiếm ${pctS(dirty)} cache — vượt ngưỡng 20%, ghi bị chặn chờ checkpoint`,
      evidence: [`dirty ${fmtBytes(f.cacheDirty)} / ${fmtBytes(f.cacheMax)}`],
      fix: 'Ghi nhanh hơn tốc độ flush xuống đĩa. Kiểm tra IOPS / độ trễ đĩa; giảm ghi dồn (batch nhỏ lại, bỏ index không dùng để mỗi lần ghi nhẹ hơn).',
      step: { phase: 'now', text: 'Kiểm tra đĩa (IOPS / độ trễ) và giảm tải ghi dồn' },
    });
  } else if (dirty >= DIRTY_INFO) {
    out.push({ id: 'dirty-info', level: 'info', title: `Dữ liệu bẩn ${pctS(dirty)} cache (ngưỡng tự flush 5%, chặn ghi ở 20%)`, evidence: [`dirty ${fmtBytes(f.cacheDirty)}`] });
  }
  for (const t of f.tickets) {
    if (t.total && t.out / t.total >= TICKET_WARN) {
      out.push({
        id: `tickets-${t.kind}`,
        level: 'crit',
        title: `Hết ticket ${t.kind === 'read' ? 'đọc' : 'ghi'} (${t.out}/${t.total}) — request mới phải xếp hàng`,
        evidence: ['Ticket là số thao tác chạy đồng thời trong storage engine; dùng hết thường vì thao tác bên trong chậm (đĩa, cache đầy), không phải vì thiếu ticket'],
        fix: 'Đừng tăng số ticket trước — tìm nguyên nhân thao tác chậm (cache đầy, đĩa chậm, op quét rộng).',
        step: { phase: 'now', text: `Tìm vì sao thao tác ${t.kind === 'read' ? 'đọc' : 'ghi'} chậm (cache / đĩa / op quét rộng)` },
      });
    }
  }
  if (f.indexBytes !== null && f.cacheMax && f.indexBytes > f.cacheMax) {
    out.push({
      id: 'index-gt-cache',
      level: 'warn',
      title: `Tổng index (${fmtBytes(f.indexBytes)}) lớn hơn cache WiredTiger (${fmtBytes(f.cacheMax)})`,
      evidence: [`data ${fmtBytes(f.dataBytes)} · index ${fmtBytes(f.indexBytes)}`],
      fix: 'Index nên nằm gọn trong RAM. Bỏ index không dùng / thừa (mục "Index") trước khi tính tới thêm RAM.',
      step: { phase: 'long', text: 'Thu gọn index cho vừa cache' },
    });
  }
  if (f.systemBytes && f.residentBytes / f.systemBytes >= RESIDENT_WARN) {
    out.push({
      id: 'resident',
      level: 'warn',
      title: `mongod đang giữ ${pctS(f.residentBytes / f.systemBytes)} RAM máy — nguy cơ swap / bị OOM kill`,
      evidence: [`resident ${fmtBytes(f.residentBytes)} / RAM ${fmtBytes(f.systemBytes)}`],
      fix: 'Cache mặc định là 50% (RAM − 1GB); phần còn lại cho kết nối, sort, aggregation và filesystem cache. Kiểm tra có tiến trình khác trên máy hoặc wiredTigerCacheSizeGB đặt quá cao.',
      step: { phase: 'restart', text: 'Xem lại wiredTigerCacheSizeGB / tiến trình khác trên máy' },
    });
  }
  if (!hasIssue(out)) out.push(ok('ok', 'Bộ nhớ ổn — cache còn chỗ, không phải tự evict, ticket còn dư', [`cache ${pctS(used)} · dirty ${pctS(dirty)} · đọc vào ${fmtN(f.pagesReadIn)} trang/s`]));

  return done('memory', at, '', out, 'Phân tích lại để xác nhận cache / ticket đã hạ',
    [
      `cache ${fmtBytes(f.cacheUsed)} / ${fmtBytes(f.cacheMax)} (${pctS(used)})`,
      `dirty ${pctS(dirty)}`,
      `đọc vào cache ${fmtN(f.pagesReadIn)} trang/s`,
      ...f.tickets.map((t) => `ticket ${t.kind === 'read' ? 'đọc' : 'ghi'} ${t.out}/${t.total}`),
      `RAM mongod ${fmtBytes(f.residentBytes)}${f.systemBytes ? ` / ${fmtBytes(f.systemBytes)}` : ''}`,
    ],
    [],
    f.appEvict === null ? ['Bản MongoDB này không có số trang luồng ứng dụng tự evict'] : []);
}

// ── 4. Replica set & oplog ──────────────────────────────────────────────────

export interface MdMember {
  name: string;
  state: string;
  health: boolean;
  /** Giây sau primary (secondary). */
  lagSec: number | null;
  votes: number;
  priority: number;
  hidden: boolean;
  arbiter: boolean;
  /** Primary: thời điểm thắng bầu chọn. */
  electionAt: number | null;
  self: boolean;
}

export interface MongoReplFacts {
  /** null = không phải replica set (standalone / mongos). */
  set: string | null;
  members: MdMember[];
  /** Cửa sổ oplog (giây) của node đang kết nối; null = không đọc được. */
  oplogWindowSec: number | null;
  oplogBytes: number | null;
  oplogMaxBytes: number | null;
  error?: string;
}

const LAG_WARN = 10;
const LAG_CRIT = 60;
const OPLOG_WARN_SEC = 24 * 3600;
const OPLOG_CRIT_SEC = 6 * 3600;
const RECENT_ELECTION_MS = 3600 * 1000;

export function analyzeMongoRepl(f: MongoReplFacts, at = Date.now()): MongoDiagnosis {
  const out: Finding[] = [];
  if (!f.set) {
    out.push({ id: 'standalone', level: 'info', title: 'Không phải replica set (standalone hoặc mongos) — không có gì để phân tích', evidence: [f.error ?? 'replSetGetStatus không trả về'] });
    return done('repl', at, '', out, '', [], [], []);
  }
  const bad = f.members.filter((m) => !m.health || /DOWN|UNKNOWN|REMOVED/.test(m.state));
  const primary = f.members.find((m) => m.state === 'PRIMARY');
  if (!primary) {
    out.push({
      id: 'no-primary',
      level: 'crit',
      title: 'Replica set KHÔNG có primary — mọi lệnh ghi đang lỗi',
      evidence: f.members.map((m) => `${m.name}: ${m.state}`),
      fix: 'Cần đa số member bỏ phiếu còn sống để bầu primary. Đưa member đang DOWN trở lại; tuyệt đối không ép cấu hình (force reconfig) khi chưa hiểu vì sao mất đa số.',
      step: { phase: 'now', text: 'Khôi phục member DOWN để replica set bầu lại primary' },
    });
  }
  if (bad.length) {
    out.push({
      id: 'unhealthy',
      level: 'crit',
      title: `${bad.length} member không khoẻ: ${bad.map((m) => m.name).join(', ')}`,
      evidence: bad.map((m) => `${m.name}: ${m.state}`),
      fix: 'Kiểm tra process, đĩa, mạng giữa các member. Mất thêm member có thể làm mất đa số → không còn primary.',
      step: { phase: 'now', text: `Khôi phục member ${bad.map((m) => m.name).join(', ')}` },
    });
  }
  const lagging = f.members.filter((m) => m.lagSec !== null && m.lagSec >= LAG_WARN).sort((a, b) => (b.lagSec ?? 0) - (a.lagSec ?? 0));
  if (lagging.length) {
    const worst = lagging[0].lagSec ?? 0;
    out.push({
      id: 'lag',
      level: worst >= LAG_CRIT ? 'crit' : 'warn',
      title: `Secondary tụt sau primary: ${lagging.map((m) => `${m.name} ${fmtSec(m.lagSec ?? 0)}`).join(', ')}`,
      evidence: [
        'Đọc từ secondary sẽ ra dữ liệu cũ; write concern majority phải chờ lâu hơn',
        ...(f.oplogWindowSec ? [`Cửa sổ oplog ${fmtSec(f.oplogWindowSec)} — lag vượt cửa sổ thì secondary phải initial sync lại từ đầu`] : []),
      ],
      fix: 'Secondary chậm hơn primary về đĩa / CPU, mạng giữa hai bên, hoặc đang có thao tác ghi khối lớn (update nhiều doc, build index). Kiểm tra tài nguyên của secondary.',
      step: { phase: 'now', text: `Kiểm tra tài nguyên / mạng của ${lagging[0].name}` },
    });
    if (f.oplogWindowSec && worst >= f.oplogWindowSec * 0.5) {
      out.push({
        id: 'lag-vs-oplog',
        level: 'crit',
        title: `Lag (${fmtSec(worst)}) đã quá nửa cửa sổ oplog (${fmtSec(f.oplogWindowSec)}) — sắp phải initial sync lại`,
        evidence: [`${lagging[0].name}`],
        fix: 'Tăng oplog ngay (replSetResizeOplog — đổi được khi đang chạy) để mua thời gian cho secondary bắt kịp.',
        sql: 'db.adminCommand({ replSetResizeOplog: 1, size: <MB> })',
        step: { phase: 'now', text: 'Tăng kích thước oplog trước khi secondary rơi khỏi cửa sổ' },
      });
    }
  }
  if (f.oplogWindowSec !== null && f.oplogWindowSec < OPLOG_WARN_SEC) {
    out.push({
      id: 'oplog-window',
      level: f.oplogWindowSec < OPLOG_CRIT_SEC ? 'crit' : 'warn',
      title: `Cửa sổ oplog chỉ ${fmtSec(f.oplogWindowSec)} — member dừng lâu hơn thế là phải initial sync lại`,
      evidence: [`oplog ${fmtBytes(f.oplogBytes)} / tối đa ${fmtBytes(f.oplogMaxBytes)}`],
      fix: 'Nên giữ ≥ 24–72 giờ để bảo trì / sự cố một member không phải sync lại từ đầu. Tăng oplog bằng replSetResizeOplog (không cần restart).',
      sql: 'db.adminCommand({ replSetResizeOplog: 1, size: <MB> })',
      step: { phase: 'long', text: 'Tăng oplog lên ≥ 24 giờ' },
    });
  }
  const voters = f.members.filter((m) => m.votes > 0);
  if (voters.length % 2 === 0 && voters.length > 0) {
    out.push({
      id: 'even-voters',
      level: 'warn',
      title: `${voters.length} member bỏ phiếu (số chẵn) — mất một nửa là không bầu được primary`,
      evidence: voters.map((m) => `${m.name} (votes ${m.votes})`),
      fix: 'Giữ số member bỏ phiếu lẻ (3, 5, 7): thêm một member hoặc đặt votes: 0 cho một member.',
      step: { phase: 'long', text: 'Đưa số member bỏ phiếu về số lẻ' },
    });
  }
  if (f.members.some((m) => m.arbiter)) {
    out.push({
      id: 'arbiter',
      level: 'info',
      title: 'Có arbiter — khi một member dữ liệu dừng, write concern majority có thể treo',
      evidence: f.members.filter((m) => m.arbiter).map((m) => m.name),
      fix: 'Với PSA (primary-secondary-arbiter), secondary dừng là majority không ghi được. Thay arbiter bằng một secondary nếu có thể.',
    });
  }
  if (primary?.electionAt && at - primary.electionAt < RECENT_ELECTION_MS) {
    out.push({ id: 'recent-election', level: 'info', title: `Primary ${primary.name} vừa được bầu ${fmtSec((at - primary.electionAt) / 1000)} trước`, evidence: ['Có failover gần đây — kiểm tra log của primary cũ để biết vì sao'] });
  }
  if (!hasIssue(out)) out.push(ok('ok', 'Replica set khoẻ — đủ member, không lag, oplog đủ dài', [`${f.members.length} member${f.oplogWindowSec ? ` · oplog ${fmtSec(f.oplogWindowSec)}` : ''}`]));

  return done('repl', at, '', out, 'Phân tích lại để xác nhận lag / member đã ổn',
    [`replica set ${f.set}`, `${f.members.length} member`, primary ? `primary ${primary.name}` : 'không có primary', f.oplogWindowSec ? `oplog ${fmtSec(f.oplogWindowSec)}` : ''].filter(Boolean),
    [{
      title: 'Member',
      columns: ['Member', 'Trạng thái', 'Lag', 'Votes', 'Priority', 'Ghi chú'],
      right: [2, 3, 4],
      rows: f.members.map((m) => ({
        cells: [`${m.name}${m.self ? ' (đang nối)' : ''}`, m.state, m.lagSec !== null ? fmtSec(m.lagSec) : '—', String(m.votes), String(m.priority), [m.hidden ? 'hidden' : '', m.arbiter ? 'arbiter' : ''].filter(Boolean).join(', ')],
        tone: !m.health || /DOWN|UNKNOWN|REMOVED/.test(m.state) ? 'down' : (m.lagSec ?? 0) >= LAG_WARN ? 'warn' : undefined,
      })),
    }],
    f.oplogWindowSec === null ? ['Không đọc được oplog (cần quyền đọc db local)'] : []);
}

// ── 5. Kết nối ──────────────────────────────────────────────────────────────

export interface MongoConnFacts {
  sec: number;
  current: number;
  available: number;
  active: number | null;
  /** Kết nối mới mỗi giây. */
  createdPerSec: number;
  /** Theo máy + app; null = không gom (quá nhiều kết nối / thiếu quyền). */
  byClient: { host: string; app: string; count: number; active: number }[] | null;
  byClientNote?: string;
}

const CONN_WARN = 0.8;
const CONN_CRIT = 0.9;
const CHURN_WARN = 20;
const ONE_HOST_SHARE = 0.5;

export function analyzeMongoConnections(f: MongoConnFacts, at = Date.now()): MongoDiagnosis {
  const out: Finding[] = [];
  const limit = f.current + f.available;
  const used = limit ? f.current / limit : 0;
  if (used >= CONN_WARN) {
    out.push({
      id: 'conn-used',
      level: used >= CONN_CRIT ? 'crit' : 'warn',
      title: `Đã dùng ${Math.round(used * 100)}% kết nối (${fmtN(f.current)} / ${fmtN(limit)})`,
      evidence: [`còn ${fmtN(f.available)} slot`],
      fix: 'Hết slot là app mới không kết nối được. Mỗi kết nối tốn ~1MB RAM. Xem bảng theo máy / app: pool quá lớn (maxPoolSize × số instance) hay rò kết nối.',
      step: { phase: 'now', text: 'Giảm maxPoolSize / tìm app rò kết nối' },
    });
  }
  if (f.createdPerSec >= CHURN_WARN) {
    out.push({
      id: 'churn',
      level: 'warn',
      title: `${fmtN(f.createdPerSec)} kết nối mới mỗi giây — app đang mở / đóng kết nối liên tục`,
      evidence: [`connections.totalCreated trong ${f.sec}s`],
      fix: 'Mỗi kết nối mới tốn bắt tay TCP + TLS + xác thực (SCRAM khá nặng CPU). Dùng một MongoClient dùng chung cho cả app thay vì tạo mới mỗi request.',
      step: { phase: 'now', text: 'Dùng chung MongoClient / pool trong app' },
    });
  }
  const rows = f.byClient ?? [];
  const byHost = new Map<string, number>();
  for (const r of rows) byHost.set(r.host, (byHost.get(r.host) ?? 0) + r.count);
  const top = [...byHost.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && f.current >= 100 && top[1] / f.current >= ONE_HOST_SHARE) {
    out.push({
      id: 'one-host',
      level: 'info',
      title: `Máy ${top[0]} giữ ${Math.round((top[1] / f.current) * 100)}% kết nối (${fmtN(top[1])})`,
      evidence: rows.filter((r) => r.host === top[0]).slice(0, 5).map((r) => `${r.app || '(không đặt appName)'}: ${fmtN(r.count)}`),
      fix: 'Kiểm tra maxPoolSize của app trên máy đó, hoặc có nhiều tiến trình cùng chạy.',
    });
  }
  if (f.active !== null && f.current >= 200 && f.active / f.current < 0.05) {
    out.push({ id: 'idle', level: 'info', title: `${Math.round((1 - f.active / f.current) * 100)}% kết nối đang rảnh`, evidence: [`đang hoạt động ${fmtN(f.active)} / ${fmtN(f.current)}`], fix: 'Pool lớn hơn nhu cầu — giảm maxPoolSize hoặc đặt maxIdleTimeMS để thu hồi kết nối rảnh.' });
  }
  if (!hasIssue(out)) out.push(ok('ok', 'Kết nối ổn — còn nhiều slot, không mở / đóng dồn dập', [`${fmtN(f.current)} / ${fmtN(limit)} · ${fmtN(f.createdPerSec)} mới/s`]));

  return done('connections', at, '', out, 'Phân tích lại để xác nhận số kết nối đã giảm',
    [`${fmtN(f.current)} / ${fmtN(limit)} kết nối (${Math.round(used * 100)}%)`, f.active !== null ? `đang hoạt động ${fmtN(f.active)}` : '', `${fmtN(f.createdPerSec)} mới/s`].filter(Boolean),
    rows.length ? [{
      title: 'Theo máy / app',
      columns: ['Máy', 'App', 'Kết nối', 'Đang hoạt động'],
      right: [2, 3],
      rows: rows.map((r) => ({ cells: [r.host, r.app || '—', fmtN(r.count), fmtN(r.active)] })),
    }] : [],
    f.byClientNote ? [f.byClientNote] : []);
}
