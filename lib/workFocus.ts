// Server-only: kho NHIỆM VỤ TRỌNG TÂM của tab Công việc.
//
// CƠ CHẾ LƯU — khác task/ghi chú ở chỗ có đường lui:
//   · Tab Công việc ĐÃ cấu hình cụm Mongo (và tool Mongo bật)  → lưu Mongo,
//     collection 'devbox_focus' cùng cụm/db với task (xem workTasks.workColl).
//   · Chưa cấu hình / tool Mongo tắt                            → lưu FILE local
//     configs/workfocus.json (override: WORK_FOCUS_PATH), dùng được ngay không
//     cần cài gì.
// Chọn mỗi lần gọi (không cache): cấu hình Mongo xong là lần gọi kế tiếp đã sang
// Mongo. Dữ liệu local KHÔNG tự biến mất hay tự đổ sang Mongo — list báo
// `localPending` và có action đưa lên (importLocal) để người dùng chủ động.
//
// Mongo cấu hình rồi mà không kết nối được thì LỖI NỔI RA chứ KHÔNG âm thầm rơi về
// file local: nếu không, một cú mất mạng lẻ tẻ sẽ chẻ dữ liệu làm hai nơi.

import { promises as fs } from 'fs';
import path from 'path';
import type { Document } from 'mongodb';
import { configPath } from './configDir';
import { MONGO_ENABLED } from './mongoClient';
import { getWorkConfigView, workColl } from './workTasks';
import { buildItem, patchItem, FOCUS_STATUSES, type FocusItem, type FocusPriority, type FocusPeriod, type FocusStatus, type FocusSub } from './workFocusCore';

export const FOCUS_COLLECTION = 'devbox_focus';

const LOCAL_FILE = process.env.WORK_FOCUS_PATH
  ? path.resolve(process.cwd(), process.env.WORK_FOCUS_PATH)
  : configPath('workfocus.json', []);

const LIST_CAP = 5000;

// ── Backend ─────────────────────────────────────────────────────────────────

interface Backend {
  list(): Promise<FocusItem[]>;
  get(id: string): Promise<FocusItem | null>;
  insert(item: FocusItem): Promise<void>;
  replace(item: FocusItem): Promise<void>;
  remove(id: string): Promise<void>;
}

// ── Local (file JSON) ───────────────────────────────────────────────────────

// Mọi thao tác đọc-sửa-ghi xếp hàng qua một chuỗi promise: bấm nhanh liên tiếp
// (kéo thả thẻ, tick nhiều subtask) mà để chồng nhau là ghi đè mất một lần sửa.
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function readLocal(): Promise<FocusItem[]> {
  try {
    const raw = JSON.parse(await fs.readFile(LOCAL_FILE, 'utf8')) as { items?: unknown };
    return Array.isArray(raw.items) ? (raw.items as FocusItem[]).map(normalize) : [];
  } catch { return []; }
}

async function writeLocal(items: FocusItem[]): Promise<void> {
  // Ghi ra file tạm rồi đổi tên: mất điện/crash giữa chừng không để lại file cụt.
  const tmp = `${LOCAL_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ items }, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, LOCAL_FILE);
}

const localBackend: Backend = {
  list: () => locked(readLocal),
  get: (id) => locked(async () => (await readLocal()).find((i) => i.id === id) ?? null),
  insert: (item) => locked(async () => { const all = await readLocal(); all.push(item); await writeLocal(all); }),
  replace: (item) => locked(async () => {
    const all = await readLocal();
    const i = all.findIndex((x) => x.id === item.id);
    if (i < 0) throw new Error('Không tìm thấy nhiệm vụ.');
    all[i] = item;
    await writeLocal(all);
  }),
  remove: (id) => locked(async () => { await writeLocal((await readLocal()).filter((i) => i.id !== id)); }),
};

// ── Mongo ───────────────────────────────────────────────────────────────────

const coll = () => workColl(FOCUS_COLLECTION);
const idOf = (id: string) => id as unknown as Document['_id'];

const mongoBackend: Backend = {
  async list() {
    const docs = await (await coll()).find({}).limit(LIST_CAP).toArray();
    return docs.map(fromDoc);
  },
  async get(id) {
    const d = await (await coll()).findOne({ _id: idOf(id) });
    return d ? fromDoc(d) : null;
  },
  async insert(item) {
    await (await coll()).insertOne({ _id: idOf(item.id), ...item });
  },
  async replace(item) {
    const { id, ...rest } = item;
    const r = await (await coll()).replaceOne({ _id: idOf(id) }, rest);
    if (r.matchedCount !== 1) throw new Error('Không tìm thấy nhiệm vụ.');
  },
  async remove(id) {
    await (await coll()).deleteOne({ _id: idOf(id) });
  },
};

// ── Chuẩn hoá khi đọc (dữ liệu cũ/tay sửa không làm UI vỡ) ──────────────────

function normalize(x: Partial<FocusItem>): FocusItem {
  const period: FocusPeriod = x.period === 'month' ? 'month' : 'week';
  const status = FOCUS_STATUSES.includes(x.status as FocusStatus) ? (x.status as FocusStatus) : 'todo';
  const priority: FocusPriority = x.priority === 'urgent' || x.priority === 'high' ? x.priority : 'normal';
  return {
    id: String(x.id ?? ''),
    period,
    periodKey: String(x.periodKey ?? ''),
    title: String(x.title ?? ''),
    note: String(x.note ?? ''),
    project: String(x.project ?? ''),
    tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
    priority,
    status,
    deadline: typeof x.deadline === 'string' && x.deadline ? x.deadline : null,
    subtasks: Array.isArray(x.subtasks)
      ? (x.subtasks as Partial<FocusSub>[]).map((s) => ({ id: String(s.id ?? ''), text: String(s.text ?? ''), done: s.done === true }))
      : [],
    carried: typeof x.carried === 'number' ? x.carried : 0,
    createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0,
    updatedAt: typeof x.updatedAt === 'number' ? x.updatedAt : 0,
    doneAt: typeof x.doneAt === 'number' ? x.doneAt : null,
  };
}

function fromDoc(d: Document): FocusItem {
  return normalize({ ...(d as Partial<FocusItem>), id: String(d._id) });
}

// ── Chọn kho ────────────────────────────────────────────────────────────────

export interface FocusStorage {
  mode: 'mongo' | 'local';
  /** Chữ hiện trên UI: tên cụm / db, hoặc đường dẫn file. */
  label: string;
}

async function pick(): Promise<{ info: FocusStorage; be: Backend }> {
  if (MONGO_ENABLED) {
    const v = await getWorkConfigView().catch(() => null);
    if (v?.configured && v.config) {
      return { info: { mode: 'mongo', label: `${v.connectionName} / ${v.config.database}` }, be: mongoBackend };
    }
  }
  return { info: { mode: 'local', label: path.relative(process.cwd(), LOCAL_FILE) || LOCAL_FILE }, be: localBackend };
}

// ── API cho route ───────────────────────────────────────────────────────────

export interface FocusListResult {
  items: FocusItem[];
  storage: FocusStorage;
  /** Số nhiệm vụ còn trong file local trong khi kho hiện tại là Mongo. */
  localPending: number;
}

export async function listFocus(): Promise<FocusListResult> {
  const { info, be } = await pick();
  const items = await be.list();
  const localPending = info.mode === 'mongo' ? (await localBackend.list()).length : 0;
  return { items, storage: info, localPending };
}

export async function addFocus(raw: Record<string, unknown>): Promise<FocusItem> {
  const { be } = await pick();
  const item = buildItem(raw);
  await be.insert(item);
  return item;
}

export async function updateFocus(id: unknown, raw: Record<string, unknown>): Promise<FocusItem> {
  const nid = String(id ?? '');
  if (!nid) throw new Error('Thiếu id nhiệm vụ.');
  const { be } = await pick();
  const cur = await be.get(nid);
  if (!cur) throw new Error('Không tìm thấy nhiệm vụ.');
  const next = patchItem(cur, raw);
  await be.replace(next);
  return next;
}

export async function removeFocus(id: unknown): Promise<void> {
  const nid = String(id ?? '');
  if (!nid) throw new Error('Thiếu id nhiệm vụ.');
  const { be } = await pick();
  await be.remove(nid);
}

/** Đưa nhiệm vụ trong file local lên Mongo (bỏ qua id đã có), rồi xoá khỏi file local. */
export async function importLocalFocus(): Promise<{ imported: number }> {
  const { info } = await pick();
  if (info.mode !== 'mongo') throw new Error('Chưa cấu hình Mongo — không có nơi để đưa lên.');
  const local = await localBackend.list();
  if (local.length === 0) return { imported: 0 };
  const have = new Set((await mongoBackend.list()).map((i) => i.id));
  let imported = 0;
  for (const it of local) {
    if (have.has(it.id)) continue;
    await mongoBackend.insert(it);
    imported++;
  }
  // Chỉ xoá bản local SAU KHI đã ghi hết lên Mongo — lỗi giữa chừng thì còn nguyên để thử lại.
  for (const it of local) await localBackend.remove(it.id);
  return { imported };
}
