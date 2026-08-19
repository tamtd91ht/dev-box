// Client helpers + types cho tab Browser. Browser-safe.

export type BookmarkKind = 'link' | 'folder';

export interface Bookmark {
  id: string;
  name: string;
  /** Rỗng với folder. */
  url: string;
  kind: BookmarkKind;
  /** undefined = nằm ở gốc cây. */
  parentId?: string;
  /** Thứ tự trong cùng một thư mục, nhỏ hơn đứng trước. */
  order: number;
  profile?: string;
  username?: string;
  password?: string;
  addedAt: string;
}

export type BookmarkMeta = Partial<Omit<Bookmark, 'id' | 'addedAt' | 'kind'>>;

/** Một nút trên cây đã dựng — dùng để vẽ menu thả xuống lồng nhau. */
export interface BmNode extends Bookmark {
  children: BmNode[];
}

/**
 * Dựng cây từ mảng phẳng, sắp theo `order`.
 *
 * Mục có `parentId` trỏ tới thư mục KHÔNG CÒN TỒN TẠI thì đưa về gốc thay vì
 * bỏ đi — dữ liệu lệch (xoá nửa chừng, sửa file tay) không được phép làm dấu
 * trang biến mất khỏi giao diện.
 */
export function bmTree(list: Bookmark[]): BmNode[] {
  const byId = new Map<string, BmNode>();
  for (const b of list) byId.set(b.id, { ...b, children: [] });

  const roots: BmNode[] = [];
  for (const n of byId.values()) {
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent && parent.kind === 'folder' && parent.id !== n.id) parent.children.push(n);
    else roots.push(n);
  }

  const sort = (arr: BmNode[]) => {
    arr.sort((a, b) => a.order - b.order);
    arr.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

async function bmAction(action: string, params: Record<string, unknown> = {}): Promise<Bookmark[]> {
  const r = await fetch('/api/bookmarks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { result: Bookmark[] }).result;
}

export const bmList = () => bmAction('list');
export const bmAdd = (url: string, meta: BookmarkMeta = {}) => bmAction('add', { url, ...meta });
export const bmAddFolder = (name: string, parentId?: string) => bmAction('addFolder', { name, parentId });
export const bmUpdate = (id: string, patch: BookmarkMeta) => bmAction('update', { id, ...patch });
/** Chuyển sang thư mục khác và/hoặc chèn trước `beforeId` (bỏ trống = xuống cuối). */
export const bmMove = (id: string, parentId?: string, beforeId?: string) => bmAction('move', { id, parentId, beforeId });
/** Xoá — với thư mục là xoá cả nhánh bên trong. */
export const bmRemove = (id: string) => bmAction('remove', { id });

/** Scheme mặc định khi người dùng gõ thiếu: máy nội bộ / mạng riêng gần như
 *  không bao giờ có TLS, ép https vào chỉ nhận ERR_SSL_PROTOCOL_ERROR rồi phải
 *  quay ra sửa tay. IP public vẫn giữ https — traffic đó đi qua Internet.
 *  (Chrome/Edge cũng phân biệt đúng như vậy.) */
export function defaultScheme(hostPart: string): 'http' | 'https' {
  const host = hostPart.replace(/:\d+$/, '').toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) return 'http';
  if (host === '::1' || host === '[::1]') return 'http';
  // Host nội bộ không có dấu chấm — "ten-may", "gitlab", "es-01".
  if (!host.includes('.') && !host.includes(':')) return 'http';

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return 'http';                          // loopback
    if (a === 10) return 'http';                           // 10.0.0.0/8
    if (a === 192 && b === 168) return 'http';             // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return 'http';    // 172.16.0.0/12
    if (a === 169 && b === 254) return 'http';             // link-local
    return 'https';                                        // IP public
  }

  // IPv6 unique-local (fc00::/7) và link-local (fe80::/10).
  const v6 = host.replace(/^\[|\]$/g, '');
  if (/^[0-9a-f:]+$/.test(v6) && v6.includes(':')) {
    if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return 'http';
    return 'https';
  }

  return 'https';
}

/** Ô địa chỉ kiểu trình duyệt thật: có scheme → giữ nguyên; TRÔNG NHƯ host
 *  (tên miền, localhost, IP, host:port) → thêm scheme mặc định theo
 *  defaultScheme; còn lại là TỪ KHÓA → tìm Google luôn, không bắt gõ đúng link. */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  const bare = s.replace(/^\/+/, '');
  const hostPart = bare.split(/[/?#]/)[0];
  const looksLikeHost =
    !/\s/.test(s) && (
      /^localhost(:\d+)?$/i.test(hostPart) ||                 // localhost / localhost:3000
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart) ||      // IP / IP:port
      /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(hostPart) || // tên miền có dấu chấm
      /^[a-z0-9-]+:\d+$/i.test(hostPart)                      // host nội bộ dạng ten-may:8080
    );
  if (looksLikeHost) return `${defaultScheme(hostPart)}://${bare}`;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

/** Partition <webview> theo profile — cùng profile là cùng phiên đăng nhập. */
export function bmPartition(profile?: string): string {
  const slug = (profile ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `persist:browser-${slug}` : 'persist:browser-default';
}
