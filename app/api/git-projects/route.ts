// /api/git-projects — manage the local Git "project" list (name + root folder).
//
//   GET                        → { enabled, configured, base, projects[] }
//   POST   { name, root }      → add a project      → { projects[] }
//   PUT    { id, name?, root? } → update a project   → { projects[] }
//   DELETE { id }              → remove a project    → { projects[] }
//
// Gated by the same GIT_TOOL_ENABLED flag as /api/git — on a k8s/production
// deployment the flag is unset, so this returns 403 and no folder is touched.
// Roots are validated against a safe base (see lib/gitProjects) before storage.

import { NextResponse, type NextRequest } from 'next/server';
import { GIT_ENABLED } from '@/lib/gitCore';
import { listProjects, addProject, updateProject, removeProject, browseStart } from '@/lib/gitProjects';

export const runtime = 'nodejs';

function disabled() {
  return NextResponse.json(
    { error: 'Git tool is disabled. Set GIT_TOOL_ENABLED=true to enable it (local dev only).' },
    { status: 403 },
  );
}

export async function GET() {
  if (!GIT_ENABLED) return NextResponse.json({ enabled: false, configured: false, base: '', projects: [] });
  const { projects, configured, base } = await listProjects();
  return NextResponse.json({ enabled: true, configured, base, projects });
}

export async function POST(req: NextRequest) {
  if (!GIT_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const projects = await addProject(body?.name, body?.root);
    return NextResponse.json({ projects });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, base: browseStart() }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!GIT_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const projects = await updateProject(body?.id, body?.name, body?.root);
    return NextResponse.json({ projects });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, base: browseStart() }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!GIT_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    const projects = await removeProject(body?.id);
    return NextResponse.json({ projects });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
