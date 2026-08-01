// /api/word — single dispatch route for the Word editor (Office tab).
//
//   POST { action, ... }  where action is one of:
//     'flags'  {}                              → { ok, result: WordFlags }
//     'open'   { path }                        → { ok, result: WordOpenResult }
//     'create' { dir, name }                   → { ok, result: WordOpenResult }
//     'save'   { path, mtimeMs, ops: WordOp[] } → { ok, result: WordSaveResult }
//
// 'open' unzips the .docx and ships the body as an ordered list of blocks
// (paragraphs + read-only tables). 'create' makes a NEW blank .docx
// (create-only, never overwrites) and returns it opened. 'save' re-reads the
// file and replays the op log on word/document.xml with a stale mtime check,
// always backing up to `<file>.bak` before an atomic overwrite. Both writes
// are gated by OFFICE_ALLOW_WRITE. Gated by OFFICE_TOOL_ENABLED (403 when
// off). Audit-logged (WORD_AUDIT).

import { NextResponse, type NextRequest } from 'next/server';
import {
  WORD_ENABLED,
  WORD_ALLOW_WRITE,
  MAX_FILE_BYTES,
  MAX_BLOCKS,
  openDocx,
  createDocx,
  saveDocx,
} from '@/lib/wordClient';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!WORD_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Office tool is disabled. Set OFFICE_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  try {
    switch (action) {
      case 'flags':
        return NextResponse.json({
          ok: true,
          result: { allowWrite: WORD_ALLOW_WRITE, maxFileBytes: MAX_FILE_BYTES, maxBlocks: MAX_BLOCKS },
        });
      case 'open':
        return NextResponse.json({ ok: true, result: await openDocx(body.path) });
      case 'create': {
        try {
          const result = await createDocx({ dir: body.dir, name: body.name });
          return NextResponse.json({ ok: true, result });
        } catch (err) {
          const msg = (err as Error).message || 'create refused';
          const gate = msg.includes('ALLOW_WRITE');
          return NextResponse.json({ ok: false, error: msg }, { status: gate ? 403 : 400 });
        }
      }
      case 'save': {
        try {
          const result = await saveDocx({ path: body.path, mtimeMs: body.mtimeMs, ops: body.ops });
          return NextResponse.json({ ok: true, result });
        } catch (err) {
          const msg = (err as Error).message || 'save refused';
          const gate = msg.includes('ALLOW_WRITE');
          return NextResponse.json({ ok: false, error: msg }, { status: gate ? 403 : 400 });
        }
      }
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'Word operation failed', detail: String(err) },
      { status: 400 },
    );
  }
}
