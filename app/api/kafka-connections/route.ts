// /api/kafka-connections — manage the local Kafka connection list.
//
//   GET                                   → { enabled, connections[] }
//   POST   { name, project, brokers }      → { connections[] }
//   PUT    { id, name, project, brokers }  → { connections[] }
//   DELETE { id }                          → { connections[] }
//
// `brokers` is a list of "host:port" (array or comma/newline-separated string).
//
// Gated by KAFKA_TOOL_ENABLED — on a k8s/production deployment the flag is unset,
// so this returns 403 and no connection file is touched. The list persists to a
// gitignored local JSON file (see lib/kafkaConnections).

import { NextResponse, type NextRequest } from 'next/server';
import { KAFKA_ENABLED } from '@/lib/kafkaClient';
import {
  listConnections,
  addConnection,
  updateConnection,
  removeConnection,
} from '@/lib/kafkaConnections';

export const runtime = 'nodejs';

function disabled() {
  return NextResponse.json(
    { error: 'Kafka tool is disabled. Set KAFKA_TOOL_ENABLED=true to enable it (local dev only).' },
    { status: 403 },
  );
}

export async function GET() {
  if (!KAFKA_ENABLED) return NextResponse.json({ enabled: false, connections: [] });
  const connections = await listConnections();
  return NextResponse.json({ enabled: true, connections });
}

export async function POST(req: NextRequest) {
  if (!KAFKA_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await addConnection(body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!KAFKA_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await updateConnection(body?.id, body ?? {});
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!KAFKA_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const connections = await removeConnection(body?.id);
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
