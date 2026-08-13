// POST /api/term — điều khiển terminal của TAB TERMINAL (độc lập với Code Studio).
//
// Actions:
//   'create'   { cwd?, shell?, label?, cols?, rows? } → { session }
//   'write'    { id, data }                           → { done }
//   'resize'   { id, cols, rows }                     → { done }
//   'rename'   { id, label }                          → { done }
//   'detach'   { id, detached }                       → { done }
//   'kill'     { id }                                 → { done }
//   'list'     {}                                     → { sessions, cwdDefault, cwdHome }
//
// Output của terminal stream qua GET /api/term/<id> (SSE) — xem route con.
//
// KHÁC Code Studio ở chỗ nào: /api/code/termCreate bắt buộc có projectId + mở
// trong root của project Git đã đăng ký. Ở đây `cwd` là TUỲ CHỌN và tự do —
// không chọn thì rơi về thư mục app (process.cwd()). Đó là yêu cầu "cho phép
// chọn thư mục chạy nhưng optional".
//
// Gated by TERMINAL_ENABLED (mặc định theo CODE_TOOL_ENABLED cho tương thích):
// đây là shell access tuỳ ý — local dev tool, không bao giờ expose ra ngoài.

import { NextResponse } from 'next/server';
import { statSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  createSession,
  getSession,
  killSession,
  listSessions,
  renameSession,
  setDetached,
  OWNER_STANDALONE,
  type ShellKind,
} from '@/lib/termSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');

/** Bật khi TERMINAL_ENABLED bật, hoặc kế thừa CODE_TOOL_ENABLED (máy nào đã bật
 *  Code Studio thì có terminal luôn, khỏi sửa .env). */
const ENABLED = on(process.env.TERMINAL_ENABLED) || on(process.env.CODE_TOOL_ENABLED);

/** Thư mục mặc định khi người dùng không chọn gì — chính là folder app. */
const DEFAULT_CWD = process.cwd();

/** Thư mục gốc của người dùng trên máy này (vd C:\Users\Admin). Hộp thoại
 *  "Terminal mới" cho bấm một nút là nhảy thẳng về đây — chỗ hay chạy lệnh
 *  linh tinh nhất, khỏi phải bấm ngược lên qua FolderPicker. */
const HOME_CWD = os.homedir();

const SHELLS: ShellKind[] = ['powershell', 'cmd', 'bash'];

/** cwd người dùng gửi lên: rỗng → thư mục app; có thì phải là đường dẫn tuyệt
 *  đối, có thật, và là thư mục. Không ghép chuỗi từ input — resolve rồi kiểm tra. */
function resolveCwd(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return DEFAULT_CWD;
  const abs = path.resolve(s);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`Thư mục không tồn tại: ${abs}`);
  }
  if (!st.isDirectory()) throw new Error(`Không phải thư mục: ${abs}`);
  return abs;
}

export async function POST(req: Request) {
  if (!ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Terminal đang tắt. Đặt TERMINAL_ENABLED=true (chỉ dùng local).' },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'Body phải là JSON.' }, { status: 400 });
  }

  const action = String(body.action ?? '');
  const idOf = () => String(body.id ?? '');

  try {
    let result: unknown;
    switch (action) {
      case 'create': {
        const s = createSession({
          projectId: OWNER_STANDALONE,
          cwd: resolveCwd(body.cwd),
          shell: SHELLS.find((k) => k === body.shell),
          label: typeof body.label === 'string' ? body.label : undefined,
          cols: Number(body.cols) || undefined,
          rows: Number(body.rows) || undefined,
        });
        // Trả nguyên info như 'list' để client nhét thẳng vào danh sách.
        result = { session: listSessions().find((x) => x.id === s.id) };
        break;
      }
      case 'write': {
        const s = getSession(idOf());
        if (!s) throw new Error('Terminal không tồn tại (đã đóng?).');
        s.write(String(body.data ?? ''));
        result = { done: true };
        break;
      }
      case 'resize': {
        const s = getSession(idOf());
        if (s) s.resize(Number(body.cols) || 80, Number(body.rows) || 24);
        result = { done: true };
        break;
      }
      case 'rename':
        renameSession(idOf(), String(body.label ?? ''));
        result = { done: true };
        break;
      case 'detach':
        setDetached(idOf(), body.detached !== false);
        result = { done: true };
        break;
      case 'kill':
        killSession(idOf());
        result = { done: true };
        break;
      case 'list':
        result = {
          sessions: listSessions(OWNER_STANDALONE),
          cwdDefault: DEFAULT_CWD,
          cwdHome: HOME_CWD,
        };
        break;
      default:
        return NextResponse.json({ ok: false, error: `Action lạ: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...(result as object) });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'Lỗi không rõ.' },
      { status: 400 },
    );
  }
}
