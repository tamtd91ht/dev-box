// /api/docs — store snippet JSON/text cho tab Tools (per-machine .docs.json).
//   POST { action, ... }:
//     'list'     {}                          → SavedDoc[]
//     'save'     { id?, name, kind, content } → SavedDoc[]  (id có = cập nhật)
//     'remove'   { id }                       → SavedDoc[]
//     'saveFile' { dir, filename, content }   → { path }  (ghi ra file thật)
//     'readFile' { path }                      → { path, content } (mở file thật từ máy)
//   GET ?media&path=  → stream file media (audio/video) với Range để <audio>/<video>
//                       phát + tua được ngay trong tab Tools.

import { NextResponse, type NextRequest } from 'next/server';
import { promises as fs, createReadStream } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import { listDocs, saveDoc, removeDoc, type DocKind } from '@/lib/docStore';

export const runtime = 'nodejs';

const MEDIA_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

/** Stream media local với hỗ trợ Range (đơn vùng) — thiếu Range là <video>
 *  không tua được trong Chromium. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (!sp.has('media')) return NextResponse.json({ ok: false, error: 'Unknown GET' }, { status: 400 });
  try {
    const p = path.resolve(String(sp.get('path') ?? '').trim());
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) return NextResponse.json({ ok: false, error: 'Không tìm thấy file.' }, { status: 404 });
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    const mime = MEDIA_MIME[ext] ?? 'application/octet-stream';

    const range = req.headers.get('range');
    const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) {
        return new NextResponse(null, { status: 416, headers: { 'content-range': `bytes */${st.size}` } });
      }
      const stream = Readable.toWeb(createReadStream(p, { start, end })) as ReadableStream;
      return new NextResponse(stream, {
        status: 206,
        headers: {
          'content-type': mime,
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'content-length': String(end - start + 1),
        },
      });
    }
    const stream = Readable.toWeb(createReadStream(p)) as ReadableStream;
    return new NextResponse(stream, {
      headers: { 'content-type': mime, 'accept-ranges': 'bytes', 'content-length': String(st.size) },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  try {
    let result: unknown;
    switch (action) {
      case 'list':
        result = await listDocs();
        break;
      case 'save':
        result = await saveDoc({
          id: typeof body.id === 'string' ? body.id : undefined,
          name: String(body.name ?? ''),
          kind: (body.kind === 'json' ? 'json' : 'text') as DocKind,
          content: String(body.content ?? ''),
        });
        break;
      case 'remove':
        result = await removeDoc(String(body.id ?? ''));
        break;
      case 'saveFile': {
        const dir = String(body.dir ?? '').trim();
        const filename = String(body.filename ?? '').trim();
        if (!dir || !filename) throw new Error('Thiếu thư mục hoặc tên file.');
        // Chặn path traversal trong tên file — chỉ nhận basename.
        if (filename !== path.basename(filename)) throw new Error('Tên file không hợp lệ.');
        const full = path.join(dir, filename);
        await fs.writeFile(full, String(body.content ?? ''), 'utf8');
        result = { path: full };
        break;
      }
      case 'readFile': {
        // Mở file text từ máy local vào editor Tools. Cap kích thước — editor
        // format/highlight không hợp file khổng lồ.
        const p = path.resolve(String(body.path ?? '').trim());
        if (!p) throw new Error('Thiếu đường dẫn file.');
        const st = await fs.stat(p).catch(() => null);
        if (!st?.isFile()) throw new Error('Không tìm thấy file.');
        const MAX = 10 * 1024 * 1024;
        if (st.size > MAX) throw new Error(`File ${(st.size / 1048576).toFixed(1)}MB — quá 10MB, editor không mở nổi.`);
        result = { path: p, content: await fs.readFile(p, 'utf8') };
        break;
      }
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
