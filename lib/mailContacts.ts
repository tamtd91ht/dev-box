// Address book local cho tab Mail — CHỈ lưu địa chỉ email để gợi ý ở ô nhập
// To/Cc (không cache nội dung mail; hòm thư đã giữ nội dung). Số lượng ít nên
// full-file JSON trong configs/ là đủ.
//
// Thu thập tự động (mailServer gọi):
//   • MỌI địa chỉ khi GỬI đi (To/Cc) — người mình chủ động liên hệ.
//   • Người GỬI ĐẾN nhưng CÙNG DOMAIN với tài khoản (đồng nghiệp nội bộ).
// Domain khác ở mail nhận → không tự lưu; UI có nút lưu THỦ CÔNG.

import { promises as fs } from 'fs';
import { configPath } from './configDir';

export interface MailContact {
  email: string;
  /** Tên hiển thị gần nhất thấy được (có thể rỗng). */
  name?: string;
  /** Số lần xuất hiện — gợi ý sắp người hay dùng lên trên. */
  count: number;
  /** ISO lần cuối thấy. */
  lastSeen: string;
}

const REG_PATH = configPath('mailcontacts.json');

async function readAll(): Promise<MailContact[]> {
  try {
    const d = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as { contacts?: MailContact[] };
    return Array.isArray(d.contacts) ? d.contacts : [];
  } catch { return []; }
}
async function writeAll(contacts: MailContact[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ contacts }, null, 2), 'utf8');
}

export async function listContacts(): Promise<MailContact[]> {
  const all = await readAll();
  // Hay dùng + mới gặp lên trên.
  return all.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}

/** Chuẩn hóa "Tên <a@b.com>" hoặc "a@b.com" → {email, name}. Trả null nếu vô lệ. */
function parseAddr(raw: string): { email: string; name?: string } | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(.*?)<\s*([^>]+?)\s*>$/.exec(s);
  const email = (m ? m[2] : s).trim().toLowerCase();
  const name = m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { email, name: name || undefined };
}

/** Ghi/tăng đếm một loạt địa chỉ. Dedupe theo email, gộp vào bản ghi cũ. */
export async function recordAddresses(raws: string[]): Promise<MailContact[]> {
  const contacts = await readAll();
  const byEmail = new Map(contacts.map((c) => [c.email, c]));
  const now = new Date().toISOString();
  for (const raw of raws) {
    const p = parseAddr(raw);
    if (!p) continue;
    const cur = byEmail.get(p.email);
    if (cur) {
      cur.count += 1; cur.lastSeen = now;
      if (p.name && !cur.name) cur.name = p.name;
    } else {
      const c: MailContact = { email: p.email, name: p.name, count: 1, lastSeen: now };
      byEmail.set(p.email, c); contacts.push(c);
    }
  }
  await writeAll(contacts);
  return contacts;
}

export async function removeContact(email: string): Promise<MailContact[]> {
  const contacts = (await readAll()).filter((c) => c.email !== email.toLowerCase());
  await writeAll(contacts);
  return contacts;
}

/** Domain của một địa chỉ (phần sau @), lowercase. */
export function domainOf(addr: string): string {
  const p = parseAddr(addr);
  return p ? p.email.split('@')[1] ?? '' : '';
}
