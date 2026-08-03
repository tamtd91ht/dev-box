// Per-machine store cho tab Tools — snippet JSON/text người dùng tạo & lưu lại
// (payload mẫu, cấu hình, note…). File .docs.json gitignored trong cwd,
// full-file read/write như các registry khác.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';

export type DocKind = 'json' | 'text';

export interface SavedDoc {
  id: string;
  name: string;
  kind: DocKind;
  content: string;
  updatedAt: string;
}

const REG_PATH = process.env.DOCS_PATH ? path.resolve(process.cwd(), process.env.DOCS_PATH) : configPath('docs.json', ['.docs.json']);

async function readAll(): Promise<SavedDoc[]> {
  try {
    const data = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as { docs?: SavedDoc[] };
    return Array.isArray(data.docs) ? data.docs : [];
  } catch { return []; }
}
async function writeAll(docs: SavedDoc[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ docs }, null, 2), 'utf8');
}

export async function listDocs(): Promise<SavedDoc[]> { return readAll(); }

export async function saveDoc(input: { id?: string; name: string; kind: DocKind; content: string }): Promise<SavedDoc[]> {
  const docs = await readAll();
  const now = new Date().toISOString();
  const name = input.name.trim() || `Untitled ${input.kind === 'json' ? 'JSON' : 'text'}`;
  if (input.id) {
    const d = docs.find((x) => x.id === input.id);
    if (!d) throw new Error('Không tìm thấy tài liệu.');
    d.name = name; d.content = input.content; d.updatedAt = now;
  } else {
    docs.unshift({ id: randomUUID(), name, kind: input.kind, content: input.content, updatedAt: now });
  }
  await writeAll(docs);
  return docs;
}

export async function removeDoc(id: string): Promise<SavedDoc[]> {
  const docs = (await readAll()).filter((d) => d.id !== id);
  await writeAll(docs);
  return docs;
}
