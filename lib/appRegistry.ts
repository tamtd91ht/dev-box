// Per-machine registry for the Apps tab — mỗi entry một app local (Next.js,
// bot, service…): trỏ thư mục gốc + hậu tố lệnh `npm run <cmd>` để start/stop
// ngay trong DevBox, khỏi mở terminal vào từng project. Quản lý theo
// name/project/description/tags như tab Links. File .apps.json gitignored.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface AppEntry {
  id: string;
  name: string;
  /** Thư mục gốc project (chứa package.json). */
  root: string;
  /** Hậu tố script: chạy `npm run <cmd>` trong root. */
  cmd: string;
  project?: string;
  description?: string;
  tags?: string[];
}

export type AppMeta = Partial<Omit<AppEntry, 'id'>>;

const REG_PATH = path.join(process.cwd(), process.env.APPS_PATH || '.apps.json');

async function readAll(): Promise<AppEntry[]> {
  try {
    const data = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as { apps?: AppEntry[] };
    return Array.isArray(data.apps) ? data.apps : [];
  } catch { return []; }
}
async function writeAll(apps: AppEntry[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ apps }, null, 2), 'utf8');
}

const normTags = (t: unknown) =>
  Array.isArray(t) ? [...new Set(t.map((x) => String(x).trim()).filter(Boolean))] : [];

export async function listApps(): Promise<AppEntry[]> { return readAll(); }

export async function getApp(id: string): Promise<AppEntry> {
  const a = (await readAll()).find((x) => x.id === id);
  if (!a) throw new Error('Không tìm thấy app.');
  return a;
}

export async function addApp(input: AppMeta): Promise<AppEntry[]> {
  const root = (input.root ?? '').trim();
  const cmd = (input.cmd ?? '').trim();
  if (!root || !cmd) throw new Error('Cần thư mục gốc và lệnh (hậu tố npm run).');
  try { await fs.access(path.join(root, 'package.json')); }
  catch { throw new Error(`Không thấy package.json trong "${root}".`); }
  const apps = await readAll();
  apps.unshift({
    id: randomUUID(),
    name: (input.name ?? '').trim() || path.basename(root),
    root, cmd,
    project: (input.project ?? '').trim() || undefined,
    description: (input.description ?? '').trim() || undefined,
    tags: normTags(input.tags).length ? normTags(input.tags) : undefined,
  });
  await writeAll(apps);
  return apps;
}

export async function updateApp(id: string, patch: AppMeta): Promise<AppEntry[]> {
  const apps = await readAll();
  const a = apps.find((x) => x.id === id);
  if (!a) throw new Error('Không tìm thấy app.');
  if (patch.name !== undefined) a.name = patch.name.trim() || a.name;
  if (patch.root !== undefined && patch.root.trim()) a.root = patch.root.trim();
  if (patch.cmd !== undefined && patch.cmd.trim()) a.cmd = patch.cmd.trim();
  if (patch.project !== undefined) a.project = patch.project.trim() || undefined;
  if (patch.description !== undefined) a.description = patch.description.trim() || undefined;
  if (patch.tags !== undefined) { const t = normTags(patch.tags); a.tags = t.length ? t : undefined; }
  await writeAll(apps);
  return apps;
}

export async function removeApp(id: string): Promise<AppEntry[]> {
  const apps = (await readAll()).filter((a) => a.id !== id);
  await writeAll(apps);
  return apps;
}
