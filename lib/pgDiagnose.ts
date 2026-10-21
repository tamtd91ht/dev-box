// Server-only: phân tích nguyên nhân cache hit thấp của PostgreSQL — phần GOM SỐ LIỆU.
//
// Chỉ ĐỌC thống kê có sẵn của Postgres (pg_stat_* / pg_statio_* /
// pg_stat_statements / pg_settings) qua runReadOnly của lib/pgClient — cùng mô
// hình an toàn với mọi lệnh đọc khác: transaction READ ONLY + statement_timeout.
// Không chạy lệnh sửa nào; các lệnh khắc phục chỉ là gợi ý để người dùng tự chạy.
//
// Luật biến số liệu thành kết luận nằm ở lib/pgDiagnoseRules (thuần, kiểm được).
//
// Tỉ lệ HIỆN TẠI: pg_stat_database là số cộng dồn, nên đo hai lần cách nhau
// WINDOW_MS. Lần đầu ở ngay đầu phiên, lần sau ở cuối (đợi đủ khoảng nếu các
// bước giữa chạy nhanh hơn) — thời gian gom các bảng không bị phí.
//
// Mỗi truy vấn "mềm": thiếu quyền / khác phiên bản thì bỏ phần đó và nói rõ,
// không làm hỏng cả lần phân tích.
//
// AN TOÀN CHO PRODUCTION:
//   • KHÔNG xin khoá bảng: kích thước bảng/index lấy từ pg_class.relpages (ước
//     lượng VACUUM/ANALYZE cập nhật) thay vì pg_total_relation_size — hàm đó xin
//     AccessShareLock, và nếu đúng lúc có ALTER TABLE đang chờ khoá thì lệnh của
//     ta xếp hàng sau nó, kéo mọi truy vấn của ứng dụng vào bảng đó xếp hàng sau ta.
//   • Mỗi transaction đặt lock_timeout 500ms + statement_timeout 5s (chặt hơn
//     15s mặc định của tab PG) — có gì bất thường thì bỏ phần đó, không chờ.
//   • Server sắp hết kết nối (≥ CONN_GUARD) thì KHÔNG mở thêm kết nối tới các
//     database khác — không giành slot của ứng dụng.
//   • Một phiên phân tích cho mỗi kết nối tại một thời điểm.

import type { PgConnection } from '@/lib/pgConnections';
import { getPool, runReadOnly, hostMetrics } from '@/lib/pgClient';
import {
  analyzeCacheHit,
  type CacheHitDiagnosis, type CacheHitFacts, type DiagActive, type DiagDb, type DiagStatement, type DiagTable, type StatementsState,
} from '@/lib/pgDiagnoseRules';

const WINDOW_MS = 6000;
/** Số database (đọc ngoài nhiều nhất) được xét tới mức bảng. */
const MAX_DBS = 3;
const TOP_TABLES = 10;
const TOP_STATEMENTS = 15;
/** Tỉ lệ kết nối đã dùng mà từ đó không mở thêm kết nối tới database khác. */
const CONN_GUARD = 0.85;

type Q = (text: string, params?: unknown[]) => Promise<import('pg').QueryResult>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
const errMsg = (e: unknown): string => (e as Error)?.message || String(e);

/** Giới hạn chặt cho mọi transaction của phần phân tích — xem ghi chú đầu file. */
async function guard(q: Q): Promise<void> {
  await q("SET LOCAL lock_timeout = '500ms'");
  await q("SET LOCAL statement_timeout = '5s'");
}

/** Một truy vấn lỗi không được làm hỏng transaction của các truy vấn sau. */
async function soft(q: Q, sql: string, params?: unknown[]): Promise<Record<string, unknown>[] | null> {
  try {
    await q('SAVEPOINT d');
    const r = await q(sql, params);
    await q('RELEASE SAVEPOINT d');
    return r.rows;
  } catch {
    await q('ROLLBACK TO SAVEPOINT d').catch(() => {});
    return null;
  }
}

async function sampleTotals(conn: PgConnection): Promise<{ hit: number; read: number; at: number }> {
  const pool = await getPool(conn);
  return runReadOnly(pool, async (q) => {
    await guard(q);
    const r = await q('SELECT sum(blks_hit)::bigint AS h, sum(blks_read)::bigint AS r FROM pg_stat_database');
    return { hit: num(r.rows[0]?.h), read: num(r.rows[0]?.r), at: Date.now() };
  });
}

interface ServerPart {
  versionNum: number;
  blockSize: number;
  user: string;
  canReadAllStats: boolean | null;
  sharedBuffersBytes: number | null;
  effectiveCacheBytes: number | null;
  trackIoTiming: boolean | null;
  /** Kết nối đang dùng / tối đa cho user thường (null = không đọc được). */
  connUse: number | null;
  dbs: (DiagDb & { allowConn: boolean })[];
}

async function serverPart(conn: PgConnection): Promise<ServerPart> {
  const pool = await getPool(conn);
  return runReadOnly(pool, async (q) => {
    await guard(q);
    const s = (await soft(q, `
      SELECT current_setting('server_version_num')::int AS v,
             current_setting('block_size')::int AS bs,
             pg_size_bytes(current_setting('shared_buffers')) AS sb,
             pg_size_bytes(current_setting('effective_cache_size')) AS ecs,
             current_setting('track_io_timing') AS tio,
             current_user AS u,
             (SELECT count(*) FROM pg_stat_activity) AS conns,
             current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int AS maxc`))?.[0] ?? {};
    const priv = (await soft(q, `
      SELECT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
             OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS ok`))?.[0];
    const dbRows = (await soft(q, `
      SELECT coalesce(d.datname, '(catalog dùng chung)') AS name,
             s.blks_hit AS hit, s.blks_read AS read, s.blk_read_time AS rt, s.stats_reset AS reset,
             coalesce(d.datallowconn, false) AS allow,
             CASE WHEN d.datallowconn AND has_database_privilege(d.datname, 'CONNECT')
                  THEN pg_database_size(d.datname) END AS size
        FROM pg_stat_database s LEFT JOIN pg_database d ON d.oid = s.datid`)) ?? [];
    return {
      versionNum: num(s.v),
      blockSize: num(s.bs) || 8192,
      user: String(s.u ?? ''),
      canReadAllStats: priv ? !!priv.ok : null,
      sharedBuffersBytes: numOrNull(s.sb),
      effectiveCacheBytes: numOrNull(s.ecs),
      trackIoTiming: s.tio === undefined ? null : s.tio === 'on',
      connUse: num(s.maxc) > 0 ? num(s.conns) / num(s.maxc) : null,
      dbs: dbRows.map((r) => ({
        name: String(r.name),
        hit: num(r.hit),
        read: num(r.read),
        readTimeMs: numOrNull(r.rt),
        sizeBytes: numOrNull(r.size),
        statsReset: iso(r.reset),
        allowConn: !!r.allow,
      })),
    };
  });
}

/** Query đang chạy trên cả server — nguồn thứ hai khi chưa có pg_stat_statements. */
async function activeQueries(conn: PgConnection): Promise<DiagActive[]> {
  const pool = await getPool(conn);
  return runReadOnly(pool, async (q) => {
    await guard(q);
    const rows = (await soft(q, `
      SELECT datname AS db, left(query, 4000) AS query, extract(epoch FROM now() - query_start) AS age
        FROM pg_stat_activity
       WHERE state = 'active' AND backend_type = 'client backend' AND pid <> pg_backend_pid()
         AND query NOT ILIKE 'explain%'
       ORDER BY query_start ASC NULLS LAST
       LIMIT 30`)) ?? [];
    return rows.map((r) => ({ db: r.db ? String(r.db) : null, query: String(r.query ?? ''), ageSec: Math.round(num(r.age)) }));
  });
}

interface DbPart {
  tables: DiagTable[];
  statements: { rows: DiagStatement[]; total: number; state: StatementsState } | null;
}

async function dbPart(conn: PgConnection, db: string, wantStatements: boolean): Promise<DbPart> {
  const pool = await getPool(conn, db);
  return runReadOnly(pool, async (q) => {
    await guard(q);
    const tableSql = (order: string, extraWhere = '') => `
      SELECT st.schemaname AS sch, st.relname AS rel,
             coalesce(io.heap_blks_read, 0) AS hr, coalesce(io.heap_blks_hit, 0) AS hh,
             coalesce(io.idx_blks_read, 0) AS ir, coalesce(io.idx_blks_hit, 0) AS ih,
             coalesce(io.toast_blks_read, 0) + coalesce(io.tidx_blks_read, 0) AS tr,
             coalesce(st.seq_scan, 0) AS ss, coalesce(st.seq_tup_read, 0) AS str, st.idx_scan AS isc,
             coalesce(st.n_live_tup, 0) AS live, coalesce(st.n_dead_tup, 0) AS dead,
             -- Ước lượng từ pg_class (không xin khoá bảng — xem ghi chú đầu file).
             (c.relpages::bigint + coalesce(t.relpages, 0)
               + coalesce((SELECT sum(i.relpages) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = c.oid), 0))
               * current_setting('block_size')::bigint AS size,
             greatest(st.last_vacuum, st.last_autovacuum) AS vac
        FROM pg_stat_user_tables st JOIN pg_statio_user_tables io ON io.relid = st.relid
        JOIN pg_class c ON c.oid = st.relid LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
       ${extraWhere}
       ORDER BY ${order} DESC LIMIT ${TOP_TABLES}`;
    const hot = (await soft(q, tableSql('coalesce(io.heap_blks_read,0) + coalesce(io.idx_blks_read,0) + coalesce(io.toast_blks_read,0) + coalesce(io.tidx_blks_read,0)'))) ?? [];
    const bloat = (await soft(q, tableSql('st.n_dead_tup', 'WHERE st.n_dead_tup >= 10000'))) ?? [];

    const byKey = new Map<string, DiagTable>();
    for (const r of [...hot, ...bloat]) {
      const key = `${r.sch}.${r.rel}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        db,
        schema: String(r.sch),
        table: String(r.rel),
        heapRead: num(r.hr),
        heapHit: num(r.hh),
        idxRead: num(r.ir),
        idxHit: num(r.ih),
        toastRead: num(r.tr),
        seqScan: num(r.ss),
        seqTupRead: num(r.str),
        idxScan: numOrNull(r.isc),
        liveTup: num(r.live),
        deadTup: num(r.dead),
        sizeBytes: numOrNull(r.size),
        lastVacuum: iso(r.vac),
      });
    }
    const tables = [...byKey.values()];

    // Cột của các bảng nóng nhất — để suy cột nên đánh index từ câu query.
    const hotTables = tables.slice(0, 5);
    if (hotTables.length) {
      const cols = (await soft(q,
        `SELECT table_schema AS s, table_name AS t, column_name AS c
           FROM information_schema.columns
          WHERE table_schema::text = ANY($1::text[]) AND table_name::text = ANY($2::text[])`,
        [hotTables.map((t) => t.schema), hotTables.map((t) => t.table)])) ?? [];
      // Index đang có + số lần dùng — để không gợi ý trùng và thấy index bị bỏ không.
      const idx = await soft(q,
        `SELECT ui.schemaname AS s, ui.relname AS t, ui.indexrelname AS i, ui.idx_scan AS sc,
                i.relpages::bigint * current_setting('block_size')::bigint AS sz, pg_get_indexdef(ui.indexrelid) AS def
           FROM pg_stat_user_indexes ui JOIN pg_class i ON i.oid = ui.indexrelid
          WHERE ui.schemaname::text = ANY($1::text[]) AND ui.relname::text = ANY($2::text[])`,
        [hotTables.map((t) => t.schema), hotTables.map((t) => t.table)]);
      for (const t of hotTables) {
        t.columns = cols.filter((c) => c.s === t.schema && c.t === t.table).map((c) => String(c.c));
        // null (lỗi / thiếu quyền) ≠ [] (bảng thật sự không có index).
        if (idx) {
          t.indexes = idx.filter((r) => r.s === t.schema && r.t === t.table).map((r) => ({
            name: String(r.i),
            def: String(r.def ?? ''),
            scans: numOrNull(r.sc),
            sizeBytes: numOrNull(r.sz),
          }));
        }
      }
    }

    let statements: DbPart['statements'] = null;
    if (wantStatements) {
      const has = await soft(q, `SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`);
      if (has?.length) {
        try {
          await q('SAVEPOINT st');
          const rows = await q(`
            SELECT d.datname AS db, left(s.query, 4000) AS query, s.calls AS calls,
                   s.shared_blks_read AS rd, s.shared_blks_hit AS ht
              FROM pg_stat_statements s LEFT JOIN pg_database d ON d.oid = s.dbid
             ORDER BY s.shared_blks_read DESC LIMIT ${TOP_STATEMENTS}`);
          const total = await q('SELECT coalesce(sum(shared_blks_read), 0) AS t FROM pg_stat_statements');
          await q('RELEASE SAVEPOINT st');
          statements = {
            rows: rows.rows.map((r) => ({
              db: r.db ? String(r.db) : null,
              query: String(r.query ?? ''),
              calls: num(r.calls),
              sharedRead: num(r.rd),
              sharedHit: num(r.ht),
            })),
            total: num(total.rows[0]?.t),
            state: 'ok',
          };
        } catch (e) {
          await q('ROLLBACK TO SAVEPOINT st').catch(() => {});
          // Có extension nhưng chưa nạp qua shared_preload_libraries → coi như chưa có.
          statements = { rows: [], total: 0, state: /shared_preload_libraries/i.test(errMsg(e)) ? 'missing' : 'error' };
        }
      }
    }
    return { tables, statements };
  });
}

const running = new Set<string>();

export async function diagnoseCacheHit(conn: PgConnection): Promise<CacheHitDiagnosis> {
  if (running.has(conn.id)) throw new Error('Đang có một phiên phân tích khác trên kết nối này — chờ nó xong rồi chạy lại.');
  running.add(conn.id);
  try {
    return await run(conn);
  } finally {
    running.delete(conn.id);
  }
}

async function run(conn: PgConnection): Promise<CacheHitDiagnosis> {
  const first = await sampleTotals(conn);
  const [server, host, active] = await Promise.all([
    serverPart(conn),
    hostMetrics(conn).catch(() => []),
    activeQueries(conn).catch(() => [] as DiagActive[]),
  ]);

  const candidates = server.dbs
    .filter((d) => d.allowConn && d.read > 0 && !/^template[01]$/.test(d.name))
    .sort((a, b) => b.read - a.read)
    .slice(0, MAX_DBS)
    .map((d) => d.name);
  const tables: DiagTable[] = [];
  const analyzedDbs: string[] = [];
  const skippedDbs: { name: string; error: string }[] = [];
  // Server sắp hết kết nối: chỉ dùng database mặc định (đã có kết nối) — không giành slot của ứng dụng.
  const tight = server.connUse !== null && server.connUse >= CONN_GUARD;
  if (tight) {
    for (const db of candidates.filter((d) => d !== conn.database)) {
      skippedDbs.push({ name: db, error: `bỏ qua — server đã dùng ${Math.round(server.connUse! * 100)}% kết nối, không mở thêm` });
    }
  }
  // Database mặc định của connection luôn được xét tìm pg_stat_statements (thường cài ở đó).
  const order = [...new Set([conn.database, ...candidates])].filter((d) => d && (!tight || d === conn.database));
  let statements: DbPart['statements'] = null;
  for (const db of order) {
    try {
      const part = await dbPart(conn, db, !statements || statements.state !== 'ok');
      if (candidates.includes(db)) {
        tables.push(...part.tables);
        analyzedDbs.push(db);
      }
      if (part.statements && (!statements || part.statements.state === 'ok')) statements = part.statements;
    } catch (e) {
      if (candidates.includes(db)) skippedDbs.push({ name: db, error: errMsg(e) });
    }
  }

  // Lần đo thứ hai: đợi cho đủ cửa sổ rồi mới lấy.
  const waitMs = first.at + WINDOW_MS - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  const second = await sampleTotals(conn).catch(() => null);
  const window = second && second.hit >= first.hit && second.read >= first.read
    ? { hit: second.hit - first.hit, read: second.read - first.read, sec: Math.round((second.at - first.at) / 1000) }
    : null;

  const mem = host.find((h) => h.memTotalBytes)?.memTotalBytes ?? null;
  const facts: CacheHitFacts = {
    versionNum: server.versionNum,
    blockSize: server.blockSize,
    user: server.user,
    canReadAllStats: server.canReadAllStats,
    sharedBuffersBytes: server.sharedBuffersBytes,
    effectiveCacheBytes: server.effectiveCacheBytes,
    trackIoTiming: server.trackIoTiming,
    hostMemBytes: mem,
    cumulative: { hit: first.hit, read: first.read },
    window,
    dbs: server.dbs.map(({ allowConn: _a, ...d }) => d),
    tables,
    analyzedDbs,
    skippedDbs,
    statements: statements?.rows ?? [],
    statementsTotalRead: statements?.total ?? 0,
    statementsState: statements?.state ?? 'missing',
    activeQueries: active,
  };
  return analyzeCacheHit(facts);
}
