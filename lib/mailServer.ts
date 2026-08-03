// Server-side mail operations for the Mail tab — IMAP (imapflow) để XEM,
// SMTP (nodemailer) để GỬI/PHẢN HỒI. Toàn bộ chạy trong Next API route;
// credentials không bao giờ rời server process.
//
// Mỗi request mở một kết nối IMAP mới rồi đóng (withImap) — đơn giản, không
// giữ pool; độ trễ connect+login với Zimbra LAN/VN là chấp nhận được cho tool
// nội bộ. Nếu sau này chậm, thêm cache kết nối theo accountId ở đây.

import { ImapFlow, type ListResponse } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { MailAccount } from './mailAccounts';

// ── Types trả về cho client ─────────────────────────────────────────────────

export interface MailFolder {
  path: string;
  name: string;
  /** \Inbox \Sent \Drafts \Trash \Junk … (nếu server khai báo). */
  specialUse?: string;
  delimiter: string;
  /** Số mail CHƯA ĐỌC trong folder (IMAP STATUS UNSEEN) — badge 🔔 trên rail. */
  unseen: number;
}

export interface MailListItem {
  uid: number;
  seq: number;
  subject: string;
  from: { name: string; address: string } | null;
  date: string | null;
  seen: boolean;
  answered: boolean;
  hasAttachments: boolean;
}

export interface MailListPage {
  items: MailListItem[];
  /** Tổng số mail trong folder (để phân trang). */
  total: number;
  /** seq nhỏ nhất đã trả — truyền lại làm beforeSeq để tải trang cũ hơn. */
  oldestSeq: number | null;
}

export interface MailAddress { name: string; address: string }

export interface MailDetail {
  uid: number;
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  date: string | null;
  /** HTML body (đã có sẵn từ mail) hoặc null nếu chỉ có text. */
  html: string | null;
  text: string | null;
  attachments: { idx: number; filename: string; contentType: string; size: number }[];
  /** Header phục vụ reply đúng thread. */
  messageId: string | null;
  references: string[];
}

export interface SendInput {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  /** Reply: message-id của mail gốc + chuỗi references của nó. */
  inReplyTo?: string;
  references?: string[];
}

// ── IMAP helpers ────────────────────────────────────────────────────────────

async function withImap<T>(account: MailAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Verify credentials by connecting + logging in (dùng khi thêm tài khoản). */
export async function verifyImap(account: MailAccount): Promise<void> {
  await withImap(account, async () => undefined);
}

const FOLDER_ORDER: Record<string, number> = {
  '\\Inbox': 0, '\\Sent': 1, '\\Drafts': 2, '\\Junk': 3, '\\Trash': 4, '\\Archive': 5,
};

export async function listFolders(account: MailAccount): Promise<MailFolder[]> {
  return withImap(account, async (client) => {
    const boxes = await client.list();
    const folders: MailFolder[] = [];
    for (const b of boxes as ListResponse[]) {
      // STATUS UNSEEN từng folder — bỏ qua folder \Noselect (container thuần).
      let unseen = 0;
      if (!b.flags?.has('\\Noselect')) {
        try {
          unseen = (await client.status(b.path, { unseen: true })).unseen ?? 0;
        } catch {
          /* folder không STATUS được (quyền/ảo) — coi như 0 */
        }
      }
      folders.push({
        path: b.path,
        name: b.name,
        specialUse: b.specialUse,
        delimiter: b.delimiter ?? '/',
        unseen,
      });
    }
    // INBOX + special-use lên đầu, còn lại theo alphabet.
    return folders.sort((a, b) => {
      const sa = a.path.toUpperCase() === 'INBOX' ? 0 : FOLDER_ORDER[a.specialUse ?? ''] ?? 9;
      const sb = b.path.toUpperCase() === 'INBOX' ? 0 : FOLDER_ORDER[b.specialUse ?? ''] ?? 9;
      return sa !== sb ? sa - sb : a.path.localeCompare(b.path);
    });
  });
}

const PAGE = 50;

/** Trang mail mới nhất của folder (hoặc trang cũ hơn khi truyền beforeSeq). */
export async function listMessages(account: MailAccount, path: string, beforeSeq?: number): Promise<MailListPage> {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      const mailbox = client.mailbox;
      const total = mailbox && typeof mailbox === 'object' ? mailbox.exists : 0;
      const hi = beforeSeq ? beforeSeq - 1 : total;
      if (!total || hi < 1) return { items: [], total, oldestSeq: null };
      const lo = Math.max(1, hi - PAGE + 1);

      const items: MailListItem[] = [];
      for await (const msg of client.fetch(`${lo}:${hi}`, {
        uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true,
      })) {
        const env = msg.envelope;
        const from = env?.from?.[0];
        // Đính kèm: quét bodyStructure tìm node có disposition attachment.
        let hasAttachments = false;
        const walk = (node: unknown) => {
          if (!node || typeof node !== 'object') return;
          const n = node as { disposition?: string; childNodes?: unknown[] };
          if ((n.disposition ?? '').toLowerCase() === 'attachment') hasAttachments = true;
          n.childNodes?.forEach(walk);
        };
        walk(msg.bodyStructure);

        items.push({
          uid: msg.uid,
          seq: msg.seq,
          subject: env?.subject ?? '(không tiêu đề)',
          from: from ? { name: from.name ?? '', address: from.address ?? '' } : null,
          date: (() => {
            const d = msg.internalDate ?? env?.date;
            return d ? new Date(d).toISOString() : null;
          })(),
          seen: msg.flags?.has('\\Seen') ?? false,
          answered: msg.flags?.has('\\Answered') ?? false,
          hasAttachments,
        });
      }
      items.sort((a, b) => b.seq - a.seq); // mới nhất lên đầu
      return { items, total, oldestSeq: lo };
    } finally {
      lock.release();
    }
  });
}

function addrList(v: ParsedMail['to']): MailAddress[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.flatMap((a) => a.value.map((x) => ({ name: x.name ?? '', address: x.address ?? '' })));
}

/** Tải + parse 1 mail; đồng thời đánh dấu đã đọc (\Seen) — hành vi mail client. */
export async function getMessage(account: MailAccount, path: string, uid: number): Promise<MailDetail> {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      const dl = await client.download(String(uid), undefined, { uid: true });
      if (!dl?.content) throw new Error('Không tải được nội dung mail.');
      const chunks: Buffer[] = [];
      for await (const c of dl.content) chunks.push(c as Buffer);
      const parsed = await simpleParser(Buffer.concat(chunks));

      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {});

      const refs = Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references ? [parsed.references] : [];

      return {
        uid,
        subject: parsed.subject ?? '(không tiêu đề)',
        from: addrList(parsed.from)[0] ?? null,
        to: addrList(parsed.to),
        cc: addrList(parsed.cc),
        date: parsed.date?.toISOString() ?? null,
        html: typeof parsed.html === 'string' ? parsed.html : null,
        text: parsed.text ?? null,
        attachments: parsed.attachments.map((a, idx) => ({
          idx,
          filename: a.filename ?? `attachment-${idx}`,
          contentType: a.contentType,
          size: a.size,
        })),
        messageId: parsed.messageId ?? null,
        references: refs,
      };
    } finally {
      lock.release();
    }
  });
}

/** Một attachment (buffer + meta) để stream về client. */
export async function getAttachment(account: MailAccount, path: string, uid: number, idx: number) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      const dl = await client.download(String(uid), undefined, { uid: true });
      if (!dl?.content) throw new Error('Không tải được nội dung mail.');
      const chunks: Buffer[] = [];
      for await (const c of dl.content) chunks.push(c as Buffer);
      const parsed = await simpleParser(Buffer.concat(chunks));
      const att = parsed.attachments[idx];
      if (!att) throw new Error('Không tìm thấy file đính kèm.');
      return { filename: att.filename ?? `attachment-${idx}`, contentType: att.contentType, content: att.content };
    } finally {
      lock.release();
    }
  });
}

// ── SMTP ────────────────────────────────────────────────────────────────────

/** Gửi mail (mới hoặc reply). Sau khi gửi, best-effort APPEND bản copy vào
 *  folder \Sent qua IMAP — SMTP tự nó KHÔNG lưu Sent; thiếu bước này thì
 *  webmail sẽ không thấy mail đã gửi từ DevBox. */
export async function sendMail(account: MailAccount, input: SendInput): Promise<{ messageId: string }> {
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.pass },
  });

  // Compose ra raw MIME một lần: gửi qua SMTP và append y nguyên vào Sent —
  // hai bản đảm bảo giống nhau, và với `raw` nodemailer KHÔNG tự parse nên
  // envelope phải lấy từ bản compose.
  const composed = new MailComposer({
    from: { name: account.label, address: account.email },
    to: input.to,
    cc: input.cc || undefined,
    bcc: input.bcc || undefined,
    subject: input.subject,
    text: input.text,
    inReplyTo: input.inReplyTo || undefined,
    references: input.references?.length ? input.references.join(' ') : undefined,
  }).compile();
  const envelope = composed.getEnvelope();
  const raw = await composed.build();

  const info = await transport.sendMail({ envelope, raw });

  // Copy vào Sent — tìm folder specialUse \Sent, fallback tên "Sent".
  try {
    await withImap(account, async (client) => {
      const boxes = await client.list();
      const sent = boxes.find((b) => b.specialUse === '\\Sent')
        ?? boxes.find((b) => /^sent$/i.test(b.name));
      if (sent) await client.append(sent.path, raw.toString('utf8'), ['\\Seen']);
    });
  } catch {
    /* Sent copy là best-effort — mail ĐÃ gửi thành công. */
  }

  return { messageId: info.messageId ?? composed.messageId() };
}
