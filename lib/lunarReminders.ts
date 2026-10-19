// Server-only: kho GHI CHÚ / LỜI NHẮC ÂM LỊCH của tab Công việc.
//
// Cùng cụm/db Mongo với task (lib/workTasks.workColl), collection riêng
// 'devbox_lunar_reminders'. Luật lặp + giờ nhắc ở lib/lunarReminderCore (dùng
// chung với client để vẽ lên lịch).
//
// Nhắc: workWatch gọi runLunarSweep mỗi phút. Mỗi lần xuất hiện chỉ bắn MỘT
// lần — đánh dấu lastNotifiedFor = ngày dương của lần xuất hiện bằng updateOne
// có điều kiện, nên nhiều máy cùng quét cũng không nhắc trùng.

import { randomUUID } from 'crypto';
import type { Collection, Document } from 'mongodb';
import { workColl, todayStr } from './workTasks';
import { lunarOf } from './lunar';
import {
  addDays, fireAtMs, occursOn, LUNAR_REPEATS,
  type LunarReminder, type LunarReminderAlert, type LunarRepeat,
} from './lunarReminderCore';

export const LUNAR_COLLECTION = 'devbox_lunar_reminders';

const TITLE_MAX = 200;
const NOTE_MAX = 20_000;
/** Nhắc trước tối đa — cũng là số ngày phía trước runLunarSweep phải dò. */
const DAYS_BEFORE_MAX = 30;

const coll = () => workColl(LUNAR_COLLECTION);
const idOf = (id: string) => id as unknown as Document['_id'];

function parseAlert(raw: unknown): LunarReminderAlert | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const daysBefore = Math.floor(Number(o.daysBefore));
  if (!Number.isFinite(daysBefore) || daysBefore < 0 || daysBefore > DAYS_BEFORE_MAX) {
    throw new Error(`Số ngày nhắc trước phải từ 0 đến ${DAYS_BEFORE_MAX}.`);
  }
  const time = String(o.time ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Giờ nhắc không hợp lệ (HH:mm).');
  return { daysBefore, time };
}

/** Validate input client. Ngày âm suy ra từ anchorDate (dương) — không tin client tự tính. */
function sanitize(raw: Record<string, unknown>) {
  const title = String(raw.title ?? '').trim();
  if (!title) throw new Error('Tiêu đề là bắt buộc.');
  if (title.length > TITLE_MAX) throw new Error(`Tiêu đề quá dài (tối đa ${TITLE_MAX} ký tự).`);
  const note = String(raw.note ?? '');
  if (note.length > NOTE_MAX) throw new Error(`Nội dung quá dài (tối đa ${NOTE_MAX} ký tự).`);
  const anchorDate = String(raw.anchorDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) throw new Error('Ngày không hợp lệ.');
  const repeat = String(raw.repeat ?? 'none') as LunarRepeat;
  if (!LUNAR_REPEATS.includes(repeat)) throw new Error('Kiểu lặp không hợp lệ.');
  const l = lunarOf(anchorDate);
  return {
    title, note, anchorDate, repeat,
    lDay: l.day, lMonth: l.month, lYear: l.year, leap: l.leap,
    alert: parseAlert(raw.alert),
  };
}

function fromDoc(d: Document): LunarReminder {
  const x = d as Partial<LunarReminder>;
  return {
    id: String(d._id),
    title: String(x.title ?? ''),
    note: String(x.note ?? ''),
    lDay: Number(x.lDay) || 1,
    lMonth: Number(x.lMonth) || 1,
    lYear: Number(x.lYear) || 0,
    leap: x.leap === true,
    anchorDate: String(x.anchorDate ?? ''),
    repeat: LUNAR_REPEATS.includes(x.repeat as LunarRepeat) ? (x.repeat as LunarRepeat) : 'none',
    alert: x.alert && typeof x.alert === 'object' ? (x.alert as LunarReminderAlert) : null,
    lastNotifiedFor: typeof x.lastNotifiedFor === 'string' ? x.lastNotifiedFor : null,
    createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0,
    updatedAt: typeof x.updatedAt === 'number' ? x.updatedAt : 0,
  };
}

export async function listLunarReminders(): Promise<LunarReminder[]> {
  const docs = await (await coll()).find({}).limit(5000).toArray();
  return docs.map(fromDoc);
}

export async function addLunarReminder(raw: Record<string, unknown>): Promise<LunarReminder> {
  const now = Date.now();
  const r: LunarReminder = { id: randomUUID(), ...sanitize(raw), lastNotifiedFor: null, createdAt: now, updatedAt: now };
  const { id, ...rest } = r;
  await (await coll()).insertOne({ _id: idOf(id), ...rest });
  return r;
}

export async function updateLunarReminder(id: unknown, raw: Record<string, unknown>): Promise<LunarReminder> {
  const nid = String(id ?? '');
  if (!nid) throw new Error('Thiếu id lời nhắc.');
  const c = await coll();
  const cur = await c.findOne({ _id: idOf(nid) });
  if (!cur) throw new Error('Không tìm thấy lời nhắc.');
  const old = fromDoc(cur);
  const next = sanitize({ ...raw, anchorDate: raw.anchorDate ?? old.anchorDate });
  // Đổi lịch lặp / giờ nhắc → cho phép nhắc lại từ đầu (lần xuất hiện sắp tới
  // có thể chưa nhắc theo cấu hình mới). Chỉ sửa chữ thì giữ cờ, khỏi nhắc lại.
  const reschedule = JSON.stringify([old.repeat, old.lDay, old.lMonth, old.lYear, old.leap, old.alert])
    !== JSON.stringify([next.repeat, next.lDay, next.lMonth, next.lYear, next.leap, next.alert]);
  const updated: LunarReminder = {
    ...old, ...next,
    lastNotifiedFor: reschedule ? null : old.lastNotifiedFor,
    updatedAt: Date.now(),
  };
  const { id: _id, ...rest } = updated;
  await c.replaceOne({ _id: idOf(nid) }, rest);
  return updated;
}

export async function removeLunarReminder(id: unknown): Promise<void> {
  const nid = String(id ?? '');
  if (!nid) throw new Error('Thiếu id lời nhắc.');
  await (await coll()).deleteOne({ _id: idOf(nid) });
}

// ── Nhắc ────────────────────────────────────────────────────────────────────

export interface LunarAlertEvent {
  kind: 'lunar';
  reminder: LunarReminder;
  message: string;
  at: number;
}

/**
 * Một lượt quét: với mỗi lời nhắc có cấu hình nhắc, dò các lần xuất hiện từ hôm
 * nay tới (hôm nay + daysBefore); lần nào đã tới giờ bắn mà chưa nhắc thì đánh
 * dấu rồi phát sự kiện. Lần xuất hiện ĐÃ QUA (trước hôm nay) không nhắc bù.
 */
export async function runLunarSweep(now = Date.now()): Promise<LunarAlertEvent[]> {
  let c: Collection<Document>;
  try { c = await coll(); } catch { return []; }
  const today = todayStr(new Date(now));
  const events: LunarAlertEvent[] = [];
  const docs = await c.find({ alert: { $ne: null } }).limit(5000).toArray();
  for (const d of docs) {
    const r = fromDoc(d);
    if (!r.alert) continue;
    for (let k = 0; k <= r.alert.daysBefore; k++) {
      const day = addDays(today, k);
      if (!occursOn(r, day) || fireAtMs(r.alert, day) > now) continue;
      if (r.lastNotifiedFor && r.lastNotifiedFor >= day) continue;
      const res = await c.updateOne(
        { _id: d._id, lastNotifiedFor: r.lastNotifiedFor },
        { $set: { lastNotifiedFor: day } },
      );
      if (res.modifiedCount !== 1) break; // máy khác vừa nhắc
      r.lastNotifiedFor = day;
      const [y, m, dd] = day.split('-');
      const l = lunarOf(day);
      const when = k === 0 ? 'Hôm nay' : k === 1 ? 'Ngày mai' : `Còn ${k} ngày`;
      events.push({
        kind: 'lunar',
        reminder: r,
        message: `${when} (${l.day}/${l.month}${l.leap ? ' nhuận' : ''} AL · ${dd}/${m}/${y}): ${r.title}`,
        at: now,
      });
      break; // mỗi lượt chỉ nhắc lần xuất hiện gần nhất
    }
  }
  return events;
}
