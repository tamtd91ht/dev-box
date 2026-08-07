// /api/remote — sổ máy từ xa cho tab Remote (lib/remoteHosts).
//
// Chỉ đọc/ghi configs/remote-hosts.json. KHÔNG kết nối đi đâu và KHÔNG chạy
// chương trình nào: việc bật client (UltraViewer/mstsc/…) do main process
// Electron làm, qua IPC 'workspace:openRemote' — renderer chỉ được chọn trong
// danh sách client đã khai sẵn, không truyền đường dẫn tuỳ ý.
//
// Mật khẩu đi qua đây LUÔN ở dạng ciphertext safeStorage (trường passwordEnc);
// route này không bao giờ thấy plaintext.
//
//   POST { action, ... }:
//     'list'   {}                                    → { ok, result: RemoteHost[] }
//     'add'    { name, kind, address, ... }           → { ok, result: RemoteHost[] }
//     'update' { id, ...patch }                       → { ok, result: RemoteHost[] }
//     'remove' { id }                                 → { ok, result: RemoteHost[] }
//     'touch'  { id }                                 → { ok, result: RemoteHost[] }

import { NextResponse, type NextRequest } from 'next/server';
import {
  listHosts, addHost, updateHost, removeHost, touchHost,
  REMOTE_KINDS, type RemoteHostInput, type RemoteKind,
} from '@/lib/remoteHosts';

export const runtime = 'nodejs';

function inputFrom(body: Record<string, unknown>): RemoteHostInput {
  const p: RemoteHostInput = {};
  if (typeof body.name === 'string') p.name = body.name;
  if (typeof body.kind === 'string' && REMOTE_KINDS.includes(body.kind as RemoteKind)) {
    p.kind = body.kind as RemoteKind;
  }
  if (typeof body.address === 'string') p.address = body.address;
  if (typeof body.username === 'string') p.username = body.username;
  // null nghĩa là "xoá mật khẩu", phân biệt với không gửi trường này.
  if (body.passwordEnc === null) p.passwordEnc = null;
  else if (typeof body.passwordEnc === 'string') p.passwordEnc = body.passwordEnc;
  if (typeof body.project === 'string') p.project = body.project;
  if (typeof body.note === 'string') p.note = body.note;
  if (body.network === 'lan' || body.network === 'wan') p.network = body.network;
  if (Array.isArray(body.tags)) p.tags = body.tags.map(String);
  return p;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  try {
    let result: unknown;
    switch (action) {
      case 'list':
        result = await listHosts();
        break;
      case 'add':
        result = await addHost(inputFrom(body));
        break;
      case 'update':
        result = await updateHost(String(body.id ?? ''), inputFrom(body));
        break;
      case 'remove':
        result = await removeHost(String(body.id ?? ''));
        break;
      case 'touch':
        result = await touchHost(String(body.id ?? ''));
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'Remote operation failed' },
      { status: 502 },
    );
  }
}
