// Client-side helpers + shared types for the PostgreSQL workspace. All calls
// go to the same-origin /api/pg* routes (the Next server holds the pg pools —
// the browser never connects to PostgreSQL directly). Browser-safe module.

export interface PublicPgConnection {
  id: string;
  name: string;
  project: string;
  host: string;
  port: number;
  database: string;
  username: string;
  tls: boolean;
  readOnly: boolean;
  hasPassword: boolean;
}

export interface PgConnectionsResponse {
  enabled: boolean;
  /** PG_ALLOW_WRITE env flag — false greys out every write control up front. */
  allowWrite: boolean;
  connections: PublicPgConnection[];
}

export interface PgTestResult {
  latencyMs: number;
  version: string;
  database: string;
}

export interface PgDatabaseInfo {
  name: string;
  sizeBytes: number;
}

export interface PgTableInfo {
  schema: string;
  name: string;
  estRows: number;
  sizeBytes: number;
}

export interface PgColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
}

export interface PgIndexInfo {
  name: string;
  definition: string;
}

export interface WireRow {
  json: string;
  truncated: boolean;
}

export interface PgQueryResult {
  columns: string[];
  rows: WireRow[];
  rowCount: number;
  capped: boolean;
  tookMs: number;
}

export interface PgQuickFindResult extends PgQueryResult {
  hasMore: boolean;
  offset: number;
}

export type PgQuickFieldType = 'text' | 'number' | 'boolean';

export interface PgQuickEntry {
  column: string;
  type: PgQuickFieldType;
  value: string;
  list?: boolean;
}

export interface PgUpdateSet {
  column: string;
  type: PgQuickFieldType | 'null';
  value: string;
}

// ── Connection registry (CRUD) ────────────────────────────────────────────────

export async function fetchPgConnections(): Promise<PgConnectionsResponse> {
  try {
    const r = await fetch('/api/pg-connections');
    if (!r.ok) return { enabled: false, allowWrite: false, connections: [] };
    return (await r.json()) as PgConnectionsResponse;
  } catch {
    return { enabled: false, allowWrite: false, connections: [] };
  }
}

export async function mutatePgConnection(
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<PublicPgConnection[]> {
  const r = await fetch('/api/pg-connections', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { connections: PublicPgConnection[] }).connections;
}

// ── PG operations ─────────────────────────────────────────────────────────────

async function pgAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/pg', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

export function testPgConnection(input: {
  host: string; port: number | string; database: string; username: string; password?: string; tls?: boolean;
}): Promise<PgTestResult> {
  return pgAction<PgTestResult>('test', input);
}

export function pingPg(connectionId: string): Promise<{ latencyMs: number }> {
  return pgAction<{ latencyMs: number }>('ping', { connectionId });
}

/** Version + latency of a SAVED connection (Overview card). */
export function pgInfo(connectionId: string): Promise<PgTestResult> {
  return pgAction<PgTestResult>('info', { connectionId });
}

export function listPgDatabases(connectionId: string): Promise<PgDatabaseInfo[]> {
  return pgAction<PgDatabaseInfo[]>('databases', { connectionId });
}

export function listPgTables(connectionId: string, db: string): Promise<PgTableInfo[]> {
  return pgAction<PgTableInfo[]>('tables', { connectionId, db });
}

export function listPgColumns(connectionId: string, db: string, schema: string, table: string): Promise<PgColumnInfo[]> {
  return pgAction<PgColumnInfo[]>('columns', { connectionId, db, schema, table });
}

export function listPgIndexes(connectionId: string, db: string, schema: string, table: string): Promise<PgIndexInfo[]> {
  return pgAction<PgIndexInfo[]>('indexes', { connectionId, db, schema, table });
}

export function queryPg(connectionId: string, db: string, sql: string): Promise<PgQueryResult> {
  return pgAction<PgQueryResult>('query', { connectionId, db, sql });
}

export function pgQuickFind(
  connectionId: string,
  db: string,
  p: { schema: string; table: string; entries: PgQuickEntry[]; limit: number; offset: number; columns?: string[] },
): Promise<PgQuickFindResult> {
  return pgAction<PgQuickFindResult>('quickFind', { connectionId, db, ...p });
}

export function pgQuickCount(
  connectionId: string,
  db: string,
  p: { schema: string; table: string; entries: PgQuickEntry[] },
): Promise<{ count: number; tookMs: number }> {
  return pgAction<{ count: number; tookMs: number }>('quickCount', { connectionId, db, ...p });
}

export function pgCountWhere(connectionId: string, db: string, schema: string, table: string, where: string): Promise<{ count: number }> {
  return pgAction<{ count: number }>('countWhere', { connectionId, db, schema, table, where });
}

export function pgUpdate(
  connectionId: string,
  db: string,
  p: { schema: string; table: string; set: PgUpdateSet[]; where: string },
): Promise<{ updated: number }> {
  return pgAction<{ updated: number }>('update', { connectionId, db, ...p });
}

// ── Shared formatters ─────────────────────────────────────────────────────────

export { fmtBytes, fmtCount, prettyDoc } from '@/lib/mongo';
