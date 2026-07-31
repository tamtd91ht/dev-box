// /api/local-config
//   GET → { services, global } — persisted per-service config + shared globals.
//   PUT → merge { service, patch } into the store and persist it (overwrite).
//         Use service = "__global__" to write the shared global variables.
//
// This is the on-disk counterpart to /api/config (which only exposes env
// DEFAULTS). User-set values live here so a restart re-maps them automatically.

import { NextResponse, type NextRequest } from 'next/server';
import { readStore, writeEntry, type RawStore } from '@/lib/localStore';
import { GLOBAL_KEY } from '@/lib/persist';

export const runtime = 'nodejs';

/** Split the raw store into { services, global }. */
function shape(store: RawStore) {
  const { [GLOBAL_KEY]: global = {}, ...services } = store;
  return { services, global };
}

export async function GET() {
  return NextResponse.json(shape(await readStore()));
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.service !== 'string' ||
    !body.service ||
    typeof body.patch !== 'object' ||
    body.patch === null
  ) {
    return NextResponse.json({ error: 'expected { service: string, patch: object }' }, { status: 400 });
  }
  const store = await writeEntry(body.service, body.patch);
  return NextResponse.json(shape(store));
}
