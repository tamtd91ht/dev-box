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
//   5. Identifiers (database/schema/table/column) are validated + quoted;
//      values travel as bind parameters, never concatenated.

import { Pool, types } from 'pg';
import type { PgConnection } from '@/lib/pgConnections';

// int8/numeric come back as strings by default — keep them as strings (exact),
// the UI/report layer decides how to render. (No parser overrides needed.)
void types;

export const PG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.PG_TOOL_ENABLED ?? '');
/** Global write gate — even when on, per-connection readOnly still applies. */
export const PG_ALLOW_WRITE = /^(1|true|yes|on)$/i.test(process.env.PG_ALLOW_WRITE ?? '');

export const QUERY_ROWS_MAX = 500;
export const QUICKFIND_LIMIT_MAX = 200;
const STMT_TIMEOUT_MS = 15_000;
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

function signature(c: PgConnection, db: string): string {
  return [c.host, c.port, db, c.username, c.tls].join('|');
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
function getPool(conn: PgConnection, db?: string): Pool {
  const database = (db && db.trim()) || conn.database;
  const now = Date.now();
  evictIdle(now);
  const key = `${conn.id}:${database}`;
  const sig = signature(conn, database);
  const existing = pools.get(key);
  if (existing && existing.sig === sig) {
    existing.lastUsed = now;
    return existing.pool;
  }
  if (existing) void existing.pool.end().catch(() => {});

  const pool = new Pool({
    host: conn.host,
    port: conn.port,
    database,
    user: conn.username,
    password: conn.password,
    ssl: conn.tls ? { rejectUnauthorized: false } : undefined,
    max: 3, // interactive tool — tiny bounded pool
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 60_000,
  });
  pool.on('error', () => {}); // idle-client errors must not crash the process
  pools.set(key, { pool, sig, lastUsed: now });
  return pool;
}

/** Run a function inside a READ ONLY transaction with a statement timeout. */
async function runReadOnly<T>(pool: Pool, fn: (q: (text: string, params?: unknown[]) => Promise<import('pg').QueryResult>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`);
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
  const pool = new Pool({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    ssl: conn.tls ? { rejectUnauthorized: false } : undefined,
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  pool.on('error', () => {});
  const t0 = Date.now();
  try {
    const r = await pool.query('SELECT version() AS v, current_database() AS db');
    const latencyMs = Date.now() - t0;
    const full = String(r.rows[0]?.v ?? '?');
    const m = /PostgreSQL\s+([\d.]+)/.exec(full);
    return { latencyMs, version: m ? m[1] : full.slice(0, 40), database: String(r.rows[0]?.db ?? conn.database) };
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function ping(conn: PgConnection): Promise<{ latencyMs: number }> {
  const pool = getPool(conn);
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
  const pool = getPool(conn);
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
  sizeBytes: number;
}

/** User tables of ONE database (system schemas excluded). */
export async function listTables(conn: PgConnection, db: string): Promise<PgTableInfo[]> {
  const pool = getPool(conn, db);
  return runReadOnly(pool, async (q) => {
    const r = await q(
      `SELECT n.nspname AS schema, c.relname AS name,
              GREATEST(c.reltuples, 0)::bigint AS est_rows,
              pg_total_relation_size(c.oid)::bigint AS size
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
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
  const pool = getPool(conn, db);
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
  const pool = getPool(conn, db);
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
  const pool = getPool(conn, db);
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

  const pool = getPool(conn, db);
  const t0 = Date.now();
  const res = await runReadOnly(pool, (q) =>
    q(`SELECT ${cols} FROM ${schema}.${table} WHERE ${text} LIMIT ${limit + 1} OFFSET ${offset}`, params),
  );
  const tookMs = Date.now() - t0;
  const rows: Record<string, unknown>[] = res.rows ?? [];
  const hasMore = rows.length > limit;
  const kept = rows.slice(0, limit);
  const columns = res.fields?.map((f) => f.name) ?? Object.keys(kept[0] ?? {});
  return { columns, rows: kept.map(toWire), rowCount: kept.length, capped: false, hasMore, offset, tookMs };
}

/** Dry-run count for the quick-find entries (also powers the update modal). */
export async function quickCount(conn: PgConnection, db: string, input: Omit<PgQuickFindInput, 'limit' | 'offset' | 'columns'>): Promise<{ count: number; tookMs: number }> {
  const schema = ident(input.schema, 'schema');
  const table = ident(input.table, 'table');
  const { text, params } = buildWhere(input.entries ?? []);
  const pool = getPool(conn, db);
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

  const pool = getPool(conn, db);
  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`);
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

/** Dry-run count for a raw WHERE (update modal). Read-only tx. */
export async function countWhere(conn: PgConnection, db: string, schemaRaw: unknown, tableRaw: unknown, whereRaw: unknown): Promise<{ count: number }> {
  const schema = ident(schemaRaw, 'schema');
  const table = ident(tableRaw, 'table');
  const where = String(whereRaw ?? '').trim();
  if (!where) throw new Error('WHERE trống');
  if (where.includes(';')) throw new Error('WHERE must be a single condition — ";" is not allowed');
  const pool = getPool(conn, db);
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
