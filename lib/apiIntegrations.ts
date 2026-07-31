// Server-only registry + manifest loader for API INTEGRATION PACKS.
//
// The API Explorer engine in this toolbox is project-neutral. A project plugs
// itself in by shipping a `devbox.api.json` MANIFEST in its own repo:
//
//   {
//     "name": "OMICX",
//     "services": [
//       { "id": "public-service", "label": "Public", "blurb": "...",
//         "authMode": "apikey", "spec": "openapi/public-service.yaml",
//         "defaultBaseUrl": "http://localhost:8090", "apiPrefix": "" }
//     ],
//     "flows": [ ...Flow objects (see lib/types.ts)... ]
//   }
//
// The operator registers packs per machine in `.apiintegrations.json`
// (gitignored — same convention as the connection registries):
//   { "integrations": [{ "id": "omicx", "name": "OMICX", "root": "D:/.../omicx-local-all-in-one" }] }
//
// Spec paths in the manifest are RELATIVE to the pack root and are resolved
// with a containment check — a manifest cannot read files outside its root.

import { promises as fs } from 'fs';
import path from 'path';
import type { Flow } from './types';
import type { AuthMode } from './request';

export interface ApiIntegration {
  /** Stable opaque id (used as the registry key + api param). */
  id: string;
  /** Display name, e.g. "OMICX". */
  name: string;
  /** Absolute folder containing devbox.api.json. */
  root: string;
}

export interface ManifestService {
  id: string;
  label: string;
  blurb?: string;
  authMode: AuthMode;
  /** Spec path relative to the pack root. */
  spec: string;
  defaultBaseUrl?: string;
  apiPrefix?: string;
}

export interface ApiManifest {
  name: string;
  services: ManifestService[];
  flows: Flow[];
}

const MANIFEST_FILE = 'devbox.api.json';

const REGISTRY_FILE = process.env.API_INTEGRATIONS_PATH
  ? path.resolve(process.cwd(), process.env.API_INTEGRATIONS_PATH)
  : path.join(process.cwd(), '.apiintegrations.json');

// ── Registry ──────────────────────────────────────────────────────────────────

async function readRegistry(): Promise<ApiIntegration[]> {
  try {
    const raw = await fs.readFile(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.integrations) ? parsed.integrations : [];
    return arr.filter((x: unknown): x is ApiIntegration => {
      const o = x as ApiIntegration;
      return !!o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.root === 'string';
    });
  } catch {
    return [];
  }
}

async function writeRegistry(list: ApiIntegration[]): Promise<void> {
  await fs.writeFile(REGISTRY_FILE, JSON.stringify({ integrations: list }, null, 2) + '\n', 'utf8');
}

export async function listIntegrations(): Promise<ApiIntegration[]> {
  return readRegistry();
}

export async function getIntegration(id: string): Promise<ApiIntegration | null> {
  const list = await readRegistry();
  return list.find((i) => i.id === id) ?? null;
}

function makeId(name: string, existing: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pack';
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

async function validateRoot(rawRoot: unknown): Promise<string> {
  const root = String(rawRoot ?? '').trim();
  if (!root) throw new Error('root folder is required');
  const abs = path.resolve(root);
  const manifest = path.join(abs, MANIFEST_FILE);
  try {
    await fs.access(manifest);
  } catch {
    throw new Error(`Không thấy ${MANIFEST_FILE} trong "${abs}" — repo đó chưa có manifest.`);
  }
  return abs;
}

export async function addIntegration(body: { name?: unknown; root?: unknown }): Promise<ApiIntegration[]> {
  const name = String(body.name ?? '').trim();
  if (!name) throw new Error('integration name is required');
  const root = await validateRoot(body.root);
  const list = await readRegistry();
  list.push({ id: makeId(name, new Set(list.map((i) => i.id))), name, root });
  await writeRegistry(list);
  return list;
}

export async function updateIntegration(id: unknown, body: { name?: unknown; root?: unknown }): Promise<ApiIntegration[]> {
  if (typeof id !== 'string' || !id) throw new Error('integration id is required');
  const list = await readRegistry();
  const idx = list.findIndex((i) => i.id === id);
  if (idx === -1) throw new Error('integration not found');
  const name = String(body.name ?? '').trim() || list[idx].name;
  const root = await validateRoot(body.root ?? list[idx].root);
  list[idx] = { id, name, root };
  await writeRegistry(list);
  return list;
}

export async function removeIntegration(id: unknown): Promise<ApiIntegration[]> {
  if (typeof id !== 'string' || !id) throw new Error('integration id is required');
  const next = (await readRegistry()).filter((i) => i.id !== id);
  await writeRegistry(next);
  return next;
}

// ── Manifest loading ─────────────────────────────────────────────────────────

const AUTH_MODES = new Set(['apikey', 'tool', 'jwt-user', 'jwt-agent', 'jwt-admin']);

/** Read + validate a pack's devbox.api.json. Throws with a readable message. */
export async function loadManifest(integration: ApiIntegration): Promise<ApiManifest> {
  const raw = await fs.readFile(path.join(integration.root, MANIFEST_FILE), 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new Error(`${MANIFEST_FILE} không phải JSON hợp lệ: ${(e as Error).message}`);
  }
  const m = parsed as Partial<ApiManifest>;
  const services = (Array.isArray(m.services) ? m.services : [])
    .filter((s): s is ManifestService => {
      const o = s as ManifestService;
      return !!o && typeof o.id === 'string' && typeof o.label === 'string' && typeof o.spec === 'string';
    })
    .map((s) => ({
      ...s,
      authMode: (AUTH_MODES.has(String(s.authMode)) ? s.authMode : 'apikey') as AuthMode,
    }));
  if (services.length === 0) throw new Error(`${MANIFEST_FILE} không khai báo service nào.`);
  return {
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : integration.name,
    services,
    flows: Array.isArray(m.flows) ? (m.flows as Flow[]) : [],
  };
}

/** Resolve a manifest-relative spec path INSIDE the pack root (traversal-safe). */
export function resolveSpecPath(integration: ApiIntegration, relSpec: string): string {
  const abs = path.resolve(integration.root, relSpec);
  const rootWithSep = integration.root.endsWith(path.sep) ? integration.root : integration.root + path.sep;
  if (!abs.startsWith(rootWithSep)) {
    throw new Error(`spec path "${relSpec}" trỏ ra ngoài pack root — bị từ chối`);
  }
  return abs;
}
