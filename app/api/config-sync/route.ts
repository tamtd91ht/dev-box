// /api/config-sync — đồng bộ configs/ của máy này với repo dev-box-config.
//
//   POST { action }:
//     'status' {}                     → SyncStatus (sẵn sàng chưa, lần push cuối, ahead/behind)
//     'setup'  {}                     → cài age + clone repo + sinh machine.json (máy mới)
//     'push'   {}                     → đóng gói + mã hoá + commit + push. KHÔNG cần passphrase.
//     'pull'   {passphrase, force?}   → git pull + giải mã + ghi vào configs/. CẦN passphrase.
//                                       force: reset --hard origin, bỏ thay đổi local.
//
// Passphrase chỉ đi qua body của request này, không log, không lưu. Sau khi
// dùng để mở private key thì file tạm bị ghi đè zero rồi xoá (xem lib/configSync).

import { NextResponse, type NextRequest } from 'next/server';
import { getStatus, setup, push, pull } from '@/lib/configSync';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { action?: string; passphrase?: string; remote?: boolean; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body phải là JSON.' }, { status: 400 });
  }

  const { action } = body;
  try {
    if (action === 'status') {
      return NextResponse.json({ ok: true, result: await getStatus() });
    }
    if (action === 'setup') {
      return NextResponse.json({ ok: true, result: await setup() });
    }
    if (action === 'push') {
      return NextResponse.json({ ok: true, result: await push({ remote: body.remote }) });
    }
    if (action === 'pull') {
      if (!body.passphrase) {
        return NextResponse.json({ ok: false, error: 'Thiếu passphrase.' }, { status: 400 });
      }
      return NextResponse.json({ ok: true, result: await pull(body.passphrase, { force: body.force }) });
    }
    return NextResponse.json({ ok: false, error: `action không hợp lệ: ${action}` }, { status: 400 });
  } catch (e) {
    // Thông báo lỗi từ configSync đã viết cho người đọc — trả nguyên văn.
    // `code` để UI biết đây là trường hợp xử lý được bằng nút (vd DIVERGED →
    // hiện "Ghi đè bằng bản trên GitHub") thay vì chỉ in lỗi ra.
    const err = e as Error & { code?: string };
    return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 500 });
  }
}
