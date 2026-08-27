// /api/automation/rate-history — lịch sử đo của rate watch.
//
//   GET            → { history: { [watchId]: [{at,value,left?}] } }
//   PUT { history} → { ok: true }
//
// Vì sao đi qua server chứ không nằm trong localStorage của renderer: buffer
// này phải sống sót khi ĐỔI LEADER. Chỉ một cửa sổ giữ lease runner, nên chỉ
// cần đóng đúng cửa sổ đó là cửa sổ khác tiếp quản — với localStorage riêng
// của nó thì buffer rỗng, và rate watch mù trọn một cửa sổ (12 giờ với cấu
// hình dài) mà UI vẫn xanh. Một file dùng chung ở server thì leader mới nạp
// lại được đúng thứ leader cũ đã đo.

import { NextResponse, type NextRequest } from 'next/server';
import { readRateHistory, writeRateHistory } from '@/lib/automation/rateHistoryStore';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ history: await readRateHistory() });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  await writeRateHistory(body?.history);
  return NextResponse.json({ ok: true });
}
