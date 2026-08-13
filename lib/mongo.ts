// Client-side helpers + shared types for the MongoDB workspace. All calls go to
// the same-origin /api/mongo* routes (the Next server holds the driver client —
// the browser never connects to MongoDB directly). This file is browser-safe:
// NO `fs`, NO `mongodb`, no server-only imports.

export type MongoScheme = 'mongodb' | 'mongodb+srv';

/** A connection as returned to the browser — password is never sent, only its presence. */
export interface PublicMongoConnection {
  id: string;
  name: string;
  project: string;
  scheme: MongoScheme;
  hosts: string[];
  replicaSet?: string;
  authSource?: string;
  username?: string;
  tls: boolean;
  directConnection: boolean;
  readOnly: boolean;
  hasPassword: boolean;
}

export interface MongoConnectionsResponse {
  enabled: boolean;
  /** MONGO_ALLOW_WRITE env flag — false greys out every write control up front. */
  allowWrite: boolean;
  connections: PublicMongoConnection[];
}

export interface TestResult {
  latencyMs: number;
  version: string;
  topology: string;
}

export interface ServerInfoResult extends TestResult {
  hosts: string[];
}

export interface MongoMemberStats {
  name: string;
  state: string;
  healthy: boolean;
  lagSec: number | null;
}

export interface MongoMonitorResult {
  uptimeSec: number;
  memResidentBytes: number;
  memVirtualBytes: number;
  fsUsedBytes: number | null;
  fsTotalBytes: number | null;
  connectionsCurrent: number;
  connectionsAvailable: number;
  cacheUsedBytes: number;
  cacheMaxBytes: number;
  opcounters: { insert: number; query: number; update: number; delete: number; command: number };
  at: number;
  members: MongoMemberStats[];
}

export interface DatabaseInfo {
  name: string;
  sizeOnDisk: number;
  empty: boolean;
}

export interface CollectionInfo {
  name: string;
  type: string;
}

export interface CollStatsResult {
  count: number;
  size: number;
  storageSize: number;
  avgObjSize: number;
  nindexes: number;
  totalIndexSize: number;
}

export interface IndexInfo {
  name: string;
  keyJson: string;
  unique: boolean;
  sparse: boolean;
  ttlSeconds?: number;
  partial: boolean;
}

export interface FieldInfo {
  path: string;
  type: string;
  seen: number;
}

export interface WireDoc {
  json: string;
  truncated: boolean;
}

export interface FindResult {
  docs: WireDoc[];
  limit: number;
  skip: number;
  hasMore: boolean;
  tookMs: number;
}

export interface CountResult {
  count: number;
  estimated: boolean;
  tookMs: number;
}

export interface AggregateResult {
  docs: WireDoc[];
  capped: boolean;
  tookMs: number;
}

export interface UpdateResult {
  matched: number;
  modified: number;
  mode: 'one' | 'many';
}

// ── Connection registry (CRUD) ────────────────────────────────────────────────

/** GET the connection list — never throws; returns disabled on any error. */
export async function fetchMongoConnections(): Promise<MongoConnectionsResponse> {
  try {
    const r = await fetch('/api/mongo-connections');
    if (!r.ok) return { enabled: false, allowWrite: false, connections: [] };
    return (await r.json()) as MongoConnectionsResponse;
  } catch {
    return { enabled: false, allowWrite: false, connections: [] };
  }
}

/** POST/PUT/DELETE a connection mutation. Throws Error(message) on a non-2xx. */
export async function mutateMongoConnection(
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<PublicMongoConnection[]> {
  const r = await fetch('/api/mongo-connections', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { connections: PublicMongoConnection[] }).connections;
}

// ── MongoDB operations ────────────────────────────────────────────────────────

/** POST one Mongo action. Throws Error(message) on a non-2xx (surfaces the driver error). */
async function mongoAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/mongo', {
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

/** Test a not-yet-saved connection straight from the form. */
export function testMongoConnection(input: {
  scheme: MongoScheme;
  hosts: string;
  replicaSet?: string;
  authSource?: string;
  username?: string;
  password?: string;
  tls?: boolean;
  directConnection?: boolean;
}): Promise<TestResult> {
  return mongoAction<TestResult>('test', input);
}

export function pingMongo(connectionId: string): Promise<{ latencyMs: number }> {
  return mongoAction<{ latencyMs: number }>('ping', { connectionId });
}

export function mongoServerInfo(connectionId: string): Promise<ServerInfoResult> {
  return mongoAction<ServerInfoResult>('serverInfo', { connectionId });
}

export function mongoMonitor(connectionId: string): Promise<MongoMonitorResult> {
  return mongoAction<MongoMonitorResult>('monitor', { connectionId });
}

export function listMongoDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  return mongoAction<DatabaseInfo[]>('databases', { connectionId });
}

export function listMongoCollections(connectionId: string, db: string): Promise<CollectionInfo[]> {
  return mongoAction<CollectionInfo[]>('collections', { connectionId, db });
}

export function mongoCollectionStats(connectionId: string, db: string, coll: string): Promise<CollStatsResult> {
  return mongoAction<CollStatsResult>('stats', { connectionId, db, coll });
}

export function listMongoIndexes(connectionId: string, db: string, coll: string): Promise<IndexInfo[]> {
  return mongoAction<IndexInfo[]>('indexes', { connectionId, db, coll });
}

/** Sampled field paths of a collection — powers the query-bar autocomplete. */
export function sampleMongoFields(connectionId: string, db: string, coll: string): Promise<FieldInfo[]> {
  return mongoAction<FieldInfo[]>('fields', { connectionId, db, coll });
}

export interface FindParams {
  filter: string;
  projection: string;
  sort: string;
  limit: number;
  skip: number;
}

export function findMongo(connectionId: string, db: string, coll: string, p: FindParams): Promise<FindResult> {
  return mongoAction<FindResult>('find', { connectionId, db, coll, ...p });
}

export function countMongo(connectionId: string, db: string, coll: string, filter: string): Promise<CountResult> {
  return mongoAction<CountResult>('count', { connectionId, db, coll, filter });
}

export function aggregateMongo(connectionId: string, db: string, coll: string, pipeline: string): Promise<AggregateResult> {
  return mongoAction<AggregateResult>('aggregate', { connectionId, db, coll, pipeline });
}

export function updateMongo(
  connectionId: string,
  db: string,
  coll: string,
  p: { filter: string; update: string; mode: 'one' | 'many' },
): Promise<UpdateResult> {
  return mongoAction<UpdateResult>('update', { connectionId, db, coll, ...p });
}

// ── Small shared formatters (used by the workspace UI) ───────────────────────

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}

/** Pretty-print one wire document (relaxed EJSON string) for display. */
export function prettyDoc(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json; // truncated docs are not valid JSON — show raw
  }
}

// ── Query-bar JSON formatting ────────────────────────────────────────────────
// The query boxes accept what people actually paste: shell-style objects with
// unquoted keys, single quotes and trailing commas. `relaxedJsonParse` accepts
// those without ever calling eval — it rewrites the text into strict JSON, then
// hands it to JSON.parse (which stays the only thing that interprets it).

/** Rewrite lenient JSON5-ish text into strict JSON. Strings are copied verbatim. */
function strictify(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    // Strings: copy through, converting '…' to "…" with proper escaping.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let body = '';
      i++;
      for (; i < src.length && src[i] !== quote; i++) {
        if (src[i] === '\\') { body += src[i] + (src[i + 1] ?? ''); i++; continue; }
        body += src[i];
      }
      if (quote === '"') {
        out += `"${body}"`;
      } else {
        // Re-quoting '…' as "…": bare `"` must gain an escape, and `\'` must
        // lose one (\' is not a legal JSON escape).
        out += `"${body.replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"')}"`;
      }
      continue;
    }

    // Line / block comments — drop them.
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }

    // Bare identifier: a key (→ quote it) or a literal like true/null (→ keep).
    if (/[A-Za-z_$]/.test(ch)) {
      let word = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) { word += src[i]; i++; }
      const rest = src.slice(i);
      const isKey = /^\s*:/.test(rest);
      out += isKey ? `"${word}"` : word;
      i--;
      continue;
    }

    // Trailing comma before a closer.
    if (ch === ',' && /^\s*[}\]]/.test(src.slice(i + 1))) continue;

    out += ch;
  }
  return out;
}

/** Parse lenient JSON text. Throws the underlying SyntaxError when unfixable. */
export function relaxedJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (first) {
    try {
      return JSON.parse(strictify(text));
    } catch {
      throw first; // report the original, more meaningful position
    }
  }
}

export interface FormatResult {
  text: string;
  error: string | null;
}

/**
 * Pretty-print a query box. Empty text stays empty; invalid text is returned
 * unchanged with the parser message so the field never eats what you typed.
 */
export function formatJsonInput(text: string, indent = 2): FormatResult {
  if (!text.trim()) return { text, error: null };
  try {
    return { text: JSON.stringify(relaxedJsonParse(text), null, indent), error: null };
  } catch (e) {
    return { text, error: (e as Error).message };
  }
}

/** Collapse a query box onto one line (the inverse of Format). */
export function minifyJsonInput(text: string): FormatResult {
  if (!text.trim()) return { text, error: null };
  try {
    return { text: JSON.stringify(relaxedJsonParse(text)), error: null };
  } catch (e) {
    return { text, error: (e as Error).message };
  }
}
