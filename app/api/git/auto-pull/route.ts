// /api/git/auto-pull — trạng thái tiến trình tự pull Git 10 phút/lần.
//
//   GET  → snapshot mới nhất (đồng thời đảm bảo scheduler đã chạy — phòng khi
//          instrumentation không kích hoạt, ví dụ server khởi động trước khi
//          bật GIT_TOOL_ENABLED).
//   POST → chạy một chu kỳ pull ngay lập tức rồi trả snapshot.
//
// Cùng cổng an toàn với /api/git: tắt hẳn khi GIT_TOOL_ENABLED không bật.

import { NextResponse } from 'next/server';
import { GIT_ENABLED } from '@/lib/gitCore';
import { ensureAutoPull, getAutoPullState, runAutoPullNow } from '@/lib/gitAutoPull';

export const runtime = 'nodejs';

export async function GET() {
  if (!GIT_ENABLED) return NextResponse.json({ enabled: false });
  ensureAutoPull();
  return NextResponse.json(getAutoPullState());
}

export async function POST() {
  if (!GIT_ENABLED) {
    return NextResponse.json(
      { error: 'Git tool is disabled. Set GIT_TOOL_ENABLED=true to enable it (local dev only).' },
      { status: 403 },
    );
  }
  ensureAutoPull();
  return NextResponse.json(await runAutoPullNow());
}
