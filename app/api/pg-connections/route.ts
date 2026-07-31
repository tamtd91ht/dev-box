// /api/pg-connections — manage the local PostgreSQL connection list.
//
//   GET                                   → { enabled, allowWrite, connections[] }
//   POST   { name, project, host, port, database, username, password?, tls?, readOnly? } → { connections[] }
//   PUT    { id, ...same fields }          → { connections[] }  (omit password to keep stored)
//   DELETE { id }                          → { connections[] }
//
// Gated by PG_TOOL_ENABLED — unset in any k8s/production deploy → 403. The list
// persists to a gitignored local JSON file (see lib/pgConnections). Passwords
// are NEVER returned to the browser — only `hasPassword: boolean`.

import { NextResponse, type NextRequest } from 'next/server';
import { PG_ENABLED, PG_ALLOW_WRITE } from '@/lib/pgClient';
import {
  listConnections,
  addConnection,
  updateConnection,
  removeConnection,
} from '@/lib/pgConnections';

export const runtime = 'nodejs';

function disabled() {
  return NextResponse.json(
    { error: 'PostgreSQL tool is disabled. Set PG_TOOL_ENABLED=true to enable it (local dev only).' },
    { status: 403 },
  );
}

export async function GET() {
  if (!PG_ENABLED) return NextResponse.json({ enabled: false, allowWrite: false, connections: [] });
  const connections = await listConnections();
  return NextResponse.json({ enabled: true, allowWrite: PG_ALLOW_WRITE, connections });
}

export async function POST(req: NextRequest) {
  if (!PG_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await addConnection(body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!PG_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await updateConnection(body?.id, body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!PG_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await removeConnection(body?.id);
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
