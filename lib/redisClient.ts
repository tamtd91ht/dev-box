// Server-only Redis operations for the local Redis-manager workspace.
//
// SECURITY / SAFETY MODEL — this connects to real Redis instances (possibly
// production ones) from the machine hosting the Next.js server, so it is
// deliberately constrained to a small, safe command surface and gated off in any
// deploy:
//   1. Gated by REDIS_TOOL_ENABLED — the API route 403s unless it is truthy. A
//      k8s/production deployment never sets it, so the feature is off there.
//   2. Browsing uses SCAN (cursor-based) ONLY — never KEYS, which blocks the whole
//      instance (project rule: redis-key-scope-management / redis-no-single-bottleneck).
//   3. Set-TTL is capped at 30 days and PERSIST / TTL-removal is NOT exposed
//      (project rule: redis-ttl-mandatory — no pseudo-eternal keys).
//   4. Delete is single-key only (no bulk / FLUSHDB / FLUSHALL); every delete is
//      audit-logged, and lock keys (`*:lock:*`) are flagged because deleting one
//      can release another pod's live lock (redis-pod-coordination-idempotency).
//   5. Single-node only — matches the "redis single" scope; no cluster client.
//
// Values from the client are passed to ioredis as distinct arguments (never a raw
// command string), so a key name can't be interpreted as a command.

import Redis, { Cluster, type RedisOptions, type ClusterNode, type ClusterOptions } from 'ioredis';
import type { RedisConnection } from '@/lib/redisConnections';

/** Either single-node or cluster ioredis client — both share the command surface we use. */
type AnyRedis = Redis | Cluster;

export const REDIS_ENABLED = /^(1|true|yes|on)$/i.test(process.env.REDIS_TOOL_ENABLED ?? '');

/** Hard TTL ceiling — 30 days, per redis-ttl-mandatory. */
export const MAX_TTL_SECONDS = 2_592_000;
/** Max collection entries returned for a single value view (list/set/zset/hash). */
export const VALUE_LIMIT = 500;
/** SCAN COUNT ceiling — keeps any one round bounded. */
const SCAN_COUNT_MAX = 1000;
/** Drop cached clients unused for longer than this. */
const IDLE_EVICT_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 5000;

export type RedisKeyType = 'string' | 'list' | 'set' | 'zset' | 'hash' | 'stream' | 'none';

export interface ScanResult {
  cursor: string;
  keys: { key: string; type: RedisKeyType; ttl: number }[];
}

export interface ValueResult {
  key: string;
  type: RedisKeyType;
  ttl: number;
  /** String for `string`; array/object for collections. Null when the key is gone. */
  value: unknown;
  /** True when a collection was capped at VALUE_LIMIT entries. */
  truncated: boolean;
  /** Total element count for collections (before truncation). */
  size?: number;
}

/** Coerce a request-supplied logical DB index into a valid 0–15 (default 0). */
export function normalizeDb(db: unknown): number {
  const n = Number(db);
  return Number.isInteger(n) && n >= 0 && n <= 15 ? n : 0;
}

// ── Client cache (one live socket per connection+db, reused across requests) ─────

interface Cached {
  client: AnyRedis;
  /** mode + address(es) + db signature — recreate the client when the profile changes. */
  sig: string;
  lastUsed: number;
}
const clients = new Map<string, Cached>();

/** True when a connection is configured as a Redis Cluster (≥1 seed node). */
export function isCluster(c: RedisConnection): boolean {
  return c.mode === 'cluster' && Array.isArray(c.nodes) && c.nodes.length > 0;
}

/** Cluster forces DB 0; single-node keeps the chosen 0–15. */
function effectiveDb(conn: RedisConnection, db: number): number {
  return isCluster(conn) ? 0 : db;
}

function signature(c: RedisConnection, db: number): string {
  if (isCluster(c)) {
    const seeds = (c.nodes ?? []).map((n) => `${n.host}:${n.port}`).join(',');
    return `cluster:${seeds}`;
  }
  return `single:${c.host}:${c.port}:${db}`;
}

function evictIdle(now: number): void {
  for (const [id, entry] of clients) {
    if (now - entry.lastUsed > IDLE_EVICT_MS) {
      entry.client.disconnect();
      clients.delete(id);
    }
  }
}

/**
 * Lazily create (or reuse) an ioredis client for a connection profile. Single-node
 * gets a `Redis` bound to the chosen logical DB (0–15, chosen per browse action);
 * cluster gets a `Cluster` over the seed nodes (DB is always 0 in cluster mode).
 * One saved connection keeps a separate cached socket per db it has been used against.
 */
function getClient(conn: RedisConnection, db = 0): AnyRedis {
  const now = Date.now();
  evictIdle(now);
  const eff = effectiveDb(conn, db);
  const cacheKey = isCluster(conn) ? `${conn.id}:cluster` : `${conn.id}:${eff}`;
  const sig = signature(conn, eff);
  const existing = clients.get(cacheKey);
  if (existing && existing.sig === sig) {
    existing.lastUsed = now;
    return existing.client;
  }
  if (existing) existing.client.disconnect(); // profile changed → drop stale socket

  let client: AnyRedis;
  if (isCluster(conn)) {
    const startupNodes: ClusterNode[] = (conn.nodes ?? []).map((n) => ({ host: n.host, port: n.port }));
    const clusterOpts: ClusterOptions = {
      redisOptions: {
        password: conn.password,
        connectTimeout: CONNECT_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
      },
      lazyConnect: true,
      // Fail fast — interactive tool, not a resilient service worker.
      clusterRetryStrategy: (times) => (times > 2 ? null : 200),
      enableOfflineQueue: true,
    };
    client = new Cluster(startupNodes, clusterOpts);
  } else {
    const opts: RedisOptions = {
      host: conn.host,
      port: conn.port,
      db: eff,
      password: conn.password,
      connectTimeout: CONNECT_TIMEOUT_MS,
      lazyConnect: true,
      // Fail fast rather than retry forever — this is an interactive browsing tool.
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => (times > 2 ? null : 200),
      enableOfflineQueue: true,
    };
    client = new Redis(opts);
  }

  // Swallow async 'error' events so an unreachable host doesn't crash the process;
  // the awaited command below still rejects and surfaces the error to the caller.
  client.on('error', () => {});
  clients.set(cacheKey, { client, sig, lastUsed: now });
  return client;
}

// ── Monitor (INFO: memory / clients / ops / hit-rate — 30s poll) ─────────────

export interface RedisNodeStats {
  /** host:port of the node (single: the connection address). */
  addr: string;
  role: string;
  usedMemoryBytes: number;
  /** 0 = no maxmemory configured (gauge falls back to system memory). */
  maxMemoryBytes: number;
  systemMemoryBytes: number;
  connectedClients: number;
  opsPerSec: number;
  /** keyspace hit rate percent since server start (null when no traffic). */
  hitRatePct: number | null;
  fragmentationRatio: number | null;
  uptimeSec: number;
  connectedSlaves: number;
}

/** Parse the INFO text format into a flat key→value map. */
function parseInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const idx = s.indexOf(':');
    if (idx > 0) out[s.slice(0, idx)] = s.slice(idx + 1);
  }
  return out;
}

function toStats(addr: string, info: Record<string, string>): RedisNodeStats {
  const hits = Number(info.keyspace_hits ?? 0);
  const misses = Number(info.keyspace_misses ?? 0);
  return {
    addr,
    role: String(info.role ?? '?'),
    usedMemoryBytes: Number(info.used_memory ?? 0),
    maxMemoryBytes: Number(info.maxmemory ?? 0),
    systemMemoryBytes: Number(info.total_system_memory ?? 0),
    connectedClients: Number(info.connected_clients ?? 0),
    opsPerSec: Number(info.instantaneous_ops_per_sec ?? 0),
    hitRatePct: hits + misses > 0 ? (hits / (hits + misses)) * 100 : null,
    fragmentationRatio: info.mem_fragmentation_ratio != null ? Number(info.mem_fragmentation_ratio) : null,
    uptimeSec: Number(info.uptime_in_seconds ?? 0),
    connectedSlaves: Number(info.connected_slaves ?? 0),
  };
}

/**
 * INFO snapshot — single node, or every MASTER of a cluster. Cheap (one INFO
 * per node), suitable for a 30s poll.
 */
export async function infoStats(conn: RedisConnection): Promise<RedisNodeStats[]> {
  const client = getClient(conn, 0);
  if (isCluster(conn) && client instanceof Cluster) {
    if (client.status !== 'ready') await client.ping();
    const masters = client.nodes('master');
    return Promise.all(masters.map(async (n) => {
      const addr = `${(n.options.host ?? '?')}:${n.options.port ?? '?'}`;
      return toStats(addr, parseInfo(await n.info()));
    }));
  }
  const info = parseInfo(await (client as Redis).info());
  return [toStats(`${conn.host}:${conn.port}`, info)];
}

// ── Operations ──────────────────────────────────────────────────────────────

/** PING → round-trip latency in ms. Throws if the instance is unreachable. */
export async function ping(conn: RedisConnection, db = 0): Promise<{ latencyMs: number }> {
  const client = getClient(conn, db);
  const t0 = Date.now();
  await client.ping();
  return { latencyMs: Date.now() - t0 };
}

/**
 * Test a not-yet-saved connection from the form. Single-node opens a throwaway
 * socket to host/port; cluster opens a throwaway Cluster over the seed nodes.
 * Always PINGs then disconnects. Throws on failure.
 */
export async function testConnection(input: {
  mode?: string;
  host?: string;
  port?: number;
  nodes?: { host: string; port: number }[];
  password?: string;
}): Promise<{ latencyMs: number }> {
  const password = input.password || undefined;
  const isClusterTest = input.mode === 'cluster';

  let client: AnyRedis;
  if (isClusterTest) {
    const seeds = (Array.isArray(input.nodes) ? input.nodes : [])
      .map((n) => ({ host: String(n.host ?? '').trim(), port: Number(n.port) }))
      .filter((n) => n.host && Number.isInteger(n.port) && n.port >= 1 && n.port <= 65535);
    if (seeds.length === 0) throw new Error('cluster test needs at least one seed node (host:port)');
    client = new Cluster(seeds, {
      redisOptions: { password, connectTimeout: CONNECT_TIMEOUT_MS, maxRetriesPerRequest: 1 },
      lazyConnect: true,
      clusterRetryStrategy: () => null, // one shot
      enableOfflineQueue: false,
    });
  } else {
    const host = String(input.host ?? '').trim();
    if (!host) throw new Error('host is required');
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535');
    client = new Redis({
      host,
      port,
      password,
      db: 0,
      connectTimeout: CONNECT_TIMEOUT_MS,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // one shot — no retries for a test probe
      enableOfflineQueue: false,
    });
  }

  client.on('error', () => {});
  const t0 = Date.now();
  try {
    await client.connect();
    await client.ping();
    return { latencyMs: Date.now() - t0 };
  } finally {
    client.disconnect();
  }
}

/** Enrich a batch of keys with type + ttl in one pipeline (one round-trip vs 2N). */
async function enrichKeys(client: AnyRedis, keys: string[]): Promise<ScanResult['keys']> {
  if (keys.length === 0) return [];
  const pipe = client.pipeline();
  for (const k of keys) {
    pipe.type(k);
    pipe.ttl(k);
  }
  const res = await pipe.exec();
  const out: ScanResult['keys'] = [];
  for (let i = 0; i < keys.length; i++) {
    const typeRes = res?.[i * 2];
    const ttlRes = res?.[i * 2 + 1];
    const type = (typeRes && !typeRes[0] ? (typeRes[1] as RedisKeyType) : 'none') ?? 'none';
    const ttl = ttlRes && !ttlRes[0] ? (ttlRes[1] as number) : -1;
    out.push({ key: keys[i], type, ttl });
  }
  return out;
}

/**
 * SCAN one round (cursor-based, NEVER KEYS), enriching each key with type + ttl.
 *
 * Cluster: a single global cursor is meaningless, so we walk the master nodes one
 * at a time. The opaque cursor is `n<nodeIdx>:<nodeCursor>`; when a node's SCAN
 * returns cursor '0' we advance to the next node, and only report the final '0'
 * once the last node is exhausted. This surfaces keys from every shard, RedisInsight-style.
 */
export async function scan(conn: RedisConnection, db: number, match: string, cursor: string, count: number): Promise<ScanResult> {
  const client = getClient(conn, db);
  const pattern = match && match.trim() ? match.trim() : '*';
  const cnt = Math.min(Math.max(Number(count) || 100, 1), SCAN_COUNT_MAX);

  if (isCluster(conn) && client instanceof Cluster) {
    return scanCluster(client, pattern, cursor, cnt);
  }

  const [next, keys] = await (client as Redis).scan(cursor || '0', 'MATCH', pattern, 'COUNT', cnt);
  return { cursor: next, keys: await enrichKeys(client, keys) };
}

/** SCAN one round across cluster master nodes; opaque cursor = `n<idx>:<cursor>`. */
async function scanCluster(client: Cluster, pattern: string, cursor: string, count: number): Promise<ScanResult> {
  // `nodes()` reads local topology, which is empty until the cluster is connected
  // (lazyConnect). A PING goes through the offline queue and forces the handshake,
  // after which the master list is populated.
  if (client.status !== 'ready') await client.ping();
  const masters = client.nodes('master');
  if (masters.length === 0) return { cursor: '0', keys: [] };

  // Parse the incoming compound cursor; default to node 0 at cursor 0.
  let nodeIdx = 0;
  let nodeCursor = '0';
  const m = /^n(\d+):(.+)$/.exec(cursor || '');
  if (m) {
    nodeIdx = Math.min(Number(m[1]), masters.length - 1);
    nodeCursor = m[2];
  }

  // Advance through nodes until one yields keys or all are exhausted.
  while (nodeIdx < masters.length) {
    const node = masters[nodeIdx];
    const [next, keys] = await node.scan(nodeCursor || '0', 'MATCH', pattern, 'COUNT', count);
    if (next === '0') {
      // This node is done — move to the next one on the following round.
      const isLast = nodeIdx === masters.length - 1;
      const outCursor = isLast ? '0' : `n${nodeIdx + 1}:0`;
      if (keys.length > 0) return { cursor: outCursor, keys: await enrichKeys(client, keys) };
      // No keys this round: keep walking nodes in-line so we don't return empty prematurely.
      nodeIdx += 1;
      nodeCursor = '0';
      continue;
    }
    return { cursor: `n${nodeIdx}:${next}`, keys: await enrichKeys(client, keys) };
  }
  return { cursor: '0', keys: [] };
}

/** Read a key's value (bounded for collections) + its type + ttl. */
export async function getValue(conn: RedisConnection, db: number, key: string): Promise<ValueResult> {
  if (!key || typeof key !== 'string') throw new Error('key is required');
  const client = getClient(conn, db);
  const type = (await client.type(key)) as RedisKeyType;
  const ttl = await client.ttl(key);

  let value: unknown = null;
  let truncated = false;
  let size: number | undefined;

  switch (type) {
    case 'none':
      break;
    case 'string':
      value = await client.get(key);
      break;
    case 'list': {
      size = await client.llen(key);
      value = await client.lrange(key, 0, VALUE_LIMIT - 1);
      truncated = size > VALUE_LIMIT;
      break;
    }
    case 'set': {
      size = await client.scard(key);
      const [, members] = await client.sscan(key, '0', 'COUNT', VALUE_LIMIT);
      value = members.slice(0, VALUE_LIMIT);
      truncated = size > VALUE_LIMIT;
      break;
    }
    case 'zset': {
      size = await client.zcard(key);
      const flat = await client.zrange(key, 0, VALUE_LIMIT - 1, 'WITHSCORES');
      const pairs: { member: string; score: string }[] = [];
      for (let i = 0; i < flat.length; i += 2) pairs.push({ member: flat[i], score: flat[i + 1] });
      value = pairs;
      truncated = size > VALUE_LIMIT;
      break;
    }
    case 'hash': {
      size = await client.hlen(key);
      const [, flat] = await client.hscan(key, '0', 'COUNT', VALUE_LIMIT);
      const obj: Record<string, string> = {};
      for (let i = 0; i < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
      value = obj;
      truncated = size > Object.keys(obj).length;
      break;
    }
    default:
      // stream or unknown — show a marker instead of trying to render it.
      value = `(${type} — preview not supported)`;
  }

  return { key, type, ttl, value, truncated, size };
}

/** Set/refresh a key's TTL. Capped at 30 days; PERSIST / removal is intentionally not offered. */
export async function setTtl(conn: RedisConnection, db: number, key: string, seconds: number): Promise<{ applied: boolean }> {
  if (!key || typeof key !== 'string') throw new Error('key is required');
  const s = Number(seconds);
  if (!Number.isInteger(s) || s < 1) throw new Error('ttl must be a whole number of seconds ≥ 1');
  if (s > MAX_TTL_SECONDS) throw new Error(`ttl must be ≤ 30 days (${MAX_TTL_SECONDS}s) — eternal keys are not allowed`);
  const client = getClient(conn, db);
  const res = await client.expire(key, s);
  return { applied: res === 1 }; // 0 = key does not exist
}

/** Payload for creating/overwriting a key. `type` picks how `value` is interpreted. */
export interface SetKeyInput {
  key: string;
  type: 'string' | 'list' | 'set' | 'hash';
  /** string: the value · list/set: string[] members · hash: {field: value}. */
  value: unknown;
  /** Optional TTL (seconds, ≤30 days). Omitted/0 → no expiry. */
  ttl?: number;
  /** When false (default), refuse if the key already exists. */
  overwrite?: boolean;
}

/**
 * Create (or overwrite) a key of a chosen type. String → SET; list → RPUSH;
 * set → SADD; hash → HSET. Existing keys are refused unless `overwrite` is true
 * (an overwrite first DELs the old key so a type change can't leave stale members).
 * TTL is capped at 30 days, per redis-ttl-mandatory. Audit-logged.
 */
export async function setValue(conn: RedisConnection, db: number, input: SetKeyInput): Promise<{ created: boolean; type: string }> {
  const key = String(input.key ?? '').trim();
  if (!key) throw new Error('key is required');
  const type = input.type;
  if (!['string', 'list', 'set', 'hash'].includes(type)) throw new Error(`unsupported type: ${type}`);

  let ttl = 0;
  if (input.ttl != null && input.ttl !== 0) {
    ttl = Number(input.ttl);
    if (!Number.isInteger(ttl) || ttl < 1) throw new Error('ttl must be a whole number of seconds ≥ 1');
    if (ttl > MAX_TTL_SECONDS) throw new Error(`ttl must be ≤ 30 days (${MAX_TTL_SECONDS}s) — eternal keys are not allowed`);
  }

  const client = getClient(conn, db);
  const exists = (await client.exists(key)) === 1;
  if (exists && !input.overwrite) throw new Error(`key "${key}" already exists — enable overwrite to replace it`);
  if (exists) await client.del(key); // clean slate so a type change leaves no stale members

  switch (type) {
    case 'string': {
      const v = typeof input.value === 'string' ? input.value : String(input.value ?? '');
      await client.set(key, v);
      break;
    }
    case 'list': {
      const members = asStringArray(input.value, 'list');
      if (members.length === 0) throw new Error('list requires at least one element');
      await client.rpush(key, ...members);
      break;
    }
    case 'set': {
      const members = asStringArray(input.value, 'set');
      if (members.length === 0) throw new Error('set requires at least one member');
      await client.sadd(key, ...members);
      break;
    }
    case 'hash': {
      const pairs = asFieldValuePairs(input.value);
      if (pairs.length === 0) throw new Error('hash requires at least one field');
      await client.hset(key, ...pairs);
      break;
    }
  }

  if (ttl > 0) await client.expire(key, ttl);

  // eslint-disable-next-line no-console
  console.log(
    `REDIS_AUDIT operation=SET connection=${conn.name} host=${conn.host}:${conn.port}/${effectiveDb(conn, db)} key=${sanitize(key)} type=${type} overwrite=${exists} ttl=${ttl} ts=${new Date().toISOString()}`,
  );
  return { created: true, type };
}

/** Coerce client-supplied value into a string[] of members (rejects empties). */
function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} value must be an array of strings`);
  return value.map((v) => (typeof v === 'string' ? v : String(v ?? ''))).filter((v) => v.length > 0);
}

/** Coerce a {field: value} object (or [field, value] pairs) into a flat HSET arg list. */
function asFieldValuePairs(value: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const f = String((entry as { field?: unknown })?.field ?? '').trim();
      const v = (entry as { value?: unknown })?.value;
      if (f) out.push(f, typeof v === 'string' ? v : String(v ?? ''));
    }
  } else if (value && typeof value === 'object') {
    for (const [f, v] of Object.entries(value as Record<string, unknown>)) {
      if (f) out.push(f, typeof v === 'string' ? v : String(v ?? ''));
    }
  } else {
    throw new Error('hash value must be an object or [{field,value}] array');
  }
  return out;
}

/** Delete a single key. Always audit-logged; flags lock keys as risky. */
export async function del(conn: RedisConnection, db: number, key: string): Promise<{ deleted: number; lockKeyWarning: boolean }> {
  if (!key || typeof key !== 'string') throw new Error('key is required');
  const client = getClient(conn, db);
  const deleted = await client.del(key);
  const lockKeyWarning = /:lock:/i.test(key);
  // Audit line → server stdout (shipped to ELK in a real deploy, per ToolAuditLog convention).
  // eslint-disable-next-line no-console
  console.log(
    `REDIS_AUDIT operation=DELETE connection=${conn.name} host=${conn.host}:${conn.port}/${effectiveDb(conn, db)} key=${sanitize(key)} deleted=${deleted} ts=${new Date().toISOString()}`,
  );
  return { deleted, lockKeyWarning };
}

/** Strip control chars + cap length so a crafted key can't inject into the audit log line. */
function sanitize(s: string): string {
  let out = '';
  for (const ch of s.slice(0, 200)) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? '?' : ch;
  }
  return out;
}
