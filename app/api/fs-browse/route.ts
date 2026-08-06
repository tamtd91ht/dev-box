// /api/fs-browse — server-side folder browser for the shared FolderPicker.
//
//   POST { path?: string, marker?: string, exts?: string[] }
//        → { path, parent, entries[], isDriveList, markerHere?, files? }
//
// `path === ""` requests the drive list on Windows; omitting it starts at the
// configured start folder. `marker` is a plain file name (e.g. devbox.api.json)
// that gets flagged per directory so the UI can highlight the right folder.
// `exts` (e.g. ["xlsx","csv"]) additionally lists matching FILES in the folder
// (name + size + mtime) so the picker can select a file (Sheet tab).
//
// Returns listings only — never file contents. Enabled by default because
// DevBox is a localhost dev tool; set FS_BROWSE_ENABLED=0 to switch folder
// listing off entirely.

import { NextResponse, type NextRequest } from 'next/server';
import { browse } from '@/lib/fsBrowse';

export const runtime = 'nodejs';

const FS_BROWSE_ENABLED = process.env.FS_BROWSE_ENABLED !== '0';

export async function POST(req: NextRequest) {
  if (!FS_BROWSE_ENABLED) {
    return NextResponse.json({ error: 'Folder browsing is disabled (FS_BROWSE_ENABLED=0).' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  // Distinguish "no path → start folder" (undefined) from "drive list" ("").
  const target = typeof body?.path === 'string' ? body.path : undefined;
  const marker = typeof body?.marker === 'string' ? body.marker : undefined;
  const exts = Array.isArray(body?.exts)
    ? (body.exts as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
  // allFiles: bỏ lọc đuôi, liệt kê MỌI file (vẫn chỉ tên + kích thước).
  const allFiles = body?.allFiles === true;
  try {
    return NextResponse.json(await browse(target, marker, exts, allFiles));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'browse failed' }, { status: 400 });
  }
}
