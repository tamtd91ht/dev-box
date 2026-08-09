// /api/git-projects — manage the local Git "project" list (name + root folder).
//
//   GET                        → { enabled, configured, base, projects[] }
//   POST   { name, root }      → add a project      → { projects[], configured, base }
//   POST   { op:'manifest', projectId }  → manifest vs disk → { manifest }
//   POST   { op:'sync-manifest' }        → rewrite manifest → { projects[] }
//   PUT    { id, name?, root? } → update a project   → { projects[], configured, base }
//   DELETE { id }              → remove a project    → { projects[], configured, base }
//
// Gated by the same GIT_TOOL_ENABLED flag as /api/git — on a k8s/production
// deployment the flag is unset, so this returns 403 and no folder is touched.
// Root chỉ cần CÓ THẬT và là thư mục — KHÔNG bị giới hạn trong một "base an
// toàn" nào (tool local, xem phần SECURITY MODEL trong lib/gitProjects). `base`
// trả kèm chỉ là thư mục mở sẵn cho hộp chọn thư mục.

import { NextResponse, type NextRequest } from 'next/server';
import { GIT_ENABLED } from '@/lib/gitCore';
import { listProjects, addProject, updateProject, removeProject, browseStart, getProject } from '@/lib/gitProjects';
import { manifestStatus, syncManifest } from '@/lib/gitManifest';

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

/**
 * Trạng thái trả về sau MỌI mutation — kèm `configured` chứ không chỉ danh sách.
 *
 * Client không tự suy ra được cờ này: danh sách rỗng có thể là "chưa cấu hình
 * bao giờ" (đang dùng thư mục tự nhận diện) hoặc "vừa xoá hết" — hai thứ hiện ra
 * hai màn hình khác nhau. Trả kèm ở đây thì client khỏi phải GET lại lần nữa,
 * tránh luôn cảnh một cú GET lỗi vặt làm cả tab Git tưởng mình bị tắt.
 */
async function stateAfterMutation() {
  const { projects, configured, base } = await listProjects();
  return { projects, configured, base };
}

export async function POST(req: NextRequest) {
  if (!GIT_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    // Manifest ops đi chung POST (thay vì thêm route mới) vì cùng vòng đời với
    // project list — `op` phân biệt chúng với "thêm project".
    if (body?.op === 'manifest') {
      const project = await getProject(String(body?.projectId ?? ''));
      if (!project) throw new Error('project not found');
      return NextResponse.json({ manifest: await manifestStatus(project) });
    }
    if (body?.op === 'sync-manifest') {
      return NextResponse.json({ projects: await syncManifest() });
    }
    await addProject(body?.name, body?.root);
    return NextResponse.json(await stateAfterMutation());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, base: browseStart() }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!GIT_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    await updateProject(body?.id, body?.name, body?.root);
    return NextResponse.json(await stateAfterMutation());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, base: browseStart() }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!GIT_ENABLED) return disabled();
  const body = await req.json().catch(() => null);
  try {
    await removeProject(body?.id);
    return NextResponse.json(await stateAfterMutation());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
