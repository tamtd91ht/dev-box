// Client-side call helpers for the API Explorer + Webhooks workspaces. All
// requests go through the same-origin /api/proxy (the server injects auth
// headers). Auth-mode metadata that used to live in the integration-specific
// lib/services.ts is inlined here — integration packs declare a service's
// authMode in their manifest instead.

import type { Endpoint } from './types';
import type { ServiceCreds } from './creds';
import type { GlobalVars } from './persist';

/**
 * How a service authenticates:
 * - 'apikey':    single X-Api-Key header — token from global API_KEY.
 * - 'tool':      X-KEY + X-VALUE static shared secrets, sent verbatim.
 * - 'jwt-user':  Authorization: Bearer <platform user token> (JWT_TOKEN_USER).
 * - 'jwt-agent': Authorization: Bearer <tenant agent token> (JWT_TOKEN_AGENT).
 * - 'jwt-admin': Authorization: Bearer <admin-system token> (JWT_TOKEN_ADMIN).
 */
export type AuthMode = 'apikey' | 'tool' | 'jwt-user' | 'jwt-agent' | 'jwt-admin';

/** The global variable a mode draws its token from ('tool' resolves per-service). */
export function globalVarFor(mode: AuthMode): keyof GlobalVars | undefined {
  switch (mode) {
    case 'jwt-user': return 'JWT_TOKEN_USER';
    case 'jwt-agent': return 'JWT_TOKEN_AGENT';
    case 'jwt-admin': return 'JWT_TOKEN_ADMIN';
    case 'apikey': return 'API_KEY';
    default: return undefined; // tool — resolved per-service
  }
}

/** Short human label per auth mode (for the settings UI). */
export function authModeLabel(mode: AuthMode): string {
  switch (mode) {
    case 'tool': return 'Tool key + secret';
    case 'jwt-user': return 'JWT · platform user';
    case 'jwt-agent': return 'JWT · tenant agent';
    case 'jwt-admin': return 'JWT · tenant admin';
    default: return 'API key (X-Api-Key)';
  }
}

/** Auth payload sent to the proxy. The proxy turns this into the right headers
 *  (X-Api-Key for 'apikey', Bearer <token> for jwt-*, X-KEY + X-VALUE verbatim
 *  for 'tool'). The `token` is raw — the proxy prepends "Bearer " for jwt modes. */
export interface AuthPayload {
  mode: AuthMode;
  token?: string;
  toolKey?: string;
  toolSecret?: string;
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
  const token = creds.token || (gv ? global[gv] : undefined);
  return { mode, token };
}

/** True when the resolved auth has everything its mode needs to authenticate. */
export function authReady(auth: AuthPayload): boolean {
  if (auth.mode === 'tool') return Boolean(auth.toolKey && auth.toolSecret);
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

export interface CallArgs {
  baseUrl: string;
  /** Optional API prefix (e.g. "/api") — prepended unless the path already starts with it. */
  apiPrefix?: string;
  auth: AuthPayload;
  endpoint: Endpoint;
  query?: Record<string, string>;
  jsonBody?: string;      // raw JSON text as typed in the editor
  file?: File | null;     // for multipart (STT)
  languageCode?: string;  // extra multipart field for STT
}

export async function callEndpoint(args: CallArgs): Promise<ProxyResult> {
  const { baseUrl, apiPrefix, auth, endpoint, query, jsonBody, file, languageCode } = args;

  // Only attach auth on secured endpoints (skip for public ones like /health).
  const authForCall = endpoint.security ? auth : undefined;

  if (endpoint.bodyKind === 'multipart') {
    const form = new FormData();
    form.append('_baseUrl', baseUrl);
    form.append('_method', endpoint.method);
    form.append('_path', endpoint.path);
    if (apiPrefix) form.append('_apiPrefix', apiPrefix);
    if (authForCall) form.append('_auth', JSON.stringify(authForCall));
    if (query) form.append('_query', JSON.stringify(query));
    if (file) form.append('file', file);
    if (languageCode) form.append('languageCode', languageCode);

    const res = await fetch('/api/proxy', { method: 'POST', body: form });
    return res.json();
  }

  const res = await fetch('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      apiPrefix,
      method: endpoint.method,
      path: endpoint.path,
      auth: authForCall,
      query,
      jsonBody: endpoint.bodyKind === 'json' ? jsonBody : undefined,
    }),
  });
  return res.json();
}

/** Ask the server for the equivalent `curl` command for a call (see /api/curl). */
export async function fetchCurl(args: CallArgs): Promise<{ curl: string; note?: string }> {
  const { baseUrl, apiPrefix, auth, endpoint, query, jsonBody, file, languageCode } = args;
  const authForCall = endpoint.security ? auth : undefined;
  const res = await fetch('/api/curl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      apiPrefix,
      method: endpoint.method,
      path: endpoint.path,
      auth: authForCall,
      query,
      jsonBody: endpoint.bodyKind === 'json' ? jsonBody : undefined,
      multipart: endpoint.bodyKind === 'multipart',
      fileName: file?.name,
      languageCode: endpoint.bodyKind === 'multipart' ? languageCode : undefined,
    }),
  });
  return res.json();
}

export interface AgentTokenResult {
  token?: string;
  error?: string;
  resolvedBy?: string;
  tenantId?: string;
  expiresIn?: number;
}

/** Mint a tenant agent token via tool-service (see /api/agent-token). */
export async function generateAgentToken(tenant: string): Promise<AgentTokenResult> {
  try {
    const res = await fetch('/api/agent-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant }),
    });
    return await res.json();
  } catch (e) {
    return { error: String(e) };
  }
}

/** Replace {{var}} placeholders in a string using the captured-vars map. */
export function interpolate(
  input: string | undefined,
  vars: Record<string, string>,
): string | undefined {
  if (!input) return input;
  return input.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, name: string) =>
    vars[name] !== undefined ? vars[name] : `{{${name}}}`,
  );
}

/** Read a value out of a JSON body by dotted path (e.g. "id" or "data.0.id"). */
export function readPath(body: unknown, dotted: string): string | undefined {
  const parts = dotted.split('.');
  let cur: unknown = body;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur == null ? undefined : String(cur);
}
