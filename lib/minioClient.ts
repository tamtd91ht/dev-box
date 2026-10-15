// Server-only MinIO / S3 operations for the local object-storage workspace.
//
// SAFETY MODEL — connects to real object stores (possibly production) from the
// machine hosting the Next.js server, so it is deliberately constrained and gated
// off in any deploy:
//   1. Gated by MINIO_TOOL_ENABLED — the API routes 403 unless truthy.
//   2. READS (list/stat/download/presign/probe) are always available.
//   3. WRITES (upload, delete object/prefix, create/remove bucket) need BOTH the
//      MINIO_ALLOW_WRITE env AND the per-connection `readOnly = false` (defaults
//      true) — plus a typed-confirm / confirm dialog in the UI for deletes.
//   4. Bucket/object names are validated before they reach the SDK; nothing is
//      ever interpolated into a shell or a URL by hand.

import http from 'http';
import https from 'https';
import { Client } from 'minio';
import type { Readable } from 'stream';
import type { MinioConnection } from '@/lib/minioConnections';
import { fetchHostMetrics, type HostMetrics } from '@/lib/hostMetrics';

export const MINIO_ENABLED = /^(1|true|yes|on)$/i.test(process.env.MINIO_TOOL_ENABLED ?? '');
/** Global write gate — even when on, per-connection readOnly still applies. */
export const MINIO_ALLOW_WRITE = /^(1|true|yes|on)$/i.test(process.env.MINIO_ALLOW_WRITE ?? '');

export const OBJECTS_PAGE = 500;
const PROBE_TIMEOUT_MS = 5000;
const UPLOAD_MAX_BYTES = (Number(process.env.MINIO_UPLOAD_MAX_MB) || 200) * 1024 * 1024;
const SCAN_OBJECTS_MAX = 100_000;
export const UPLOAD_LIMIT_BYTES = UPLOAD_MAX_BYTES;

// ── Client cache ────────────────────────────────────────────────────────────

interface Cached {
  client: Client;
  agent: http.Agent | https.Agent;
  sig: string;
}
const clients = new Map<string, Cached>();

function sigOf(c: MinioConnection): string {
  return [c.host, c.port, c.tls, c.accessKey, c.secretKey ?? '', c.region ?? ''].join('|');
}

function entry(conn: MinioConnection): Cached {
  const sig = sigOf(conn);
  const hit = clients.get(conn.id);
  if (hit && hit.sig === sig) return hit;
  // Server nội bộ hay dùng chứng chỉ tự ký — cùng quy ước với tab Postgres (ssl
  // không kiểm chain). Agent dùng chung cho cả SDK lẫn các request health.
  const agent = conn.tls
    ? new https.Agent({ rejectUnauthorized: false, keepAlive: true })
    : new http.Agent({ keepAlive: true });
  const client = new Client({
    endPoint: conn.host,
    port: conn.port,
    useSSL: conn.tls,
    accessKey: conn.accessKey,
    secretKey: conn.secretKey ?? '',
    region: conn.region,
    transportAgent: agent,
  });
  const next = { client, agent, sig };
  clients.set(conn.id, next);
  return next;
}

export function getClient(conn: MinioConnection): Client {
  return entry(conn).client;
}

// ── Validation ──────────────────────────────────────────────────────────────

/** S3 bucket naming (3–63, lowercase letters/digits/dots/hyphens). */
export function validBucket(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s)) throw new Error(`tên bucket không hợp lệ: "${s}"`);
  return s;
}

function validObject(raw: unknown): string {
  const s = String(raw ?? '');
  if (!s || s.length > 1024 || s.includes('\0')) throw new Error('tên object không hợp lệ');
  return s;
}

function validPrefix(raw: unknown): string {
  const s = String(raw ?? '');
  if (s.length > 1024 || s.includes('\0')) throw new Error('prefix không hợp lệ');
  return s;
}

/** Ghi được không: env + cờ của connection. Ném lỗi dễ hiểu nếu không. */
export function assertWritable(conn: MinioConnection): void {
  if (!MINIO_ALLOW_WRITE) throw new Error('ghi đang bị khoá toàn tool — đặt MINIO_ALLOW_WRITE=true (chỉ dùng local)');
  if (conn.readOnly) throw new Error(`server "${conn.name}" đang ở chế độ read-only — sửa server và bỏ chọn Read-only để ghi`);
}

// ── Probes ──────────────────────────────────────────────────────────────────

interface HttpProbe {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** GET một đường dẫn trên chính endpoint MinIO (health, metrics) — không ném lỗi, status 0 khi hỏng. */
function httpGet(conn: MinioConnection, urlPath: string, wantBody = false, timeoutMs = PROBE_TIMEOUT_MS): Promise<HttpProbe> {
  const { agent } = entry(conn);
  const mod = conn.tls ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(
      { host: conn.host, port: conn.port, path: urlPath, method: 'GET', agent, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (d: Buffer) => {
          if (!wantBody) return;
          size += d.length;
          if (size <= 4 * 1024 * 1024) chunks.push(d);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
        if (!wantBody) res.resume();
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    req.end();
  });
}

export interface MinioTestResult {
  latencyMs: number;
  buckets: number;
  /** /minio/health/live trả 200. */
  live: boolean;
  /** /minio/health/cluster trả 200 (đủ quorum ghi). */
  clusterOk: boolean;
  /** Header Server của MinIO (vd "MinIO"), nếu có. */
  server?: string;
  deploymentId?: string;
}

export async function testConnection(conn: MinioConnection): Promise<MinioTestResult> {
  const client = getClient(conn);
  const t0 = Date.now();
  const list = await client.listBuckets(); // cũng kiểm access/secret key
  const latencyMs = Date.now() - t0;
  const [live, cluster] = await Promise.all([
    httpGet(conn, '/minio/health/live'),
    httpGet(conn, '/minio/health/cluster'),
  ]);
  const server = cluster.headers['server'] ?? live.headers['server'];
  const dep = cluster.headers['x-minio-deployment-id'] ?? live.headers['x-minio-deployment-id'];
  return {
    latencyMs,
    buckets: list.length,
    live: live.status === 200,
    // Không phải MinIO (S3 khác) thì không có /minio/health — coi như ổn nếu list được.
    clusterOk: cluster.status === 200 || cluster.status === 0 || cluster.status === 404,
    server: typeof server === 'string' ? server : undefined,
    deploymentId: typeof dep === 'string' ? dep : undefined,
  };
}

export async function ping(conn: MinioConnection): Promise<{ latencyMs: number }> {
  const t0 = Date.now();
  await getClient(conn).listBuckets();
  return { latencyMs: Date.now() - t0 };
}

// ── Prometheus metrics ───────────────────────────────────────────────────────
//
// MinIO expose metrics Prometheus ở /minio/v2/metrics/{cluster,bucket,node}. Mặc
// định yêu cầu token (`mc admin prometheus generate`) trừ khi MinIO chạy với
// MINIO_PROMETHEUS_AUTH_TYPE=public. Connection có thể khai `metricsUrl` (host/cổng
// khác, sau proxy) và `metricsToken` — còn không thì dùng chính endpoint API.

/** Cộng gộp mọi dòng của một metric (có hoặc không có nhãn). */
function promSum(text: string, name: string): number | undefined {
  let total = 0;
  let found = false;
  const re = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+|NaN|\\+Inf)\\s*$`, 'gm');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) {
      total += v;
      found = true;
    }
  }
  return found ? total : undefined;
}

/** Giá trị theo nhãn `bucket` của một metric. */
function promByBucket(text: string, name: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = new RegExp(`^${name}\\{([^}]*)\\}\\s+([0-9.eE+-]+)\\s*$`, 'gm');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const b = /bucket="([^"]*)"/.exec(m[1]);
    const v = Number(m[2]);
    if (b && Number.isFinite(v)) out.set(b[1], (out.get(b[1]) ?? 0) + v);
  }
  return out;
}

/** GET một URL tuyệt đối (metrics có thể ở host/cổng khác endpoint API). */
function fetchUrl(conn: MinioConnection, rawUrl: string, token?: string, timeoutMs = 4000): Promise<HttpProbe> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return Promise.resolve({ status: 0, headers: {}, body: '' }); }
  const tls = u.protocol === 'https:';
  const agent = tls ? new https.Agent({ rejectUnauthorized: false }) : new http.Agent();
  void conn;
  return new Promise((resolve) => {
    const req = (tls ? https : http).request(
      {
        host: u.hostname,
        port: u.port || (tls ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        agent,
        timeout: timeoutMs,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size <= 8 * 1024 * 1024) chunks.push(d);
        });
        res.on('end', () => { agent.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); });
        res.on('error', () => { agent.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
      },
    );
    req.on('timeout', () => { req.destroy(); agent.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
    req.on('error', () => { agent.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
    req.end();
  });
}

// ── Console: đăng nhập hộ ────────────────────────────────────────────────────
//
// Console (giao diện web, cổng 9001) có đăng nhập RIÊNG: POST /api/v1/login với
// {accessKey, secretKey} → Set-Cookie phiên. DevBox đã giữ sẵn cặp key nên làm bước
// này hộ ở SERVER — trình duyệt không bao giờ thấy secret, chỉ nhận cookie phiên
// (JWT hết hạn sau vài chục phút) để nạp vào khung Console. Không dùng được với
// Console cấu hình SSO/OIDC-only (khi đó không có form key để đăng nhập).

export interface ConsoleSession {
  /** Địa chỉ Console đã chuẩn hoá (không có "/" cuối). */
  url: string;
  cookies: { name: string; value: string }[];
}

export async function consoleLogin(conn: MinioConnection): Promise<ConsoleSession> {
  if (!conn.consoleUrl) throw new Error('server này chưa khai Console URL — sửa server và điền địa chỉ Console');
  const base = conn.consoleUrl.replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(`${base}/api/v1/login`); } catch { throw new Error(`Console URL không hợp lệ: ${conn.consoleUrl}`); }
  const tls = u.protocol === 'https:';
  const agent = tls ? new https.Agent({ rejectUnauthorized: false }) : new http.Agent();
  const payload = JSON.stringify({ accessKey: conn.accessKey, secretKey: conn.secretKey ?? '' });
  const res = await new Promise<{ status: number; setCookie: string[]; body: string }>((resolve, reject) => {
    const req = (tls ? https : http).request(
      {
        host: u.hostname,
        port: u.port || (tls ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        agent,
        timeout: 8000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => { if (chunks.length < 64) chunks.push(d); });
        r.on('end', () => {
          agent.destroy();
          resolve({ status: r.statusCode ?? 0, setCookie: r.headers['set-cookie'] ?? [], body: Buffer.concat(chunks).toString('utf8').slice(0, 300) });
        });
        r.on('error', (e) => { agent.destroy(); reject(e); });
      },
    );
    req.on('timeout', () => { req.destroy(); agent.destroy(); reject(new Error('Console không phản hồi (timeout 8s)')); });
    req.on('error', (e) => { agent.destroy(); reject(new Error(`không kết nối được Console: ${e.message}`)); });
    req.write(payload);
    req.end();
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Console từ chối đăng nhập — sai access/secret key, hoặc Console chỉ cho đăng nhập qua SSO/OIDC');
  }
  if (res.status === 404) throw new Error('Console không có /api/v1/login — Console URL có thể trỏ nhầm sang S3 API (cổng 9000) thay vì Console (9001)');
  if (res.status < 200 || res.status >= 300) throw new Error(`Console trả HTTP ${res.status}${res.body ? `: ${res.body}` : ''}`);
  const cookies = res.setCookie
    .map((line) => {
      const first = line.split(';')[0];
      const eq = first.indexOf('=');
      return eq > 0 ? { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() } : null;
    })
    .filter((c): c is { name: string; value: string } => !!c && !!c.value);
  if (cookies.length === 0) throw new Error('Console đăng nhập được nhưng không trả cookie phiên');
  return { url: base, cookies };
}

/** "http://ip:9000" (không đường dẫn) → thêm /minio/v2/metrics/cluster; có đường dẫn rồi thì giữ nguyên. */
function withMetricsPath(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.pathname === '' || u.pathname === '/') return `${u.origin}/minio/v2/metrics/cluster${u.search}`;
  } catch {
    /* URL vẹo — để fetchUrl báo lỗi */
  }
  return raw;
}

/** Địa chỉ gốc của endpoint API (dùng để dựng URL metrics mặc định). */
function apiBase(conn: MinioConnection): string {
  return `${conn.tls ? 'https' : 'http'}://${conn.host}:${conn.port}`;
}

export interface MinioBucketUsage {
  bucket: string;
  sizeBytes: number;
  objects: number | null;
}

export interface MinioMetrics {
  /** Đọc được metrics không. false = chưa cấu hình token / MinIO chặn / URL sai. */
  available: boolean;
  /** URL đã dùng. */
  source: string;
  /** Vì sao không đọc được (nếu available=false). */
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

/** Đọc + parse metrics cụm (và dung lượng theo bucket nếu có). Không ném lỗi. */
export async function metrics(conn: MinioConnection): Promise<MinioMetrics> {
  const source = withMetricsPath(conn.metricsUrl) || `${apiBase(conn)}/minio/v2/metrics/cluster`;
  const cluster = await fetchUrl(conn, source, conn.metricsToken);
  if (cluster.status !== 200 || !cluster.body) {
    const reason =
      cluster.status === 0 ? 'không kết nối được tới URL metrics'
      : cluster.status === 401 || cluster.status === 403 ? 'MinIO yêu cầu token — điền Bearer token (mc admin prometheus generate) hoặc bật MINIO_PROMETHEUS_AUTH_TYPE=public'
      : cluster.status === 404 ? 'URL metrics không tồn tại (sai đường dẫn / MinIO bản khác)'
      : `HTTP ${cluster.status}`;
    return { available: false, source, reason, bucketUsage: [] };
  }
  const t = cluster.body;
  const usableTotal = promSum(t, 'minio_cluster_capacity_usable_total_bytes');
  const usableFree = promSum(t, 'minio_cluster_capacity_usable_free_bytes');
  const m: MinioMetrics = {
    available: true,
    source,
    usableTotalBytes: usableTotal,
    usableFreeBytes: usableFree,
    rawTotalBytes: promSum(t, 'minio_cluster_capacity_raw_total_bytes'),
    rawFreeBytes: promSum(t, 'minio_cluster_capacity_raw_free_bytes'),
    usedBytes: promSum(t, 'minio_cluster_usage_total_bytes'),
    objects: promSum(t, 'minio_cluster_usage_object_total'),
    buckets: promSum(t, 'minio_cluster_bucket_total'),
    nodesOnline: promSum(t, 'minio_cluster_nodes_online_total'),
    nodesOffline: promSum(t, 'minio_cluster_nodes_offline_total'),
    drivesOnline: promSum(t, 'minio_cluster_drive_online_total'),
    drivesOffline: promSum(t, 'minio_cluster_drive_offline_total'),
    drivesTotal: promSum(t, 'minio_cluster_drive_total'),
    bucketUsage: [],
  };
  // Dung lượng theo bucket nằm ở endpoint /bucket (cùng thư mục, cùng token).
  const bucketUrl = source.replace(/\/cluster(\/?)(\?.*)?$/, '/bucket$1$2');
  if (bucketUrl !== source) {
    const bk = await fetchUrl(conn, bucketUrl, conn.metricsToken);
    if (bk.status === 200 && bk.body) {
      const size = promByBucket(bk.body, 'minio_bucket_usage_total_bytes');
      const count = promByBucket(bk.body, 'minio_bucket_usage_object_total');
      m.bucketUsage = [...size.entries()]
        .map(([bucket, sizeBytes]) => ({ bucket, sizeBytes, objects: count.get(bucket) ?? null }))
        .sort((a, b) => b.sizeBytes - a.sizeBytes);
    }
  }
  return m;
}

/**
 * Chỉ số cho Monitor/Automation. Luôn có `up` + `latencyMs` + `buckets` + `clusterDown`;
 * thêm dung lượng/node/ổ/object khi đọc được metrics. Phần metrics là best-effort:
 * không đọc được thì bỏ qua, KHÔNG làm probe thất bại.
 */
export async function probe(conn: MinioConnection): Promise<Record<string, number>> {
  const t = await testConnection(conn);
  const m: Record<string, number> = {
    up: 1,
    latencyMs: Math.round(t.latencyMs),
    buckets: t.buckets,
    clusterDown: t.clusterOk ? 0 : 1,
  };
  const x = await metrics(conn).catch(() => null);
  if (x?.available) {
    const total = x.usableTotalBytes;
    const free = x.usableFreeBytes;
    if (total && total > 0 && free !== undefined) {
      m.diskUsedPct = Math.round(((total - free) / total) * 1000) / 10;
      m.diskTotalGb = Math.round((total / 1024 ** 3) * 10) / 10;
      m.diskUsedGb = Math.round(((total - free) / 1024 ** 3) * 10) / 10;
    }
    if (x.nodesOffline !== undefined) m.nodesOffline = x.nodesOffline;
    if (x.nodesOnline !== undefined) m.nodesOnline = x.nodesOnline;
    if (x.drivesOffline !== undefined) m.drivesOffline = x.drivesOffline;
    if (x.drivesOnline !== undefined) m.drivesOnline = x.drivesOnline;
    if (x.objects !== undefined) m.objects = x.objects;
  }
  return m;
}

/** node_exporter của máy chạy MinIO — rỗng nếu connection không khai metricsUrls. */
export async function hostMetrics(conn: MinioConnection): Promise<HostMetrics[]> {
  return fetchHostMetrics(conn.metricsUrls ?? []);
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface MinioBucketInfo {
  name: string;
  createdAt: string | null;
}

export async function listBuckets(conn: MinioConnection): Promise<MinioBucketInfo[]> {
  const list = await getClient(conn).listBuckets();
  return list
    .map((b) => ({ name: b.name, createdAt: b.creationDate ? new Date(b.creationDate).toISOString() : null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface MinioObjectInfo {
  name: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
}

export interface MinioListing {
  prefix: string;
  /** "Thư mục" con (prefix kết thúc bằng "/"). */
  prefixes: string[];
  objects: MinioObjectInfo[];
  /** Còn nữa — truyền `nextAfter` làm startAfter để lấy trang kế. */
  truncated: boolean;
  nextAfter: string | null;
}

export async function listObjects(
  conn: MinioConnection,
  bucket: unknown,
  prefix: unknown,
  startAfter?: unknown,
  limit = OBJECTS_PAGE,
): Promise<MinioListing> {
  const b = validBucket(bucket);
  const p = validPrefix(prefix);
  const after = typeof startAfter === 'string' ? startAfter : '';
  const stream = getClient(conn).listObjectsV2(b, p, false, after);
  const prefixes: string[] = [];
  const objects: MinioObjectInfo[] = [];
  let truncated = false;
  let last = '';
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (it: { name?: string; prefix?: string; size?: number; lastModified?: Date; etag?: string }) => {
      if (prefixes.length + objects.length >= limit) {
        truncated = true;
        stream.destroy();
        return;
      }
      if (it.prefix) {
        prefixes.push(it.prefix);
        last = it.prefix;
      } else if (it.name) {
        objects.push({
          name: it.name,
          size: it.size ?? 0,
          lastModified: it.lastModified ? new Date(it.lastModified).toISOString() : null,
          etag: it.etag ? String(it.etag).replace(/"/g, '') : null,
        });
        last = it.name;
      }
    });
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
    stream.on('error', (e: Error) => reject(e));
  });
  return { prefix: p, prefixes, objects, truncated, nextAfter: truncated ? last : null };
}

export interface MinioObjectStat {
  name: string;
  size: number;
  etag: string | null;
  contentType: string | null;
  lastModified: string | null;
  metadata: Record<string, string>;
}

export async function statObject(conn: MinioConnection, bucket: unknown, object: unknown): Promise<MinioObjectStat> {
  const b = validBucket(bucket);
  const o = validObject(object);
  const st = await getClient(conn).statObject(b, o);
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(st.metaData ?? {})) meta[k] = String(v);
  return {
    name: o,
    size: st.size,
    etag: st.etag ? String(st.etag).replace(/"/g, '') : null,
    contentType: meta['content-type'] ?? null,
    lastModified: st.lastModified ? new Date(st.lastModified).toISOString() : null,
    metadata: meta,
  };
}

/** Dung lượng + số object của một bucket (hoặc prefix) — quét đệ quy, chặn ở SCAN_OBJECTS_MAX. */
export async function bucketStats(
  conn: MinioConnection,
  bucket: unknown,
  prefix: unknown = '',
): Promise<{ objects: number; sizeBytes: number; truncated: boolean }> {
  const b = validBucket(bucket);
  const stream = getClient(conn).listObjectsV2(b, validPrefix(prefix), true);
  let objects = 0;
  let sizeBytes = 0;
  let truncated = false;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (it: { size?: number }) => {
      objects++;
      sizeBytes += it.size ?? 0;
      if (objects >= SCAN_OBJECTS_MAX) {
        truncated = true;
        stream.destroy();
      }
    });
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
    stream.on('error', (e: Error) => reject(e));
  });
  return { objects, sizeBytes, truncated };
}

export async function presignedUrl(conn: MinioConnection, bucket: unknown, object: unknown, expirySec = 3600): Promise<string> {
  const sec = Math.min(Math.max(60, Math.floor(expirySec) || 3600), 7 * 24 * 3600);
  return getClient(conn).presignedGetObject(validBucket(bucket), validObject(object), sec);
}

/** Mở stream đọc một object (cho route download/preview). */
export async function openObject(
  conn: MinioConnection,
  bucket: unknown,
  object: unknown,
): Promise<{ stream: Readable; stat: MinioObjectStat }> {
  const b = validBucket(bucket);
  const o = validObject(object);
  const stat = await statObject(conn, b, o);
  const stream = await getClient(conn).getObject(b, o);
  return { stream, stat };
}

// ── Writes (gated) ──────────────────────────────────────────────────────────

export async function putObject(
  conn: MinioConnection,
  bucket: unknown,
  object: unknown,
  data: Buffer,
  contentType?: string,
): Promise<{ etag: string }> {
  assertWritable(conn);
  if (data.length > UPLOAD_MAX_BYTES) {
    throw new Error(`file lớn hơn giới hạn ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} MB (MINIO_UPLOAD_MAX_MB)`);
  }
  const meta = contentType ? { 'Content-Type': contentType } : {};
  const r = await getClient(conn).putObject(validBucket(bucket), validObject(object), data, data.length, meta);
  return { etag: String(r.etag ?? '').replace(/"/g, '') };
}

export async function removeObject(conn: MinioConnection, bucket: unknown, object: unknown): Promise<void> {
  assertWritable(conn);
  await getClient(conn).removeObject(validBucket(bucket), validObject(object));
}

/** Xoá cả "thư mục" (mọi object dưới prefix). Trả số object đã xoá. */
export async function removePrefix(conn: MinioConnection, bucket: unknown, prefix: unknown): Promise<number> {
  assertWritable(conn);
  const b = validBucket(bucket);
  const p = validPrefix(prefix);
  if (!p || !p.endsWith('/')) throw new Error('prefix phải kết thúc bằng "/" (một thư mục)');
  const client = getClient(conn);
  const names: string[] = [];
  const stream = client.listObjectsV2(b, p, true);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (it: { name?: string }) => { if (it.name) names.push(it.name); });
    stream.on('end', () => resolve());
    stream.on('error', (e: Error) => reject(e));
  });
  for (let i = 0; i < names.length; i += 1000) {
    await client.removeObjects(b, names.slice(i, i + 1000));
  }
  return names.length;
}

export async function makeBucket(conn: MinioConnection, bucket: unknown): Promise<void> {
  assertWritable(conn);
  await getClient(conn).makeBucket(validBucket(bucket), conn.region ?? '');
}

/** Xoá bucket — S3 chỉ cho khi bucket RỖNG. */
export async function removeBucket(conn: MinioConnection, bucket: unknown): Promise<void> {
  assertWritable(conn);
  await getClient(conn).removeBucket(validBucket(bucket));
}
