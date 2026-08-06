// The CORS-avoiding proxy. The browser posts here; the Next server forwards the
// request to the real backend (baseUrl) and returns the response verbatim.
//
// Why a proxy: the target backend may have CORS disabled by default, so a browser
// cannot call it directly. Routing through this same-origin Next server sidesteps
// CORS entirely — the server-to-server fetch is not subject to it.
//
// The request FROM the browser is itself either JSON or multipart:
//   - JSON control call:   { baseUrl, method, path, apiPrefix?, auth?, query?, jsonBody?, extraHeaders? }
//   - multipart passthrough (STT file upload): multipart/form-data with fields
//     _baseUrl, _method, _path, _apiPrefix?, _auth (JSON string), _query (JSON string), plus the file part(s).
//
// `apiPrefix` (optional, per-service) is reconciled against `path` (the openapi
// path): prepended unless the path already starts with it (see joinPath) — e.g.
// "/api". The gateway routing prefix (e.g. /ai-svc) lives in baseUrl, not here.
//
// `auth` = { mode, token?, toolKey?, toolSecret? }. mode is
// 'apikey' | 'tool' | 'jwt-user' | 'jwt-agent' | 'jwt-admin'. For 'tool' mode the
// proxy sends X-KEY / X-VALUE verbatim (both static secrets, see authHeaders). For
// jwt-* modes the raw token becomes "Authorization: Bearer <token>" (the proxy
// prepends "Bearer " only when the token doesn't already carry it).
// We detect JSON vs multipart by Content-Type and forward accordingly.

import { NextResponse } from 'next/server';
import { authHeaders, buildTargetUrl, type AuthSpec } from '@/lib/proxyCore';

export const runtime = 'nodejs';

/** Turn the backend response into our envelope (status + headers + body). */
async function relay(upstream: Response): Promise<NextResponse> {
  const contentType = upstream.headers.get('content-type') ?? '';
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Return JSON envelope so the UI can always render status + headers, and parse
  // the body when it is JSON. Binary/audio is referenced by URL in these APIs
  // (audioUrl / inputAudioUrl), so we never need to stream binary back here.
  let bodyText = '';
  try {
    bodyText = await upstream.text();
  } catch {
    bodyText = '';
  }

  let bodyJson: unknown = undefined;
  if (contentType.includes('application/json')) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      /* leave as text */
    }
  }

  return NextResponse.json({
    ok: upstream.ok,
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
    contentType,
    bodyJson,
    bodyText: bodyJson === undefined ? bodyText : undefined,
  });
}

export async function POST(req: Request) {
  const reqContentType = req.headers.get('content-type') ?? '';

  try {
    // ── Multipart passthrough (STT) ──────────────────────────────────────────
    if (reqContentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const baseUrl = String(form.get('_baseUrl') ?? '');
      const method = String(form.get('_method') ?? 'POST').toUpperCase();
      const path = String(form.get('_path') ?? '');
      const apiPrefix = form.get('_apiPrefix') ? String(form.get('_apiPrefix')) : undefined;
      const authRaw = form.get('_auth');
      const auth: AuthSpec | undefined = authRaw ? JSON.parse(String(authRaw)) : undefined;
      const queryRaw = form.get('_query');
      const query = queryRaw ? JSON.parse(String(queryRaw)) : undefined;

      if (!baseUrl || !path) {
        return NextResponse.json(
          { error: 'PROXY_BAD_REQUEST', detail: 'Missing _baseUrl or _path' },
          { status: 400 },
        );
      }

      // Rebuild a clean FormData without our control fields.
      const forward = new FormData();
      for (const [key, value] of form.entries()) {
        if (key.startsWith('_')) continue;
        forward.append(key, value as string | Blob);
      }

      const headers: Record<string, string> = { ...authHeaders(auth) };
      // Do NOT set Content-Type — fetch derives the multipart boundary itself.

      const upstream = await fetch(buildTargetUrl(baseUrl, path, query, apiPrefix), {
        method,
        headers,
        body: forward,
      });
      return relay(upstream);
    }

    // ── JSON control call ────────────────────────────────────────────────────
    const ctl = await req.json();
    const {
      baseUrl,
      method = 'GET',
      path,
      apiPrefix,
      auth,
      query,
      jsonBody,
      extraHeaders,
    } = ctl ?? {};

    if (!baseUrl || !path) {
      return NextResponse.json(
        { error: 'PROXY_BAD_REQUEST', detail: 'Missing baseUrl or path' },
        { status: 400 },
      );
    }

    const headers: Record<string, string> = {
      ...(extraHeaders ?? {}),
      ...authHeaders(auth as AuthSpec | undefined),
    };

    const hasBody = jsonBody !== undefined && jsonBody !== null && jsonBody !== '';
    if (hasBody) headers['Content-Type'] = 'application/json';

    const upstream = await fetch(buildTargetUrl(baseUrl, path, query, apiPrefix), {
      method: String(method).toUpperCase(),
      headers,
      body: hasBody
        ? typeof jsonBody === 'string'
          ? jsonBody
          : JSON.stringify(jsonBody)
        : undefined,
    });
    return relay(upstream);
  } catch (err) {
    // Network-level failure reaching the backend (wrong baseUrl, service down, …).
    return NextResponse.json(
      {
        ok: false,
        status: 0,
        statusText: 'PROXY_FETCH_FAILED',
        error: 'Could not reach the target backend.',
        detail: String(err),
      },
      { status: 502 },
    );
  }
}
