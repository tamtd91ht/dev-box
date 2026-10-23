// /api/work-images — ảnh + file đính kèm của tab Công việc (lib/workImages).
//
//   GET  ?ref=<ref>                    → stream ảnh (inline, chỉ kiểu ảnh raster)
//   GET  ?ref=<ref>&name=<tên gốc>     → TẢI file (attachment, octet-stream) — mọi ref
//                                        không phải ảnh raster luôn đi đường này
//   POST multipart { file }            → { ok, result: { ref } }   lưu ảnh theo chế độ hiện tại
//   POST multipart { file, kind:'file' } → { ok, result: { ref } } lưu file bất kỳ (≤ 50 MB)
//   POST json { action:'config' }      → { ok, result: WorkImageConfigView }
//   POST json { action:'config-set', mode, connectionId?, bucket? } → như 'config'
//
// KHÔNG gate theo Mongo: nhiệm vụ trọng tâm chạy được khi chưa có Mongo nên ảnh
// cũng phải vậy. Chế độ MinIO tự kiểm MINIO_TOOL_ENABLED / quyền ghi bên trong.

import { Readable } from 'stream';
import { NextResponse, type NextRequest } from 'next/server';
import { getImageConfigView, setImageConfig, saveImage, saveFile, openImage } from '@/lib/workImages';
import { isImageRef } from '@/lib/workImageCore';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get('ref') ?? '';
  const name = req.nextUrl.searchParams.get('name');
  try {
    const img = await openImage(ref);
    // Chỉ ảnh raster mới inline; còn lại (và khi xin tải) luôn là attachment octet-stream.
    const download = name !== null || !isImageRef(ref);
    const fname = (name ?? '').replace(/[\r\n"\\/]/g, '').trim().slice(0, 150) || ref.slice(ref.lastIndexOf('/') + 1);
    return new Response(Readable.toWeb(img.stream) as ReadableStream, {
      headers: {
        'content-type': download ? 'application/octet-stream' : img.type,
        ...(download ? {
          'content-disposition': `attachment; filename="${fname.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        } : {}),
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
      if (!f || typeof f === 'string') throw new Error('Thiếu file.');
      const buf = Buffer.from(await f.arrayBuffer());
      const ref = form.get('kind') === 'file' ? await saveFile(buf, f.name) : await saveImage(buf, f.type);
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
