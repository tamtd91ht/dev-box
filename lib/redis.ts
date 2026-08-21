// Client-side helpers + shared types for the Redis workspace. All calls go to the
// same-origin /api/redis* routes (the Next server holds the ioredis socket — the
// browser never connects to Redis directly). This file is browser-safe: NO `fs`,
// NO `ioredis`, no server-only imports.

import { apiFetch } from './apiFetch';

export type RedisKeyType = 'string' | 'list' | 'set' | 'zset' | 'hash' | 'stream' | 'none';

/** TTL ceiling mirrored from the server (redis-ttl-mandatory) so the UI can block early. */
export const MAX_TTL_SECONDS = 2_592_000; // 30 days

/** One Redis Cluster seed node. */
export interface RedisNode {
  host: string;
  port: number;
}

export type RedisMode = 'single' | 'cluster';

/** A connection as returned to the browser — password is never sent, only its presence. */
export interface PublicRedisConnection {
  id: string;
  name: string;
  project: string;
  mode: RedisMode;
  host: string;
  port: number;
  nodes?: RedisNode[];
  hasPassword: boolean;
}

/** Body for add/update — password optional (omit on edit to keep the stored one). */
export interface RedisConnectionInput {
  id?: string;
  name: string;
  project: string;
  mode: RedisMode;
  host?: string;
  port?: number;
  nodes?: RedisNode[];
  password?: string;
}

export interface RedisConnectionsResponse {
  enabled: boolean;
  connections: PublicRedisConnection[];
}

export interface ScannedKey {
  key: string;
  type: RedisKeyType;
  ttl: number;
}

export interface ScanResult {
  cursor: string;
  keys: ScannedKey[];
}

export interface ValueResult {
  key: string;
  type: RedisKeyType;
  ttl: number;
  value: unknown;
  truncated: boolean;
  size?: number;
}

export interface PingResult {
  latencyMs: number;
}

export interface DeleteResult {
  deleted: number;
  lockKeyWarning: boolean;
}

// ── Connection registry (CRUD) ────────────────────────────────────────────────

/** GET the connection list — never throws; returns disabled on any error. */
export async function fetchRedisConnections(): Promise<RedisConnectionsResponse> {
  try {
    const r = await apiFetch('/api/redis-connections', { timeoutMs: 15000 });
    if (!r.ok) return { enabled: false, connections: [] };
    return (await r.json()) as RedisConnectionsResponse;
  } catch {
    return { enabled: false, connections: [] };
  }
}

/** POST/PUT/DELETE a connection mutation. Throws Error(message) on a non-2xx. */
export async function mutateRedisConnection(
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<PublicRedisConnection[]> {
  const r = await apiFetch('/api/redis-connections', {
    method,
    body: JSON.stringify(body),
    timeoutMs: 15000,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { connections: PublicRedisConnection[] }).connections;
}

// ── Redis operations ──────────────────────────────────────────────────────────

/** POST one Redis action. Throws Error(message) on a non-2xx (surfaces Redis error). */
async function redisAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await apiFetch('/api/redis', {
    method: 'POST',
    body: JSON.stringify({ action, ...params }),
    timeoutMs: 60000, // thao tác dữ liệu (scan keyspace lớn…) được phép lâu hơn CRUD config
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

export function pingRedis(connectionId: string, db: number): Promise<PingResult> {
  return redisAction<PingResult>('ping', { connectionId, db });
}

export interface RedisNodeStats {
  addr: string;
  role: string;
  usedMemoryBytes: number;
  maxMemoryBytes: number;
  systemMemoryBytes: number;
  connectedClients: number;
  opsPerSec: number;
  hitRatePct: number | null;
  fragmentationRatio: number | null;
  uptimeSec: number;
  connectedSlaves: number;
}

/** INFO snapshot per node (single → 1 entry; cluster → every master). */
export function redisStats(connectionId: string): Promise<RedisNodeStats[]> {
  return redisAction<RedisNodeStats[]>('stats', { connectionId });
}

/** Test a not-yet-saved connection straight from the form (single or cluster). */
export function testRedisConnection(input: {
  mode: RedisMode;
  host?: string;
  port?: number;
  nodes?: RedisNode[];
  password?: string;
}): Promise<PingResult> {
  return redisAction<PingResult>('test', input);
}

export function scanRedis(
  connectionId: string,
  db: number,
  match: string,
  cursor: string,
  count: number,
): Promise<ScanResult> {
  return redisAction<ScanResult>('scan', { connectionId, db, match, cursor, count });
}

/**
 * Tra ĐÚNG một key theo tên — TYPE+TTL O(1), KHÔNG quét keyspace.
 *
 * Dùng cho ô tìm khi bật "Đúng key". SCAN MATCH <key> cũng ra kết quả nhưng
 * phải đi hết keyspace mới kết luận được, nên trên DB lớn key nằm cuối là
 * không bao giờ tìm thấy. Trả cùng shape với scan để UI dùng chung một đường.
 */
export function lookupRedisKey(connectionId: string, db: number, key: string): Promise<ScanResult> {
  return redisAction<ScanResult>('lookup', { connectionId, db, key });
}

export function getRedisValue(connectionId: string, db: number, key: string): Promise<ValueResult> {
  return redisAction<ValueResult>('value', { connectionId, db, key });
}

export function setRedisTtl(connectionId: string, db: number, key: string, seconds: number): Promise<{ applied: boolean }> {
  return redisAction<{ applied: boolean }>('setTtl', { connectionId, db, key, seconds });
}

export function deleteRedisKey(connectionId: string, db: number, key: string): Promise<DeleteResult> {
  return redisAction<DeleteResult>('del', { connectionId, db, key });
}

/** Add-key payload type mirrored from the server's SetKeyInput. */
export interface SetKeyInput {
  key: string;
  type: 'string' | 'list' | 'set' | 'hash';
  /** string → string · list/set → string[] · hash → {field: value}. */
  value: unknown;
  /** Seconds (≤30 days); omit/0 = no expiry. */
  ttl?: number;
  /** false (default) → refuse if key exists. */
  overwrite?: boolean;
}

/** Create/overwrite a key of a chosen type. Throws Error(message) on failure. */
export function setRedisValue(
  connectionId: string,
  db: number,
  input: SetKeyInput,
): Promise<{ created: boolean; type: string }> {
  return redisAction<{ created: boolean; type: string }>('set', { connectionId, db, ...input });
}

// ── Small shared formatters (used by the workspace UI) ──────────────────────────

/** Humanize a TTL in seconds: -1 = no expiry, -2 = missing key. */
export function humanizeTtl(ttl: number): string {
  if (ttl === -1) return 'no expiry';
  if (ttl === -2) return 'gone';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m ${ttl % 60}s`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`;
  return `${Math.floor(ttl / 86400)}d ${Math.floor((ttl % 86400) / 3600)}h`;
}
