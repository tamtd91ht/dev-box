// Server-only persistence + validation for PostgreSQL "connections".
//
// A connection is one PG endpoint an operator wants to browse:
//   { id, name, project, host, port, database, username, password?, tls, readOnly }
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

export interface PgConnection {
  /** Stable opaque id (used as the list key + api param). */
  id: string;
  /** Human label shown in the list. */
  name: string;
  /** Free-text project/grouping label (e.g. "vn", "th", "core"). */
  project: string;
  host: string;
  port: number;
  /** Default database of the session (PG requires one; usually "postgres"). */
  database: string;
  username: string;
  /** Plaintext on local disk (see security model above). */
  password?: string;
  tls: boolean;
  /** Per-connection write gate — TRUE (default) blocks the update action. */
  readOnly: boolean;
}

/** The client-safe projection — password stripped, presence flagged. */
export type PublicPgConnection = Omit<PgConnection, 'password'> & { hasPassword: boolean };

/** File holding the connection list. Overridable via PG_CONNECTIONS_PATH. */
const CONNECTIONS_FILE = process.env.PG_CONNECTIONS_PATH
  ? path.resolve(process.cwd(), process.env.PG_CONNECTIONS_PATH)
  : path.join(process.cwd(), '.pgconnections.json');

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

function normalize(c: PgConnection): PgConnection {
  return {
    id: c.id,
    name: c.name,
    project: typeof c.project === 'string' && c.project.trim() ? c.project.trim() : 'default',
    host: typeof c.host === 'string' ? c.host.trim() : '',
    port: Number.isInteger(c.port) ? c.port : 5432,
    database: typeof c.database === 'string' && c.database.trim() ? c.database.trim() : 'postgres',
    username: typeof c.username === 'string' ? c.username.trim() : '',
    password: typeof c.password === 'string' && c.password.length ? c.password : undefined,
    tls: !!c.tls,
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
  readOnly?: unknown;
}

function validate(body: PgConnectionInput, existing?: PgConnection): Omit<PgConnection, 'id'> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('connection name is required');
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : 'default';
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (!host) throw new Error('host is required');
  if (/[\s/@?]/.test(host)) throw new Error(`invalid host "${host}"`);
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535');
  const database = typeof body.database === 'string' && body.database.trim() ? body.database.trim() : 'postgres';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!username) throw new Error('username is required');
  const password = typeof body.password === 'string' && body.password.length
    ? body.password
    : existing?.password;
  const readOnly = body.readOnly === undefined
    ? (existing ? existing.readOnly : true)
    : !(body.readOnly === false || body.readOnly === 'false' || body.readOnly === 'off');
  return { name, project, host, port, database, username, password, tls: !!body.tls, readOnly };
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
