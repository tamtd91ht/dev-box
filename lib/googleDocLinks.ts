// Per-machine registry of pasted Drive FILE links for the Google tab — mục 🔗
// "Tài liệu được share". Khác googleRoots.ts (đăng ký THƯ MỤC gốc của dự án):
// ở đây mỗi entry là MỘT FILE ai đó share cho bạn, không cần nằm trong thư mục
// dự án nào cả. Cùng khuôn với các registry khác: một file JSON nhỏ trong
// ./configs, đọc/ghi nguyên file, không cập nhật từng phần.
//
// KHÔNG lưu accountId: quyền Drive tính theo từng file và link share có thể
// thuộc bất kỳ tài khoản nào đang đăng nhập — người xem để GoogleFilePreview
// tự dò (multi-account fallback). Lưu account vào đây chỉ tổ sai khi bạn đăng
// xuất rồi đăng nhập lại bằng account khác.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';

export interface GoogleDocLink {
  id: string;
  /** Drive file ID (bóc từ link đã dán). */
  fileId: string;
  /** Tên hiển thị — mặc định là tên thật của file trên Drive. */
  name: string;
  /** MIME lúc đăng ký, để hiện đúng icon mà không phải gọi lại Drive. */
  mimeType: string;
  /** Link gốc đã dán, giữ để "mở trong Drive". */
  url: string;
  /** Ghim lên đầu danh sách. */
  pinned?: boolean;
  /** ISO — lần mở gần nhất, để sắp xếp "mới xem trước". */
  lastOpened?: string;
  /** ISO — lúc dán vào. */
  addedAt: string;
}

const REG_PATH = process.env.GOOGLE_DOCLINKS_PATH
  ? path.resolve(process.cwd(), process.env.GOOGLE_DOCLINKS_PATH)
  : configPath('googledoclinks.json');

async function readAll(): Promise<GoogleDocLink[]> {
  try {
    const raw = await fs.readFile(REG_PATH, 'utf8');
    const data = JSON.parse(raw) as { links?: GoogleDocLink[] };
    return Array.isArray(data.links) ? data.links : [];
  } catch {
    return [];
  }
}

async function writeAll(links: GoogleDocLink[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ links }, null, 2), 'utf8');
}

/** Ghim trước, rồi mới mở gần đây nhất, rồi mới thêm gần đây nhất. */
function sorted(links: GoogleDocLink[]): GoogleDocLink[] {
  return [...links].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.lastOpened ?? b.addedAt).localeCompare(a.lastOpened ?? a.addedAt);
  });
}

export async function listDocLinks(): Promise<GoogleDocLink[]> {
  return sorted(await readAll());
}

/**
 * Thêm một link đã dán. Dán lại link cũ KHÔNG tạo bản trùng — chỉ cập nhật tên
 * / mime và đẩy lên đầu, vì người dùng dán lại thường là muốn mở lại nó.
 */
export async function addDocLink(input: {
  fileId: string;
  name: string;
  mimeType: string;
  url: string;
}): Promise<GoogleDocLink[]> {
  const links = await readAll();
  const now = new Date().toISOString();
  const existing = links.find((l) => l.fileId === input.fileId);
  if (existing) {
    existing.name = input.name || existing.name;
    existing.mimeType = input.mimeType || existing.mimeType;
    existing.url = input.url || existing.url;
    existing.lastOpened = now;
  } else {
    links.push({
      id: randomUUID(),
      fileId: input.fileId,
      name: input.name,
      mimeType: input.mimeType,
      url: input.url,
      addedAt: now,
      lastOpened: now,
    });
  }
  await writeAll(links);
  return sorted(links);
}

export async function removeDocLink(id: string): Promise<GoogleDocLink[]> {
  const links = (await readAll()).filter((l) => l.id !== id);
  await writeAll(links);
  return sorted(links);
}

export async function renameDocLink(id: string, name: string): Promise<GoogleDocLink[]> {
  const links = await readAll();
  const l = links.find((x) => x.id === id);
  if (!l) throw new Error('Không tìm thấy link đã lưu.');
  l.name = name.trim() || l.name;
  await writeAll(links);
  return sorted(links);
}

export async function pinDocLink(id: string, pinned: boolean): Promise<GoogleDocLink[]> {
  const links = await readAll();
  const l = links.find((x) => x.id === id);
  if (!l) throw new Error('Không tìm thấy link đã lưu.');
  l.pinned = pinned;
  await writeAll(links);
  return sorted(links);
}

/** Đánh dấu vừa mở — để danh sách xếp "mới xem trước". */
export async function touchDocLink(id: string): Promise<GoogleDocLink[]> {
  const links = await readAll();
  const l = links.find((x) => x.id === id);
  if (l) {
    l.lastOpened = new Date().toISOString();
    await writeAll(links);
  }
  return sorted(links);
}
