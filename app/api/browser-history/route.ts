// /api/browser-history — lịch sử truy cập của tab Browser (per-machine
// configs/browser-history.json). Nguồn cho GỢI Ý của ô địa chỉ.
//   POST { action, ... }:
//     'suggest'    { q?, limit? }        → HistoryEntry[]  (xếp theo điểm khớp)
//     'list'       { q?, limit? }        → HistoryEntry[]  (mới nhất trước)
//     'visit'      { url, title? }       → { entry }
//     'title'      { url, title }        → {}
//     'remove'     { url } | { host }    → {}
//     'clear'      {}                    → {}

import { NextResponse, type NextRequest } from 'next/server';
import {
  suggest, listHistory, recordVisit, recordTitle,
  removeHistory, removeHistoryHost, clearHistory,
} from '@/lib/historyStore';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  const str = (k: string) => (typeof body[k] === 'string' ? body[k] as string : '');
  const num = (k: string) => (typeof body[k] === 'number' ? body[k] as number : undefined);

  try {
    let result: unknown = {};
    switch (action) {
      case 'suggest': result = await suggest(str('q'), num('limit')); break;
      case 'list': result = await listHistory(num('limit') ?? 200, str('q')); break;
      case 'visit': result = { entry: await recordVisit(str('url'), str('title')) }; break;
      case 'title': await recordTitle(str('url'), str('title')); break;
      case 'remove':
        // Xoá theo host khi có `host`, ngược lại xoá một URL. Hai việc khác
        // hẳn nhau nhưng cùng là "bỏ khỏi lịch sử" nên đi chung một action.
        if (str('host')) await removeHistoryHost(str('host'));
        else await removeHistory(str('url'));
        break;
      case 'clear': await clearHistory(); break;
      default: return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
