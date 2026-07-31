// Quick-find presets for the MongoDB workspace. A preset bookmarks a
// (connection, database, collection) target under a friendly name — "Tìm
// tenant" — plus a curated list of QUERYABLE FIELDS. Running a preset shows
// those fields as checkboxes: tick the ones you have values for, fill them in,
// and the tool builds an equality filter (implicit AND across fields).
//
// Each field carries a TYPE so the value the operator types (always text in the
// UI) is converted to what the server actually stores:
//   text     → string equality
//   objectId → {"$oid": "<hex>"} (EJSON — the server parses it into ObjectId)
//   number   → numeric equality
//   boolean  → true/false
// The type can be overridden at run time (e.g. an _id that is sometimes a plain
// string) — the preset's type is just the default.
//
// Presets are a personal, local-dev bookmark, so they live in localStorage
// (same convention as lib/kafkaPresets.ts — connections stay server-owned).
// Browser-only module.

/** localStorage key holding the preset array (JSON). */
const QUICKFINDS_KEY = 'omicx.mongo.quickfinds';

export type QuickFieldType = 'text' | 'objectId' | 'number' | 'boolean';

export const QUICK_FIELD_TYPES: { value: QuickFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'objectId', label: 'ObjectId' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
];

export interface QuickFindField {
  /** Display name, e.g. "ID", "IsDeleted". */
  label: string;
  /** Mongo field path, e.g. "_id", "is_deleted", "profile.phone". */
  path: string;
  /** Default value type at run time (overridable per run). */
  type: QuickFieldType;
}

export interface MongoQuickFind {
  id: string;
  /** Friendly button name, e.g. "Tìm tenant". */
  name: string;
  /** id of a saved PublicMongoConnection. */
  connectionId: string;
  database: string;
  collection: string;
  fields: QuickFindField[];
  /** Page size when running (server clamps to ≤200). */
  limit: number;
}

function isField(v: unknown): v is QuickFindField {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return typeof f.label === 'string' && typeof f.path === 'string' && typeof f.type === 'string';
}

function isQuickFind(v: unknown): v is MongoQuickFind {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.connectionId === 'string' &&
    typeof p.database === 'string' &&
    typeof p.collection === 'string' &&
    Array.isArray(p.fields) && p.fields.every(isField)
  );
}

/** Read all presets (never throws — returns [] on any parse/storage error). */
export function loadQuickFinds(): MongoQuickFind[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(QUICKFINDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isQuickFind).map((p) => ({ ...p, limit: Number.isInteger(p.limit) && p.limit > 0 ? Math.min(p.limit, 200) : 50 }))
      : [];
  } catch {
    return [];
  }
}

/** Persist the full preset list. */
function save(list: MongoQuickFind[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(QUICKFINDS_KEY, JSON.stringify(list));
}

/** A non-crypto id — presets are local bookmarks, collision-safety isn't critical. */
function newId(): string {
  return `qf_${Math.random().toString(36).slice(2, 10)}${(performance.now() | 0).toString(36)}`;
}

/** Add a preset and return the new list. */
export function addQuickFind(input: Omit<MongoQuickFind, 'id'>): MongoQuickFind[] {
  const list = loadQuickFinds();
  list.push({ id: newId(), ...input });
  save(list);
  return list;
}

/** Update an existing preset by id and return the new list. */
export function updateQuickFind(id: string, patch: Omit<MongoQuickFind, 'id'>): MongoQuickFind[] {
  const list = loadQuickFinds().map((p) => (p.id === id ? { ...p, ...patch } : p));
  save(list);
  return list;
}

/** Remove a preset by id and return the new list. */
export function removeQuickFind(id: string): MongoQuickFind[] {
  const list = loadQuickFinds().filter((p) => p.id !== id);
  save(list);
  return list;
}

// ── Run-time filter builder ────────────────────────────────────────────────

export interface QuickFilterEntry {
  path: string;
  type: QuickFieldType;
  /** Raw text the operator typed. */
  value: string;
  /** true = "quidn,tamtd" is a comma-separated list → `{path: {$in: [...]}}`. */
  list?: boolean;
}

/** Convert ONE raw text value per the field type. Throws with the field name on bad input. */
function convertOne(path: string, type: QuickFieldType, raw: string): unknown {
  switch (type) {
    case 'objectId': {
      if (!/^[0-9a-fA-F]{24}$/.test(raw)) {
        throw new Error(`"${path}": ObjectId phải là 24 ký tự hex — nhận được "${raw}"`);
      }
      return { $oid: raw.toLowerCase() };
    }
    case 'number': {
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) throw new Error(`"${path}": "${raw}" không phải số`);
      return n;
    }
    case 'boolean': {
      if (raw !== 'true' && raw !== 'false') throw new Error(`"${path}": boolean phải là true/false`);
      return raw === 'true';
    }
    default:
      return raw;
  }
}

/**
 * Build the EJSON filter string for the enabled fields — implicit AND (all keys
 * in one object). Single mode = equality; list mode splits the value on commas
 * and emits `{$in: [...]}` with EVERY element converted per the field type
 * (an ObjectId list becomes real ObjectIds). Throws a per-field Error on a
 * value that can't be converted so the UI can show exactly which box is wrong.
 */
export function buildQuickFilter(entries: QuickFilterEntry[]): string {
  const filter: Record<string, unknown> = {};
  for (const e of entries) {
    const path = e.path.trim();
    if (!path) continue;
    if (e.list) {
      const parts = e.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) throw new Error(`"${path}": list rỗng — nhập các giá trị cách nhau dấu phẩy`);
      filter[path] = { $in: parts.map((p) => convertOne(path, e.type, p)) };
    } else {
      filter[path] = convertOne(path, e.type, e.value.trim());
    }
  }
  if (Object.keys(filter).length === 0) throw new Error('Chưa có điều kiện nào — tích ít nhất 1 field và điền giá trị.');
  return JSON.stringify(filter);
}
