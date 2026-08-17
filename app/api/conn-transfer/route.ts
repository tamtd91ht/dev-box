// /api/conn-transfer — xuất/nhập danh sách connection của một menu.
//
//   GET  ?kind=kafka&ids=a,b        → file JSON export (tải về, Content-Disposition)
//   POST { kind, action:'preview', file }              → { preview }
//   POST { kind, action:'import', file, ids?, mode }   → { added, overwritten, skipped, total }
//
// `kind` ∈ kafka|redis|mongo|rabbit|es|pg. Mỗi loại vẫn nằm sau ĐÚNG cờ
// *_TOOL_ENABLED của tab đó — tab tắt thì không xuất/nhập được, y như mọi
// endpoint khác của tab.
//
// CẢNH BÁO: bản export chứa mật khẩu plaintext (xem lib/connTransfer.ts) — đây
// là chủ ý để file dùng lại được trên máy khác, UI nói rõ điều này ở hộp thoại
// xác nhận trước khi tải.

import { NextResponse, type NextRequest } from 'next/server';
import {
  buildExport,
  previewImport,
  applyImport,
  isRegistryKind,
  isKindEnabled,
  registryLabel,
  type ConflictMode,
  type RegistryKind,
} from '@/lib/connTransfer';

export const runtime = 'nodejs';

/** Kiểm tra kind + cờ bật tab. Trả về kind đã hẹp kiểu, hoặc một response lỗi. */
function resolveKind(raw: unknown): { kind: RegistryKind } | { error: NextResponse } {
  if (!isRegistryKind(raw)) {
    return { error: NextResponse.json({ error: 'kind không hợp lệ' }, { status: 400 }) };
  }
  if (!isKindEnabled(raw)) {
    return {
      error: NextResponse.json(
        { error: `Tab ${registryLabel(raw)} đang tắt trên bản deploy này.` },
        { status: 403 },
      ),
    };
  }
  return { kind: raw };
}

/** Tên file tải về: `kafka-clusters-20260817-1530.json`. */
function exportFilename(kind: RegistryKind): string {
  const n = new Date();
  const two = (x: number) => String(x).padStart(2, '0');
  const stamp = `${n.getFullYear()}${two(n.getMonth() + 1)}${two(n.getDate())}-${two(n.getHours())}${two(n.getMinutes())}`;
  return `${kind}-connections-${stamp}.json`;
}

export async function GET(req: NextRequest) {
  const r = resolveKind(req.nextUrl.searchParams.get('kind'));
  if ('error' in r) return r.error;

  const idsParam = req.nextUrl.searchParams.get('ids') ?? '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);

  try {
    const file = await buildExport(r.kind, ids);
    // Trả về như một file tải xuống: browser (và Electron) hiện hộp thoại "Save
    // as…" nên người dùng chọn được thư mục lưu, đúng như tải một file thường.
    return new NextResponse(JSON.stringify(file, null, 2) + '\n', {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(r.kind)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    kind?: unknown; action?: unknown; file?: unknown; ids?: unknown; mode?: unknown;
  } | null;

  const r = resolveKind(body?.kind);
  if ('error' in r) return r.error;

  const ids = Array.isArray(body?.ids)
    ? (body!.ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;

  try {
    if (body?.action === 'preview') {
      return NextResponse.json({ preview: await previewImport(body.file, r.kind) });
    }
    if (body?.action === 'import') {
      const mode: ConflictMode =
        body.mode === 'overwrite' || body.mode === 'skip' || body.mode === 'duplicate'
          ? body.mode
          : 'skip';
      return NextResponse.json(await applyImport(body.file, r.kind, ids, mode));
    }
    return NextResponse.json({ error: 'action không hợp lệ (preview | import)' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
