// /api/curl — build the equivalent `curl` command for a request, so it can be run
// straight against the real backend (baseUrl) outside this tool.
//
// It reuses the proxy's header/URL logic (lib/proxyCore) so the exported command
// matches exactly what /api/proxy would send — including the 'tool' mode
// X-KEY / X-VALUE static secrets.
//
// Body: { baseUrl, method, path, apiPrefix?, auth?, query?, jsonBody?, multipart?, fileName?, languageCode? }
// Reply: { curl: string, note?: string }

import { NextResponse, type NextRequest } from 'next/server';
import { authHeaders, buildTargetUrl, type AuthSpec } from '@/lib/proxyCore';

export const runtime = 'nodejs';

/** Single-quote a value for POSIX sh: wrap in '…', escaping embedded quotes. */
function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.baseUrl !== 'string' || typeof body.path !== 'string') {
    return NextResponse.json({ error: 'expected { baseUrl, path, ... }' }, { status: 400 });
  }

  const {
    baseUrl,
    method = 'GET',
    path,
    apiPrefix,
    auth,
    query,
    jsonBody,
    multipart,
    fileName,
    languageCode,
  } = body;

  const url = buildTargetUrl(
    baseUrl,
    path,
    query as Record<string, string> | undefined,
    apiPrefix as string | undefined,
  );
  const headers = authHeaders(auth as AuthSpec | undefined);

  const lines: string[] = [`curl -X ${String(method).toUpperCase()} ${sq(url)}`];
  for (const [k, v] of Object.entries(headers)) lines.push(`-H ${sq(`${k}: ${v}`)}`);

  let note: string | undefined;
  if (multipart) {
    // The file bytes live only in the browser — emit an @-path placeholder.
    lines.push(`-F ${sq(`file=@${fileName || 'audio.wav'}`)}`);
    if (languageCode) lines.push(`-F ${sq(`languageCode=${languageCode}`)}`);
    note = `Replace @${fileName || 'audio.wav'} with the real file path before running.`;
  } else {
    const hasBody = jsonBody !== undefined && jsonBody !== null && jsonBody !== '';
    if (hasBody) {
      lines.push(`-H ${sq('Content-Type: application/json')}`);
      const data = typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody);
      lines.push(`-d ${sq(data)}`);
    }
  }

  // Join with " \\\n  " so the command is copy-paste friendly and readable.
  const curl = lines.join(' \\\n  ');
  return NextResponse.json({ curl, note });
}
