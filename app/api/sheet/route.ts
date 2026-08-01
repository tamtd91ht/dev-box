// /api/sheet — single dispatch route for the Sheet workspace (Excel/CSV).
//
//   POST { action, ... }  where action is one of:
//     'flags'  {}                                → { ok, result: SheetFlags }
//     'open'   { path }                          → { ok, result: SheetOpenResult }
//     'create' { dir, name }                     → { ok, result: SheetOpenResult }
//     'save'   { path, mtimeMs, sheets: [{ name, ops[] }] } → { ok, result: SheetSaveResult }
//
// 'open' parses the file server-side (ExcelJS / papaparse) and ships a capped
// JSON view. 'create' makes a NEW empty .xlsx/.csv (create-only, never
// overwrites) and returns it opened. 'save' re-reads the file and replays the
// op log (set cell / insert row / delete row) with a stale mtime check, always
// backing up to `<file>.bak` before an atomic overwrite. Both writes are gated
// by SHEET_ALLOW_WRITE. Gated by SHEET_TOOL_ENABLED (403 when off).
// Audit-logged (SHEET_AUDIT).

import { NextResponse, type NextRequest } from 'next/server';
import {
  SHEET_ENABLED,
  SHEET_ALLOW_WRITE,
  MAX_FILE_BYTES,
  MAX_ROWS,
  MAX_COLS,
  openFile,
  createFile,
  saveFile,
} from '@/lib/sheetClient';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!SHEET_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Sheet tool is disabled. Set SHEET_TOOL_ENABLED=true (local dev only).' },
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
          result: { allowWrite: SHEET_ALLOW_WRITE, maxFileBytes: MAX_FILE_BYTES, maxRows: MAX_ROWS, maxCols: MAX_COLS },
        });
      case 'open':
        return NextResponse.json({ ok: true, result: await openFile(body.path) });
      case 'create': {
        try {
          const result = await createFile({ dir: body.dir, name: body.name });
          return NextResponse.json({ ok: true, result });
        } catch (err) {
          const msg = (err as Error).message || 'create refused';
          const gate = msg.includes('ALLOW_WRITE');
          return NextResponse.json({ ok: false, error: msg }, { status: gate ? 403 : 400 });
        }
      }
      case 'save': {
        try {
          const result = await saveFile({ path: body.path, mtimeMs: body.mtimeMs, sheets: body.sheets });
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
      { ok: false, error: (err as Error).message || 'Sheet operation failed', detail: String(err) },
      { status: 400 },
    );
  }
}
