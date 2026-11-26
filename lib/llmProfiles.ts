// Kho CẤU HÌNH + PROMPT MẪU dùng chung cho các menu gọi LLM qua API (🤖 OpenAI, ClaudeAI).
// Mỗi nhà cung cấp một file trong configs/ (configs/openai.json, configs/claude.json — cả thư
// mục configs/ không lên git: file CHỨA KHOÁ API). Lưu được NHIỀU cấu hình (khoá công ty / cá
// nhân / dịch vụ tương thích…), một cấu hình mặc định; request chọn cấu hình theo id.
//
// Khoá không bao giờ ra khỏi server: trang chỉ nhận `keyHint` ("sk-p…3fQa"); mọi chữ trả về trang
// đi qua scrubKey. Phần gọi API (khác nhau theo nhà cung cấp) nằm ở lib/openaiServer.ts,
// lib/claudeServer.ts.

import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';
import {
  OPENAI_LIMITS,
  type OpenAiPreset, type OpenAiProfile, type OpenAiProfileInput, type OpenAiProfiles,
} from './openai';

export interface StoredProfile {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  organization: string;
  project: string;
  defaultModel: string;
}

interface Store {
  profiles: StoredProfile[];
  defaultId: string;
  presets: OpenAiPreset[];
}

export const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Che khoá trong mọi chữ trả về trang (lỗi của API đôi khi nhắc lại khoá). */
export function scrubKey(text: string, key: string): string {
  let out = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
  if (key) out = out.split(key).join('***');
  return out;
}

function keyHint(key: string): string {
  if (!key) return '';
  return key.length <= 10 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export interface ProfileStoreOptions {
  /** Tên file trong configs/, vd "openai.json". */
  file: string;
  /** Base URL mặc định khi người dùng để trống. */
  defaultBase: string;
  /** Tên nhà cung cấp trong thông báo, vd "OpenAI", "Claude". */
  label: string;
}

export function createProfileStore(o: ProfileStoreOptions) {
  const STORE = configPath(o.file);

  async function readStore(): Promise<Store> {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(await fs.readFile(STORE, 'utf8')) as Record<string, unknown>; } catch { /* chưa có */ }
    const presets = Array.isArray(data.presets) ? (data.presets as OpenAiPreset[]) : [];
    let profiles = Array.isArray(data.profiles) ? (data.profiles as StoredProfile[]) : [];
    // Bản đầu (chỉ OpenAI) có MỘT cấu hình (`config`) → thành cấu hình "Mặc định".
    const old = data.config as Partial<StoredProfile> | undefined;
    if (!profiles.length && old && (old.apiKey || old.defaultModel)) {
      profiles = [{
        id: randomUUID(), name: 'Mặc định', apiKey: old.apiKey ?? '', baseUrl: old.baseUrl || o.defaultBase,
        organization: old.organization ?? '', project: old.project ?? '', defaultModel: old.defaultModel ?? '',
      }];
    }
    const defaultId = typeof data.defaultId === 'string' && profiles.some((p) => p.id === data.defaultId)
      ? data.defaultId : profiles[0]?.id ?? '';
    return { profiles, defaultId, presets };
  }

  async function writeStore(s: Store): Promise<void> {
    await fs.writeFile(STORE, JSON.stringify(s, null, 2), 'utf8');
  }

  function publicOf(p: StoredProfile): OpenAiProfile {
    return {
      id: p.id,
      name: p.name,
      hasKey: !!p.apiKey,
      keyHint: keyHint(p.apiKey),
      baseUrl: p.baseUrl || o.defaultBase,
      organization: p.organization,
      project: p.project,
      defaultModel: p.defaultModel,
    };
  }

  const publicStore = (s: Store): OpenAiProfiles => ({ profiles: s.profiles.map(publicOf), defaultId: s.defaultId });

  function normBaseUrl(v: unknown): string {
    const raw = str(v, 500) || o.defaultBase;
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error(`Base URL không hợp lệ (vd ${o.defaultBase}).`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Base URL phải là http(s).');
    return raw.replace(/\/+$/, '');
  }

  /** Cấu hình đã lưu, đè bằng bản nháp (nút Thử trước khi lưu). */
  function merged(saved: StoredProfile, draft?: OpenAiProfileInput): StoredProfile {
    if (!draft) return saved;
    return {
      id: saved.id,
      name: draft.name !== undefined ? str(draft.name, 80) || saved.name : saved.name,
      apiKey: draft.clearKey ? '' : str(draft.apiKey, 500) || saved.apiKey,
      baseUrl: draft.baseUrl !== undefined ? normBaseUrl(draft.baseUrl) : saved.baseUrl,
      organization: draft.organization !== undefined ? str(draft.organization, 200) : saved.organization,
      project: draft.project !== undefined ? str(draft.project, 200) : saved.project,
      defaultModel: draft.defaultModel !== undefined ? str(draft.defaultModel, 200) : saved.defaultModel,
    };
  }

  const blank = (): StoredProfile => ({
    id: '', name: '', apiKey: '', baseUrl: o.defaultBase, organization: '', project: '', defaultModel: '',
  });

  /** Cấu hình theo id; trống = mặc định. */
  function pick(s: Store, id: unknown): StoredProfile {
    const want = typeof id === 'string' && id ? id : s.defaultId;
    const p = s.profiles.find((x) => x.id === want);
    if (!p) {
      throw new Error(s.profiles.length
        ? 'Không còn cấu hình này (đã bị xoá?) — chọn lại cấu hình.'
        : `Chưa có cấu hình nào — bấm ⚙ thêm khoá API ${o.label}.`);
    }
    return p;
  }

  /** Cấu hình để gọi API: đã lưu (theo id) hoặc bản nháp chưa lưu (nút Thử kết nối). */
  async function resolve(profileId: unknown, draft?: OpenAiProfileInput): Promise<StoredProfile> {
    const s = await readStore();
    const base = draft && !draft.id && !profileId ? { ...blank(), name: str(draft.name, 80) || 'Cấu hình mới' } : pick(s, draft?.id || profileId);
    return merged(base, draft);
  }

  async function profilesList(): Promise<OpenAiProfiles> {
    return publicStore(await readStore());
  }

  async function profileSave(input: unknown): Promise<OpenAiProfiles> {
    const draft = (input ?? {}) as OpenAiProfileInput;
    const s = await readStore();
    const name = str(draft.name, 80);
    if (draft.id) {
      const i = s.profiles.findIndex((p) => p.id === draft.id);
      if (i < 0) throw new Error('Không tìm thấy cấu hình để cập nhật (đã bị xoá?).');
      s.profiles[i] = merged(s.profiles[i], draft);
    } else {
      if (!name) throw new Error('Đặt tên cho cấu hình (vd "Công ty", "Cá nhân").');
      if (s.profiles.length >= OPENAI_LIMITS.maxProfiles) throw new Error(`Đã đủ ${OPENAI_LIMITS.maxProfiles} cấu hình — xoá bớt trước.`);
      s.profiles.push(merged({ ...blank(), id: randomUUID(), name }, draft));
    }
    const dup = new Set<string>();
    for (const p of s.profiles) {
      const k = p.name.toLowerCase();
      if (dup.has(k)) throw new Error(`Đã có cấu hình tên "${p.name}" — đặt tên khác.`);
      dup.add(k);
    }
    if (!s.defaultId) s.defaultId = s.profiles[0]?.id ?? '';
    await writeStore(s);
    return publicStore(s);
  }

  async function profileRemove(id: unknown): Promise<OpenAiProfiles> {
    const s = await readStore();
    s.profiles = s.profiles.filter((p) => p.id !== id);
    if (!s.profiles.some((p) => p.id === s.defaultId)) s.defaultId = s.profiles[0]?.id ?? '';
    await writeStore(s);
    return publicStore(s);
  }

  async function profileSetDefault(id: unknown): Promise<OpenAiProfiles> {
    const s = await readStore();
    s.defaultId = pick(s, id).id;
    await writeStore(s);
    return publicStore(s);
  }

  async function presetsList(): Promise<OpenAiPreset[]> {
    return (await readStore()).presets;
  }

  /** Thêm / cập nhật một prompt mẫu đã được nhà cung cấp kiểm (normRequest của nó). */
  async function presetUpsert(preset: Omit<OpenAiPreset, 'id' | 'updatedAt'> & { id?: string }): Promise<OpenAiPreset[]> {
    const s = await readStore();
    const full: OpenAiPreset = { ...preset, id: preset.id || randomUUID(), updatedAt: new Date().toISOString() };
    const i = s.presets.findIndex((p) => p.id === full.id);
    if (i >= 0) s.presets[i] = full;
    else {
      if (s.presets.length >= OPENAI_LIMITS.maxPresets) throw new Error(`Đã đủ ${OPENAI_LIMITS.maxPresets} prompt mẫu — xoá bớt trước.`);
      s.presets.push(full);
    }
    await writeStore(s);
    return s.presets;
  }

  async function presetRemove(id: unknown): Promise<OpenAiPreset[]> {
    const s = await readStore();
    s.presets = s.presets.filter((p) => p.id !== id);
    await writeStore(s);
    return s.presets;
  }

  return {
    readStore, pick, resolve,
    profilesList, profileSave, profileRemove, profileSetDefault,
    presetsList, presetUpsert, presetRemove,
  };
}
