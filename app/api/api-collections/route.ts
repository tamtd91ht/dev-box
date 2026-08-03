// /api/api-collections — store collection + environment cho tab API.
//   POST { action, ... }:
//     'get'          {}                → ApiData
//     'saveRequest'  { ...ApiRequest } → ApiData   (id có = cập nhật)
//     'removeRequest'{ id }            → ApiData
//     'saveEnv'      { ...ApiEnvironment } → ApiData
//     'removeEnv'    { id }            → ApiData
//     'setActiveEnv' { id | null }     → ApiData

import { NextResponse, type NextRequest } from 'next/server';
import {
  getData, saveRequest, removeRequest, saveEnv, removeEnv, setActiveEnv,
} from '@/lib/apiStore';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  try {
    let result: unknown;
    switch (action) {
      case 'get': result = await getData(); break;
      case 'saveRequest': result = await saveRequest(body as never); break;
      case 'removeRequest': result = await removeRequest(String(body.id ?? '')); break;
      case 'saveEnv': result = await saveEnv(body as never); break;
      case 'removeEnv': result = await removeEnv(String(body.id ?? '')); break;
      case 'setActiveEnv': result = await setActiveEnv((body.id as string) ?? null); break;
      default: return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
