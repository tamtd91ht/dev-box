// Client-side helpers + shared types for the Elasticsearch workspace. All calls
// go to the same-origin /api/es* routes (the Next server issues the HTTP calls
// to the cluster — the browser never reaches ES directly). Browser-safe: no fs,
// no server-only imports.

export interface PublicEsConnection {
  id: string;
  name: string;
  project: string;
  /** Cluster node addresses, "host:port" (≥1 — multiple = failover list). */
  nodes: string[];
  tls: boolean;
}

export interface EsConnectionsResponse {
  enabled: boolean;
  connections: PublicEsConnection[];
}

export interface EsTestResult {
  latencyMs: number;
  clusterName: string;
  version: string;
  status: string;
  nodes: number;
}

export interface EsHealthResult extends EsTestResult {
  activeShards: number;
  unassignedShards: number;
  relocatingShards: number;
  pendingTasks: number;
}

export interface EsNodeInfo {
  name: string;
  ip: string;
  roles: string;
  master: boolean;
  heapPercent: number | null;
  ramPercent: number | null;
  cpu: number | null;
  load1m: number | null;
  load5m: number | null;
  load15m: number | null;
  diskUsedPercent: number | null;
  diskTotalBytes: number | null;
  diskAvailBytes: number | null;
}

export interface EsIndexInfo {
  name: string;
  health: string;
  status: string;
  docsCount: number;
  sizeBytes: number;
  primaries: number;
  replicas: number;
}

export interface WireDoc {
  json: string;
  truncated: boolean;
}

export interface EsSearchResult {
  docs: WireDoc[];
  total: number;
  totalRelation: 'eq' | 'gte';
  size: number;
  from: number;
  tookMs: number;
  /** Kết quả `aggregations` — null khi request không có aggs. */
  aggs: WireDoc | null;
}

// ── Connection registry (CRUD) ────────────────────────────────────────────────

export async function fetchEsConnections(): Promise<EsConnectionsResponse> {
  try {
    const r = await fetch('/api/es-connections');
    if (!r.ok) return { enabled: false, connections: [] };
    return (await r.json()) as EsConnectionsResponse;
  } catch {
    return { enabled: false, connections: [] };
  }
}

export async function mutateEsConnection(
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<PublicEsConnection[]> {
  const r = await fetch('/api/es-connections', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { connections: PublicEsConnection[] }).connections;
}

// ── ES operations ─────────────────────────────────────────────────────────────

async function esAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/es', {
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

export function testEsConnection(input: { nodes: string; tls?: boolean }): Promise<EsTestResult> {
  return esAction<EsTestResult>('test', input);
}

export function pingEs(connectionId: string): Promise<{ latencyMs: number }> {
  return esAction<{ latencyMs: number }>('ping', { connectionId });
}

export function esHealth(connectionId: string): Promise<EsHealthResult> {
  return esAction<EsHealthResult>('health', { connectionId });
}

export function listEsIndices(connectionId: string): Promise<EsIndexInfo[]> {
  return esAction<EsIndexInfo[]>('indices', { connectionId });
}

export function listEsNodes(connectionId: string): Promise<EsNodeInfo[]> {
  return esAction<EsNodeInfo[]>('nodes', { connectionId });
}

export function esMapping(connectionId: string, index: string): Promise<WireDoc> {
  return esAction<WireDoc>('mapping', { connectionId, index });
}

export interface EsSearchParams {
  /** NGUYÊN body _search (JSON, kiểu Kibana Dev Tools) — có thì các field rời bị bỏ qua. */
  body?: string;
  query?: string;
  /** Phần `aggs` của body _search (JSON) — bỏ trống nếu không thống kê. */
  aggs?: string;
  source?: string;
  sort?: string;
  /** 0 = chỉ lấy aggregations. */
  size?: number;
  /** Phân trang — đè lên `from` trong body (nếu có). */
  from?: number;
}

export function searchEs(connectionId: string, index: string, p: EsSearchParams): Promise<EsSearchResult> {
  return esAction<EsSearchResult>('search', { connectionId, index, ...p });
}

export function countEs(connectionId: string, index: string, query: string, body?: string): Promise<{ count: number; tookMs: number }> {
  return esAction<{ count: number; tookMs: number }>('count', { connectionId, index, query, body });
}

/** Mức nguy hiểm của lệnh console — xem classifyConsoleCommand ở lib/esClient. */
export type EsConsoleRisk = 'read' | 'write' | 'destructive';

export interface EsConsoleResult {
  method: string;
  path: string;
  risk: EsConsoleRisk;
  status: number;
  ok: boolean;
  /** Response đã pretty-print (server cắt bớt nếu quá dài). */
  json: string;
  truncated: boolean;
  tookMs: number;
  node: string;
}

/**
 * Gọi một lệnh REST nguyên bản (tab Console) — ghi được, kể cả PUT/DELETE.
 * Lệnh bị xếp 'destructive' đòi `confirmed: true`; thiếu cờ đó server từ chối,
 * nên modal xác nhận ở UI không phải là chốt duy nhất.
 */
export function esConsole(
  connectionId: string,
  cmd: { method: string; path: string; body?: string; confirmed?: boolean },
): Promise<EsConsoleResult> {
  return esAction<EsConsoleResult>('console', { connectionId, ...cmd });
}

// ── Shared formatters ─────────────────────────────────────────────────────────

export { fmtBytes, fmtCount, prettyDoc } from '@/lib/mongo';
