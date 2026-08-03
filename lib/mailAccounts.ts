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
  /** Display label — defaults to the email address. */
  label: string;
  email: string;
  /** IMAP/SMTP login — thường trùng email (Zimbra/Gmail đều vậy). */
  user: string;
  pass: string;
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
  accounts.push({ ...input, id: randomUUID(), label: input.label.trim() || input.email });
  await writeAll(accounts);
  return accounts;
}

export async function removeAccount(id: string): Promise<MailAccount[]> {
  const accounts = (await readAll()).filter((a) => a.id !== id);
  await writeAll(accounts);
  return accounts;
}
