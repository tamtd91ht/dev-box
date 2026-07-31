// /api/rabbit-connections — manage the local RabbitMQ connection list.
//
//   GET                                                    → { enabled, connections[] }
//   POST   { name, project, host, port, username, password, tls?, vhost? } → { connections[] }
//   PUT    { id, ... }                                      → { connections[] }
//   DELETE { id }                                           → { connections[] }
//
// Gated by RABBIT_TOOL_ENABLED — on a k8s/production deployment the flag is
// unset, so this returns 403 and no connection file is touched. The list persists
// to a gitignored local JSON file (see lib/rabbitConnections). The management
// password is stored server-side only and never returned (toPublic strips it).

import { NextResponse, type NextRequest } from 'next/server';
import { RABBIT_ENABLED } from '@/lib/rabbitClient';
import {
  listConnections,
  addConnection,
  updateConnection,
  removeConnection,
} from '@/lib/rabbitConnections';

export const runtime = 'nodejs';

function disabled() {
  return NextResponse.json(
    { error: 'RabbitMQ tool is disabled. Set RABBIT_TOOL_ENABLED=true to enable it (local dev only).' },
    { status: 403 },
  );
}

export async function GET() {
  if (!RABBIT_ENABLED) return NextResponse.json({ enabled: false, connections: [] });
  const connections = await listConnections();
  return NextResponse.json({ enabled: true, connections });
}

export async function POST(req: NextRequest) {
  if (!RABBIT_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await addConnection(body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!RABBIT_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await updateConnection(body?.id, body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!RABBIT_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await removeConnection(body?.id);
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
