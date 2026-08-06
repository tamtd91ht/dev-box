// Server-only GitLab merge-request API for the local Git workspace.
//
// SECURITY MODEL — mirrors gitCore.ts. This runs on the developer's own machine,
// gated by GIT_TOOL_ENABLED (the /api/git route 403s otherwise), and never
// exposes any secret to the browser:
//   1. The GitLab API token is NOT configured anywhere and NOT entered in the UI.
//      It is read at request time from the SAME git credential helper that `git
//      push`/`pull` already uses — via `git credential fill`. The token stays on
//      the server; only MR metadata (never the token) is returned to the client.
//   2. The GitLab host + project path are derived from the repo's own `origin`
//      remote URL — never from client input. The client only ever names an
//      already-authorized repo path (authorizeRepo in the route) and an MR iid.
//   3. All git subcommands run via execFile('git', [argv]) — never a shell string.
//
// Scope: list OPEN MRs targeting a branch, and merge one MR by iid. Both go
// through the GitLab REST API (/api/v4) so the MR record, CI, and approval rules
// on GitLab are respected — this is a real MR merge, not a local `git merge`.

import { execFile } from 'child_process';
import { getToken } from './gitlabTokens';

const GIT_TIMEOUT_MS = 15_000;
const API_TIMEOUT_MS = 20_000;

/**
 * Run a git subcommand in `cwd`, optionally feeding `input` to stdin.
 *
 * Never interactive. This runs inside a server request with no attached
 * terminal, so a credential prompt has nobody to answer it: GIT_TERMINAL_PROMPT=0
 * blocks git's own text prompt, and an empty GIT_ASKPASS/SSH_ASKPASS blocks the
 * GUI helper (on Windows, Git Credential Manager) that would otherwise pop a
 * dialog per call. Without these, `credential fill` below pops a login box that
 * can never stick — `fill` only READS credentials, so whatever is typed is used
 * once and never saved, and the next call prompts again.
 */
function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1 << 20,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GCM_INTERACTIVE: 'never',
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || (err as Error).message || '').toString().trim();
          reject(new Error(msg || 'git command failed'));
          return;
        }
        resolve(stdout.toString());
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

// ── Remote parsing ────────────────────────────────────────────────────────────

export interface GitLabRepoRef {
  /** API base, e.g. "https://gitlab.example.com". */
  baseUrl: string;
  /** Host only, e.g. "gitlab.example.com" — used for credential lookup. */
  host: string;
  /** URL-encoded "group/subgroup/project" path (no .git). */
  projectPath: string;
}

/**
 * Parse a git remote URL (HTTPS or SSH) into the GitLab host + project path.
 * Supports:
 *   https://gitlab.host/group/sub/proj.git
 *   https://user@gitlab.host/group/proj.git
 *   git@gitlab.host:group/sub/proj.git
 *   ssh://git@gitlab.host:22/group/proj.git
 */
export function parseGitLabRemote(remoteUrl: string): GitLabRepoRef {
  const url = (remoteUrl || '').trim();
  if (!url) throw new Error('remote URL is empty');

  let host = '';
  let projectPath = '';

  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('ssh://')) {
    const u = new URL(url);
    host = u.hostname;
    projectPath = u.pathname.replace(/^\/+/, '');
  } else {
    // scp-like syntax: git@host:group/proj.git
    const m = url.match(/^[^@]+@([^:]+):(.+)$/);
    if (!m) throw new Error(`unrecognized remote URL: ${url}`);
    host = m[1];
    projectPath = m[2];
  }

  projectPath = projectPath.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!host || !projectPath) throw new Error(`could not derive GitLab host/project from: ${url}`);

  // Always HTTPS for the API, regardless of the remote's transport.
  return { baseUrl: `https://${host}`, host, projectPath };
}

/** Resolve the GitLab ref for an authorized repo path (reads its `origin` remote). */
export async function repoGitLabRef(repo: string): Promise<GitLabRepoRef> {
  const out = await git(repo, ['remote', 'get-url', 'origin']);
  return parseGitLabRemote(out.trim());
}

// ── Token via git credential helper ───────────────────────────────────────────

/**
 * Ask git's own credential helper for the token it uses to talk to `host`, using
 * the authorized repo as cwd so repo-scoped credential config applies. The value
 * returned by `git credential fill` under `password=` is exactly what git sends
 * for HTTPS auth — for a GitLab HTTPS remote this is normally a Personal/Project
 * Access Token, which the REST API accepts as a Bearer / PRIVATE-TOKEN.
 *
 * Returns null when the helper yields nothing (e.g. an SSH remote with no HTTPS
 * credential stored) so the caller can surface a clear, actionable error.
 */
async function tokenFromGitCredential(repo: string, host: string): Promise<string | null> {
  const input = `protocol=https\nhost=${host}\n\n`;
  let out: string;
  try {
    // NOTE: `git credential` has no --no-prompt flag (it accepts only
    // fill|approve|reject, and rejects anything else with exit 129). Interactive
    // prompts are suppressed by the env set in git() above instead.
    out = await git(repo, ['credential', 'fill'], input);
  } catch {
    return null;
  }
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq) === 'password') {
      const v = line.slice(eq + 1).trim();
      return v || null;
    }
  }
  return null;
}

// ── GitLab REST API ───────────────────────────────────────────────────────────

export interface MergeRequestSummary {
  iid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  webUrl: string;
  /** 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'checking' | ... */
  mergeStatus: string;
  draft: boolean;
  hasConflicts: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GitLabMrJson {
  iid: number;
  title: string;
  source_branch: string;
  target_branch: string;
  author?: { name?: string; username?: string };
  web_url: string;
  merge_status?: string;
  detailed_merge_status?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  has_conflicts?: boolean;
  created_at: string;
  updated_at: string;
  state?: string;
}

function toSummary(m: GitLabMrJson): MergeRequestSummary {
  return {
    iid: m.iid,
    title: m.title,
    sourceBranch: m.source_branch,
    targetBranch: m.target_branch,
    author: m.author?.name || m.author?.username || '',
    webUrl: m.web_url,
    mergeStatus: m.detailed_merge_status || m.merge_status || 'unknown',
    draft: !!(m.draft ?? m.work_in_progress),
    hasConflicts: !!m.has_conflicts,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

async function gitlabApi(
  ref: GitLabRepoRef,
  token: string,
  method: 'GET' | 'PUT',
  apiPath: string,
): Promise<unknown> {
  const url = `${ref.baseUrl}/api/v4/projects/${encodeURIComponent(ref.projectPath)}${apiPath}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': token,
        Accept: 'application/json',
      },
      signal: ac.signal,
    });
  } catch (e) {
    throw new Error(`GitLab API request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      detail = j.message || j.error || detail;
    } catch {
      /* keep raw text */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `GitLab API ${res.status}: token không hợp lệ hoặc thiếu quyền (cần scope \`api\`). ` +
          `Nếu bạn đang dùng mật khẩu tài khoản: REST API không nhận mật khẩu — ` +
          `hãy lưu một Personal Access Token qua nút "Token GitLab" trong tab Git. ${detail}`,
      );
    }
    throw new Error(`GitLab API ${res.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Resolve the API token for a repo, throwing a clear error when unavailable.
 *
 * Order matters. A token saved explicitly for this host (gitlabTokens.ts) wins,
 * because it is known to be a Personal/Project Access Token — the only thing the
 * REST API accepts. The git credential helper is only a fallback: on an instance
 * that allows password auth for HTTPS git, what it stores is the account
 * password, which pushes fine but 401s here. Trying it anyway costs one cheap
 * local call and keeps setups that DID store a PAT working with no config.
 */
async function resolveToken(repo: string, ref: GitLabRepoRef): Promise<string> {
  const saved = await getToken(ref.host);
  if (saved) return saved;

  const fromGit = await tokenFromGitCredential(repo, ref.host);
  if (fromGit) return fromGit;

  throw new Error(
    `Chưa có token GitLab cho ${ref.host}. Tạo Personal Access Token (scope \`api\`) ` +
      `trên GitLab rồi lưu vào tab Git (nút "Token GitLab"). ` +
      `Lưu ý: mật khẩu tài khoản dùng để push/pull KHÔNG dùng được cho MR API.`,
  );
}

/**
 * List OPEN merge requests of a repo that target `targetBranch` (e.g. "dev"),
 * newest first. Reads the token from git credential and calls the GitLab API.
 */
export async function listOpenMergeRequests(
  repo: string,
  targetBranch: string,
): Promise<{ ref: GitLabRepoRef; mrs: MergeRequestSummary[] }> {
  const branch = (targetBranch || '').trim();
  if (!branch) throw new Error('target branch is required');
  const ref = await repoGitLabRef(repo);
  const token = await resolveToken(repo, ref);
  const qs = new URLSearchParams({
    state: 'opened',
    target_branch: branch,
    order_by: 'updated_at',
    sort: 'desc',
    per_page: '50',
  });
  const data = (await gitlabApi(ref, token, 'GET', `/merge_requests?${qs.toString()}`)) as GitLabMrJson[];
  const mrs = Array.isArray(data) ? data.map(toSummary) : [];
  return { ref, mrs };
}

export interface MergeOutcome {
  iid: number;
  state: string;
  mergeCommitSha?: string;
  webUrl: string;
}

/**
 * Merge one MR by iid via the GitLab MR merge API. Honours GitLab-side rules
 * (approvals, pipeline, conflicts) — a non-mergeable MR returns a 405/406 which
 * surfaces as a clear error. `removeSourceBranch` follows the MR's own setting.
 */
export async function mergeMergeRequest(repo: string, iid: number): Promise<MergeOutcome> {
  if (!Number.isInteger(iid) || iid < 1) throw new Error('invalid merge request iid');
  const ref = await repoGitLabRef(repo);
  const token = await resolveToken(repo, ref);
  const merged = (await gitlabApi(
    ref,
    token,
    'PUT',
    `/merge_requests/${iid}/merge`,
  )) as GitLabMrJson & { merge_commit_sha?: string };
  return {
    iid: merged.iid,
    state: merged.state || 'merged',
    mergeCommitSha: merged.merge_commit_sha,
    webUrl: merged.web_url,
  };
}
