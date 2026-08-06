// Quick-find presets for the PostgreSQL workspace — same model as the Mongo/ES
// tabs: a named button bookmarks (connection, database, schema.table) plus a
// curated list of queryable COLUMNS; running it is: tick, fill, Run. The WHERE
// is built SERVER-SIDE from structured entries as parameterized `col = $n` /
// `col = ANY($n)` clauses (implicit AND) — values never concatenate into SQL.
//
// Column types: text · number · boolean (converted before binding). List mode
// ("a,b") binds an array and compares with `= ANY(...)`.
//
// Presets live in localStorage. Browser-only module.

import type { PgQuickFieldType } from '@/lib/pg';

import { readLocal, writeLocal } from './localKeys';

const QUICKFINDS_KEY = 'pg.quickfinds';

export const PG_QUICK_FIELD_TYPES: { value: PgQuickFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Số' },
  { value: 'boolean', label: 'Boolean' },
];

export interface PgQuickFindField {
  /** Display name, e.g. "Tenant". */
  label: string;
  /** Column name, e.g. "tenant_id". */
  column: string;
  type: PgQuickFieldType;
}

export interface PgQuickFind {
  id: string;
  name: string;
  /** id of a saved PublicPgConnection. */
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  fields: PgQuickFindField[];
  /** Page size when running (server clamps to ≤200). */
  limit: number;
}

function isField(v: unknown): v is PgQuickFindField {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return typeof f.label === 'string' && typeof f.column === 'string' && typeof f.type === 'string';
}

function isQuickFind(v: unknown): v is PgQuickFind {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.connectionId === 'string' &&
    typeof p.database === 'string' &&
    typeof p.schema === 'string' &&
    typeof p.table === 'string' &&
    Array.isArray(p.fields) && p.fields.every(isField)
  );
}

export function loadPgQuickFinds(): PgQuickFind[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = readLocal(QUICKFINDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isQuickFind).map((p) => ({ ...p, limit: Number.isInteger(p.limit) && p.limit > 0 ? Math.min(p.limit, 200) : 50 }))
      : [];
  } catch {
    return [];
  }
}

function save(list: PgQuickFind[]): void {
  if (typeof window === 'undefined') return;
  writeLocal(QUICKFINDS_KEY, JSON.stringify(list));
}

function newId(): string {
  return `pqf_${Math.random().toString(36).slice(2, 10)}${(performance.now() | 0).toString(36)}`;
}

export function addPgQuickFind(input: Omit<PgQuickFind, 'id'>): PgQuickFind[] {
  const list = loadPgQuickFinds();
  list.push({ id: newId(), ...input });
  save(list);
  return list;
}

export function updatePgQuickFind(id: string, patch: Omit<PgQuickFind, 'id'>): PgQuickFind[] {
  const list = loadPgQuickFinds().map((p) => (p.id === id ? { ...p, ...patch } : p));
  save(list);
  return list;
}

export function removePgQuickFind(id: string): PgQuickFind[] {
  const list = loadPgQuickFinds().filter((p) => p.id !== id);
  save(list);
  return list;
}
