// /api/ws-targets — the send-target address book (configs/wstargets.json).
//
//   GET                       → { groups[] }
//   POST { accountKey, accountLabel, label, targets[] }
//                             → upsert one (account × label) entry
//   DELETE { id }             → drop one entry
//
// Kept OUT of the chat app on purpose: Zalo is where you tag conversations,
// DevBox is where you can see, audit and edit who a rule will actually message.

import { NextResponse, type NextRequest } from 'next/server';
import { readTargets, removeGroup, upsertGroup } from '@/lib/workspace/targets';

export const runtime = 'nodejs';

export async function GET() {
  const store = await readTargets();
  return NextResponse.json({ groups: store.groups });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  try {
    const store = await upsertGroup(body);
    return NextResponse.json({ groups: store.groups });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: 'cần id' }, { status: 400 });
  const store = await removeGroup(body.id);
  return NextResponse.json({ groups: store.groups });
}
