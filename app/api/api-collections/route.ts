// /api/api-collections — store collection + environment cho tab API.
//   POST { action, ... }:
//     'get'          {}                → ApiData
//     'saveRequest'  { ...ApiRequest } → ApiData   (id có = cập nhật)
//     'removeRequest'{ id }            → ApiData
//     'saveEnv'      { ...ApiEnvironment } → ApiData
//     'removeEnv'    { id }            → ApiData
//     'setActiveEnv' { id | null }     → ApiData
//     'setActiveVarName' { name }      → ApiData   (nhãn mặc định cho biến chưa chọn riêng)
//     'setVarPick'   { scope, key, label } → ApiData (giá trị đang dùng của MỘT biến)
//     'quickSwitchVars' { label }      → ApiData   (mọi biến có nhãn này chuyển sang nó)
//     'saveGlobals' / 'saveProjectVars' nhận thêm { picks } — lựa chọn của phạm vi đó
//     'saveGlobals'  { vars }          → ApiData   (biến chung)
//     'saveProjectVars' { project, vars } → ApiData (biến theo dự án)
//     'importBundle' { requests, projectVars?, globalVars?, mode, prefix } → { data, result }
//                    (client đã quy mọi loại file — DevBox/Postman — về dạng này, lib/apiTransfer)
//     'renameFolder' { from, to }      → ApiData   (kéo theo thư mục con + biến dự án)

import { NextResponse, type NextRequest } from 'next/server';
import {
  getData, saveRequest, removeRequest, saveEnv, removeEnv, setActiveEnv, setActiveVarName, saveGlobals, saveProjectVars,
  setVarPick, quickSwitchVars,
  importBundle, renameFolder,
} from '@/lib/apiStore';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  try {
    let result: unknown;
    switch (action) {
      case 'get': result = await getData(); break;
      case 'saveRequest': result = await saveRequest(body as never); break;
      case 'removeRequest': result = await removeRequest(String(body.id ?? '')); break;
      case 'saveEnv': result = await saveEnv(body as never); break;
      case 'removeEnv': result = await removeEnv(String(body.id ?? '')); break;
      case 'setActiveEnv': result = await setActiveEnv((body.id as string) ?? null); break;
      case 'setActiveVarName': result = await setActiveVarName(body.name); break;
      case 'saveGlobals': result = await saveGlobals(body.vars, body.picks); break;
      case 'saveProjectVars': result = await saveProjectVars(String(body.project ?? ''), body.vars, body.picks); break;
      case 'setVarPick': result = await setVarPick(body.scope, body.key, body.label); break;
      case 'quickSwitchVars': result = await quickSwitchVars(body.label); break;
      case 'importBundle': result = await importBundle(body as unknown as Parameters<typeof importBundle>[0]); break;
      case 'renameFolder': result = await renameFolder(body.from, body.to); break;
      default: return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
