// /api/cal — mục LỊCH của tab Mail, nói CalDAV với chính mail server đã khai ở
// tab Mail (Zimbra là ca dùng chính). Credentials tái dùng từ mailaccounts.json
// nên client KHÔNG phải nhập lại gì và cũng không thấy mật khẩu.
//
//   POST { action, accountId, ... }:
//     'calendars' {}                                    → { ok, result: { calendars, root } }
//     'events'    { calendarUrl, from, to }             → { ok, result: CalEvent[] }
//                 (from/to ISO — server lọc bằng time-range, một request/tháng)
//     'create'    { calendarUrl, event }                → { ok, result: CalEvent }
//     'update'    { calendarUrl, url, event }           → { ok, result: CalEvent }
//                 (sự kiện lặp: sửa CẢ chuỗi, giữ nguyên RRULE)
//     'delete'    { url }                               → { ok, result: { deleted: true } }
//     'setUrl'    { url }                               → { ok, result: { calDavUrl } }
//                 (khai địa chỉ CalDAV riêng khi đoán từ imap host sai)

import { NextResponse, type NextRequest } from 'next/server';
import { getAccount, setCalDavUrl } from '@/lib/mailAccounts';
import {
  listCalendars, listEvents, createEvent, updateEvent, deleteEvent, guessCalRoot,
  type EventInput,
} from '@/lib/calServer';

export const runtime = 'nodejs';

/** Ép body thô của client về EventInput đã kiểm tra. */
function eventInput(raw: unknown): EventInput {
  const e = (raw ?? {}) as Record<string, unknown>;
  const start = String(e.start ?? '');
  const end = String(e.end ?? '');
  if (!start || !end) throw new Error('Thiếu thời gian bắt đầu/kết thúc.');
  if (isNaN(new Date(start).getTime()) || isNaN(new Date(end).getTime())) {
    throw new Error('Thời gian không hợp lệ.');
  }
  if (new Date(end).getTime() < new Date(start).getTime()) {
    throw new Error('Giờ kết thúc đang sớm hơn giờ bắt đầu.');
  }
  return {
    summary: String(e.summary ?? '').trim(),
    location: String(e.location ?? '').trim() || undefined,
    description: String(e.description ?? '').trim() || undefined,
    start,
    end,
    allDay: e.allDay === true,
    attendees: Array.isArray(e.attendees) ? e.attendees.map(String) : undefined,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  try {
    const accountId = String(body.accountId ?? '');
    if (!accountId) throw new Error('Thiếu accountId — chọn hòm thư trước.');
    const account = await getAccount(accountId);

    let result: unknown;
    switch (action) {
      case 'calendars':
        // Kèm root đang dùng để UI hiện được "đang hỏi lịch ở đâu" khi lỗi.
        result = {
          calendars: await listCalendars(account),
          root: account.calDavUrl || guessCalRoot(account),
          custom: !!account.calDavUrl,
        };
        break;
      case 'events': {
        const calendarUrl = String(body.calendarUrl ?? '');
        if (!calendarUrl) throw new Error('Thiếu calendarUrl.');
        result = await listEvents(
          account, calendarUrl,
          String(body.from ?? new Date().toISOString()),
          String(body.to ?? new Date().toISOString()),
        );
        break;
      }
      case 'create': {
        const calendarUrl = String(body.calendarUrl ?? '');
        if (!calendarUrl) throw new Error('Thiếu calendarUrl.');
        result = await createEvent(account, calendarUrl, eventInput(body.event));
        break;
      }
      case 'update': {
        const url = String(body.url ?? '');
        const calendarUrl = String(body.calendarUrl ?? '');
        if (!url || !calendarUrl) throw new Error('Thiếu url sự kiện.');
        result = await updateEvent(account, url, calendarUrl, eventInput(body.event));
        break;
      }
      case 'delete': {
        const url = String(body.url ?? '');
        if (!url) throw new Error('Thiếu url sự kiện.');
        await deleteEvent(account, url);
        result = { deleted: true };
        break;
      }
      case 'setUrl': {
        await setCalDavUrl(accountId, String(body.url ?? ''));
        const updated = await getAccount(accountId);
        result = { calDavUrl: updated.calDavUrl ?? null };
        break;
      }
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'Calendar operation failed' },
      { status: 502 },
    );
  }
}
