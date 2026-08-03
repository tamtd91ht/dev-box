// Server-only persistence + validation for Elasticsearch "connections".
//
// A connection is one ES CLUSTER — a list of coordinator/data node addresses
// (like Kafka's bootstrap brokers):
//   { id, name, project, nodes: ["host:port", ...], tls }
// The server fails over node-to-node on CONNECTION errors (an HTTP response,
// even 5xx, is authoritative and not retried — see lib/esClient.ts).
// Clusters are reached over the office VPN with NO authentication, so unlike
// Redis/Rabbit/Mongo there is no credential to protect — the file is still
// gitignored (host lists are per-machine/per-operator, not repo content).
// Missing file → no connections yet (the UI prompts to add one).
//
// The whole ES tab is READ-ONLY (search/count/mapping/health — never a write),
// so there is no readOnly flag either. Gated by ES_TOOL_ENABLED (off in any
// k8s/prod deploy). Works against ES 6.8 → 8.x (version quirks handled in
// lib/esClient.ts).

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';

export interface EsConnection {
  /** Stable opaque id (used as the list key + api param). */
  id: string;
  /** Human label shown in the list. */
  name: string;
  /** Free-text project/grouping label (e.g. "vn", "th", "core"). */
  project: string;
  /** Cluster node addresses, "host:port" (default port 9200). ≥1 entry. */
  nodes: string[];
  /** https when true (rare on VPN, but some clusters terminate TLS). */
  tls: boolean;
}

/** ES connections carry no secret — the public projection is the record itself. */
export type PublicEsConnection = EsConnection;

/** File holding the connection list. Overridable via ES_CONNECTIONS_PATH. */
const CONNECTIONS_FILE = process.env.ES_CONNECTIONS_PATH
  ? path.resolve(process.cwd(), process.env.ES_CONNECTIONS_PATH)
  : configPath('esconnections.json', ['.esconnections.json']);

/** Read the persisted list. Returns [] on missing/bad file. */
async function readRaw(): Promise<EsConnection[]> {
  try {
    const raw = await fs.readFile(CONNECTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed) ? parsed : [];
    return arr
      .filter((c: unknown): c is EsConnection => {
        const o = c as EsConnection;
        return !!o && typeof o.id === 'string' && typeof o.name === 'string';
      })
      .map((c: EsConnection) => normalize(c));
  } catch {
    return [];
  }
}

async function writeRaw(connections: EsConnection[]): Promise<void> {
  await fs.writeFile(CONNECTIONS_FILE, JSON.stringify({ connections }, null, 2) + '\n', 'utf8');
}

/** Legacy record shape (pre-cluster): single { host, port }. */
interface LegacyFields { host?: unknown; port?: unknown; }

function normalize(c: EsConnection & LegacyFields): EsConnection {
  let nodes = Array.isArray(c.nodes)
    ? c.nodes.map((n) => (typeof n === 'string' ? n.trim() : '')).filter(Boolean)
    : [];
  // Migrate a legacy single-host record into the node list transparently.
  if (nodes.length === 0 && typeof c.host === 'string' && c.host.trim()) {
    const port = Number.isInteger(c.port) ? c.port : 9200;
    nodes = [`${c.host.trim()}:${port}`];
  }
  return {
    id: c.id,
    name: c.name,
    project: typeof c.project === 'string' && c.project.trim() ? c.project.trim() : 'default',
    nodes,
    tls: !!c.tls,
  };
}

export async function listConnections(): Promise<PublicEsConnection[]> {
  return readRaw();
}

export async function getConnection(id: string): Promise<EsConnection | null> {
  const list = await readRaw();
  return list.find((c) => c.id === id) ?? null;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface EsConnectionInput {
  name?: unknown;
  project?: unknown;
  /** string[] or one comma/newline-separated "host:port, host:port" string. */
  nodes?: unknown;
  tls?: unknown;
  /** Legacy single-host fields — still accepted. */
  host?: unknown;
  port?: unknown;
}

/** Parse one "host[:port]" entry (default port 9200). Throws on bad input. */
function parseNode(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error('node must not be empty');
  if (/[\s/@?]/.test(s)) throw new Error(`invalid node "${s}" — enter host:port only`);
  const idx = s.lastIndexOf(':');
  if (idx === -1) return `${s}:9200`;
  const port = Number(s.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in "${s}"`);
  if (!s.slice(0, idx).trim()) throw new Error(`invalid node "${s}" — host part is empty`);
  return s;
}

function validate(body: EsConnectionInput): Omit<EsConnection, 'id'> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('connection name is required');
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : 'default';

  let parts = Array.isArray(body.nodes)
    ? body.nodes.map((n) => String(n ?? ''))
    : String(body.nodes ?? '').split(/[\n,]+/);
  parts = parts.map((p) => p.trim()).filter(Boolean);
  // Legacy single host/port body still works.
  if (parts.length === 0 && typeof body.host === 'string' && body.host.trim()) {
    parts = [`${body.host.trim()}:${Number(body.port) || 9200}`];
  }
  const nodes = parts.map(parseNode);
  if (nodes.length === 0) throw new Error('at least one node (host:port) is required');

  return { name, project, nodes, tls: !!body.tls };
}

/** Build a NOT-persisted connection straight from form fields (test action). */
export function buildUnsavedConnection(body: EsConnectionInput): EsConnection {
  return { id: '__test__', ...validate({ ...body, name: (body.name as string) || 'test' }) };
}

/** id-safe slug from name+project; collisions resolved by suffixing. */
function makeId(name: string, project: string, existing: Set<string>): string {
  const base = `${project}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'es';
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function addConnection(body: EsConnectionInput): Promise<PublicEsConnection[]> {
  const clean = validate(body);
  const list = await readRaw();
  const id = makeId(clean.name, clean.project, new Set(list.map((c) => c.id)));
  list.push({ id, ...clean });
  await writeRaw(list);
  return list;
}

export async function updateConnection(id: unknown, body: EsConnectionInput): Promise<PublicEsConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('connection not found');
  list[idx] = { id, ...validate(body) };
  await writeRaw(list);
  return list;
}

export async function removeConnection(id: unknown): Promise<PublicEsConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const next = list.filter((c) => c.id !== id);
  await writeRaw(next);
  return next;
}
