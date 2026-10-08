// Biến {{var}} + vài tiện ích thuần cho tab API. Browser-safe, không phụ thuộc gì.
//
//   · Biến động  {{$guid}} {{$timestamp}} …  — sinh mới ở MỖI chỗ xuất hiện
//   · findVarNames   — liệt kê tên biến một chuỗi dùng (để cảnh báo biến chưa có)
//   · splitQuery / joinQuery — bảng Params ⇄ query string của URL
//   · basicAuthValue — giá trị header Authorization: Basic …

import type { ApiAuth, ApiHeader } from './api';

// ── Biến động ─────────────────────────────────────────────────────────────

const rnd = (n: number) => Math.floor(Math.random() * n);

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = rnd(16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'kilo', 'lima', 'nova', 'oscar', 'sierra', 'tango', 'zulu'];

/** Biến động đã biết → hàm sinh giá trị. Dùng chung cho resolveVars và danh sách gợi ý. */
export const DYNAMIC_VARS: Record<string, { desc: string; gen: () => string }> = {
  $guid: { desc: 'UUID v4 ngẫu nhiên', gen: uuid },
  $randomUUID: { desc: 'UUID v4 ngẫu nhiên (như $guid)', gen: uuid },
  $timestamp: { desc: 'Unix timestamp (giây)', gen: () => String(Math.floor(Date.now() / 1000)) },
  $timestampMs: { desc: 'Unix timestamp (mili giây)', gen: () => String(Date.now()) },
  $isoTimestamp: { desc: 'Thời điểm hiện tại, ISO 8601 (UTC)', gen: () => new Date().toISOString() },
  $randomInt: { desc: 'Số nguyên ngẫu nhiên 0–1000', gen: () => String(rnd(1001)) },
  $randomWord: { desc: 'Một từ ngẫu nhiên', gen: () => WORDS[rnd(WORDS.length)] },
  $randomEmail: { desc: 'Email ngẫu nhiên @example.com', gen: () => `${WORDS[rnd(WORDS.length)]}${rnd(10000)}@example.com` },
};

/** Giá trị của biến động, hoặc null nếu `name` không phải biến động đã biết. */
export function dynamicVar(name: string): string | null {
  return DYNAMIC_VARS[name]?.gen() ?? null;
}

const VAR_RE = /\{\{\s*(\$?[\w.-]+)\s*\}\}/g;

/** Thay {{tên}} bằng giá trị trong `env`, hoặc biến động. Biến lạ giữ nguyên chữ. */
export function resolveVars(text: string, env: Record<string, string>): string {
  return text.replace(VAR_RE, (m, name: string) => {
    if (name in env) return env[name];
    return dynamicVar(name) ?? m;
  });
}

/** Tên các biến (KHÔNG tính biến động) mà các chuỗi này dùng. */
export function findVarNames(...texts: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(VAR_RE)) if (!m[1].startsWith('$')) out.add(m[1]);
  }
  return [...out];
}

// ── Params ⇄ URL ──────────────────────────────────────────────────────────
//
// Không encode/decode: giữ NGUYÊN chữ người dùng gõ. Decode rồi encode lại sẽ
// đổi `{{token}}` thành `%7B%7Btoken%7D%7D` và làm hỏng biến; giữ nguyên thì URL
// ra đúng như trong ô URL, việc encode (nếu cần) là của người gõ.

export interface SplitUrl { base: string; hash: string; rows: ApiHeader[] }

/** Tách URL thành phần trước `?`, fragment, và các cặp key=value của query. */
export function splitQuery(url: string): SplitUrl {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = noHash.indexOf('?');
  if (q < 0) return { base: noHash, hash, rows: [] };
  const rows: ApiHeader[] = [];
  for (const part of noHash.slice(q + 1).split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    rows.push(eq < 0 ? { key: part, value: '', on: true } : { key: part.slice(0, eq), value: part.slice(eq + 1), on: true });
  }
  return { base: noHash.slice(0, q), hash, rows };
}

/** Ghép lại URL từ phần gốc + các dòng đang BẬT và có key. */
export function joinQuery(base: string, rows: ApiHeader[], hash = ''): string {
  const qs = rows
    .filter((r) => r.on !== false && r.key.trim() !== '')
    .map((r) => (r.value === '' && !r.key.includes('=') ? `${r.key}=` : `${r.key}=${r.value}`))
    .join('&');
  return base + (qs ? `?${qs}` : '') + hash;
}

/** Thêm một cặp vào query của URL (API key đặt ở query). Có sẵn cùng tên thì thay. */
export function setQueryParam(url: string, key: string, value: string): string {
  const s = splitQuery(url);
  const rows = s.rows.filter((r) => r.key !== key);
  rows.push({ key: encodeURIComponent(key), value: encodeURIComponent(value), on: true });
  return joinQuery(s.base, rows, s.hash);
}

// ── Auth ──────────────────────────────────────────────────────────────────

/** `Basic base64(user:pass)` — qua UTF-8 để tên/mật khẩu có dấu không làm btoa ném lỗi. */
export function basicAuthValue(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/**
 * Áp tab Auth vào request ĐÃ resolve biến: trả URL + headers mới.
 *
 * Header cùng tên đã có sẵn (đang bật, từ tab Headers) thắng — người dùng gõ tay
 * thì ý họ rõ hơn cấu hình tự động. API key đặt ở query thì ghép vào URL.
 */
export function applyAuth(
  url: string,
  headers: ApiHeader[],
  auth: ApiAuth | undefined,
  env: Record<string, string>,
): { url: string; headers: ApiHeader[] } {
  if (!auth || auth.type === 'none') return { url, headers };
  const r = (t: string | undefined) => resolveVars(t ?? '', env);
  const has = (name: string) => headers.some((h) => h.key.trim().toLowerCase() === name.toLowerCase());
  const out = [...headers];
  if (auth.type === 'bearer') {
    const token = r(auth.token).trim();
    if (token && !has('authorization')) out.push({ key: 'Authorization', value: `Bearer ${token}` });
  } else if (auth.type === 'basic') {
    if ((auth.user || auth.pass) && !has('authorization')) {
      out.push({ key: 'Authorization', value: basicAuthValue(r(auth.user), r(auth.pass)) });
    }
  } else if (auth.type === 'apikey') {
    const name = r(auth.keyName).trim();
    if (name) {
      if (auth.keyIn === 'query') return { url: setQueryParam(url, name, r(auth.keyValue)), headers: out };
      if (!has(name)) out.push({ key: name, value: r(auth.keyValue) });
    }
  }
  return { url, headers: out };
}
