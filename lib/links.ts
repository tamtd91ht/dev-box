// Client-side helpers + shared types for the Links tab. All calls go to the
// same-origin /api/links route. Browser-safe module.

export interface SavedLink {
  id: string;
  name: string;
  url: string;
  addedAt: string;
  project?: string;
  description?: string;
  tags?: string[];
  /** Profile session — link cùng profile mở chung partition đăng nhập. */
  profile?: string;
  /** Tài khoản site (optional) — 🔑 tự điền form login trong viewer. */
  username?: string;
  password?: string;
}

export interface SavedLinkMeta {
  name?: string;
  project?: string;
  description?: string;
  tags?: string[];
  profile?: string;
  username?: string;
  password?: string;
}

async function linksAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

export const lList = () => linksAction<SavedLink[]>('list');
export const lAdd = (url: string, meta: SavedLinkMeta = {}) => linksAction<SavedLink[]>('add', { url, ...meta });
export const lUpdate = (id: string, patch: SavedLinkMeta) => linksAction<SavedLink[]>('update', { id, ...patch });
export const lRemove = (id: string) => linksAction<SavedLink[]>('remove', { id });

/** Partition <webview> cho một profile — cùng profile là cùng phiên đăng
 *  nhập (cookie lưu bền trong data/browser/Partitions). Không profile →
 *  session chung mặc định của tab Links. */
export function partitionFor(profile?: string): string {
  const slug = (profile ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `persist:links-${slug}` : 'persist:links-shared';
}
