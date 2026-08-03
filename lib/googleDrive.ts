// Server-only Google Drive REST v3 client for the Google tab. No SDK — the
// calls we need are plain GETs with a bearer token (googleapis would add
// ~30 MB of deps for this). Read-only by scope AND by code: only files.list /
// files.get / files.export are ever called.
//
// downloadContent/exportContent phục vụ API-PREVIEW: file private không mở
// được trong <webview> (Google chặn đăng nhập embedded browser) → tải nội
// dung qua API rồi hiển thị ngay trong app; sửa thì mở browser ngoài.

import { getAccessToken } from './googleAuth';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  starred?: boolean;
  owners?: { displayName?: string; emailAddress?: string }[];
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

export interface DriveList {
  files: DriveFile[];
  nextPageToken?: string;
}

export const MIME = {
  folder: 'application/vnd.google-apps.folder',
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
} as const;

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,starred,owners(displayName,emailAddress),shortcutDetails';

async function driveGet<T>(accountId: string, pathname: string, params: Record<string, string>): Promise<T> {
  const token = await getAccessToken(accountId);
  const u = new URL(`https://www.googleapis.com/drive/v3/${pathname}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
  const data = (await r.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!r.ok) {
    const msg = data.error?.message ?? `HTTP ${r.status}`;
    if (r.status === 401) throw new Error(`Google từ chối token (${msg}) — thử Đăng xuất rồi đăng nhập lại.`);
    throw new Error(`Google Drive API: ${msg}`);
  }
  return data;
}

/** Escape a value embedded in a Drive q string ('…'). */
const qEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const COMMON_LIST_PARAMS = {
  supportsAllDrives: 'true',
  includeItemsFromAllDrives: 'true',
  corpora: 'allDrives', // My Drive + mọi Shared Drive — techlead thấy hết một chỗ
};

/** One folder level: sub-folders first (A→Z), then files (mới sửa trước). */
export async function browseFolder(accountId: string, folderId: string): Promise<DriveList> {
  const data = await driveGet<DriveList>(accountId, 'files', {
    ...COMMON_LIST_PARAMS,
    q: `'${qEsc(folderId)}' in parents and trashed=false`,
    orderBy: 'folder,modifiedTime desc',
    pageSize: '200',
    fields: `nextPageToken,files(${FILE_FIELDS})`,
  });
  return data;
}

export interface ListOptions {
  kind: 'docs' | 'sheets';
  /** Substring search on the file name. */
  q?: string;
  /** Only ⭐ starred files. */
  starred?: boolean;
  pageToken?: string;
}

/** Global Docs/Sheets listing for ONE account, newest-modified first. */
export async function listByKind(accountId: string, opts: ListOptions): Promise<DriveList> {
  const mime = opts.kind === 'docs' ? MIME.doc : MIME.sheet;
  const clauses = [`mimeType='${mime}'`, 'trashed=false'];
  if (opts.q && opts.q.trim()) clauses.push(`name contains '${qEsc(opts.q.trim())}'`);
  if (opts.starred) clauses.push('starred=true');
  const params: Record<string, string> = {
    ...COMMON_LIST_PARAMS,
    q: clauses.join(' and '),
    orderBy: 'modifiedTime desc',
    pageSize: '40',
    fields: `nextPageToken,files(${FILE_FIELDS})`,
  };
  if (opts.pageToken) params.pageToken = opts.pageToken;
  return driveGet<DriveList>(accountId, 'files', params);
}

/** files.get — used to validate a pasted folder link and fetch its name. */
export async function getFile(accountId: string, id: string): Promise<DriveFile> {
  return driveGet<DriveFile>(accountId, `files/${encodeURIComponent(id)}`, {
    supportsAllDrives: 'true',
    fields: FILE_FIELDS,
  });
}

/** Trần dung lượng preview — quá cỡ này thì bảo người dùng mở browser. */
const MAX_CONTENT = 30 * 1024 * 1024;

async function driveGetBinary(
  accountId: string,
  pathname: string,
  params: Record<string, string>,
): Promise<{ buf: Buffer; contentType: string }> {
  const token = await getAccessToken(accountId);
  const u = new URL(`https://www.googleapis.com/drive/v3/${pathname}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    const msg = data.error?.message ?? `HTTP ${r.status}`;
    if (r.status === 401) throw new Error(`Google từ chối token (${msg}) — thử Đăng xuất rồi đăng nhập lại.`);
    throw new Error(`Google Drive API: ${msg}`);
  }
  const ab = await r.arrayBuffer();
  if (ab.byteLength > MAX_CONTENT) {
    throw new Error(`File quá lớn để xem trong app (${(ab.byteLength / 1024 / 1024).toFixed(1)} MB > 30 MB) — mở trên browser.`);
  }
  return { buf: Buffer.from(ab), contentType: r.headers.get('content-type') ?? 'application/octet-stream' };
}

/** Tải nguyên văn nội dung một file thường (xlsx/pdf/ảnh/text…): alt=media. */
export async function downloadContent(accountId: string, id: string) {
  return driveGetBinary(accountId, `files/${encodeURIComponent(id)}`, {
    alt: 'media',
    supportsAllDrives: 'true',
  });
}

/** Export một file Google-native (Docs/Sheets/Slides) sang mimeType khác. */
export async function exportContent(accountId: string, id: string, mimeType: string) {
  return driveGetBinary(accountId, `files/${encodeURIComponent(id)}/export`, { mimeType });
}

/**
 * Pull the folder/file ID out of any Drive URL shape people actually paste:
 *   …/drive/folders/<id>            …/drive/u/0/folders/<id>?…
 *   …?id=<id>                       …/file/d/<id>/…   …/d/<id>/edit
 * A bare ID (no slashes) passes through unchanged.
 */
export function extractDriveId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s; // bare ID
  const m =
    /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) ||
    /\/d\/([A-Za-z0-9_-]{10,})/.exec(s) ||
    /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  return m ? m[1] : null;
}
