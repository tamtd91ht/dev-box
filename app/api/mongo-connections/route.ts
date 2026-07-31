// /api/mongo-connections — manage the local MongoDB connection list.
//
//   GET                                        → { enabled, allowWrite, connections[] }
//   POST   { name, project, scheme, hosts, replicaSet?, authSource?, username?,
//            password?, tls?, directConnection?, readOnly? } → { connections[] }
//   PUT    { id, ...same fields }               → { connections[] }  (omit password to keep stored)
//   DELETE { id }                               → { connections[] }
//
// Gated by MONGO_TOOL_ENABLED — on a k8s/production deployment the flag is unset,
// so this returns 403 and no connection file is touched. The list persists to a
// gitignored local JSON file (see lib/mongoConnections). Passwords are NEVER
// returned to the browser — only `hasPassword: boolean`. `allowWrite` reports the
// MONGO_ALLOW_WRITE env flag so the UI can grey out write controls up front.

import { NextResponse, type NextRequest } from 'next/server';
import { MONGO_ENABLED, MONGO_ALLOW_WRITE } from '@/lib/mongoClient';
import {
  listConnections,
  addConnection,
  updateConnection,
  removeConnection,
} from '@/lib/mongoConnections';

export const runtime = 'nodejs';

function disabled() {
  return NextResponse.json(
    { error: 'MongoDB tool is disabled. Set MONGO_TOOL_ENABLED=true to enable it (local dev only).' },
    { status: 403 },
  );
}

export async function GET() {
  if (!MONGO_ENABLED) return NextResponse.json({ enabled: false, allowWrite: false, connections: [] });
  const connections = await listConnections();
  return NextResponse.json({ enabled: true, allowWrite: MONGO_ALLOW_WRITE, connections });
}

export async function POST(req: NextRequest) {
  if (!MONGO_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await addConnection(body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!MONGO_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await updateConnection(body?.id, body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!MONGO_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await removeConnection(body?.id);
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
