// /api/code — single dispatch route for Code Studio (mini-IDE tab).
//
//   POST { action, ... } where action is one of:
//     'projects'   {}                                  → { projects, configured }   (dùng chung registry với tab Git)
//     'tree'       { projectId, rel }                  → { entries: TreeEntry[] }
//     'read'       { projectId, rel }                  → { content, binary, size, mtime }
//     'write'      { projectId, rel, content, mtime? } → { mtime }                  (mtime cũ → conflict check)
//     'create'     { projectId, rel, kind }            → { done }                   (kind: 'file' | 'dir')
//     'rename'     { projectId, rel, newName }         → { rel }
//     'remove'     { projectId, rel }                  → { done }
//     'termCreate' { projectId, rel?, shell?, cols?, rows? } → { id, pty }
//     'termWrite'  { id, data }                        → { done }
//     'termResize' { id, cols, rows }                  → { done }
//     'termKill'   { id }                              → { done }
//     'termList'   { projectId? }                      → { sessions }
//
// Output của terminal stream qua GET /api/code/term/<id> (SSE).
// Gated by CODE_TOOL_ENABLED — local dev tool, arbitrary shell access by design.

import { NextResponse, type NextRequest } from 'next/server';
import { listProjects, getProject } from '@/lib/gitProjects';
import {
  listDir, readFileSafe, writeFileSafe, createEntry, renameEntry, deleteEntry, resolveInside,
} from '@/lib/codeFs';
import { createSession, getSession, killSession, listSessions, type ShellKind } from '@/lib/termSessions';

export const runtime = 'nodejs';

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');
const CODE_ENABLED = on(process.env.CODE_TOOL_ENABLED);

export async function POST(req: NextRequest) {
  if (!CODE_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Code tool is disabled. Set CODE_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  const rel = typeof body.rel === 'string' ? body.rel : '';

  /** Project root cho các action đụng filesystem. */
  const needRoot = async (): Promise<string> => {
    const p = await getProject(String(body.projectId ?? ''));
    if (!p) throw new Error('Project không tồn tại — chọn lại project.');
    return p.root;
  };

  try {
    let result: unknown;
    switch (action) {
      case 'projects':
        result = await listProjects();
        break;
      case 'tree':
        result = { entries: await listDir(await needRoot(), rel) };
        break;
      case 'read':
        result = await readFileSafe(await needRoot(), rel);
        break;
      case 'write':
        result = await writeFileSafe(
          await needRoot(),
          rel,
          String(body.content ?? ''),
          typeof body.mtime === 'number' ? body.mtime : undefined,
        );
        break;
      case 'create':
        await createEntry(await needRoot(), rel, body.kind === 'dir' ? 'dir' : 'file');
        result = { done: true };
        break;
      case 'rename':
        result = await renameEntry(await needRoot(), rel, String(body.newName ?? ''));
        break;
      case 'remove':
        await deleteEntry(await needRoot(), rel);
        result = { done: true };
        break;
      case 'termCreate': {
        const root = await needRoot();
        const cwd = resolveInside(root, rel); // terminal mở tại folder đang chọn
        const s = createSession({
          projectId: String(body.projectId),
          cwd,
          shell: (['powershell', 'cmd', 'bash'] as ShellKind[]).find((k) => k === body.shell),
          cols: Number(body.cols) || undefined,
          rows: Number(body.rows) || undefined,
        });
        result = { id: s.id, pty: s.pty };
        break;
      }
      case 'termWrite': {
        const s = getSession(String(body.id ?? ''));
        if (!s) throw new Error('Terminal không tồn tại (đã đóng?).');
        s.write(String(body.data ?? ''));
        result = { done: true };
        break;
      }
      case 'termResize': {
        const s = getSession(String(body.id ?? ''));
        if (s) s.resize(Number(body.cols) || 80, Number(body.rows) || 24);
        result = { done: true };
        break;
      }
      case 'termKill':
        killSession(String(body.id ?? ''));
        result = { done: true };
        break;
      case 'termList':
        result = { sessions: listSessions(typeof body.projectId === 'string' ? body.projectId : undefined) };
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message || 'Code operation failed' }, { status: 502 });
  }
}
