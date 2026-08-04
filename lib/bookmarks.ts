// Client helpers + types cho tab Browser. Browser-safe.

export interface Bookmark {
  id: string;
  name: string;
  url: string;
  profile?: string;
  username?: string;
  password?: string;
  addedAt: string;
}

export type BookmarkMeta = Partial<Omit<Bookmark, 'id' | 'addedAt'>>;

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
export const bmUpdate = (id: string, patch: BookmarkMeta) => bmAction('update', { id, ...patch });
export const bmRemove = (id: string) => bmAction('remove', { id });

/** Ô địa chỉ kiểu trình duyệt thật: có scheme → giữ nguyên; TRÔNG NHƯ host
 *  (tên miền, localhost, IP, host:port) → thêm https://; còn lại là TỪ KHÓA
 *  → tìm Google luôn, không bắt gõ đúng link. */
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
  if (looksLikeHost) return 'https://' + bare;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

/** Partition <webview> theo profile — cùng profile là cùng phiên đăng nhập. */
export function bmPartition(profile?: string): string {
  const slug = (profile ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `persist:browser-${slug}` : 'persist:browser-default';
}
