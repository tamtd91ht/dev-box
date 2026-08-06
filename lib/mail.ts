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
}

export interface MailListPage {
  items: MailListItem[];
  total: number;
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
  html: string | null;
  text: string | null;
  attachments: { idx: number; filename: string; contentType: string; size: number }[];
  messageId: string | null;
  references: string[];
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

export interface SendInput {
  accountId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: SendAttachment[];
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

export const attachmentUrl = (accountId: string, path: string, uid: number, idx: number) =>
  `/api/mail?attachment&accountId=${encodeURIComponent(accountId)}&path=${encodeURIComponent(path)}&uid=${uid}&idx=${idx}`;

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
