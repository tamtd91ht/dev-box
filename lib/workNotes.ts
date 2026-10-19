// Server-only: kho GHI CHÚ của tab Công việc — lưu trên MongoDB.
//
// Dùng CHUNG con trỏ cấu hình với task (lib/workTasks: cùng cụm Mongo, cùng
// database — xem workColl), chỉ khác COLLECTION: 'devbox_work_notes'. Người
// dùng cấu hình kho lưu trữ một lần ở tab Công việc là dùng được cả hai.
//
// Ghi chú cố tình ĐƠN GIẢN — chỉ là nơi cất thông tin: tên + danh sách tag
// (tùy chọn) + một ô nội dung text tự do. Không trạng thái, không deadline,
// không cảnh báo (khác hẳn task). Sửa lại lúc nào cũng được.

import { randomUUID } from 'crypto';
import type { Document } from 'mongodb';
import { workColl } from './workTasks';

export const NOTES_COLLECTION = 'devbox_work_notes';

export interface WorkNote {
  id: string;
  name: string;
  tags: string[];
  body: string;
  createdAt: number;
  updatedAt: number;
}

const NAME_MAX = 200;
const BODY_MAX = 200_000; // ~200KB text — quá mức này thì nên là file, không phải ghi chú
const TAGS_MAX = 20;
const TAG_MAX = 40;

async function coll() {
  return workColl(NOTES_COLLECTION);
}

/** Validate + chuẩn hóa input từ client (dùng chung cho add và update). */
function sanitize(raw: Record<string, unknown>): Pick<WorkNote, 'name' | 'tags' | 'body'> {
  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error('Tên ghi chú là bắt buộc.');
  if (name.length > NAME_MAX) throw new Error(`Tên ghi chú quá dài (tối đa ${NAME_MAX} ký tự).`);

  // Tag nhận cả mảng (UI chip) lẫn chuỗi ngăn bởi dấu phẩy (dán tay) — giống task.
  const rawTags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => String(t))
    : String(raw.tags ?? '').split(',');
  const tags: string[] = [];
  for (const t of rawTags) {
    const tag = t.trim().slice(0, TAG_MAX);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= TAGS_MAX) break;
  }

  const body = String(raw.body ?? '');
  if (body.length > BODY_MAX) throw new Error(`Nội dung quá dài (tối đa ${BODY_MAX} ký tự).`);

  return { name, tags, body };
}

function fromDoc(d: Document): WorkNote {
  return {
    id: String(d._id),
    name: typeof d.name === 'string' ? d.name : '',
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    body: typeof d.body === 'string' ? d.body : '',
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
  };
}

const LIST_CAP = 1000;

/** Toàn bộ ghi chú, sửa gần nhất lên trước (cap 1000 — client tự lọc/tìm). */
export async function listNotes(): Promise<WorkNote[]> {
  const c = await coll();
  const docs = await c.find({}).sort({ updatedAt: -1, createdAt: -1 }).limit(LIST_CAP).toArray();
  return docs.map(fromDoc);
}

export async function addNote(raw: Record<string, unknown>): Promise<WorkNote> {
  const base = sanitize(raw);
  const now = Date.now();
  const note: WorkNote = { ...base, id: randomUUID(), createdAt: now, updatedAt: now };
  const c = await coll();
  await c.insertOne({ _id: note.id as unknown as Document['_id'], ...note });
  return note;
}

export async function updateNote(id: unknown, raw: Record<string, unknown>): Promise<WorkNote> {
  const nid = String(id ?? '');
  if (!nid) throw new Error('Thiếu id ghi chú.');
  const base = sanitize(raw);
  const c = await coll();
  const updatedAt = Date.now();
  const res = await c.updateOne(
    { _id: nid as unknown as Document['_id'] },
    { $set: { ...base, updatedAt } },
  );
  if (res.matchedCount !== 1) throw new Error('Không tìm thấy ghi chú.');
  const doc = await c.findOne({ _id: nid as unknown as Document['_id'] });
  return doc ? fromDoc(doc) : { ...base, id: nid, createdAt: updatedAt, updatedAt };
}

export async function removeNote(id: unknown): Promise<void> {
  const nid = String(id ?? '');
  if (!nid) throw new Error('Thiếu id ghi chú.');
  const c = await coll();
  await c.deleteOne({ _id: nid as unknown as Document['_id'] });
}
