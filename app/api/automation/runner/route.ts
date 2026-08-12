// /api/automation/runner — lease "ai được chạy watch-runner".
//
//   POST { holderId } → { leader: boolean, holder, ttlMs }
//
// Vì sao tồn tại: watcher chạy phía renderer, và MỖI cửa sổ mount một watcher
// riêng — Electron + browser dev mở cùng lúc là HAI runner poll độc lập, hai bộ
// cooldown riêng, tin cảnh báo xen kẽ nhau dưới mọi giới hạn đã đặt (bằng chứng:
// heartbeat đi theo cặp lệch ~12s trong .automation-trace.jsonl). Mọi cửa sổ
// đều nói chuyện với đúng MỘT Next server, nên server phát lease: ai giữ lease
// thì poll, còn lại đứng chờ (standby) và tự tiếp quản khi leader tắt.
//
// Lease nằm trên globalThis (RAM của server) có chủ đích: server restart thì
// lease trống và cửa sổ nào renew trước sẽ nhận — không cần file, không cần dọn.

import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';

/** Watcher renew mỗi tick 2s — 8s không renew nghĩa là cửa sổ đó đã đóng/treo. */
const TTL_MS = 8000;

interface Lease {
  holder: string;
  at: number;
}

const g = globalThis as unknown as { __autoRunnerLease?: Lease };

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.holderId === 'string' ? body.holderId.trim() : '';
  if (!id) return NextResponse.json({ error: 'holderId là bắt buộc' }, { status: 400 });

  const now = Date.now();
  const cur = g.__autoRunnerLease;
  if (!cur || cur.holder === id || now - cur.at > TTL_MS) {
    g.__autoRunnerLease = { holder: id, at: now };
    return NextResponse.json({ leader: true, holder: id, ttlMs: TTL_MS });
  }
  return NextResponse.json({ leader: false, holder: cur.holder, ttlMs: TTL_MS });
}
