// /api/self-update — tự cập nhật CHÍNH DevBox từ Git.
//
//   POST { action }:
//     'status' {fetch?}    → UpdateStatus (nhánh, ahead/behind, commit đang chờ,
//                            file bẩn). fetch=true thì chạm mạng để lấy ref mới;
//                            mặc định chỉ đọc cục bộ (rẻ, dùng cho poll).
//     'update' {stash?}    → fetch + merge --ff-only. Repo bẩn thì trả lỗi
//                            code='DIRTY' kèm danh sách file; client hỏi lại
//                            rồi gọi lại với stash=true.
//     'install' {}         → npm install sau khi package.json đổi.
//
// KHÔNG có tham số đường dẫn: lib/selfUpdate khoá cứng vào process.cwd(). Bề
// mặt duy nhất người gọi điều khiển được là `action` — xem mô hình an toàn ở
// đầu lib/selfUpdate.ts.

import { NextResponse, type NextRequest } from 'next/server';
import { execFile } from 'child_process';
import path from 'path';
import { getStatus, pullUpdate } from '@/lib/selfUpdate';

export const runtime = 'nodejs';
/** Trạng thái phụ thuộc thư mục làm việc — không được cache. */
export const dynamic = 'force-dynamic';

/** npm install kéo mạng, có thể lâu — cho hẳn 10 phút rồi mới bỏ cuộc. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Chạy `npm install` trong thư mục app.
 *
 * Trên Windows npm là npm.cmd — execFile không tự tìm ra đuôi .cmd, mà bật
 * shell:true thì lại mở đường cho chèn lệnh. Ở đây không có tham số nào từ
 * người dùng đi vào argv (lệnh cố định hoàn toàn) nên shell là an toàn, và đó
 * là cách gọn nhất để npm chạy được trên cả hai nền tảng.
 */
function npmInstall(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-audit', '--no-fund'],
      {
        cwd: path.resolve(process.cwd()),
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === 'win32',
      },
      (err, stdout, stderr) => {
        const out = (stdout?.toString() ?? '') + (stderr?.toString() ?? '');
        if (err) {
          reject(new Error(out.trim() || (err as Error).message || 'npm install thất bại'));
          return;
        }
        resolve(out.trim());
      },
    );
  });
}

export async function POST(req: NextRequest) {
  let body: { action?: string; fetch?: boolean; stash?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body phải là JSON.' }, { status: 400 });
  }

  const { action } = body;
  try {
    if (action === 'status') {
      return NextResponse.json({ ok: true, result: await getStatus(body.fetch === true) });
    }
    if (action === 'update') {
      return NextResponse.json({ ok: true, result: await pullUpdate(body.stash === true) });
    }
    if (action === 'install') {
      const log = await npmInstall();
      // Chỉ giữ phần đuôi: npm in rất dài mà thông tin hữu ích nằm ở cuối.
      return NextResponse.json({ ok: true, result: { log: log.slice(-4000) } });
    }
    return NextResponse.json(
      { ok: false, error: `action không hợp lệ: ${action}` },
      { status: 400 },
    );
  } catch (e) {
    // Lỗi từ selfUpdate đã viết sẵn cho người đọc — trả nguyên văn. `code` để
    // UI biết ca nào xử lý được bằng nút (DIRTY → "Cất tạm rồi cập nhật"),
    // `files` để nó liệt kê đúng file đang vướng thay vì bắt người dùng đoán.
    const err = e as Error & { code?: string; files?: string[] };
    return NextResponse.json(
      { ok: false, error: err.message, code: err.code, files: err.files },
      { status: 500 },
    );
  }
}
