// Client helpers + types cho tab API (Postman-like). Browser-safe.

export interface ApiHeader { key: string; value: string; on?: boolean }

export interface ApiRequest {
  id: string;
  name: string;
  folder?: string;
  method: string;
  url: string;
  headers: ApiHeader[];
  body: string;
  bodyType: 'none' | 'raw' | 'form';
  updatedAt: string;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  vars: { key: string; value: string }[];
}

export interface ApiData {
  requests: ApiRequest[];
  environments: ApiEnvironment[];
  activeEnvId?: string;
}

export interface HttpResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
  size: number;
}

async function call<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
  const r = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { result: T }).result;
}

const store = (action: string, params: Record<string, unknown> = {}) =>
  call<ApiData>('/api/api-collections', { action, ...params });

export const apiGet = () => store('get');
export const apiSaveRequest = (r: Partial<ApiRequest> & { name: string }) => store('saveRequest', { ...r });
export const apiRemoveRequest = (id: string) => store('removeRequest', { id });
export const apiSaveEnv = (e: Partial<ApiEnvironment> & { name: string }) => store('saveEnv', { ...e });
export const apiRemoveEnv = (id: string) => store('removeEnv', { id });
export const apiSetActiveEnv = (id: string | null) => store('setActiveEnv', { id });

/** Gửi một request qua proxy server (né CORS). */
export const apiSend = (input: { method: string; url: string; headers?: ApiHeader[]; body?: string }) =>
  call<HttpResult>('/api/http', input);
