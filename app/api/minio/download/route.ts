// GET /api/minio/download?connectionId=&bucket=&object=[&inline=1]
//
// Stream một object về trình duyệt. `inline=1` cho xem trước (ảnh/văn bản/PDF) —
// khi đó chỉ cho các kiểu an toàn để nhúng; mọi thứ khác (html, svg, js…) vẫn ép
// tải xuống để một object độc hại không chạy script trong origin của DevBox.
// Đây là ĐỌC nên không cần cờ ghi, chỉ cần MINIO_TOOL_ENABLED.

import { Readable } from 'stream';
import { NextResponse, type NextRequest } from 'next/server';
import { MINIO_ENABLED, openObject } from '@/lib/minioClient';
import { getConnection } from '@/lib/minioConnections';

export const runtime = 'nodejs';

const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|bmp)|text\/plain|application\/(json|pdf)|audio\/|video\/)/i;

export async function GET(req: NextRequest) {
  if (!MINIO_ENABLED) return NextResponse.json({ error: 'MinIO tool is disabled' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const conn = await getConnection(sp.get('connectionId') ?? '');
  if (!conn) return NextResponse.json({ error: 'Unknown connection' }, { status: 404 });
  try {
    const { stream, stat } = await openObject(conn, sp.get('bucket'), sp.get('object'));
    const wantInline = sp.get('inline') === '1';
    const type = stat.contentType || 'application/octet-stream';
    const inline = wantInline && INLINE_OK.test(type);
    const base = stat.name.split('/').pop() || 'download';
    const headers = new Headers({
      'content-type': inline ? type : 'application/octet-stream',
      'content-length': String(stat.size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(base)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'",
      'cache-control': 'no-store',
    });
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'download failed' }, { status: 502 });
  }
}
