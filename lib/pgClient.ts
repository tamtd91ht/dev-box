// Server-only PostgreSQL operations for the local PG-manager workspace.
//
// SECURITY / SAFETY MODEL — connects to real PG servers (possibly production)
// from the machine hosting the Next.js server, so it is deliberately
// constrained and gated off in any deploy:
//   1. Gated by PG_TOOL_ENABLED — the API routes 403 unless truthy.
//   2. READS run inside `BEGIN TRANSACTION READ ONLY` with a `SET LOCAL
//      statement_timeout` — the DATABASE refuses any write smuggled into a
//      "read" query, and a bad query times out server-side (15s).
//   3. Raw SQL results are row-capped: the query is wrapped as
//      `SELECT * FROM (q) __q LIMIT N+1` when possible; queries that can't be
//      wrapped (EXPLAIN, SHOW, …) run as-is — still read-only + timed out —
//      and are truncated after fetch.
//   4. The ONLY write is update-with-WHERE: a structured UPDATE on one table
//      with a NON-EMPTY WHERE clause, parameterized SET values, no other
//      statement kind. Gates: PG_ALLOW_WRITE env + per-connection readOnly
//      (defaults true) + typed-confirm modal in the UI. Audit-logged.
//      Ngoài ra màn "⚡ Thực thi SQL" (executeSql) chạy SQL tự do sau CÙNG hai
//      cổng đó, trong một transaction tool tự mở: chạy thử = ROLLBACK, ghi thật
//      = COMMIT (UI bắt chạy thử đúng câu đó trước). Audit-logged.
//   5. Identifiers (database/schema/table/column) are validated + quoted;
//      values travel as bind parameters, never concatenated.
//   6. KHÔNG ĐỂ BẢNG KẸT KHOÁ. Mọi transaction (đọc lẫn UPDATE) đặt
//      `lock_timeout` LOCK_TIMEOUT_MS: hễ phải chờ khoá là báo lỗi ngay thay vì
//      xếp hàng — vì một lệnh đang chờ khoá đứng sau ALTER TABLE / VACUUM FULL /
//      REINDEX sẽ kéo mọi truy vấn của ứng dụng vào bảng đó xếp hàng sau nó.
//      Thông tin kích thước (danh sách bảng, phân tích) lấy từ pg_class.relpages
//      — KHÔNG gọi pg_total_relation_size / pg_relation_size, vì các hàm đó xin
//      AccessShareLock trên từng bảng (danh sách bảng gọi cho MỌI bảng một lượt).

import { Client, Pool, types } from 'pg';
import type { PgConnection } from '@/lib/pgConnections';
import { parseHostList, type PgEndpoint } from '@/lib/pgHosts';
import { fetchHostMetrics, type HostMetrics } from '@/lib/hostMetrics';

// int8/numeric come back as strings by default — keep them as strings (exact),
// the UI/report layer decides how to render. (No parser overrides needed.)
void types;

export const PG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.PG_TOOL_ENABLED ?? '');
/** Global write gate — even when on, per-connection readOnly still applies. */
export const PG_ALLOW_WRITE = /^(1|true|yes|on)$/i.test(process.env.PG_ALLOW_WRITE ?? '');

export const QUERY_ROWS_MAX = 500;
export const QUICKFIND_LIMIT_MAX = 200;
const STMT_TIMEOUT_MS = 15_000;
/** Chờ khoá quá ngần này thì bỏ — xem mục 6 ở đầu file. */
const LOCK_TIMEOUT_MS = 1_000;
const CONNECT_TIMEOUT_MS = 5000;
const IDLE_EVICT_MS = 10 * 60 * 1000;
/** Rendered row guard — mirrors the Mongo tab. */
const ROW_JSON_CAP = 200_000;

// ── Pool cache (one tiny pool per connection+database) ───────────────────────

interface Cached {
  pool: Pool;
  sig: string;
  lastUsed: number;
}
const pools = new Map<string, Cached>();

function signature(c: PgConnection, db: string, ep: PgEndpoint): string {
  return [c.host, c.port, ep.host, ep.port, db, c.username, c.tls].join('|');
}

// ── Cluster: chọn node ────────────────────────────────────────────────────────
//
// Ô Host có thể là danh sách "pg1:5432,pg2:5432,…" (xem lib/pgHosts). `pg` không
// tự failover giữa nhiều host nên ta chọn node ở đây: hỏi song song từng node
// `pg_is_in_recovery()`, lấy node PRIMARY đứng đầu danh sách; không có primary
// (đang failover, hoặc chỉ liệt kê replica) thì lấy node đầu tiên sống — đọc vẫn
// chạy được, còn ghi sẽ bị chính standby từ chối. Kết quả nhớ ENDPOINT_TTL_MS để
// không dò lại ở mỗi lệnh; hết hạn (hoặc pool lỗi kết nối) thì dò lại, nên sau
// failover tự chuyển sang primary mới.

interface Picked {
  ep: PgEndpoint;
  role: 'primary' | 'standby';
  at: number;
}
const ENDPOINT_TTL_MS = 30_000;
const picked = new Map<string, Picked>();

function sslOf(c: PgConnection) {
  return c.tls ? { rejectUnauthorized: false } : undefined;
}

async function probeNode(c: PgConnection, db: string, ep: PgEndpoint): Promise<'primary' | 'standby'> {
  const client = new Client({
    host: ep.host,
    port: ep.port,
    database: db,
    user: c.username,
    password: c.password,
    ssl: sslOf(c),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    const r = await client.query('SELECT pg_is_in_recovery() AS r');
    return r.rows[0]?.r ? 'standby' : 'primary';
  } finally {
    await client.end().catch(() => {});
  }
}

/** Node đang dùng cho connection này (đã dò + cache khi Host là cluster). */
async function resolveEndpoint(c: PgConnection, db: string, force = false): Promise<Picked> {
  const eps = parseHostList(c.host, c.port);
  if (eps.length === 1) return { ep: eps[0], role: 'primary', at: Date.now() };
  const key = `${c.id}|${c.host}|${c.port}|${db}`;
  const hit = picked.get(key);
  if (!force && hit && Date.now() - hit.at < ENDPOINT_TTL_MS) return hit;

  const results = await Promise.allSettled(eps.map((ep) => probeNode(c, db, ep)));
  let best: Picked | null = null;
  for (let i = 0; i < eps.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled') continue;
    if (r.value === 'primary') {
      best = { ep: eps[i], role: 'primary', at: Date.now() };
      break; // primary đứng đầu danh sách thắng
    }
    if (!best) best = { ep: eps[i], role: 'standby', at: Date.now() };
  }
  if (!best) {
    const why = results
      .map((r, i) => `${eps[i].host}:${eps[i].port} → ${(r as PromiseRejectedResult).reason?.message ?? 'lỗi'}`)
      .join('; ');
    throw new Error(`không kết nối được node nào trong cluster (${why})`);
  }
  picked.set(key, best);
  return best;
}

function evictIdle(now: number): void {
  for (const [key, entry] of pools) {
    if (now - entry.lastUsed > IDLE_EVICT_MS) {
      void entry.pool.end().catch(() => {});
      pools.delete(key);
    }
  }
}

/** Lazily create (or reuse) a pool for a connection + database. */
export async function getPool(conn: PgConnection, db?: string): Promise<Pool> {
  const database = (db && db.trim()) || conn.database;
  const now = Date.now();
  evictIdle(now);
  const key = `${conn.id}:${database}`;
  const { ep } = await resolveEndpoint(conn, database);
  const sig = signature(conn, database, ep);
  const existing = pools.get(key);
  if (existing && existing.sig === sig) {
    existing.lastUsed = now;
    return existing.pool;
  }
  if (existing) void existing.pool.end().catch(() => {});

  const pool = new Pool({
    host: ep.host,
    port: ep.port,
    database,
    user: conn.username,
    password: conn.password,
    ssl: sslOf(conn),
    max: 3, // interactive tool — tiny bounded pool
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 60_000,
  });
  pool.on('error', () => {}); // idle-client errors must not crash the process
  pools.set(key, { pool, sig, lastUsed: now });
  return pool;
}

/** Run a function inside a READ ONLY transaction with a statement timeout. */
export async function runReadOnly<T>(pool: Pool, fn: (q: (text: string, params?: unknown[]) => Promise<import('pg').QueryResult>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    const out = await fn((text, params) => client.query(text, params as never));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Identifier / value helpers ────────────────────────────────────────────────

/** Validate + double-quote one SQL identifier (schema/table/column/database). */
function ident(raw: unknown, label: string): string {
  const s = String(raw ?? '').trim();
  if (!s || !/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(s)) throw new Error(`invalid ${label}: "${s}"`);
  return `"${s}"`;
}

/** One row → wire JSON string (Dates become ISO strings), size-capped. */
function toWire(row: Record<string, unknown>): { json: string; truncated: boolean } {
  const json = JSON.stringify(row);
  if (json.length <= ROW_JSON_CAP) return { json, truncated: false };
  return { json: json.slice(0, ROW_JSON_CAP), truncated: true };
}

// ── Probes ────────────────────────────────────────────────────────────────────

export interface PgTestResult {
  latencyMs: number;
  /** e.g. "PostgreSQL 14.11 on x86_64…" trimmed to the version token. */
  version: string;
  database: string;
}

export async function testConnection(conn: PgConnection): Promise<PgTestResult> {
  const t0 = Date.now();
  // Test luôn dò lại cluster (force) để thấy đúng node/vai trò ở thời điểm này.
  const { ep, role } = await resolveEndpoint(conn, conn.database, true);
  const nodes = parseHostList(conn.host, conn.port).length;
  const pool = new Pool({
    host: ep.host,
    port: ep.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    ssl: sslOf(conn),
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  pool.on('error', () => {});
  try {
    const r = await pool.query('SELECT version() AS v, current_database() AS db');
    const latencyMs = Date.now() - t0;
    const full = String(r.rows[0]?.v ?? '?');
    const m = /PostgreSQL\s+([\d.]+)/.exec(full);
    return {
      latencyMs,
      version: m ? m[1] : full.slice(0, 40),
      database: String(r.rows[0]?.db ?? conn.database),
      ...(nodes > 1 ? { endpoint: `${ep.host}:${ep.port}`, role, nodes } : {}),
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ── Server health stats (Overview + Monitor) ──────────────────────────────────
//
// Mọi thứ đo được BẰNG SQL, không cần quyền superuser (thiếu quyền thì chỉ số đó
// vắng mặt chứ không làm cả lần đo hỏng): kết nối, phiên chờ lock, giao dịch/query
// chạy lâu, cache hit, dung lượng database, tuổi XID (nguy cơ wraparound), replication.
// Đĩa/RAM/CPU của MÁY thì SQL không biết — xem metricsUrls (node_exporter).

export interface PgSession {
  pid: number;
  user: string;
  db: string;
  state: string;
  /** "Lock:relation", "IO:DataFileRead"… hoặc null khi đang chạy CPU. */
  waitEvent: string | null;
  queryAgeSec: number | null;
  xactAgeSec: number | null;
  query: string;
}

export interface PgStats {
  role: 'primary' | 'standby';
  uptimeSec: number;
  maxConnections: number;
  connections: number;
  connectionsUsedPct: number;
  active: number;
  idle: number;
  idleInTx: number;
  /** Phiên đang chờ một lock. */
  lockWaiters: number;
  longestQuerySec: number | null;
  longestTxSec: number | null;
  dbSizeBytes: number | null;
  /** Tỉ lệ GẦN ĐÂY (giữa hai lần đo) — xem recentHitPct; chưa đủ số liệu thì bằng số cộng dồn. */
  cacheHitPct: number | null;
  /** Cộng dồn từ lần reset thống kê — một đợt quét lớn cũ kéo số này xuống rất lâu. */
  cacheHitTotalPct: number | null;
  /** Tích luỹ từ lần reset thống kê gần nhất. */
  deadlocks: number | null;
  tempBytes: number | null;
  /** Tuổi XID lớn nhất / 2^31 — 100% là Postgres tự dừng để chống wraparound. */
  wraparoundPct: number | null;
  sharedBuffersBytes: number | null;
  /** Primary: số replica đang nối + replay lag lớn nhất (byte). */
  replicas: number | null;
  replicaLagBytes: number | null;
  /** Standby: replay lag (giây) — 0 khi không còn gì để replay. */
  replayLagSec: number | null;
  inactiveSlots: number | null;
  slotRetainedBytes: number | null;
  sessions: PgSession[];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

// ── Cache hit GẦN ĐÂY ─────────────────────────────────────────────────────────
// blks_hit/blks_read của pg_stat_database cộng dồn từ lần reset thống kê: một
// đợt quét lớn tuần trước (hoặc lúc vừa khởi động, cache trống) kéo tỉ lệ xuống
// và giữ đó rất lâu dù hiện tại đã ổn — Monitor báo đỏ mãi. Nên lấy hiệu giữa
// hai lần đo. Mốc chỉ dời khi cửa sổ đủ HIT_MIN_BLOCKS (tải thấp thì cửa sổ cứ
// nới ra cho đủ mẫu), quá HIT_MAX_AGE_MS thì bỏ mốc cũ. Nhiều nơi cùng gọi
// stats() (tab PG + Monitor) chỉ làm cửa sổ ngắn lại, không làm sai số.
const HIT_MIN_BLOCKS = 1000;
const HIT_MAX_AGE_MS = 15 * 60 * 1000;
const hitBase = new Map<string, { hit: number; read: number; at: number; recent: number | null }>();

/** Dung lượng database đo lại thưa — xem chỗ dùng trong stats(). */
const DB_SIZE_TTL_MS = 10 * 60 * 1000;
const dbSizeCache = new Map<string, { bytes: number | null; at: number }>();

function recentHitPct(id: string, hit: number, read: number): number | null {
  const now = Date.now();
  const base = hitBase.get(id);
  // Lần đầu / counter bị reset / mốc quá cũ → đặt mốc mới, chưa có số gần đây.
  if (!base || hit < base.hit || read < base.read || now - base.at > HIT_MAX_AGE_MS) {
    hitBase.set(id, { hit, read, at: now, recent: base && now - base.at <= HIT_MAX_AGE_MS ? base.recent : null });
    return null;
  }
  const dh = hit - base.hit;
  const dr = read - base.read;
  if (dh + dr < HIT_MIN_BLOCKS) return base.recent;
  const recent = round1((dh / (dh + dr)) * 100);
  hitBase.set(id, { hit, read, at: now, recent });
  return recent;
}

export async function stats(conn: PgConnection, opts: { sessions?: boolean } = {}): Promise<PgStats> {
  const pool = await getPool(conn);
  return runReadOnly(pool, async (q) => {
    // Mỗi truy vấn "mềm": thiếu quyền / khác phiên bản → bỏ chỉ số đó, không hỏng cả lần đo.
    const soft = async (sql: string): Promise<Record<string, unknown> | null> => {
      try {
        // SAVEPOINT để một truy vấn lỗi không làm hỏng transaction của các truy vấn sau.
        await q('SAVEPOINT s');
        const r = await q(sql);
        await q('RELEASE SAVEPOINT s');
        return r.rows[0] ?? null;
      } catch {
        await q('ROLLBACK TO SAVEPOINT s').catch(() => {});
        return null;
      }
    };

    const base = await q(
      `SELECT pg_is_in_recovery() AS rec,
              extract(epoch FROM now() - pg_postmaster_start_time()) AS up,
              current_setting('max_connections')::int AS maxc`,
    );
    const b = base.rows[0] ?? {};
    const standby = !!b.rec;
    const maxConnections = num(b.maxc) ?? 0;

    const act = await soft(
      `SELECT count(*) FILTER (WHERE backend_type = 'client backend') AS total,
              count(*) FILTER (WHERE backend_type = 'client backend' AND state = 'active' AND pid <> pg_backend_pid()) AS active,
              count(*) FILTER (WHERE backend_type = 'client backend' AND state = 'idle') AS idle,
              count(*) FILTER (WHERE backend_type = 'client backend' AND state LIKE 'idle in transaction%') AS iit,
              count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiters,
              max(extract(epoch FROM now() - query_start)) FILTER (WHERE backend_type = 'client backend' AND state = 'active' AND pid <> pg_backend_pid()) AS lq,
              max(extract(epoch FROM now() - xact_start)) FILTER (WHERE backend_type = 'client backend' AND xact_start IS NOT NULL AND pid <> pg_backend_pid()) AS ltx
         FROM pg_stat_activity`,
    );
    const connections = num(act?.total) ?? 0;

    // pg_database_size đi qua TOÀN BỘ file dữ liệu (không khoá, nhưng nặng hơn một lệnh
    // thường) — Monitor đo mỗi 30s nên chỉ đo lại sau DB_SIZE_TTL_MS, giữa chừng dùng số cũ.
    const cachedSize = dbSizeCache.get(conn.id);
    const size = cachedSize && Date.now() - cachedSize.at < DB_SIZE_TTL_MS
      ? { sz: cachedSize.bytes }
      : await soft(`SELECT sum(pg_database_size(datname))::bigint AS sz FROM pg_database WHERE datallowconn`);
    if (size && (!cachedSize || Date.now() - cachedSize.at >= DB_SIZE_TTL_MS)) {
      dbSizeCache.set(conn.id, { bytes: num(size.sz), at: Date.now() });
    }
    const dbs = await soft(
      `SELECT sum(blks_hit)::bigint AS h, sum(blks_read)::bigint AS r, sum(deadlocks)::bigint AS d, sum(temp_bytes)::bigint AS t FROM pg_stat_database`,
    );
    const hit = num(dbs?.h) ?? 0;
    const read = num(dbs?.r) ?? 0;
    const wrap = await soft(`SELECT max(age(datfrozenxid)) AS a FROM pg_database`);
    const sb = await soft(`SELECT pg_size_bytes(current_setting('shared_buffers')) AS sb`);

    let replicas: number | null = null;
    let replicaLagBytes: number | null = null;
    let replayLagSec: number | null = null;
    let inactiveSlots: number | null = null;
    let slotRetainedBytes: number | null = null;
    if (standby) {
      const lag = await soft(
        `SELECT CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
                     ELSE extract(epoch FROM now() - pg_last_xact_replay_timestamp()) END AS lag`,
      );
      replayLagSec = num(lag?.lag);
    } else {
      const rep = await soft(
        `SELECT count(*) AS n, max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS lag FROM pg_stat_replication`,
      );
      replicas = num(rep?.n);
      replicaLagBytes = num(rep?.lag);
      const slots = await soft(
        `SELECT count(*) FILTER (WHERE NOT active) AS inactive,
                max(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
           FROM pg_replication_slots`,
      );
      inactiveSlots = num(slots?.inactive);
      slotRetainedBytes = num(slots?.retained);
    }

    const sessions: PgSession[] = [];
    if (opts.sessions) {
      try {
        const r = await q(
          `SELECT pid, usename, datname, state, wait_event_type, wait_event,
                  extract(epoch FROM now() - query_start) AS qage,
                  extract(epoch FROM now() - xact_start) AS xage,
                  left(query, 300) AS query
             FROM pg_stat_activity
            WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND state IS NOT NULL AND state <> 'idle'
            ORDER BY query_start ASC NULLS LAST
            LIMIT 15`,
        );
        for (const row of r.rows) {
          sessions.push({
            pid: Number(row.pid),
            user: String(row.usename ?? ''),
            db: String(row.datname ?? ''),
            state: String(row.state ?? ''),
            waitEvent: row.wait_event_type ? `${row.wait_event_type}:${row.wait_event ?? ''}` : null,
            queryAgeSec: round1(num(row.qage)),
            xactAgeSec: round1(num(row.xage)),
            query: String(row.query ?? ''),
          });
        }
      } catch {
        /* không đọc được pg_stat_activity chi tiết — bỏ phần phiên */
      }
    }

    return {
      role: standby ? 'standby' : 'primary',
      uptimeSec: Math.round(num(b.up) ?? 0),
      maxConnections,
      connections,
      connectionsUsedPct: maxConnections > 0 ? round1((connections / maxConnections) * 100) ?? 0 : 0,
      active: num(act?.active) ?? 0,
      idle: num(act?.idle) ?? 0,
      idleInTx: num(act?.iit) ?? 0,
      lockWaiters: num(act?.waiters) ?? 0,
      longestQuerySec: round1(num(act?.lq)),
      longestTxSec: round1(num(act?.ltx)),
      dbSizeBytes: num(size?.sz),
      // dbs null (thiếu quyền / lỗi) → hit=read=0 giả; không được đụng vào mốc đo.
      cacheHitPct: (dbs ? recentHitPct(conn.id, hit, read) : null) ?? (hit + read > 0 ? round1((hit / (hit + read)) * 100) : null),
      cacheHitTotalPct: hit + read > 0 ? round1((hit / (hit + read)) * 100) : null,
      deadlocks: num(dbs?.d),
      tempBytes: num(dbs?.t),
      wraparoundPct: wrap ? round1(((num(wrap.a) ?? 0) / 2147483647) * 100) : null,
      sharedBuffersBytes: num(sb?.sb),
      replicas,
      replicaLagBytes,
      replayLagSec: round1(replayLagSec),
      inactiveSlots,
      slotRetainedBytes,
      sessions,
    };
  });
}

/** node_exporter (RAM/đĩa/CPU/load) của máy chạy Postgres — rỗng nếu connection không khai metricsUrls. */
export async function hostMetrics(conn: PgConnection): Promise<HostMetrics[]> {
  return fetchHostMetrics(conn.metricsUrls ?? []);
}

export async function ping(conn: PgConnection): Promise<{ latencyMs: number }> {
  const pool = await getPool(conn);
  const t0 = Date.now();
  await pool.query('SELECT 1');
  return { latencyMs: Date.now() - t0 };
}

// ── Reads: catalog ────────────────────────────────────────────────────────────

export interface PgDatabaseInfo {
  name: string;
  sizeBytes: number;
}

export async function listDatabases(conn: PgConnection): Promise<PgDatabaseInfo[]> {
  const pool = await getPool(conn);
  return runReadOnly(pool, async (q) => {
    const r = await q(
      `SELECT datname AS name, pg_database_size(datname)::bigint AS size
         FROM pg_database
        WHERE NOT datistemplate AND datallowconn
        ORDER BY datname`,
    );
    return r.rows.map((row) => ({ name: String(row.name), sizeBytes: Number(row.size ?? 0) }));
  });
}

export interface PgTableInfo {
  schema: string;
  name: string;
  /** reltuples estimate — cheap, not exact. */
  estRows: number;
  /** Ước lượng từ pg_class.relpages (bảng + toast + index) — không xin khoá; cập nhật theo VACUUM/ANALYZE. */
  sizeBytes: number;
}

/** User tables of ONE database (system schemas excluded). */
export async function listTables(conn: PgConnection, db: string): Promise<PgTableInfo[]> {
  const pool = await getPool(conn, db);
  return runReadOnly(pool, async (q) => {
    const r = await q(
      `SELECT n.nspname AS schema, c.relname AS name,
              GREATEST(c.reltuples, 0)::bigint AS est_rows,
              -- KHÔNG dùng pg_total_relation_size: nó xin khoá TỪNG bảng (ở đây là mọi bảng
              -- một lượt) — kẹt sau một ALTER TABLE là kéo cả ứng dụng xếp hàng. Xem mục 6.
              (c.relpages::bigint + coalesce(t.relpages, 0)
                + coalesce((SELECT sum(i.relpages) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = c.oid), 0))
                * current_setting('block_size')::bigint AS size
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
        WHERE c.relkind IN ('r', 'p', 'm')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY n.nspname, c.relname`,
    );
    return r.rows.map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      estRows: Number(row.est_rows ?? 0),
      sizeBytes: Number(row.size ?? 0),
    }));
  });
}

export interface PgColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
}

export async function listColumns(conn: PgConnection, db: string, schema: string, table: string): Promise<PgColumnInfo[]> {
  const pool = await getPool(conn, db);
  return runReadOnly(pool, async (q) => {
    const r = await q(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [schema, table],
    );
    return r.rows.map((row) => ({
      name: String(row.column_name),
      dataType: String(row.data_type),
      nullable: row.is_nullable === 'YES',
      default: row.column_default === null ? null : String(row.column_default),
    }));
  });
}

export interface PgIndexInfo {
  name: string;
  definition: string;
}

export async function listIndexes(conn: PgConnection, db: string, schema: string, table: string): Promise<PgIndexInfo[]> {
  const pool = await getPool(conn, db);
  return runReadOnly(pool, async (q) => {
    const r = await q(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [schema, table],
    );
    return r.rows.map((row) => ({ name: String(row.indexname), definition: String(row.indexdef) }));
  });
}

// ── Reads: raw SQL (read-only enforced by the database) ──────────────────────

export interface PgQueryResult {
  columns: string[];
  rows: { json: string; truncated: boolean }[];
  rowCount: number;
  /** True when the row cap kicked in. */
  capped: boolean;
  tookMs: number;
}

/**
 * Run operator-authored SQL inside a READ ONLY transaction. Wrapped in a
 * LIMIT subselect when possible; unwrappable statements run as-is (still
 * read-only + statement_timeout) and are truncated after fetch.
 */
export async function query(conn: PgConnection, db: string, rawSql: unknown): Promise<PgQueryResult> {
  const sql = String(rawSql ?? '').trim().replace(/;+\s*$/, '');
  if (!sql) throw new Error('SQL trống');
  const pool = await getPool(conn, db);
  const t0 = Date.now();
  const res = await runReadOnly(pool, async (q) => {
    try {
      return await q(`SELECT * FROM (\n${sql}\n) __q LIMIT ${QUERY_ROWS_MAX + 1}`);
    } catch (e) {
      // Not wrappable (EXPLAIN/SHOW/set-returning oddities) — run as-is.
      // A syntax error in the USER's sql also lands here and will re-throw below.
      const inner = await q(sql).catch(() => { throw e instanceof Error ? e : new Error(String(e)); });
      return inner;
    }
  });
  const tookMs = Date.now() - t0;
  const all = Array.isArray(res) ? res[res.length - 1] : res;
  const rows: Record<string, unknown>[] = all.rows ?? [];
  const capped = rows.length > QUERY_ROWS_MAX;
  const kept = rows.slice(0, QUERY_ROWS_MAX);
  const columns = all.fields?.map((f: { name: string }) => f.name) ?? Object.keys(kept[0] ?? {});
  return { columns, rows: kept.map(toWire), rowCount: kept.length, capped, tookMs };
}

// ── Quick-find: structured equality search (parameterized) ───────────────────

export type PgQuickFieldType = 'text' | 'number' | 'boolean';

export interface PgQuickEntry {
  column: string;
  type: PgQuickFieldType;
  /** Raw text; list=true → comma-separated values. */
  value: string;
  list?: boolean;
}

function convertOne(column: string, type: PgQuickFieldType, raw: string): string | number | boolean {
  switch (type) {
    case 'number': {
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) throw new Error(`"${column}": "${raw}" không phải số`);
      return n;
    }
    case 'boolean': {
      if (raw !== 'true' && raw !== 'false') throw new Error(`"${column}": boolean phải là true/false`);
      return raw === 'true';
    }
    default:
      return raw;
  }
}

/** WHERE builder: one `= $n` / `= ANY($n)` per entry, implicit AND. */
function buildWhere(entries: PgQuickEntry[]): { text: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const e of entries) {
    const col = ident(e.column, 'column');
    if (e.list) {
      const items = e.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length === 0) throw new Error(`"${e.column}": list rỗng — nhập các giá trị cách nhau dấu phẩy`);
      params.push(items.map((it) => convertOne(e.column, e.type, it)));
      parts.push(`${col} = ANY($${params.length})`);
    } else {
      params.push(convertOne(e.column, e.type, e.value.trim()));
      parts.push(`${col} = $${params.length}`);
    }
  }
  if (parts.length === 0) throw new Error('Chưa có điều kiện nào — tích ít nhất 1 cột và điền giá trị.');
  return { text: parts.join(' AND '), params };
}

export interface PgQuickFindInput {
  schema: string;
  table: string;
  entries: PgQuickEntry[];
  limit?: unknown;
  offset?: unknown;
  /** Optional column allowlist to SELECT (default *). */
  columns?: unknown;
  /** Optional ORDER BY: [{ column, dir }] (tối đa 5 khoá; cột đi qua ident()). */
  sort?: unknown;
}

export async function quickFind(conn: PgConnection, db: string, input: PgQuickFindInput): Promise<PgQueryResult & { hasMore: boolean; offset: number }> {
  const schema = ident(input.schema, 'schema');
  const table = ident(input.table, 'table');
  const { text, params } = buildWhere(input.entries ?? []);
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), QUICKFIND_LIMIT_MAX);
  const offRaw = Number(input.offset);
  const offset = Math.min(Math.max(Number.isInteger(offRaw) ? offRaw : 0, 0), 1_000_000);
  const cols = Array.isArray(input.columns) && input.columns.length
    ? input.columns.map((c) => ident(c, 'column')).join(', ')
    : '*';

  // ORDER BY: cột qua ident() (chặn injection), chiều chỉ nhận desc/asc. Không sort = thứ tự tự nhiên của PG.
  const orderKeys = (Array.isArray(input.sort) ? input.sort : []).slice(0, 5).flatMap((s) => {
    const o = (s ?? {}) as { column?: unknown; dir?: unknown };
    if (typeof o.column !== 'string' || !o.column.trim()) return [];
    return [`${ident(o.column, 'column')} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`];
  });
  const orderBy = orderKeys.length ? ` ORDER BY ${orderKeys.join(', ')}` : '';

  const pool = await getPool(conn, db);
  const t0 = Date.now();
  const res = await runReadOnly(pool, (q) =>
    q(`SELECT ${cols} FROM ${schema}.${table} WHERE ${text}${orderBy} LIMIT ${limit + 1} OFFSET ${offset}`, params),
  );
  const tookMs = Date.now() - t0;
  const rows: Record<string, unknown>[] = res.rows ?? [];
  const hasMore = rows.length > limit;
  const kept = rows.slice(0, limit);
  const columns = res.fields?.map((f) => f.name) ?? Object.keys(kept[0] ?? {});
  return { columns, rows: kept.map(toWire), rowCount: kept.length, capped: false, hasMore, offset, tookMs };
}

/** Dry-run count for the quick-find entries (also powers the update modal). */
export async function quickCount(conn: PgConnection, db: string, input: Omit<PgQuickFindInput, 'limit' | 'offset' | 'columns' | 'sort'>): Promise<{ count: number; tookMs: number }> {
  const schema = ident(input.schema, 'schema');
  const table = ident(input.table, 'table');
  const { text, params } = buildWhere(input.entries ?? []);
  const pool = await getPool(conn, db);
  const t0 = Date.now();
  const res = await runReadOnly(pool, (q) => q(`SELECT count(*)::bigint AS n FROM ${schema}.${table} WHERE ${text}`, params));
  return { count: Number(res.rows[0]?.n ?? 0), tookMs: Date.now() - t0 };
}

// ── The ONE write: UPDATE with a mandatory WHERE ─────────────────────────────

export interface PgUpdateInput {
  schema: string;
  table: string;
  /** SET pairs — values parameterized; type picks the conversion. */
  set: { column: string; type: PgQuickFieldType | 'null'; value: string }[];
  /** Raw WHERE text (without the WHERE keyword) — MANDATORY, non-empty. */
  where: string;
}

export interface PgUpdateResult {
  updated: number;
}

/**
 * The ONLY write this tool exposes: a single-table UPDATE with
 *   - a NON-EMPTY WHERE clause (a blind table-wide write is refused),
 *   - parameterized SET values on validated column identifiers,
 *   - no second statement (';' rejected inside the WHERE text).
 * Gate order: PG_ALLOW_WRITE env → per-connection readOnly → validation.
 * Runs with a statement timeout. Every call is audit-logged to stdout.
 */
export async function updateWithWhere(conn: PgConnection, db: string, input: PgUpdateInput): Promise<PgUpdateResult> {
  if (!PG_ALLOW_WRITE) {
    throw new Error('Writes are disabled for the whole tool. Set PG_ALLOW_WRITE=true in .env.local (local dev only).');
  }
  if (conn.readOnly) {
    throw new Error(`Connection "${conn.name}" is read-only. Edit the connection and untick read-only to arm writes.`);
  }
  const schema = ident(input.schema, 'schema');
  const table = ident(input.table, 'table');

  const where = String(input.where ?? '').trim();
  if (!where) throw new Error('UPDATE requires a NON-EMPTY WHERE — a table-wide blind update is not allowed');
  if (where.includes(';')) throw new Error('WHERE must be a single condition — ";" is not allowed');

  const set = Array.isArray(input.set) ? input.set : [];
  if (set.length === 0) throw new Error('SET is empty — add at least one column');
  const assigns: string[] = [];
  const params: unknown[] = [];
  for (const s of set) {
    const col = ident(s.column, 'column');
    if (s.type === 'null') {
      assigns.push(`${col} = NULL`);
    } else {
      params.push(convertOne(s.column, s.type, String(s.value ?? '').trim()));
      assigns.push(`${col} = $${params.length}`);
    }
  }

  const pool = await getPool(conn, db);
  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`);
    // Hàng đang bị ứng dụng giữ khoá → bỏ ngay, không chờ (và không giữ khoá của ta lâu).
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    const res = await client.query(`UPDATE ${schema}.${table} SET ${assigns.join(', ')} WHERE ${where}`, params);
    updated = res.rowCount ?? 0;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Audit line → server stdout (same convention as MONGO_AUDIT / REDIS_AUDIT).
  // eslint-disable-next-line no-console
  console.log(
    `PG_AUDIT operation=UPDATE connection=${conn.name} target=${db || conn.database}.${input.schema}.${input.table} ` +
    `set=${sanitize(set.map((s) => s.column).join(','))} where=${sanitize(where)} updated=${updated} ts=${new Date().toISOString()}`,
  );
  return { updated };
}

// ── Thực thi SQL tự do (INSERT / UPDATE / DELETE / DDL) ──────────────────────
//
// Màn "⚡ Thực thi SQL" — cùng hai cổng với UPDATE ở trên (PG_ALLOW_WRITE +
// readOnly của connection). Cả khối chạy trong MỘT transaction do tool mở:
//   · commit=false → CHẠY THỬ: thực thi thật rồi ROLLBACK — biết chính xác số
//     dòng bị ảnh hưởng / lỗi gì trước khi ghi. (Sequence đã nextval thì
//     không lùi lại — PG vốn vậy.)
//   · commit=true  → thực thi rồi COMMIT. Ghi audit như UPDATE.
// Lệnh điều khiển transaction (BEGIN/COMMIT/ROLLBACK/…) bị từ chối: một COMMIT
// lọt vào giữa sẽ biến "chạy thử" thành ghi thật. Lệnh không chạy được trong
// transaction (VACUUM, CREATE INDEX CONCURRENTLY, CREATE DATABASE) thì PG tự
// báo lỗi — tool này không hỗ trợ chúng.

export interface PgExecStatement {
  /** INSERT / UPDATE / DELETE / CREATE / ALTER / SELECT … (do PG trả về). */
  command: string;
  rowCount: number | null;
}

export interface PgExecResult extends PgQueryResult {
  committed: boolean;
  statements: PgExecStatement[];
}

const TX_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE|START|PREPARE|SET\s+TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS)\b/i;

/**
 * Tách câu SQL thành từng lệnh, bỏ qua `;` nằm trong chuỗi '…', định danh "…",
 * chuỗi $tag$…$tag$ và comment. Chỉ dùng để soát từ khoá đầu mỗi lệnh — câu
 * gửi lên PG vẫn là nguyên văn người dùng gõ.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
      cur += ' ';
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      cur += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      // E'…' cho phép \' — không tính thì máy tách lệnh lệch pha với PG.
      const esc = ch === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (esc && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end < 0 ? sql.length : end + m[0].length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Lệnh điều khiển transaction đầu tiên trong danh sách (null = không có). */
export function txControlStatement(stmts: string[]): string | null {
  return stmts.find((s) => TX_CONTROL.test(s)) ?? null;
}

export async function executeSql(conn: PgConnection, db: string, rawSql: unknown, commit: boolean): Promise<PgExecResult> {
  if (!PG_ALLOW_WRITE) {
    throw new Error('Writes are disabled for the whole tool. Set PG_ALLOW_WRITE=true in .env.local (local dev only).');
  }
  if (conn.readOnly) {
    throw new Error(`Connection "${conn.name}" is read-only. Edit the connection and untick read-only to arm writes.`);
  }
  const sql = String(rawSql ?? '').trim();
  const stmts = splitStatements(sql);
  if (stmts.length === 0) throw new Error('SQL trống');
  const bad = txControlStatement(stmts);
  if (bad) {
    throw new Error(`Không cho phép lệnh điều khiển transaction ("${bad.split(/\s+/)[0]}") — tool tự mở transaction và tự COMMIT/ROLLBACK.`);
  }

  const pool = await getPool(conn, db);
  const client = await pool.connect();
  const t0 = Date.now();
  let results: import('pg').QueryResult[];
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    // Không bind param → simple query protocol → chạy được nhiều lệnh một lượt,
    // node-pg trả về mảng kết quả theo từng lệnh.
    const res = await client.query(sql) as unknown as import('pg').QueryResult | import('pg').QueryResult[];
    results = Array.isArray(res) ? res : [res];
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const tookMs = Date.now() - t0;

  const statements = results.map((r) => ({ command: r.command ?? '?', rowCount: r.rowCount ?? null }));
  // Lưới kết quả = lệnh cuối có trả dòng (SELECT / … RETURNING).
  const withRows = [...results].reverse().find((r) => (r.fields?.length ?? 0) > 0);
  const rows: Record<string, unknown>[] = withRows?.rows ?? [];
  const capped = rows.length > QUERY_ROWS_MAX;
  const kept = rows.slice(0, QUERY_ROWS_MAX);
  const columns = withRows?.fields?.map((f) => f.name) ?? [];

  if (commit) {
    // eslint-disable-next-line no-console
    console.log(
      `PG_AUDIT operation=EXEC connection=${conn.name} db=${db || conn.database} ` +
      `statements=${sanitize(statements.map((s) => `${s.command}:${s.rowCount ?? '-'}`).join(','))} ` +
      `sql=${sanitize(sql)} ts=${new Date().toISOString()}`,
    );
  }
  return { columns, rows: kept.map(toWire), rowCount: kept.length, capped, tookMs, committed: commit, statements };
}

/** Dry-run count for a raw WHERE (update modal). Read-only tx. */
export async function countWhere(conn: PgConnection, db: string, schemaRaw: unknown, tableRaw: unknown, whereRaw: unknown): Promise<{ count: number }> {
  const schema = ident(schemaRaw, 'schema');
  const table = ident(tableRaw, 'table');
  const where = String(whereRaw ?? '').trim();
  if (!where) throw new Error('WHERE trống');
  if (where.includes(';')) throw new Error('WHERE must be a single condition — ";" is not allowed');
  const pool = await getPool(conn, db);
  const res = await runReadOnly(pool, (q) => q(`SELECT count(*)::bigint AS n FROM ${schema}.${table} WHERE ${where}`));
  return { count: Number(res.rows[0]?.n ?? 0) };
}

/** Strip control chars + cap length so crafted SQL can't inject into the audit log line. */
function sanitize(s: string): string {
  let out = '';
  for (const ch of s.slice(0, 500)) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? '?' : ch;
  }
  return out;
}
