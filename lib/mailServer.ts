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
import { getMailAccessToken } from './googleAuth';

/** Thông tin đăng nhập cho một kết nối — mật khẩu HOẶC access token (XOAUTH2).
 *  Gọi ngay trước mỗi lần connect vì access token chỉ sống ~1 giờ. */
async function authFor(account: MailAccount): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (account.auth === 'oauth') {
    if (!account.googleAccountId) {
      throw new Error('Tài khoản mail này khai dùng OAuth nhưng chưa gắn tài khoản Google — kết nối lại.');
    }
    // Token được refresh tự động bởi googleAuth khi hết hạn.
    return { user: account.user, accessToken: await getMailAccessToken(account.googleAccountId) };
  }
  return { user: account.user, pass: account.pass };
}

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

export interface SendAttachment {
  filename: string;
  /** Nội dung base64 (client đọc file → base64). */
  contentBase64: string;
  contentType?: string;
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
  attachments?: SendAttachment[];
}

// ── IMAP helpers ────────────────────────────────────────────────────────────

async function withImap<T>(
  account: MailAccount,
  fn: (client: ImapFlow) => Promise<T>,
  /** Nhận log của ImapFlow — chỉ dùng khi verify để báo lỗi chi tiết. */
  onLog?: (entry: Record<string, unknown>) => void,
): Promise<T> {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    // pass HOẶC accessToken (XOAUTH2) — imapflow tự chọn cơ chế theo field có mặt.
    auth: await authFor(account),
    // logger: false ở đường chạy thường (khỏi ồn + khỏi rò mật khẩu vào log).
    // Khi verify thì bắt log để lấy đúng câu server từ chối.
    logger: onLog
      ? { debug: () => {}, info: (o) => onLog(o as Record<string, unknown>), warn: (o) => onLog(o as Record<string, unknown>), error: (o) => onLog(o as Record<string, unknown>) }
      : false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Verify credentials by connecting + logging in (dùng khi thêm tài khoản).
 *  Lỗi thô của ImapFlow rất cụt ("Invalid credentials (Failure)") nên ở đây
 *  dịch sang thông báo có ĐỦ ngữ cảnh: host/port đang thử, phản hồi thật của
 *  server, và cách sửa cho từng nhà cung cấp (Gmail cần App Password…). */
export class ImapVerifyError extends Error {
  constructor(readonly failure: ImapFailure) {
    super(failure.title);
    this.name = 'ImapVerifyError';
  }
}

export async function verifyImap(account: MailAccount): Promise<void> {
  // Giữ vài dòng log cuối của server — câu từ chối thật thường nằm ở đây.
  const tail: string[] = [];
  const onLog = (o: Record<string, unknown>) => {
    const msg = [o.msg, o.err, o.responseText].filter((v) => typeof v === 'string').join(' ');
    // KHÔNG ghi dòng chứa lệnh LOGIN (có mật khẩu trong đó).
    if (msg && !/\blogin\b|\bauthenticate\b/i.test(msg)) {
      tail.push(msg);
      if (tail.length > 6) tail.shift();
    }
  };
  try {
    await withImap(account, async () => undefined, onLog);
  } catch (err) {
    // Kèm dữ liệu có cấu trúc để UI dựng nút/link khắc phục, đồng thời message
    // vẫn là text đầy đủ cho log và cho caller cũ.
    const failure = classifyImapError(err, account, tail);
    const e = new ImapVerifyError(failure);
    e.message = explainImapError(err, account, tail);
    throw e;
  }
}

/** Phân loại lỗi IMAP để UI chọn ĐÚNG cách khắc phục (nút bấm, link, ô cần
 *  sửa) thay vì in một bức tường chữ. Client không đoán bằng regex nữa. */
export type ImapFailKind =
  | 'auth'          // sai user/pass — Gmail thường là do chưa dùng App Password
  | 'app-password'  // chắc chắn cần App Password (Gmail + auth fail)
  | 'imap-disabled' // server nói IMAP bị tắt
  | 'dns'           // sai tên host
  | 'refused'       // sai cổng / firewall
  | 'timeout'
  | 'tls'           // lệch chế độ mã hóa hoặc cert sai
  | 'unknown';

export interface ImapFailure {
  kind: ImapFailKind;
  /** Một câu ngắn hiện to trong UI. */
  title: string;
  /** Các bước/ghi chú — UI render thành list, không phải một khối text. */
  steps: string[];
  /** Field nên focus lại để sửa: 'pass' | 'email' | 'imapHost' | 'imapPort'. */
  focus?: 'pass' | 'email' | 'imapHost' | 'imapPort';
  /** Link mở ngoài kèm nhãn nút. */
  links: { label: string; url: string }[];
  /** Chi tiết kỹ thuật — gập lại, chỉ mở khi cần tra. */
  detail: string;
}

/** Gom mọi manh mối một lỗi IMAP mang theo thành chuỗi đọc được. */
function errorDetail(err: unknown): { code: string; text: string; raw: string } {
  const e = (err ?? {}) as {
    code?: string; responseText?: string; response?: string;
    authenticationFailed?: boolean; serverResponseCode?: string; message?: string;
  };
  return {
    code: String(e.code ?? e.serverResponseCode ?? ''),
    // responseText = câu server trả về, thứ hữu ích nhất mà ImapFlow hay che đi.
    text: String(e.responseText ?? e.response ?? ''),
    raw: String(e.message ?? err ?? 'Unknown error'),
  };
}

/** Lỗi IMAP → dữ liệu CÓ CẤU TRÚC để UI dựng giao diện khắc phục.
 *  Đây là hàm chính; explainImapError chỉ là bản làm phẳng thành text cho log
 *  và cho chỗ nào chưa kịp dùng UI mới. */
export function classifyImapError(
  err: unknown, account: MailAccount, serverLog: string[] = [],
): ImapFailure {
  const { code, text, raw } = errorDetail(err);
  const where = `${account.imap.host}:${account.imap.port} (${account.imap.secure ? 'TLS' : 'STARTTLS/plain'})`;
  const host = account.imap.host.toLowerCase();
  const isGmail = /(^|\.)gmail\.com$|(^|\.)googlemail\.com$/.test(host) || /google/.test(host);
  const blob = `${code} ${text} ${raw}`.toLowerCase();
  const authFailed =
    Boolean((err as { authenticationFailed?: boolean })?.authenticationFailed) ||
    code === 'AUTHENTICATIONFAILED' ||
    /invalid credentials|authenticationfailed|auth.*fail|login fail/.test(blob);

  const detail = [
    // Luôn ghi host:port đã thử — kể cả khi tiêu đề không nhắc (vd lỗi Gmail),
    // để còn biết đang nói về server nào khi đọc log/nhờ hỗ trợ.
    `đã thử ${where} · user ${account.user}`,
    code && `mã ${code}`,
    text && `server: "${text}"`,
    raw && `chi tiết: ${raw}`,
    !text && serverLog.length > 0 && `log server: ${serverLog.join(' | ')}`,
  ].filter(Boolean).join(' · ');

  const F = (f: Omit<ImapFailure, 'detail'>): ImapFailure => ({ ...f, detail });

  // IMAP bị tắt — Gmail trả câu rất riêng, nhận ra được thì khỏi bắt người dùng
  // đi thử mật khẩu vô ích.
  if (/imap access is disabled|imap is disabled|not enabled for imap/.test(blob)) {
    return F({
      kind: 'imap-disabled',
      title: 'Hòm thư này đang TẮT quyền truy cập IMAP.',
      steps: [
        'Mật khẩu của bạn có thể vẫn đúng — server đơn giản là không cho IMAP kết nối.',
        isGmail
          ? 'Vào Gmail → Settings → Forwarding and POP/IMAP → chọn "Enable IMAP" → Save.'
          : 'Bật IMAP trong phần cài đặt webmail, hoặc nhờ admin mở quyền IMAP.',
        'Nếu là tài khoản Google Workspace của công ty, admin có thể đã tắt IMAP toàn tổ chức.',
      ],
      links: isGmail ? [{ label: 'Mở cài đặt Gmail', url: 'https://mail.google.com/mail/u/0/#settings/fwdandpop' }] : [],
    });
  }

  // Hòm thư OAuth: token hỏng/bị thu hồi — KHÔNG được khuyên đi tạo App
  // Password (nó không liên quan, và Workspace thường đã tắt tính năng đó).
  if (authFailed && account.auth === 'oauth') {
    return F({
      kind: 'auth',
      title: 'Google từ chối token của hòm thư này.',
      steps: [
        'Quyền có thể đã bị thu hồi, hoặc token không còn hiệu lực.',
        'Bấm "Kết nối bằng Google" để cấp quyền lại cho địa chỉ này.',
        'Nếu là tài khoản công ty, admin Workspace có thể đã tắt truy cập IMAP.',
      ],
      links: [{ label: 'Xem quyền đã cấp', url: 'https://myaccount.google.com/permissions' }],
    });
  }

  if (authFailed && isGmail) {
    return F({
      kind: 'app-password',
      title: 'Gmail từ chối mật khẩu này.',
      steps: [
        'CÁCH TỐT NHẤT: xóa hòm thư này rồi thêm lại bằng nút "Kết nối bằng Google" — không cần mật khẩu.',
        'Gmail không cho dùng mật khẩu Google thường cho IMAP; chỉ App Password (16 ký tự) mới được.',
        'Nếu trang App Password báo "not available for your account" thì công ty đã TẮT tính năng này → buộc phải dùng OAuth.',
        'Đã dùng App Password mà vẫn bị từ chối → kiểm tra IMAP đã bật chưa.',
      ],
      focus: 'pass',
      links: [
        { label: 'Tạo App Password', url: 'https://myaccount.google.com/apppasswords' },
        { label: 'Bật xác minh 2 bước', url: 'https://myaccount.google.com/signinoptions/two-step-verification' },
        { label: 'Bật IMAP trong Gmail', url: 'https://mail.google.com/mail/u/0/#settings/fwdandpop' },
      ],
    });
  }

  if (authFailed) {
    return F({
      kind: 'auth',
      title: `Server từ chối đăng nhập tại ${where}.`,
      steps: [
        'Kiểm tra lại mật khẩu (bấm 👁 để soi chuỗi vừa nhập).',
        'Một số server đòi username KHÔNG có @domain — thử chỉ phần trước @.',
        'Tài khoản có thể đã bị khóa tạm do đăng nhập sai nhiều lần.',
      ],
      focus: 'pass',
      links: [],
    });
  }

  if (/certificate|self.signed|altname|depth zero|unable to verify/.test(blob)) {
    return F({
      kind: 'tls',
      title: `Chứng chỉ TLS của ${where} không hợp lệ hoặc không khớp tên host.`,
      steps: ['Thường do host gõ sai, hoặc server dùng cert tự ký.'],
      focus: 'imapHost',
      links: [],
    });
  }
  if (/enotfound|eai_again|getaddrinfo/.test(blob)) {
    return F({
      kind: 'dns',
      title: `Không tìm thấy host "${account.imap.host}".`,
      steps: ['Kiểm tra chính tả tên host.', 'Mail server nội bộ có thể cần VPN mới thấy.'],
      focus: 'imapHost',
      links: [],
    });
  }
  if (/econnrefused/.test(blob)) {
    return F({
      kind: 'refused',
      title: `Server từ chối kết nối tới ${where}.`,
      steps: ['Sai cổng? 993 = TLS, 143 = STARTTLS/plain.', 'Hoặc firewall đang chặn.'],
      focus: 'imapPort',
      links: [],
    });
  }
  if (/etimedout|timeout|timed out/.test(blob)) {
    return F({
      kind: 'timeout',
      title: `Kết nối tới ${where} quá thời gian chờ.`,
      steps: ['Firewall/VPN đang chặn, hoặc sai cổng.', 'Thử cổng 993 (TLS).'],
      focus: 'imapPort',
      links: [],
    });
  }
  if (/wrong version number|ssl|eproto|packet length/.test(blob)) {
    return F({
      kind: 'tls',
      title: `Bắt tay TLS thất bại với ${where}.`,
      steps: ['Nhầm chế độ mã hóa: cổng 993 phải TLS, cổng 143 phải STARTTLS.'],
      focus: 'imapPort',
      links: [],
    });
  }

  return F({
    kind: 'unknown',
    title: `Không kết nối được IMAP tới ${where}.`,
    steps: ['Xem chi tiết kỹ thuật bên dưới để tra nguyên nhân.'],
    links: [],
  });
}

/** Bản LÀM PHẲNG của classifyImapError thành text — dùng cho log và cho chỗ
 *  nào chỉ hiển thị được một chuỗi. UI mới nên dùng classifyImapError. */
export function explainImapError(err: unknown, account: MailAccount, serverLog: string[] = []): string {
  const f = classifyImapError(err, account, serverLog);
  const lines = [f.title];
  if (f.steps.length) lines.push('', ...f.steps.map((s) => `• ${s}`));
  if (f.links.length) lines.push('', ...f.links.map((l) => `${l.label}: ${l.url}`));
  if (f.detail) lines.push('', `— ${f.detail}`);
  return lines.join('\n');
}

/** STATUS INBOX {unseen} — số mail đến chưa đọc, cho tiến trình nền mailWatch. */
export async function inboxUnseen(account: MailAccount): Promise<number> {
  return withImap(account, async (client) => (await client.status('INBOX', { unseen: true })).unseen ?? 0);
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

/** Đánh dấu TOÀN BỘ mail trong folder là đã đọc (\Seen) — nút "Đánh dấu tất cả đã đọc". */
export async function markAllSeen(account: MailAccount, path: string): Promise<{ marked: number }> {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      const mailbox = client.mailbox;
      const total = mailbox && typeof mailbox === 'object' ? mailbox.exists : 0;
      if (!total) return { marked: 0 };
      await client.messageFlagsAdd('1:*', ['\\Seen']);
      return { marked: total };
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

/** Tìm folder Trash của hộp thư: ưu tiên special-use \Trash, fallback theo tên. */
async function findTrashPath(client: ImapFlow): Promise<string | null> {
  const boxes = (await client.list()) as ListResponse[];
  const byUse = boxes.find((b) => b.specialUse === '\\Trash');
  if (byUse) return byUse.path;
  const NAMES = ['trash', 'deleted items', 'deleted messages', 'thùng rác'];
  const byName = boxes.find((b) => NAMES.includes(b.name.toLowerCase()) || NAMES.includes(b.path.toLowerCase()));
  return byName?.path ?? null;
}

/**
 * Xóa 1 mail — hành vi mail client chuẩn, an toàn cho mail lừa đảo (KHÔNG cần
 * mở/parse nội dung, chỉ thao tác UID):
 *   · folder thường  → MOVE vào Trash (còn cứu được nếu xóa nhầm)
 *   · đang ở Trash / server không có Trash → \Deleted + EXPUNGE (xóa vĩnh viễn)
 */
export async function deleteMessage(
  account: MailAccount,
  path: string,
  uid: number,
): Promise<{ mode: 'trash' | 'purged'; trashPath?: string }> {
  return withImap(account, async (client) => {
    const trash = await findTrashPath(client);
    const lock = await client.getMailboxLock(path);
    try {
      if (trash && trash !== path) {
        await client.messageMove(String(uid), trash, { uid: true });
        return { mode: 'trash' as const, trashPath: trash };
      }
      await client.messageDelete(String(uid), { uid: true });
      return { mode: 'purged' as const };
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
  const cred = await authFor(account);
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    // XOAUTH2: nodemailer cần type:'OAuth2' + accessToken (không tự suy ra như imapflow).
    auth: cred.accessToken
      ? { type: 'OAuth2' as const, user: cred.user, accessToken: cred.accessToken }
      : { user: cred.user, pass: cred.pass },
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
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.contentBase64, 'base64'),
      contentType: a.contentType || undefined,
    })),
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
