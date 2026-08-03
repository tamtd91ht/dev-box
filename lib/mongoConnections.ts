// Server-only persistence + validation for MongoDB "connections".
//
// A connection is a MongoDB deployment an operator wants to browse — standalone,
// replica set, or a mongodb+srv cluster:
//   { id, name, project, scheme, hosts[], replicaSet?, authSource?, username?,
//     password?, tls, directConnection, readOnly }
// The list lives in ONE JSON file on the local machine (gitignored) so each
// operator configures their own clusters ONCE and it survives restarts.
// Missing file → no connections yet (the UI prompts to add one).
//
// WRITE SAFETY — `readOnly` (default TRUE, including for records saved before the
// flag existed) is the per-connection write gate: while set, the update action is
// refused server-side regardless of the MONGO_ALLOW_WRITE env flag. Mirrors the
// RabbitMQ tab's dual-gate model (lib/rabbitConnections.ts).
//
// SECURITY MODEL — this is a LOCAL, single-user ops tool (gated by
// MONGO_TOOL_ENABLED, off in any k8s/prod deploy). The connection file holds
// MongoDB passwords in PLAINTEXT — same convention as `.redisconnections.json` /
// `.rabbitconnections.json` (anyone who can reach this tool already has the
// operator's own machine + filesystem). The file is gitignored so a secret never
// reaches a commit. Passwords are NEVER returned to the browser — only
// `hasPassword: boolean` (see toPublic).

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';

export type MongoScheme = 'mongodb' | 'mongodb+srv';

export interface MongoConnection {
  /** Stable opaque id (used as the list key + api param). */
  id: string;
  /** Human label shown in the list. */
  name: string;
  /** Free-text project/grouping label (e.g. "vn", "th", "core"). */
  project: string;
  /** 'mongodb' = explicit host:port list · 'mongodb+srv' = one SRV domain. */
  scheme: MongoScheme;
  /** "host:port" entries ('mongodb') or ONE domain without port ('mongodb+srv'). */
  hosts: string[];
  /** Replica set name (optional — SRV discovers it via DNS). */
  replicaSet?: string;
  /** Auth database (default "admin" when a username is set). */
  authSource?: string;
  username?: string;
  /** Plaintext on local disk (see security model above). */
  password?: string;
  tls: boolean;
  /** Connect straight to the named host even if it reports a replica set. */
  directConnection: boolean;
  /**
   * Per-connection write gate. TRUE (default) blocks the update action even when
   * the MONGO_ALLOW_WRITE env flag is on — pointing this tool at a production
   * cluster never silently arms writes.
   */
  readOnly: boolean;
}

/** The client-safe projection — password stripped, presence flagged. */
export type PublicMongoConnection = Omit<MongoConnection, 'password'> & { hasPassword: boolean };

/** File holding the connection list. Overridable via MONGO_CONNECTIONS_PATH. */
const CONNECTIONS_FILE = process.env.MONGO_CONNECTIONS_PATH
  ? path.resolve(process.cwd(), process.env.MONGO_CONNECTIONS_PATH)
  : configPath('mongoconnections.json', ['.mongoconnections.json']);

/** Strip the password before a connection is sent to the browser. */
export function toPublic(c: MongoConnection): PublicMongoConnection {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: !!(password && password.length) };
}

/** Read the persisted list (raw, WITH passwords). Returns [] on missing/bad file. */
async function readRaw(): Promise<MongoConnection[]> {
  try {
    const raw = await fs.readFile(CONNECTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed) ? parsed : [];
    return arr
      .filter((c: unknown): c is MongoConnection => {
        const o = c as MongoConnection;
        return !!o && typeof o.id === 'string' && typeof o.name === 'string';
      })
      .map((c: MongoConnection) => normalize(c));
  } catch {
    return [];
  }
}

async function writeRaw(connections: MongoConnection[]): Promise<void> {
  await fs.writeFile(CONNECTIONS_FILE, JSON.stringify({ connections }, null, 2) + '\n', 'utf8');
}

/** Coerce a stored/raw record into a well-typed connection with safe defaults. */
function normalize(c: MongoConnection): MongoConnection {
  const scheme: MongoScheme = c.scheme === 'mongodb+srv' ? 'mongodb+srv' : 'mongodb';
  const hosts = Array.isArray(c.hosts)
    ? c.hosts.map((h) => (typeof h === 'string' ? h.trim() : '')).filter(Boolean)
    : [];
  return {
    id: c.id,
    name: c.name,
    project: typeof c.project === 'string' && c.project.trim() ? c.project.trim() : 'default',
    scheme,
    hosts,
    replicaSet: typeof c.replicaSet === 'string' && c.replicaSet.trim() ? c.replicaSet.trim() : undefined,
    authSource: typeof c.authSource === 'string' && c.authSource.trim() ? c.authSource.trim() : undefined,
    username: typeof c.username === 'string' && c.username.trim() ? c.username.trim() : undefined,
    password: typeof c.password === 'string' && c.password.length ? c.password : undefined,
    tls: !!c.tls,
    directConnection: !!c.directConnection,
    // Locked unless the stored record explicitly says false (pre-flag records → locked).
    readOnly: c.readOnly === undefined ? true : c.readOnly !== false,
  };
}

/** Full list (client-safe — passwords stripped). */
export async function listConnections(): Promise<PublicMongoConnection[]> {
  return (await readRaw()).map(toPublic);
}

/** Resolve ONE connection WITH its password — server-side use only (never returned to the browser). */
export async function getConnection(id: string): Promise<MongoConnection | null> {
  const list = await readRaw();
  return list.find((c) => c.id === id) ?? null;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface MongoConnectionInput {
  name?: unknown;
  project?: unknown;
  scheme?: unknown;
  /** string[] or one comma/newline-separated "host:port, host:port" string. */
  hosts?: unknown;
  replicaSet?: unknown;
  authSource?: unknown;
  username?: unknown;
  password?: unknown;
  tls?: unknown;
  directConnection?: unknown;
  readOnly?: unknown;
}

/** Parse one "host[:port]" entry. Throws on bad input. */
function parseHost(raw: string, scheme: MongoScheme): string {
  const s = raw.trim();
  if (!s) throw new Error('host must not be empty');
  if (/\s/.test(s)) throw new Error(`invalid host "${s}" — contains whitespace`);
  if (s.includes('/') || s.includes('?') || s.includes('@')) {
    throw new Error(`invalid host "${s}" — enter host:port only, not a URI`);
  }
  const idx = s.lastIndexOf(':');
  if (idx === -1) {
    // No port: SRV domains have none; plain hosts get the default 27017.
    return scheme === 'mongodb+srv' ? s : `${s}:27017`;
  }
  if (scheme === 'mongodb+srv') throw new Error(`SRV domain "${s}" must not include a port`);
  const port = Number(s.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in "${s}"`);
  if (!s.slice(0, idx).trim()) throw new Error(`invalid host "${s}" — host part is empty`);
  return s;
}

/** Normalize the hosts field: accepts string[] or a comma/newline-separated string. */
function parseHosts(raw: unknown, scheme: MongoScheme): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((h) => String(h ?? ''))
    : String(raw ?? '').split(/[\n,]+/);
  const hosts = parts.map((h) => h.trim()).filter(Boolean).map((h) => parseHost(h, scheme));
  if (hosts.length === 0) throw new Error('at least one host is required');
  if (scheme === 'mongodb+srv' && hosts.length > 1) {
    throw new Error('mongodb+srv takes exactly ONE SRV domain');
  }
  return hosts;
}

/**
 * Validate a client-supplied connection body → a clean partial (no id). Throws on
 * bad input. `existing` supplies the stored record on edit so an omitted password
 * keeps the saved secret and an omitted readOnly keeps the saved lock state.
 */
function validate(body: MongoConnectionInput, existing?: MongoConnection): Omit<MongoConnection, 'id'> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('connection name is required');

  const scheme: MongoScheme = body.scheme === 'mongodb+srv' ? 'mongodb+srv' : 'mongodb';
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : 'default';
  const hosts = parseHosts(body.hosts, scheme);

  const replicaSet = typeof body.replicaSet === 'string' && body.replicaSet.trim() ? body.replicaSet.trim() : undefined;
  const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim() : undefined;
  const password = typeof body.password === 'string' && body.password.length
    ? body.password
    : existing?.password;
  const authSource = typeof body.authSource === 'string' && body.authSource.trim()
    ? body.authSource.trim()
    : username ? 'admin' : undefined;

  // Locked unless the caller explicitly sends readOnly=false. An omitted field on
  // edit keeps the stored state; on create it locks.
  const readOnly = body.readOnly === undefined
    ? (existing ? existing.readOnly : true)
    : !(body.readOnly === false || body.readOnly === 'false' || body.readOnly === 'off');

  return {
    name,
    project,
    scheme,
    hosts,
    replicaSet,
    authSource,
    username,
    password,
    tls: !!body.tls,
    directConnection: scheme === 'mongodb' ? !!body.directConnection : false,
    readOnly,
  };
}

/** id-safe slug from name+project; collisions resolved by suffixing. */
function makeId(name: string, project: string, existing: Set<string>): string {
  const base = `${project}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mongo';
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Build a NOT-persisted connection straight from form fields — used by the
 * "test" action to probe before saving. Same validation as add/update.
 */
export function buildUnsavedConnection(body: MongoConnectionInput): MongoConnection {
  return { id: '__test__', ...validate(body) };
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function addConnection(body: MongoConnectionInput): Promise<PublicMongoConnection[]> {
  const clean = validate(body);
  const list = await readRaw();
  const id = makeId(clean.name, clean.project, new Set(list.map((c) => c.id)));
  list.push({ id, ...clean });
  await writeRaw(list);
  return list.map(toPublic);
}

export async function updateConnection(id: unknown, body: MongoConnectionInput): Promise<PublicMongoConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('connection not found');
  const clean = validate(body, list[idx]);
  list[idx] = { id, ...clean };
  await writeRaw(list);
  return list.map(toPublic);
}

export async function removeConnection(id: unknown): Promise<PublicMongoConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const next = list.filter((c) => c.id !== id);
  await writeRaw(next);
  return next.map(toPublic);
}
