// Per-machine store cho tab API (Postman-like): collections (request đã lưu,
// gom theo folder tên tự do) + environments (bộ biến {{var}}). File
// .apicollections.json gitignored trong cwd, full-file read/write.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';

export interface ApiHeader { key: string; value: string; on?: boolean }

/** Mirror của ApiBodyType ở lib/api.ts (file này không import module browser). */
export type ApiBodyType = 'none' | 'raw' | 'form' | 'multipart';

/** Một dòng form. `fileB64` KHÔNG bao giờ được ghi xuống đây — client đã lược
 *  bỏ (stripFiles), và saveRequest lược lần nữa cho chắc: file vài MB nhồi vào
 *  file cấu hình JSON làm mọi lần đọc/ghi chậm hẳn. */
export interface ApiFormField {
  key: string;
  value: string;
  on?: boolean;
  kind?: 'text' | 'file';
  fileName?: string;
  fileB64?: string;
  fileType?: string;
}

export interface ApiVar { key: string; value: string; on?: boolean }

export interface ApiAuth {
  type: 'none' | 'bearer' | 'basic' | 'apikey';
  token?: string;
  user?: string;
  pass?: string;
  keyName?: string;
  keyValue?: string;
  keyIn?: 'header' | 'query';
}

export interface ApiSendOpts { timeoutSec?: number; follow?: boolean }

export interface ApiRequest {
  id: string;
  name: string;
  /** Folder/nhóm tự do (vd "Auth", "Backend") — rỗng = chưa phân nhóm. */
  folder?: string;
  method: string;
  url: string;
  headers: ApiHeader[];
  body: string;
  bodyType: ApiBodyType;
  /** Dòng form khi bodyType là 'form' (urlencoded) hoặc 'multipart'. */
  form?: ApiFormField[];
  /** Bảng Params (gồm dòng đang tắt). Vắng = suy ra từ query của `url`. */
  params?: ApiHeader[];
  auth?: ApiAuth;
  opts?: ApiSendOpts;
  updatedAt: string;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  vars: { key: string; value: string }[];
}

interface ApiData {
  requests: ApiRequest[];
  /** Cũ: giữ nguyên trong file, không còn dùng (xem globalVars). */
  environments: ApiEnvironment[];
  activeEnvId?: string;
  globalVars: ApiVar[];
  projectVars: Record<string, ApiVar[]>;
}

const REG_PATH = process.env.API_COLLECTIONS_PATH ? path.resolve(process.cwd(), process.env.API_COLLECTIONS_PATH) : configPath('apicollections.json', ['.apicollections.json']);

async function readAll(): Promise<ApiData> {
  try {
    const d = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as Partial<ApiData>;
    const environments = Array.isArray(d.environments) ? d.environments : [];
    // Chuyển từ mô hình cũ: chưa có biến chung thì lấy bộ environment đang chọn
    // (hoặc cái đầu tiên) làm biến chung. KHÔNG xoá environments — chúng vẫn nằm
    // nguyên trong file, chỉ là UI không dùng nữa. Lần ghi kế tiếp sẽ lưu luôn
    // globalVars; cho tới lúc đó mỗi lần đọc seed ra cùng một kết quả.
    const legacy = environments.find((e) => e.id === d.activeEnvId) ?? environments[0];
    return {
      requests: Array.isArray(d.requests) ? d.requests : [],
      environments,
      activeEnvId: d.activeEnvId,
      globalVars: Array.isArray(d.globalVars)
        ? d.globalVars
        : (legacy?.vars ?? []).map((v) => ({ key: v.key, value: v.value, on: true })),
      projectVars: d.projectVars && typeof d.projectVars === 'object' ? d.projectVars : {},
    };
  } catch { return { requests: [], environments: [], globalVars: [], projectVars: {} }; }
}
async function writeAll(data: ApiData): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

export async function getData(): Promise<ApiData> { return readAll(); }

export async function saveRequest(input: Partial<ApiRequest> & { name: string }): Promise<ApiData> {
  const data = await readAll();
  const now = new Date().toISOString();
  const base = {
    name: input.name.trim() || 'Untitled request',
    folder: (input.folder ?? '').trim() || undefined,
    method: input.method ?? 'GET',
    url: input.url ?? '',
    headers: input.headers ?? [],
    body: input.body ?? '',
    bodyType: input.bodyType ?? 'none',
    // Chốt chặn cuối: ruột file không được nằm trong collections dù client có
    // lỡ gửi lên. Giữ tên/kiểu để UI còn hiện "đã chọn file X, chọn lại đi".
    form: input.form?.map((f) => (f.kind === 'file' ? { ...f, fileB64: undefined } : f)),
    params: input.params,
    auth: input.auth && input.auth.type !== 'none' ? input.auth : undefined,
    opts: input.opts,
    updatedAt: now,
  };
  if (input.id) {
    const r = data.requests.find((x) => x.id === input.id);
    if (!r) throw new Error('Không tìm thấy request.');
    Object.assign(r, base);
  } else {
    data.requests.unshift({ id: randomUUID(), ...base });
  }
  await writeAll(data);
  return data;
}

export async function removeRequest(id: string): Promise<ApiData> {
  const data = await readAll();
  data.requests = data.requests.filter((r) => r.id !== id);
  await writeAll(data);
  return data;
}

export async function saveEnv(input: Partial<ApiEnvironment> & { name: string }): Promise<ApiData> {
  const data = await readAll();
  if (input.id) {
    const e = data.environments.find((x) => x.id === input.id);
    if (!e) throw new Error('Không tìm thấy environment.');
    e.name = input.name.trim() || e.name;
    e.vars = input.vars ?? e.vars;
  } else {
    data.environments.unshift({ id: randomUUID(), name: input.name.trim() || 'Env', vars: input.vars ?? [] });
  }
  await writeAll(data);
  return data;
}

export async function removeEnv(id: string): Promise<ApiData> {
  const data = await readAll();
  data.environments = data.environments.filter((e) => e.id !== id);
  if (data.activeEnvId === id) data.activeEnvId = undefined;
  await writeAll(data);
  return data;
}

export async function setActiveEnv(id: string | null): Promise<ApiData> {
  const data = await readAll();
  data.activeEnvId = id ?? undefined;
  await writeAll(data);
  return data;
}

/** Danh sách biến sạch: bỏ dòng không có key, trim key. */
function cleanVars(vars: unknown): ApiVar[] {
  if (!Array.isArray(vars)) return [];
  const out: ApiVar[] = [];
  for (const v of vars as Partial<ApiVar>[]) {
    const key = String(v?.key ?? '').trim();
    if (!key) continue;
    out.push({ key, value: String(v?.value ?? ''), on: v?.on === false ? false : true });
  }
  return out;
}

export async function saveGlobals(vars: unknown): Promise<ApiData> {
  const data = await readAll();
  data.globalVars = cleanVars(vars);
  await writeAll(data);
  return data;
}

/** `project` rỗng không hợp lệ: biến chung có chỗ riêng của nó (saveGlobals). */
export async function saveProjectVars(project: string, vars: unknown): Promise<ApiData> {
  const name = project.trim();
  if (!name) throw new Error('Thiếu tên dự án.');
  const data = await readAll();
  const clean = cleanVars(vars);
  // Danh sách rỗng thì bỏ hẳn khoá — khỏi để lại mục mồ côi trong file.
  if (clean.length) data.projectVars[name] = clean;
  else delete data.projectVars[name];
  await writeAll(data);
  return data;
}
