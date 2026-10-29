// Server-only persistence + validation for PostgreSQL "connections".
//
// A connection is one PG endpoint an operator wants to browse:
//   { id, name, project, host, database, username, password?, tls, readOnly }
// `host` là "host:port" phân cách dấu phẩy (một địa chỉ = máy đơn / HA, nhiều = cluster — lib/pgHosts).
// `database` is the DEFAULT database to connect to (PG sessions are bound to a
// database) — the browser tree can still open sibling databases; the server
// keys its pools per (connection, database).
//
// WRITE SAFETY — `readOnly` (default TRUE, including for records saved before
// the flag existed) is the per-connection write gate: while set, the update
// action is refused server-side regardless of the PG_ALLOW_WRITE env flag.
// Same dual-gate model as the Mongo/Rabbit tabs.
//
// SECURITY MODEL — LOCAL, single-user ops tool (gated by PG_TOOL_ENABLED, off
// in any k8s/prod deploy). Passwords sit in PLAINTEXT in the gitignored file
// (same convention as .mongoconnections.json) and are NEVER returned to the
// browser — only `hasPassword: boolean`.

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';
import { DEFAULT_PG_PORT, canonicalHostList, normalizeHostList } from './pgHosts';

export interface PgConnection {
  /** Stable opaque id (used as the list key + api param). */
  id: string;
  /** Human label shown in the list. */
  name: string;
  /** Free-text project/grouping label (e.g. "vn", "th", "core"). */
  project: string;
  /** "host:port" phân cách dấu phẩy, node nào cũng có cổng. */
  host: string;
  /** Cũ: cổng chung trước khi gộp vào `host`. Bản ghi đọc lên đã được gộp, không còn field này. */
  port?: number;
  /** Default database of the session (PG requires one; usually "postgres"). */
  database: string;
  username: string;
  /** Plaintext on local disk (see security model above). */
  password?: string;
  tls: boolean;
  /**
   * OPTIONAL node_exporter endpoints của máy chạy Postgres. SQL không nói được gì
   * về đĩa/RAM/CPU của máy, mà đĩa đầy mới là cách Postgres chết hay gặp nhất —
   * khai URL ở đây (vd http://10.0.0.5:9100/metrics) thì Monitor đo thêm các chỉ số host.
   */
  metricsUrls: string[];
  /** Per-connection write gate — TRUE (default) blocks the update action. */
  readOnly: boolean;
}

/** The client-safe projection — password stripped, presence flagged. */
export type PublicPgConnection = Omit<PgConnection, 'password'> & { hasPassword: boolean };

/** File holding the connection list. Overridable via PG_CONNECTIONS_PATH. */
const CONNECTIONS_FILE = process.env.PG_CONNECTIONS_PATH
  ? path.resolve(process.cwd(), process.env.PG_CONNECTIONS_PATH)
  : configPath('pgconnections.json', ['.pgconnections.json']);

export function toPublic(c: PgConnection): PublicPgConnection {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: !!(password && password.length) };
}

async function readRaw(): Promise<PgConnection[]> {
  try {
    const raw = await fs.readFile(CONNECTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed) ? parsed : [];
    return arr
      .filter((c: unknown): c is PgConnection => {
        const o = c as PgConnection;
        return !!o && typeof o.id === 'string' && typeof o.name === 'string';
      })
      .map((c: PgConnection) => normalize(c));
  } catch {
    return [];
  }
}

async function writeRaw(connections: PgConnection[]): Promise<void> {
  await fs.writeFile(CONNECTIONS_FILE, JSON.stringify({ connections }, null, 2) + '\n', 'utf8');
}

/** Gộp cổng cũ vào từng node; host hỏng cú pháp thì giữ nguyên để người dùng thấy và sửa. */
function canonicalOrRaw(host: string, port: number | undefined): string {
  try {
    return canonicalHostList(host, port);
  } catch {
    return normalizeHostList(host);
  }
}

function normalize(c: PgConnection): PgConnection {
  return {
    id: c.id,
    name: c.name,
    project: typeof c.project === 'string' && c.project.trim() ? c.project.trim() : 'default',
    host: typeof c.host === 'string' ? canonicalOrRaw(c.host, Number.isInteger(c.port) ? c.port : DEFAULT_PG_PORT) : '',
    database: typeof c.database === 'string' && c.database.trim() ? c.database.trim() : 'postgres',
    username: typeof c.username === 'string' ? c.username.trim() : '',
    password: typeof c.password === 'string' && c.password.length ? c.password : undefined,
    tls: !!c.tls,
    metricsUrls: Array.isArray(c.metricsUrls)
      ? c.metricsUrls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean)
      : [],
    // Locked unless the stored record explicitly says false (pre-flag records → locked).
    readOnly: c.readOnly === undefined ? true : c.readOnly !== false,
  };
}

export async function listConnections(): Promise<PublicPgConnection[]> {
  return (await readRaw()).map(toPublic);
}

/** Resolve ONE connection WITH its password — server-side use only. */
export async function getConnection(id: string): Promise<PgConnection | null> {
  const list = await readRaw();
  return list.find((c) => c.id === id) ?? null;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface PgConnectionInput {
  name?: unknown;
  project?: unknown;
  host?: unknown;
  port?: unknown;
  database?: unknown;
  username?: unknown;
  password?: unknown;
  tls?: unknown;
  metricsUrls?: unknown;
  readOnly?: unknown;
}

function parseMetricsUrls(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  return items
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .map((u) => {
      let parsed: URL;
      try { parsed = new URL(u); } catch { throw new Error(`metrics URL không hợp lệ: "${u}"`); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`metrics URL phải là http/https: "${u}"`);
      }
      return u;
    });
}

function validate(body: PgConnectionInput, existing?: PgConnection): Omit<PgConnection, 'id'> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('connection name is required');
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : 'default';
  // "host:port" phân cách dấu phẩy, có thể là cả cluster (xem lib/pgHosts). Node không ghi cổng =
  // `port` nếu client cũ còn gửi, không thì 5432. Ném lỗi nếu có node sai cú pháp / cổng.
  const raw = typeof body.host === 'string' ? normalizeHostList(body.host) : '';
  if (!raw) throw new Error('host is required');
  const port = body.port === undefined || body.port === '' ? DEFAULT_PG_PORT : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535');
  const host = canonicalHostList(raw, port);
  const database = typeof body.database === 'string' && body.database.trim() ? body.database.trim() : 'postgres';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!username) throw new Error('username is required');
  const password = typeof body.password === 'string' && body.password.length
    ? body.password
    : existing?.password;
  const readOnly = body.readOnly === undefined
    ? (existing ? existing.readOnly : true)
    : !(body.readOnly === false || body.readOnly === 'false' || body.readOnly === 'off');
  const metricsUrls = parseMetricsUrls(body.metricsUrls);
  return { name, project, host, database, username, password, tls: !!body.tls, metricsUrls, readOnly };
}

/** Build a NOT-persisted connection straight from form fields (test action). */
export function buildUnsavedConnection(body: PgConnectionInput): PgConnection {
  return { id: '__test__', ...validate({ ...body, name: (body.name as string) || 'test' }) };
}

function makeId(name: string, project: string, existing: Set<string>): string {
  const base = `${project}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pg';
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function addConnection(body: PgConnectionInput): Promise<PublicPgConnection[]> {
  const clean = validate(body);
  const list = await readRaw();
  const id = makeId(clean.name, clean.project, new Set(list.map((c) => c.id)));
  list.push({ id, ...clean });
  await writeRaw(list);
  return list.map(toPublic);
}

export async function updateConnection(id: unknown, body: PgConnectionInput): Promise<PublicPgConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('connection not found');
  list[idx] = { id, ...validate(body, list[idx]) };
  await writeRaw(list);
  return list.map(toPublic);
}

export async function removeConnection(id: unknown): Promise<PublicPgConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const next = list.filter((c) => c.id !== id);
  await writeRaw(next);
  return next.map(toPublic);
}
