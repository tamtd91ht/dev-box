// Manifest chia sẻ qua git: "project này gồm những repo nào".
//
// VẤN ĐỀ — configs/ bị gitignore toàn bộ (đúng: chứa secret + đường dẫn theo
// máy), nên configs/gitprojects.json không bao giờ đi theo repo. Ai pull dev-box
// về cũng mở tab Git ra thấy trắng, không có cách nào biết trước đó project này
// từng gồm những repo nào, phải đi hỏi người khác từng URL một.
//
// GIẢI PHÁP — tách làm hai phần theo tính portable:
//
//   configs/gitprojects.json         (local, ignored)  → id + name + ROOT tuyệt đối
//   configs/gitprojects.shared.json  (COMMIT)          → name + danh sách remote URL
//
// Manifest chỉ chứa thứ giống nhau trên mọi máy: tên project, và với mỗi repo là
// folder name + remote URL. KHÔNG chứa root — đó mới là phần khác nhau giữa các
// máy (E:\vihat\tool\vhs vs ~/work/vhs) và là lý do file gốc phải ignore.
//
// Nhờ vậy máy mới chỉ cần trỏ project tới folder của mình một lần, còn lại tab
// Git tự đối chiếu manifest với repo có trên đĩa và chỉ ra cái nào còn thiếu +
// clone được ngay.
//
// SECURITY — file này ĐƯỢC COMMIT nên tuyệt đối không được chứa secret:
//   1. Chỉ ghi remote URL. URL dạng https://user:pass@host/... bị strip phần
//      credential trước khi ghi (xem sanitizeRemote) — một remote đã từng nhúng
//      token là chuyện có thật, và commit nó lên là lộ token.
//   2. Không ghi root, không ghi đường dẫn tuyệt đối, không ghi token.

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';
import { detectRepos, remoteUrl } from './gitCore';
import { listProjects, type GitProject } from './gitProjects';

/** Một repo trong manifest — đủ để clone lại trên máy khác. */
export interface ManifestRepo {
  /** Tên folder repo nằm dưới root (một segment, không phải đường dẫn đầy đủ). */
  path: string;
  /** Remote origin URL, đã strip credential. '' khi repo không có origin. */
  url: string;
}

/** Một project trong manifest. Khớp với project local theo `name`. */
export interface ManifestProject {
  name: string;
  repos: ManifestRepo[];
}

/**
 * File manifest — CÓ commit. Cố ý KHÔNG cho override bằng env như các file khác:
 * nó là phần của repo, không phải state theo máy.
 */
const MANIFEST_FILE = configPath('gitprojects.shared.json');

/**
 * Bỏ phần credential nhúng trong remote URL trước khi ghi vào file được commit.
 * `https://oauth2:glpat-xxx@host/g/p.git` → `https://host/g/p.git`.
 */
export function sanitizeRemote(raw: string): string {
  const url = (raw || '').trim();
  if (!url) return '';
  // Dạng scp (git@host:group/repo.git): phần trước @ là username của SSH, không
  // phải secret — giữ nguyên.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    // Không parse được → cắt thủ công phần userinfo cho chắc, thà mất thông tin
    // hơn là commit token.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  }
}

/** Đọc manifest đã commit. Trả [] khi chưa có file / file lỗi. */
export async function readManifest(): Promise<ManifestProject[]> {
  let raw: string;
  try {
    raw = await fs.readFile(MANIFEST_FILE, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = (parsed as { projects?: unknown })?.projects;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p): p is ManifestProject => {
      const o = p as ManifestProject;
      return !!o && typeof o.name === 'string' && Array.isArray(o.repos);
    })
    .map((p) => ({
      name: p.name,
      repos: p.repos
        .filter((r): r is ManifestRepo => !!r && typeof r.path === 'string' && typeof r.url === 'string')
        // Chỉ nhận folder name một segment — manifest được commit nên có thể do
        // người khác sửa tay; một "../.." ở đây sẽ thành đích clone.
        .filter((r) => r.path === path.basename(r.path) && r.path !== '.' && r.path !== '..')
        .map((r) => ({ path: r.path, url: sanitizeRemote(r.url) })),
    }));
}

async function writeManifest(projects: ManifestProject[]): Promise<void> {
  const body = JSON.stringify({ projects }, null, 2) + '\n';
  await fs.writeFile(MANIFEST_FILE, body, 'utf8');
}

/**
 * Quét toàn bộ repo đang có dưới root của một project và trả entry manifest của
 * nó. Repo không có origin vẫn được ghi với url '' — nó vẫn là thông tin ("project
 * này có repo tên X"), và UI sẽ báo là không clone lại được.
 */
async function scanProject(project: GitProject): Promise<ManifestProject> {
  const repos = await detectRepos(project.root);
  const entries = await Promise.all(
    repos.map(async (r) => ({
      path: r.name,
      url: sanitizeRemote((await remoteUrl(r.path)) ?? ''),
    })),
  );
  return { name: project.name, repos: entries };
}

/**
 * Ghi đè manifest bằng thực tế trên đĩa của MỌI project đang cấu hình ("Đồng bộ
 * manifest"). Đây là nút chủ động: những gì có trên máy này trở thành nguồn sự
 * thật, nên nó xoá cả repo mà máy này không có.
 */
export async function syncManifest(): Promise<ManifestProject[]> {
  const { projects } = await listProjects();
  const scanned = await Promise.all(projects.map(scanProject));
  // Bỏ project rỗng: commit một project không repo nào chỉ gây nhiễu.
  const next = scanned.filter((p) => p.repos.length > 0);
  await writeManifest(next);
  return next;
}

/**
 * Thêm/cập nhật MỘT repo trong manifest — gọi sau khi clone hoặc tạo repo qua
 * tool, để manifest không bị lệch mà không cần ai nhớ bấm đồng bộ.
 *
 * Cố ý merge chứ không ghi đè: máy đang chạy có thể chưa clone hết repo mà
 * manifest liệt kê, và một lần clone không được phép xoá các entry đó.
 */
export async function recordRepo(projectName: string, repoPath: string, url: string): Promise<ManifestProject[]> {
  const name = (projectName || '').trim();
  const folder = path.basename((repoPath || '').trim());
  if (!name || !folder) return readManifest();
  const clean = sanitizeRemote(url);

  const projects = await readManifest();
  let proj = projects.find((p) => p.name === name);
  if (!proj) {
    proj = { name, repos: [] };
    projects.push(proj);
  }
  const existing = proj.repos.find((r) => r.path === folder);
  if (existing) existing.url = clean || existing.url;
  else proj.repos.push({ path: folder, url: clean });
  proj.repos.sort((a, b) => a.path.localeCompare(b.path));

  await writeManifest(projects);
  return projects;
}

/** Một repo có trong manifest nhưng chưa có trên đĩa. */
export interface MissingRepo {
  path: string;
  url: string;
}

export interface ManifestStatus {
  /** Manifest có tồn tại (đã commit) hay chưa. */
  present: boolean;
  /** Số repo manifest liệt kê cho project đang chọn. */
  total: number;
  /** Repo manifest có mà máy này chưa clone. */
  missing: MissingRepo[];
  /** Repo máy này có mà manifest chưa ghi — gợi ý bấm Đồng bộ. */
  extra: string[];
}

/**
 * Đối chiếu manifest với thực tế trên đĩa cho MỘT project. Đây là thứ tab Git
 * hiển thị: "manifest có 5 repo, máy bạn thiếu 2 — clone chúng?".
 */
export async function manifestStatus(project: GitProject): Promise<ManifestStatus> {
  const manifest = await readManifest();
  const entry = manifest.find((p) => p.name === project.name);
  const onDisk = new Set((await detectRepos(project.root)).map((r) => r.name));

  if (!entry) {
    return { present: manifest.length > 0, total: 0, missing: [], extra: [...onDisk].sort() };
  }
  const listed = new Set(entry.repos.map((r) => r.path));
  return {
    present: true,
    total: entry.repos.length,
    // Không có url thì không clone lại được — vẫn báo thiếu, UI sẽ disable nút.
    missing: entry.repos.filter((r) => !onDisk.has(r.path)).map((r) => ({ path: r.path, url: r.url })),
    extra: [...onDisk].filter((n) => !listed.has(n)).sort(),
  };
}
