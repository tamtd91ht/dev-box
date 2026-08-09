// Server-only persistence + validation for Git "projects".
//
// A project is just { id, name, root } — a named root folder under which sibling
// git repos are auto-detected. The list lives in a single JSON file on the local
// machine (gitignored) so each developer configures their own folder layout ONCE
// and it survives restarts. Missing file → no projects yet (the UI prompts to add
// one); a legacy GIT_TOOL_ROOT is surfaced as an implicit fallback project so the
// old single-root behaviour keeps working with zero config.
//
// SECURITY MODEL — this is a LOCAL, single-user tool (gated by GIT_TOOL_ENABLED,
// off in any k8s/prod deploy). Folder layout is per-machine, so a project root
// may be anywhere the host can read — we do NOT restrict it to a "safe base"
// (anyone who can reach this tool already has the developer's own filesystem
// access). A root is accepted as long as it exists and is a directory. Git
// actions still only ever target paths inside a configured project root (see
// authorizeRepo in gitCore), and every path is path.resolve()'d — never string-
// concatenated from client input.

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';

export interface GitProject {
  /** Stable opaque id (used as the tab key + api param). */
  id: string;
  /** Human label shown on the tab. */
  name: string;
  /** Absolute, normalized root folder that holds the repos. */
  root: string;
}

/** File holding the project list. Overridable via GIT_PROJECTS_PATH. */
const PROJECTS_FILE = process.env.GIT_PROJECTS_PATH
  ? path.resolve(process.cwd(), process.env.GIT_PROJECTS_PATH)
  : configPath('gitprojects.json', ['.gitprojects.json']);

/**
 * A sensible STARTING folder for the browse picker (not a restriction). Priority:
 *   GIT_TOOL_BASE → GIT_TOOL_ROOT → the parent of cwd (the workspace holding this
 *   repo). The user can browse anywhere from there.
 */
export function browseStart(): string {
  const raw = process.env.GIT_TOOL_BASE || process.env.GIT_TOOL_ROOT || path.resolve(process.cwd(), '..');
  return path.resolve(raw);
}

/**
 * Validate + normalize a user-supplied root. Local tool → the only requirement is
 * that it exists and is a directory (no base restriction). Returns the canonical
 * absolute path to store.
 */
export async function validateRoot(root: unknown): Promise<string> {
  if (typeof root !== 'string' || !root.trim()) throw new Error('root folder is required');
  const resolved = path.resolve(root.trim());
  let st;
  try {
    st = await fs.stat(resolved);
  } catch {
    throw new Error('root folder does not exist');
  }
  if (!st.isDirectory()) throw new Error('root is not a directory');
  return resolved;
}

/**
 * Read the persisted project list.
 *
 * `null` = CHƯA CÓ file (chưa từng cấu hình, hoặc file hỏng) — khác hẳn với `[]`
 * = có file nhưng danh sách rỗng, tức người dùng đã CHỦ Ý xoá hết. Phân biệt hai
 * ca này là bắt buộc: xem listProjects().
 */
async function readPersisted(): Promise<GitProject[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(PROJECTS_FILE, 'utf8');
  } catch {
    return null; // chưa có file
  }
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.projects) ? parsed.projects : Array.isArray(parsed) ? parsed : [];
    return arr
      .filter((p: unknown): p is GitProject => {
        const o = p as GitProject;
        return !!o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.root === 'string';
      })
      .map((p: GitProject) => ({ id: p.id, name: p.name, root: path.resolve(p.root) }));
  } catch {
    return null; // file hỏng → coi như chưa cấu hình, đừng nuốt mất fallback
  }
}

/** Danh sách đã lưu, coi "chưa có file" như rỗng — dùng cho các hàm ghi. */
async function readRaw(): Promise<GitProject[]> {
  return (await readPersisted()) ?? [];
}

async function writeRaw(projects: GitProject[]): Promise<void> {
  await fs.writeFile(PROJECTS_FILE, JSON.stringify({ projects }, null, 2) + '\n', 'utf8');
}

/**
 * The implicit fallback project derived from GIT_TOOL_ROOT / the default sibling
 * root, so the tool works with zero config exactly like before. Returned ONLY
 * when the user hasn't configured any project of their own. Its id is reserved.
 */
export const DEFAULT_PROJECT_ID = '__default__';

function defaultProject(): GitProject {
  const root = process.env.GIT_TOOL_ROOT
    ? path.resolve(process.env.GIT_TOOL_ROOT)
    : path.resolve(process.cwd(), '..');
  return { id: DEFAULT_PROJECT_ID, name: path.basename(root) || 'workspace', root };
}

/**
 * Effective project list shown to the client: the persisted list, or — when the
 * user has never configured anything — a single implicit default so first-run is
 * never a blank screen. The `configured` flag lets the UI tell "user set this up"
 * from "auto fallback".
 *
 * DANH SÁCH RỖNG KHÁC VỚI CHƯA CẤU HÌNH. Trước đây cả hai đều rơi vào fallback,
 * nên xoá project CUỐI CÙNG là nó "mọc lại" ngay: default lấy tên + root từ thư
 * mục cha của app, trùng khít với project mà nhiều người tự thêm, nên nhìn y hệt
 * cái vừa xoá — mà lúc đó `configured` thành false nên bảng Quản lý còn giấu
 * luôn nút Xóa, hết đường xoá lại. File đã tồn tại nghĩa là người dùng từng lưu:
 * rỗng thì phải trả về rỗng.
 */
export async function listProjects(): Promise<{ projects: GitProject[]; configured: boolean; base: string }> {
  const persisted = await readPersisted();
  if (persisted === null) return { projects: [defaultProject()], configured: false, base: browseStart() };
  return { projects: persisted, configured: true, base: browseStart() };
}

/** Roots the git actions are allowed to operate under (all effective projects). */
export async function allowedRoots(): Promise<string[]> {
  const { projects } = await listProjects();
  return projects.map((p) => p.root);
}

/** Resolve a single project by id from the EFFECTIVE list (incl. default). */
export async function getProject(id: string): Promise<GitProject | null> {
  const { projects } = await listProjects();
  return projects.find((p) => p.id === id) ?? null;
}

// ── Mutations (operate on the persisted list only) ──────────────────────────────

/** Short, filesystem/id-safe random-free id derived from name + root. Stable enough
 *  for a local single-user tool; collisions are resolved by suffixing. */
function makeId(name: string, existing: Set<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  let id = slug;
  let n = 2;
  while (existing.has(id) || id === DEFAULT_PROJECT_ID) id = `${slug}-${n++}`;
  return id;
}

export async function addProject(name: unknown, root: unknown): Promise<GitProject[]> {
  const label = typeof name === 'string' ? name.trim() : '';
  if (!label) throw new Error('project name is required');
  const resolvedRoot = await validateRoot(root);
  const persisted = await readRaw();
  if (persisted.some((p) => p.root === resolvedRoot)) {
    throw new Error('a project with that root already exists');
  }
  const id = makeId(label, new Set(persisted.map((p) => p.id)));
  persisted.push({ id, name: label, root: resolvedRoot });
  await writeRaw(persisted);
  return persisted;
}

export async function updateProject(id: unknown, name: unknown, root: unknown): Promise<GitProject[]> {
  if (typeof id !== 'string' || !id) throw new Error('project id is required');
  const persisted = await readRaw();
  const idx = persisted.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error('project not found');
  const next = { ...persisted[idx] };
  if (typeof name === 'string' && name.trim()) next.name = name.trim();
  if (root !== undefined) {
    const resolvedRoot = await validateRoot(root);
    if (persisted.some((p, i) => i !== idx && p.root === resolvedRoot)) {
      throw new Error('a project with that root already exists');
    }
    next.root = resolvedRoot;
  }
  persisted[idx] = next;
  await writeRaw(persisted);
  return persisted;
}

export async function removeProject(id: unknown): Promise<GitProject[]> {
  if (typeof id !== 'string' || !id) throw new Error('project id is required');
  const persisted = await readRaw();
  const next = persisted.filter((p) => p.id !== id);
  await writeRaw(next);
  return next;
}
