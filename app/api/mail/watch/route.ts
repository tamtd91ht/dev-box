// /api/mail/watch — trạng thái tiến trình đếm mail chưa đọc 10 phút/lần.
//
//   GET  → snapshot mới nhất (đồng thời đảm bảo scheduler đã chạy).
//   POST → kiểm ngay một lượt rồi trả snapshot.
//
// Chỉ trả số liệu tổng hợp (label/email/unseen) — không bao giờ lộ password
// (registry tài khoản nằm server-side, xem lib/mailAccounts).

import { NextResponse } from 'next/server';
import { ensureMailWatch, getMailWatchState, runMailWatchNow } from '@/lib/mailWatch';

export const runtime = 'nodejs';

export async function GET() {
  ensureMailWatch();
  return NextResponse.json(getMailWatchState());
}

export async function POST() {
  ensureMailWatch();
  return NextResponse.json(await runMailWatchNow());
}
