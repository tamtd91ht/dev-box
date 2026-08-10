// /api/zaloapi — route điều phối cho nhánh Zalo API (THỬ NGHIỆM).
//
//   POST { action, ... }:
//     'flags'   {}                                  → { enabled, allowSend }
//     'login'   { accountKey, cookie, imei, userAgent, language? }
//                                                   → { uid, ready, expiresAt … }
//     'status'  { accountKey? }                      → SessionInfo | SessionInfo[]
//     'send'    { accountKey, threadId?, text, group? } → SendResult
//     'logout'  { accountKey }                       → { dropped }
//
// VÌ SAO Ở SERVER chứ không trong webview: hàm gửi của Zalo Web nằm trong bundle
// đã đóng gói, không phơi ra `window` — thử dò trong trang là ngõ cụt (xem
// lib/zaloapi/apiSend.ts). Đường đi được là tự dựng lại request đã ký + mã hoá,
// việc đó cần Node (crypto, không bị CORS), nên nó nằm đây.
//
// Webview giờ chỉ còn một việc: quét QR rồi nhả cookie + imei ra.
//
// Credential CHỈ nằm trong RAM (lib/zaloapi/server/session.ts) và không bao giờ
// được trả ngược ra client — response chỉ mang uid + trạng thái.
//
// Cổng: ZALOAPI_TOOL_ENABLED (403 khi tắt) + ZALOAPI_ALLOW_SEND cho 'send'.
// Mọi lượt gửi ghi một dòng ZALOAPI_AUDIT ra stdout, cùng quy ước SHEET_AUDIT.

import { NextResponse, type NextRequest } from 'next/server';
import { login, sendMessage } from '@/lib/zaloapi/server/client';
import { ZALOAPI_ENABLED, ZALOAPI_ALLOW_SEND } from '@/lib/zaloapi/server/flags';
import {
  putSession,
  getSession,
  getFreshContext,
  dropSession,
  sessionInfo,
  listSessions,
} from '@/lib/zaloapi/server/session';
import { startListener, pollMessages, listenerState, stopListener } from '@/lib/zaloapi/server/listenerHub';
import { contactsFor, upsertContact, removeContact } from '@/lib/zaloapi/server/contacts';
import { trace } from '@/lib/zaloapi/server/trace';

export const runtime = 'nodejs';

/** Chuỗi bắt buộc, cắt khoảng trắng — thiếu thì báo đúng tên trường. */
function need(v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new Error(`thiếu ${what}`);
  return s;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  // 'flags' trả lời được cả khi nhánh đang tắt — UI cần biết vì sao nó tắt.
  if (action === 'flags') {
    return NextResponse.json({
      ok: true,
      result: { enabled: ZALOAPI_ENABLED, allowSend: ZALOAPI_ALLOW_SEND },
    });
  }

  if (!ZALOAPI_ENABLED) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Nhánh Zalo API đang tắt. Đặt ZALOAPI_TOOL_ENABLED=true trong .env.local rồi khởi động lại '
          + '(chỉ dùng local, và CHỈ với tài khoản thử — nhánh này vi phạm ToS Zalo).',
      },
      { status: 403 },
    );
  }

  try {
    switch (action) {
      case 'login': {
        const accountKey = need(body.accountKey, 'accountKey');
        const creds = {
          cookie: need(body.cookie, 'cookie (chưa trích được từ phiên guest?)'),
          imei: need(body.imei, 'imei (phải là imei guest đã sinh, không tái tạo được)'),
          userAgent: need(body.userAgent, 'userAgent (phải khớp UA lúc đăng nhập)'),
          language: typeof body.language === 'string' ? body.language : undefined,
        };
        const ctx = await login(creds);
        trace('login', `login OK ${accountKey}`, { uid: ctx.uid, wsUrls: ctx.wsUrls.length, hasChat: !!ctx.serviceMap?.chat?.length, ping: ctx.pingIntervalMs });
        // Cất cả creds: nhờ đó listener + send tự login lại được khi phiên hỏng,
        // không bắt người dùng bấm Kết nối lại mỗi lần cookie bị Zalo xoay.
        putSession(accountKey, ctx, creds);
        // Kết nối lại (creds mới) → bỏ listener cũ đang bám ctx cũ; lần 'listen'
        // kế tiếp dựng lại với ctx tươi.
        stopListener(accountKey);
        // eslint-disable-next-line no-console
        console.log(`ZALOAPI_AUDIT operation=LOGIN account=${accountKey} uid=${ctx.uid} ts=${new Date().toISOString()}`);
        return NextResponse.json({ ok: true, result: sessionInfo(accountKey) });
      }

      case 'status': {
        const accountKey = typeof body.accountKey === 'string' ? body.accountKey.trim() : '';
        return NextResponse.json({
          ok: true,
          result: accountKey ? sessionInfo(accountKey) : listSessions(),
        });
      }

      case 'send': {
        const accountKey = need(body.accountKey, 'accountKey');
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) {
          return NextResponse.json({ ok: false, error: 'nội dung rỗng — không gửi' }, { status: 400 });
        }
        if (!ZALOAPI_ALLOW_SEND) {
          return NextResponse.json(
            { ok: false, error: 'Gửi đang tắt. Đặt ZALOAPI_ALLOW_SEND=true trong .env.local (chỉ dùng tài khoản thử).' },
            { status: 403 },
          );
        }
        // getFreshContext tự login lại nếu phiên hết hạn — không còn 409 "hết hạn".
        // Chỉ 409 khi CHƯA từng Kết nối (không có creds để login lại).
        let ctx;
        try {
          ctx = await getFreshContext(accountKey);
        } catch (err) {
          return NextResponse.json(
            { ok: false, error: `${(err as Error).message}` },
            { status: 409 },
          );
        }
        const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
        const group = !!body.group;
        const result = await sendMessage(ctx, { threadId, message: text, group });
        // eslint-disable-next-line no-console
        console.log(
          `ZALOAPI_AUDIT operation=SEND account=${accountKey} thread=${threadId || '(self)'} group=${group} `
          + `len=${text.length} ok=${result.ok} ts=${new Date().toISOString()}`,
        );
        return NextResponse.json({ ok: true, result });
      }

      // Bật listener NHẬN tin (server-side WebSocket). Cần phiên đã login.
      case 'listen': {
        const accountKey = need(body.accountKey, 'accountKey');
        const ctx = getSession(accountKey);
        if (!ctx) {
          return NextResponse.json(
            { ok: false, error: `chưa đăng nhập cho ${accountKey} — đăng nhập trước khi nghe` },
            { status: 409 },
          );
        }
        const r = startListener(accountKey, ctx);
        trace('listen', `bật listener ${accountKey}`, { ok: r.ok, detail: r.detail, wsUrls: ctx.wsUrls.length, hasChat: !!ctx.serviceMap?.chat?.length });
        return NextResponse.json({ ok: r.ok, result: { ...listenerState(accountKey), detail: r.detail } });
      }

      // Hút tin listener đã nhận từ lần poll trước + trạng thái kết nối.
      case 'poll': {
        const accountKey = need(body.accountKey, 'accountKey');
        const res = pollMessages(accountKey);
        // Chỉ trace khi CÓ gì đáng chú ý (tin, hoặc đổi trạng thái) để khỏi spam.
        if (res.messages.length || res.state !== 'ready') {
          trace('poll', `state=${res.state} msgs=${res.messages.length}`, { detail: res.detail, stats: res.stats });
        }
        return NextResponse.json({ ok: true, result: res });
      }

      case 'logout': {
        const accountKey = need(body.accountKey, 'accountKey');
        const stoppedListener = stopListener(accountKey);
        const dropped = dropSession(accountKey);
        // eslint-disable-next-line no-console
        console.log(`ZALOAPI_AUDIT operation=LOGOUT account=${accountKey} dropped=${dropped} listener=${stoppedListener} ts=${new Date().toISOString()}`);
        return NextResponse.json({ ok: true, result: { dropped, stoppedListener } });
      }

      // ── Danh bạ đích (tự học từ tin đến + thêm tay) ──────────────────────
      case 'contacts': {
        const accountKey = need(body.accountKey, 'accountKey');
        return NextResponse.json({ ok: true, result: await contactsFor(accountKey) });
      }

      case 'contactAdd': {
        const accountKey = need(body.accountKey, 'accountKey');
        const threadId = need(body.threadId, 'threadId');
        const store = await upsertContact({
          accountKey,
          threadId,
          name: typeof body.name === 'string' ? body.name : '',
          group: !!body.group,
        });
        return NextResponse.json({ ok: true, result: store.contacts.filter((c) => c.accountKey === accountKey) });
      }

      case 'contactRemove': {
        const accountKey = need(body.accountKey, 'accountKey');
        const threadId = need(body.threadId, 'threadId');
        const store = await removeContact(accountKey, threadId);
        return NextResponse.json({ ok: true, result: store.contacts.filter((c) => c.accountKey === accountKey) });
      }

      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    trace('error', `op '${action}' lỗi`, { msg: (err as Error).message });
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'Zalo API thất bại' },
      { status: 400 },
    );
  }
}
