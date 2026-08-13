// Per-machine registry for the Links tab — bookmark MỌI link nội bộ/ngoài
// (Jenkins build, Rancher logs, Google Docs bên thứ 3, …) kèm metadata
// (dự án/mô tả/tags) và PROFILE session: các link cùng profile mở chung một
// partition đăng nhập trong viewer nhúng → login user/pass một lần cho cả
// nhóm; hai tài khoản trên cùng một service = hai profile khác nhau.
//
// Same shape as the other JSON registries: a small gitignored file in cwd,
// full-file read/write. Tiền thân là .googlelinks.json (mục 🔗 nằm trong tab
// Google) — lần đọc đầu tiên tự MIGRATE dữ liệu cũ sang .links.json.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';
import { defaultScheme } from './bookmarks';

export interface SavedLink {
  id: string;
  /** Display name — defaults to whatever the client sends (page title / hostname). */
  name: string;
  url: string;
  /** ISO timestamp khi lưu — hiển thị "x ngày trước". */
  addedAt: string;
  /** Dự án liên quan (optional) — badge + lọc. */
  project?: string;
  /** Mô tả ngắn (optional). */
  description?: string;
  /** Tags để group/lọc (optional). */
  tags?: string[];
  /** Profile session (optional) — link cùng profile dùng chung partition
   *  đăng nhập trong viewer. Không gán = session chung mặc định. */
  profile?: string;
  /** Tài khoản đăng nhập site (optional) — nút 🔑 trong viewer tự điền vào
   *  form login khi session hết hạn. Plaintext trong file gitignored trên máy
   *  cá nhân — cùng mức với .mailaccounts.json. */
  username?: string;
  password?: string;
}

export interface SavedLinkMeta {
  name?: string;
  project?: string;
  description?: string;
  tags?: string[];
  profile?: string;
  username?: string;
  password?: string;
}

/** Chuẩn hóa tags: trim, bỏ rỗng, dedupe không phân biệt hoa thường. */
/** Thêm scheme khi thiếu — giữ nguyên nếu đã có, hoặc nếu trông không ra host
 *  (để addLink vẫn từ chối được rác thay vì biến nó thành URL). */
function addScheme(raw: string): string {
  if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  const bare = raw.replace(/^\/+/, '');
  const hostPart = bare.split(/[/?#]/)[0];
  const looksLikeHost =
    !/\s/.test(bare) && (
      /^localhost(:\d+)?$/i.test(hostPart) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart) ||
      /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(hostPart) ||
      /^[a-z0-9-]+:\d+$/i.test(hostPart)
    );
  return looksLikeHost ? `${defaultScheme(hostPart)}://${bare}` : raw;
}

export function normTags(tags: unknown): string[] {
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

// configPath tự migrate .links.json (hoặc .googlelinks.json cũ) từ repo-root
// sang configs/. LEGACY_PATH giữ lại để đọc file .googlelinks.json còn sót
// ngoài root (trường hợp cả hai cùng tồn tại) — an toàn, không mất dữ liệu.
const REG_PATH = process.env.LINKS_PATH
  ? path.resolve(process.cwd(), process.env.LINKS_PATH)
  : configPath('links.json', ['.links.json', '.googlelinks.json']);
const LEGACY_PATH = path.join(process.cwd(), '.googlelinks.json');

async function readAll(): Promise<SavedLink[]> {
  try {
    const raw = await fs.readFile(REG_PATH, 'utf8');
    const data = JSON.parse(raw) as { links?: SavedLink[] };
    return Array.isArray(data.links) ? data.links : [];
  } catch {
    // Migrate một lần từ registry cũ của mục 🔗 trong tab Google.
    try {
      const raw = await fs.readFile(LEGACY_PATH, 'utf8');
      const data = JSON.parse(raw) as { links?: SavedLink[] };
      const links = Array.isArray(data.links) ? data.links : [];
      if (links.length) await writeAll(links);
      return links;
    } catch {
      return [];
    }
  }
}

async function writeAll(links: SavedLink[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ links }, null, 2), 'utf8');
}

export async function listLinks(): Promise<SavedLink[]> {
  return readAll();
}

export async function addLink(input: { url: string } & SavedLinkMeta): Promise<SavedLink[]> {
  // Thiếu scheme thì tự thêm theo defaultScheme (localhost/mạng riêng → http),
  // để nút 💾 nhận đúng những gì nút Mở đã mở được.
  const url = addScheme(input.url.trim());
  if (!/^https?:\/\//i.test(url)) throw new Error('Link không hợp lệ — cần bắt đầu bằng http(s)://');
  const links = await readAll();
  if (links.some((l) => l.url === url)) throw new Error('Link này đã được lưu rồi.');
  const name = (input.name ?? '').trim() || (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const tags = normTags(input.tags);
  links.unshift({
    id: randomUUID(),
    name,
    url,
    addedAt: new Date().toISOString(),
    project: (input.project ?? '').trim() || undefined,
    description: (input.description ?? '').trim() || undefined,
    tags: tags.length ? tags : undefined,
    profile: (input.profile ?? '').trim() || undefined,
    username: (input.username ?? '').trim() || undefined,
    password: input.password || undefined,
  });
  await writeAll(links);
  return links;
}

/** Sửa metadata một link đã lưu — mọi field optional; url không đổi. */
export async function updateLink(id: string, patch: SavedLinkMeta): Promise<SavedLink[]> {
  const links = await readAll();
  const l = links.find((x) => x.id === id);
  if (!l) throw new Error('Không tìm thấy link đã lưu.');
  if (patch.name !== undefined) l.name = patch.name.trim() || l.name;
  if (patch.project !== undefined) l.project = patch.project.trim() || undefined;
  if (patch.description !== undefined) l.description = patch.description.trim() || undefined;
  if (patch.profile !== undefined) l.profile = patch.profile.trim() || undefined;
  if (patch.username !== undefined) l.username = patch.username.trim() || undefined;
  if (patch.password !== undefined) l.password = patch.password || undefined;
  if (patch.tags !== undefined) {
    const tags = normTags(patch.tags);
    l.tags = tags.length ? tags : undefined;
  }
  await writeAll(links);
  return links;
}

export async function removeLink(id: string): Promise<SavedLink[]> {
  const links = (await readAll()).filter((l) => l.id !== id);
  await writeAll(links);
  return links;
}
