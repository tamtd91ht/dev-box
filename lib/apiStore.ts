// Per-machine store cho tab API (Postman-like): collections (request đã lưu,
// gom theo folder tên tự do) + environments (bộ biến {{var}}). File
// .apicollections.json gitignored trong cwd, full-file read/write.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface ApiHeader { key: string; value: string; on?: boolean }

export interface ApiRequest {
  id: string;
  name: string;
  /** Folder/nhóm tự do (vd "Auth", "OMICX") — rỗng = chưa phân nhóm. */
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

interface ApiData { requests: ApiRequest[]; environments: ApiEnvironment[]; activeEnvId?: string }

const REG_PATH = path.join(process.cwd(), process.env.API_COLLECTIONS_PATH || '.apicollections.json');

async function readAll(): Promise<ApiData> {
  try {
    const d = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as Partial<ApiData>;
    return {
      requests: Array.isArray(d.requests) ? d.requests : [],
      environments: Array.isArray(d.environments) ? d.environments : [],
      activeEnvId: d.activeEnvId,
    };
  } catch { return { requests: [], environments: [] }; }
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
