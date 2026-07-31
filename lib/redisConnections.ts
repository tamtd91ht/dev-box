// Server-only persistence + validation for Redis "connections".
//
// A connection is a Redis endpoint an operator wants to browse — single-node or cluster:
//   { id, name, project, mode, host, port, nodes?, password? }
//   mode='single' → host/port · mode='cluster' → nodes[] (seed host:port list)
// The list lives in ONE JSON file on the local machine (gitignored) so each
// operator configures their own instances ONCE and it survives restarts.
// Missing file → no connections yet (the UI prompts to add one).
//
// The logical DB index (0–15) is NOT part of a connection — it is chosen at
// browse time in the key browser, so one saved connection can browse any DB.
//
// SECURITY MODEL — this is a LOCAL, single-user ops tool (gated by
// REDIS_TOOL_ENABLED, off in any k8s/prod deploy). The connection file holds
// Redis passwords in PLAINTEXT — this mirrors the existing `.apitester-config.json`
// convention (anyone who can reach this tool already has the operator's own
// machine + filesystem). The file is gitignored so a secret never reaches a
// commit. Every value is validated/typed before storage; nothing from the client
// is ever concatenated into a Redis command (see lib/redisClient.ts — SCAN /
// EXPIRE / DEL only, args passed as distinct argv, never a raw command string).

import { promises as fs } from 'fs';
import path from 'path';

/** A single Redis Cluster seed node. */
export interface RedisNode {
  host: string;
  port: number;
}

export type RedisMode = 'single' | 'cluster';

export interface RedisConnection {
  /** Stable opaque id (used as the list key + api param). */
  id: string;
  /** Human label shown in the list. */
  name: string;
  /** Free-text project/grouping label (e.g. "vn", "th", "core"). */
  project: string;
  /** 'single' = one node (host/port). 'cluster' = ioredis Cluster over `nodes`. */
  mode: RedisMode;
  /** Single-node address. Used only when mode === 'single'. */
  host: string;
  port: number;
  /** Cluster seed nodes. Used only when mode === 'cluster' (≥1 entry). */
  nodes?: RedisNode[];
  /** Optional AUTH password — plaintext on local disk (see security model above). */
  password?: string;
}

/** The client-safe projection of a connection — password stripped, presence flagged. */
export type PublicRedisConnection = Omit<RedisConnection, 'password'> & { hasPassword: boolean };

/** File holding the connection list. Overridable via REDIS_CONNECTIONS_PATH. */
const CONNECTIONS_FILE = process.env.REDIS_CONNECTIONS_PATH
  ? path.resolve(process.cwd(), process.env.REDIS_CONNECTIONS_PATH)
  : path.join(process.cwd(), '.redisconnections.json');

/** Strip the password before a connection is sent to the browser. */
export function toPublic(c: RedisConnection): PublicRedisConnection {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: !!(password && password.length) };
}

/** Read the persisted list (raw, WITH passwords). Returns [] on missing/bad file. */
async function readRaw(): Promise<RedisConnection[]> {
  try {
    const raw = await fs.readFile(CONNECTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed) ? parsed : [];
    return arr
      .filter((c: unknown): c is RedisConnection => {
        const o = c as RedisConnection;
        return !!o && typeof o.id === 'string' && typeof o.name === 'string';
      })
      .map((c: RedisConnection) => normalize(c));
  } catch {
    return [];
  }
}

async function writeRaw(connections: RedisConnection[]): Promise<void> {
  await fs.writeFile(CONNECTIONS_FILE, JSON.stringify({ connections }, null, 2) + '\n', 'utf8');
}

/** Coerce a raw node record into a valid {host, port}, or null if unusable. */
function normalizeNode(n: unknown): RedisNode | null {
  const o = n as RedisNode;
  const host = typeof o?.host === 'string' ? o.host.trim() : '';
  if (!host) return null;
  const port = Number.isInteger(o?.port) ? o.port : 6379;
  return { host, port };
}

/** Coerce a stored/raw record into a well-typed connection with safe defaults. */
function normalize(c: RedisConnection): RedisConnection {
  const mode: RedisMode = c.mode === 'cluster' ? 'cluster' : 'single';
  const nodes = Array.isArray(c.nodes)
    ? c.nodes.map(normalizeNode).filter((n): n is RedisNode => n !== null)
    : [];
  return {
    id: c.id,
    name: c.name,
    project: typeof c.project === 'string' && c.project.trim() ? c.project.trim() : 'default',
    mode,
    // Keep a single-node address even for cluster (falls back to the first seed) so
    // list badges / signatures always have something to show.
    host: typeof c.host === 'string' && c.host.trim() ? c.host.trim() : nodes[0]?.host ?? '',
    port: Number.isInteger(c.port) ? c.port : nodes[0]?.port ?? 6379,
    nodes: mode === 'cluster' ? nodes : undefined,
    password: typeof c.password === 'string' && c.password.length ? c.password : undefined,
  };
}

/** Full list (client-safe — passwords stripped). */
export async function listConnections(): Promise<PublicRedisConnection[]> {
  return (await readRaw()).map(toPublic);
}

/** Resolve ONE connection WITH its password — server-side use only (never returned to the browser). */
export async function getConnection(id: string): Promise<RedisConnection | null> {
  const list = await readRaw();
  return list.find((c) => c.id === id) ?? null;
}

// ── Validation ──────────────────────────────────────────────────────────────

interface ConnectionInput {
  name?: unknown;
  project?: unknown;
  mode?: unknown;
  host?: unknown;
  port?: unknown;
  /** Cluster seeds: either [{host,port}] or "host:port" strings. */
  nodes?: unknown;
  password?: unknown;
}

/** Parse one seed entry — accepts {host,port} or a "host:port" string. Throws on bad input. */
function parseNode(raw: unknown): RedisNode {
  if (typeof raw === 'string') {
    const s = raw.trim();
    const idx = s.lastIndexOf(':');
    const host = (idx === -1 ? s : s.slice(0, idx)).trim();
    const port = idx === -1 ? 6379 : Number(s.slice(idx + 1));
    if (!host) throw new Error(`invalid node "${raw}" — host is empty`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in node "${raw}"`);
    return { host, port };
  }
  const o = raw as RedisNode;
  const host = typeof o?.host === 'string' ? o.host.trim() : '';
  if (!host) throw new Error('cluster node host is required');
  const port = Number(o?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('cluster node port must be 1–65535');
  return { host, port };
}

/** Validate a client-supplied connection body → a clean partial (no id). Throws on bad input. */
function validate(body: ConnectionInput): Omit<RedisConnection, 'id'> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('connection name is required');

  const mode: RedisMode = body.mode === 'cluster' ? 'cluster' : 'single';
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : 'default';
  const password = typeof body.password === 'string' && body.password.length ? body.password : undefined;

  if (mode === 'cluster') {
    const rawNodes = Array.isArray(body.nodes) ? body.nodes : [];
    const nodes = rawNodes.map(parseNode);
    if (nodes.length === 0) throw new Error('cluster mode requires at least one seed node (host:port)');
    // Mirror the first seed into host/port so badges/signatures have an address.
    return { name, project, mode, host: nodes[0].host, port: nodes[0].port, nodes, password };
  }

  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (!host) throw new Error('host is required');
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535');

  return { name, project, mode, host, port, nodes: undefined, password };
}

/** id-safe slug from name+project; collisions resolved by suffixing. */
function makeId(name: string, project: string, existing: Set<string>): string {
  const base = `${project}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'redis';
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function addConnection(body: ConnectionInput): Promise<PublicRedisConnection[]> {
  const clean = validate(body);
  const list = await readRaw();
  const id = makeId(clean.name, clean.project, new Set(list.map((c) => c.id)));
  list.push({ id, ...clean });
  await writeRaw(list);
  return list.map(toPublic);
}

export async function updateConnection(id: unknown, body: ConnectionInput): Promise<PublicRedisConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('connection not found');
  const clean = validate(body);
  // Keep the existing password when the client omits it (edit without re-entering the secret).
  const password = clean.password ?? list[idx].password;
  list[idx] = { id, ...clean, password };
  await writeRaw(list);
  return list.map(toPublic);
}

export async function removeConnection(id: unknown): Promise<PublicRedisConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const next = list.filter((c) => c.id !== id);
  await writeRaw(next);
  return next.map(toPublic);
}
