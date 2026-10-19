// Export / import collection của tab API — phần browser-safe (không fs).
//
// File export là JSON tự mô tả:
//   { format: 'devbox-api-collection', version: 1, exportedAt, scope,
//     requests: ApiRequest[], projectVars?: {folder: vars}, globalVars?: vars }
// `scope` = đường dẫn thư mục đã xuất ('' = toàn bộ). Request giữ nguyên `folder`
// đầy đủ (vd "admin/call-export") để import sang máy khác ra đúng cây cũ.
//
// Import nhận 3 loại file:
//   · file export của DevBox (ở trên)
//   · Postman Collection v2.x (item lồng nhau → thư mục "Tên collection/Thư mục/…")
//   · nguyên file .apicollections.json của máy khác ({ requests, globalVars, … })
// Mọi loại đều quy về ApiBundle rồi mới gửi server — server chỉ biết một dạng.

import type { ApiAuth, ApiData, ApiFormField, ApiHeader, ApiRequest, ApiVar } from './api';

export const BUNDLE_FORMAT = 'devbox-api-collection';

export interface ApiBundle {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  exportedAt: string;
  scope: string;
  requests: ApiRequest[];
  projectVars?: Record<string, ApiVar[]>;
  globalVars?: ApiVar[];
}

export interface ParsedImport {
  /** Nguồn nhận ra được — hiện cho người dùng biết file là gì. */
  source: 'devbox' | 'postman' | 'raw';
  label: string;
  requests: ApiRequest[];
  projectVars: Record<string, ApiVar[]>;
  globalVars: ApiVar[];
}

/** Thư mục `folder` có nằm trong `scope` không ('' = mọi thứ). */
export function inScope(folder: string | undefined, scope: string): boolean {
  if (!scope) return true;
  const f = folder ?? '';
  return f === scope || f.startsWith(`${scope}/`);
}

export function buildExport(
  data: ApiData,
  scope: string,
  opts: { projectVars: boolean; globalVars: boolean },
): ApiBundle {
  const requests = data.requests
    .filter((r) => inScope(r.folder, scope))
    // Ruột file đính kèm không bao giờ đi theo (store cũng đã lược, đây là chốt hai).
    .map((r) => ({ ...r, form: r.form?.map((f) => (f.kind === 'file' ? { ...f, fileB64: undefined } : f)) }));
  const out: ApiBundle = { format: BUNDLE_FORMAT, version: 1, exportedAt: new Date().toISOString(), scope, requests };
  if (opts.projectVars) {
    const pv = Object.fromEntries(Object.entries(data.projectVars ?? {}).filter(([k]) => inScope(k, scope)));
    if (Object.keys(pv).length) out.projectVars = pv;
  }
  if (opts.globalVars && data.globalVars?.length) out.globalVars = data.globalVars;
  return out;
}

export function exportFileName(scope: string): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const slug = scope ? scope.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') : 'all';
  return `api-${slug || 'all'}-${stamp}.json`;
}

/** Ép trình duyệt lưu JSON thành file (Electron mở hộp thoại Save as…). */
export function downloadJson(obj: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Nhận diện + chuyển đổi file import ──────────────────────────────────────

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function cleanVars(v: unknown): ApiVar[] {
  return arr<Partial<ApiVar>>(v)
    .map((x) => ({ key: str(x.key).trim(), value: str(x.value), on: x.on !== false, ...(x.name ? { name: str(x.name) } : {}) }))
    .filter((x) => x.key);
}

function cleanVarMap(v: unknown): Record<string, ApiVar[]> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, ApiVar[]> = {};
  for (const [k, vars] of Object.entries(v as Record<string, unknown>)) {
    const c = cleanVars(vars);
    if (k.trim() && c.length) out[k.trim()] = c;
  }
  return out;
}

export function parseImport(raw: unknown): ParsedImport {
  if (!raw || typeof raw !== 'object') throw new Error('File không phải JSON object.');
  const o = raw as Record<string, unknown>;

  if (o.format === BUNDLE_FORMAT) {
    return {
      source: 'devbox',
      label: `DevBox export${o.scope ? ` — thư mục "${str(o.scope)}"` : ' — toàn bộ'}${o.exportedAt ? ` · ${str(o.exportedAt).slice(0, 16).replace('T', ' ')}` : ''}`,
      requests: arr<ApiRequest>(o.requests).filter((r) => r && typeof r === 'object'),
      projectVars: cleanVarMap(o.projectVars),
      globalVars: cleanVars(o.globalVars),
    };
  }

  const info = o.info as Record<string, unknown> | undefined;
  if (info && Array.isArray(o.item)) return fromPostman(o);

  if (Array.isArray(o.requests)) {
    return {
      source: 'raw',
      label: 'File dữ liệu API của DevBox (.apicollections.json)',
      requests: arr<ApiRequest>(o.requests).filter((r) => r && typeof r === 'object'),
      projectVars: cleanVarMap(o.projectVars),
      globalVars: cleanVars(o.globalVars),
    };
  }
  throw new Error('Không nhận ra định dạng file — cần file export của DevBox hoặc Postman Collection v2.');
}

// ── Postman Collection v2.0 / v2.1 ──────────────────────────────────────────

type PmKv = { key?: string; value?: unknown; disabled?: boolean; type?: string; src?: unknown };

function pmUrl(u: unknown): string {
  if (typeof u === 'string') return u;
  if (u && typeof u === 'object') {
    const x = u as Record<string, unknown>;
    if (typeof x.raw === 'string') return x.raw;
    const host = Array.isArray(x.host) ? x.host.join('.') : str(x.host);
    const path = Array.isArray(x.path) ? x.path.join('/') : str(x.path);
    const proto = x.protocol ? `${str(x.protocol)}://` : '';
    return `${proto}${host}${path ? `/${path}` : ''}`;
  }
  return '';
}

function pmAuth(a: unknown): ApiAuth | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const x = a as Record<string, unknown>;
  // v2.1: bearer: [{key:'token', value}] ; v2.0: bearer: {token}
  const get = (type: string, key: string): string => {
    const v = x[type];
    if (Array.isArray(v)) return str((v as PmKv[]).find((k) => k.key === key)?.value);
    if (v && typeof v === 'object') return str((v as Record<string, unknown>)[key]);
    return '';
  };
  switch (x.type) {
    case 'bearer': return { type: 'bearer', token: get('bearer', 'token') };
    case 'basic': return { type: 'basic', user: get('basic', 'username'), pass: get('basic', 'password') };
    case 'apikey': return {
      type: 'apikey', keyName: get('apikey', 'key'), keyValue: get('apikey', 'value'),
      keyIn: get('apikey', 'in') === 'query' ? 'query' : 'header',
    };
    default: return undefined;
  }
}

function fromPostman(o: Record<string, unknown>): ParsedImport {
  const info = o.info as Record<string, unknown>;
  const root = str(info.name).trim() || 'Postman';
  const requests: ApiRequest[] = [];
  const projectVars: Record<string, ApiVar[]> = {};
  const vars = arr<PmKv>(o.variable)
    .map((v) => ({ key: str(v.key).trim(), value: str(v.value), on: !v.disabled }))
    .filter((v) => v.key);
  if (vars.length) projectVars[root] = vars;
  const now = new Date().toISOString();
  let n = 0;

  const walk = (items: unknown[], folder: string, inherited: ApiAuth | undefined) => {
    for (const it of items as Record<string, unknown>[]) {
      if (!it || typeof it !== 'object') continue;
      const auth = pmAuth(it.auth) ?? inherited;
      if (Array.isArray(it.item)) {
        walk(it.item, `${folder}/${str(it.name).trim().replace(/\//g, '-') || 'Folder'}`, auth);
        continue;
      }
      const rq = it.request;
      if (!rq) continue;
      const r = (typeof rq === 'string' ? { url: rq, method: 'GET' } : rq) as Record<string, unknown>;
      const headers: ApiHeader[] = arr<PmKv>(r.header)
        .map((h) => ({ key: str(h.key), value: str(h.value), on: !h.disabled }))
        .filter((h) => h.key);
      const body = (r.body ?? {}) as Record<string, unknown>;
      let bodyType: ApiRequest['bodyType'] = 'none';
      let rawBody = '';
      let form: ApiFormField[] | undefined;
      if (body.mode === 'raw') { bodyType = 'raw'; rawBody = str(body.raw); }
      else if (body.mode === 'urlencoded') {
        bodyType = 'form';
        form = arr<PmKv>(body.urlencoded).map((f) => ({ key: str(f.key), value: str(f.value), on: !f.disabled, kind: 'text' as const }));
      } else if (body.mode === 'formdata') {
        bodyType = 'multipart';
        form = arr<PmKv>(body.formdata).map((f) => f.type === 'file'
          ? { key: str(f.key), value: '', on: !f.disabled, kind: 'file' as const, fileName: str(Array.isArray(f.src) ? f.src[0] : f.src).split(/[\\/]/).pop() }
          : { key: str(f.key), value: str(f.value), on: !f.disabled, kind: 'text' as const });
      } else if (body.mode === 'graphql') {
        bodyType = 'raw';
        rawBody = JSON.stringify(body.graphql ?? {}, null, 2);
      }
      const reqAuth = pmAuth(r.auth) ?? auth;
      requests.push({
        // id ổn định theo vị trí: import lại CÙNG file thì nhận ra là trùng, không nhân đôi.
        id: str(it.id) || `pm-${root}-${n++}-${str(it.name)}`.replace(/\s+/g, '_'),
        name: str(it.name).trim() || 'Request',
        folder,
        method: str(r.method).toUpperCase() || 'GET',
        url: pmUrl(r.url),
        headers,
        body: rawBody,
        bodyType,
        form,
        auth: reqAuth,
        updatedAt: now,
      });
    }
  };
  walk(o.item as unknown[], root, pmAuth(o.auth));
  return {
    source: 'postman',
    label: `Postman Collection — "${root}"`,
    requests,
    projectVars,
    globalVars: [],
  };
}
