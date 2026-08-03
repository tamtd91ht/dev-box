// /api/links — single dispatch route for the Links tab (bookmark + profile
// session registry, per-machine). KHÔNG đụng mạng ngoài: chỉ đọc/ghi
// .links.json; bản thân link mở trong <webview> phía renderer.
//
//   POST { action, ... }  where action is one of:
//     'list'   {}                                              → { ok, result: SavedLink[] }
//     'add'    { url, name?, project?, description?, tags?, profile? } → { ok, result: SavedLink[] }
//     'update' { id, name?, project?, description?, tags?, profile? }  → { ok, result: SavedLink[] }
//     'remove' { id }                                          → { ok, result: SavedLink[] }

import { NextResponse, type NextRequest } from 'next/server';
import { listLinks, addLink, updateLink, removeLink, type SavedLinkMeta } from '@/lib/linkRegistry';

export const runtime = 'nodejs';

function metaFrom(body: Record<string, unknown>): SavedLinkMeta {
  const meta: SavedLinkMeta = {};
  if (typeof body.name === 'string') meta.name = body.name;
  if (typeof body.project === 'string') meta.project = body.project;
  if (typeof body.description === 'string') meta.description = body.description;
  if (typeof body.profile === 'string') meta.profile = body.profile;
  if (typeof body.username === 'string') meta.username = body.username;
  if (typeof body.password === 'string') meta.password = body.password;
  if (Array.isArray(body.tags)) meta.tags = body.tags.map(String);
  return meta;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  try {
    let result: unknown;
    switch (action) {
      case 'list':
        result = await listLinks();
        break;
      case 'add':
        result = await addLink({ url: String(body.url ?? ''), ...metaFrom(body) });
        break;
      case 'update':
        result = await updateLink(String(body.id ?? ''), metaFrom(body));
        break;
      case 'remove':
        result = await removeLink(String(body.id ?? ''));
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message || 'Links operation failed' }, { status: 502 });
  }
}
