// Server-only persistence + validation for MinIO / S3 "connections".
//
// A connection is an S3-compatible endpoint (MinIO) an operator wants to browse:
//   { id, name, project, host, port, tls, accessKey, secretKey, region?, readOnly }
//
// Persisted to a gitignored local JSON file next to the other registries (see
// lib/configDir). The secret key is PLAINTEXT on local disk — same trade-off as
// the Postgres/Mongo registries; the file never leaves the machine except via the
// explicit export in lib/connTransfer. The browser only ever sees `hasSecret`.

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';

export interface MinioConnection {
  /** Stable opaque id (list key + api param). */
  id: string;
  name: string;
  /** Free-text grouping label (e.g. "vn", "core"). */
  project: string;
  host: string;
  port: number;
  tls: boolean;
  accessKey: string;
  /** Plaintext on local disk (see header). */
  secretKey?: string;
  /** Optional S3 region (MinIO default is us-east-1 and rarely needs setting). */
  region?: string;
  /**
   * Địa chỉ CONSOLE (giao diện web quản trị, thường cổng 9001 hoặc một domain riêng) —
   * KHÁC với endpoint S3 API ở trên. Chỉ để mở nhanh từ tab; DevBox không đăng nhập hộ.
   */
  consoleUrl?: string;
  /**
   * URL Prometheus metrics của MinIO cho Monitor (mặc định `<API>/minio/v2/metrics/cluster`).
   * Điền khi metrics nằm ở host/cổng khác hoặc sau proxy.
   */
  metricsUrl?: string;
  /** Bearer token Prometheus (`mc admin prometheus generate`) — khi MinIO không cho đọc metrics công khai. */
  metricsToken?: string;
  /** node_exporter của máy/các máy chạy MinIO — nguồn đĩa/RAM/CPU máy chủ. */
  metricsUrls: string[];
  /** Per-connection write gate — TRUE (default) blocks upload/delete/bucket changes. */
  readOnly: boolean;
}

/** The client-safe projection — secret stripped, presence flagged. */
export type PublicMinioConnection = Omit<MinioConnection, 'secretKey' | 'metricsToken'> & {
  hasSecret: boolean;
  hasMetricsToken: boolean;
};

/** File holding the connection list. Overridable via MINIO_CONNECTIONS_PATH. */
const CONNECTIONS_FILE = process.env.MINIO_CONNECTIONS_PATH
  ? path.resolve(process.cwd(), process.env.MINIO_CONNECTIONS_PATH)
  : configPath('minioconnections.json', ['.minioconnections.json']);

export function toPublic(c: MinioConnection): PublicMinioConnection {
  const { secretKey, metricsToken, ...rest } = c;
  return { ...rest, hasSecret: !!(secretKey && secretKey.length), hasMetricsToken: !!(metricsToken && metricsToken.length) };
}

async function readRaw(): Promise<MinioConnection[]> {
  try {
    const raw = await fs.readFile(CONNECTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed) ? parsed : [];
    return arr
      .filter((c: unknown): c is MinioConnection => {
        const o = c as MinioConnection;
        return !!o && typeof o.id === 'string' && typeof o.name === 'string';
      })
      .map((c: MinioConnection) => normalize(c));
  } catch {
    return [];
  }
}

async function writeRaw(connections: MinioConnection[]): Promise<void> {
  await fs.writeFile(CONNECTIONS_FILE, JSON.stringify({ connections }, null, 2) + '\n', 'utf8');
}

function normalize(c: MinioConnection): MinioConnection {
  return {
    id: c.id,
    name: c.name,
    project: typeof c.project === 'string' && c.project.trim() ? c.project.trim() : 'default',
    host: typeof c.host === 'string' ? c.host.trim() : '',
    port: Number.isInteger(c.port) ? c.port : 9000,
    tls: !!c.tls,
    accessKey: typeof c.accessKey === 'string' ? c.accessKey.trim() : '',
    secretKey: typeof c.secretKey === 'string' && c.secretKey.length ? c.secretKey : undefined,
    region: typeof c.region === 'string' && c.region.trim() ? c.region.trim() : undefined,
    consoleUrl: typeof c.consoleUrl === 'string' && c.consoleUrl.trim() ? c.consoleUrl.trim() : undefined,
    metricsUrl: typeof c.metricsUrl === 'string' && c.metricsUrl.trim() ? c.metricsUrl.trim() : undefined,
    metricsToken: typeof c.metricsToken === 'string' && c.metricsToken.length ? c.metricsToken : undefined,
    metricsUrls: Array.isArray(c.metricsUrls)
      ? c.metricsUrls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean)
      : [],
    // Locked unless the stored record explicitly says false (pre-flag records → locked).
    readOnly: c.readOnly === undefined ? true : c.readOnly !== false,
  };
}

export async function listConnections(): Promise<PublicMinioConnection[]> {
  return (await readRaw()).map(toPublic);
}

/** Resolve ONE connection WITH its secret — server-side use only. */
export async function getConnection(id: string): Promise<MinioConnection | null> {
  const list = await readRaw();
  return list.find((c) => c.id === id) ?? null;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface MinioConnectionInput {
  name?: unknown;
  project?: unknown;
  host?: unknown;
  port?: unknown;
  tls?: unknown;
  accessKey?: unknown;
  secretKey?: unknown;
  region?: unknown;
  consoleUrl?: unknown;
  metricsUrl?: unknown;
  metricsToken?: unknown;
  metricsUrls?: unknown;
  readOnly?: unknown;
}

/**
 * Chấp nhận cả URL đầy đủ lẫn dạng gõ tắt: "192.168.2.90:9001", "localhost:9001",
 * "console.minio.vn". Thiếu scheme thì tự thêm: IP / localhost / có port → http://,
 * domain trần → https://. Đường dẫn (vd /minio/v2/metrics/cluster) được giữ nguyên.
 */
function httpUrl(raw: unknown, what: string): string | undefined {
  let u = typeof raw === 'string' ? raw.trim() : '';
  if (!u) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    const hostPart = u.replace(/\/.*$/, '');
    const plain = /^(\d{1,3}(\.\d{1,3}){3}|localhost|\[[0-9a-f:]+\])(:\d+)?$/i.test(hostPart) || /:\d+$/.test(hostPart);
    u = `${plain ? 'http' : 'https'}://${u}`;
  }
  let parsed: URL;
  try { parsed = new URL(u); } catch { throw new Error(`${what} không hợp lệ: "${u}"`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${what} phải là http/https: "${u}"`);
  if (!parsed.hostname) throw new Error(`${what} thiếu host: "${u}"`);
  return u;
}

function urlList(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  return items.map((x) => httpUrl(x, 'metrics URL')).filter((u): u is string => !!u);
}

/**
 * Người dùng hay dán nguyên URL ("https://minio.example.com:9000/") vào ô Host.
 * Bóc scheme/port/đường dẫn ra: scheme https ⇒ tls, "host:port" ⇒ tách port.
 */
function splitEndpoint(raw: string): { host: string; port?: number; tls?: boolean } {
  let s = raw.trim();
  let tls: boolean | undefined;
  const m = /^(https?):\/\//i.exec(s);
  if (m) {
    tls = m[1].toLowerCase() === 'https';
    s = s.slice(m[0].length);
  }
  s = s.replace(/\/.*$/, '');
  let port: number | undefined;
  const pm = /^(.*):(\d+)$/.exec(s);
  if (pm && !pm[1].includes(':')) {
    s = pm[1];
    port = Number(pm[2]);
  }
  return { host: s, port, tls };
}

function validate(body: MinioConnectionInput, existing?: MinioConnection): Omit<MinioConnection, 'id'> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('connection name is required');
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : 'default';
  const ep = splitEndpoint(typeof body.host === 'string' ? body.host : '');
  if (!ep.host) throw new Error('host is required');
  if (/[\s@?]/.test(ep.host)) throw new Error(`invalid host "${ep.host}"`);
  const portRaw = ep.port ?? Number(body.port);
  const port = Number.isFinite(portRaw) && portRaw ? portRaw : 9000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535');
  const tls = ep.tls ?? !!body.tls;
  const accessKey = typeof body.accessKey === 'string' ? body.accessKey.trim() : '';
  if (!accessKey) throw new Error('access key is required');
  const secretKey = typeof body.secretKey === 'string' && body.secretKey.length
    ? body.secretKey
    : existing?.secretKey;
  if (!secretKey) throw new Error('secret key is required');
  const region = typeof body.region === 'string' && body.region.trim() ? body.region.trim() : undefined;
  const readOnly = body.readOnly === undefined
    ? (existing ? existing.readOnly : true)
    : !(body.readOnly === false || body.readOnly === 'false' || body.readOnly === 'off');
  const consoleUrl = httpUrl(body.consoleUrl, 'Console URL');
  const metricsUrl = httpUrl(body.metricsUrl, 'Metrics URL');
  const metricsToken = typeof body.metricsToken === 'string' && body.metricsToken.length
    ? body.metricsToken.trim()
    : existing?.metricsToken;
  const metricsUrls = urlList(body.metricsUrls);
  return { name, project, host: ep.host, port, tls, accessKey, secretKey, region, consoleUrl, metricsUrl, metricsToken, metricsUrls, readOnly };
}

/** Build a NOT-persisted connection straight from form fields (test action). */
export function buildUnsavedConnection(body: MinioConnectionInput, existingId?: string): Promise<MinioConnection> | MinioConnection {
  const make = (existing?: MinioConnection): MinioConnection => ({
    id: '__test__',
    ...validate({ ...body, name: (body.name as string) || 'test' }, existing),
  });
  // Sửa một server đã lưu mà để trống secret → dùng lại secret đã lưu để Test được.
  if (existingId && !(typeof body.secretKey === 'string' && body.secretKey.length)) {
    return getConnection(existingId).then((c) => make(c ?? undefined));
  }
  return make();
}

function makeId(name: string, project: string, existing: Set<string>): string {
  const base = `${project}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'minio';
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function addConnection(body: MinioConnectionInput): Promise<PublicMinioConnection[]> {
  const clean = validate(body);
  const list = await readRaw();
  const id = makeId(clean.name, clean.project, new Set(list.map((c) => c.id)));
  list.push({ id, ...clean });
  await writeRaw(list);
  return list.map(toPublic);
}

export async function updateConnection(id: unknown, body: MinioConnectionInput): Promise<PublicMinioConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('connection not found');
  list[idx] = { id, ...validate(body, list[idx]) };
  await writeRaw(list);
  return list.map(toPublic);
}

export async function removeConnection(id: unknown): Promise<PublicMinioConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const next = list.filter((c) => c.id !== id);
  await writeRaw(next);
  return next.map(toPublic);
}
