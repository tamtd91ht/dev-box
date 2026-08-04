'use client';

// Trung tâm thông báo của app shell — client-only, lưu localStorage.
//
// Mô hình "hòm thư": mỗi thông báo GẮN VỚI MỘT TAB đích (vd 'git'). Tab đó hiện
// badge đỏ với số chưa đọc (như thư đến); mở đúng tab — hoặc mở panel chuông —
// là đã đọc. Lịch sử giữ lại để xem sau, tự dọn sau 2 ngày, có nút xóa tất cả.
//
// Lưu LOCAL trên thiết bị (localStorage) theo yêu cầu: không đồng bộ server,
// mỗi máy một hòm riêng. Store viết theo giao thức useSyncExternalStore
// (subscribe/getSnapshot) để page.tsx render badge rẻ.

export type NoticeLevel = 'info' | 'warn' | 'urgent';

export interface AppNotice {
  id: string;
  /** Tab đích trong shell ('git', 'kafka', …) — nơi hiện badge đỏ. */
  tab: string;
  level: NoticeLevel;
  title: string;
  body: string;
  /** Nguồn phát (vd 'git auto-pull') — hiện ở dòng meta. */
  source: string;
  at: number;
  read: boolean;
}

export interface NoticeSnapshot {
  /** Mới nhất trước. */
  notices: AppNotice[];
  /** Số CHƯA ĐỌC theo tab — page.tsx vẽ badge từ đây. */
  unreadByTab: Record<string, number>;
  unreadTotal: number;
}

const STORAGE_KEY = 'devbox.notices.v1';
/** Giữ tối đa 2 ngày. */
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
/** Chặn phình localStorage khi một nguồn lỗi lặp liên tục. */
const MAX_COUNT = 300;

const EMPTY: NoticeSnapshot = { notices: [], unreadByTab: {}, unreadTotal: 0 };

class NoticeStore {
  private list: AppNotice[] = [];
  private snap: NoticeSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private loaded = false;

  // ── persistence ──────────────────────────────────────────────────────────

  private loadOnce(): void {
    if (this.loaded || typeof window === 'undefined') return;
    this.loaded = true;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as AppNotice[]) : [];
      this.list = Array.isArray(parsed)
        ? parsed.filter((n) => n && typeof n.id === 'string' && typeof n.at === 'number')
        : [];
    } catch {
      this.list = [];
    }
    this.prune();
    this.rebuild();
  }

  private persist(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.list));
    } catch {
      /* localStorage đầy/không khả dụng — thông báo vẫn sống trong phiên này */
    }
  }

  /** Bỏ thông báo quá 2 ngày + cắt bớt khi vượt trần số lượng. */
  private prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    this.list = this.list.filter((n) => n.at >= cutoff).slice(0, MAX_COUNT);
  }

  private rebuild(): void {
    const unreadByTab: Record<string, number> = {};
    let total = 0;
    for (const n of this.list) {
      if (n.read) continue;
      unreadByTab[n.tab] = (unreadByTab[n.tab] ?? 0) + 1;
      total += 1;
    }
    this.snap = { notices: this.list, unreadByTab, unreadTotal: total };
    for (const l of this.listeners) l();
  }

  // ── useSyncExternalStore plumbing ────────────────────────────────────────

  subscribe = (l: () => void): (() => void) => {
    this.loadOnce();
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): NoticeSnapshot => {
    this.loadOnce();
    return this.snap;
  };

  /** SSR không có localStorage — render hòm rỗng, client hydrate lại. */
  getServerSnapshot = (): NoticeSnapshot => EMPTY;

  // ── mutations ────────────────────────────────────────────────────────────

  add(n: { tab: string; level: NoticeLevel; title: string; body: string; source: string }): void {
    this.loadOnce();
    this.list = [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...n,
        at: Date.now(),
        read: false,
      },
      ...this.list,
    ];
    this.prune();
    this.persist();
    this.rebuild();
  }

  /** Người dùng mở đúng tab đích → thư của tab đó thành đã đọc. */
  markTabRead(tab: string): void {
    this.loadOnce();
    if (!this.list.some((n) => n.tab === tab && !n.read)) return;
    this.list = this.list.map((n) => (n.tab === tab && !n.read ? { ...n, read: true } : n));
    this.persist();
    this.rebuild();
  }

  /** Mở panel chuông = đã xem tất cả (badge tắt, lịch sử vẫn còn). */
  markAllRead(): void {
    this.loadOnce();
    if (!this.list.some((n) => !n.read)) return;
    this.list = this.list.map((n) => (n.read ? n : { ...n, read: true }));
    this.persist();
    this.rebuild();
  }

  clearAll(): void {
    this.loadOnce();
    if (!this.list.length) return;
    this.list = [];
    this.persist();
    this.rebuild();
  }
}

export const notices = new NoticeStore();
