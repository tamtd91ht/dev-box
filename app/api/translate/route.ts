// /api/translate — nút dịch nhanh (components/QuickTranslate.tsx).
//
//   POST { action:'translate', q, from, to } → { ok, result: TransResult }
//   POST { action:'suggest', q, lang }       → { ok, result: string[] }
//   POST { action:'tts', q, lang }           → { ok, result: { mime, chunks: base64[] } }
//
// Nguồn dịch/gợi ý và lý do chọn: xem lib/translateServer.ts.

import { NextResponse, type NextRequest } from 'next/server';
import { suggest, translate, tts } from '@/lib/translateServer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? '');
  try {
    switch (action) {
      case 'translate':
        return NextResponse.json({ ok: true, result: await translate(body?.q, body?.from, body?.to) });
      case 'suggest':
        return NextResponse.json({ ok: true, result: await suggest(body?.q, body?.lang) });
      case 'tts':
        return NextResponse.json({ ok: true, result: await tts(body?.q, body?.lang) });
      default:
        return NextResponse.json({ ok: false, error: `action không hỗ trợ: "${action}"` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
