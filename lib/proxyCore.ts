// Server-only core shared by /api/proxy and /api/curl.
//
// Both routes must turn the SAME auth spec into the SAME headers and target URL —
// the curl export is only useful if it matches what the proxy actually sends. For
// 'tool' mode X-KEY and X-VALUE are both static shared secrets sent verbatim
// (tool-service compares them constant-time) — no time token, no prefix.

export const API_KEY_HEADER = 'X-Api-Key';
export const TOOL_KEY_HEADER = 'X-KEY';
export const TOOL_VALUE_HEADER = 'X-VALUE';
export const AUTH_HEADER = 'Authorization';

export type AuthModeSpec = 'apikey' | 'tool' | 'jwt-user' | 'jwt-agent' | 'jwt-admin';

export interface AuthSpec {
  mode?: AuthModeSpec;
  token?: string;
  toolKey?: string;
  toolSecret?: string;
}

/** Prepend "Bearer " unless the token already carries it (case-insensitive). */
export function bearer(token: string): string {
  return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
}

/**
 * Build auth headers for the chosen mode. For 'tool' both X-KEY and X-VALUE are
 * static shared secrets sent verbatim — tool-service compares them constant-time.
 */
export function authHeaders(auth: AuthSpec | undefined): Record<string, string> {
  if (!auth) return {};
  if (auth.mode === 'tool') {
    if (!auth.toolKey || !auth.toolSecret) return {};
    return {
      [TOOL_KEY_HEADER]: auth.toolKey,
      [TOOL_VALUE_HEADER]: auth.toolSecret,
    };
  }
  if (!auth.token) return {};
  // jwt-* modes → Authorization: Bearer <token>; apikey → X-Api-Key.
  if (auth.mode === 'jwt-user' || auth.mode === 'jwt-agent' || auth.mode === 'jwt-admin') {
    return { [AUTH_HEADER]: bearer(String(auth.token)) };
  }
  return { [API_KEY_HEADER]: String(auth.token) };
}

/**
 * Reconcile an optional API prefix (e.g. "/api") against an openapi path. The
 * prefix is prepended ONLY when the path does not already start with it —
 * segment-aware, so a prefix "/api" is not considered present in "/apix/…". Both
 * are normalized to a single leading slash. An empty/blank prefix is a no-op.
 *
 * This matches services whose openapi.yaml already bakes the prefix into every
 * path (ai-service: "/api/ai/jobs" → left as-is) as well as services whose paths
 * omit it (tool-service: "/tools/encrypt" → "/api/tools/encrypt"). The gateway
 * routing prefix (e.g. "/ai-svc") is NOT handled here — it belongs in the base URL.
 */
export function joinPath(apiPrefix: string | undefined, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  let pre = (apiPrefix ?? '').trim().replace(/\/+$/, '');
  if (!pre) return p;
  if (!pre.startsWith('/')) pre = `/${pre}`;
  if (p === pre || p.startsWith(`${pre}/`)) return p; // already carries the prefix
  return pre + p;
}

export function buildTargetUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string> | null,
  apiPrefix?: string,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = joinPath(apiPrefix, path);
  const url = new URL(base + p);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && `${v}`.length > 0) {
        url.searchParams.set(k, `${v}`);
      }
    }
  }
  return url.toString();
}
