// Store phía SERVER cho các "nút tìm nhanh" (preset) của Redis, Kafka, Mongo,
// Elasticsearch, PostgreSQL.
//
// VÌ SAO CHUYỂN KHỎI localStorage: preset là thứ người dùng tự tay dựng — đặt
// tên, chọn connection, khai báo mẫu key/field. Nằm ở localStorage thì:
//   · dọn cache trình duyệt là mất sạch (đã xảy ra)
//   · mỗi máy một bản, không chia sẻ được cho đồng nghiệp
//   · không đẩy lên git như các cấu hình khác trong configs/
//
// Giờ nằm ở configs/presets.json, nên configSync (lib/configSync.ts) tự động
// đẩy lên repo dev-box-config cùng các file config khác — nó quét cả thư mục
// configs/*.json chứ không liệt kê từng file.
//
// KHÔNG chứa secret: preset chỉ giữ `connectionId` trỏ tới connection đã lưu,
// còn host/user/password nằm ở store connection riêng. Nên đẩy lên git an toàn.

import { promises as fs } from 'fs';
import { configPath } from './configDir';

/** Các nhóm preset. Trùng với tiền tố khoá localStorage cũ để migrate 1-1. */
export type PresetKind =
  | 'redis.quickfinds'
  | 'kafka.presets'
  | 'mongo.quickfinds'
  | 'es.quickfinds'
  | 'pg.quickfinds';

const KINDS: PresetKind[] = [
  'redis.quickfinds',
  'kafka.presets',
  'mongo.quickfinds',
  'es.quickfinds',
  'pg.quickfinds',
];

export function isPresetKind(v: unknown): v is PresetKind {
  return typeof v === 'string' && (KINDS as string[]).includes(v);
}

/** Mỗi nhóm là một mảng preset. Giữ `unknown[]` ở tầng này: hình dạng từng
 *  preset do module của tab đó tự kiểm (isQuickFind…), store không cần biết —
 *  thêm field mới ở tab không phải sửa store. */
type Store = Partial<Record<PresetKind, unknown[]>>;

const FILE = configPath('presets.json');

async function readAll(): Promise<Store> {
  try {
    const d = JSON.parse(await fs.readFile(FILE, 'utf8')) as Store;
    if (!d || typeof d !== 'object') return {};
    // Lọc nhóm lạ và giá trị không phải mảng — file sửa tay vẫn không làm sập.
    const out: Store = {};
    for (const k of KINDS) if (Array.isArray(d[k])) out[k] = d[k];
    return out;
  } catch {
    return {};
  }
}

async function writeAll(store: Store): Promise<void> {
  await fs.writeFile(FILE, JSON.stringify(store, null, 2), 'utf8');
}

export async function listPresets(kind: PresetKind): Promise<unknown[]> {
  return (await readAll())[kind] ?? [];
}

export async function listAllPresets(): Promise<Store> {
  return readAll();
}

/** Ghi đè cả nhóm. Client giữ toàn bộ mảng nên thay trọn gói là đủ, và tránh
 *  hẳn chuyện merge từng phần tử bị lệch thứ tự. */
export async function savePresets(kind: PresetKind, list: unknown[]): Promise<unknown[]> {
  const store = await readAll();
  store[kind] = Array.isArray(list) ? list : [];
  await writeAll(store);
  return store[kind]!;
}

/**
 * Nhận dữ liệu cũ từ localStorage của client.
 *
 * CHỈ ghi khi nhóm đó trên server đang TRỐNG — người dùng có thể mở app ở nhiều
 * máy, máy nào cũng gửi bản localStorage của mình lên; không có điều kiện này
 * thì máy mở sau sẽ ghi đè preset mà máy trước vừa đồng bộ về.
 */
export async function seedPresets(kind: PresetKind, list: unknown[]): Promise<{ seeded: boolean; list: unknown[] }> {
  const store = await readAll();
  const cur = store[kind];
  if (Array.isArray(cur) && cur.length > 0) return { seeded: false, list: cur };
  if (!Array.isArray(list) || list.length === 0) return { seeded: false, list: cur ?? [] };
  store[kind] = list;
  await writeAll(store);
  return { seeded: true, list };
}
