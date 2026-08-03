// Server-only persistence + validation for RabbitMQ "connections".
//
// A connection is a RabbitMQ broker/cluster an operator wants to inspect via its
// HTTP management API (default port 15672):
//   { id, name, project, nodes: string[], username, password, tls, vhost }
// `nodes` is a list of "host:port" management endpoints — one per cluster node.
// The client tries them in order and fails over to the next if one is unreachable
// (see lib/rabbitClient.ts), so a single-node broker is just a one-element list.
// The list lives in ONE JSON file on the local machine (gitignored) so each
// operator configures their brokers ONCE and it survives restarts.
//
// SECURITY MODEL — this is a LOCAL, single-user ops tool (gated by
// RABBIT_TOOL_ENABLED, off in any k8s/prod deploy). The management password is
// stored in plaintext in the gitignored file (same convention as the Redis
// manager) but is NEVER sent back to the browser: toPublic() strips it and
// exposes only `hasPassword`. Every value is validated/typed before storage;
// nothing from the client is interpolated into a shell — the client issues only
// typed fetch() calls to the management API (see lib/rabbitClient.ts).

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';

const DEFAULT_PORT = 15672;

export interface RabbitConnection {
  /** Stable opaque id (list key + api param). */
  id: string;
  /** Human label shown in the list. */
  name: string;
  /** Free-text project/grouping label (e.g. "vn", "th", "core"). */
  project: string;
  /** Management-API endpoints, each "host:port" — one per cluster node. */
  nodes: string[];
  /** Management-API username. */
  username: string;
  /** Management-API password (plaintext, gitignored, never returned to browser). */
  password: string;
  /** Use https for the management API. */
  tls: boolean;
  /** Optional vhost filter ("" = all vhosts the user can see). */
  vhost: string;
  /**
   * Block every mutating op (create/purge/delete) on this broker. FAIL-SAFE: any
   * record missing the field normalizes to `true`, so brokers saved before this
   * flag existed — including production clusters — are locked until explicitly
   * unlocked. Second, independent layer on top of RABBIT_ALLOW_DESTRUCTIVE.
   */
  readOnly: boolean;
}

/** Client-safe projection — password stripped, replaced by a hasPassword flag. */
export interface PublicRabbitConnection {
  id: string;
  name: string;
  project: string;
  nodes: string[];
  username: string;
  tls: boolean;
  vhost: string;
  hasPassword: boolean;
  readOnly: boolean;
}

/** File holding the connection list. Overridable via RABBIT_CONNECTIONS_PATH. */
const CONNECTIONS_FILE = process.env.RABBIT_CONNECTIONS_PATH
  ? path.resolve(process.cwd(), process.env.RABBIT_CONNECTIONS_PATH)
  : configPath('rabbitconnections.json', ['.rabbitconnections.json']);

export function toPublic(c: RabbitConnection): PublicRabbitConnection {
  return {
    id: c.id,
    name: c.name,
    project: c.project,
    nodes: c.nodes,
    username: c.username,
    tls: c.tls,
    vhost: c.vhost,
    hasPassword: !!c.password,
    readOnly: c.readOnly,
  };
}

/**
 * Parse a node list from either an array or a comma/newline/space-separated
 * string. Each entry is "host" or "host:port"; a missing/invalid port defaults to
 * 15672. Deduplicates while preserving order. Returns [] when nothing valid.
 */
export function parseNodes(input: unknown): string[] {
  let tokens: string[] = [];
  if (Array.isArray(input)) tokens = input.map((x) => String(x));
  else if (typeof input === 'string') tokens = input.split(/[\s,]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const idx = t.lastIndexOf(':');
    let host = t;
    let port = DEFAULT_PORT;
    if (idx > 0) {
      const p = Number(t.slice(idx + 1));
      if (Number.isInteger(p) && p >= 1 && p <= 65535) {
        host = t.slice(0, idx);
        port = p;
      } else {
        host = t.slice(0, idx); // trailing junk after ':' → drop, keep default port
      }
    }
    host = host.trim();
    if (!host) continue;
    const node = `${host}:${port}`;
    if (!seen.has(node)) { seen.add(node); out.push(node); }
  }
  return out;
}

async function readRaw(): Promise<RabbitConnection[]> {
  try {
    const raw = await fs.readFile(CONNECTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed) ? parsed : [];
    return arr
      .filter((c: unknown): c is RabbitConnection => {
        const o = c as RabbitConnection;
        return !!o && typeof o.id === 'string' && typeof o.name === 'string';
      })
      .map((c: Record<string, unknown>) => normalize(c));
  } catch {
    return [];
  }
}

async function writeRaw(connections: RabbitConnection[]): Promise<void> {
  await fs.writeFile(CONNECTIONS_FILE, JSON.stringify({ connections }, null, 2) + '\n', 'utf8');
}

/**
 * Coerce a stored/raw record into a well-typed connection with safe defaults.
 * Backward-compatible: an older single-node record with `host`/`port` (no
 * `nodes`) is migrated into a one-element `nodes` list.
 */
function normalize(c: Record<string, unknown>): RabbitConnection {
  let nodes = parseNodes(c.nodes);
  if (nodes.length === 0 && typeof c.host === 'string' && c.host.trim()) {
    const port = Number.isInteger(c.port) && (c.port as number) > 0 ? (c.port as number) : DEFAULT_PORT;
    nodes = parseNodes(`${(c.host as string).trim()}:${port}`);
  }
  return {
    id: String(c.id),
    name: String(c.name),
    project: typeof c.project === 'string' && c.project.trim() ? c.project.trim() : 'default',
    nodes,
    username: typeof c.username === 'string' ? c.username : '',
    password: typeof c.password === 'string' ? c.password : '',
    tls: !!c.tls,
    vhost: typeof c.vhost === 'string' ? (c.vhost as string).trim() : '',
    // FAIL-SAFE: absent → true. A broker saved before this flag existed (e.g. a
    // production cluster) stays locked until the operator opts out explicitly.
    readOnly: c.readOnly === undefined ? true : !!c.readOnly,
  };
}

export async function listConnections(): Promise<PublicRabbitConnection[]> {
  return (await readRaw()).map(toPublic);
}

/** Resolve ONE connection — server-side only (retains the password). */
export async function getConnection(id: string): Promise<RabbitConnection | null> {
  const list = await readRaw();
  return list.find((c) => c.id === id) ?? null;
}

// ── Validation ──────────────────────────────────────────────────────────────

interface ConnectionInput {
  name?: unknown;
  project?: unknown;
  nodes?: unknown;
  username?: unknown;
  password?: unknown;
  tls?: unknown;
  vhost?: unknown;
  readOnly?: unknown;
  /** On update: keep the existing password when the form left it blank. */
  keepPassword?: unknown;
}

function validate(body: ConnectionInput, existing?: RabbitConnection): Omit<RabbitConnection, 'id'> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('connection name is required');

  const nodes = parseNodes(body.nodes);
  if (nodes.length === 0) throw new Error('at least one node (host:port) is required');

  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : 'default';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const tls = body.tls === true || body.tls === 'true' || body.tls === 'on';
  const vhost = typeof body.vhost === 'string' ? body.vhost.trim() : '';

  // Password: use the supplied one; if blank on update and keepPassword, reuse existing.
  let password = typeof body.password === 'string' ? body.password : '';
  if (!password && body.keepPassword && existing) password = existing.password;

  // Locked unless the caller explicitly sends readOnly=false. An omitted field on
  // create means locked; on update it falls back to the stored value.
  const readOnly = body.readOnly === undefined
    ? (existing ? existing.readOnly : true)
    : !(body.readOnly === false || body.readOnly === 'false' || body.readOnly === 'off');

  return { name, project, nodes, username, password, tls, vhost, readOnly };
}

function makeId(name: string, project: string, existing: Set<string>): string {
  const base = `${project}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'rabbit';
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function addConnection(body: ConnectionInput): Promise<PublicRabbitConnection[]> {
  const clean = validate(body);
  const list = await readRaw();
  const id = makeId(clean.name, clean.project, new Set(list.map((c) => c.id)));
  list.push({ id, ...clean });
  await writeRaw(list);
  return list.map(toPublic);
}

export async function updateConnection(id: unknown, body: ConnectionInput): Promise<PublicRabbitConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('connection not found');
  const clean = validate({ ...body, keepPassword: true }, list[idx]);
  list[idx] = { id, ...clean };
  await writeRaw(list);
  return list.map(toPublic);
}

export async function removeConnection(id: unknown): Promise<PublicRabbitConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const next = list.filter((c) => c.id !== id);
  await writeRaw(next);
  return next.map(toPublic);
}
