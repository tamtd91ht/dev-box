// Client-side helpers for the local, on-disk config store.
//
// Connection config (per-service base URL + per-service token override) AND the
// shared global variables (API_KEY + JWT tokens) are persisted to a JSON file on
// THIS machine by the server (see lib/localStore.ts + app/api/local-config).
// The browser reads it on load and writes back on every change, so a restart —
// even in a different browser or incognito window — re-maps the saved config.
//
// These functions only talk to the same-origin /api/local-config route; the file
// itself is touched exclusively on the server.

/** One service's persisted connection config. All fields optional. */
export interface StoredServiceConfig {
  baseUrl?: string;
  /** API prefix (e.g. "/api") reconciled against each openapi path: prepended
   *  unless the path already starts with it. Empty = no prefix. The gateway
   *  routing prefix (e.g. "/ai-svc") belongs in baseUrl, not here. */
  apiPrefix?: string;
  /** Per-service auth token/key OVERRIDE (raw, no "Bearer"). Falls back to the
   *  matching global variable when empty. */
  token?: string;
  toolKey?: string;    // tool mode — X-KEY
  toolSecret?: string; // tool mode — static secret sent verbatim as X-VALUE
  /** WebSocket URL for the tool-service webhook receiver's live push (e.g.
   *  ws://localhost:9090/ws/webhooks). Empty = derive from baseUrl host + :9090. */
  wsUrl?: string;
  /** Public ingest base used to render the copyable webhook URL
   *  (`{publicBaseUrl}/tools/hook/{id}`). This is the host external senders reach —
   *  often a dedicated ingress, distinct from the management baseUrl. Empty = derive
   *  from baseUrl + apiPrefix. */
  publicBaseUrl?: string;
}

/** Shared global variables applied to every service unless it overrides them. */
export interface GlobalVars {
  API_KEY?: string;           // apikey services → X-Api-Key
  JWT_TOKEN_USER?: string;    // platform user     → Authorization: Bearer
  JWT_TOKEN_AGENT?: string;   // agent of a tenant → Authorization: Bearer
  JWT_TOKEN_ADMIN?: string;   // tenant admin-system agent → Authorization: Bearer
}

/** Per-service config store: service id → its persisted config. */
export type LocalConfig = Record<string, StoredServiceConfig>;

/** Reserved store key that holds the GlobalVars object. */
export const GLOBAL_KEY = '__global__';

/** A write patch. A `null` value deletes that key from the stored entry. */
export type ConfigPatch = Record<string, string | null>;

/** The full config: per-service entries + the shared global variables. */
export interface FullConfig {
  services: LocalConfig;
  global: GlobalVars;
}

/** Load the full persisted config from disk (via the server). */
export async function fetchFullConfig(): Promise<FullConfig> {
  const r = await fetch('/api/local-config');
  const d = await r.json();
  return {
    services: (d.services ?? {}) as LocalConfig,
    global: (d.global ?? {}) as GlobalVars,
  };
}

/**
 * Merge `patch` into the stored config for `service` and persist it, overwriting
 * the previous values for the patched keys. Returns the full updated store.
 */
export async function saveLocalConfig(service: string, patch: ConfigPatch): Promise<FullConfig> {
  return putConfig(service, patch);
}

/** Merge `patch` into the shared global variables and persist it. */
export async function saveGlobalVars(patch: ConfigPatch): Promise<FullConfig> {
  return putConfig(GLOBAL_KEY, patch);
}

async function putConfig(service: string, patch: ConfigPatch): Promise<FullConfig> {
  const r = await fetch('/api/local-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service, patch }),
  });
  const d = await r.json();
  return {
    services: (d.services ?? {}) as LocalConfig,
    global: (d.global ?? {}) as GlobalVars,
  };
}
