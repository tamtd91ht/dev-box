// /api/http — proxy gửi MỘT request HTTP tùy ý cho tab API (Postman-like).
// Browser POST vào đây, server fetch tới target thật rồi trả envelope
// (status + headers + body + thời gian) — né CORS hoàn toàn (server-to-server).
//
//   POST { method, url, headers?: {key,value}[], body?: string }
//   → { ok, result: { status, statusText, headers, body, timeMs, size } }
//
// KHÔNG dính auth/apiPrefix của omicx (khác /api/proxy) — đây là HTTP thô.

import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    method?: string; url?: string; headers?: { key: string; value: string }[]; body?: string;
  } | null;
  if (!body?.url) return NextResponse.json({ ok: false, error: 'Thiếu URL.' }, { status: 400 });

  let url: URL;
  try { url = new URL(body.url); }
  catch { return NextResponse.json({ ok: false, error: `URL không hợp lệ: ${body.url}` }, { status: 400 }); }
  if (!/^https?:$/.test(url.protocol)) {
    return NextResponse.json({ ok: false, error: 'Chỉ hỗ trợ http/https.' }, { status: 400 });
  }

  const method = (body.method || 'GET').toUpperCase();
  const headers = new Headers();
  for (const h of body.headers ?? []) if (h.key.trim()) headers.set(h.key.trim(), h.value);

  const init: RequestInit = { method, headers, redirect: 'follow' };
  if (body.body && !['GET', 'HEAD'].includes(method)) init.body = body.body;

  const t0 = Date.now();
  try {
    const r = await fetch(url, init);
    const buf = Buffer.from(await r.arrayBuffer());
    const timeMs = Date.now() - t0;
    const resHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => { resHeaders[k] = v; });
    const ct = r.headers.get('content-type') ?? '';
    // Trả text cho JSON/text; binary chỉ báo kích thước (tool này để gọi API).
    const isText = /json|text|xml|javascript|html|urlencoded|x-ndjson/i.test(ct) || !ct;
    return NextResponse.json({
      ok: true,
      result: {
        status: r.status,
        statusText: r.statusText,
        headers: resHeaders,
        body: isText ? buf.toString('utf8') : `[binary ${buf.length} bytes · ${ct}]`,
        timeMs,
        size: buf.length,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Không gọi được: ${(e as Error).message}`, result: { timeMs: Date.now() - t0 } },
      { status: 502 },
    );
  }
}
