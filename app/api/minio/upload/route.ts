// POST /api/minio/upload  (multipart/form-data)
//   fields: connectionId, bucket, prefix? ("thư mục" đích, kết thúc bằng "/"), file (1 hoặc nhiều)
//   → { ok, result: { uploaded: [{ name, size }] } }
//
// GHI: cần MINIO_ALLOW_WRITE + connection readOnly=false (assertWritable trong
// lib/minioClient). File được đệm vào RAM nên bị chặn ở MINIO_UPLOAD_MAX_MB.

import { NextResponse, type NextRequest } from 'next/server';
import { MINIO_ENABLED, assertWritable, putObject, UPLOAD_LIMIT_BYTES } from '@/lib/minioClient';
import { getConnection } from '@/lib/minioConnections';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!MINIO_ENABLED) return NextResponse.json({ ok: false, error: 'MinIO tool is disabled' }, { status: 403 });
  try {
    const form = await req.formData();
    const conn = await getConnection(String(form.get('connectionId') ?? ''));
    if (!conn) return NextResponse.json({ ok: false, error: 'Unknown connection' }, { status: 404 });
    assertWritable(conn);
    const bucket = String(form.get('bucket') ?? '');
    const prefix = String(form.get('prefix') ?? '');
    if (prefix && !prefix.endsWith('/')) throw new Error('prefix phải kết thúc bằng "/"');
    const files = form.getAll('file').filter((f): f is File => typeof f !== 'string');
    if (!files.length) throw new Error('chưa chọn file nào');
    const uploaded: { name: string; size: number }[] = [];
    for (const f of files) {
      if (f.size > UPLOAD_LIMIT_BYTES) throw new Error(`"${f.name}" lớn hơn giới hạn upload`);
      const name = `${prefix}${f.name.replace(/[\\/]+/g, '_')}`;
      await putObject(conn, bucket, name, Buffer.from(await f.arrayBuffer()), f.type || undefined);
      uploaded.push({ name, size: f.size });
    }
    return NextResponse.json({ ok: true, result: { uploaded } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message || 'upload failed' }, { status: 502 });
  }
}
