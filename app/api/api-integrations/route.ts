// /api/api-integrations — manage registered API integration packs + read their
// manifests in one round-trip.
//
//   GET               → { integrations: [{ id, name, root, manifest? | manifestError? }] }
//   POST   { name, root }        → { integrations }   (root must contain devbox.api.json)
//   PUT    { id, name?, root? }  → { integrations }
//   DELETE { id }                → { integrations }
//
// The registry is a per-machine gitignored JSON (see lib/apiIntegrations). No
// env gate: the explorer only reads manifests/specs the operator registered
// themselves — same trust model as the Git workspace's project list.

import { NextResponse, type NextRequest } from 'next/server';
import {
  listIntegrations,
  addIntegration,
  updateIntegration,
  removeIntegration,
  loadManifest,
  type ApiIntegration,
  type ApiManifest,
} from '@/lib/apiIntegrations';

export const runtime = 'nodejs';

interface IntegrationView extends ApiIntegration {
  manifest?: ApiManifest;
  manifestError?: string;
}

async function withManifests(list: ApiIntegration[]): Promise<IntegrationView[]> {
  return Promise.all(list.map(async (i) => {
    try {
      return { ...i, manifest: await loadManifest(i) };
    } catch (e) {
      return { ...i, manifestError: (e as Error).message };
    }
  }));
}

export async function GET() {
  const integrations = await withManifests(await listIntegrations());
  return NextResponse.json({ integrations });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  try {
    const integrations = await withManifests(await addIntegration(body ?? {}));
    return NextResponse.json({ integrations });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  try {
    const integrations = await withManifests(await updateIntegration(body?.id, body ?? {}));
    return NextResponse.json({ integrations });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => null);
  try {
    const integrations = await withManifests(await removeIntegration(body?.id));
    return NextResponse.json({ integrations });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
