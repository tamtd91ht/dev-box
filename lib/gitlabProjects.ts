// Server-only "create a new GitLab project" for the local Git workspace.
//
// WHY THIS EXISTS — the workspace could already bring an EXISTING remote repo
// down (cloneRepo in gitCore). Starting a brand-new service still meant leaving
// the tool: open GitLab in a browser, click New project, copy the URL back, then
// clone. This module closes that loop: create the project through the GitLab REST
// API, then hand the resulting HTTPS URL to cloneRepo so the new repo lands in the
// active project's root and shows up in the repo list like any other.
//
// SECURITY MODEL — mirrors gitlabMr.ts / gitlabTokens.ts:
//   1. Gated by GIT_TOOL_ENABLED (the /api/git route 403s otherwise) — a local,
//      single-user developer tool, off in any k8s/prod deploy.
//   2. The API token is the Personal Access Token stored per-host by
//      gitlabTokens.ts. It is resolved server-side and NEVER echoed to the
//      browser. Unlike the MR flow there is no repo to read `origin` from, so the
//      host comes from the client — but it is only ever used to look up an
//      already-saved token and to build an https:// API URL, and a host with no
//      saved token fails with a clear message instead of prompting.
//   3. Every value sent to GitLab goes in a JSON body (no shell, no argv), and the
//      project path/name are validated here before the call so a typo fails fast
//      with a readable error rather than a 400 from GitLab.

import { getToken } from './gitlabTokens';

const API_TIMEOUT_MS = 20_000;

/** Project visibility as GitLab names it. */
export type GitLabVisibility = 'private' | 'internal' | 'public';

/** One namespace (personal or group) a project can be created under. */
export interface NamespaceOption {
  id: number;
  /** Full path, e.g. "backend/services" — what the project URL is prefixed with. */
  fullPath: string;
  /** Human label, e.g. "Backend / Services". */
  name: string;
  /** 'user' | 'group' — shown so a personal namespace is recognisable. */
  kind: string;
}

/** What the client learns about a freshly created GitLab project. */
export interface CreatedProject {
  id: number;
  name: string;
  /** "group/sub/repo" — the project's path with its namespace. */
  pathWithNamespace: string;
  /** Browser URL of the project. */
  webUrl: string;
  /** HTTPS clone URL — what the local clone step uses. */
  httpUrl: string;
  sshUrl: string;
  /** Default branch, or '' when the project was created empty. */
  defaultBranch: string;
  visibility: string;
}

interface GitLabProjectJson {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  default_branch?: string;
  visibility?: string;
}

interface GitLabNamespaceJson {
  id: number;
  name: string;
  full_path: string;
  kind: string;
}

/**
 * Normalize + validate a bare hostname[:port] typed by the user. Same rule as
 * gitlabTokens.normalizeHost — a URL or path here would silently never match a
 * saved token.
 */
export function normalizeGitLabHost(raw: unknown): string {
  let h = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  // Tolerate a pasted URL ("https://gitlab.example.com/") — take just the host.
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!h) throw new Error('host GitLab là bắt buộc');
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(h)) throw new Error(`host GitLab không hợp lệ: ${raw}`);
  return h;
}

/**
 * Validate the project's URL path (the last segment of its GitLab URL). GitLab's
 * own rule: start with alphanumeric, then alphanumerics, `_ . -`, no trailing
 * `.git`/`.atom`. Checked here so a bad value never becomes a folder name either.
 */
export function validateProjectPath(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p) throw new Error('đường dẫn (path) của repo là bắt buộc');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p)) {
    throw new Error('path chỉ gồm chữ/số/._- và phải bắt đầu bằng chữ hoặc số');
  }
  if (/\.(git|atom)$/i.test(p)) throw new Error('path không được kết thúc bằng .git hoặc .atom');
  return p;
}

/** Validate the display name. GitLab is permissive here; we only require non-empty. */
export function validateProjectName(raw: unknown, fallbackPath: string): string {
  const n = typeof raw === 'string' ? raw.trim() : '';
  return n || fallbackPath;
}

/** Coerce a client-supplied visibility, defaulting to the safe option. */
export function validateVisibility(raw: unknown): GitLabVisibility {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'private' || v === 'internal' || v === 'public') return v;
  return 'private';
}

/**
 * Resolve the PAT for `host`, throwing an actionable error when none is saved.
 *
 * Unlike gitlabMr.resolveToken there is no repo to fall back to `git credential`
 * with — and that fallback often yields an account password the REST API rejects
 * anyway — so a saved PAT is required. Project creation needs scope `api`.
 */
async function resolveHostToken(host: string): Promise<string> {
  const token = await getToken(host);
  if (token) return token;
  throw new Error(
    `Chưa có token GitLab cho ${host}. Tạo Personal Access Token (scope \`api\`) trên ` +
      `https://${host}/-/user_settings/personal_access_tokens rồi lưu lại ở ô "Token GitLab" bên dưới.`,
  );
}

/** Call the GitLab REST API for `host` with the PRIVATE-TOKEN header. */
async function api(
  host: string,
  token: string,
  method: 'GET' | 'POST',
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `https://${host}/api/v4${apiPath}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': token,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (e) {
    throw new Error(`Gọi GitLab API thất bại: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text) as { message?: unknown; error?: unknown };
      // GitLab returns validation errors as { message: { path: ["..."] } }.
      if (j.message && typeof j.message === 'object') detail = JSON.stringify(j.message);
      else if (typeof j.message === 'string') detail = j.message;
      else if (typeof j.error === 'string') detail = j.error;
    } catch {
      /* keep raw text */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `GitLab API ${res.status}: token không hợp lệ hoặc thiếu quyền (cần scope \`api\`, ` +
          `và quyền tạo project trong namespace đã chọn). ${detail}`,
      );
    }
    if (res.status === 400 || res.status === 409 || res.status === 422) {
      throw new Error(`GitLab từ chối: ${detail}`);
    }
    throw new Error(`GitLab API ${res.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Namespaces the token's owner can create a project in — their personal namespace
 * plus every group they're a member of. Lets the UI offer a picker instead of
 * making the user remember a numeric namespace id.
 */
export async function listNamespaces(hostRaw: unknown): Promise<{ host: string; namespaces: NamespaceOption[] }> {
  const host = normalizeGitLabHost(hostRaw);
  const token = await resolveHostToken(host);
  const data = (await api(host, token, 'GET', '/namespaces?per_page=100')) as GitLabNamespaceJson[];
  const namespaces = (Array.isArray(data) ? data : []).map((n) => ({
    id: n.id,
    fullPath: n.full_path,
    name: n.name,
    kind: n.kind,
  }));
  // Personal namespace first (it's the common default), then groups by path.
  namespaces.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'user' ? -1 : 1;
    return a.fullPath.localeCompare(b.fullPath);
  });
  return { host, namespaces };
}

export interface CreateProjectInput {
  host: unknown;
  /** URL path (last segment). Required. */
  path: unknown;
  /** Display name. Defaults to the path. */
  name?: unknown;
  /** Numeric namespace id from listNamespaces. Omitted → the token owner's own. */
  namespaceId?: unknown;
  visibility?: unknown;
  description?: unknown;
  /** Seed the repo with a README so it has a default branch (and is clonable). */
  initReadme?: unknown;
  /** Name of the default branch when initialising with a README. */
  defaultBranch?: unknown;
}

/**
 * Create a new project on GitLab and return its clone URLs.
 *
 * `initReadme` matters: a project created empty has no commits and no default
 * branch. Cloning it works but git warns about an empty repository, and the
 * workspace's per-repo status has no branch to report — so the UI defaults this
 * on and callers who want a truly empty repo must opt out.
 */
export async function createGitLabProject(input: CreateProjectInput): Promise<CreatedProject> {
  const host = normalizeGitLabHost(input.host);
  const projPath = validateProjectPath(input.path);
  const name = validateProjectName(input.name, projPath);
  const visibility = validateVisibility(input.visibility);
  const token = await resolveHostToken(host);

  const body: Record<string, unknown> = { name, path: projPath, visibility };
  if (input.namespaceId !== undefined && input.namespaceId !== null && input.namespaceId !== '') {
    const id = Number(input.namespaceId);
    if (!Number.isInteger(id) || id < 1) throw new Error('namespace không hợp lệ');
    body.namespace_id = id;
  }
  const desc = typeof input.description === 'string' ? input.description.trim() : '';
  if (desc) body.description = desc;
  if (input.initReadme) {
    body.initialize_with_readme = true;
    const branch = typeof input.defaultBranch === 'string' ? input.defaultBranch.trim() : '';
    if (branch) {
      if (branch.startsWith('-') || /[\s~^:?*[\]\\]/.test(branch)) throw new Error('tên branch không hợp lệ');
      body.default_branch = branch;
    }
  }

  const created = (await api(host, token, 'POST', '/projects', body)) as GitLabProjectJson;
  return {
    id: created.id,
    name: created.name,
    pathWithNamespace: created.path_with_namespace,
    webUrl: created.web_url,
    httpUrl: created.http_url_to_repo,
    sshUrl: created.ssh_url_to_repo,
    defaultBranch: created.default_branch || '',
    visibility: created.visibility || visibility,
  };
}
