// /api/http — proxy gửi MỘT request HTTP tùy ý cho tab API (Postman-like).
// Browser POST vào đây, server fetch tới target thật rồi trả envelope
// (status + headers + body + thời gian) — né CORS hoàn toàn (server-to-server).
//
//   POST { method, url, headers?: {key,value}[], body?: string,
//          bodyType?: 'none'|'raw'|'form'|'multipart', form?: ApiFormField[] }
//   → { ok, result: { status, statusText, headers, body, timeMs, size } }
//
// bodyType='form'      → dựng application/x-www-form-urlencoded từ `form`.
// bodyType='multipart' → dựng multipart/form-data, dòng kind='file' mang nội
//                        dung base64 (fileB64) được giải mã lại thành Blob.
// Bỏ trống bodyType → gửi `body` nguyên văn, y như trước.
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

interface FormField {
  key: string; value: string; on?: boolean;
  kind?: 'text' | 'file'; fileName?: string; fileB64?: string; fileType?: string;
}

/** Trần tổng dung lượng file — base64 nằm trọn trong RAM, quá tay là treo
 *  process chứ không phải chỉ chậm. Khớp FILE_LIMIT ở lib/api.ts. */
const FILE_LIMIT = 20 * 1024 * 1024;

/** Dòng dùng được: có tên field và chưa bị tắt. */
const usable = (f: FormField) => f.key.trim() !== '' && f.on !== false;

/**
 * Dựng body theo `bodyType`.
 *
 * TRẢ VỀ `undefined` CHO CONTENT-TYPE ở hai dạng form: để fetch/undici TỰ đặt.
 * Với multipart điều này là bắt buộc — header phải kèm `boundary=...` mà chỉ
 * runtime mới biết; tự tay đặt 'multipart/form-data' trơn là server bên kia
 * không tách nổi part nào và trả 400. Với urlencoded thì FormData/URLSearchParams
 * cũng tự khai đúng, khỏi phải nhớ.
 */
function buildBody(
  bodyType: string | undefined,
  raw: string | undefined,
  form: FormField[] | undefined,
): { body: BodyInit | undefined; dropContentType: boolean } {
  if (bodyType === 'form') {
    const p = new URLSearchParams();
    for (const f of form ?? []) if (usable(f)) p.append(f.key.trim(), f.value ?? '');
    return { body: p, dropContentType: true };
  }
  if (bodyType === 'multipart') {
    const fd = new FormData();
    let total = 0;
    for (const f of form ?? []) {
      if (!usable(f)) continue;
      if (f.kind === 'file') {
        // Dòng file chưa chọn lại file (request vừa nạp từ collections — ruột
        // file cố ý không được lưu) thì BỎ QUA, không gửi một part rỗng mang
        // tên file cũ: server bên kia sẽ nhận một file 0 byte và tưởng là thật.
        if (!f.fileB64) continue;
        const buf = Buffer.from(f.fileB64, 'base64');
        total += buf.length;
        if (total > FILE_LIMIT) throw new Error(`Tổng file vượt ${Math.round(FILE_LIMIT / 1024 / 1024)}MB.`);
        fd.append(
          f.key.trim(),
          new Blob([new Uint8Array(buf)], { type: f.fileType || 'application/octet-stream' }),
          f.fileName || 'file',
        );
      } else {
        fd.append(f.key.trim(), f.value ?? '');
      }
    }
    return { body: fd, dropContentType: true };
  }
  return { body: raw || undefined, dropContentType: false };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    method?: string; url?: string; headers?: { key: string; value: string }[]; body?: string;
    bodyType?: string; form?: FormField[];
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

  let built: { body: BodyInit | undefined; dropContentType: boolean };
  try {
    built = buildBody(body.bodyType, body.body, body.form);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
  // Content-Type do người dùng gõ tay ở tab Headers phải NHƯỜNG cho bản runtime
  // tự sinh: giữ lại cái cũ (vd 'application/json' còn sót từ lần gõ raw) thì
  // multipart mất boundary và request hỏng mà không rõ vì sao.
  if (built.dropContentType) headers.delete('content-type');

  const init: RequestInit & { dispatcher?: unknown } = { method, headers, redirect: 'follow' };
  if (built.body !== undefined && !['GET', 'HEAD'].includes(method)) init.body = built.body;
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
