// Tìm nhanh cho tab Redis — đặt tên cho một phép tra key hay dùng lại.
//
// Một preset ghim: (tên, mô tả, kết nối Redis, DB index, MẪU KEY). Mẫu key là
// phần cốt lõi: nó chứa biến dạng `{{tên}}` mà lúc chạy mới điền, ví dụ
//
//     callbot_listen:{{domain}}:{{ip}}
//
// → lúc bấm nút, form hỏi `domain` và `ip`, điền xong ghép thành key thật rồi
// tra. Mẫu KHÔNG có biến nào (`session:global`) thì dùng nguyên văn, không hỏi
// gì — cùng một cơ chế, khỏi phải có hai loại preset.
//
// Vì sao là biến chứ không phải để người dùng tự gõ cả key: key Redis trong
// thực tế dài và có tiền tố cố định (`callbot_listen:`), gõ tay mỗi lần là dễ
// sai chính tả ở đúng phần không bao giờ đổi. Ghim phần cố định, hỏi phần thay
// đổi — đó là toàn bộ giá trị của tính năng này.
//
// Preset là bookmark cá nhân của từng máy nên nằm ở localStorage (khác với
// connection do server giữ). Module chỉ chạy phía browser.

import { readLocal } from './localKeys';
import { persistPresets } from './presetSync';

const QUICKFINDS_KEY = 'redis.quickfinds';

// Cú pháp biến trong mẫu key: `{{tên}}`. Tên nhận chữ, số, `_`, `-`, `.`.
// Mỗi chỗ dùng TỰ TẠO regex mới thay vì chia sẻ một hằng số: regex có flag `g`
// mang theo `lastIndex`, dùng chung giữa matchAll/replace/test là kiểu bug mà
// lần chạy thứ hai mới sai.
const VAR_SRC = '\\{\\{\\s*([A-Za-z0-9_.\\-]+)\\s*\\}\\}';
const varRe = () => new RegExp(VAR_SRC, 'g');

export interface RedisQuickFind {
  id: string;
  /** Tên chức năng, vd "Callbot đang lắng nghe". */
  name: string;
  /** Mô tả ngắn — preset này tra cái gì. */
  description?: string;
  /** id của một PublicRedisConnection đã lưu. */
  connectionId: string;
  /** DB index 0–15. Cluster luôn chỉ có DB 0. */
  db: number;
  /** Mẫu key, có thể chứa `{{biến}}` — vd `callbot_listen:{{domain}}:{{ip}}`. */
  keyPattern: string;
}

/**
 * Rút danh sách tên biến trong mẫu, theo THỨ TỰ xuất hiện và không trùng lặp.
 * Biến lặp lại (`{{id}}:{{id}}`) chỉ hỏi một lần rồi điền vào mọi chỗ.
 */
export function extractVars(pattern: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of pattern.matchAll(varRe())) {
    const name = m[1];
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/**
 * Thay biến trong mẫu bằng giá trị người dùng nhập.
 * Biến thiếu giá trị được giữ NGUYÊN VĂN (`{{domain}}`) chứ không xoá thành
 * rỗng — key sai còn nhìn ra được là thiếu chỗ nào, chứ `callbot_listen::1.2.3.4`
 * thì không ai đoán được.
 */
export function fillPattern(pattern: string, values: Record<string, string>): string {
  return pattern.replace(varRe(), (whole, name: string) => {
    const v = values[name];
    return v !== undefined && v !== '' ? v : whole;
  });
}

/** Mẫu đã điền còn sót biến nào chưa? Dùng để chặn chạy khi thiếu dữ liệu. */
export function hasUnfilledVars(filled: string): boolean {
  return varRe().test(filled);
}

function isQuickFind(v: unknown): v is RedisQuickFind {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.connectionId === 'string' &&
    typeof p.keyPattern === 'string' &&
    (p.description === undefined || typeof p.description === 'string')
  );
}

/** DB index hợp lệ 0–15; ngoài khoảng hoặc không phải số → 0. */
function normDb(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 15 ? n : 0;
}

export function loadRedisQuickFinds(): RedisQuickFind[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = readLocal(QUICKFINDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isQuickFind).map((p) => ({ ...p, db: normDb(p.db) }))
      : [];
  } catch {
    return [];
  }
}

function save(list: RedisQuickFind[]): void {
  if (typeof window === 'undefined') return;
  // Ghi cache localStorage RỒI đẩy lên configs/presets.json — preset là
  // dữ liệu người dùng tự dựng, phải sống sót qua dọn cache và đẩy được
  // lên git như mọi config khác.
  persistPresets(QUICKFINDS_KEY, list);
}

function newId(): string {
  return `rqf_${Math.random().toString(36).slice(2, 10)}${(performance.now() | 0).toString(36)}`;
}

export function addRedisQuickFind(input: Omit<RedisQuickFind, 'id'>): RedisQuickFind[] {
  const list = loadRedisQuickFinds();
  list.push({ id: newId(), ...input, db: normDb(input.db) });
  save(list);
  return list;
}

export function updateRedisQuickFind(id: string, patch: Omit<RedisQuickFind, 'id'>): RedisQuickFind[] {
  const list = loadRedisQuickFinds().map(
    (p) => (p.id === id ? { ...p, ...patch, db: normDb(patch.db) } : p),
  );
  save(list);
  return list;
}

export function removeRedisQuickFind(id: string): RedisQuickFind[] {
  const list = loadRedisQuickFinds().filter((p) => p.id !== id);
  save(list);
  return list;
}
