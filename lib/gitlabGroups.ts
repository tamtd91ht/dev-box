// Server-only "quét một group GitLab → danh sách repo" cho màn Clone cả group.
//
// VÌ SAO TỒN TẠI — clone đơn (cloneRepo trong gitCore) cần người dùng dán từng
// URL. Dựng máy mới cho một dự án vài chục service thì đó là vài chục lần dán.
// Module này nhận MỘT đường dẫn/ID group, hỏi GitLab REST API lấy toàn bộ project
// (kể cả trong nhóm con), để UI cho tick chọn rồi clone hàng loạt.
//
// MÔ HÌNH BẢO MẬT — giống gitlabProjects.ts: token là PAT đã lưu theo host
// (gitlabTokens.ts), tra phía server, KHÔNG bao giờ trả về trình duyệt. Host do
// client gửi chỉ dùng để tra token đã lưu và dựng URL https:// tới API. Module
// này chỉ ĐỌC (GET) — không tạo/sửa gì trên GitLab.

import { getToken } from './gitlabTokens';
import { normalizeGitLabHost } from './gitlabProjects';

const API_TIMEOUT_MS = 20_000;
const PER_PAGE = 100;
/** Chặn trên số trang — 50 × 100 = 5000 repo, quá đủ cho một group thật. */
const MAX_PAGES = 50;

/** Một repo trong group, dạng đủ cho UI chọn + clone. */
export interface GroupRepo {
  id: number;
  name: string;
  /** Đoạn cuối URL của project — cũng là tên thư mục mặc định khi clone. */
  path: string;
  /** "group/sub/repo". */
  pathWithNamespace: string;
  /** Đường dẫn tính từ group đã quét, vd "sub/repo" (repo trực tiếp → "repo"). */
  relativePath: string;
  webUrl: string;
  httpUrl: string;
  sshUrl: string;
  /** '' khi repo rỗng (chưa có commit). */
  defaultBranch: string;
  archived: boolean;
  emptyRepo: boolean;
}

export interface GroupScanResult {
  host: string;
  group: { id: number; name: string; fullPath: string; webUrl: string };
  repos: GroupRepo[];
  /** true khi chạm MAX_PAGES — danh sách có thể chưa đủ. */
  truncated: boolean;
}

/**
 * Lỗi mà UI chữa được bằng cách nhập/đổi token: mang kèm host để form token biết
 * lưu cho host nào. Route /api/git chuyển hai field này ra response.
 */
export class GitLabTokenError extends Error {
  readonly needToken = true;
  constructor(
    message: string,
    readonly host: string,
  ) {
    super(message);
  }
}

/**
 * Tách thứ người dùng gõ thành { host, group }. Nhận:
 *   - URL đầy đủ:  https://gitlab.x.com/groups/a/b  |  https://gitlab.x.com/a/b
 *                  (đuôi "/-/…" của các trang con được bỏ)
 *   - host/path:   gitlab.x.com/a/b
 *   - ID số:       1234            (cần host đi kèm)
 *   - path trần:   a/b             (cần host đi kèm)
 */
export function parseGroupRef(inputRaw: unknown, hostRaw: unknown): { host: string; group: string } {
  let input = typeof inputRaw === 'string' ? inputRaw.trim() : '';
  if (!input) throw new Error('nhập đường dẫn hoặc ID của group GitLab');

  let host = '';
  const m = /^https?:\/\/([^/\s]+)(\/.*)?$/i.exec(input);
  if (m) {
    host = m[1];
    input = m[2] ?? '';
  } else if (!/^\d+$/.test(input)) {
    // "gitlab.x.com/a/b" — đoạn đầu có dấu chấm và còn phần sau → coi là host.
    const first = input.split('/')[0];
    if (first.includes('.') && input.includes('/')) {
      host = first;
      input = input.slice(first.length);
    }
  }

  // Bỏ query/hash, tiền tố /groups/, đuôi "/-/…" (trang con), và dấu / thừa.
  let group = input.replace(/[?#].*$/, '');
  group = group.replace(/^\/+/, '').replace(/^groups\//i, '');
  group = group.replace(/\/-(\/.*)?$/, '').replace(/\/+$/, '');
  try {
    group = decodeURIComponent(group);
  } catch {
    /* giữ nguyên nếu không decode được */
  }
  if (!group) throw new Error('không thấy đường dẫn group trong URL — vd https://gitlab.com/ten-group');
  if (!/^\d+$/.test(group) && !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(group)) {
    throw new Error(`đường dẫn group không hợp lệ: ${group}`);
  }

  const hostFinal = normalizeGitLabHost(
    host || (typeof hostRaw === 'string' && hostRaw.trim() ? hostRaw : ''),
  );
  return { host: hostFinal, group };
}

interface Page {
  data: unknown;
  nextPage: string;
}

/** GET một trang của GitLab API. Trả cả header phân trang. */
async function apiGet(host: string, token: string, apiPath: string): Promise<Page> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`https://${host}/api/v4${apiPath}`, {
      headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
      signal: ac.signal,
    });
  } catch (e) {
    throw new Error(`Gọi GitLab API (${host}) thất bại: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: unknown; error?: unknown };
      if (typeof j.message === 'string') detail = j.message;
      else if (typeof j.error === 'string') detail = j.error;
    } catch {
      /* giữ text thô */
    }
    if (res.status === 401) {
      throw new GitLabTokenError(
        `GitLab từ chối token của ${host} (401) — token sai hoặc đã hết hạn. Nhập token mới (scope \`read_api\` hoặc \`api\`).`,
        host,
      );
    }
    if (res.status === 403) {
      throw new GitLabTokenError(
        `Token của ${host} thiếu quyền (403) — cần scope \`read_api\` hoặc \`api\`. ${detail}`,
        host,
      );
    }
    if (res.status === 404) {
      throw new Error(
        'Không tìm thấy group (404) — sai đường dẫn/ID, hoặc tài khoản của token không phải thành viên group này.',
      );
    }
    throw new Error(`GitLab API ${res.status}: ${detail}`);
  }
  return { data: text ? JSON.parse(text) : null, nextPage: res.headers.get('x-next-page') || '' };
}

interface GroupJson {
  id: number;
  name: string;
  full_path: string;
  web_url: string;
}

interface ProjectJson {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  web_url: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  default_branch?: string | null;
  archived?: boolean;
  empty_repo?: boolean;
}

/**
 * Quét mọi project của một group, GỒM CẢ nhóm con (include_subgroups). Project
 * được chia sẻ từ group khác (with_shared) bị loại — chúng không thuộc group này
 * và đường dẫn tương đối của chúng vô nghĩa.
 */
export async function scanGroup(inputRaw: unknown, hostRaw: unknown): Promise<GroupScanResult> {
  const { host, group } = parseGroupRef(inputRaw, hostRaw);
  const token = await getToken(host);
  if (!token) {
    throw new GitLabTokenError(
      `Chưa có token GitLab cho ${host}. Tạo Personal Access Token (scope \`read_api\` hoặc \`api\`) ` +
        `tại https://${host}/-/user_settings/personal_access_tokens rồi dán vào ô bên dưới.`,
      host,
    );
  }

  const g = (await apiGet(host, token, `/groups/${encodeURIComponent(group)}?with_projects=false`)).data as GroupJson;

  const repos: GroupRepo[] = [];
  let page = '1';
  let pages = 0;
  let truncated = false;
  while (page) {
    if (pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
    pages++;
    const { data, nextPage } = await apiGet(
      host,
      token,
      `/groups/${g.id}/projects?include_subgroups=true&with_shared=false&simple=false` +
        `&order_by=path&sort=asc&per_page=${PER_PAGE}&page=${encodeURIComponent(page)}`,
    );
    const list = Array.isArray(data) ? (data as ProjectJson[]) : [];
    const prefix = `${g.full_path}/`;
    for (const p of list) {
      const full = p.path_with_namespace || '';
      repos.push({
        id: p.id,
        name: p.name,
        path: p.path,
        pathWithNamespace: full,
        relativePath: full.toLowerCase().startsWith(prefix.toLowerCase()) ? full.slice(prefix.length) : p.path,
        webUrl: p.web_url,
        httpUrl: p.http_url_to_repo,
        sshUrl: p.ssh_url_to_repo,
        defaultBranch: p.default_branch || '',
        archived: !!p.archived,
        emptyRepo: !!p.empty_repo,
      });
    }
    // Hết trang: header rỗng, hoặc (instance cũ không gửi header) trang chưa đầy.
    page = nextPage || (list.length === PER_PAGE && !nextPage ? String(pages + 1) : '');
    if (!list.length) page = '';
  }

  repos.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    host,
    group: { id: g.id, name: g.name, fullPath: g.full_path, webUrl: g.web_url },
    repos,
    truncated,
  };
}
