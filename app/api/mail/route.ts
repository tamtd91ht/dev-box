// /api/mail — single dispatch route for the Mail tab (IMAP xem / SMTP gửi).
//
// MULTI-ACCOUNT + provider-agnostic: mọi mail server nói IMAP/SMTP đều dùng
// được (Zimbra mail.example.com, Gmail app-password, …). Credentials nằm
// trong .mailaccounts.json phía server; client chỉ nhận MailAccountPublic.
//
//   POST { action, ... }  where action is one of:
//     'accounts'      {}                              → { ok, result: MailAccountPublic[] }
//     'accountAdd'    { label?, email, user?, pass, imapHost, imapPort?, imapSecure?,
//                       smtpHost, smtpPort?, smtpSecure? }
//                     → { ok, result: MailAccountPublic[] }   (verify IMAP login trước khi lưu)
//     'accountRemove' { id }                          → { ok, result: MailAccountPublic[] }
//     'folders'       { accountId }                   → { ok, result: MailFolder[] }
//     'list'          { accountId, path, beforeSeq? } → { ok, result: MailListPage }
//     'message'       { accountId, path, uid }        → { ok, result: MailDetail } (đánh dấu \Seen)
//     'send'          { accountId, to, cc?, bcc?, subject, text, inReplyTo?, references? }
//                     → { ok, result: { messageId } }         (best-effort copy vào Sent)
//
//   GET ?attachment&accountId=&path=&uid=&idx=  → stream file đính kèm.

import { NextResponse, type NextRequest } from 'next/server';
import { listAccounts, getAccount, addAccount, removeAccount, toPublic } from '@/lib/mailAccounts';
import {
  verifyImap, listFolders, listMessages, getMessage, getAttachment, sendMail,
} from '@/lib/mailServer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  const accountId = String(body.accountId ?? '');
  const needAccount = async () => {
    if (!accountId) throw new Error('Thiếu accountId — chọn tài khoản mail trước.');
    return getAccount(accountId);
  };

  try {
    let result: unknown;
    switch (action) {
      case 'accounts':
        result = (await listAccounts()).map(toPublic);
        break;
      case 'accountAdd': {
        const email = String(body.email ?? '').trim();
        if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Email không hợp lệ.');
        const pass = String(body.pass ?? '');
        if (!pass) throw new Error('Thiếu password.');
        const acc = {
          label: String(body.label ?? '').trim() || email,
          email,
          user: String(body.user ?? '').trim() || email,
          pass,
          imap: {
            host: String(body.imapHost ?? '').trim(),
            port: Number(body.imapPort) || 993,
            secure: body.imapSecure !== false,
          },
          smtp: {
            host: String(body.smtpHost ?? '').trim(),
            port: Number(body.smtpPort) || 465,
            secure: body.smtpSecure !== false,
          },
        };
        if (!acc.imap.host || !acc.smtp.host) throw new Error('Thiếu host IMAP/SMTP.');
        // Login thử qua IMAP trước khi lưu — sai password là biết ngay.
        await verifyImap({ ...acc, id: 'verify' });
        result = (await addAccount(acc)).map(toPublic);
        break;
      }
      case 'accountRemove':
        result = (await removeAccount(String(body.id ?? ''))).map(toPublic);
        break;
      case 'folders':
        result = await listFolders(await needAccount());
        break;
      case 'list':
        result = await listMessages(
          await needAccount(),
          String(body.path ?? 'INBOX'),
          typeof body.beforeSeq === 'number' ? body.beforeSeq : undefined,
        );
        break;
      case 'message':
        result = await getMessage(await needAccount(), String(body.path ?? 'INBOX'), Number(body.uid));
        break;
      case 'send': {
        const to = String(body.to ?? '').trim();
        if (!to) throw new Error('Thiếu người nhận (To).');
        result = await sendMail(await needAccount(), {
          to,
          cc: String(body.cc ?? '').trim() || undefined,
          bcc: String(body.bcc ?? '').trim() || undefined,
          subject: String(body.subject ?? ''),
          text: String(body.text ?? ''),
          inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : undefined,
          references: Array.isArray(body.references) ? body.references.map(String) : undefined,
          attachments: Array.isArray(body.attachments)
            ? body.attachments.map((a: Record<string, unknown>) => ({
                filename: String(a.filename ?? 'attachment'),
                contentBase64: String(a.contentBase64 ?? ''),
                contentType: typeof a.contentType === 'string' ? a.contentType : undefined,
              }))
            : undefined,
        });
        break;
      }
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = (err as Error).message || 'Mail operation failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}

/** Tải file đính kèm: /api/mail?attachment&accountId=&path=&uid=&idx= */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (!sp.has('attachment')) {
    return NextResponse.json({ ok: false, error: 'Unknown GET' }, { status: 400 });
  }
  try {
    const account = await getAccount(sp.get('accountId') ?? '');
    const att = await getAttachment(
      account,
      sp.get('path') ?? 'INBOX',
      Number(sp.get('uid')),
      Number(sp.get('idx')),
    );
    return new NextResponse(new Uint8Array(att.content), {
      headers: {
        'content-type': att.contentType || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
