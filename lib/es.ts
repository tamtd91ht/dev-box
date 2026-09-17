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
  /** Giá trị sort của hit cuối — đưa lại vào `searchAfter` để lấy trang kế.
   *  null khi body không sort hoặc trang rỗng. */
  lastSort: unknown[] | null;
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
  /** Con trỏ search_after (mảng giá trị sort của hit cuối trang trước).
   *  Có nó thì `from` bị bỏ qua — xem EsSearchInput ở lib/esClient. */
  searchAfter?: unknown[];
}

export function searchEs(connectionId: string, index: string, p: EsSearchParams): Promise<EsSearchResult> {
  return esAction<EsSearchResult>('search', { connectionId, index, ...p });
}

/**
 * Một trang của vòng scroll — đường phân trang của XUẤT BÁO CÁO.
 *
 * Vì sao là scroll chứ không phải search_after: xem khối ghi chú dài ở
 * lib/esClient.ts (tóm tắt: search_after cần một khoá sort định danh được từng
 * document, mà không cụm nào cũng có — `_id` thì ES 8 chặn fielddata nên cả
 * lần xuất chết ngay với "all shards failed").
 */
export interface EsScrollPage {
  docs: WireDoc[];
  tookMs: number;
  /** Con trỏ trang kế — ES có thể ĐỔI id giữa các trang, luôn gửi lại cái mới nhất. */
  scrollId: string | null;
}

export interface EsScrollParams {
  /** NGUYÊN body _search (tab Dữ liệu). */
  body?: string;
  /** `query` rời (tab Tìm nhanh). */
  query?: string;
  /** Sort của lần xuất — đè lên sort trong body. Rỗng = không sort. */
  sort?: string;
  source?: string;
  size?: number;
}

/** Mở scroll + lấy trang đầu. */
export function scrollStartEs(connectionId: string, index: string, p: EsScrollParams): Promise<EsScrollPage> {
  return esAction<EsScrollPage>('scroll', { connectionId, index, mode: 'start', ...p });
}

/** Trang kế. */
export function scrollNextEs(connectionId: string, scrollId: string): Promise<EsScrollPage> {
  return esAction<EsScrollPage>('scroll', { connectionId, mode: 'next', scrollId });
}

/** Đóng scroll. Gọi xong lần xuất (kể cả khi lỗi) để cụm thu hồi context. */
export function scrollClearEs(connectionId: string, scrollId: string): Promise<{ ok: boolean }> {
  return esAction<{ ok: boolean }>('scroll', { connectionId, mode: 'clear', scrollId });
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

/**
 * Tên field top-level suy từ chính kết quả trả về — nguồn gợi ý cột khi export.
 *
 * Vì sao không dùng mapping: index thật thường khai hàng trăm field mà một truy
 * vấn chỉ trả về vài chục, và `_source` có thể đã lọc bớt. Lấy từ document thật
 * cho danh sách đúng thứ ĐANG có trong tay. Chỉ soi 25 doc đầu là đủ đại diện
 * mà không tốn thời gian parse cả trang.
 *
 * `_id` bị loại vì nó không nằm trong `_source` — chỗ gọi tự thêm vào nếu cần.
 */
export function deriveEsFieldNames(docs: WireDoc[]): string[] {
  const keys = new Set<string>();
  for (const d of docs.slice(0, 25)) {
    try {
      for (const k of Object.keys(JSON.parse(d.json) as Record<string, unknown>)) keys.add(k);
    } catch { /* doc bị cắt — bỏ qua */ }
  }
  keys.delete('_id');
  return [...keys].sort((a, b) => a.localeCompare(b));
}
