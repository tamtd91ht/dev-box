// Client-side helpers + shared types for the Google tab. All calls go to the
// same-origin /api/google route (the Next server holds the OAuth tokens — the
// browser never sees them). Browser-safe module.

export interface GoogleAccount {
  id: string;
  email?: string;
}

export interface GoogleStatus {
  configured: boolean;
  /** Mọi tài khoản đã đăng nhập trên máy này (multi-account). */
  accounts: GoogleAccount[];
  redirectUri: string;
}

export interface GFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  starred?: boolean;
  owners?: { displayName?: string; emailAddress?: string }[];
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

export interface GList {
  files: GFile[];
  nextPageToken?: string;
}

export interface GRoot {
  id: string;
  accountId: string;
  name: string;
  folderId: string;
  url: string;
}

async function googleAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    const err = new Error((data as { error?: string }).error || `HTTP ${r.status}`);
    (err as Error & { status?: number }).status = r.status;
    throw err;
  }
  return (data as { result: T }).result;
}

export const gStatus = () => googleAction<GoogleStatus>('status');
export const gAuthUrl = () => googleAction<{ url: string }>('authUrl');
export const gLogout = (accountId: string) => googleAction<{ done: boolean }>('logout', { accountId });
export const gRoots = (accountId: string) => googleAction<GRoot[]>('roots', { accountId });
export const gRootAdd = (accountId: string, url: string, name?: string) =>
  googleAction<GRoot[]>('rootAdd', { accountId, url, name });
export const gRootRemove = (id: string) => googleAction<GRoot[]>('rootRemove', { id });
export const gBrowse = (accountId: string, folderId: string) => googleAction<GList>('browse', { accountId, folderId });
export const gList = (
  accountId: string,
  kind: 'docs' | 'sheets',
  opts: { q?: string; starred?: boolean; pageToken?: string } = {},
) => googleAction<GList>('list', { accountId, kind, ...opts });

export const G_MIME = {
  folder: 'application/vnd.google-apps.folder',
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
  shortcut: 'application/vnd.google-apps.shortcut',
} as const;

export function mimeIcon(mime: string): string {
  switch (mime) {
    case G_MIME.folder: return '📁';
    case G_MIME.doc: return '📝';
    case G_MIME.sheet: return '📊';
    case G_MIME.slides: return '📽️';
    case G_MIME.shortcut: return '↪️';
    case 'application/pdf': return '📕';
    default:
      if (mime.startsWith('image/')) return '🖼️';
      if (mime.startsWith('video/')) return '🎬';
      return '🗎';
  }
}

/** Relative Vietnamese timestamp: vừa xong · 5 phút trước · 3 ngày trước · dd/mm/yyyy. */
export function fmtRel(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} ngày trước`;
  return new Date(t).toLocaleDateString('vi-VN');
}
