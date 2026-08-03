// Per-machine registry of Drive "project root" folders for the Google tab —
// each entry is one pasted folder link (vd. thư mục tài liệu của một dự án).
// Same shape as the other JSON registries (.gitprojects.json, …): a small
// gitignored file in cwd, full-file read/write, no partial updates.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';

export interface GoogleRoot {
  id: string;
  /** DevBox Google account this root belongs to (multi-account). */
  accountId: string;
  /** Display name — defaults to the Drive folder's own name. */
  name: string;
  /** Drive folder ID (extracted from the pasted link). */
  folderId: string;
  /** Original pasted URL, kept for "mở trong Drive". */
  url: string;
}

const REG_PATH = process.env.GOOGLE_ROOTS_PATH ? path.resolve(process.cwd(), process.env.GOOGLE_ROOTS_PATH) : configPath('googleroots.json', ['.googleroots.json']);

async function readAll(): Promise<GoogleRoot[]> {
  try {
    const raw = await fs.readFile(REG_PATH, 'utf8');
    const data = JSON.parse(raw) as { roots?: GoogleRoot[] };
    return Array.isArray(data.roots) ? data.roots : [];
  } catch {
    return [];
  }
}

async function writeAll(roots: GoogleRoot[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ roots }, null, 2), 'utf8');
}

/** All roots, or only one account's roots when accountId is given. */
export async function listRoots(accountId?: string): Promise<GoogleRoot[]> {
  const roots = await readAll();
  return accountId ? roots.filter((r) => r.accountId === accountId) : roots;
}

export async function addRoot(input: { accountId: string; name: string; folderId: string; url: string }): Promise<GoogleRoot[]> {
  const roots = await readAll();
  if (roots.some((r) => r.folderId === input.folderId && r.accountId === input.accountId)) {
    throw new Error('Thư mục này đã được đăng ký cho tài khoản này rồi.');
  }
  roots.push({ id: randomUUID(), accountId: input.accountId, name: input.name, folderId: input.folderId, url: input.url });
  await writeAll(roots);
  return roots.filter((r) => r.accountId === input.accountId);
}

export async function removeRoot(id: string): Promise<GoogleRoot[]> {
  const roots = (await readAll()).filter((r) => r.id !== id);
  await writeAll(roots);
  return roots;
}

export async function renameRoot(id: string, name: string): Promise<GoogleRoot[]> {
  const roots = await readAll();
  const r = roots.find((x) => x.id === id);
  if (!r) throw new Error('Không tìm thấy thư mục đã đăng ký.');
  r.name = name.trim() || r.name;
  await writeAll(roots);
  return roots;
}
