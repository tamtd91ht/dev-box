// Server-only: kho CÔNG VIỆC (task management) — lưu trên MongoDB.
//
// Khác mọi registry local khác của DevBox: task là dữ liệu GLOBAL (nhiều máy
// cùng thấy) nên nằm trong một cụm Mongo do người dùng chọn từ danh sách
// quản lý Mongo hiện có (lib/mongoConnections). File config local chỉ giữ
// CON TRỎ (connectionId + database); collection cố định 'devbox_work_tasks'.
//
// Cảnh báo (xem workWatch):
//   · NGÀY BẮT ĐẦU — chỉ khi task được TẠO cho một ngày tương lai (createdDate
//     < startDate, so theo NGÀY không quan tâm giờ): tới ngày đó thì nhắc.
//   · DEADLINE — theo cấu hình per-task: trước X phút, hoặc trước N ngày lúc
//     HH:mm. Mỗi loại chỉ bắn MỘT lần (đánh dấu *NotifiedAt trong document,
//     nên nhiều máy cùng mở cũng không nhắc trùng).

import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import type { Collection, Document } from 'mongodb';
import { configPath } from './configDir';
import { getConnection, listConnections, type PublicMongoConnection } from './mongoConnections';
import { internalClient } from './mongoClient';

export const WORK_COLLECTION = 'devbox_work_tasks';

// ── Config (con trỏ tới cụm Mongo) ──────────────────────────────────────────

export interface WorkConfig {
  connectionId: string;
  database: string;
}

const CONFIG_FILE = configPath('worktasks.json', []);

async function readConfig(): Promise<WorkConfig | null> {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')) as Partial<WorkConfig>;
    if (typeof raw.connectionId === 'string' && raw.connectionId && typeof raw.database === 'string' && raw.database) {
      return { connectionId: raw.connectionId, database: raw.database };
    }
  } catch { /* chưa cấu hình */ }
  return null;
}

export interface WorkConfigView {
  configured: boolean;
  config: WorkConfig | null;
  /** Tên connection đang trỏ (null khi connection đã bị xóa khỏi registry). */
  connectionName: string | null;
  connections: PublicMongoConnection[];
}

export async function getWorkConfigView(): Promise<WorkConfigView> {
  const config = await readConfig();
  const connections = await listConnections();
  const conn = config ? connections.find((c) => c.id === config.connectionId) : undefined;
  return {
    configured: !!config && !!conn,
    config,
    connectionName: conn?.name ?? null,
    connections,
  };
}

export async function setWorkConfig(connectionId: unknown, database: unknown): Promise<void> {
  const id = String(connectionId ?? '').trim();
  const db = String(database ?? '').trim();
  if (!id) throw new Error('Chọn một MongoDB connection.');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(db)) throw new Error('Tên database không hợp lệ (a-z, 0-9, _, -).');
  if (!(await getConnection(id))) throw new Error('Connection không tồn tại trong danh sách quản lý Mongo.');
  await fs.writeFile(CONFIG_FILE, JSON.stringify({ connectionId: id, database: db }, null, 2) + '\n', 'utf8');
}

async function coll(): Promise<Collection<Document>> {
  const cfg = await readConfig();
  if (!cfg) throw new Error('Chưa cấu hình MongoDB cho tab Công việc.');
  const conn = await getConnection(cfg.connectionId);
  if (!conn) throw new Error('Connection đã bị xóa khỏi danh sách quản lý Mongo — cấu hình lại.');
  return internalClient(conn).db(cfg.database).collection(WORK_COLLECTION);
}

// ── Task model ───────────────────────────────────────────────────────────────

export type WorkPriority = 'low' | 'normal' | 'high' | 'urgent';

export type WorkAlert =
  | { kind: 'offset'; minutes: number }                    // trước deadline X phút
  | { kind: 'daily'; daysBefore: number; time: string };   // trước N ngày, lúc HH:mm

export interface WorkTask {
  id: string;
  project: string;
  name: string;
  desc: string;
  priority: WorkPriority;
  tags: string[];
  /** Ngày bắt đầu 'YYYY-MM-DD' (chọn từ lịch). */
  startDate: string;
  /** Deadline cam kết — ngày + giờ local, kèm epoch ms để tính cảnh báo. */
  dlDate: string | null;
  dlTime: string | null;
  deadlineMs: number | null;
  alert: WorkAlert | null;
  status: 'open' | 'done';
  createdAt: number;
  /** 'YYYY-MM-DD' local lúc tạo — luật nhắc ngày bắt đầu so theo NGÀY. */
  createdDate: string;
  doneAt: number | null;
  startNotifiedAt: number | null;
  deadlineNotifiedAt: number | null;
}

export function todayStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const PRIORITIES: WorkPriority[] = ['low', 'normal', 'high', 'urgent'];

function parseAlert(raw: unknown): WorkAlert | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === 'offset') {
    const minutes = Math.floor(Number(o.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 30) throw new Error('Cấu hình cảnh báo (phút) không hợp lệ.');
    return { kind: 'offset', minutes };
  }
  if (o.kind === 'daily') {
    const daysBefore = Math.floor(Number(o.daysBefore));
    const time = String(o.time ?? '');
    if (!Number.isFinite(daysBefore) || daysBefore < 0 || daysBefore > 30) throw new Error('Số ngày cảnh báo trước không hợp lệ.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Giờ cảnh báo không hợp lệ (HH:mm).');
    return { kind: 'daily', daysBefore, time };
  }
  return null;
}

/** Validate + chuẩn hóa input từ client thành task (add) hoặc patch (update). */
function sanitize(raw: Record<string, unknown>): Omit<WorkTask, 'id' | 'createdAt' | 'createdDate' | 'doneAt' | 'startNotifiedAt' | 'deadlineNotifiedAt' | 'status'> {
  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error('Tên công việc là bắt buộc.');
  const startDate = String(raw.startDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('Ngày bắt đầu không hợp lệ (YYYY-MM-DD).');

  const priority = PRIORITIES.includes(raw.priority as WorkPriority) ? (raw.priority as WorkPriority) : 'normal';
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
    : String(raw.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);

  let dlDate: string | null = null;
  let dlTime: string | null = null;
  let deadlineMs: number | null = null;
  const rawDlDate = String(raw.dlDate ?? '').trim();
  if (rawDlDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDlDate)) throw new Error('Ngày deadline không hợp lệ.');
    const rawDlTime = String(raw.dlTime ?? '').trim() || '18:00';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rawDlTime)) throw new Error('Giờ deadline không hợp lệ (HH:mm).');
    const ms = new Date(`${rawDlDate}T${rawDlTime}:00`).getTime();
    if (!Number.isFinite(ms)) throw new Error('Deadline không hợp lệ.');
    dlDate = rawDlDate; dlTime = rawDlTime; deadlineMs = ms;
  }

  const alert = deadlineMs !== null ? parseAlert(raw.alert) : null;

  return {
    project: String(raw.project ?? '').trim(),
    name,
    desc: String(raw.desc ?? '').trim(),
    priority,
    tags,
    startDate,
    dlDate,
    dlTime,
    deadlineMs,
    alert,
  };
}

function fromDoc(d: Document): WorkTask {
  return {
    id: String(d._id),
    project: d.project ?? '',
    name: d.name ?? '',
    desc: d.desc ?? '',
    priority: PRIORITIES.includes(d.priority) ? d.priority : 'normal',
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    startDate: d.startDate ?? '',
    dlDate: d.dlDate ?? null,
    dlTime: d.dlTime ?? null,
    deadlineMs: typeof d.deadlineMs === 'number' ? d.deadlineMs : null,
    alert: d.alert ?? null,
    status: d.status === 'done' ? 'done' : 'open',
    createdAt: d.createdAt ?? 0,
    createdDate: d.createdDate ?? '',
    doneAt: d.doneAt ?? null,
    startNotifiedAt: d.startNotifiedAt ?? null,
    deadlineNotifiedAt: d.deadlineNotifiedAt ?? null,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

const LIST_CAP = 1000;

/** Toàn bộ task (cap 1000, mới nhất trước theo startDate) — khối lượng task cá
 *  nhân/team nhỏ, client tự lọc theo tháng đang xem. */
export async function listTasks(): Promise<WorkTask[]> {
  const c = await coll();
  const docs = await c.find({}).sort({ startDate: -1, createdAt: -1 }).limit(LIST_CAP).toArray();
  return docs.map(fromDoc);
}

export async function addTask(raw: Record<string, unknown>): Promise<WorkTask> {
  const base = sanitize(raw);
  const task: WorkTask = {
    ...base,
    id: randomUUID(),
    status: 'open',
    createdAt: Date.now(),
    createdDate: todayStr(),
    doneAt: null,
    startNotifiedAt: null,
    deadlineNotifiedAt: null,
  };
  // Giờ nhắc đã Ở QUÁ KHỨ ngay lúc tạo (vd deadline 12:00 hôm nay, cảnh báo
  // trước 3h, tạo lúc 10:30) → coi như đã qua cửa sổ nhắc, KHÔNG bắn liền một
  // cảnh báo vô nghĩa ngay sau khi bấm lưu. Deadline còn ở tương lai thì UI
  // vẫn hiện đếm ngược; người tạo vốn đã biết task này gấp.
  if (task.alert && task.deadlineMs !== null) {
    const at = alertAtMs(task);
    if (at !== null && at <= task.createdAt) task.deadlineNotifiedAt = task.createdAt;
  }
  const c = await coll();
  await c.insertOne({ _id: task.id as unknown as Document['_id'], ...task });
  return task;
}

export async function updateTask(id: unknown, raw: Record<string, unknown>): Promise<void> {
  const tid = String(id ?? '');
  if (!tid) throw new Error('Thiếu id.');
  const base = sanitize(raw);
  const c = await coll();
  // Đổi deadline/cấu hình cảnh báo → reset cờ đã-nhắc-deadline để nhắc lại
  // theo lịch mới. Cờ ngày bắt đầu giữ nguyên trừ khi đổi startDate.
  const cur = await c.findOne({ _id: tid as unknown as Document['_id'] });
  if (!cur) throw new Error('Không tìm thấy công việc.');
  const resetDeadline = cur.deadlineMs !== base.deadlineMs || JSON.stringify(cur.alert ?? null) !== JSON.stringify(base.alert ?? null);
  const resetStart = cur.startDate !== base.startDate;
  // Reset cờ nhắc — nhưng nếu lịch nhắc MỚI đã ở quá khứ thì đánh dấu luôn là
  // đã qua cửa sổ nhắc (không bắn liền ngay sau khi sửa) — cùng luật addTask.
  let deadlineNotifiedAt: number | null | undefined;
  if (resetDeadline) {
    deadlineNotifiedAt = null;
    if (base.alert && base.deadlineMs !== null) {
      const at = alertAtMs({ ...base, alert: base.alert, deadlineMs: base.deadlineMs, dlDate: base.dlDate } as WorkTask);
      if (at !== null && at <= Date.now()) deadlineNotifiedAt = Date.now();
    }
  }
  await c.updateOne(
    { _id: tid as unknown as Document['_id'] },
    {
      $set: {
        ...base,
        ...(deadlineNotifiedAt !== undefined ? { deadlineNotifiedAt } : {}),
        ...(resetStart ? { startNotifiedAt: null } : {}),
      },
    },
  );
}

export async function setTaskStatus(id: unknown, status: unknown): Promise<void> {
  const tid = String(id ?? '');
  const st = status === 'done' ? 'done' : 'open';
  const c = await coll();
  await c.updateOne(
    { _id: tid as unknown as Document['_id'] },
    { $set: { status: st, doneAt: st === 'done' ? Date.now() : null } },
  );
}

export async function removeTask(id: unknown): Promise<void> {
  const tid = String(id ?? '');
  const c = await coll();
  await c.deleteOne({ _id: tid as unknown as Document['_id'] });
}

// ── Cảnh báo ────────────────────────────────────────────────────────────────

export interface WorkAlertEvent {
  kind: 'start' | 'deadline';
  task: WorkTask;
  /** Diễn giải sẵn cho UI. */
  message: string;
  at: number;
}

/** Thời điểm phải bắn cảnh báo deadline của một task (null = không cấu hình). */
function alertAtMs(t: WorkTask): number | null {
  if (t.deadlineMs === null || !t.alert) return null;
  if (t.alert.kind === 'offset') return t.deadlineMs - t.alert.minutes * 60_000;
  // daily: trước N ngày, lúc HH:mm (theo ngày của deadline).
  if (!t.dlDate) return null;
  const base = new Date(`${t.dlDate}T${t.alert.time}:00`).getTime();
  if (!Number.isFinite(base)) return null;
  return base - t.alert.daysBefore * 86_400_000;
}

function fmtDeadline(t: WorkTask): string {
  if (!t.dlDate) return '';
  const [y, m, d] = t.dlDate.split('-');
  return `${t.dlTime ?? ''} ${d}/${m}/${y}`.trim();
}

/**
 * Một lượt quét cảnh báo: tìm task đến hạn nhắc, ĐÁNH DẤU đã nhắc (điều kiện
 * trong updateOne — hai server cùng quét cũng chỉ một bên thắng), trả về danh
 * sách sự kiện vừa bắn. Chưa cấu hình Mongo → trả [] im lặng.
 */
export async function runAlertSweep(now = Date.now()): Promise<WorkAlertEvent[]> {
  let c: Collection<Document>;
  try {
    c = await coll();
  } catch {
    return []; // chưa cấu hình — không phải lỗi
  }
  const today = todayStr(new Date(now));
  const events: WorkAlertEvent[] = [];

  // 1) Nhắc NGÀY BẮT ĐẦU — task tạo cho ngày tương lai, hôm nay đã tới ngày đó.
  const startDue = await c.find({
    status: 'open',
    startNotifiedAt: null,
    startDate: { $lte: today },
    $expr: { $lt: ['$createdDate', '$startDate'] }, // chỉ task tạo TRƯỚC ngày bắt đầu
  }).limit(50).toArray();
  for (const d of startDue) {
    const res = await c.updateOne(
      { _id: d._id, startNotifiedAt: null },
      { $set: { startNotifiedAt: now } },
    );
    if (res.modifiedCount !== 1) continue; // máy khác vừa nhắc rồi
    const task = fromDoc(d);
    events.push({
      kind: 'start',
      task,
      message: `Hôm nay bắt đầu: ${task.name}${task.project ? ` (${task.project})` : ''}${task.dlDate ? ` — deadline ${fmtDeadline(task)}` : ''}`,
      at: now,
    });
  }

  // 2) Nhắc GẦN DEADLINE — đến giờ cảnh báo đã cấu hình.
  const dlCandidates = await c.find({
    status: 'open',
    deadlineNotifiedAt: null,
    deadlineMs: { $ne: null },
    alert: { $ne: null },
  }).limit(200).toArray();
  for (const d of dlCandidates) {
    const task = fromDoc(d);
    const at = alertAtMs(task);
    if (at === null || now < at) continue;
    const res = await c.updateOne(
      { _id: d._id, deadlineNotifiedAt: null },
      { $set: { deadlineNotifiedAt: now } },
    );
    if (res.modifiedCount !== 1) continue;
    const overdue = task.deadlineMs !== null && now > task.deadlineMs;
    const left = task.deadlineMs !== null ? Math.round((task.deadlineMs - now) / 60_000) : 0;
    const leftText = overdue
      ? 'ĐÃ QUÁ HẠN'
      : left >= 60 ? `còn ~${Math.round(left / 60)} giờ` : `còn ${left} phút`;
    events.push({
      kind: 'deadline',
      task,
      message: `Deadline ${fmtDeadline(task)} (${leftText}): ${task.name}${task.project ? ` (${task.project})` : ''}`,
      at: now,
    });
  }

  return events;
}
