// Server-only persistence + validation for Kafka "connections".
//
// A connection is a Kafka cluster an operator wants to inspect:
//   { id, name, project, brokers }
//   brokers = list of bootstrap addresses ("host:port"), ≥1 entry.
// The list lives in ONE JSON file on the local machine (gitignored) so each
// operator configures their own clusters ONCE and it survives restarts.
// Missing file → no connections yet (the UI prompts to add one).
//
// SECURITY MODEL — this is a LOCAL, single-user ops tool (gated by
// KAFKA_TOOL_ENABLED, off in any k8s/prod deploy). Only PLAINTEXT brokers are
// supported for now (no SASL/SSL creds stored), mirroring the Redis-manager
// convention. The file is gitignored. Every value is validated/typed before
// storage; nothing from the client is ever interpolated into a shell/command —
// kafkajs receives typed args only (see lib/kafkaClient.ts).

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';

export interface KafkaConnection {
  /** Stable opaque id (used as the list key + api param). */
  id: string;
  /** Human label shown in the list. */
  name: string;
  /** Free-text project/grouping label (e.g. "vn", "th", "core"). */
  project: string;
  /** Bootstrap broker addresses ("host:port"), ≥1 entry. */
  brokers: string[];
  /**
   * OPTIONAL Prometheus metrics endpoints (node_exporter / jmx_exporter), one
   * per broker host — e.g. "http://192.168.2.70:9100/metrics". The Kafka wire
   * protocol exposes no host metrics, so RAM/disk/CPU/load in the cluster
   * monitor come from these when configured (VPN, no auth).
   */
  metricsUrls: string[];
}

/**
 * The client-safe projection. No secret is stored today (PLAINTEXT only), so this
 * is effectively identity — kept for symmetry with the Redis registry and so a
 * future SASL password field can be stripped here without touching call sites.
 */
export type PublicKafkaConnection = KafkaConnection;

/** File holding the connection list. Overridable via KAFKA_CONNECTIONS_PATH. */
const CONNECTIONS_FILE = process.env.KAFKA_CONNECTIONS_PATH
  ? path.resolve(process.cwd(), process.env.KAFKA_CONNECTIONS_PATH)
  : configPath('kafkaconnections.json', ['.kafkaconnections.json']);

/** Projection sent to the browser (identity today — see PublicKafkaConnection). */
export function toPublic(c: KafkaConnection): PublicKafkaConnection {
  return { id: c.id, name: c.name, project: c.project, brokers: [...c.brokers], metricsUrls: [...c.metricsUrls] };
}

/** Read the persisted list. Returns [] on missing/bad file. */
async function readRaw(): Promise<KafkaConnection[]> {
  try {
    const raw = await fs.readFile(CONNECTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed) ? parsed : [];
    return arr
      .filter((c: unknown): c is KafkaConnection => {
        const o = c as KafkaConnection;
        return !!o && typeof o.id === 'string' && typeof o.name === 'string';
      })
      .map((c: KafkaConnection) => normalize(c));
  } catch {
    return [];
  }
}

async function writeRaw(connections: KafkaConnection[]): Promise<void> {
  await fs.writeFile(CONNECTIONS_FILE, JSON.stringify({ connections }, null, 2) + '\n', 'utf8');
}

/** Coerce one broker entry ("host:port" string or {host,port}) into "host:port". Null if unusable. */
function normalizeBroker(b: unknown): string | null {
  if (typeof b === 'string') {
    const s = b.trim();
    return s ? s : null;
  }
  const o = b as { host?: unknown; port?: unknown };
  const host = typeof o?.host === 'string' ? o.host.trim() : '';
  if (!host) return null;
  const port = Number.isInteger(o?.port) ? (o.port as number) : 9092;
  return `${host}:${port}`;
}

/** Coerce a stored/raw record into a well-typed connection with safe defaults. */
function normalize(c: KafkaConnection): KafkaConnection {
  const brokers = Array.isArray(c.brokers)
    ? c.brokers.map(normalizeBroker).filter((b): b is string => b !== null)
    : [];
  return {
    id: c.id,
    name: c.name,
    project: typeof c.project === 'string' && c.project.trim() ? c.project.trim() : 'default',
    brokers,
    metricsUrls: Array.isArray(c.metricsUrls)
      ? c.metricsUrls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean)
      : [],
  };
}

/** Full list (client-safe). */
export async function listConnections(): Promise<PublicKafkaConnection[]> {
  return (await readRaw()).map(toPublic);
}

/** Resolve ONE connection — server-side use only. */
export async function getConnection(id: string): Promise<KafkaConnection | null> {
  const list = await readRaw();
  return list.find((c) => c.id === id) ?? null;
}

// ── Validation ──────────────────────────────────────────────────────────────

interface ConnectionInput {
  name?: unknown;
  project?: unknown;
  /** Brokers: comma/newline-separated string, or an array of "host:port" strings. */
  brokers?: unknown;
  /** Optional metrics endpoints: comma/newline-separated string or string[]. */
  metricsUrls?: unknown;
}

/** Parse + validate the optional metrics URL list (http/https only). */
function parseMetricsUrls(raw: unknown): string[] {
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/)
      : [];
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

/** Validate one "host:port" broker. Throws on bad input. Returns the trimmed value. */
function parseBroker(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw new Error('broker address is empty');
  const idx = s.lastIndexOf(':');
  const host = (idx === -1 ? s : s.slice(0, idx)).trim();
  const port = idx === -1 ? 9092 : Number(s.slice(idx + 1));
  if (!host) throw new Error(`invalid broker "${raw}" — host is empty`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in broker "${raw}"`);
  return `${host}:${port}`;
}

/** Accept brokers as an array or a comma/newline/space-separated string. */
function parseBrokers(raw: unknown): string[] {
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/)
      : [];
  const brokers = items
    .map((x) => (typeof x === 'string' ? x.trim() : x))
    .filter((x) => x !== '' && x != null)
    .map(parseBroker);
  if (brokers.length === 0) throw new Error('at least one broker (host:port) is required');
  return brokers;
}

/** Validate a client-supplied connection body → a clean partial (no id). Throws on bad input. */
function validate(body: ConnectionInput): Omit<KafkaConnection, 'id'> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('connection name is required');
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : 'default';
  const brokers = parseBrokers(body.brokers);
  const metricsUrls = parseMetricsUrls(body.metricsUrls);
  return { name, project, brokers, metricsUrls };
}

/** id-safe slug from project+name; collisions resolved by suffixing. */
function makeId(name: string, project: string, existing: Set<string>): string {
  const base = `${project}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'kafka';
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function addConnection(body: ConnectionInput): Promise<PublicKafkaConnection[]> {
  const clean = validate(body);
  const list = await readRaw();
  const id = makeId(clean.name, clean.project, new Set(list.map((c) => c.id)));
  list.push({ id, ...clean });
  await writeRaw(list);
  return list.map(toPublic);
}

export async function updateConnection(id: unknown, body: ConnectionInput): Promise<PublicKafkaConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error('connection not found');
  const clean = validate(body);
  list[idx] = { id, ...clean };
  await writeRaw(list);
  return list.map(toPublic);
}

export async function removeConnection(id: unknown): Promise<PublicKafkaConnection[]> {
  if (typeof id !== 'string' || !id) throw new Error('connection id is required');
  const list = await readRaw();
  const next = list.filter((c) => c.id !== id);
  await writeRaw(next);
  return next.map(toPublic);
}
