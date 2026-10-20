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

/** `tags` = nhãn tự gán để lọc/gom biến (vd auth, user, payment) — không ảnh hưởng lúc gửi. */
export interface ApiVar { key: string; value: string; on?: boolean; name?: string; tags?: string[] }

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
  /** Nhãn mặc định cho biến CHƯA có lựa chọn riêng (= nhãn lần "chuyển nhanh" gần nhất). */
  activeVarName?: string;
  globalVars: ApiVar[];
  projectVars: Record<string, ApiVar[]>;
  /**
   * Giá trị ĐANG DÙNG của từng biến: phạm vi ('' = chung, hoặc thư mục) → tên
   * biến → nhãn của giá trị ('' = giá trị không nhãn). Mỗi biến tự chọn, không
   * còn một ô name chung cho mọi biến. Lưu chung cho mọi request.
   */
  varPicks: Record<string, Record<string, string>>;
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
      activeVarName: typeof d.activeVarName === 'string' ? d.activeVarName : undefined,
      globalVars: Array.isArray(d.globalVars)
        ? d.globalVars
        : (legacy?.vars ?? []).map((v) => ({ key: v.key, value: v.value, on: true })),
      projectVars: d.projectVars && typeof d.projectVars === 'object' ? d.projectVars : {},
      varPicks: cleanPicks(d.varPicks),
    };
  } catch { return { requests: [], environments: [], globalVars: [], projectVars: {}, varPicks: {} }; }
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

export async function setActiveVarName(name: unknown): Promise<ApiData> {
  const data = await readAll();
  const n = String(name ?? '').trim();
  data.activeVarName = n || undefined;
  await writeAll(data);
  return data;
}

/** varPicks sạch: chỉ giữ chuỗi → chuỗi, bỏ phạm vi rỗng. */
function cleanPicks(raw: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [scope, m] of Object.entries(raw as Record<string, unknown>)) {
    const picks = cleanScopePicks(m);
    if (Object.keys(picks).length) out[scope] = picks;
  }
  return out;
}

function cleanScopePicks(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.trim() && typeof v === 'string') out[k.trim()] = v.trim();
  }
  return out;
}

/** Ghi lựa chọn của MỘT phạm vi, bỏ khoá không còn biến nào (khỏi rác). */
function putScopePicks(data: ApiData, scope: string, picks: unknown, vars: ApiVar[]): void {
  const keys = new Set(vars.map((v) => v.key));
  const clean = Object.fromEntries(Object.entries(cleanScopePicks(picks)).filter(([k]) => keys.has(k)));
  if (Object.keys(clean).length) data.varPicks[scope] = clean;
  else delete data.varPicks[scope];
}

/** Đổi giá trị đang dùng của MỘT biến (thanh chip của request). */
export async function setVarPick(scopeRaw: unknown, keyRaw: unknown, labelRaw: unknown): Promise<ApiData> {
  const scope = String(scopeRaw ?? '').trim();
  const key = String(keyRaw ?? '').trim();
  if (!key) throw new Error('Thiếu tên biến.');
  const data = await readAll();
  (data.varPicks[scope] ??= {})[key] = String(labelRaw ?? '').trim();
  await writeAll(data);
  return data;
}

/**
 * CHUYỂN NHANH: mọi biến (mọi phạm vi) có giá trị mang nhãn `label` chuyển sang
 * giá trị đó; biến không có nhãn này giữ nguyên lựa chọn. Nhãn cũng thành mặc
 * định cho biến chưa từng được chọn riêng.
 */
export async function quickSwitchVars(labelRaw: unknown): Promise<ApiData> {
  const label = String(labelRaw ?? '').trim();
  const data = await readAll();
  const scopes: [string, ApiVar[]][] = [['', data.globalVars], ...Object.entries(data.projectVars)];
  for (const [scope, vars] of scopes) {
    for (const v of vars) {
      if (v.on !== false && (v.name ?? '') === label) (data.varPicks[scope] ??= {})[v.key] = label;
    }
  }
  data.activeVarName = label || undefined;
  await writeAll(data);
  return data;
}

/** Tag sạch: trim, bỏ rỗng, bỏ trùng (không phân biệt hoa/thường), tối đa 10. */
function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const s = String(t ?? '').trim().slice(0, 40);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out.slice(0, 10);
}

/** Danh sách biến sạch: bỏ dòng không có key, trim key. */
function cleanVars(vars: unknown): ApiVar[] {
  if (!Array.isArray(vars)) return [];
  const out: ApiVar[] = [];
  for (const v of vars as Partial<ApiVar>[]) {
    const key = String(v?.key ?? '').trim();
    if (!key) continue;
    const name = String(v?.name ?? '').trim();
    const tags = cleanTags(v?.tags);
    out.push({
      key, value: String(v?.value ?? ''), on: v?.on === false ? false : true,
      ...(name ? { name } : {}), ...(tags.length ? { tags } : {}),
    });
  }
  return out;
}

/** `picks` (tuỳ chọn) = lựa chọn giá trị của phạm vi này, ghi cùng lúc với biến. */
export async function saveGlobals(vars: unknown, picks?: unknown): Promise<ApiData> {
  const data = await readAll();
  data.globalVars = cleanVars(vars);
  if (picks !== undefined) putScopePicks(data, '', picks, data.globalVars);
  await writeAll(data);
  return data;
}

/** `project` rỗng không hợp lệ: biến chung có chỗ riêng của nó (saveGlobals). */
export async function saveProjectVars(project: string, vars: unknown, picks?: unknown): Promise<ApiData> {
  const name = project.trim();
  if (!name) throw new Error('Thiếu tên dự án.');
  const data = await readAll();
  const clean = cleanVars(vars);
  // Danh sách rỗng thì bỏ hẳn khoá — khỏi để lại mục mồ côi trong file.
  if (clean.length) data.projectVars[name] = clean;
  else delete data.projectVars[name];
  if (picks !== undefined) putScopePicks(data, name, picks, clean);
  await writeAll(data);
  return data;
}

// ── Import / đổi tên thư mục ────────────────────────────────────────────────

export type ImportMode = 'overwrite' | 'skip' | 'duplicate';

export interface ImportInput {
  requests: unknown;
  projectVars?: unknown;
  globalVars?: unknown;
  /** Xử lý request trùng id: ghi đè / bỏ qua / thêm bản sao id mới. */
  mode?: unknown;
  /** Đặt tất cả vào dưới thư mục này (rỗng = giữ nguyên cây của file). */
  prefix?: unknown;
}

export interface ImportResult { added: number; overwritten: number; skipped: number }

const joinFolder = (prefix: string, folder: string | undefined) =>
  [prefix, folder ?? ''].map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/') || undefined;

/** Gộp biến theo key: key mới thêm vào; key trùng thì ghi đè khi overwrite. */
function mergeVars(cur: ApiVar[], incoming: ApiVar[], overwrite: boolean): ApiVar[] {
  const out = cur.map((v) => ({ ...v }));
  for (const v of incoming) {
    const i = out.findIndex((x) => x.key === v.key && (x.name ?? '') === (v.name ?? ''));
    if (i < 0) out.push(v);
    else if (overwrite) out[i] = v;
  }
  return out;
}

export async function importBundle(input: ImportInput): Promise<{ data: ApiData; result: ImportResult }> {
  const mode: ImportMode = input.mode === 'skip' || input.mode === 'duplicate' ? input.mode : 'overwrite';
  const prefix = String(input.prefix ?? '').trim();
  const list = Array.isArray(input.requests) ? (input.requests as Partial<ApiRequest>[]) : [];
  if (!list.length) throw new Error('File không có request nào.');
  const data = await readAll();
  const result: ImportResult = { added: 0, overwritten: 0, skipped: 0 };
  const now = new Date().toISOString();

  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const rec: ApiRequest = {
      id: String(r.id ?? '') || randomUUID(),
      name: String(r.name ?? '').trim() || 'Untitled request',
      folder: joinFolder(prefix, r.folder),
      method: String(r.method ?? 'GET').toUpperCase(),
      url: String(r.url ?? ''),
      headers: Array.isArray(r.headers) ? r.headers : [],
      body: String(r.body ?? ''),
      bodyType: (['none', 'raw', 'form', 'multipart'] as const).includes(r.bodyType as ApiBodyType) ? r.bodyType as ApiBodyType : 'none',
      form: Array.isArray(r.form) ? r.form.map((f) => (f.kind === 'file' ? { ...f, fileB64: undefined } : f)) : undefined,
      params: Array.isArray(r.params) ? r.params : undefined,
      auth: r.auth && r.auth.type !== 'none' ? r.auth : undefined,
      opts: r.opts,
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
    };
    const i = data.requests.findIndex((x) => x.id === rec.id);
    if (i < 0) { data.requests.push(rec); result.added++; continue; }
    if (mode === 'skip') { result.skipped++; continue; }
    if (mode === 'duplicate') { data.requests.push({ ...rec, id: randomUUID() }); result.added++; continue; }
    data.requests[i] = rec;
    result.overwritten++;
  }

  // Biến: key mới luôn thêm; key trùng chỉ ghi đè ở chế độ overwrite.
  const ow = mode === 'overwrite';
  if (input.projectVars && typeof input.projectVars === 'object') {
    for (const [k, vars] of Object.entries(input.projectVars as Record<string, unknown>)) {
      const key = joinFolder(prefix, k);
      const clean = cleanVars(vars);
      if (!key || !clean.length) continue;
      data.projectVars[key] = mergeVars(data.projectVars[key] ?? [], clean, ow);
    }
  }
  const g = cleanVars(input.globalVars);
  if (g.length) data.globalVars = mergeVars(data.globalVars, g, ow);

  await writeAll(data);
  return { data, result };
}

/** Đổi tên (hoặc chuyển) thư mục `from` → `to`, kéo theo thư mục con và biến dự án. */
export async function renameFolder(fromRaw: unknown, toRaw: unknown): Promise<ApiData> {
  const from = String(fromRaw ?? '').trim();
  const to = String(toRaw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!from) throw new Error('Thiếu thư mục cần đổi tên.');
  if (!to) throw new Error('Tên mới không được rỗng.');
  if (from === to) return readAll();
  const move = (f: string | undefined) =>
    f === from ? to : f?.startsWith(`${from}/`) ? `${to}${f.slice(from.length)}` : f;
  const data = await readAll();
  for (const r of data.requests) r.folder = move(r.folder);
  const pv: Record<string, ApiVar[]> = {};
  for (const [k, v] of Object.entries(data.projectVars)) {
    const nk = move(k) ?? k;
    pv[nk] = pv[nk] ? mergeVars(pv[nk], v, false) : v;
  }
  data.projectVars = pv;
  // Lựa chọn giá trị đi theo thư mục (trùng thì lựa chọn đang có ở đích thắng).
  const picks: ApiData['varPicks'] = {};
  for (const [k, m] of Object.entries(data.varPicks)) {
    const nk = k === '' ? '' : move(k) ?? k;
    picks[nk] = { ...m, ...picks[nk] };
  }
  data.varPicks = picks;
  await writeAll(data);
  return data;
}
