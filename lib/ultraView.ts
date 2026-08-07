// ULTRA VIEW — xem NHIỀU workspace cùng lúc, chia đôi/ba/bốn màn hình.
//
// Bình thường DevBox chỉ cho xem một tab: mọi pane nằm chung một ô lưới, pane
// không được chọn thì bị giấu (xem paneStyle trong app/page.tsx). Ultra View
// giữ nguyên cách mount đó — chỉ đổi chỗ ĐẶT pane: mỗi pane trong danh sách
// chiếm một cột riêng, nên xem Git bên trái trong lúc dòm Kafka bên phải.
//
// Nhờ pane vốn đã "mount một lần rồi giữ mãi", bật/tắt Ultra View KHÔNG dựng
// lại workspace nào: không mất kết nối Redis/Kafka đang mở, không mất kết quả
// truy vấn, không phải đăng nhập lại webview. Chỉ là chuyện bố cục.
//
// Lưu localStorage (per-máy) danh sách khoá pane + trạng thái bật/tắt, y như
// recentTabs — chỉ có KHOÁ tab, không có nội dung gì bên trong.

const KEY = 'devbox.ultraView';

/**
 * Số pane tối đa xem cùng lúc. Trên 4 thì mỗi cột hẹp dưới ~300px ở màn hình
 * thường, các workspace (vốn tự chia layout 2 cột bên trong) vỡ bố cục — chưa
 * kể 4 pane sống cùng lúc đã là nhiều kết nối/poll chạy song song.
 */
export const MAX_PANES = 4;

export interface UltraState {
  /** Đang bật chế độ nhiều pane hay không. */
  on: boolean;
  /** Các khoá tab đang xem, TRÁI → PHẢI. Tối đa MAX_PANES. */
  panes: string[];
}

type Listener = () => void;
const listeners = new Set<Listener>();

const OFF: UltraState = { on: false, panes: [] };
let cache: UltraState | null = null;

function read(): UltraState {
  if (cache) return cache;
  if (typeof window === 'undefined') return OFF;
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<UltraState>) : null;
    const panes = Array.isArray(v?.panes)
      ? v!.panes.filter((k): k is string => typeof k === 'string' && !!k).slice(0, MAX_PANES)
      : [];
    // Bật mà không còn pane nào thì coi như tắt — tránh kẹt ở màn hình trống.
    cache = { on: !!v?.on && panes.length > 0, panes };
  } catch {
    cache = OFF;
  }
  return cache;
}

function write(next: UltraState): void {
  cache = { on: next.on && next.panes.length > 0, panes: next.panes.slice(0, MAX_PANES) };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* hết quota — bố cục vẫn chạy, chỉ là lần sau không nhớ */
  }
  listeners.forEach((l) => l());
}

/** Trạng thái hiện tại. */
export function get(): UltraState {
  return read();
}

/** Pane `key` có đang được xem trong Ultra View không. */
export function has(key: string): boolean {
  const s = read();
  return s.on && s.panes.includes(key);
}

/**
 * Bật Ultra View. `seed` là tab đang mở — vào chế độ nhiều pane thì pane đầu
 * tiên chính là thứ người dùng đang nhìn, không nhảy đi đâu cả.
 */
export function enable(seed?: string): void {
  const s = read();
  const panes = s.panes.length > 0 ? s.panes : seed ? [seed] : [];
  if (panes.length === 0) return; // không có gì để xem
  write({ on: true, panes });
}

/** Tắt Ultra View, quay về xem một tab. Danh sách pane được GIỮ để bật lại. */
export function disable(): void {
  write({ ...read(), on: false });
}

/** Bật/tắt qua lại (nút trên thanh tiêu đề · Ctrl+Shift+U). */
export function toggle(seed?: string): void {
  if (read().on) disable();
  else enable(seed);
}

/**
 * Thêm một tab vào khung nhìn. Đã có rồi thì thôi; đủ MAX_PANES rồi thì thay
 * pane CUỐI (ngoài cùng phải) — chỗ người dùng vừa nhìn tới nhất, đổi ở đó ít
 * phá bố cục đang quen nhất.
 */
export function add(key: string): void {
  if (!key) return;
  const s = read();
  if (s.panes.includes(key)) {
    if (!s.on) write({ on: true, panes: s.panes });
    return;
  }
  const panes = s.panes.length < MAX_PANES
    ? [...s.panes, key]
    : [...s.panes.slice(0, MAX_PANES - 1), key];
  write({ on: true, panes });
}

/** Bỏ một pane khỏi khung nhìn (nút ✕ trên đầu pane). Hết pane → tắt hẳn. */
export function remove(key: string): void {
  const s = read();
  const panes = s.panes.filter((k) => k !== key);
  write({ on: panes.length > 0 && s.on, panes });
}

/** Có/không có `key` trong khung nhìn — dùng cho menu chọn pane. */
export function togglePane(key: string): void {
  if (read().panes.includes(key)) remove(key);
  else add(key);
}

/** Đổi hẳn sang một bộ pane (vd chọn từ bố cục dựng sẵn). */
export function setPanes(keys: string[]): void {
  const panes = keys.filter(Boolean).slice(0, MAX_PANES);
  write({ on: panes.length > 0, panes });
}

/**
 * Đẩy một pane sang trái/phải để sắp lại thứ tự. `dir` là -1 (trái) hoặc 1
 * (phải); chạm mép thì không làm gì.
 */
export function move(key: string, dir: -1 | 1): void {
  const s = read();
  const i = s.panes.indexOf(key);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= s.panes.length) return;
  const panes = [...s.panes];
  [panes[i], panes[j]] = [panes[j], panes[i]];
  write({ ...s, panes });
}

// ── Đăng ký theo dõi (useSyncExternalStore) ─────────────────────────────────

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getSnapshot(): UltraState {
  return read();
}

export function getServerSnapshot(): UltraState {
  return OFF;
}
