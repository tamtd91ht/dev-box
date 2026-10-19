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
import { readLocal } from './localKeys';
import { persistPresets } from './presetSync';

const QUICKFINDS_KEY = 'mongo.quickfinds';

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

export type QuickSortDir = 'asc' | 'desc';

/** MỘT khoá sắp xếp. */
export interface QuickFindSort {
  /** Field path để sort, e.g. "created_at". */
  path: string;
  dir: QuickSortDir;
}

/**
 * Sắp xếp kết quả — TUỲ CHỌN, NHIỀU KHOÁ áp theo thứ tự khai báo.
 * Không khai = giữ thứ tự tự nhiên của Mongo.
 */
export type QuickFindSortKeys = QuickFindSort[];

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
  /** Optional — sort kết quả theo một hoặc nhiều field, áp theo thứ tự.
   *  Preset cũ lưu dạng object đơn; sanitizeSort nâng lên mảng khi đọc. */
  sort?: QuickFindSortKeys;
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

/** Một khoá hợp lệ thì giữ, còn lại (thiếu path, dir lạ, tay sửa file hỏng) bỏ. */
function sanitizeSortKey(v: unknown): QuickFindSort | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  const path = typeof s.path === 'string' ? s.path.trim() : '';
  if (!path || (s.dir !== 'asc' && s.dir !== 'desc')) return undefined;
  return { path, dir: s.dir };
}

/**
 * Chuẩn hoá `sort` khi đọc preset — nhận CẢ HAI dạng.
 *
 * TƯƠNG THÍCH NGƯỢC (bắt buộc): preset lưu từ bản trước nằm trong localStorage
 * và configs/presets.json ở dạng object đơn `{path, dir}`. Chỉ nhận mảng thì
 * mọi preset cũ mất sort trong im lặng — người dùng không được báo gì, chỉ thấy
 * kết quả xếp sai. Nên object đơn được bọc thành mảng một phần tử.
 */
function sanitizeSort(v: unknown): QuickFindSortKeys | undefined {
  if (!v) return undefined;
  const raw = Array.isArray(v) ? v : [v]; // dạng cũ: object đơn
  const keys = raw.map(sanitizeSortKey).filter((k): k is QuickFindSort => !!k);
  return keys.length ? keys : undefined;
}

/** Read all presets (never throws — returns [] on any parse/storage error). */
export function loadQuickFinds(): MongoQuickFind[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = readLocal(QUICKFINDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isQuickFind).map((p) => ({
          ...p,
          limit: Number.isInteger(p.limit) && p.limit > 0 ? Math.min(p.limit, 200) : 50,
          sort: sanitizeSort(p.sort),
        }))
      : [];
  } catch {
    return [];
  }
}

/** Persist the full preset list. */
function save(list: MongoQuickFind[]): void {
  if (typeof window === 'undefined') return;
  // Ghi cache localStorage RỒI đẩy lên configs/presets.json — preset là
  // dữ liệu người dùng tự dựng, phải sống sót qua dọn cache và đẩy được
  // lên git như mọi config khác.
  persistPresets(QUICKFINDS_KEY, list);
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

/**
 * Sort EJSON cho find — '' khi không khai sort (giữ thứ tự tự nhiên).
 *
 * Nhiều khoá giữ ĐÚNG thứ tự khai báo: JSON.stringify của object literal giữ
 * thứ tự chèn với khoá chuỗi không phải số, và Mongo đọc sort theo thứ tự đó.
 * Khoá trùng path bị bỏ (khoá sau vô nghĩa, lại phá thứ tự).
 */
export function buildQuickSort(sort?: QuickFindSortKeys | QuickFindSort): string {
  if (!sort) return '';
  const keys = Array.isArray(sort) ? sort : [sort]; // nhận cả dạng cũ
  const out: Record<string, 1 | -1> = {};
  for (const k of keys) {
    const path = k?.path?.trim();
    if (!path || path in out) continue;
    out[path] = k.dir === 'desc' ? -1 : 1;
  }
  return Object.keys(out).length ? JSON.stringify(out) : '';
}

/** Mô tả sort cho tooltip / hộp thoại xác nhận: "created_at ↓ · name ↑". */
export function describeSort(sort?: QuickFindSortKeys): string {
  if (!sort?.length) return '';
  return sort.filter((k) => k.path.trim())
    .map((k) => `${k.path} ${k.dir === 'desc' ? '↓' : '↑'}`)
    .join(' · ');
}

// ── Run-time filter builder ────────────────────────────────────────────────

export interface QuickFilterEntry {
  path: string;
  type: QuickFieldType;
  /** Raw text the operator typed. */
  value: string;
  /** true = "alice,bob" is a comma-separated list → `{path: {$in: [...]}}`. */
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
