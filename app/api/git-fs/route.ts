// /api/git-fs — server-side folder browser for the project-root picker.
//
//   POST { path?: string } → { path, parent, entries[], isDriveList }
//
// Local tool only — gated by GIT_TOOL_ENABLED (403 otherwise; nothing on disk is
// read on a k8s/prod deploy). Returns directory listings only, never file
// contents. `path === ""` requests the drive list on Windows.

import { NextResponse, type NextRequest } from 'next/server';
import { GIT_ENABLED } from '@/lib/gitCore';
import { browse } from '@/lib/gitFs';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!GIT_ENABLED) {
    return NextResponse.json({ error: 'Git tool is disabled.' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  // Distinguish "no path → start folder" (undefined) from "drive list" ("").
  const target = typeof body?.path === 'string' ? body.path : undefined;
  try {
    return NextResponse.json(await browse(target));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'browse failed' }, { status: 400 });
  }
}
