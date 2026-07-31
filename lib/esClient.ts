// Server-only Elasticsearch operations for the local ES-manager workspace.
// Plain HTTP against the ES REST API via global fetch — no client library.
//
// SAFETY MODEL — read-only by construction and gated off in any deploy:
//   1. Gated by ES_TOOL_ENABLED — the API routes 403 unless truthy.
//   2. ONLY read endpoints are reachable: GET /, _cluster/health, _cat/indices,
//      _mapping, _search, _count. There is no code path that issues a write —
//      the tool cannot index, delete, or change settings.
//   3. Every search is bounded: size ≤ 200/page, from+size ≤ 10 000 (the ES
//      window), request timeout 15 s (AbortController) + ES-side "timeout".
//   4. Query DSL from the client is parsed JSON passed as a request BODY —
//      never string-concatenated into the URL. `script` / `script_score` keys
//      are rejected anywhere in the query (no server-side scripting from an
//      ops tool — mirrors the Mongo tab's $where ban).
//   5. Index names are validated (no leading '-', no '..', no '/').

import type { EsConnection } from '@/lib/esConnections';

export const ES_ENABLED = /^(1|true|yes|on)$/i.test(process.env.ES_TOOL_ENABLED ?? '');

export const SEARCH_SIZE_MAX = 200;
export const SEARCH_SIZE_DEFAULT = 50;
/** ES result-window cap (index.max_result_window default). */
const RESULT_WINDOW = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * GET/POST one ES endpoint with a hard timeout, failing over node-to-node on
 * CONNECTION errors (unreachable/timeout). Any HTTP response — even 5xx — is
 * authoritative and NOT retried on another node (same policy as the RabbitMQ
 * tab's management-API client). Throws Error with the ES reason.
 */
async function esFetch<T>(conn: EsConnection, pathAndQuery: string, body?: unknown): Promise<T> {
  const scheme = conn.tls ? 'https' : 'http';
  let lastErr: Error | null = null;
  for (const node of conn.nodes) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${scheme}://${node}${pathAndQuery}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        cache: 'no-store',
      });
      const text = await res.text();
      let json: unknown;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!res.ok) {
        const reason = (json as { error?: { reason?: string; type?: string } })?.error;
        throw new AuthoritativeError(reason?.reason || reason?.type || `ES trả HTTP ${res.status}`);
      }
      return json as T;
    } catch (e) {
      if (e instanceof AuthoritativeError) throw new Error(e.message); // HTTP answer — done
      lastErr = (e as Error).name === 'AbortError'
        ? new Error(`node ${node} không phản hồi trong ${REQUEST_TIMEOUT_MS / 1000}s`)
        : new Error(`node ${node}: ${(e as Error).message}`);
      // connection-level failure → try the next node
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('connection has no nodes');
}

/** Marker: the cluster ANSWERED (4xx/5xx) — don't fail over to another node. */
class AuthoritativeError extends Error {}

// ── Cluster major-version cache (6.8 vs 7/8 body differences) ────────────────

const versionCache = new Map<string, { sig: string; major: number }>();

/** Major version of the cluster (cached per connection profile). Defaults to 7+ behavior. */
async function getMajor(conn: EsConnection): Promise<number> {
  const sig = `${conn.tls}|${conn.nodes.join(',')}`;
  const hit = versionCache.get(conn.id);
  if (hit && hit.sig === sig) return hit.major;
  try {
    const root = await esFetch<{ version?: { number?: string } }>(conn, '/');
    const major = Number(String(root.version?.number ?? '7').split('.')[0]) || 7;
    versionCache.set(conn.id, { sig, major });
    return major;
  } catch {
    return 7;
  }
}

function requireIndex(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('index is required');
  if (s.includes('/') || s.includes('?') || s.includes(' ') || s.startsWith('-') || s.includes('..')) {
    throw new Error(`invalid index name: "${s}"`);
  }
  return s;
}

/** Reject scripting keys anywhere in a client-supplied query tree. */
function forbidScripts(doc: unknown, depth = 0): void {
  if (depth > 25 || doc === null || typeof doc !== 'object') return;
  if (Array.isArray(doc)) { for (const it of doc) forbidScripts(it, depth + 1); return; }
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (k === 'script' || k === 'script_score' || k === 'script_fields') {
      throw new Error(`query dùng "${k}" — scripting bị chặn trong tool này`);
    }
    forbidScripts(v, depth + 1);
  }
}

function parseJson(raw: unknown, label: string): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  let v: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return {};
    try { v = JSON.parse(s); } catch (e) { throw new Error(`${label} không phải JSON hợp lệ: ${(e as Error).message}`); }
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} phải là JSON object`);
  return v as Record<string, unknown>;
}

/** Rendered document guard — mirrors the Mongo tab. */
const DOC_JSON_CAP = 200_000;
function toWire(doc: unknown): { json: string; truncated: boolean } {
  const json = JSON.stringify(doc);
  if (json.length <= DOC_JSON_CAP) return { json, truncated: false };
  return { json: json.slice(0, DOC_JSON_CAP), truncated: true };
}

// ── Probes ────────────────────────────────────────────────────────────────────

export interface EsTestResult {
  latencyMs: number;
  clusterName: string;
  version: string;
  /** green / yellow / red. */
  status: string;
  nodes: number;
}

export async function testConnection(conn: EsConnection): Promise<EsTestResult> {
  const t0 = Date.now();
  const root = await esFetch<{ cluster_name?: string; version?: { number?: string } }>(conn, '/');
  const latencyMs = Date.now() - t0;
  const health = await esFetch<{ status?: string; number_of_nodes?: number }>(conn, '/_cluster/health').catch(() => ({} as Record<string, never>));
  return {
    latencyMs,
    clusterName: String(root.cluster_name ?? '?'),
    version: String(root.version?.number ?? '?'),
    status: String((health as { status?: string }).status ?? '?'),
    nodes: Number((health as { number_of_nodes?: number }).number_of_nodes ?? 0),
  };
}

export interface EsHealthResult extends EsTestResult {
  activeShards: number;
  unassignedShards: number;
  relocatingShards: number;
  pendingTasks: number;
}

export async function clusterHealth(conn: EsConnection): Promise<EsHealthResult> {
  const t0 = Date.now();
  const root = await esFetch<{ cluster_name?: string; version?: { number?: string } }>(conn, '/');
  const latencyMs = Date.now() - t0;
  const h = await esFetch<Record<string, unknown>>(conn, '/_cluster/health');
  return {
    latencyMs,
    clusterName: String(root.cluster_name ?? '?'),
    version: String(root.version?.number ?? '?'),
    status: String(h.status ?? '?'),
    nodes: Number(h.number_of_nodes ?? 0),
    activeShards: Number(h.active_shards ?? 0),
    unassignedShards: Number(h.unassigned_shards ?? 0),
    relocatingShards: Number(h.relocating_shards ?? 0),
    pendingTasks: Number(h.number_of_pending_tasks ?? 0),
  };
}

// ── Node stats (heap / disk / cpu / load — for the 10s monitor) ───────────────

export interface EsNodeInfo {
  name: string;
  ip: string;
  /** Role letters as reported by _cat/nodes (dim, cdfhilmrstw, …). */
  roles: string;
  /** True for the elected master ("*" in the master column). */
  master: boolean;
  heapPercent: number | null;
  ramPercent: number | null;
  /** Recent CPU usage percent. */
  cpu: number | null;
  load1m: number | null;
  load5m: number | null;
  load15m: number | null;
  diskUsedPercent: number | null;
  diskTotalBytes: number | null;
  diskAvailBytes: number | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** _cat/nodes — heap/ram/cpu/load/disk per node. Same columns on 6.8 → 8.x. */
export async function listNodes(conn: EsConnection): Promise<EsNodeInfo[]> {
  const rows = await esFetch<Record<string, string>[]>(
    conn,
    '/_cat/nodes?format=json&bytes=b&h=name,ip,node.role,master,heap.percent,ram.percent,cpu,load_1m,load_5m,load_15m,disk.used_percent,disk.total,disk.avail',
  );
  return rows
    .map((r) => ({
      name: String(r.name ?? '?'),
      ip: String(r.ip ?? ''),
      roles: String(r['node.role'] ?? ''),
      master: r.master === '*',
      heapPercent: num(r['heap.percent']),
      ramPercent: num(r['ram.percent']),
      cpu: num(r.cpu),
      load1m: num(r.load_1m),
      load5m: num(r.load_5m),
      load15m: num(r.load_15m),
      diskUsedPercent: num(r['disk.used_percent']),
      diskTotalBytes: num(r['disk.total']),
      diskAvailBytes: num(r['disk.avail']),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Indices ───────────────────────────────────────────────────────────────────

export interface EsIndexInfo {
  name: string;
  health: string;
  status: string;
  docsCount: number;
  sizeBytes: number;
  primaries: number;
  replicas: number;
}

/** _cat/indices — system indices (leading '.') filtered out. */
export async function listIndices(conn: EsConnection): Promise<EsIndexInfo[]> {
  const rows = await esFetch<Record<string, string>[]>(
    conn,
    '/_cat/indices?format=json&bytes=b&h=index,health,status,docs.count,store.size,pri,rep',
  );
  return rows
    .map((r) => ({
      name: String(r.index ?? ''),
      health: String(r.health ?? '?'),
      status: String(r.status ?? '?'),
      docsCount: Number(r['docs.count'] ?? 0),
      sizeBytes: Number(r['store.size'] ?? 0),
      primaries: Number(r.pri ?? 0),
      replicas: Number(r.rep ?? 0),
    }))
    .filter((r) => r.name && !r.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Full mapping of one index, pretty-printed (capped). */
export async function getMapping(conn: EsConnection, index: string): Promise<{ json: string; truncated: boolean }> {
  const idx = requireIndex(index);
  const m = await esFetch<Record<string, unknown>>(conn, `/${encodeURIComponent(idx)}/_mapping`);
  const pretty = JSON.stringify(m, null, 2);
  if (pretty.length <= DOC_JSON_CAP) return { json: pretty, truncated: false };
  return { json: pretty.slice(0, DOC_JSON_CAP), truncated: true };
}

// ── Search / count ────────────────────────────────────────────────────────────

export interface EsSearchInput {
  /** JSON string (or object): the `query` clause. Empty → match_all. */
  query?: unknown;
  /** JSON string: _source include list (["a","b"]) — optional. */
  source?: unknown;
  /** JSON string: sort clause — optional. */
  sort?: unknown;
  size?: unknown;
  from?: unknown;
}

export interface EsSearchResult {
  docs: { json: string; truncated: boolean }[];
  /** total matched (value + relation "eq"/"gte" — ES7; ES6 numbers normalized). */
  total: number;
  totalRelation: 'eq' | 'gte';
  size: number;
  from: number;
  tookMs: number;
}

function parseSort(raw: unknown): unknown[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let v: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return undefined;
    try { v = JSON.parse(s); } catch (e) { throw new Error(`sort không phải JSON hợp lệ: ${(e as Error).message}`); }
  }
  return Array.isArray(v) ? v : [v];
}

function parseSource(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let v: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return undefined;
    try { v = JSON.parse(s); } catch { v = s.split(',').map((x) => x.trim()).filter(Boolean); }
  }
  if (!Array.isArray(v) || v.length === 0) return undefined;
  return v.map(String);
}

export async function search(conn: EsConnection, index: string, input: EsSearchInput): Promise<EsSearchResult> {
  const idx = requireIndex(index);
  const query = parseJson(input.query, 'query');
  forbidScripts(query);
  const size = Math.min(Math.max(Number(input.size) || SEARCH_SIZE_DEFAULT, 1), SEARCH_SIZE_MAX);
  const fromRaw = Number(input.from);
  const from = Math.min(Math.max(Number.isInteger(fromRaw) ? fromRaw : 0, 0), RESULT_WINDOW - size);

  const body: Record<string, unknown> = {
    query: Object.keys(query).length ? query : { match_all: {} },
    size,
    from,
    timeout: '15s',
  };
  // `track_total_hits` exists only from ES 7 — 6.8 rejects the unknown key
  // (its hits.total is an exact NUMBER already, normalized below).
  if (await getMajor(conn) >= 7) body.track_total_hits = true;
  const sort = parseSort(input.sort);
  if (sort) body.sort = sort;
  const source = parseSource(input.source);
  if (source) body._source = source;

  const t0 = Date.now();
  const res = await esFetch<{
    took?: number;
    hits?: { total?: number | { value?: number; relation?: string }; hits?: { _id: string; _source?: Record<string, unknown> }[] };
  }>(conn, `/${encodeURIComponent(idx)}/_search`, body);
  const tookMs = Date.now() - t0;

  const rawTotal = res.hits?.total;
  const total = typeof rawTotal === 'number' ? rawTotal : Number(rawTotal?.value ?? 0);
  const totalRelation: 'eq' | 'gte' = typeof rawTotal === 'object' && rawTotal?.relation === 'gte' ? 'gte' : 'eq';
  const docs = (res.hits?.hits ?? []).map((h) => toWire({ _id: h._id, ...(h._source ?? {}) }));
  return { docs, total, totalRelation, size, from, tookMs };
}

export async function count(conn: EsConnection, index: string, rawQuery: unknown): Promise<{ count: number; tookMs: number }> {
  const idx = requireIndex(index);
  const query = parseJson(rawQuery, 'query');
  forbidScripts(query);
  const body = Object.keys(query).length ? { query } : undefined;
  const t0 = Date.now();
  const res = await esFetch<{ count?: number }>(conn, `/${encodeURIComponent(idx)}/_count`, body ?? { query: { match_all: {} } });
  return { count: Number(res.count ?? 0), tookMs: Date.now() - t0 };
}
