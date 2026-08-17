// ẨN TÍNH NĂNG KHỎI MENU — danh sách khoá tab người dùng không muốn thấy.
//
// DevBox có hơn 20 tab; mỗi người thường chỉ dùng vài cái. Ẩn bớt cho thanh
// menu gọn lại, bật lại lúc nào cũng được ở bảng "Hiện/ẩn tính năng" (nút ⚙
// trên thanh tiêu đề).
//
// ẨN CHỈ LÀ CHUYỆN GIAO DIỆN. Workspace vẫn mount và chạy y như cũ — cách mount
// trong app/page.tsx dựa trên `visited`, hoàn toàn không liên quan tới danh
// sách này. Cụ thể:
//   · automation/watcher nền vẫn chạy, vẫn bắn cảnh báo;
//   · Workspace + Zalo API vẫn mount từ lúc khởi động để nhận tin;
//   · mail watcher vẫn đếm thư mới.
// Tab bị ẩn mà có thông báo thì chuông trên NotificationCenter vẫn kêu, và mở
// lại tab đó ra là thấy nguyên trạng.
//
// Lưu localStorage (per-máy), chỉ chứa KHOÁ tab — cùng khuôn với ultraView.ts.

const KEY = 'devbox.hiddenTabs';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Mảng rỗng dùng chung cho SSR — trả mới mỗi lần sẽ làm useSyncExternalStore lặp vô hạn. */
const NONE: string[] = [];
let cache: string[] | null = null;

function read(): string[] {
  if (cache) return cache;
  if (typeof window === 'undefined') return NONE;
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    cache = Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && !!k) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: string[]): void {
  cache = [...new Set(next.filter(Boolean))];
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* hết quota — menu vẫn chạy, chỉ là lần sau không nhớ */
  }
  listeners.forEach((l) => l());
}

/** Danh sách khoá đang bị ẩn. */
export function get(): string[] {
  return read();
}

/** Tab này có đang bị ẩn khỏi menu không. */
export function isHidden(key: string): boolean {
  return read().includes(key);
}

/** Ẩn một tab khỏi menu. */
export function hide(key: string): void {
  if (!key) return;
  const cur = read();
  if (cur.includes(key)) return;
  write([...cur, key]);
}

/** Hiện lại một tab. */
export function show(key: string): void {
  const cur = read();
  if (!cur.includes(key)) return;
  write(cur.filter((k) => k !== key));
}

export function toggle(key: string): void {
  if (isHidden(key)) show(key);
  else hide(key);
}

/** Hiện lại toàn bộ — lối thoát khi lỡ ẩn quá tay. */
export function showAll(): void {
  if (read().length === 0) return;
  write([]);
}

// ── Đăng ký theo dõi (useSyncExternalStore) ─────────────────────────────────

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getSnapshot(): string[] {
  return read();
}

export function getServerSnapshot(): string[] {
  return NONE;
}
