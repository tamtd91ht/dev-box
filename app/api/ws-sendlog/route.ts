// /api/ws-sendlog — a focused debug log for ONE thing: the Zalo send flow.
//
//   POST <trace>  → append it as a pretty JSON block to configs/ws-send-debug.log
//   GET           → return the file's text (so it can be read back / cleared)
//   DELETE        → truncate the file
//
// The send path spans the renderer (type/verify scripts) and the main process
// (the trusted Enter). Scattering console lines across the terminal made it
// unreadable; this puts the whole attempt — every step, the key result, the
// verify — in one file the user can hand back verbatim.

import { NextResponse, type NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import { configPath } from '@/lib/configDir';

export const runtime = 'nodejs';

const FILE = configPath('ws-send-debug.log', ['.ws-send-debug.log']);

export async function GET() {
  try {
    return new NextResponse(await fs.readFile(FILE, 'utf8'), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  } catch {
    return new NextResponse('(chưa có log)', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

export async function DELETE() {
  try {
    await fs.writeFile(FILE, '', 'utf8');
  } catch {
    /* nothing to clear */
  }
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const trace = await req.json().catch(() => null);
  if (!trace || typeof trace !== 'object') {
    return NextResponse.json({ error: 'expected a trace object' }, { status: 400 });
  }
  const at = new Date().toISOString();
  const block = `\n===== ${at} =====\n${JSON.stringify(trace, null, 2)}\n`;
  try {
    await fs.appendFile(FILE, block, 'utf8');
    return NextResponse.json({ ok: true, file: FILE });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
