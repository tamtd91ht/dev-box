// Client-side helpers + shared types for the Mail tab. All calls go to the
// same-origin /api/mail route (the Next server holds IMAP/SMTP credentials —
// the browser never sees passwords). Browser-safe module.

export interface MailEndpointPublic { host: string; port: number; secure: boolean }

export interface MailAccountPub {
  id: string;
  label: string;
  email: string;
  user: string;
  imap: MailEndpointPublic;
  smtp: MailEndpointPublic;
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
  label?: string;
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

async function mailAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/mail', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    const err = new Error((data as { error?: string }).error || `HTTP ${r.status}`);
    (err as Error & { status?: number }).status = r.status;
    throw err;
  }
  return (data as { result: T }).result;
}

export const mAccounts = () => mailAction<MailAccountPub[]>('accounts');
export const mAccountAdd = (input: AccountAddInput) => mailAction<MailAccountPub[]>('accountAdd', { ...input });
export const mAccountRemove = (id: string) => mailAction<MailAccountPub[]>('accountRemove', { id });
export const mFolders = (accountId: string) => mailAction<MailFolder[]>('folders', { accountId });
export const mList = (accountId: string, path: string, beforeSeq?: number) =>
  mailAction<MailListPage>('list', { accountId, path, beforeSeq });
export const mMessage = (accountId: string, path: string, uid: number) =>
  mailAction<MailDetail>('message', { accountId, path, uid });
export const mSend = (input: SendInput) => mailAction<{ messageId: string }>('send', { ...input });
/** Xóa mail theo UID (move Trash; đang ở Trash → xóa vĩnh viễn) — không đọc nội dung. */
export const mDelete = (accountId: string, path: string, uid: number) =>
  mailAction<{ mode: 'trash' | 'purged'; trashPath?: string }>('delete', { accountId, path, uid });

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
