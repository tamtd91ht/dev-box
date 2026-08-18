// /api/work — tab Công việc (task management, lưu trên MongoDB).
//
//   GET                    → snapshot cảnh báo (WorkAlertHost poll; tự khởi
//                            động scheduler nếu chưa chạy).
//   POST { action, ... }:
//     'config'       {}                          → { configured, config, connectionName, connections }
//     'config-set'   { connectionId, database }  → như 'config' (validate connection tồn tại)
//     'list'         {}                          → { tasks }
//
// Thêm connection MỚI: UI dùng thẳng form + API của menu Mongo
// (/api/mongo-connections) — cùng một registry, không có đường riêng ở đây.
//     'add'          { ...task }                 → { task }   (quét cảnh báo ngay sau đó)
//
// Task có 2 loại qua field 'kind': 'daily' (việc trong ngày, cần startTime +
// endTime, không cảnh báo, không trạng thái — server ép 'done' và 'status' từ
// chối loại này) và 'deadline' (cần dlDate/dlTime + alert). Thiếu 'kind' → hiểu
// là 'deadline' (tương thích client/dữ liệu cũ).
//     'update'       { id, ...task }             → { ok }
//     'status'       { id, status }              → { ok }   status ∈ pending|active|done|cancelled
//     'remove'       { id }                      → { ok }
//
// GHI CHÚ (kho riêng, collection 'devbox_work_notes' — cùng cụm/db với task):
//     'notes-list'   {}                          → { notes }
//     'note-add'     { name, tags, body }        → { note }
//     'note-update'  { id, name, tags, body }    → { note }
//     'note-remove'  { id }                      → { ok }
//
// Gate theo MONGO_TOOL_ENABLED — tính năng sống trên cụm Mongo do người dùng
// quản lý trong tab Mongo, tắt tool Mongo là tắt luôn chỗ này.

import { NextResponse, type NextRequest } from 'next/server';
import { MONGO_ENABLED } from '@/lib/mongoClient';
import {
  getWorkConfigView, setWorkConfig, listTasks, addTask, updateTask, setTaskStatus, removeTask,
} from '@/lib/workTasks';
import { listNotes, addNote, updateNote, removeNote } from '@/lib/workNotes';
import { ensureWorkWatch, getWorkWatchState, runWorkWatchNow } from '@/lib/workWatch';

export const runtime = 'nodejs';

function disabled() {
  return NextResponse.json(
    { ok: false, error: 'Mongo tool đang tắt. Set MONGO_TOOL_ENABLED=true trong .env.local để dùng tab Công việc.' },
    { status: 403 },
  );
}

export async function GET() {
  if (!MONGO_ENABLED) return NextResponse.json({ enabled: false, alerts: [], alertSeq: 0 });
  ensureWorkWatch();
  return NextResponse.json({ enabled: true, ...getWorkWatchState() });
}

export async function POST(req: NextRequest) {
  if (!MONGO_ENABLED) return disabled();
  ensureWorkWatch();

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  try {
    let result: unknown;
    switch (action) {
      case 'config':
        result = await getWorkConfigView();
        break;
      case 'config-set':
        await setWorkConfig(body.connectionId, body.database);
        result = await getWorkConfigView();
        break;
      case 'list':
        result = { tasks: await listTasks() };
        break;
      case 'add': {
        const task = await addTask(body);
        // Quét ngay: task deadline sát giờ (hoặc cấu hình cảnh báo đã qua giờ)
        // được nhắc liền thay vì đợi tick sau.
        void runWorkWatchNow();
        result = { task };
        break;
      }
      case 'update':
        await updateTask(body.id, body);
        void runWorkWatchNow();
        result = { ok: true };
        break;
      case 'status':
        await setTaskStatus(body.id, body.status);
        result = { ok: true };
        break;
      case 'remove':
        await removeTask(body.id);
        result = { ok: true };
        break;
      // ── Ghi chú — kho phẳng, không cảnh báo nên không đụng workWatch ──────
      case 'notes-list':
        result = { notes: await listNotes() };
        break;
      case 'note-add':
        result = { note: await addNote(body) };
        break;
      case 'note-update':
        result = { note: await updateNote(body.id, body) };
        break;
      case 'note-remove':
        await removeNote(body.id);
        result = { ok: true };
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message || 'work operation failed' }, { status: 400 });
  }
}
