// /api/automation
//   GET → the persisted automation config (normalized, safe defaults if absent)
//   PUT → normalize + persist the posted config, returning what was written
//
// The whole config is written at once: it is a small document edited by one
// person on one machine, so a read-modify-write patch protocol would buy
// nothing but complexity.

import { NextResponse, type NextRequest } from 'next/server';
import { readAutomationConfig, writeAutomationConfig } from '@/lib/automation/store';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(await readAutomationConfig());
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'expected an AutomationConfig object' }, { status: 400 });
  }
  try {
    return NextResponse.json(await writeAutomationConfig(body));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
