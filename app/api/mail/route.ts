// /api/mail — single dispatch route for the Mail tab (IMAP xem / SMTP gửi).
//
// MULTI-ACCOUNT + provider-agnostic: mọi mail server nói IMAP/SMTP đều dùng
// được (Zimbra mail.example.com, Gmail app-password, …). Credentials nằm
// trong .mailaccounts.json phía server; client chỉ nhận MailAccountPublic.
//
//   POST { action, ... }  where action is one of:
//     'accounts'      {}                              → { ok, result: MailAccountPublic[] }
//     'accountAdd'    { label?, title?, email, user?, pass, imapHost, imapPort?, imapSecure?,
//                       smtpHost, smtpPort?, smtpSecure? }
//                     → { ok, result: MailAccountPublic[] }   (verify IMAP login trước khi lưu)
//     'accountAddOAuth' { email, label?, title? }     → { ok, result: MailAccountPublic[] }
//                     (Gmail/Workspace qua XOAUTH2 — KHÔNG cần App Password;
//                      đòi đã đăng nhập Google cho email đó + có scope mail)
//     'googleAuthUrl' { email? }                      → { ok, result: { url } }
//                     (consent kèm scope https://mail.google.com/)
//     'accountRemove' { id }                          → { ok, result: MailAccountPublic[] }
//     'accountRename' { id, title?, label? }          → { ok, result: MailAccountPublic[] }
//                     (title = tên quản lý hiện trên tab; label = tên người gửi ở header From)
//     'folders'       { accountId }                   → { ok, result: MailFolder[] }
//     'list'          { accountId, path, beforeSeq? } → { ok, result: MailListPage }
//     'message'       { accountId, path, uid }        → { ok, result: MailDetail } (đánh dấu \Seen)
//     'nestedMessage' { accountId, path, uid, trail } → { ok, result: MailDetail }
//                     (mail LỒNG trong mail — thư chuyển tiếp đính kèm bản gốc;
//                      trail = [idx] mỗi lớp lồng, vd [2] hoặc [2,0])
//     'signatureSet'  { id, signature, onReply? }     → { ok, result: MailAccountPublic[] }
//                     (chữ ký HTML riêng từng tài khoản; server lọc script trước khi lưu)
//     'markAllSeen'   { accountId, path }              → { ok, result: { marked } }
//                     (đánh dấu TOÀN BỘ mail trong folder là đã đọc)
//     'delete'        { accountId, path, uid }        → { ok, result: { mode: 'trash'|'purged' } }
//                     (move vào Trash; đang ở Trash → xóa vĩnh viễn — không đọc nội dung)
//     'send'          { accountId, to, cc?, bcc?, subject, text, inReplyTo?, references? }
//                     → { ok, result: { messageId } }         (best-effort copy vào Sent)
//
//   GET ?attachment&accountId=&path=&uid=&idx=  → stream file đính kèm.
//   GET ?fetch&mode=probe|download&url=         → link "Tải về" TRONG BODY mail:
//       probe = xem URL trả về file hay trang web (đọc header rồi hủy body);
//       download = stream file về client với content-disposition attachment,
//       để tải ngay trong app thay vì văng ra trình duyệt ngoài.

import { NextResponse, type NextRequest } from 'next/server';
import { listAccounts, getAccount, addAccount, removeAccount, renameAccount, setSignature, toPublic } from '@/lib/mailAccounts';
import {
  verifyImap, listFolders, listMessages, getMessage, getAttachment, sendMail, deleteMessage,
  markAllSeen, getNestedMessage, getNestedAttachment, ImapVerifyError,
} from '@/lib/mailServer';
import { listContacts, recordAddresses, removeContact, domainOf } from '@/lib/mailContacts';
import { findAccountByEmail, hasMailScope, authUrl as googleAuthUrl } from '@/lib/googleAuth';

export const runtime = 'nodejs';

/**
 * Làm sạch HTML chữ ký trước khi lưu.
 *
 * Chữ ký đi vào MAIL GỬI RA — tức là chạy trong mail client của NGƯỜI KHÁC. Dù
 * nội dung do chính chủ máy gõ (không phải input từ ngoài), vẫn phải lọc: người
 * dùng hay dán chữ ký từ webmail/Word cũ, kéo theo `<script>`, `onerror=`,
 * `javascript:` — thứ khiến mail bị đánh dấu spam hoặc bị gateway chặn thẳng.
 *
 * Chỉ giữ HTML trình bày: chữ, link, ảnh, bảng. Đây là allow-list ở mức thô
 * (bỏ thẻ nguy hiểm + mọi thuộc tính thực thi), không phải parser DOM đầy đủ —
 * đủ cho một ô chữ ký cục bộ, và không kéo thêm dependency.
 */
function sanitizeSignature(html: string): string {
  return html
    // Thẻ chạy code hoặc kéo nội dung ngoài — bỏ cả phần bên trong.
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    // Thẻ tự đóng của nhóm trên (vd <link ...>, <meta ...>).
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|form)\b[^>]*>/gi, '')
    // Handler on* (onclick, onerror, onload…) ở mọi kiểu nháy.
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // javascript:/vbscript: trong href/src.
    .replace(/(href|src)\s*=\s*(?:"\s*(?:javascript|vbscript):[^"]*"|'\s*(?:javascript|vbscript):[^']*'|(?:javascript|vbscript):[^\s>]+)/gi, '$1="#"')
    .slice(0, 20000); // chữ ký dài hơn mức này là dán nhầm cả trang
}

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
      // URL consent Google có kèm scope MAIL (https://mail.google.com/).
      // Tách khỏi /api/google 'authUrl' vì tab đó chỉ xin quyền Drive.
      case 'googleAuthUrl': {
        const hint = String(body.email ?? '').trim();
        result = { url: googleAuthUrl(['mail'], hint || undefined) };
        break;
      }
      case 'accountAdd': {
        const email = String(body.email ?? '').trim();
        if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Email không hợp lệ.');
        const pass = String(body.pass ?? '');
        if (!pass) throw new Error('Thiếu password.');
        const acc = {
          label: String(body.label ?? '').trim() || email,
          title: String(body.title ?? '').trim() || undefined,
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
      // Thêm hòm thư Gmail/Workspace bằng OAuth — KHÔNG cần App Password.
      // Điều kiện: đã đăng nhập tài khoản Google đó (tab Google hoặc nút
      // "Kết nối bằng Google") và tài khoản đã cấp scope mail.
      case 'accountAddOAuth': {
        const email = String(body.email ?? '').trim();
        if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Email không hợp lệ.');
        const g = await findAccountByEmail(email);
        if (!g) {
          throw new Error(`Chưa đăng nhập Google cho ${email} — bấm "Kết nối bằng Google" trước.`);
        }
        if (!(await hasMailScope(g.id))) {
          throw new Error(`Tài khoản ${email} chưa cấp quyền mail — bấm "Kết nối bằng Google" để cấp quyền IMAP/SMTP.`);
        }
        const acc = {
          label: String(body.label ?? '').trim() || email,
          title: String(body.title ?? '').trim() || undefined,
          email,
          user: email,
          pass: '',                       // OAuth: không lưu mật khẩu
          auth: 'oauth' as const,
          googleAccountId: g.id,
          // Gmail cố định; Workspace domain riêng cũng dùng chung endpoint này.
          imap: { host: 'imap.gmail.com', port: 993, secure: true },
          smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
        };
        // Vẫn login thử để chắc chắn token dùng được, không lưu account chết.
        await verifyImap({ ...acc, id: 'verify' });
        result = (await addAccount(acc)).map(toPublic);
        break;
      }
      case 'accountRename': {
        const patch: { title?: string; label?: string } = {};
        if (body.title !== undefined) patch.title = String(body.title);
        if (body.label !== undefined) patch.label = String(body.label);
        result = (await renameAccount(String(body.id ?? ''), patch)).map(toPublic);
        break;
      }
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
      case 'message': {
        const acc = await needAccount();
        const detail = await getMessage(acc, String(body.path ?? 'INBOX'), Number(body.uid));
        // Thu người GỬI vào address book NẾU cùng domain với tài khoản (đồng
        // nghiệp nội bộ). Domain khác → không tự lưu (UI có nút thủ công).
        const from = detail.from;
        if (from?.address && domainOf(from.address) === domainOf(acc.email)) {
          const label = from.name ? `${from.name} <${from.address}>` : from.address;
          void recordAddresses([label]).catch(() => {});
        }
        result = detail;
        break;
      }
      case 'nestedMessage': {
        // Mail chuyển tiếp đính kèm nguyên bản gốc (message/rfc822) — bóc ra
        // đọc ngay trong app thay vì tải file .eml về máy.
        const trail: number[] = Array.isArray(body.trail) ? body.trail.map(Number) : [];
        if (trail.some((n: number) => !Number.isInteger(n) || n < 0)) {
          throw new Error('Vị trí mail lồng không hợp lệ.');
        }
        result = await getNestedMessage(
          await needAccount(),
          String(body.path ?? 'INBOX'),
          Number(body.uid),
          trail,
        );
        break;
      }
      case 'markAllSeen':
        result = await markAllSeen(await needAccount(), String(body.path ?? 'INBOX'));
        break;
      case 'delete':
        // Xóa theo UID — không tải/parse nội dung nên an toàn với mail lừa đảo.
        result = await deleteMessage(
          await needAccount(),
          String(body.path ?? 'INBOX'),
          Number(body.uid),
        );
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
          html: typeof body.html === 'string' && body.html.trim() ? body.html : undefined,
          inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : undefined,
          references: Array.isArray(body.references) ? body.references.map(String) : undefined,
          attachments: Array.isArray(body.attachments)
            ? body.attachments.map((a: Record<string, unknown>) => ({
                filename: String(a.filename ?? 'attachment'),
                contentBase64: String(a.contentBase64 ?? ''),
                contentType: typeof a.contentType === 'string' ? a.contentType : undefined,
              }))
            : undefined,
          // Chuyển tiếp: chỉ gửi TOẠ ĐỘ của đính kèm gốc, server tự đọc lại từ
          // IMAP — client không phải tải về rồi upload ngược lên.
          forwardAttachments: Array.isArray(body.forwardAttachments)
            ? body.forwardAttachments.map((a: Record<string, unknown>) => ({
                path: String(a.path ?? 'INBOX'),
                uid: Number(a.uid),
                idx: Number(a.idx),
              }))
            : undefined,
        });
        // Thu MỌI địa chỉ đã gửi tới (To + Cc) — người mình chủ động liên hệ.
        void recordAddresses([...to.split(','), ...String(body.cc ?? '').split(',')].filter(Boolean)).catch(() => {});
        break;
      }
      case 'signatureSet': {
        // Chữ ký là HTML người dùng tự soạn — làm sạch TRƯỚC KHI LƯU (bỏ script,
        // handler on*, javascript: …). Xem sanitizeSignature.
        const raw = String(body.signature ?? '');
        result = (await setSignature(
          String(body.id ?? ''),
          sanitizeSignature(raw),
          typeof body.onReply === 'boolean' ? body.onReply : undefined,
        )).map(toPublic);
        break;
      }
      case 'contacts':
        result = await listContacts();
        break;
      case 'contactAdd':
        // Lưu thủ công một địa chỉ bất kỳ (kể cả domain khác).
        result = await recordAddresses([String(body.address ?? '')]);
        break;
      case 'contactRemove':
        result = await removeContact(String(body.email ?? ''));
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = (err as Error).message || 'Mail operation failed';
    // Lỗi verify IMAP mang theo phân loại + link khắc phục → client dựng UI
    // hành động được thay vì in một khối text.
    const failure = err instanceof ImapVerifyError ? err.failure : undefined;
    return NextResponse.json({ ok: false, error: msg, failure }, { status: 502 });
  }
}

/** Rút filename từ Content-Disposition (filename* ưu tiên) hoặc path của URL. */
function filenameFrom(cd: string | null, finalUrl: string): string {
  if (cd) {
    const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
    if (star) {
      try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* giữ fallback */ }
    }
    const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (plain) return plain[1].trim();
  }
  try {
    const seg = decodeURIComponent(new URL(finalUrl).pathname.split('/').filter(Boolean).pop() ?? '');
    if (seg) return seg;
  } catch { /* URL lạ */ }
  return 'download';
}

/**
 * Link trong body mail: server fetch hộ (http/https, follow redirect).
 *   probe    → chỉ đọc header, hủy body: URL này là FILE hay trang web?
 *   download → stream nguyên body về client như một file đính kèm.
 * Lưu ý: fetch không mang cookie đăng nhập của user — link cần session sẽ trả
 * trang login (probe nhận diện là trang web → client mở trình duyệt như cũ).
 */
async function fetchBodyLink(sp: URLSearchParams): Promise<NextResponse> {
  const url = sp.get('url') ?? '';
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, error: 'Chỉ hỗ trợ URL http/https.' }, { status: 400 });
  }
  const mode = sp.get('mode') === 'download' ? 'download' : 'probe';
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      // probe nhanh gọn; download cho phép file lớn/đường truyền chậm.
      signal: AbortSignal.timeout(mode === 'probe' ? 20_000 : 600_000),
      headers: { 'user-agent': 'VHS-DevBox mail viewer' },
    });
    const ct = res.headers.get('content-type') ?? '';
    const cd = res.headers.get('content-disposition');
    // File = server tự khai attachment, hoặc content-type không phải trang web.
    const isFile = /attachment/i.test(cd ?? '') || (!!ct && !/text\/html|application\/xhtml/i.test(ct));
    const filename = filenameFrom(cd, res.url || url);

    if (mode === 'probe') {
      void res.body?.cancel().catch(() => {});
      return NextResponse.json({
        ok: true,
        result: {
          file: res.ok && isFile,
          filename,
          contentType: ct,
          size: Number(res.headers.get('content-length')) || null,
        },
      });
    }
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `HTTP ${res.status} khi tải ${url}` }, { status: 502 });
    }
    return new NextResponse(res.body, {
      headers: {
        'content-type': ct || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}

/** Tải file đính kèm / fetch link body: xem doc đầu file. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.has('fetch')) return fetchBodyLink(sp);
  if (!sp.has('attachment')) {
    return NextResponse.json({ ok: false, error: 'Unknown GET' }, { status: 400 });
  }
  try {
    const account = await getAccount(sp.get('accountId') ?? '');
    // `trail` = đường đi vào mail lồng (vd "2" hay "2.0"). Có thì đính kèm nằm
    // TRONG mail chuyển tiếp, phải bóc từng lớp mới lấy được.
    const trailRaw = (sp.get('trail') ?? '').trim();
    const trail = trailRaw
      ? trailRaw.split('.').map(Number).filter((n) => Number.isInteger(n) && n >= 0)
      : [];
    const att = trail.length
      ? await getNestedAttachment(
          account,
          sp.get('path') ?? 'INBOX',
          Number(sp.get('uid')),
          trail,
          Number(sp.get('idx')),
        )
      : await getAttachment(
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
