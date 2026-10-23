// /api/work-images — ảnh đính kèm của tab Công việc (lib/workImages).
//
//   GET  ?ref=<ref>                    → stream ảnh (inline, chỉ kiểu ảnh raster)
//   POST multipart { file }            → { ok, result: { ref } }   lưu theo chế độ hiện tại
//   POST json { action:'config' }      → { ok, result: WorkImageConfigView }
//   POST json { action:'config-set', mode, connectionId?, bucket? } → như 'config'
//
// KHÔNG gate theo Mongo: nhiệm vụ trọng tâm chạy được khi chưa có Mongo nên ảnh
// cũng phải vậy. Chế độ MinIO tự kiểm MINIO_TOOL_ENABLED / quyền ghi bên trong.

import { Readable } from 'stream';
import { NextResponse, type NextRequest } from 'next/server';
import { getImageConfigView, setImageConfig, saveImage, openImage } from '@/lib/workImages';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get('ref') ?? '';
  try {
    const img = await openImage(ref);
    return new Response(Readable.toWeb(img.stream) as ReadableStream, {
      headers: {
        'content-type': img.type,
        'content-length': String(img.size),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        // Ref là uuid, nội dung không bao giờ đổi — cache mạnh cho đỡ tải lại.
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (e) {
    const msg = (e as Error).message || 'read failed';
    return NextResponse.json({ error: msg }, { status: msg === 'not found' || /NotFound|NoSuchKey/i.test(msg) ? 404 : 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await req.formData();
      const f = form.get('file');
      if (!f || typeof f === 'string') throw new Error('Thiếu file ảnh.');
      const ref = await saveImage(Buffer.from(await f.arrayBuffer()), f.type);
      return NextResponse.json({ ok: true, result: { ref } });
    }
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    switch (body?.action) {
      case 'config':
        return NextResponse.json({ ok: true, result: await getImageConfigView() });
      case 'config-set':
        await setImageConfig(body);
        return NextResponse.json({ ok: true, result: await getImageConfigView() });
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${String(body?.action)}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message || 'work image operation failed' }, { status: 400 });
  }
}
