// /api/google — single dispatch route for the Google tab (Drive read-only).
//
// MULTI-ACCOUNT: 'status' returns every signed-in account; mọi action đụng
// tới Drive đều nhận accountId.
//
//   POST { action, ... }  where action is one of:
//     'status'     {}                            → { ok, result: GoogleStatus }  (accounts[])
//     'authUrl'    {}                            → { ok, result: { url } }       (thêm/đăng nhập lại tài khoản)
//     'logout'     { accountId }                 → { ok, result: { done: true } }
//     'roots'      { accountId }                 → { ok, result: GoogleRoot[] }  (roots của tài khoản đó)
//     'rootAdd'    { accountId, url, name? }     → { ok, result: GoogleRoot[] }  (validates via files.get)
//     'rootRemove' { id }                        → { ok, result: GoogleRoot[] }  (all accounts' roots)
//     'rootRename' { id, name }                  → { ok, result: GoogleRoot[] }
//     'browse'     { accountId, folderId }       → { ok, result: DriveList }
//     'list'       { accountId, kind: 'docs'|'sheets', q?, starred?, pageToken? } → { ok, result: DriveList }
//
// Everything is READ-ONLY against Google (scope drive.readonly; only
// files.list/files.get are called) — editing opens Google's own UI in the
// browser. Gated by GOOGLE_TOOL_ENABLED (403 when off).

import { NextResponse, type NextRequest } from 'next/server';
import { GOOGLE_ENABLED, authUrl, logout, status } from '@/lib/googleAuth';
import { browseFolder, listByKind, getFile, extractDriveId, MIME } from '@/lib/googleDrive';
import { listRoots, addRoot, removeRoot, renameRoot } from '@/lib/googleRoots';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!GOOGLE_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Google tool is disabled. Set GOOGLE_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  // Mọi action đụng Drive/registry theo tài khoản đều cần accountId tường minh.
  const accountId = String(body.accountId ?? '');
  const needAccount = () => {
    if (!accountId) throw new Error('Thiếu accountId — chọn tài khoản Google trước.');
    return accountId;
  };

  try {
    let result: unknown;
    switch (action) {
      case 'status':
        result = await status();
        break;
      case 'authUrl':
        result = { url: authUrl() };
        break;
      case 'logout':
        await logout(needAccount());
        result = { done: true };
        break;
      case 'roots':
        result = await listRoots(needAccount());
        break;
      case 'rootAdd': {
        const acc = needAccount();
        const url = String(body.url ?? '');
        const folderId = extractDriveId(url);
        if (!folderId) throw new Error('Không nhận ra link Google Drive — dán link dạng …/drive/folders/<id>.');
        const meta = await getFile(acc, folderId); // validates access + fetches the real name
        if (meta.mimeType !== MIME.folder) throw new Error(`Link này là "${meta.name}" (${meta.mimeType}) — cần link THƯ MỤC.`);
        const name = String(body.name ?? '').trim() || meta.name;
        result = await addRoot({ accountId: acc, name, folderId, url });
        break;
      }
      case 'rootRemove':
        result = await removeRoot(String(body.id ?? ''));
        break;
      case 'rootRename':
        result = await renameRoot(String(body.id ?? ''), String(body.name ?? ''));
        break;
      case 'browse':
        result = await browseFolder(needAccount(), String(body.folderId ?? ''));
        break;
      case 'list': {
        const kind = body.kind === 'sheets' ? 'sheets' : 'docs';
        result = await listByKind(needAccount(), {
          kind,
          q: typeof body.q === 'string' ? body.q : undefined,
          starred: body.starred === true,
          pageToken: typeof body.pageToken === 'string' ? body.pageToken : undefined,
        });
        break;
      }
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = (err as Error).message || 'Google operation failed';
    const auth = msg.includes('Chưa đăng nhập') || msg.includes('Thiếu accountId');
    return NextResponse.json({ ok: false, error: msg }, { status: auth ? 401 : 502 });
  }
}
