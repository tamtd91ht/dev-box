// Per-machine registry of mail accounts for the Mail tab — IMAP/SMTP chuẩn,
// dùng được cho MỌI mail server (Zimbra mail.example.com, Gmail app
// password, Outlook, …), không riêng nhà cung cấp nào. Same shape as the other
// JSON registries (.googleroots.json, …): a small gitignored file in cwd,
// full-file read/write.
//
// Password nằm plaintext trong file gitignored trên máy cá nhân — cùng mức
// bảo mật với .googleauth.json (refresh token). KHÔNG commit, không sync.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';

export interface MailEndpoint {
  host: string;
  port: number;
  /** true = TLS ngay từ đầu (993/465); false = STARTTLS/plain (143/587). */
  secure: boolean;
}

export interface MailAccount {
  id: string;
  /** Tên người GỬI — đi vào header From của mail gửi ra (mailServer.ts).
   *  KHÁC `title`: đổi cái này là người nhận thấy khác. */
  label: string;
  /** Tên để QUẢN LÝ trong app — hiện trên tab chọn tài khoản, badge thông báo.
   *  Không ảnh hưởng mail gửi ra. Bỏ trống → dùng cả địa chỉ email, vì hai
   *  tài khoản khác domain mà cùng prefix (user@a.com / user@gmail.com) sẽ
   *  không phân biệt được nếu chỉ lấy phần trước @. */
  title?: string;
  email: string;
  /** IMAP/SMTP login — thường trùng email (Zimbra/Gmail đều vậy). */
  user: string;
  /** Mật khẩu / App Password. Rỗng khi auth='oauth'. */
  pass: string;
  /**
   * Cách xác thực với mail server:
   *   'password' (mặc định, cũ) — LOGIN bằng user/pass.
   *   'oauth'  — XOAUTH2 bằng access token Google, KHÔNG lưu mật khẩu.
   * Google Workspace thường tắt App Password ("The setting you are looking for
   * is not available for your account") → oauth là đường duy nhất.
   */
  auth?: 'password' | 'oauth';
  /** auth='oauth': id tài khoản Google trong googleauth.json cấp token. */
  googleAccountId?: string;
  imap: MailEndpoint;
  smtp: MailEndpoint;
}

/** Shape trả về cho client — KHÔNG BAO GIỜ kèm password. */
export type MailAccountPublic = Omit<MailAccount, 'pass'>;

export function toPublic(a: MailAccount): MailAccountPublic {
  const { pass: _pass, ...pub } = a;
  return pub;
}

const REG_PATH = process.env.MAIL_ACCOUNTS_PATH ? path.resolve(process.cwd(), process.env.MAIL_ACCOUNTS_PATH) : configPath('mailaccounts.json', ['.mailaccounts.json']);

async function readAll(): Promise<MailAccount[]> {
  try {
    const raw = await fs.readFile(REG_PATH, 'utf8');
    const data = JSON.parse(raw) as { accounts?: MailAccount[] };
    return Array.isArray(data.accounts) ? data.accounts : [];
  } catch {
    return [];
  }
}

async function writeAll(accounts: MailAccount[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ accounts }, null, 2), 'utf8');
}

export async function listAccounts(): Promise<MailAccount[]> {
  return readAll();
}

export async function getAccount(id: string): Promise<MailAccount> {
  const a = (await readAll()).find((x) => x.id === id);
  if (!a) throw new Error('Không tìm thấy tài khoản mail — chọn lại tài khoản.');
  return a;
}

export async function addAccount(input: Omit<MailAccount, 'id'>): Promise<MailAccount[]> {
  const accounts = await readAll();
  if (accounts.some((a) => a.email === input.email && a.imap.host === input.imap.host)) {
    throw new Error('Tài khoản này đã được thêm rồi.');
  }
  accounts.push({
    ...input,
    id: randomUUID(),
    label: input.label.trim() || input.email,
    title: input.title?.trim() || undefined,
  });
  await writeAll(accounts);
  return accounts;
}

export async function removeAccount(id: string): Promise<MailAccount[]> {
  const accounts = (await readAll()).filter((a) => a.id !== id);
  await writeAll(accounts);
  return accounts;
}

/** Đổi tên quản lý (tab) và/hoặc tên người gửi (header From) của một tài khoản. */
export async function renameAccount(
  id: string,
  patch: { title?: string; label?: string },
): Promise<MailAccount[]> {
  const accounts = await readAll();
  const a = accounts.find((x) => x.id === id);
  if (!a) throw new Error('Không tìm thấy tài khoản mail.');
  // Bỏ trống title = quay về mặc định (hiện cả địa chỉ email).
  if (patch.title !== undefined) a.title = patch.title.trim() || undefined;
  // label rỗng thì giữ email làm tên người gửi, không để From trống.
  if (patch.label !== undefined) a.label = patch.label.trim() || a.email;
  await writeAll(accounts);
  return accounts;
}

/** Tên hiển thị trong app: title tự đặt → hoặc cả địa chỉ email (KHÔNG cắt
 *  prefix, để user@a.com và user@gmail.com không trông giống nhau). */
export function accountTitle(a: Pick<MailAccount, 'title' | 'email'>): string {
  return a.title?.trim() || a.email;
}
