// /api/config-sync — đồng bộ configs/ của máy này với repo dev-box-config.
//
//   POST { action }:
//     'status' {}                     → SyncStatus (sẵn sàng chưa, lần push cuối, ahead/behind)
//     'setup'  {}                     → cài age + clone repo + sinh machine.json (máy mới)
//     'push'   {force?}               → đóng gói + mã hoá + commit + push. KHÔNG cần passphrase.
//                                       Bị chặn (code SHRINK) nếu bản sắp đẩy làm hụt
//                                       vault trên origin; force: bỏ qua, ghi đè hẳn.
//     'pull'   {passphrase, force?}   → git pull + giải mã + ghi vào configs/. CẦN passphrase.
//                                       force: reset --hard origin, bỏ thay đổi local.
//
// Passphrase chỉ đi qua body của request này, không log, không lưu. Sau khi
// dùng để mở private key thì file tạm bị ghi đè zero rồi xoá (xem lib/configSync).

import { NextResponse, type NextRequest } from 'next/server';
import { getStatus, setup, push, pull, SYNC_ENABLED } from '@/lib/configSync';

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
    // 'status' luôn trả lời được — UI cần biết `enabled` để quyết định có vẽ
    // nút hay không, và câu trả lời đó không tiết lộ gì.
    if (action === 'status') {
      return NextResponse.json({ ok: true, result: await getStatus() });
    }
    // Mọi hành động THẬT đều dừng ở đây khi chưa bật. Ẩn nút ở client không
    // phải một ranh giới — chỗ này mới là.
    if (!SYNC_ENABLED) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Đồng bộ config chỉ dành cho chủ repo config (vault là repo private). '
            + 'Chủ sở hữu bật bằng CONFIG_SYNC_ENABLED=true trong .env.local.',
          code: 'DISABLED',
        },
        { status: 403 },
      );
    }
    if (action === 'setup') {
      return NextResponse.json({ ok: true, result: await setup() });
    }
    if (action === 'push') {
      return NextResponse.json({
        ok: true,
        result: await push({ remote: body.remote, force: body.force }),
      });
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
    // hiện "Ghi đè bằng bản trên GitHub"), `detail` để nó liệt kê được cụ thể
    // file nào sắp mất (SHRINK) chứ không bắt người dùng đoán.
    const err = e as Error & { code?: string; detail?: unknown };
    return NextResponse.json(
      { ok: false, error: err.message, code: err.code, detail: err.detail },
      { status: 500 },
    );
  }
}
