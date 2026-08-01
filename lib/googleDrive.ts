// Server-only Google Drive REST v3 client for the Google tab. No SDK — the
// three calls we need are plain GETs with a bearer token (googleapis would add
// ~30 MB of deps for this). Read-only by scope AND by code: only files.list /
// files.get are ever called.

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
