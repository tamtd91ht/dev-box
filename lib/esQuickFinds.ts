// Quick-find presets for the Elasticsearch workspace — same model as the Mongo
// tab (lib/mongoQuickFinds): a named button bookmarks (connection, index) plus
// a curated list of queryable fields; running it builds a bool.filter query
// with one clause per ticked field (implicit AND).
//
// Field types map to ES query clauses:
//   keyword → term  (exact match — IDs, codes, keyword fields)
//   text    → match (analyzed full-text fields)
//   number  → term  (numeric equality)
//   boolean → term  (true/false)
// List mode ("quidn,tamtd") → `terms` for keyword/number/boolean, and a
// bool.should of `match` (minimum_should_match: 1) for text.
//
// Presets live in localStorage. Browser-only module.

const QUICKFINDS_KEY = 'omicx.es.quickfinds';

export type EsQuickFieldType = 'keyword' | 'text' | 'number' | 'boolean';

export const ES_QUICK_FIELD_TYPES: { value: EsQuickFieldType; label: string }[] = [
  { value: 'keyword', label: 'Exact (term)' },
  { value: 'text', label: 'Text (match)' },
  { value: 'number', label: 'Số' },
  { value: 'boolean', label: 'Boolean' },
];

export interface EsQuickFindField {
  /** Display name, e.g. "Tenant". */
  label: string;
  /** ES field path, e.g. "tenantId", "profile.phone.keyword". */
  path: string;
  type: EsQuickFieldType;
}

export interface EsQuickFind {
  id: string;
  name: string;
  /** id of a saved PublicEsConnection. */
  connectionId: string;
  index: string;
  fields: EsQuickFindField[];
  /** Page size when running (server clamps to ≤200). */
  limit: number;
}

function isField(v: unknown): v is EsQuickFindField {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return typeof f.label === 'string' && typeof f.path === 'string' && typeof f.type === 'string';
}

function isQuickFind(v: unknown): v is EsQuickFind {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.connectionId === 'string' &&
    typeof p.index === 'string' &&
    Array.isArray(p.fields) && p.fields.every(isField)
  );
}

export function loadEsQuickFinds(): EsQuickFind[] {
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

function save(list: EsQuickFind[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(QUICKFINDS_KEY, JSON.stringify(list));
}

function newId(): string {
  return `eqf_${Math.random().toString(36).slice(2, 10)}${(performance.now() | 0).toString(36)}`;
}

export function addEsQuickFind(input: Omit<EsQuickFind, 'id'>): EsQuickFind[] {
  const list = loadEsQuickFinds();
  list.push({ id: newId(), ...input });
  save(list);
  return list;
}

export function updateEsQuickFind(id: string, patch: Omit<EsQuickFind, 'id'>): EsQuickFind[] {
  const list = loadEsQuickFinds().map((p) => (p.id === id ? { ...p, ...patch } : p));
  save(list);
  return list;
}

export function removeEsQuickFind(id: string): EsQuickFind[] {
  const list = loadEsQuickFinds().filter((p) => p.id !== id);
  save(list);
  return list;
}

// ── Run-time query builder ────────────────────────────────────────────────────

export interface EsQuickFilterEntry {
  path: string;
  type: EsQuickFieldType;
  value: string;
  /** true = comma-separated list → terms / bool.should. */
  list?: boolean;
}

function convertOne(path: string, type: EsQuickFieldType, raw: string): string | number | boolean {
  switch (type) {
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
 * Build the ES query JSON string: `{bool: {filter: [clause per field]}}`.
 * Throws a per-field Error on unconvertible values.
 */
export function buildEsQuickQuery(entries: EsQuickFilterEntry[]): string {
  const filters: Record<string, unknown>[] = [];
  for (const e of entries) {
    const path = e.path.trim();
    if (!path) continue;
    if (e.list) {
      const parts = e.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) throw new Error(`"${path}": list rỗng — nhập các giá trị cách nhau dấu phẩy`);
      if (e.type === 'text') {
        filters.push({
          bool: { should: parts.map((p) => ({ match: { [path]: p } })), minimum_should_match: 1 },
        });
      } else {
        filters.push({ terms: { [path]: parts.map((p) => convertOne(path, e.type, p)) } });
      }
    } else {
      const v = convertOne(path, e.type, e.value.trim());
      filters.push(e.type === 'text' ? { match: { [path]: v } } : { term: { [path]: v } });
    }
  }
  if (filters.length === 0) throw new Error('Chưa có điều kiện nào — tích ít nhất 1 field và điền giá trị.');
  return JSON.stringify({ bool: { filter: filters } });
}
