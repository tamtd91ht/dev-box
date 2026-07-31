// Client-side auth helpers shared by the Webhooks workspace (management calls
// go through the same-origin /api/proxy with tool key/secret auth). Slimmed
// from the omicx fork — the endpoint-catalog caller (callEndpoint/fetchCurl)
// left with the API Explorer.

import type { ServiceCreds } from './creds';
import type { GlobalVars } from './persist';

/** Auth modes the proxy understands (see lib/proxyCore). The toolbox build only
 *  exercises 'tool' (X-KEY + X-VALUE), but the payload shape stays compatible. */
export type AuthMode = 'tool' | 'apikey' | 'jwt-agent' | 'jwt-admin' | 'none';

/** Auth payload sent to the proxy. The proxy turns this into the right headers
 *  (X-Api-Key for 'apikey', Bearer <token> for jwt-*, X-KEY + X-VALUE verbatim
 *  for 'tool'). The `token` is raw — the proxy prepends "Bearer " for jwt modes. */
export interface AuthPayload {
  mode: AuthMode;
  token?: string;
  toolKey?: string;
  toolSecret?: string;
}

/** Global variable a non-tool mode draws its token from (API_KEY convention). */
function globalVarFor(mode: AuthMode): keyof GlobalVars | null {
  return mode === 'apikey' ? 'API_KEY' : null;
}

/**
 * Resolve the effective auth for a call: per-service creds first, then the
 * matching global variable. Tool mode is always per-service (key + secret).
 */
export function resolveAuth(mode: AuthMode, creds: ServiceCreds, global: GlobalVars): AuthPayload {
  if (mode === 'tool') {
    return { mode, toolKey: creds.toolKey, toolSecret: creds.toolSecret };
  }
  const gv = globalVarFor(mode);
  const token = creds.token || (gv ? (global[gv] as string | undefined) : undefined);
  return { mode, token };
}

/** True when the resolved auth has everything its mode needs to authenticate. */
export function authReady(auth: AuthPayload): boolean {
  if (auth.mode === 'tool') return Boolean(auth.toolKey && auth.toolSecret);
  if (auth.mode === 'none') return true;
  return Boolean(auth.token);
}

export interface ProxyResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  contentType?: string;
  bodyJson?: unknown;
  bodyText?: string;
  error?: string;
  detail?: string;
}
