// Client-side helpers + shared types for the Git workspace. All calls go to the
// same-origin /api/git route (server runs the actual git commands, local only).

export type FileGroup = 'staged' | 'unstaged' | 'untracked';

export interface ChangedFile {
  path: string;
  code: string;
  group: FileGroup;
  origPath?: string;
}

export interface RepoStatus {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  files: ChangedFile[];
}

export interface BranchInfo {
  current: string;
  branches: string[];
}

export interface RepoInfo {
  path: string;
  name: string;
}

export interface CommitLog {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  relDate: string;
  subject: string;
  refs: string;
}

export type RepoState =
  | 'clean'
  | 'dirty'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'no-upstream'
  | 'error';

export interface RepoOverview {
  name: string;
  path: string;
  branch: string;
  detached: boolean;
  state: RepoState;
  ahead: number;
  behind: number;
  changes: number;
  error?: string;
}

export type PullOutcome = 'pulled' | 'up-to-date' | 'skipped' | 'conflict' | 'error';

export interface PullResult {
  name: string;
  path: string;
  outcome: PullOutcome;
  message: string;
}

/** Result of the `clone` action — the new repo, ready to select. */
export interface CloneResult {
  path: string;
  name: string;
  output: string;
}

/** Result of the `discard-all` action — counts of what was thrown away. */
export interface DiscardAllResult {
  /** Tracked files reverted to HEAD (staged + unstaged). */
  reverted: number;
  /** Untracked files/folders deleted from disk. */
  removed: number;
  /** True when a rebase in progress was aborted too. */
  abortedRebase: boolean;
  status: RepoStatus;
}

/** Folder name a clone URL defaults to — mirrors the server's derivation so the
 *  form can prefill it without a round-trip. */
export function defaultCloneName(url: string): string {
  const trimmed = url.trim().replace(/[/\\]+$/, '');
  const last = trimmed.split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

export interface GitCapabilities {
  enabled: boolean;
  repos: RepoInfo[];
}

/** Result of the `review-mr` action — buffered output + process exit code. */
export interface ReviewMrResult {
  output: string;
  exitCode: number;
}

/** One open GitLab merge request (client-safe projection). */
export interface MergeRequestSummary {
  iid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  webUrl: string;
  mergeStatus: string;
  draft: boolean;
  hasConflicts: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Response of the `list-mrs` action. */
export interface ListMrsResult {
  targetBranch: string;
  project: string;
  baseUrl: string;
  mrs: MergeRequestSummary[];
}

/** Response of the `merge-mr` action. */
export interface MergeMrResult {
  iid: number;
  state: string;
  mergeCommitSha?: string;
  webUrl: string;
}

/** Redacted view of a stored GitLab API token — never carries the secret. */
export interface GitLabTokenStatus {
  host: string;
  /** Last 4 chars only, e.g. "…a1b2". */
  preview: string;
  savedAt: string;
}

/** Response of the `gitlab-token-status` action (host of the repo's origin). */
export interface GitLabTokenStatusResult {
  host: string;
  token: GitLabTokenStatus | null;
}

/** A configured Git project — a named root folder that holds sibling repos. */
export interface GitProject {
  id: string;
  name: string;
  root: string;
}

export interface GitProjectsResponse {
  enabled: boolean;
  /** True when the user has saved their own projects; false = auto fallback. */
  configured: boolean;
  /** Safe base every project root must live under (shown as UI hint). */
  base: string;
  projects: GitProject[];
}

/** GET the configured project list — never throws; returns disabled on any error. */
export async function fetchGitProjects(): Promise<GitProjectsResponse> {
  try {
    const r = await fetch('/api/git-projects');
    if (!r.ok) return { enabled: false, configured: false, base: '', projects: [] };
    return (await r.json()) as GitProjectsResponse;
  } catch {
    return { enabled: false, configured: false, base: '', projects: [] };
  }
}

// Folder browsing now lives in components/FolderPicker.tsx (shared by the Git
// workspace and ＋ Projects) and talks to /api/fs-browse.

/** POST/PUT/DELETE a project mutation. Throws Error(message) on non-2xx. */
export async function mutateGitProject(
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<GitProject[]> {
  const r = await fetch('/api/git-projects', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { projects: GitProject[] }).projects;
}

/** GET capability probe — never throws; returns disabled on any error. */
export async function fetchGitCapabilities(): Promise<GitCapabilities> {
  try {
    const r = await fetch('/api/git');
    if (!r.ok) return { enabled: false, repos: [] };
    return (await r.json()) as GitCapabilities;
  } catch {
    return { enabled: false, repos: [] };
  }
}

/** POST one git action. Throws Error(message) on a non-2xx (surfaces git stderr). */
export async function gitAction<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const r = await fetch('/api/git', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}

/** Short human label for a porcelain XY code. */
export function codeLabel(code: string): string {
  if (code === '??') return 'new';
  const x = code[0];
  const y = code[1];
  const c = x !== '.' && x !== '?' ? x : y; // prefer the meaningful side
  switch (c) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'conflict';
    default:
      return 'changed';
  }
}
