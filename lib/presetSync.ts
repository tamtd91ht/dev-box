// Đồng bộ preset ("nút tìm nhanh") giữa localStorage và configs/presets.json.
//
// BÀI TOÁN: năm module preset (redis/kafka/mongo/es/pg) đều có API ĐỒNG BỘ
// `loadX(): X[]` và được gọi thẳng trong `useEffect` của component. Server thì
// chỉ đọc được qua fetch — bất đồng bộ. Viết lại cả năm module + năm component
// sang async là một đợt sửa rộng, dễ làm hỏng chỗ đang chạy tốt.
//
// CÁCH LÀM: giữ localStorage làm CACHE ĐỒNG BỘ, còn configs/presets.json là
// nguồn thật:
//   · lúc app khởi động, `hydratePresets()` kéo từ server về ghi vào
//     localStorage, rồi phát event để component đang mở nạp lại
//   · mọi lần ghi (`writeLocal`) vẫn ghi localStorage như cũ, và đẩy lên server
//   · máy chưa có gì trên server thì SEED bằng localStorage đang có, nên preset
//     người dùng đã dựng từ trước không mất khi nâng cấp
//
// Nhờ vậy `loadX()` vẫn đồng bộ, component không phải đổi, mà dữ liệu đã nằm
// trong configs/ để configSync đẩy lên git.

import { useEffect } from 'react';

import { readLocal, writeLocal } from './localKeys';

/** Các nhóm preset — trùng đúng khoá localStorage (không có tiền tố devbox.). */
export const PRESET_KINDS = [
  'redis.quickfinds',
  'kafka.presets',
  'mongo.quickfinds',
  'es.quickfinds',
  'pg.quickfinds',
] as const;

export type PresetKind = typeof PRESET_KINDS[number];

const isKind = (k: string): k is PresetKind => (PRESET_KINDS as readonly string[]).includes(k);

/** Component nghe event này để nạp lại sau khi server trả dữ liệu về. */
export const PRESETS_EVENT = 'devbox:presets-changed';

function emit(kind: PresetKind): void {
  try { window.dispatchEvent(new CustomEvent(PRESETS_EVENT, { detail: { kind } })); }
  catch { /* môi trường không có CustomEvent — bỏ qua */ }
}

/**
 * Đẩy một nhóm lên server. Gọi sau mỗi lần ghi localStorage.
 *
 * Cố ý KHÔNG await ở phía gọi: lưu preset phải phản hồi tức thì (localStorage đã
 * ghi xong), còn việc lên đĩa chậm hơn cũng không sao. Lỗi mạng chỉ log — mất
 * đồng bộ một lần đỡ hơn là chặn giao diện.
 */
export function pushPresets(kind: PresetKind, list: unknown[]): void {
  if (typeof window === 'undefined') return;
  void fetch('/api/presets', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, list }),
  }).catch(() => { /* offline / server chưa lên — lần ghi sau thử lại */ });
}

/**
 * Kéo toàn bộ preset từ server về localStorage, một lần lúc app khởi động.
 *
 * Nhóm nào server còn trống mà localStorage đang có → SEED lên server. Đây là
 * đường nâng cấp cho người đã dùng app từ trước: dữ liệu của họ đang ở
 * localStorage, không seed thì lần dọn cache tới là mất.
 */
export async function hydratePresets(): Promise<void> {
  if (typeof window === 'undefined') return;
  let store: Record<string, unknown[]>;
  try {
    const r = await fetch('/api/presets');
    const d = await r.json() as { ok?: boolean; result?: Record<string, unknown[]> };
    if (!r.ok || d.ok === false || !d.result) return;
    store = d.result;
  } catch {
    return; // server chưa lên — cứ dùng localStorage, lần sau đồng bộ
  }

  for (const kind of PRESET_KINDS) {
    const remote = Array.isArray(store[kind]) ? store[kind] : [];
    if (remote.length > 0) {
      // Server có dữ liệu → nó là nguồn thật, ghi xuống cache.
      writeLocal(kind, JSON.stringify(remote));
      emit(kind);
      continue;
    }
    // Server trống → seed bằng những gì máy này đang giữ.
    let local: unknown[] = [];
    try {
      const raw = readLocal(kind);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) local = parsed;
    } catch { /* cache hỏng — coi như trống */ }
    if (local.length === 0) continue;
    try {
      await fetch('/api/presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, list: local }),
      });
    } catch { /* thử lại lần khởi động sau */ }
  }
}

/** Dùng trong module preset: ghi cache RỒI đẩy lên server. */
export function persistPresets(kind: string, list: unknown[]): void {
  writeLocal(kind, JSON.stringify(list));
  if (isKind(kind)) pushPresets(kind, list);
}

/**
 * Nạp lại một nhóm preset khi hydrate xong.
 *
 * `loadX()` đọc localStorage một lần lúc mount, mà lúc đó fetch về server có thể
 * CHƯA xong — component sẽ hiện danh sách rỗng rồi đứng im dù dữ liệu đã về.
 * Hook này nghe event của hydratePresets và gọi lại `reload`.
 */
export function usePresetSync(kind: PresetKind, reload: () => void): void {
  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<{ kind?: string }>).detail;
      if (!d?.kind || d.kind === kind) reload();
    };
    window.addEventListener(PRESETS_EVENT, onChange);
    return () => window.removeEventListener(PRESETS_EVENT, onChange);
  }, [kind, reload]);
}
