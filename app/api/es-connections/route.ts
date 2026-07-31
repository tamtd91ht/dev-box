// /api/es-connections — manage the local Elasticsearch connection list.
//
//   GET                                  → { enabled, connections[] }
//   POST   { name, project, host, port, tls? } → { connections[] }
//   PUT    { id, ...same fields }         → { connections[] }
//   DELETE { id }                         → { connections[] }
//
// Clusters are VPN-reachable with no authentication, so records hold no secret.
// Gated by ES_TOOL_ENABLED — unset in any k8s/production deploy → 403. The list
// persists to a gitignored local JSON file (see lib/esConnections).

import { NextResponse, type NextRequest } from 'next/server';
import { ES_ENABLED } from '@/lib/esClient';
import {
  listConnections,
  addConnection,
  updateConnection,
  removeConnection,
} from '@/lib/esConnections';

export const runtime = 'nodejs';

function disabled() {
  return NextResponse.json(
    { error: 'Elasticsearch tool is disabled. Set ES_TOOL_ENABLED=true to enable it (local dev only).' },
    { status: 403 },
  );
}

export async function GET() {
  if (!ES_ENABLED) return NextResponse.json({ enabled: false, connections: [] });
  const connections = await listConnections();
  return NextResponse.json({ enabled: true, connections });
}

export async function POST(req: NextRequest) {
  if (!ES_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await addConnection(body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!ES_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await updateConnection(body?.id, body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!ES_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await removeConnection(body?.id);
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
