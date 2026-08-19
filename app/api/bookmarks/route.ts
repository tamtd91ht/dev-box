// /api/bookmarks — store dấu trang cho tab Browser (per-machine .bookmarks.json).
//   POST { action, ... }:
//     'list'      {}                                            → Bookmark[]
//     'add'       { url, name?, parentId?, profile?, username?, password? } → Bookmark[]
//     'addFolder' { name, parentId? }                            → Bookmark[]
//     'update'    { id, ...meta }                                → Bookmark[]
//     'move'      { id, parentId?, beforeId? }                   → Bookmark[]
//     'remove'    { id }   (folder = xoá cả nhánh)               → Bookmark[]

import { NextResponse, type NextRequest } from 'next/server';
import {
  listBookmarks, addBookmark, addFolder, updateBookmark, moveBookmark, removeBookmark,
  type BookmarkMeta,
} from '@/lib/bookmarkStore';

export const runtime = 'nodejs';

function metaFrom(body: Record<string, unknown>): BookmarkMeta {
  const m: BookmarkMeta = {};
  for (const k of ['name', 'url', 'profile', 'username', 'password', 'parentId'] as const) {
    if (typeof body[k] === 'string') m[k] = body[k] as string;
  }
  return m;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  try {
    let result: unknown;
    switch (action) {
      case 'list': result = await listBookmarks(); break;
      case 'add': result = await addBookmark({ url: String(body.url ?? ''), ...metaFrom(body) }); break;
      case 'addFolder': result = await addFolder(String(body.name ?? ''), body.parentId ? String(body.parentId) : undefined); break;
      case 'update': result = await updateBookmark(String(body.id ?? ''), metaFrom(body)); break;
      case 'move': result = await moveBookmark(
        String(body.id ?? ''),
        body.parentId ? String(body.parentId) : undefined,
        body.beforeId ? String(body.beforeId) : undefined,
      ); break;
      case 'remove': result = await removeBookmark(String(body.id ?? '')); break;
      default: return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
