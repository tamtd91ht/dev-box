// /api/zaloapi — route điều phối cho nhánh Zalo API (THỬ NGHIỆM).
//
//   POST { action, ... }:
//     'flags'   {}                                  → { enabled, allowSend }
//     'login'   { accountKey, cookie, imei, userAgent, language? }
//                                                   → { uid, ready, expiresAt … }
//     'status'  { accountKey? }                      → SessionInfo | SessionInfo[]
//     'send'    { accountKey, threadId?, text, group? } → SendResult
//     'logout'  { accountKey }                       → { dropped }
//     'react'   { accountKey, threadId, msgId, key | remove:true, group? }
//                                                   → { ok, detail, messages }
//     'archiveConfig'    { accountKey? }             → ArchiveConfigView
//     'archiveConfigSet' { mode, connectionId?, database? } → ArchiveConfigView
//     'archiveHydrate'   { accountKey }              → { threads, messages }
//     'archivePurge'     { accountKey | all }        → { messages, threads }
//
// KHO LƯU TRỮ TIN (lib/zaloapi/server/messageArchive) — TUỲ CHỌN, 3 chế độ:
// 'off' không lưu (mặc định), 'local' file JSONL trong configs/, 'mongo' một cụm
// chọn từ registry Mongo. Lý do có nó: listener socket chỉ thấy tin TỪ LÚC KẾT
// NỐI, và Zalo không cho lấy lại lịch sử 1-1 — không lưu thì restart là trắng
// màn chat. 'login' tự nạp lại từ kho, 'history' rơi về kho khi RAM trống.
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
import { login, sendMessage, uploadImage, sendPhoto, getGroupHistory, scanContacts, sendReaction } from '@/lib/zaloapi/server/client';
import { reactionByKey, REACTION_SOURCE, UNREACT_RTYPE } from '@/lib/zaloapi/reactions';
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
import { contactsFor, upsertContact, removeContact, bulkUpsertContacts, setContactTags } from '@/lib/zaloapi/server/contacts';
import {
  threadsFor,
  messagesFor,
  markThreadRead,
  recordOutgoing,
  setMessageStatus,
  applyNames,
  dropThreads,
  prependHistory,
  hydrateFromArchive,
  recordOwnReaction,
  realMsgIds,
} from '@/lib/zaloapi/server/threadStore';
import {
  getArchiveConfigView,
  setArchiveConfig,
  purgeArchive,
  loadThreadMessages,
} from '@/lib/zaloapi/server/messageArchive';
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
        // Nạp lại lịch sử từ kho lưu trữ (nếu đã cấu hình): RAM vừa trống, mà
        // Zalo không cho lấy lại tin 1-1 — đây là đường duy nhất để màn chat có
        // tin của các phiên trước. Chế độ 'off' thì hàm này là no-op.
        const restored = await hydrateFromArchive(accountKey);
        if (restored.messages) {
          trace('archive', `khôi phục ${restored.messages} tin / ${restored.threads} hội thoại từ kho`, restored);
        }
        // eslint-disable-next-line no-console
        console.log(`ZALOAPI_AUDIT operation=LOGIN account=${accountKey} uid=${ctx.uid} ts=${new Date().toISOString()}`);
        return NextResponse.json({ ok: true, result: { ...sessionInfo(accountKey), restored } });
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
        // Định dạng chữ (tuỳ chọn): [{start,len,st}]. Lọc sơ để chắc kiểu.
        const styles = Array.isArray(body.styles)
          ? body.styles
              .filter((s: unknown) => s && typeof s === 'object')
              .map((s: Record<string, unknown>) => ({ start: Number(s.start) || 0, len: Number(s.len) || 0, st: String(s.st || '') }))
              .filter((s: { len: number; st: string }) => s.len > 0 && s.st)
          : undefined;
        // Tag (@) trong tin nhóm (tuỳ chọn): [{uid,name}], trần 5 — quá số đó
        // là spam cả nhóm chứ không còn là cảnh báo.
        const mentions = Array.isArray(body.mentions)
          ? body.mentions
              .filter((m: unknown) => m && typeof m === 'object')
              .map((m: Record<string, unknown>) => ({ uid: String(m.uid || '').trim(), name: String(m.name || '').trim() }))
              .filter((m: { uid: string }) => m.uid)
              .slice(0, 5)
          : undefined;
        // Ghi LẠC QUAN vào kho hội thoại NGAY để màn chat hiện bong bóng liền,
        // rồi cập nhật trạng thái theo kết quả. dest rỗng = tự gửi cho mình (uid).
        const dest = threadId || ctx.uid;
        const now = Date.now();
        const echoId = dest ? recordOutgoing(accountKey, { threadId: dest, group, text, at: now, status: 'sending' }) : '';
        const result = await sendMessage(ctx, { threadId, message: text, group, styles, mentions });
        if (dest && echoId) setMessageStatus(accountKey, dest, echoId, result.ok ? 'sent' : 'failed');
        // eslint-disable-next-line no-console
        console.log(
          `ZALOAPI_AUDIT operation=SEND account=${accountKey} thread=${threadId || '(self)'} group=${group} `
          + `len=${text.length} ok=${result.ok} ts=${new Date().toISOString()}`,
        );
        return NextResponse.json({ ok: true, result: { ...result, threadId: dest } });
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

      // ── Màn chat: danh sách hội thoại + lịch sử tin ──────────────────────
      // GỘP hai nguồn: (a) kho RAM phiên này (có tin mới nhất + chưa đọc), và
      // (b) DANH BẠ đã học lưu trên đĩa từ các phiên trước. Nhờ (b), vừa Kết nối
      // là thấy ngay các hội thoại cũ để mở/nhắn, không phải chờ có tin mới.
      case 'threads': {
        const accountKey = need(body.accountKey, 'accountKey');
        // uid của CHÍNH tài khoản đang kết nối — nó KHÔNG phải một hội thoại, phải
        // loại khỏi danh sách. Chỉ giữ khách (người khác) + nhóm.
        const ownUid = getSession(accountKey)?.uid || '';
        // Hội thoại rác cần loại: threadId rỗng, "0" (bug tin-của-mình cũ), hoặc
        // chính là uid tài khoản đang đăng nhập.
        const junk = (id: string) => !id || id === '0' || (!!ownUid && id === ownUid);
        let contacts: Awaited<ReturnType<typeof contactsFor>> = [];
        try {
          contacts = await contactsFor(accountKey);
          applyNames(accountKey, Object.fromEntries(contacts.map((c) => [c.threadId, c.name])));
        } catch { /* thiếu danh bạ không chặn danh sách */ }
        const live = threadsFor(accountKey).filter((t) => !junk(t.threadId));
        const seen = new Set(live.map((t) => t.threadId));
        const fromContacts = contacts
          .filter((c) => !junk(c.threadId) && !seen.has(c.threadId))
          .map((c) => ({ threadId: c.threadId, group: c.group, name: c.name, lastText: '', lastAt: c.lastSeen || 0, unread: 0 }));
        const tagOf = new Map(contacts.map((c) => [c.threadId, c.tags ?? []]));
        const merged = [...live, ...fromContacts]
          .sort((a, b) => b.lastAt - a.lastAt)
          .map((t) => ({ ...t, tags: tagOf.get(t.threadId) ?? [] }));
        return NextResponse.json({ ok: true, result: merged });
      }

      // QUÉT nhóm + khách từ tài khoản Zalo về, lưu vào danh bạ rồi trả danh sách
      // hội thoại đã gộp — để lần sau vào không còn trống.
      case 'scan': {
        const accountKey = need(body.accountKey, 'accountKey');
        let ctx;
        try { ctx = await getFreshContext(accountKey); }
        catch (err) { return NextResponse.json({ ok: false, error: `${(err as Error).message}` }, { status: 409 }); }
        const { contacts: scanned, groups, friends, note } = await scanContacts(ctx);
        if (scanned.length) await bulkUpsertContacts(accountKey, scanned);
        trace('scan', `quét danh bạ: ${groups} nhóm · ${friends} khách`, { note });

        const ownUid = ctx.uid;
        const junk = (id: string) => !id || id === '0' || (!!ownUid && id === ownUid);
        let contacts: Awaited<ReturnType<typeof contactsFor>> = [];
        try {
          contacts = await contactsFor(accountKey);
          applyNames(accountKey, Object.fromEntries(contacts.map((c) => [c.threadId, c.name])));
        } catch { /* ignore */ }
        const live = threadsFor(accountKey).filter((t) => !junk(t.threadId));
        const seen = new Set(live.map((t) => t.threadId));
        const fromContacts = contacts
          .filter((c) => !junk(c.threadId) && !seen.has(c.threadId))
          .map((c) => ({ threadId: c.threadId, group: c.group, name: c.name, lastText: '', lastAt: c.lastSeen || 0, unread: 0 }));
        const tagOf = new Map(contacts.map((c) => [c.threadId, c.tags ?? []]));
        const merged = [...live, ...fromContacts]
          .sort((a, b) => b.lastAt - a.lastAt)
          .map((t) => ({ ...t, tags: tagOf.get(t.threadId) ?? [] }));
        return NextResponse.json({ ok: true, result: { threads: merged, groups, friends, note } });
      }

      case 'history': {
        const accountKey = need(body.accountKey, 'accountKey');
        const threadId = need(body.threadId, 'threadId');
        markThreadRead(accountKey, threadId);
        let msgs = messagesFor(accountKey, threadId);
        // RAM trống cho hội thoại này (mở lại một hội thoại cũ sau khi restart,
        // hoặc hội thoại chỉ có trong danh bạ) → thử kho lưu trữ. Không nạp
        // ngược vào RAM: chỉ cần trả cho lần render này, và tin mới vẫn chảy vào
        // RAM như thường.
        if (!msgs.length) {
          try {
            msgs = await loadThreadMessages(accountKey, threadId);
          } catch { /* kho lỗi → trả rỗng như trước */ }
        }
        return NextResponse.json({ ok: true, result: msgs });
      }

      // THẢ / BỎ cảm xúc lên một tin. rType -1 = bỏ (xem lib/zaloapi/reactions).
      case 'react': {
        const accountKey = need(body.accountKey, 'accountKey');
        const threadId = need(body.threadId, 'threadId');
        const msgId = need(body.msgId, 'msgId');
        const group = !!body.group;
        // Thả cảm xúc cũng là GHI lên tài khoản người khác → cùng cổng với gửi tin.
        if (!ZALOAPI_ALLOW_SEND) {
          return NextResponse.json(
            { ok: false, error: 'Gửi đang tắt. Đặt ZALOAPI_ALLOW_SEND=true trong .env.local (chỉ dùng tài khoản thử).' },
            { status: 403 },
          );
        }
        const remove = body.remove === true;
        const def = remove ? null : reactionByKey(String(body.key ?? ''));
        if (!remove && !def) {
          return NextResponse.json({ ok: false, error: `cảm xúc không hợp lệ: ${String(body.key ?? '')}` }, { status: 400 });
        }
        let ctx;
        try { ctx = await getFreshContext(accountKey); }
        catch (err) { return NextResponse.json({ ok: false, error: `${(err as Error).message}` }, { status: 409 }); }

        const icon = def?.icon ?? '';
        const rType = def?.rType ?? UNREACT_RTYPE;
        // `msgId` client gửi lên là id NỘI BỘ của bong bóng (có thể là chuỗi ta
        // tự sinh). Zalo cần id THẬT dạng số → tra từ kho tin, đừng dùng thẳng.
        const real = realMsgIds(accountKey, threadId, msgId);
        // Hiện ngay (lạc quan) rồi mới gọi Zalo — cùng kỷ luật với gửi tin.
        // `prev` là mặt ta đang thả trước lượt này, để hoàn nguyên nếu Zalo từ chối.
        const prev = recordOwnReaction(accountKey, threadId, msgId, icon, rType);
        const result = await sendReaction(ctx, {
          threadId, group,
          msgId: real.zMsgId,
          cliMsgId: real.zCliMsgId,
          icon, rType, source: REACTION_SOURCE,
        });
        // Zalo từ chối → đặt lại ĐÚNG mặt cũ (hoặc bỏ hẳn nếu trước đó chưa thả).
        if (!result.ok && prev !== undefined) {
          recordOwnReaction(accountKey, threadId, msgId, prev?.icon ?? '', prev?.rType ?? UNREACT_RTYPE);
        }
        // Trace ĐẦY ĐỦ id đã gửi: khi Zalo "nhận mà không áp", đây là chỗ duy
        // nhất thấy được ta đã gửi id gì và nó có phải id thật dạng số hay không.
        trace('react', `thả cảm xúc ${icon || '(bỏ)'} rType=${rType}`, {
          ok: result.ok,
          detail: result.detail,
          uiMsgId: msgId,
          gMsgID: real.zMsgId,
          cMsgID: real.zCliMsgId ?? '',
          numeric: /^\d+$/.test(real.zMsgId),
          group,
          raw: result.raw,
        });
        // eslint-disable-next-line no-console
        console.log(
          `ZALOAPI_AUDIT operation=REACT account=${accountKey} thread=${threadId} msg=${real.zMsgId} `
          + `icon=${icon || '(bỏ)'} rType=${rType} ok=${result.ok} ts=${new Date().toISOString()}`,
        );
        return NextResponse.json({
          ok: result.ok,
          result: { ...result, messages: messagesFor(accountKey, threadId) },
        });
      }

      // ── Kho lưu trữ tin (tuỳ chọn: off / local / mongo) ──────────────────
      case 'archiveConfig': {
        const accountKey = typeof body.accountKey === 'string' ? body.accountKey.trim() : undefined;
        return NextResponse.json({ ok: true, result: await getArchiveConfigView(accountKey) });
      }

      case 'archiveConfigSet': {
        const accountKey = typeof body.accountKey === 'string' ? body.accountKey.trim() : undefined;
        await setArchiveConfig({
          mode: body.mode,
          connectionId: body.connectionId,
          database: body.database,
        });
        // Vừa BẬT kho (local/mongo) mà tài khoản đang đăng nhập → nạp lại ngay,
        // không phải bấm Kết nối lại mới thấy lịch sử.
        if (accountKey && body.mode !== 'off' && getSession(accountKey)) {
          await hydrateFromArchive(accountKey);
        }
        trace('archive', `đổi chế độ kho lưu trữ → ${String(body.mode)}`);
        return NextResponse.json({ ok: true, result: await getArchiveConfigView(accountKey) });
      }

      // Nạp lại lịch sử từ kho vào RAM theo yêu cầu (nút trong màn chat).
      case 'archiveHydrate': {
        const accountKey = need(body.accountKey, 'accountKey');
        const restored = await hydrateFromArchive(accountKey);
        return NextResponse.json({ ok: true, result: restored });
      }

      // DỌN kho — xoá tin đã lưu. Mặc định chỉ tài khoản đang xem; all=true xoá cả kho.
      case 'archivePurge': {
        const accountKey = body.all === true ? undefined : need(body.accountKey, 'accountKey');
        const removed = await purgeArchive(accountKey);
        // eslint-disable-next-line no-console
        console.log(
          `ZALOAPI_AUDIT operation=ARCHIVE_PURGE account=${accountKey ?? '(all)'} `
          + `messages=${removed.messages} threads=${removed.threads} ts=${new Date().toISOString()}`,
        );
        return NextResponse.json({ ok: true, result: removed });
      }

      // Gửi ẢNH: nhận bytes base64 từ renderer → upload → gửi tin ảnh.
      case 'sendImage': {
        const accountKey = need(body.accountKey, 'accountKey');
        if (!ZALOAPI_ALLOW_SEND) {
          return NextResponse.json({ ok: false, error: 'Gửi đang tắt. Đặt ZALOAPI_ALLOW_SEND=true trong .env.local.' }, { status: 403 });
        }
        const b64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
        if (!b64) return NextResponse.json({ ok: false, error: 'thiếu dữ liệu ảnh' }, { status: 400 });
        const buffer = Buffer.from(b64, 'base64');
        if (!buffer.length) return NextResponse.json({ ok: false, error: 'ảnh rỗng' }, { status: 400 });
        const fileName = (typeof body.fileName === 'string' && body.fileName.trim()) || `image_${Date.now()}.jpg`;
        const caption = typeof body.caption === 'string' ? body.caption : '';
        const group = !!body.group;
        const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';

        let ctx;
        try { ctx = await getFreshContext(accountKey); }
        catch (err) { return NextResponse.json({ ok: false, error: `${(err as Error).message}` }, { status: 409 }); }

        const dest = threadId || ctx.uid;
        try {
          const attachment = await uploadImage(ctx, { buffer, fileName, threadId, group });
          const now = Date.now();
          const echoId = dest ? recordOutgoing(accountKey, { threadId: dest, group, text: caption || '[ảnh]', at: now, status: 'sending', imageUrl: attachment.thumbUrl || attachment.normalUrl }) : '';
          const result = await sendPhoto(ctx, { threadId, group, attachment, caption });
          if (dest && echoId) setMessageStatus(accountKey, dest, echoId, result.ok ? 'sent' : 'failed');
          // eslint-disable-next-line no-console
          console.log(`ZALOAPI_AUDIT operation=SEND_IMAGE account=${accountKey} thread=${threadId || '(self)'} group=${group} size=${buffer.length} ok=${result.ok} ts=${new Date().toISOString()}`);
          return NextResponse.json({ ok: true, result: { ...result, threadId: dest } });
        } catch (err) {
          return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
        }
      }

      // Kéo LỊCH SỬ CŨ. Chỉ NHÓM có API (getGroupChatHistory); 1-1 Zalo không lộ.
      case 'loadOlder': {
        const accountKey = need(body.accountKey, 'accountKey');
        const threadId = need(body.threadId, 'threadId');
        const group = !!body.group;
        if (!group) {
          return NextResponse.json({ ok: true, result: { supported: false, messages: messagesFor(accountKey, threadId) } });
        }
        let ctx;
        try { ctx = await getFreshContext(accountKey); }
        catch (err) { return NextResponse.json({ ok: false, error: `${(err as Error).message}` }, { status: 409 }); }
        const count = Number.isFinite(Number(body.count)) ? Number(body.count) : 50;
        const older = await getGroupHistory(ctx, threadId, count);
        prependHistory(accountKey, threadId, true, older);
        return NextResponse.json({ ok: true, result: { supported: true, messages: messagesFor(accountKey, threadId) } });
      }

      // Gán/đổi TAG cho một hội thoại (để lọc/tìm).
      case 'setTags': {
        const accountKey = need(body.accountKey, 'accountKey');
        const threadId = need(body.threadId, 'threadId');
        const tags = Array.isArray(body.tags) ? body.tags.map((x: unknown) => String(x)) : [];
        const name = typeof body.name === 'string' ? body.name : undefined;
        const group = !!body.group;
        await setContactTags({ accountKey, threadId, tags, name, group });
        return NextResponse.json({ ok: true, result: { ok: true, tags } });
      }

      case 'markRead': {
        const accountKey = need(body.accountKey, 'accountKey');
        const threadId = need(body.threadId, 'threadId');
        markThreadRead(accountKey, threadId);
        return NextResponse.json({ ok: true, result: { ok: true } });
      }

      case 'logout': {
        const accountKey = need(body.accountKey, 'accountKey');
        const stoppedListener = stopListener(accountKey);
        dropThreads(accountKey);
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
