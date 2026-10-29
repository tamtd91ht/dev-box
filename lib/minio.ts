// Client-side helpers + shared types for the MinIO workspace. All calls go to the
// same-origin /api/minio* routes (the Next server holds the S3 clients — the
// browser never talks to MinIO directly). Browser-safe module.

import { apiFetch } from './apiFetch';

export interface PublicMinioConnection {
  id: string;
  name: string;
  project: string;
  host: string;
  port: number;
  tls: boolean;
  accessKey: string;
  region?: string;
  /** Địa chỉ Console (giao diện web quản trị) — khác endpoint S3 API. */
  consoleUrl?: string;
  /** URL Prometheus metrics (mặc định suy ra từ endpoint API). */
  metricsUrl?: string;
  /** node_exporter của máy chạy MinIO. */
  metricsUrls: string[];
  readOnly: boolean;
  hasSecret: boolean;
  hasMetricsToken: boolean;
}

export interface MinioConnectionsResponse {
  enabled: boolean;
  /** MINIO_ALLOW_WRITE env flag — false greys out every write control up front. */
  allowWrite: boolean;
  connections: PublicMinioConnection[];
}

export interface MinioTestResult {
  latencyMs: number;
  buckets: number;
  live: boolean;
  clusterOk: boolean;
  server?: string;
  deploymentId?: string;
}

export interface MinioBucketUsage {
  bucket: string;
  sizeBytes: number;
  objects: number | null;
}

export interface MinioMetrics {
  available: boolean;
  source: string;
  reason?: string;
  usableTotalBytes?: number;
  usableFreeBytes?: number;
  rawTotalBytes?: number;
  rawFreeBytes?: number;
  usedBytes?: number;
  objects?: number;
  buckets?: number;
  nodesOnline?: number;
  nodesOffline?: number;
  drivesOnline?: number;
  drivesOffline?: number;
  drivesTotal?: number;
  bucketUsage: MinioBucketUsage[];
}

export interface MinioHostDisk {
  mount: string;
  sizeBytes: number;
  availBytes: number;
}

/** Một máy từ node_exporter — cùng hình dạng với Kafka/Postgres. */
export interface MinioHostMetrics {
  url: string;
  host: string;
  error?: string;
  load1?: number;
  memTotalBytes?: number;
  memAvailableBytes?: number;
  disks?: MinioHostDisk[];
  cpuIdleSec?: number;
  cpuTotalSec?: number;
  cpuCores?: number;
  at: number;
}

export interface MinioBucketInfo {
  name: string;
  createdAt: string | null;
}

export interface MinioObjectInfo {
  name: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
}

export interface MinioListing {
  prefix: string;
  prefixes: string[];
  objects: MinioObjectInfo[];
  truncated: boolean;
  nextAfter: string | null;
}

export interface MinioObjectStat {
  name: string;
  size: number;
  etag: string | null;
  contentType: string | null;
  lastModified: string | null;
  metadata: Record<string, string>;
}

// ── Connection registry (CRUD) ────────────────────────────────────────────────

export async function fetchMinioConnections(): Promise<MinioConnectionsResponse> {
  try {
    const r = await apiFetch('/api/minio-connections', { timeoutMs: 15000 });
    if (!r.ok) return { enabled: false, allowWrite: false, connections: [] };
    return (await r.json()) as MinioConnectionsResponse;
  } catch {
    return { enabled: false, allowWrite: false, connections: [] };
  }
}

export async function mutateMinioConnection(
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<PublicMinioConnection[]> {
  const r = await fetch('/api/minio-connections', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { connections: PublicMinioConnection[] }).connections;
}

// ── MinIO operations ──────────────────────────────────────────────────────────

async function minioAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/minio', {
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

export function testMinioConnection(input: {
  host: string; port: number | string; tls?: boolean; accessKey: string; secretKey?: string; connectionId?: string;
}): Promise<MinioTestResult> {
  return minioAction<MinioTestResult>('test', input);
}

export function pingMinio(connectionId: string): Promise<{ latencyMs: number }> {
  return minioAction<{ latencyMs: number }>('ping', { connectionId });
}

/** Chỉ số cho Monitor/Automation (up, latencyMs, buckets, clusterDown, + dung lượng nếu đọc được metrics). */
export function probeMinio(connectionId: string): Promise<{ metrics: Record<string, number> }> {
  return minioAction<{ metrics: Record<string, number> }>('probe', { connectionId });
}

export function minioInfo(connectionId: string): Promise<MinioTestResult> {
  return minioAction<MinioTestResult>('info', { connectionId });
}

/** Đăng nhập Console hộ bằng key đã lưu → cookie phiên (không bao giờ có secret) để nạp vào khung Console. */
export function minioConsoleLogin(connectionId: string): Promise<{ url: string; cookies: { name: string; value: string }[] }> {
  return minioAction('consoleLogin', { connectionId });
}

/** Prometheus metrics của MinIO (dung lượng, node/ổ, dung lượng theo bucket) — `available:false` kèm lý do khi chưa đọc được. */
export function minioMetrics(connectionId: string): Promise<MinioMetrics> {
  return minioAction<MinioMetrics>('metrics', { connectionId });
}

/** node_exporter RAM/đĩa/CPU/load của máy chạy MinIO (rỗng nếu chưa khai metricsUrls). */
export function minioHostMetrics(connectionId: string): Promise<MinioHostMetrics[]> {
  return minioAction<MinioHostMetrics[]>('hostMetrics', { connectionId });
}

export function listMinioBuckets(connectionId: string): Promise<MinioBucketInfo[]> {
  return minioAction<MinioBucketInfo[]>('buckets', { connectionId });
}

export function listMinioObjects(connectionId: string, bucket: string, prefix: string, startAfter?: string): Promise<MinioListing> {
  return minioAction<MinioListing>('objects', { connectionId, bucket, prefix, startAfter });
}

export function statMinioObject(connectionId: string, bucket: string, object: string): Promise<MinioObjectStat> {
  return minioAction<MinioObjectStat>('stat', { connectionId, bucket, object });
}

export function minioBucketStats(connectionId: string, bucket: string, prefix = ''): Promise<{ objects: number; sizeBytes: number; truncated: boolean }> {
  return minioAction('bucketStats', { connectionId, bucket, prefix });
}

export function minioPresign(connectionId: string, bucket: string, object: string, expirySec = 3600): Promise<{ url: string }> {
  return minioAction<{ url: string }>('presign', { connectionId, bucket, object, expirySec });
}

export function minioMakeBucket(connectionId: string, bucket: string): Promise<{ created: boolean }> {
  return minioAction('makeBucket', { connectionId, bucket });
}

export function minioRemoveBucket(connectionId: string, bucket: string): Promise<{ removed: boolean }> {
  return minioAction('removeBucket', { connectionId, bucket });
}

export function minioRemoveObject(connectionId: string, bucket: string, object: string): Promise<{ removed: boolean }> {
  return minioAction('removeObject', { connectionId, bucket, object });
}

export function minioRemovePrefix(connectionId: string, bucket: string, prefix: string): Promise<{ removed: number }> {
  return minioAction('removePrefix', { connectionId, bucket, prefix });
}

/** URL tải/xem trước một object qua server DevBox (stream, không lộ secret). */
export function minioDownloadUrl(connectionId: string, bucket: string, object: string, inline = false): string {
  const q = new URLSearchParams({ connectionId, bucket, object });
  if (inline) q.set('inline', '1');
  return `/api/minio/download?${q.toString()}`;
}

export async function uploadMinioFiles(
  connectionId: string,
  bucket: string,
  prefix: string,
  files: File[],
): Promise<{ uploaded: { name: string; size: number }[] }> {
  const form = new FormData();
  form.set('connectionId', connectionId);
  form.set('bucket', bucket);
  form.set('prefix', prefix);
  for (const f of files) form.append('file', f);
  const r = await fetch('/api/minio/upload', { method: 'POST', body: form });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: { uploaded: { name: string; size: number }[] } }).result;
}

// ── Shared formatters ─────────────────────────────────────────────────────────

export { fmtBytes, fmtCount } from '@/lib/mongo';
