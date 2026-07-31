// /api/agent-token — mint a tenant agent's JWT via tool-service's /tools/agent-token,
// so the operator can populate the JWT_TOKEN_AGENT / JWT_TOKEN_ADMIN global variables
// by just entering a tenantId or domain (no manual token copy-paste).
//
// The upstream endpoint is tool-service (ToolAuth: X-KEY + X-VALUE). Those secrets +
// the tool-service base URL are read from the persisted store server-side — they never
// round-trip through the browser here. When no email/phone is sent the endpoint resolves
// the tenant's business-owner agent.
//
// Body:  { tenant: "<tenantId UUID or domain FQDN>" }
// Reply: { token, resolvedBy?, agentId?, tenantId?, expiresIn? } | { error, status? }

import { NextResponse, type NextRequest } from 'next/server';
import { authHeaders, buildTargetUrl } from '@/lib/proxyCore';
import { readStore } from '@/lib/localStore';

export const runtime = 'nodejs';

const TOOL_SERVICE = 'tool-service';
const AGENT_TOKEN_PATH = '/tools/agent-token';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const tenant = typeof body?.tenant === 'string' ? body.tenant.trim() : '';
  if (!tenant) {
    return NextResponse.json({ error: 'Nhập tenantId hoặc domain.' }, { status: 400 });
  }

  // tool-service connection comes from the persisted store (base URL + X-KEY/X-VALUE).
  const store = await readStore();
  const toolCfg = store[TOOL_SERVICE] ?? {};
  const toolKey = toolCfg.toolKey;
  const toolSecret = toolCfg.toolSecret;
  if (!toolKey || !toolSecret) {
    return NextResponse.json(
      {
        error:
          'Chưa cấu hình tool-service credentials (X-KEY / X-VALUE). Mở Settings → chọn service tool-service để nhập.',
      },
      { status: 400 },
    );
  }

  const baseUrl = (toolCfg.baseUrl || '').trim();
  if (!baseUrl) {
    return NextResponse.json(
      { error: 'Chưa có base URL cho tool-service. Mở Settings → tool-service để nhập.' },
      { status: 400 },
    );
  }

  // Respect tool-service's configured API prefix (e.g. /api), same as the proxy.
  const url = buildTargetUrl(baseUrl, AGENT_TOKEN_PATH, null, toolCfg.apiPrefix);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders({ mode: 'tool', toolKey, toolSecret }),
  };

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tenant }),
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Không gọi được tool-service (${baseUrl}): ${String(e)}` },
      { status: 502 },
    );
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    // Surface the upstream error message (nested {error:{message}} or flat {message}).
    const msg =
      data?.error?.message || data?.message || `tool-service trả về HTTP ${upstream.status}`;
    return NextResponse.json({ error: msg, status: upstream.status }, { status: 200 });
  }

  const token = data?.accessToken;
  if (!token || typeof token !== 'string') {
    return NextResponse.json(
      { error: 'tool-service không trả về accessToken.' },
      { status: 200 },
    );
  }

  return NextResponse.json({
    token,
    resolvedBy: data.resolvedBy,
    agentId: data.agentId,
    tenantId: data.tenantId,
    expiresIn: data.expiresIn,
  });
}
