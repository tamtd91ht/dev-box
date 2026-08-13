// Server-only MongoDB operations for the local Mongo-manager workspace.
//
// SECURITY / SAFETY MODEL — this connects to real MongoDB deployments (possibly
// production ones) from the machine hosting the Next.js server, so it is
// deliberately constrained and gated off in any deploy:
//   1. Gated by MONGO_TOOL_ENABLED — the API routes 403 unless it is truthy. A
//      k8s/production deployment never sets it, so the feature is off there.
//   2. READS are unrestricted in scope but bounded in cost: every query carries
//      maxTimeMS, find results are capped per page (cursor-paged via skip/limit),
//      aggregations refuse $out/$merge/$function/$accumulator and get a hard
//      $limit appended (read-only pipelines only).
//   3. WRITES are update-with-query ONLY: updateOne/updateMany with a NON-EMPTY
//      filter and $-operator update documents. No insert, no delete, no drop, no
//      replace, no upsert. Three independent gates: MONGO_ALLOW_WRITE env flag +
//      per-connection readOnly (defaults true) + typed-confirm modal in the UI.
//      Every update is audit-logged to stdout (MONGO_AUDIT lines).
//   4. `$where` (arbitrary server-side JS) is rejected anywhere in any filter —
//      project rule input-validation-sanitization.
//
// Filters/updates/pipelines from the client are parsed with EJSON (accepts plain
// JSON too, plus {$oid}, {$date}, …) and passed to the driver as BSON documents —
// never concatenated into command strings.

import { MongoClient, BSON, type Document, type Sort } from 'mongodb';
import type { MongoConnection } from '@/lib/mongoConnections';

export const MONGO_ENABLED = /^(1|true|yes|on)$/i.test(process.env.MONGO_TOOL_ENABLED ?? '');
/** Global write gate — even when on, per-connection readOnly still applies. */
export const MONGO_ALLOW_WRITE = /^(1|true|yes|on)$/i.test(process.env.MONGO_ALLOW_WRITE ?? '');

/** Max documents returned per find page (UI can page with skip). */
export const FIND_LIMIT_MAX = 200;
export const FIND_LIMIT_DEFAULT = 50;
/** Hard cap appended to every aggregation pipeline. */
export const AGGREGATE_LIMIT = 500;
/** Query budget — interactive tool, bounded queries (mongodb-query-timeout). */
const MAX_TIME_FIND_MS = 15_000;
const MAX_TIME_AGGREGATE_MS = 30_000;
const MAX_TIME_ADMIN_MS = 10_000;
/** Rendered document guard: one huge doc must not freeze the browser tab. */
const DOC_JSON_CAP = 200_000; // chars of EJSON per document
/** Drop cached clients unused for longer than this. */
const IDLE_EVICT_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 5000;

// ── URI + client cache ────────────────────────────────────────────────────────

/** Build a driver URI from the stored fields (credentials URL-encoded). */
export function buildUri(c: MongoConnection): string {
  const cred = c.username
    ? `${encodeURIComponent(c.username)}:${encodeURIComponent(c.password ?? '')}@`
    : '';
  const params = new URLSearchParams();
  if (c.replicaSet) params.set('replicaSet', c.replicaSet);
  if (c.authSource && c.username) params.set('authSource', c.authSource);
  if (c.tls) params.set('tls', 'true');
  if (c.directConnection && c.scheme === 'mongodb') params.set('directConnection', 'true');
  const qs = params.toString();
  return `${c.scheme}://${cred}${c.hosts.join(',')}/${qs ? `?${qs}` : ''}`;
}

interface Cached {
  client: MongoClient;
  /** Connection-profile signature — recreate the client when the profile changes. */
  sig: string;
  lastUsed: number;
}
const clients = new Map<string, Cached>();

function signature(c: MongoConnection): string {
  return [c.scheme, c.hosts.join(','), c.replicaSet ?? '', c.username ?? '', c.authSource ?? '', c.tls, c.directConnection].join('|');
}

function evictIdle(now: number): void {
  for (const [id, entry] of clients) {
    if (now - entry.lastUsed > IDLE_EVICT_MS) {
      void entry.client.close().catch(() => {});
      clients.delete(id);
    }
  }
}

/** Lazily create (or reuse) a MongoClient for a connection profile. */
function getClient(conn: MongoConnection): MongoClient {
  const now = Date.now();
  evictIdle(now);
  const sig = signature(conn);
  const existing = clients.get(conn.id);
  if (existing && existing.sig === sig) {
    existing.lastUsed = now;
    return existing.client;
  }
  if (existing) void existing.client.close().catch(() => {}); // profile changed → drop stale client

  const client = new MongoClient(buildUri(conn), {
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    maxPoolSize: 5, // interactive tool — tiny bounded pool
    retryWrites: false,
  });
  clients.set(conn.id, { client, sig, lastUsed: now });
  return client;
}

/** Truy cập MongoClient thô (tái dùng pool cache ở trên) cho các TÍNH NĂNG NỘI
 *  BỘ khác của DevBox — hiện là kho Công việc (lib/workTasks): ghi vào một
 *  collection riêng do người dùng chủ đích cấu hình, KHÔNG đi qua gate
 *  readOnly của tool duyệt Mongo (gate đó bảo vệ thao tác sửa DỮ LIỆU CỦA
 *  CỤM từ UI duyệt, không áp cho kho lưu trữ riêng của app). */
export function internalClient(conn: MongoConnection): MongoClient {
  return getClient(conn);
}

// ── EJSON parsing + safety scans ──────────────────────────────────────────────

/** Parse a client-supplied EJSON/JSON string (or pass through an object). */
function parseDoc(raw: unknown, label: string): Document {
  let doc: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return {};
    try {
      doc = BSON.EJSON.parse(s);
    } catch (e) {
      throw new Error(`${label} is not valid JSON/EJSON: ${(e as Error).message}`);
    }
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${label} must be a JSON object`);
  return doc as Document;
}

/** Parse a client-supplied EJSON/JSON string into an array (for pipelines). */
function parseArray(raw: unknown, label: string): Document[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      arr = BSON.EJSON.parse(s);
    } catch (e) {
      throw new Error(`${label} is not valid JSON/EJSON: ${(e as Error).message}`);
    }
  }
  if (!Array.isArray(arr)) throw new Error(`${label} must be a JSON array`);
  return arr as Document[];
}

/** Reject a key anywhere in a document tree (e.g. $where — server-side JS). */
function forbidKeyDeep(doc: unknown, forbidden: string[], label: string, depth = 0): void {
  if (depth > 20 || doc === null || typeof doc !== 'object') return;
  if (Array.isArray(doc)) {
    for (const item of doc) forbidKeyDeep(item, forbidden, label, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (forbidden.includes(k)) throw new Error(`${label}: operator "${k}" is not allowed in this tool`);
    forbidKeyDeep(v, forbidden, label, depth + 1);
  }
}

const FILTER_FORBIDDEN = ['$where', '$function', '$accumulator'];

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return FIND_LIMIT_DEFAULT;
  return Math.min(n, FIND_LIMIT_MAX);
}

function clampSkip(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, 1_000_000);
}

function requireName(raw: unknown, label: string): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error(`${label} is required`);
  if (s.includes('$') || s.includes('\0')) throw new Error(`invalid ${label}: "${s}"`);
  return s;
}

/** Serialize one document to relaxed EJSON, capping pathological sizes. */
function toWire(doc: Document): { json: string; truncated: boolean } {
  const json = BSON.EJSON.stringify(doc, undefined, undefined, { relaxed: true });
  if (json.length <= DOC_JSON_CAP) return { json, truncated: false };
  return { json: json.slice(0, DOC_JSON_CAP), truncated: true };
}

// ── Connection probes ─────────────────────────────────────────────────────────

export interface TestResult {
  latencyMs: number;
  version: string;
  /** e.g. "replica set: rs0 (primary: host:port)" · "standalone" · "sharded (mongos)". */
  topology: string;
}

/**
 * `hello` exists only on MongoDB ≥4.4 — older servers (4.0/3.6, wire ≤7) still
 * answer the legacy `isMaster`. Try modern first, fall back, and normalize the
 * primary flag (`isWritablePrimary` vs legacy `ismaster`).
 */
async function helloCommand(client: MongoClient): Promise<Document & { primary: boolean }> {
  const admin = client.db('admin');
  const res = await admin.command({ hello: 1 }).catch(() => admin.command({ isMaster: 1 }));
  return { ...res, primary: !!(res.isWritablePrimary ?? res.ismaster) };
}

async function describeTopology(client: MongoClient): Promise<Omit<TestResult, 'latencyMs'>> {
  const hello = await helloCommand(client);
  const build = await client.db('admin').command({ buildInfo: 1 }).catch(() => ({ version: '?' }));
  let topology = 'standalone';
  if (hello.msg === 'isdbgrid') topology = 'sharded (mongos)';
  else if (hello.setName) {
    const role = hello.primary ? 'primary' : 'secondary';
    topology = `replica set ${hello.setName} · ${hello.hosts?.length ?? 1} node(s) · connected to ${role}`;
  }
  return { version: String(build.version ?? '?'), topology };
}

/**
 * Test a not-yet-saved connection straight from the form. Opens a throwaway
 * client, pings, reports version + topology, then closes. Throws on failure.
 */
export async function testConnection(conn: MongoConnection): Promise<TestResult> {
  const client = new MongoClient(buildUri(conn), {
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    maxPoolSize: 1,
  });
  const t0 = Date.now();
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    const latencyMs = Date.now() - t0;
    const info = await describeTopology(client);
    return { latencyMs, ...info };
  } finally {
    await client.close().catch(() => {});
  }
}

/** PING via the cached client → round-trip latency. */
export async function ping(conn: MongoConnection): Promise<{ latencyMs: number }> {
  const client = getClient(conn);
  const t0 = Date.now();
  await client.db('admin').command({ ping: 1 });
  return { latencyMs: Date.now() - t0 };
}

export interface ServerInfoResult extends TestResult {
  /** Replica-set member list (empty for standalone/mongos). */
  hosts: string[];
}

/** Overview payload: version + topology + member hosts. */
export async function serverInfo(conn: MongoConnection): Promise<ServerInfoResult> {
  const client = getClient(conn);
  const t0 = Date.now();
  await client.db('admin').command({ ping: 1 });
  const latencyMs = Date.now() - t0;
  const hello = await helloCommand(client);
  const info = await describeTopology(client);
  return { latencyMs, ...info, hosts: Array.isArray(hello.hosts) ? hello.hosts.map(String) : [] };
}

// ── Monitor (RAM / disk / connections / cache / repl lag — 30s poll) ─────────

export interface MongoMemberStats {
  name: string;
  /** PRIMARY / SECONDARY / ARBITER / (DOWN) … */
  state: string;
  healthy: boolean;
  /** Replication lag vs primary, seconds (secondaries only). */
  lagSec: number | null;
}

export interface MongoMonitorResult {
  uptimeSec: number;
  /** mongod resident RAM, bytes. */
  memResidentBytes: number;
  memVirtualBytes: number;
  /** Data volume usage (dbStats fsUsedSize/fsTotalSize — MongoDB ≥4.4; null older). */
  fsUsedBytes: number | null;
  fsTotalBytes: number | null;
  connectionsCurrent: number;
  connectionsAvailable: number;
  /** WiredTiger cache pressure. */
  cacheUsedBytes: number;
  cacheMaxBytes: number;
  /** Cumulative opcounters — the CLIENT diffs consecutive polls into ops/s. */
  opcounters: { insert: number; query: number; update: number; delete: number; command: number };
  /** Wall-clock of this snapshot (for rate math). */
  at: number;
  /** Replica-set members (empty for standalone/mongos). */
  members: MongoMemberStats[];
}

/** One snapshot of serverStatus + dbStats + replSetGetStatus (best-effort each). */
export async function monitor(conn: MongoConnection): Promise<MongoMonitorResult> {
  const client = getClient(conn);
  const admin = client.db('admin');
  const ss = await admin.command({ serverStatus: 1 });
  const stats = await admin.command({ dbStats: 1 }).catch(() => null as Document | null);

  let members: MongoMemberStats[] = [];
  try {
    const rs = await admin.command({ replSetGetStatus: 1 });
    const rows: Document[] = Array.isArray(rs.members) ? rs.members : [];
    const primary = rows.find((m) => m.stateStr === 'PRIMARY');
    const primaryOptime = primary?.optimeDate ? new Date(primary.optimeDate as string | Date).getTime() : null;
    members = rows.map((m) => {
      const opt = m.optimeDate ? new Date(m.optimeDate as string | Date).getTime() : null;
      const isSecondary = m.stateStr === 'SECONDARY';
      const lagSec = isSecondary && primaryOptime !== null && opt !== null
        ? Math.max(0, Math.round((primaryOptime - opt) / 1000))
        : null;
      return {
        name: String(m.name ?? '?'),
        state: String(m.stateStr ?? '?'),
        healthy: Number(m.health ?? 0) === 1,
        lagSec,
      };
    });
  } catch { /* standalone / mongos / no permission — hide the member table */ }

  const wt = (ss.wiredTiger as Document | undefined)?.cache as Document | undefined;
  const mem = (ss.mem ?? {}) as Document;
  const connx = (ss.connections ?? {}) as Document;
  const ops = (ss.opcounters ?? {}) as Document;
  return {
    uptimeSec: Number(ss.uptime ?? 0),
    memResidentBytes: Number(mem.resident ?? 0) * 1024 * 1024,
    memVirtualBytes: Number(mem.virtual ?? 0) * 1024 * 1024,
    fsUsedBytes: stats && stats.fsUsedSize != null ? Number(stats.fsUsedSize) : null,
    fsTotalBytes: stats && stats.fsTotalSize != null ? Number(stats.fsTotalSize) : null,
    connectionsCurrent: Number(connx.current ?? 0),
    connectionsAvailable: Number(connx.available ?? 0),
    cacheUsedBytes: Number(wt?.['bytes currently in the cache'] ?? 0),
    cacheMaxBytes: Number(wt?.['maximum bytes configured'] ?? 0),
    opcounters: {
      insert: Number(ops.insert ?? 0),
      query: Number(ops.query ?? 0),
      update: Number(ops.update ?? 0),
      delete: Number(ops.delete ?? 0),
      command: Number(ops.command ?? 0),
    },
    at: Date.now(),
    members,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export interface DatabaseInfo {
  name: string;
  sizeOnDisk: number;
  empty: boolean;
}

export async function listDatabases(conn: MongoConnection): Promise<DatabaseInfo[]> {
  const client = getClient(conn);
  const res = await client.db('admin').admin().listDatabases();
  return res.databases
    .map((d) => ({ name: d.name, sizeOnDisk: Number(d.sizeOnDisk ?? 0), empty: !!d.empty }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface CollectionInfo {
  name: string;
  /** 'collection' | 'view' | 'timeseries'. */
  type: string;
}

export async function listCollections(conn: MongoConnection, dbName: string): Promise<CollectionInfo[]> {
  const db = requireName(dbName, 'database');
  const client = getClient(conn);
  const cols = await client.db(db).listCollections({}, { nameOnly: false, maxTimeMS: MAX_TIME_ADMIN_MS }).toArray();
  return cols
    .map((c) => ({ name: c.name, type: String(c.type ?? 'collection') }))
    .filter((c) => !c.name.startsWith('system.'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface CollStatsResult {
  count: number;
  /** Uncompressed data size + on-disk storage size, bytes. */
  size: number;
  storageSize: number;
  avgObjSize: number;
  nindexes: number;
  totalIndexSize: number;
}

export async function collectionStats(conn: MongoConnection, dbName: string, collName: string): Promise<CollStatsResult> {
  const db = requireName(dbName, 'database');
  const coll = requireName(collName, 'collection');
  const client = getClient(conn);
  // $collStats aggregation works on modern servers and honors maxTimeMS.
  const [row] = await client
    .db(db)
    .collection(coll)
    .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: MAX_TIME_ADMIN_MS })
    .toArray()
    .catch(() => [] as Document[]);
  const s = (row?.storageStats ?? {}) as Document;
  return {
    count: Number(s.count ?? 0),
    size: Number(s.size ?? 0),
    storageSize: Number(s.storageSize ?? 0),
    avgObjSize: Number(s.avgObjSize ?? 0),
    nindexes: Number(s.nindexes ?? 0),
    totalIndexSize: Number(s.totalIndexSize ?? 0),
  };
}

export interface IndexInfo {
  name: string;
  /** {"tenantId": 1, "createdAt": -1} rendered as JSON. */
  keyJson: string;
  unique: boolean;
  sparse: boolean;
  ttlSeconds?: number;
  partial: boolean;
}

export async function listIndexes(conn: MongoConnection, dbName: string, collName: string): Promise<IndexInfo[]> {
  const db = requireName(dbName, 'database');
  const coll = requireName(collName, 'collection');
  const client = getClient(conn);
  const idx = await client.db(db).collection(coll).listIndexes().toArray();
  return idx.map((i) => ({
    name: String(i.name),
    keyJson: JSON.stringify(i.key),
    unique: !!i.unique,
    sparse: !!i.sparse,
    ttlSeconds: typeof i.expireAfterSeconds === 'number' ? i.expireAfterSeconds : undefined,
    partial: !!i.partialFilterExpression,
  }));
}

// ── Field discovery (autocomplete for the query bar) ─────────────────────────

export interface FieldInfo {
  /** Dotted path — array elements collapse into their parent (`items.sku`). */
  path: string;
  /** BSON-ish type name of the first value seen (`string`, `objectId`, `array`…). */
  type: string;
  /** How many of the sampled documents carry this path. */
  seen: number;
}

/** How many documents to sample, and how deep/wide to walk them. */
const FIELD_SAMPLE_DOCS = 60;
const FIELD_MAX_DEPTH = 4;
const FIELD_MAX_PATHS = 400;

function bsonTypeOf(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (typeof v === 'object') {
    const name = (v as { _bsontype?: string })._bsontype;
    if (name === 'ObjectId' || name === 'ObjectID') return 'objectId';
    if (name) return name.charAt(0).toLowerCase() + name.slice(1);
    return 'object';
  }
  return typeof v;
}

/**
 * Walk sampled documents and collect their field paths. Arrays are flattened
 * into the parent path (Mongo queries `items.sku` regardless of index), so the
 * suggestions match what you would actually type into a filter.
 */
function collectPaths(doc: Document, out: Map<string, FieldInfo>, prefix = '', depth = 0): void {
  if (depth > FIELD_MAX_DEPTH || out.size >= FIELD_MAX_PATHS) return;
  for (const [key, value] of Object.entries(doc)) {
    if (out.size >= FIELD_MAX_PATHS) return;
    const path = prefix ? `${prefix}.${key}` : key;
    const prev = out.get(path);
    if (prev) prev.seen += 1;
    else out.set(path, { path, type: bsonTypeOf(value), seen: 1 });

    if (Array.isArray(value)) {
      // Descend into the first object element only — enough to expose the shape.
      const el = value.find((x) => x && typeof x === 'object' && !Array.isArray(x) && !(x as { _bsontype?: string })._bsontype);
      if (el) collectPaths(el as Document, out, path, depth + 1);
    } else if (value && typeof value === 'object' && bsonTypeOf(value) === 'object') {
      collectPaths(value as Document, out, path, depth + 1);
    }
  }
}

/** Sample a collection and return its field paths, most common first. */
export async function sampleFields(conn: MongoConnection, dbName: string, collName: string): Promise<FieldInfo[]> {
  const db = requireName(dbName, 'database');
  const coll = requireName(collName, 'collection');
  const client = getClient(conn);
  const rows = await client
    .db(db)
    .collection(coll)
    .find({}, { limit: FIELD_SAMPLE_DOCS, maxTimeMS: MAX_TIME_FIND_MS })
    .toArray();
  const out = new Map<string, FieldInfo>();
  for (const row of rows) collectPaths(row, out);
  return [...out.values()].sort((a, b) => b.seen - a.seen || a.path.localeCompare(b.path));
}

export interface FindInput {
  filter?: unknown;
  projection?: unknown;
  sort?: unknown;
  limit?: unknown;
  skip?: unknown;
}

export interface FindResult {
  /** Relaxed-EJSON string per document (client renders/parses). */
  docs: { json: string; truncated: boolean }[];
  limit: number;
  skip: number;
  /** True when one more document exists past this page. */
  hasMore: boolean;
  tookMs: number;
}

export async function find(conn: MongoConnection, dbName: string, collName: string, input: FindInput): Promise<FindResult> {
  const db = requireName(dbName, 'database');
  const coll = requireName(collName, 'collection');
  const filter = parseDoc(input.filter, 'filter');
  forbidKeyDeep(filter, FILTER_FORBIDDEN, 'filter');
  const projection = parseDoc(input.projection, 'projection');
  const sort = parseDoc(input.sort, 'sort') as Sort;
  const limit = clampLimit(input.limit);
  const skip = clampSkip(input.skip);

  const client = getClient(conn);
  const t0 = Date.now();
  // Fetch limit+1 to answer "is there a next page" without a count.
  const rows = await client
    .db(db)
    .collection(coll)
    .find(filter, {
      projection: Object.keys(projection).length ? projection : undefined,
      sort: Object.keys(sort as Document).length ? sort : undefined,
      limit: limit + 1,
      skip,
      maxTimeMS: MAX_TIME_FIND_MS,
    })
    .toArray();
  const tookMs = Date.now() - t0;
  const hasMore = rows.length > limit;
  return { docs: rows.slice(0, limit).map(toWire), limit, skip, hasMore, tookMs };
}

export interface CountResult {
  count: number;
  /** True when the fast collection-metadata estimate was used (empty filter). */
  estimated: boolean;
  tookMs: number;
}

export async function count(conn: MongoConnection, dbName: string, collName: string, rawFilter: unknown): Promise<CountResult> {
  const db = requireName(dbName, 'database');
  const coll = requireName(collName, 'collection');
  const filter = parseDoc(rawFilter, 'filter');
  forbidKeyDeep(filter, FILTER_FORBIDDEN, 'filter');
  const client = getClient(conn);
  const t0 = Date.now();
  const c = client.db(db).collection(coll);
  const isEmpty = Object.keys(filter).length === 0;
  const n = isEmpty
    ? await c.estimatedDocumentCount({ maxTimeMS: MAX_TIME_FIND_MS })
    : await c.countDocuments(filter, { maxTimeMS: MAX_TIME_FIND_MS });
  return { count: n, estimated: isEmpty, tookMs: Date.now() - t0 };
}

/** Aggregation stages that write or run server-side JS — read-only tool, all refused. */
const PIPELINE_FORBIDDEN_STAGES = ['$out', '$merge'];

export interface AggregateResult {
  docs: { json: string; truncated: boolean }[];
  /** True when the hard AGGREGATE_LIMIT cap kicked in. */
  capped: boolean;
  tookMs: number;
}

export async function aggregate(conn: MongoConnection, dbName: string, collName: string, rawPipeline: unknown): Promise<AggregateResult> {
  const db = requireName(dbName, 'database');
  const coll = requireName(collName, 'collection');
  const pipeline = parseArray(rawPipeline, 'pipeline');
  if (pipeline.length === 0) throw new Error('pipeline must have at least one stage');
  if (pipeline.length > 20) throw new Error('pipeline is capped at 20 stages in this tool');
  for (const stage of pipeline) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) throw new Error('every pipeline stage must be an object');
    for (const key of Object.keys(stage)) {
      if (PIPELINE_FORBIDDEN_STAGES.includes(key)) throw new Error(`stage "${key}" writes data — not allowed (read-only aggregation)`);
    }
  }
  forbidKeyDeep(pipeline, FILTER_FORBIDDEN, 'pipeline');

  const client = getClient(conn);
  const t0 = Date.now();
  const rows = await client
    .db(db)
    .collection(coll)
    .aggregate([...pipeline, { $limit: AGGREGATE_LIMIT + 1 }], {
      maxTimeMS: MAX_TIME_AGGREGATE_MS,
      allowDiskUse: false,
    })
    .toArray();
  const tookMs = Date.now() - t0;
  const capped = rows.length > AGGREGATE_LIMIT;
  return { docs: rows.slice(0, AGGREGATE_LIMIT).map(toWire), capped, tookMs };
}

// ── The ONE write: update with a mandatory query ─────────────────────────────

const UPDATE_ALLOWED_OPERATORS = new Set([
  '$set', '$unset', '$inc', '$mul', '$rename', '$min', '$max', '$currentDate',
  '$addToSet', '$push', '$pull', '$pullAll', '$pop', '$bit',
]);

export interface UpdateInput {
  filter: unknown;
  update: unknown;
  /** 'one' (default) or 'many'. */
  mode?: unknown;
}

export interface UpdateResult {
  matched: number;
  modified: number;
  mode: 'one' | 'many';
}

/**
 * The ONLY write this tool exposes: updateOne/updateMany with
 *   - a NON-EMPTY filter (a blind collection-wide write is refused),
 *   - a $-operator update document (whole-document replace is refused),
 *   - upsert hard-off, and
 *   - an allowlist of update operators (no $where-style escape hatches).
 * Gate order: MONGO_ALLOW_WRITE env → per-connection readOnly → validation.
 * Every call is audit-logged to stdout.
 */
export async function updateWithQuery(conn: MongoConnection, dbName: string, collName: string, input: UpdateInput): Promise<UpdateResult> {
  if (!MONGO_ALLOW_WRITE) {
    throw new Error('Writes are disabled for the whole tool. Set MONGO_ALLOW_WRITE=true in .env.local (local dev only).');
  }
  if (conn.readOnly) {
    throw new Error(`Connection "${conn.name}" is read-only. Edit the connection and untick read-only to arm writes.`);
  }
  const db = requireName(dbName, 'database');
  const coll = requireName(collName, 'collection');

  const filter = parseDoc(input.filter, 'filter');
  if (Object.keys(filter).length === 0) {
    throw new Error('update requires a NON-EMPTY filter — a collection-wide blind update is not allowed');
  }
  forbidKeyDeep(filter, FILTER_FORBIDDEN, 'filter');

  if (Array.isArray(input.update)) throw new Error('aggregation-pipeline updates are not allowed in this tool');
  const update = parseDoc(input.update, 'update');
  const opKeys = Object.keys(update);
  if (opKeys.length === 0) throw new Error('update document is empty');
  for (const k of opKeys) {
    if (!k.startsWith('$')) {
      throw new Error(`update must use atomic operators ($set, $inc, …) — "${k}" looks like a whole-document replace`);
    }
    if (!UPDATE_ALLOWED_OPERATORS.has(k)) throw new Error(`update operator "${k}" is not allowed in this tool`);
  }

  const mode: 'one' | 'many' = input.mode === 'many' ? 'many' : 'one';
  const client = getClient(conn);
  const c = client.db(db).collection(coll);
  const res = mode === 'many'
    ? await c.updateMany(filter, update, { upsert: false })
    : await c.updateOne(filter, update, { upsert: false });

  // Audit line → server stdout (same convention as REDIS_AUDIT in lib/redisClient.ts).
  // eslint-disable-next-line no-console
  console.log(
    `MONGO_AUDIT operation=UPDATE connection=${conn.name} target=${db}.${coll} mode=${mode} ` +
    `filter=${sanitize(JSON.stringify(filter))} update=${sanitize(JSON.stringify(update))} ` +
    `matched=${res.matchedCount} modified=${res.modifiedCount} ts=${new Date().toISOString()}`,
  );
  return { matched: res.matchedCount, modified: res.modifiedCount, mode };
}

/** Strip control chars + cap length so a crafted filter can't inject into the audit log line. */
function sanitize(s: string): string {
  let out = '';
  for (const ch of s.slice(0, 500)) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? '?' : ch;
  }
  return out;
}
