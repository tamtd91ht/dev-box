// /api/ai — trợ lý AI (components/AiChat.tsx). Xem lib/aiChatServer.ts.
//
//   POST { action:'ask', question, history?, screen?, model?, attachments? } → { ok, id }
//   POST { action:'poll', id, from }  → { ok, result: AiPoll }   (phần chữ mới + trạng thái)
//   POST { action:'stop', id }        → { ok }
//
// Kho tri thức riêng (lib/aiKnowledge.ts) — tài liệu bật được chèn vào prompt:
//   POST { action:'kb.list' }                    → { ok, result: KbMeta[] }
//   POST { action:'kb.get', id }                 → { ok, result: KbDoc }
//   POST { action:'kb.save', id?, title, content } → { ok, result: KbMeta[] }
//   POST { action:'kb.toggle', id, enabled }     → { ok, result: KbMeta[] }
//   POST { action:'kb.remove', id }              → { ok, result: KbMeta[] }
//
// Trợ lý không có công cụ và route này không chạy gì khác
// ngoài `claude -p` không-công-cụ — đừng thêm action cho nó thao tác lên máy.

import { NextResponse, type NextRequest } from 'next/server';
import { ask, poll, stop } from '@/lib/aiChatServer';
import { kbGet, kbList, kbRemove, kbSave, kbToggle } from '@/lib/aiKnowledge';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? '');
  try {
    switch (action) {
      case 'ask':
        return NextResponse.json({ ok: true, ...(await ask(body ?? {})) });
      case 'poll':
        return NextResponse.json({ ok: true, result: poll(body?.id, body?.from) });
      case 'stop':
        stop(body?.id);
        return NextResponse.json({ ok: true });
      case 'kb.list':
        return NextResponse.json({ ok: true, result: await kbList() });
      case 'kb.get':
        return NextResponse.json({ ok: true, result: await kbGet(body?.id) });
      case 'kb.save':
        return NextResponse.json({ ok: true, result: await kbSave(body ?? {}) });
      case 'kb.toggle':
        return NextResponse.json({ ok: true, result: await kbToggle(body?.id, body?.enabled) });
      case 'kb.remove':
        return NextResponse.json({ ok: true, result: await kbRemove(body?.id) });
      default:
        return NextResponse.json({ ok: false, error: `action không hỗ trợ: "${action}"` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
