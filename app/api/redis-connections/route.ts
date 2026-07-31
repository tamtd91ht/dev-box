// /api/redis-connections — manage the local Redis connection list.
//
//   GET                                   → { enabled, connections[] }   (passwords stripped)
//   POST   { name, project, mode, host?, port?, nodes?, password? } → { connections[] }
//   PUT    { id, ...same fields }          → { connections[] }   (omit password to keep stored)
//   DELETE { id }                          → { connections[] }
//
// mode='single' uses host/port; mode='cluster' uses nodes[] (seed host:port list).
//
// Gated by REDIS_TOOL_ENABLED — on a k8s/production deployment the flag is unset,
// so this returns 403 and no connection file is touched. The list persists to a
// gitignored local JSON file (see lib/redisConnections). Passwords are NEVER
// returned to the browser — only `hasPassword: boolean`.

import { NextResponse, type NextRequest } from 'next/server';
import { REDIS_ENABLED } from '@/lib/redisClient';
import {
  listConnections,
  addConnection,
  updateConnection,
  removeConnection,
} from '@/lib/redisConnections';

export const runtime = 'nodejs';

function disabled() {
  return NextResponse.json(
    { error: 'Redis tool is disabled. Set REDIS_TOOL_ENABLED=true to enable it (local dev only).' },
    { status: 403 },
  );
}

export async function GET() {
  if (!REDIS_ENABLED) return NextResponse.json({ enabled: false, connections: [] });
  const connections = await listConnections();
  return NextResponse.json({ enabled: true, connections });
}

export async function POST(req: NextRequest) {
  if (!REDIS_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await addConnection(body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!REDIS_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await updateConnection(body?.id, body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!REDIS_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await removeConnection(body?.id);
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
