// /api/config-sync — đồng bộ configs/ của máy này với repo dev-box-config.
//
//   POST { action }:
//     'status' {}              → SyncStatus (repo sẵn sàng chưa, lần push cuối, git ahead/behind)
//     'push'   {}              → đóng gói + mã hoá + commit + push. KHÔNG cần passphrase.
//     'pull'   {passphrase}    → git pull + giải mã + ghi vào configs/. CẦN passphrase.
//
// Passphrase chỉ đi qua body của request này, không log, không lưu. Sau khi
// dùng để mở private key thì file tạm bị ghi đè zero rồi xoá (xem lib/configSync).

import { NextResponse, type NextRequest } from 'next/server';
import { getStatus, push, pull } from '@/lib/configSync';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { action?: string; passphrase?: string; remote?: boolean };
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
    if (action === 'push') {
      return NextResponse.json({ ok: true, result: await push({ remote: body.remote }) });
    }
    if (action === 'pull') {
      if (!body.passphrase) {
        return NextResponse.json({ ok: false, error: 'Thiếu passphrase.' }, { status: 400 });
      }
      return NextResponse.json({ ok: true, result: await pull(body.passphrase) });
    }
    return NextResponse.json({ ok: false, error: `action không hợp lệ: ${action}` }, { status: 400 });
  } catch (e) {
    // Thông báo lỗi từ configSync đã viết cho người đọc — trả nguyên văn.
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
