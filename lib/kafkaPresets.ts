// Quick-search presets for the Kafka workspace. A preset bookmarks a
// (connection, topic) pair under a friendly name so a recurring investigation —
// "Bản tin FSEventComplete on kafka-01" — is one click away. Running a preset
// then asks only for the keyword + time window at the moment of use.
//
// Presets are a personal, local-dev bookmark, so they live in localStorage
// (unlike connections, which the Next server owns). Browser-only module.

/** localStorage key holding the preset array (JSON). */
import { readLocal, writeLocal } from './localKeys';

const PRESETS_KEY = 'kafka.presets';

export interface KafkaPreset {
  id: string;
  /** Friendly function name, e.g. "Bản tin FSEventComplete". */
  name: string;
  /** id of a saved PublicKafkaConnection (cluster). */
  connectionId: string;
  /** Topic to search. */
  topic: string;
}

function isPreset(v: unknown): v is KafkaPreset {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.connectionId === 'string' &&
    typeof p.topic === 'string'
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
  writeLocal(PRESETS_KEY, JSON.stringify(list));
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
