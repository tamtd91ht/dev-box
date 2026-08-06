// /api/http — proxy gửi MỘT request HTTP tùy ý cho tab API (Postman-like).
// Browser POST vào đây, server fetch tới target thật rồi trả envelope
// (status + headers + body + thời gian) — né CORS hoàn toàn (server-to-server).
//
//   POST { method, url, headers?: {key,value}[], body?: string }
//   → { ok, result: { status, statusText, headers, body, timeMs, size } }
//
// KHÔNG dính auth/apiPrefix của backend cấu hình sẵn (khác /api/proxy) — đây là HTTP thô.

import { NextResponse, type NextRequest } from 'next/server';
import { Agent } from 'undici';

export const runtime = 'nodejs';

// Tool gọi API nội bộ (staging, IP thuần, cert tự ký) nên KHÔNG verify TLS —
// nếu verify, undici reject ngay ở tầng bắt tay và không bao giờ có status code
// để trả về. Agent này chỉ áp cho request đi ra từ tab API, không đụng phần khác.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

// fetch của undici luôn ném đúng một message "fetch failed"; nguyên nhân thật
// (ECONNREFUSED, ENOTFOUND, cert, scheme lạ) nằm ở chuỗi .cause — bóc hết ra.
function explain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    const code = (cur as NodeJS.ErrnoException).code;
    const msg = code && !cur.message.includes(code) ? `${cur.message} (${code})` : cur.message;
    if (msg && !parts.includes(msg)) parts.push(msg);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' ← ') || String(e);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    method?: string; url?: string; headers?: { key: string; value: string }[]; body?: string;
  } | null;
  if (!body?.url) return NextResponse.json({ ok: false, error: 'Thiếu URL.' }, { status: 400 });

  let url: URL;
  try { url = new URL(body.url); }
  catch { return NextResponse.json({ ok: false, error: `URL không hợp lệ: ${body.url}` }, { status: 400 }); }
  // KHÔNG chặn theo protocol — URL nào parse được là gửi. Scheme lạ (ftp:, ws:…)
  // sẽ do fetch tự ném lỗi, và lỗi đó trả về nguyên văn ở nhánh catch bên dưới.

  const method = (body.method || 'GET').toUpperCase();
  const headers = new Headers();
  for (const h of body.headers ?? []) if (h.key.trim()) headers.set(h.key.trim(), h.value);

  const init: RequestInit & { dispatcher?: unknown } = { method, headers, redirect: 'follow' };
  if (body.body && !['GET', 'HEAD'].includes(method)) init.body = body.body;
  if (url.protocol === 'https:') init.dispatcher = insecureAgent;

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
      { ok: false, error: `Không gọi được: ${explain(e)}`, result: { timeMs: Date.now() - t0 } },
      { status: 502 },
    );
  }
}
