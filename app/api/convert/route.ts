// /api/convert — chuyển đổi file (tab Tools). Job chạy ngầm, client poll.
//
//   GET                          → { jobs }  (snapshot cho ConvertHost + UI)
//   POST { action, ... }:
//     'start'   { srcPath, target, outDir?, useAi?, templatePath? } → { job }
//     'matrix'  {}                        → { matrix }  cặp thư viện làm được
//     'render-html' { id }                → { html }    HTML để Electron in PDF
//     'render-done' { id, base64 }        → { job }     ghi PDF, chốt job
//     'render-fail' { id, reason }        → { ok }      renderer không in được
//     'clear'   {}                        → { jobs }    dọn job đã kết thúc
//
// Không có cờ *_TOOL_ENABLED riêng: tính năng chỉ đọc/ghi file local giống nút
// "Mở file từ máy" sẵn có của tab Tools (/api/docs), cùng mức quyền.

import { NextResponse, type NextRequest } from 'next/server';
import { LIB_MATRIX } from '@/lib/convertCore';
import {
  startJob, listJobs, takeRenderHtml, finishRender, failRender, clearFinished,
} from '@/lib/convertJobs';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ ok: true, result: { jobs: listJobs() } });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  try {
    let result: unknown;
    switch (action) {
      case 'matrix':
        result = { matrix: LIB_MATRIX };
        break;
      case 'start': {
        const job = await startJob({
          srcPath: body.srcPath,
          target: body.target,
          outDir: body.outDir,
          useAi: body.useAi,
          templatePath: body.templatePath,
        });
        result = { job: { ...job, pendingHtml: undefined } };
        break;
      }
      case 'render-html':
        result = { html: takeRenderHtml(String(body.id ?? '')) };
        break;
      case 'render-done': {
        const job = await finishRender(body.id, body.base64);
        result = { job: { ...job, pendingHtml: undefined } };
        break;
      }
      case 'render-fail':
        failRender(body.id, body.reason);
        result = { ok: true };
        break;
      case 'clear':
        clearFinished();
        result = { jobs: listJobs() };
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message || 'convert failed' }, { status: 400 });
  }
}
