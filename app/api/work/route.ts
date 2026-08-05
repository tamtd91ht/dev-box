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
//     'update'       { id, ...task }             → { ok }
//     'status'       { id, status }              → { ok }   status ∈ pending|active|done|cancelled
//     'remove'       { id }                      → { ok }
//
// Gate theo MONGO_TOOL_ENABLED — tính năng sống trên cụm Mongo do người dùng
// quản lý trong tab Mongo, tắt tool Mongo là tắt luôn chỗ này.

import { NextResponse, type NextRequest } from 'next/server';
import { MONGO_ENABLED } from '@/lib/mongoClient';
import {
  getWorkConfigView, setWorkConfig, listTasks, addTask, updateTask, setTaskStatus, removeTask,
} from '@/lib/workTasks';
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
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message || 'work operation failed' }, { status: 400 });
  }
}
