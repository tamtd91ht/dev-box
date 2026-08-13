// Client-side helpers + shared types for the Mail tab. All calls go to the
// same-origin /api/mail route (the Next server holds IMAP/SMTP credentials —
// the browser never sees passwords). Browser-safe module.

export interface MailEndpointPublic { host: string; port: number; secure: boolean }

export interface MailAccountPub {
  id: string;
  /** Tên người GỬI — vào header From của mail gửi ra. */
  label: string;
  /** Tên QUẢN LÝ trong app (tab chọn tài khoản). Bỏ trống → dùng cả email. */
  title?: string;
  email: string;
  user: string;
  /** 'oauth' = đăng nhập bằng Google (XOAUTH2), không lưu mật khẩu. */
  auth?: 'password' | 'oauth';
  googleAccountId?: string;
  imap: MailEndpointPublic;
  smtp: MailEndpointPublic;
  /** Chữ ký cuối thư (HTML) — riêng từng tài khoản. */
  signature?: string;
  /** Có chèn chữ ký khi trả lời / chuyển tiếp không (mặc định có). */
  signatureOnReply?: boolean;
}

/** Tên hiển thị trên tab/badge: title tự đặt, hoặc CẢ địa chỉ email — không cắt
 *  prefix, vì user@example.com và user@gmail.com sẽ trông y hệt nhau. */
export function accTitle(a: Pick<MailAccountPub, 'title' | 'email'>): string {
  return a.title?.trim() || a.email;
}

export interface MailFolder {
  path: string;
  name: string;
  specialUse?: string;
  delimiter: string;
  /** Số mail chưa đọc (badge 🔔 trên rail thư mục). */
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
  /** Header gom chuỗi hội thoại (từ envelope IMAP). */
  messageId?: string | null;
  inReplyTo?: string | null;
}

/** Một chuỗi hội thoại đã gom: nhiều mail cùng chủ đề nối tiếp nhau. */
export interface MailThread {
  /** Khoá gom (message-id gốc hoặc tiêu đề đã chuẩn hoá). */
  key: string;
  /** Mail trong chuỗi, MỚI NHẤT trước — phần tử [0] là cái hiện ở dòng chính. */
  items: MailListItem[];
  /** Có mail nào chưa đọc không (dòng chuỗi in đậm như một mail chưa đọc). */
  unseen: boolean;
}

/** Bỏ mọi tiền tố Re:/Fwd:/RE:/TRẢ LỜI: … để hai mail cùng chủ đề gom về một
 *  khoá. Lặp vì thực tế hay gặp "Re: Fwd: Re: …". */
export function normalizeSubject(subject: string): string {
  let s = (subject || '').trim();
  for (;;) {
    const next = s.replace(/^\s*(re|fwd?|trả lời|chuyển tiếp)\s*(\[\d+\])?\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Gom danh sách mail thành các chuỗi hội thoại.
 *
 * Ưu tiên header thật (`inReplyTo` → `messageId`) vì đó là cách RFC định nghĩa
 * một thread; chỉ khi không lần được mới rơi về so tiêu đề đã chuẩn hoá. Chỉ
 * dựa vào tiêu đề thì hai mail "Báo cáo tuần" của hai tháng khác nhau sẽ bị
 * gộp oan, nên tiêu đề là phương án CUỐI chứ không phải đầu.
 *
 * Giữ nguyên thứ tự trước-sau của danh sách gốc (mới nhất trên đầu): chuỗi
 * xuất hiện ở đúng vị trí mail mới nhất của nó.
 */
export function groupThreads(items: MailListItem[]): MailThread[] {
  // message-id → khoá chuỗi. Mail trả lời kế thừa khoá của mail nó trả lời.
  const keyOfMsg = new Map<string, string>();
  const bySubject = new Map<string, string>();
  const threads = new Map<string, MailThread>();
  const order: string[] = [];

  // Duyệt từ CŨ tới MỚI để mail cha luôn được đăng ký khoá trước mail con.
  for (const m of [...items].reverse()) {
    const subjKey = normalizeSubject(m.subject);
    const parentKey = m.inReplyTo ? keyOfMsg.get(m.inReplyTo) : undefined;
    const key = parentKey
      ?? (subjKey ? bySubject.get(subjKey) : undefined)
      ?? m.messageId
      ?? `uid:${m.uid}`;

    if (m.messageId) keyOfMsg.set(m.messageId, key);
    if (subjKey && !bySubject.has(subjKey)) bySubject.set(subjKey, key);

    const t = threads.get(key);
    if (t) {
      t.items.unshift(m);           // danh sách trong chuỗi: mới nhất trước
      t.unseen = t.unseen || !m.seen;
    } else {
      threads.set(key, { key, items: [m], unseen: !m.seen });
      order.push(key);
    }
  }

  // order đang theo chiều cũ→mới; đảo lại để chuỗi mới nhất lên đầu.
  return order.reverse().map((k) => threads.get(k)!).filter(Boolean);
}

export interface MailListPage {
  items: MailListItem[];
  total: number;
  oldestSeq: number | null;
}

export interface MailAddress { name: string; address: string }

export interface MailAttachmentInfo {
  idx: number;
  filename: string;
  contentType: string;
  size: number;
  /** true = đính kèm này LÀ MỘT MAIL (message/rfc822) — thư chuyển tiếp đính
   *  kèm bản gốc. UI mở nó bằng khung đọc mail thay vì nút tải file. */
  nested?: boolean;
}

export interface MailDetail {
  uid: number;
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  date: string | null;
  html: string | null;
  text: string | null;
  attachments: MailAttachmentInfo[];
  messageId: string | null;
  references: string[];
  inReplyTo?: string | null;
}

export interface AccountAddInput {
  /** Tên người gửi (header From). */
  label?: string;
  /** Tên quản lý trên tab chọn tài khoản. */
  title?: string;
  email: string;
  user?: string;
  pass: string;
  imapHost: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
}

export interface SendAttachment {
  filename: string;
  contentBase64: string;
  contentType?: string;
}

/** Đính kèm giữ lại khi CHUYỂN TIẾP: chỉ gửi toạ độ, server tự đọc từ IMAP. */
export interface ForwardAttachmentRef {
  path: string;
  uid: number;
  idx: number;
}

export interface SendInput {
  accountId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  /** Bản HTML — có thì gửi multipart/alternative (text + html). */
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: SendAttachment[];
  forwardAttachments?: ForwardAttachmentRef[];
}

/** Phân loại lỗi IMAP server gửi kèm (mirror của ImapFailure ở mailServer). */
export interface ImapFailureInfo {
  kind: 'auth' | 'app-password' | 'imap-disabled' | 'dns' | 'refused' | 'timeout' | 'tls' | 'unknown';
  title: string;
  steps: string[];
  focus?: 'pass' | 'email' | 'imapHost' | 'imapPort';
  links: { label: string; url: string }[];
  detail: string;
}

export type MailActionError = Error & { status?: number; failure?: ImapFailureInfo };

async function mailAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/mail', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    const err = new Error((data as { error?: string }).error || `HTTP ${r.status}`) as MailActionError;
    err.status = r.status;
    // Lỗi verify IMAP kèm phân loại → UI dựng nút/link khắc phục.
    err.failure = (data as { failure?: ImapFailureInfo }).failure;
    throw err;
  }
  return (data as { result: T }).result;
}

export const mAccounts = () => mailAction<MailAccountPub[]>('accounts');
export const mAccountAdd = (input: AccountAddInput) => mailAction<MailAccountPub[]>('accountAdd', { ...input });
export const mAccountRemove = (id: string) => mailAction<MailAccountPub[]>('accountRemove', { id });
/** Thêm hòm thư Gmail/Workspace bằng OAuth — không cần App Password. */
export const mAccountAddOAuth = (email: string, meta: { label?: string; title?: string } = {}) =>
  mailAction<MailAccountPub[]>('accountAddOAuth', { email, ...meta });
/** URL consent Google kèm scope mail (XOAUTH2 cho IMAP/SMTP). */
export const mGoogleAuthUrl = (email?: string) =>
  mailAction<{ url: string }>('googleAuthUrl', { email });
/** Đổi tên tài khoản. title = tên quản lý trên tab; label = tên người gửi (From). */
export const mAccountRename = (id: string, patch: { title?: string; label?: string }) =>
  mailAction<MailAccountPub[]>('accountRename', { id, ...patch });
export const mFolders = (accountId: string) => mailAction<MailFolder[]>('folders', { accountId });
export const mList = (accountId: string, path: string, beforeSeq?: number) =>
  mailAction<MailListPage>('list', { accountId, path, beforeSeq });
export const mMessage = (accountId: string, path: string, uid: number) =>
  mailAction<MailDetail>('message', { accountId, path, uid });
/** Mở MAIL LỒNG bên trong một mail (thư chuyển tiếp đính kèm bản gốc).
 *  `trail` = vị trí đính kèm qua từng lớp lồng, vd [2] hoặc [2,0]. */
export const mNestedMessage = (accountId: string, path: string, uid: number, trail: number[]) =>
  mailAction<MailDetail>('nestedMessage', { accountId, path, uid, trail });
/** Đặt chữ ký (HTML) cho một tài khoản. Chuỗi rỗng = bỏ chữ ký. */
export const mSignatureSet = (id: string, signature: string, onReply?: boolean) =>
  mailAction<MailAccountPub[]>('signatureSet', { id, signature, onReply });
export const mSend = (input: SendInput) => mailAction<{ messageId: string }>('send', { ...input });
/** Xóa mail theo UID (move Trash; đang ở Trash → xóa vĩnh viễn) — không đọc nội dung. */
export const mDelete = (accountId: string, path: string, uid: number) =>
  mailAction<{ mode: 'trash' | 'purged'; trashPath?: string }>('delete', { accountId, path, uid });
/** Đánh dấu toàn bộ mail trong folder là đã đọc. */
export const mMarkAllSeen = (accountId: string, path: string) =>
  mailAction<{ marked: number }>('markAllSeen', { accountId, path });

export interface MailContact { email: string; name?: string; count: number; lastSeen: string }
export const mContacts = () => mailAction<MailContact[]>('contacts');
export const mContactAdd = (address: string) => mailAction<MailContact[]>('contactAdd', { address });
export const mContactRemove = (email: string) => mailAction<MailContact[]>('contactRemove', { email });

/** URL tải một đính kèm. `trail` khác rỗng = đính kèm nằm TRONG mail lồng
 *  (thư chuyển tiếp) — server bóc từng lớp theo đường đi này rồi mới lấy file. */
export const attachmentUrl = (
  accountId: string, path: string, uid: number, idx: number, trail: number[] = [],
) =>
  `/api/mail?attachment&accountId=${encodeURIComponent(accountId)}&path=${encodeURIComponent(path)}&uid=${uid}&idx=${idx}`
  + (trail.length ? `&trail=${trail.join('.')}` : '');

/** Icon theo specialUse / tên folder. */
export function folderIcon(f: MailFolder): string {
  if (f.path.toUpperCase() === 'INBOX') return '📥';
  switch (f.specialUse) {
    case '\\Sent': return '📤';
    case '\\Drafts': return '📝';
    case '\\Trash': return '🗑️';
    case '\\Junk': return '🚫';
    case '\\Archive': return '📦';
    default: return '📁';
  }
}

export function fmtAddr(a: MailAddress | null): string {
  if (!a) return '';
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
