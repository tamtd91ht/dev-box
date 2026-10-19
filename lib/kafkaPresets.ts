// Quick-search presets for the Kafka workspace. A preset bookmarks a
// (connection, topic) pair under a friendly name — plus an optional description
// and a default "last N minutes" window — so a recurring investigation like
// "Bản tin FSEventComplete on kafka-01" is one click away. Running a preset
// then asks only for the keyword; the time window is pre-seeded from the
// preset's windowMinutes and can be overridden at the moment of use.
//
// Presets are a personal, local-dev bookmark, so they live in localStorage
// (unlike connections, which the Next server owns). Browser-only module.

/** localStorage key holding the preset array (JSON). */
import { readLocal } from './localKeys';
import { persistPresets } from './presetSync';

const PRESETS_KEY = 'kafka.presets';

export interface KafkaPreset {
  id: string;
  /** Friendly function name, e.g. "Bản tin FSEventComplete". */
  name: string;
  /** id of a saved PublicKafkaConnection (cluster). */
  connectionId: string;
  /** Topic to search. */
  topic: string;
  /** Mô tả ngắn — preset này tìm gì (absent on entries saved before this field existed). */
  description?: string;
  /** Default run window: "N phút gần nhất" (absent → DEFAULT_WINDOW_MINUTES). */
  windowMinutes?: number;
}

/** Khung thời gian mặc định khi chạy preset: 30 phút gần nhất tính tới hiện tại.
 *  Preset cũ đã lưu windowMinutes riêng thì vẫn giữ giá trị của nó — hằng số này
 *  chỉ áp cho preset chưa khai (windowMinutes vắng mặt) và cho ô mặc định của
 *  form tạo mới. */
export const DEFAULT_WINDOW_MINUTES = 30;
export const MAX_WINDOW_MINUTES = 10080; // 7 days

export function clampWindowMinutes(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_MINUTES;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(1, Math.round(n)));
}

function isPreset(v: unknown): v is KafkaPreset {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.connectionId === 'string' &&
    typeof p.topic === 'string' &&
    (p.description === undefined || typeof p.description === 'string') &&
    (p.windowMinutes === undefined || (typeof p.windowMinutes === 'number' && Number.isFinite(p.windowMinutes)))
  );
}

/** Read all presets (never throws — returns [] on any parse/storage error). */
export function loadPresets(): KafkaPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = readLocal(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPreset) : [];
  } catch {
    return [];
  }
}

/** Persist the full preset list. */
function save(list: KafkaPreset[]): void {
  if (typeof window === 'undefined') return;
  // Ghi cache localStorage RỒI đẩy lên configs/presets.json — preset là
  // dữ liệu người dùng tự dựng, phải sống sót qua dọn cache và đẩy được
  // lên git như mọi config khác.
  persistPresets(PRESETS_KEY, list);
}

/** A non-crypto id — presets are local bookmarks, collision-safety isn't critical. */
function newId(): string {
  return `p_${Math.random().toString(36).slice(2, 10)}${(performance.now() | 0).toString(36)}`;
}

/** Add a preset and return the new list. */
export function addPreset(input: Omit<KafkaPreset, 'id'>): KafkaPreset[] {
  const list = loadPresets();
  list.push({ id: newId(), ...input });
  save(list);
  return list;
}

/** Update an existing preset by id and return the new list. */
export function updatePreset(id: string, patch: Omit<KafkaPreset, 'id'>): KafkaPreset[] {
  const list = loadPresets().map((p) => (p.id === id ? { ...p, ...patch } : p));
  save(list);
  return list;
}

/** Remove a preset by id and return the new list. */
export function removePreset(id: string): KafkaPreset[] {
  const list = loadPresets().filter((p) => p.id !== id);
  save(list);
  return list;
}
