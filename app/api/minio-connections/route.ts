// /api/minio-connections — manage the local MinIO / S3 connection list.
//
//   GET                                   → { enabled, allowWrite, connections[] }
//   POST   { name, project, host, port, tls, accessKey, secretKey, region?, readOnly? } → { connections[] }
//   PUT    { id, ...same fields }          → { connections[] }  (omit secretKey to keep stored)
//   DELETE { id }                          → { connections[] }
//
// Gated by MINIO_TOOL_ENABLED — unset in any k8s/production deploy → 403. The list
// persists to a gitignored local JSON file (see lib/minioConnections). Secret keys
// are NEVER returned to the browser — only `hasSecret: boolean`.

import { NextResponse, type NextRequest } from 'next/server';
import { MINIO_ENABLED, MINIO_ALLOW_WRITE } from '@/lib/minioClient';
import {
  listConnections,
  addConnection,
  updateConnection,
  removeConnection,
} from '@/lib/minioConnections';

export const runtime = 'nodejs';

function disabled() {
  return NextResponse.json(
    { error: 'MinIO tool is disabled. Set MINIO_TOOL_ENABLED=true to enable it (local dev only).' },
    { status: 403 },
  );
}

export async function GET() {
  if (!MINIO_ENABLED) return NextResponse.json({ enabled: false, allowWrite: false, connections: [] });
  const connections = await listConnections();
  return NextResponse.json({ enabled: true, allowWrite: MINIO_ALLOW_WRITE, connections });
}

export async function POST(req: NextRequest) {
  if (!MINIO_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await addConnection(body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!MINIO_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await updateConnection(body?.id, body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!MINIO_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await removeConnection(body?.id);
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
