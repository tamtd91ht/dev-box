// Danh sách TAB VỪA DÙNG cho màn hình "Tiếp cận nhanh" (Ctrl+` / nút 🕘).
//
// Giống khu "vừa xem" của Chrome: mỗi lần đổi tab thì tab đó nhảy lên đầu, kèm
// số lần mở + lần mở gần nhất. Nhờ đó đang xem Kafka → nhảy qua Mail đọc thư →
// quay lại Kafka chỉ bằng một phím, không phải dò lại trên thanh menu dài.
//
// Chỉ lưu KHOÁ tab (vd 'kafka', 'pack:abc') + thời điểm/số lần — không đụng vào
// nội dung đang mở bên trong tab, nên không có gì nhạy cảm. Lưu localStorage
// (per-máy, per-trình duyệt) và phát sự kiện để mọi component cùng cập nhật.

const KEY = 'devbox.recentTabs';
/** Giữ tối đa ngần này mục — quá thì cắt đuôi (cũ nhất rụng trước). */
const MAX = 24;
/** Đổi tab nhanh hơn ngần này thì coi như lướt qua, không ghi nhận. */
const MIN_DWELL_MS = 1200;

export interface RecentTab {
  /** Khoá tab, đúng giá trị `mode` của app: 'kafka' | 'mail' | 'pack:<id>'… */
  key: string;
  /** Lần mở gần nhất (epoch ms). */
  at: number;
  /** Tổng số lần mở — để xếp mục "hay dùng". */
  count: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();

let cache: RecentTab[] | null = null;

function read(): RecentTab[] {
  if (cache) return cache;
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    cache = Array.isArray(list)
      ? list
        .filter((x): x is RecentTab =>
          !!x && typeof (x as RecentTab).key === 'string'
          && Number.isFinite((x as RecentTab).at))
        .map((x) => ({ key: x.key, at: x.at, count: Number(x.count) || 1 }))
        .slice(0, MAX)
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: RecentTab[]): void {
  cache = list.slice(0, MAX);
  try { window.localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* hết quota — bỏ qua */ }
  listeners.forEach((l) => l());
}

/** Danh sách theo thứ tự VỪA DÙNG (mới nhất trước). */
export function list(): RecentTab[] {
  return read();
}

/** Ghi nhận đang mở `key`. Gọi khi tab đã được xem đủ lâu (xem MIN_DWELL_MS). */
export function touch(key: string): void {
  if (!key) return;
  const cur = read();
  const old = cur.find((r) => r.key === key);
  const next: RecentTab = { key, at: Date.now(), count: (old?.count ?? 0) + 1 };
  write([next, ...cur.filter((r) => r.key !== key)]);
}

/** Bỏ một tab khỏi danh sách (nút ✕ trên từng thẻ). */
export function remove(key: string): void {
  write(read().filter((r) => r.key !== key));
}

/** Xoá sạch danh sách. */
export function clear(): void {
  write([]);
}

/** Tab dùng gần đây NHẤT mà không phải `exceptKey` — dùng cho "quay lại tab
 *  trước" (Ctrl+Tab): đang ở Mail thì trả về Kafka. */
export function previous(exceptKey: string): string | null {
  return read().find((r) => r.key !== exceptKey)?.key ?? null;
}

/** Số lần mở, dùng để đánh dấu "hay dùng". */
export function countOf(key: string): number {
  return read().find((r) => r.key === key)?.count ?? 0;
}

// ── Đăng ký theo dõi (useSyncExternalStore) ─────────────────────────────────

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getSnapshot(): RecentTab[] {
  return read();
}

const EMPTY: RecentTab[] = [];
export function getServerSnapshot(): RecentTab[] {
  return EMPTY;
}

export { MIN_DWELL_MS };
