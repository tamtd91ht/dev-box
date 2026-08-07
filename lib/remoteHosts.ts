// Sổ MÁY TỪ XA cho tab Remote — quản lý danh sách máy cần điều khiển và mở
// bằng ĐÚNG phần mềm sẵn có trên máy (UltraViewer / Remote Desktop / VNC).
//
// DevBox KHÔNG tự vẽ màn hình máy kia: làm được chuyện đó phải có host capture
// màn hình + relay xuyên NAT, tức là viết lại UltraViewer. Thay vào đó ở đây
// lo phần mà UltraViewer làm dở: nhớ máy nào là máy nào (tên, thuộc dự án gì,
// ai dùng, ghi chú), tra cứu nhanh, rồi bấm một cái là client bật lên đúng máy.
//
// MẬT KHẨU: chỉ giữ CIPHERTEXT do safeStorage (DPAPI) niêm phong ở renderer —
// giống hệt lib/passwordStore. File configs/remote-hosts.json bê sang máy khác
// hay user khác là không giải mã được. Xem thêm ghi chú ở writeAll().

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';

// Type + hằng số thuần nằm ở ./remoteHostTypes (không import fs) để client
// component dùng được mà không kéo `fs` vào bundle browser. Re-export ở đây để
// code cũ import từ file này vẫn chạy như trước.
export type { RemoteKind, RemoteHost, RemoteHostInput } from './remoteHostTypes';
export { REMOTE_KINDS, KIND_META, validAddress } from './remoteHostTypes';

import type { RemoteHost, RemoteHostInput, RemoteKind } from './remoteHostTypes';
import { validAddress, REMOTE_KINDS } from './remoteHostTypes';

const REG_PATH = process.env.REMOTE_HOSTS_PATH
  ? path.resolve(process.cwd(), process.env.REMOTE_HOSTS_PATH)
  : configPath('remote-hosts.json', ['.remote-hosts.json']);

/** Chuẩn hóa tags — cùng luật với lib/linkRegistry để lọc nhất quán. */
function normTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const s = String(t).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

async function readAll(): Promise<RemoteHost[]> {
  try {
    const raw = await fs.readFile(REG_PATH, 'utf8');
    const data = JSON.parse(raw) as { hosts?: RemoteHost[] };
    return Array.isArray(data.hosts) ? data.hosts : [];
  } catch {
    return [];
  }
}

async function writeAll(hosts: RemoteHost[]): Promise<void> {
  // File này chứa ciphertext mật khẩu → nằm trong configs/ (đã gitignore) và
  // chỉ đọc được bởi đúng user trên đúng máy đã niêm phong.
  await fs.writeFile(REG_PATH, JSON.stringify({ hosts }, null, 2), 'utf8');
}

export async function listHosts(): Promise<RemoteHost[]> {
  return readAll();
}

export async function addHost(input: RemoteHostInput): Promise<RemoteHost[]> {
  const name = (input.name ?? '').trim();
  const address = (input.address ?? '').trim();
  const kind = input.kind && REMOTE_KINDS.includes(input.kind) ? input.kind : 'ultraviewer';
  if (!name) throw new Error('Cần đặt tên cho máy.');
  if (!address) throw new Error('Cần nhập ID hoặc địa chỉ máy.');
  if (!validAddress(address)) {
    throw new Error('Địa chỉ chỉ được gồm chữ, số và . _ - : @ — bỏ ký tự lạ đi.');
  }
  const hosts = await readAll();
  const tags = normTags(input.tags);
  hosts.unshift({
    id: randomUUID(),
    name,
    kind,
    address,
    username: (input.username ?? '').trim() || undefined,
    passwordEnc: input.passwordEnc || undefined,
    project: (input.project ?? '').trim() || undefined,
    note: (input.note ?? '').trim() || undefined,
    tags: tags.length ? tags : undefined,
    network: input.network === 'wan' ? 'wan' : input.network === 'lan' ? 'lan' : undefined,
    addedAt: new Date().toISOString(),
  });
  await writeAll(hosts);
  return hosts;
}

export async function updateHost(id: string, patch: RemoteHostInput): Promise<RemoteHost[]> {
  const hosts = await readAll();
  const h = hosts.find((x) => x.id === id);
  if (!h) throw new Error('Không tìm thấy máy này.');
  if (patch.name !== undefined) h.name = patch.name.trim() || h.name;
  if (patch.kind !== undefined && REMOTE_KINDS.includes(patch.kind)) h.kind = patch.kind;
  if (patch.address !== undefined) {
    const addr = patch.address.trim();
    if (!addr) throw new Error('Cần nhập ID hoặc địa chỉ máy.');
    if (!validAddress(addr)) {
      throw new Error('Địa chỉ chỉ được gồm chữ, số và . _ - : @ — bỏ ký tự lạ đi.');
    }
    h.address = addr;
  }
  if (patch.username !== undefined) h.username = patch.username.trim() || undefined;
  // null = xoá hẳn mật khẩu; undefined = không đụng tới.
  if (patch.passwordEnc === null) h.passwordEnc = undefined;
  else if (patch.passwordEnc !== undefined) h.passwordEnc = patch.passwordEnc || undefined;
  if (patch.project !== undefined) h.project = patch.project.trim() || undefined;
  if (patch.note !== undefined) h.note = patch.note.trim() || undefined;
  if (patch.network !== undefined) {
    h.network = patch.network === 'wan' ? 'wan' : patch.network === 'lan' ? 'lan' : undefined;
  }
  if (patch.tags !== undefined) {
    const tags = normTags(patch.tags);
    h.tags = tags.length ? tags : undefined;
  }
  await writeAll(hosts);
  return hosts;
}

export async function removeHost(id: string): Promise<RemoteHost[]> {
  const hosts = (await readAll()).filter((h) => h.id !== id);
  await writeAll(hosts);
  return hosts;
}

/** Ghi nhận vừa mở máy này — để xếp "hay dùng" lên đầu. */
export async function touchHost(id: string): Promise<RemoteHost[]> {
  const hosts = await readAll();
  const h = hosts.find((x) => x.id === id);
  if (h) {
    h.lastUsedAt = new Date().toISOString();
    h.useCount = (h.useCount ?? 0) + 1;
    await writeAll(hosts);
  }
  return hosts;
}
