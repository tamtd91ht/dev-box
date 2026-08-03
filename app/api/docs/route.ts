// /api/docs — store snippet JSON/text cho tab Tools (per-machine .docs.json).
//   POST { action, ... }:
//     'list'   {}                          → SavedDoc[]
//     'save'   { id?, name, kind, content } → SavedDoc[]  (id có = cập nhật)
//     'remove' { id }                       → SavedDoc[]

import { NextResponse, type NextRequest } from 'next/server';
import { listDocs, saveDoc, removeDoc, type DocKind } from '@/lib/docStore';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  try {
    let result: unknown;
    switch (action) {
      case 'list':
        result = await listDocs();
        break;
      case 'save':
        result = await saveDoc({
          id: typeof body.id === 'string' ? body.id : undefined,
          name: String(body.name ?? ''),
          kind: (body.kind === 'json' ? 'json' : 'text') as DocKind,
          content: String(body.content ?? ''),
        });
        break;
      case 'remove':
        result = await removeDoc(String(body.id ?? ''));
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
