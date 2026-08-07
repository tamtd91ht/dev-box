// Server-only Git operations for the local SourceTree-style workspace.
//
// SECURITY MODEL — this module runs `git` on the machine hosting the Next.js
// server, so it is deliberately locked down:
//   1. Gated by GIT_TOOL_ENABLED — the API route 403s unless it is truthy. A
//      k8s/production deployment simply never sets it, so the feature is off
//      there and there is no way to reach these functions.
//   2. Every repo path is validated against an ALLOWLIST derived from the
//      configured Git root (auto-detected sibling repos + any explicitly
//      added). A request can only target a path that is in that list AND is a
//      real git working tree — never an arbitrary path from the request body.
//   3. Commands run via execFile('git', [argv]) — NEVER a shell string — so a
//      branch name / commit message / file path is passed as a distinct argv
//      element and can't be interpreted as a shell command.
//
// This is an internal, locally-run developer tool; it is not meant to be
// exposed to any network beyond the developer's own machine.

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export const GIT_ENABLED = /^(1|true|yes|on)$/i.test(process.env.GIT_TOOL_ENABLED ?? '');

/** Root under which sibling repos are auto-detected. Defaults to the workspace
 *  workspace that contains this repo (two levels up from cwd's repo). Override
 *  with GIT_TOOL_ROOT (absolute path). */
const GIT_ROOT = process.env.GIT_TOOL_ROOT
  ? path.resolve(process.env.GIT_TOOL_ROOT)
  : path.resolve(process.cwd(), '..');

const MAX_BUFFER = 16 * 1024 * 1024; // 16 MB — diffs can be large
const GIT_TIMEOUT_MS = 30_000;
/** Cloning pulls the whole history over the network — minutes, not seconds. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

export interface RepoInfo {
  /** Absolute path to the repo working tree. */
  path: string;
  /** Basename, used as the display label. */
  name: string;
}

interface GitOpts {
  /** Override the default 30 s timeout (clone needs much more). */
  timeoutMs?: number;
  /** Extra environment for this call only (merged over process.env). */
  env?: Record<string, string>;
  /** Resolve with stderr appended — git writes progress there (clone, fetch). */
  withStderr?: boolean;
}

/** Run a git subcommand in `cwd`. Rejects with a trimmed stderr on non-zero exit. */
function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        windowsHide: true,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || (err as Error).message || '').toString().trim();
          reject(new Error(msg || 'git command failed'));
          return;
        }
        resolve(opts.withStderr ? stdout.toString() + stderr.toString() : stdout.toString());
      },
    );
  });
}

/**
 * Update remote-tracking refs from the remote without touching the working tree
 * (`git fetch --prune`). This is what makes the `behind` count reflect the real
 * server state — `git status` alone only compares HEAD against the LOCAL copy of
 * `origin/*`, so without a fetch a push made elsewhere stays invisible. Best
 * effort: resolves true on success, false when it fails (offline, no remote) so
 * callers can still fall back to a local-only status read. */
async function fetchRepo(repo: string): Promise<boolean> {
  try {
    await git(repo, ['fetch', '--prune']);
    return true;
  } catch {
    return false;
  }
}

/** True when `dir` is the top level of a git working tree. */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * The repo's `origin` remote URL, or null when it has none (a repo created with
 * `git init` and never pushed). Never throws — callers treat "no remote" as data,
 * not an error.
 */
export async function remoteUrl(repo: string): Promise<string | null> {
  try {
    const out = await git(repo, ['remote', 'get-url', 'origin']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Auto-detect immediate sibling directories under `root` that are git repos.
 *  Defaults to the legacy GIT_ROOT so callers that don't pass a root keep working. */
export async function detectRepos(root: string = GIT_ROOT): Promise<RepoInfo[]> {
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const repos: RepoInfo[] = [];
  for (const name of entries.sort()) {
    const full = path.join(root, name);
    // Fast pre-check: a .git entry (dir or file for worktrees/submodules).
    try {
      await fs.access(path.join(full, '.git'));
    } catch {
      continue;
    }
    if (await isGitRepo(full)) repos.push({ path: full, name });
  }
  return repos;
}

/**
 * Resolve + authorize a requested repo path. Returns the canonical absolute path
 * when it is inside one of the `allowedRoots` AND is a real git repo; throws
 * otherwise. This is the single gate every mutating/reading operation passes
 * through — never trust a raw path from the client. Defaults to the legacy
 * single GIT_ROOT when no roots are supplied.
 */
export async function authorizeRepo(requested: string, allowedRoots: string[] = [GIT_ROOT]): Promise<string> {
  if (!requested || typeof requested !== 'string') throw new Error('repo path required');
  const resolved = path.resolve(requested);
  const roots = (allowedRoots.length ? allowedRoots : [GIT_ROOT]).map((r) => path.resolve(r));
  const inSomeRoot = roots.some((root) => {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    return resolved === root || resolved.startsWith(rootWithSep);
  });
  // Must live directly under (or at) one configured root — blocks traversal.
  if (!inSomeRoot) {
    throw new Error('repo path is outside the allowed Git root(s)');
  }
  if (!(await isGitRepo(resolved))) throw new Error('not a git repository');
  return resolved;
}

// ── Clone ─────────────────────────────────────────────────────────────────────

export interface CloneResult {
  /** Absolute path of the freshly cloned working tree. */
  path: string;
  /** Folder name it was cloned into (the new repo's display label). */
  name: string;
  /** git's own output — it reports the clone on stderr, so both streams are merged. */
  output: string;
}

/**
 * Remote URLs we accept: http(s)://, ssh://, git:// and the scp-style
 * `git@host:group/repo.git`. A local path is deliberately NOT accepted — the only
 * reason to clone in this tool is to bring a remote repo down, and allowing
 * arbitrary local paths would turn the clone action into a file-read primitive.
 */
const REMOTE_URL_RE =
  /^(?:https?:\/\/|ssh:\/\/|git:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:)[^\s]+$/;

/** Validate a user-supplied clone URL. Throws with a human message when unusable. */
export function validateCloneUrl(raw: unknown): string {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) throw new Error('URL repo là bắt buộc');
  // A leading dash would be parsed as a flag by git.
  if (url.startsWith('-')) throw new Error('URL không hợp lệ');
  // `ext::<command>` makes git run an arbitrary command as its transport.
  if (/ext::/i.test(url)) throw new Error('transport ext:: không được phép');
  if (!REMOTE_URL_RE.test(url)) {
    throw new Error('URL phải là https://, ssh://, git:// hoặc git@host:group/repo.git');
  }
  return url;
}

/** Folder name a URL would clone into: last path segment minus a `.git` suffix. */
export function defaultCloneName(url: string): string {
  const trimmed = url.trim().replace(/[/\\]+$/, '');
  const last = trimmed.split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

/**
 * Validate the target folder name: a single path segment, so the clone can only
 * ever land directly inside the project root (no traversal, no absolute path).
 */
export function validateCloneName(requested: unknown, url: string): string {
  const explicit = typeof requested === 'string' ? requested.trim() : '';
  const name = explicit || defaultCloneName(url);
  if (!name) throw new Error('không suy ra được tên thư mục từ URL — hãy nhập tên');
  if (name !== path.basename(name) || /[/\\]/.test(name) || name === '.' || name === '..') {
    throw new Error('tên thư mục phải là một tên đơn (không chứa / hay \\)');
  }
  if (name.startsWith('-') || name.startsWith('.')) throw new Error('tên thư mục không hợp lệ');
  return name;
}

/** Validate an optional branch to clone (`--branch`). Empty → clone the default. */
function validateCloneBranch(raw: unknown): string {
  const branch = typeof raw === 'string' ? raw.trim() : '';
  if (!branch) return '';
  if (branch.startsWith('-') || /[\s~^:?*[\]\\]/.test(branch)) throw new Error('tên branch không hợp lệ');
  return branch;
}

/**
 * Clone `url` into a NEW folder directly under `root` (a configured project root),
 * so the result is auto-detected as one of that project's repos.
 *
 * Safety: the URL/name/branch are validated above and passed as separate argv
 * elements after `--`; `protocol.ext.allow=never` blocks the ext:: transport even
 * if a redirect tries to reach it; GIT_TERMINAL_PROMPT=0 makes a private repo
 * without a stored credential fail fast instead of hanging on a hidden prompt.
 */
export async function cloneRepo(
  root: string,
  urlRaw: unknown,
  nameRaw: unknown,
  branchRaw?: unknown,
): Promise<CloneResult> {
  const url = validateCloneUrl(urlRaw);
  const name = validateCloneName(nameRaw, url);
  const branch = validateCloneBranch(branchRaw);

  const rootAbs = path.resolve(root);
  try {
    const st = await fs.stat(rootAbs);
    if (!st.isDirectory()) throw new Error('not a dir');
  } catch {
    throw new Error(`thư mục gốc của project không tồn tại: ${rootAbs}`);
  }

  const target = path.join(rootAbs, name);
  try {
    await fs.access(target);
    throw new Error(`"${name}" đã tồn tại trong ${rootAbs} — chọn tên khác`);
  } catch (e) {
    // ENOENT is what we want; anything else (incl. the throw above) propagates.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // No --progress: without a TTY that would return tens of KB of carriage-return
  // spam. stderr still carries the useful lines ("Cloning into …", branch info).
  const args = ['-c', 'protocol.ext.allow=never', 'clone'];
  if (branch) args.push('--branch', branch);
  args.push('--', url, target);

  let output: string;
  try {
    output = await git(rootAbs, args, {
      timeoutMs: CLONE_TIMEOUT_MS,
      withStderr: true,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (e) {
    const msg = (e as Error).message || 'clone failed';
    if (/could not read Username|terminal prompts disabled|Authentication failed/i.test(msg)) {
      throw new Error(
        'clone thất bại: cần đăng nhập. Lưu credential trước (vd: clone tay một lần bằng git CLI) rồi thử lại.',
      );
    }
    throw new Error(msg.split('\n').slice(0, 3).join('\n'));
  }

  if (!(await isGitRepo(target))) throw new Error('clone xong nhưng không phải git repo?');
  return { path: target, name, output: output.trim() };
}

// ── Status ────────────────────────────────────────────────────────────────────

export type FileGroup = 'staged' | 'unstaged' | 'untracked';

export interface ChangedFile {
  path: string;
  /** Two-letter XY code from porcelain v2 (e.g. "M.", ".M", "A."). */
  code: string;
  group: FileGroup;
  /** For renames/copies — the original path. */
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

/** Map a porcelain-v2 XY pair into human file groups. Untracked/ignored handled
 *  separately by their line prefix. */
function classify(x: string, y: string): { staged: boolean; unstaged: boolean } {
  return { staged: x !== '.' && x !== '?', unstaged: y !== '.' };
}

export async function status(repo: string): Promise<RepoStatus> {
  const out = await git(repo, ['status', '--porcelain=v2', '--branch']);
  const res: RepoStatus = {
    branch: '',
    ahead: 0,
    behind: 0,
    detached: false,
    files: [],
  };
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      res.branch = head;
      res.detached = head === '(detached)';
    } else if (line.startsWith('# branch.upstream ')) {
      res.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        res.ahead = parseInt(m[1], 10);
        res.behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Ordinary (1) or rename/copy (2) change.
      const parts = line.split(' ');
      const xy = parts[1]; // e.g. "M." / ".M" / "A."
      const x = xy[0];
      const y = xy[1];
      const { staged, unstaged } = classify(x, y);
      if (line.startsWith('2 ')) {
        // Rename: "2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>"
        const tab = line.indexOf('\t');
        const pathPart = line.slice(0, tab).split(' ').slice(9).join(' ');
        const origPath = line.slice(tab + 1);
        if (staged) res.files.push({ path: pathPart, code: xy, group: 'staged', origPath });
        if (unstaged) res.files.push({ path: pathPart, code: xy, group: 'unstaged', origPath });
      } else {
        const pathPart = parts.slice(8).join(' ');
        if (staged) res.files.push({ path: pathPart, code: xy, group: 'staged' });
        if (unstaged) res.files.push({ path: pathPart, code: xy, group: 'unstaged' });
      }
    } else if (line.startsWith('? ')) {
      res.files.push({ path: line.slice(2), code: '??', group: 'untracked' });
    }
    // "u " (unmerged/conflict) lines are surfaced as unstaged for visibility.
    else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      res.files.push({ path: parts.slice(10).join(' '), code: parts[1], group: 'unstaged' });
    }
  }
  return res;
}

// ── Branches ────────────────────────────────────────────────────────────────

export interface BranchInfo {
  current: string;
  branches: string[];
}

export async function branches(repo: string): Promise<BranchInfo> {
  const out = await git(repo, [
    'branch',
    '--list',
    '--format=%(HEAD)%(refname:short)',
  ]);
  const branchList: string[] = [];
  let current = '';
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const isCurrent = line.startsWith('*');
    const name = line.slice(1).trim();
    branchList.push(name);
    if (isCurrent) current = name;
  }
  return { current, branches: branchList };
}

// ── Multi-repo overview (status check + pull all) ───────────────────────────────

export type RepoState =
  | 'clean' // no local changes, in sync with upstream
  | 'dirty' // uncommitted local changes (working tree not clean)
  | 'ahead' // local commits not pushed
  | 'behind' // remote commits not pulled
  | 'diverged' // both ahead and behind
  | 'no-upstream' // branch has no tracking remote
  | 'error'; // status could not be read

export interface RepoOverview {
  name: string;
  path: string;
  branch: string;
  detached: boolean;
  state: RepoState;
  ahead: number;
  behind: number;
  /** Number of changed files in the working tree (staged + unstaged + untracked). */
  changes: number;
  error?: string;
}

/** Derive a single high-level state from a RepoStatus. Precedence: dirty first
 *  (local work is the most actionable), then remote divergence, then clean. */
function deriveState(st: RepoStatus): RepoState {
  if (st.files.length > 0) return 'dirty';
  if (!st.upstream && !st.detached) return 'no-upstream';
  if (st.ahead > 0 && st.behind > 0) return 'diverged';
  if (st.behind > 0) return 'behind';
  if (st.ahead > 0) return 'ahead';
  return 'clean';
}

/** Status of every detected repo under `root`, run concurrently. Fetches each
 *  repo first so `ahead`/`behind` reflect the real remote (a fetch failure is
 *  swallowed — status is still read from local). Never throws — a repo that
 *  fails is reported with state 'error'. */
export async function statusAll(root: string = GIT_ROOT): Promise<RepoOverview[]> {
  const repos = await detectRepos(root);
  return Promise.all(
    repos.map(async (r): Promise<RepoOverview> => {
      try {
        await fetchRepo(r.path);
        const st = await status(r.path);
        return {
          name: r.name,
          path: r.path,
          branch: st.branch,
          detached: st.detached,
          state: deriveState(st),
          ahead: st.ahead,
          behind: st.behind,
          changes: st.files.length,
        };
      } catch (e) {
        return {
          name: r.name,
          path: r.path,
          branch: '',
          detached: false,
          state: 'error',
          ahead: 0,
          behind: 0,
          changes: 0,
          error: (e as Error).message,
        };
      }
    }),
  );
}

export type PullOutcome = 'pulled' | 'up-to-date' | 'skipped' | 'conflict' | 'error';

export interface PullResult {
  name: string;
  path: string;
  outcome: PullOutcome;
  message: string;
}

/**
 * Pull every detected repo with --ff-only, concurrently. A repo is SKIPPED (not
 * pulled) when it has local uncommitted changes or no upstream — pulling those
 * risks a mess. When a fast-forward is impossible (history diverged), the pull
 * fails and is reported as 'conflict' so the caller can flag it. Never throws.
 */
export async function pullAll(root: string = GIT_ROOT): Promise<PullResult[]> {
  const repos = await detectRepos(root);
  return Promise.all(
    repos.map(async (r): Promise<PullResult> => {
      try {
        // Fetch first so `behind` reflects the remote — otherwise a repo with
        // unpulled server commits looks "up-to-date" (behind === 0) and is skipped.
        await fetchRepo(r.path);
        const st = await status(r.path);
        // A repo sitting mid-merge/rebase (unmerged entries: UU, AA, DD, …) IS
        // the conflict case — report it as such, not as a generic "dirty" skip.
        if (st.files.some((f) => f.code.includes('U') || f.code === 'AA' || f.code === 'DD')) {
          return { name: r.name, path: r.path, outcome: 'conflict', message: 'đang có conflict chưa xử lý' };
        }
        if (st.files.length > 0) {
          return { name: r.name, path: r.path, outcome: 'skipped', message: 'có thay đổi chưa commit' };
        }
        if (st.detached) {
          return { name: r.name, path: r.path, outcome: 'skipped', message: 'detached HEAD' };
        }
        if (!st.upstream) {
          return { name: r.name, path: r.path, outcome: 'skipped', message: 'chưa có upstream' };
        }
        if (st.behind === 0) {
          return { name: r.name, path: r.path, outcome: 'up-to-date', message: 'đã mới nhất' };
        }
        const out = await pull(r.path);
        return { name: r.name, path: r.path, outcome: 'pulled', message: out.trim().split('\n')[0] || `+${st.behind}` };
      } catch (e) {
        const msg = (e as Error).message || 'pull failed';
        // A non-fast-forward is the "conflict" case worth surfacing distinctly.
        const conflict = /non-fast-forward|not possible to fast-forward|diverge|would be overwritten|conflict/i.test(msg);
        return {
          name: r.name,
          path: r.path,
          outcome: conflict ? 'conflict' : 'error',
          // stderr của git mở đầu bằng dòng "hint: …" vô nghĩa với người đọc —
          // conflict thì nói thẳng bằng lời người.
          message: conflict ? 'lịch sử phân nhánh với remote — cần merge/rebase thủ công' : msg.split('\n')[0],
        };
      }
    }),
  );
}

// ── Log / history ─────────────────────────────────────────────────────────────

export interface CommitLog {
  hash: string;
  /** First 7 chars of hash. */
  shortHash: string;
  author: string;
  /** Author date, ISO-8601 strict. */
  date: string;
  /** Relative date, e.g. "2 hours ago". */
  relDate: string;
  subject: string;
  /** Ref decorations (branch/tag names) attached to this commit, if any. */
  refs: string;
}

// Field separator = US (0x1f), record separator = RS (0x1e). Neither can appear
// in commit metadata, so parsing is unambiguous without shell-quoting concerns.
const LOG_FMT = ['%H', '%an', '%aI', '%ar', '%s', '%D'].join('%x1f') + '%x1e';

/** Most-recent commits on the current HEAD (newest first). */
export async function log(repo: string, limit = 30): Promise<CommitLog[]> {
  const n = Math.min(Math.max(1, Math.floor(limit) || 30), 200);
  const out = await git(repo, ['log', `--max-count=${n}`, '--no-color', `--pretty=format:${LOG_FMT}`]);
  const commits: CommitLog[] = [];
  for (const record of out.split('\x1e')) {
    const rec = record.replace(/^\n/, '');
    if (!rec.trim()) continue;
    const [hash, author, date, relDate, subject, refs] = rec.split('\x1f');
    if (!hash) continue;
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      author: author ?? '',
      date: date ?? '',
      relDate: relDate ?? '',
      subject: subject ?? '',
      refs: (refs ?? '').trim(),
    });
  }
  return commits;
}

// ── Diff ────────────────────────────────────────────────────────────────────

/** Unified diff for one file. `staged` → diff of the index vs HEAD; else the
 *  working-tree vs index. Untracked files have no diff — the caller shows the raw
 *  content note instead. */
export async function diffFile(repo: string, file: string, staged: boolean): Promise<string> {
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  args.push('--', file);
  return git(repo, args);
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function stage(repo: string, files: string[]): Promise<void> {
  if (!files.length) return;
  await git(repo, ['add', '--', ...files]);
}

export async function unstage(repo: string, files: string[]): Promise<void> {
  if (!files.length) return;
  // restore --staged is the modern reset-of-the-index; works on git 2.23+.
  await git(repo, ['restore', '--staged', '--', ...files]);
}

/** Discard working-tree changes for tracked files (does NOT delete untracked). */
export async function discard(repo: string, files: string[]): Promise<void> {
  if (!files.length) return;
  await git(repo, ['checkout', '--', ...files]);
}

/**
 * Fully discard staged files: drop them from the index AND revert the working
 * tree to HEAD. `restore --staged --worktree` does both in one call (git 2.23+),
 * so a file that was `git add`-ed goes back to its committed content.
 */
export async function discardStaged(repo: string, files: string[]): Promise<void> {
  if (!files.length) return;
  await git(repo, ['restore', '--staged', '--worktree', '--', ...files]);
}

/**
 * Delete untracked files from disk (`git clean -f`). `-d` also removes newly
 * created untracked directories. This is irreversible — the files are not in
 * git, so there is nothing to restore them from. The `--` guards every path as
 * a literal argument, and each path is still confined to the authorized repo.
 */
export async function clean(repo: string, files: string[]): Promise<void> {
  if (!files.length) return;
  await git(repo, ['clean', '-f', '-d', '--', ...files]);
}

export interface DiscardAllResult {
  /** Files brought back to HEAD (tracked — staged + unstaged, deleted included). */
  reverted: number;
  /** Untracked files/folders deleted from disk. */
  removed: number;
  /** True when an in-progress rebase was aborted as part of the reset. */
  abortedRebase: boolean;
}

/** True when the repo has at least one commit (a fresh `git init` has no HEAD). */
async function hasHead(repo: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw away EVERY local change in the repo, in one shot — the SourceTree
 * "Discard all" / `git reset --hard && git clean -fd`:
 *   1. an in-progress rebase is aborted first (`reset --hard` alone would leave
 *      the repo mid-rebase; a merge/`MERGE_HEAD` IS cleared by reset),
 *   2. index + working tree go back to HEAD (staged and unstaged alike),
 *   3. untracked files and newly created folders are deleted from disk.
 *
 * `clean` runs WITHOUT `-x`, so gitignored files (node_modules, .env, build
 * output) are deliberately kept — only files git would otherwise report as
 * untracked go away. Irreversible: nothing here is recoverable from git.
 */
export async function discardAll(repo: string): Promise<DiscardAllResult> {
  const before = await status(repo);
  const tracked = new Set(before.files.filter((f) => f.group !== 'untracked').map((f) => f.path));
  const untracked = before.files.filter((f) => f.group === 'untracked').length;

  // Abort a rebase in progress (its state dir lives in the real git dir, which
  // may be elsewhere for worktrees — ask git for it instead of assuming .git).
  let abortedRebase = false;
  const gitDir = path.resolve(repo, (await git(repo, ['rev-parse', '--git-dir'])).trim());
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      await fs.access(path.join(gitDir, dir));
    } catch {
      continue;
    }
    try {
      await git(repo, ['rebase', '--abort']);
      abortedRebase = true;
    } catch {
      /* best effort — the reset below still cleans the tree */
    }
    break;
  }

  if (await hasHead(repo)) {
    await git(repo, ['reset', '--hard', 'HEAD']);
  } else {
    // No commit yet → there is no HEAD to reset to. Empty the index so every
    // added file becomes untracked, then let `clean` remove it.
    await git(repo, ['read-tree', '--empty']);
  }
  await git(repo, ['clean', '-f', '-d']);

  return { reverted: tracked.size, removed: untracked, abortedRebase };
}

export async function commit(repo: string, message: string): Promise<string> {
  const msg = (message || '').trim();
  if (!msg) throw new Error('commit message required');
  return git(repo, ['commit', '-m', msg]);
}

export async function checkout(repo: string, branch: string, create: boolean): Promise<string> {
  const name = (branch || '').trim();
  if (!name) throw new Error('branch name required');
  // A leading dash could be read as a flag → refuse it defensively.
  if (name.startsWith('-')) throw new Error('invalid branch name');
  return create ? git(repo, ['checkout', '-b', name]) : git(repo, ['checkout', name]);
}

export async function pull(repo: string): Promise<string> {
  // --ff-only: never create a merge commit or leave a conflict in the tool.
  return git(repo, ['pull', '--ff-only']);
}

export async function push(repo: string): Promise<string> {
  const st = await status(repo);
  // No upstream yet → set it on push so the first push of a new branch works.
  if (!st.upstream && st.branch && !st.detached) {
    return git(repo, ['push', '-u', 'origin', st.branch]);
  }
  return git(repo, ['push']);
}
