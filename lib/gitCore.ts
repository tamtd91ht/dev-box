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
 * True khi `dir` là GỐC của working tree, không phải một thư mục con nằm trong
 * repo. `--is-inside-work-tree` trả true cho cả `repo/src/lib`, nên nó KHÔNG
 * dùng được cho câu hỏi "root của project có phải chính là một repo không":
 * trỏ project vào `omicx/some-service/src` sẽ đỗ, rồi mọi lệnh git sau đó chạy
 * trên repo cha với đường dẫn hiển thị sai. `--show-toplevel` trả về gốc thật,
 * so lại với `dir` mới kết luận được.
 *
 * So sánh sau khi resolve + hạ chữ thường trên Windows: git in ra `E:/vihat/...`
 * (forward slash) còn `dir` là `E:\vihat\...`, và ổ đĩa có thể khác hoa/thường.
 */
async function isRepoRoot(dir: string): Promise<boolean> {
  let top: string;
  try {
    top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return false;
  }
  if (!top) return false;
  const norm = (v: string) => {
    const abs = path.resolve(v);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  return norm(top) === norm(dir);
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

/**
 * True khi bản thân `root` là gốc của một repo — tức project được trỏ THẲNG vào
 * một repo chứ không phải vào thư mục chứa nhiều repo. Xem detectRepos.
 */
export async function isSelfRepo(root: string = GIT_ROOT): Promise<boolean> {
  try {
    await fs.access(path.join(path.resolve(root), '.git'));
  } catch {
    return false;
  }
  return isRepoRoot(path.resolve(root));
}

/**
 * Auto-detect immediate sibling directories under `root` that are git repos.
 * Defaults to the legacy GIT_ROOT so callers that don't pass a root keep working.
 *
 * PROJECT LÀ CHÍNH MỘT REPO — nhiều project không phải "thư mục chứa nhiều repo"
 * mà bản thân nó là một repo duy nhất (một mono-repo, hay một service lẻ). Trước
 * đây trỏ project vào đó là tab Git trắng trơn: hàm này chỉ quét con trực tiếp,
 * và một repo không chứa repo con nào cả.
 *
 * Cách xử lý: trả về đúng MỘT entry trỏ vào chính root. Nhờ vậy toàn bộ phần còn
 * lại của tool (dropdown repo, status-all, pull-all, manifest, authorizeRepo —
 * đã cho phép `resolved === root`) không cần biết đến ca này, project hiện ra y
 * như một project có duy nhất một repo con.
 *
 * Trường hợp lai (root là repo VÀ có repo con bên trong, vd submodule đã init)
 * ưu tiên coi root là repo và bỏ qua con: người trỏ project vào một repo là muốn
 * làm việc với repo đó, còn submodule có vòng đời riêng do repo cha quản lý —
 * hiện chúng ra thành repo ngang hàng chỉ dẫn tới commit/push lẫn nhau.
 */
export async function detectRepos(root: string = GIT_ROOT): Promise<RepoInfo[]> {
  const rootAbs = path.resolve(root);
  if (await isSelfRepo(rootAbs)) {
    return [{ path: rootAbs, name: path.basename(rootAbs) || rootAbs }];
  }
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
  /** Remote-tracking branches (e.g. "origin/dev"), minus the symbolic origin/HEAD.
   *  Lets the user merge a branch that exists on the server but not locally. */
  remotes: string[];
  /** True when the repo is sitting in an unfinished merge (MERGE_HEAD exists) —
   *  the UI shows "resolve conflicts / abort" instead of offering a new merge. */
  merging: boolean;
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

  // Remote-tracking refs. `origin/HEAD` is a symbolic alias for the default
  // branch, not a branch to merge — drop it.
  let remotes: string[] = [];
  try {
    const rout = await git(repo, ['branch', '--remotes', '--format=%(refname:short)']);
    remotes = rout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/\/HEAD$/.test(l) && !l.includes(' -> '));
  } catch {
    /* no remotes configured — leave empty */
  }

  return { current, branches: branchList, remotes, merging: await isMerging(repo) };
}

/** True when a merge is in progress (MERGE_HEAD present in the real git dir). */
async function isMerging(repo: string): Promise<boolean> {
  try {
    const gitDir = path.resolve(repo, (await git(repo, ['rev-parse', '--git-dir'])).trim());
    await fs.access(path.join(gitDir, 'MERGE_HEAD'));
    return true;
  } catch {
    return false;
  }
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

/** One file touched by a commit, with its churn — the history view's file list. */
export interface CommitFile {
  /** Path AFTER the commit (the new name, for a rename). */
  path: string;
  /** Path BEFORE, only when git detected a rename/copy. */
  oldPath?: string;
  /** A=thêm, M=sửa, D=xoá, R=đổi tên, C=chép, T=đổi kiểu. */
  status: string;
  /** Số dòng thêm/bớt. `null` cho file nhị phân — git in "-" chứ không phải số. */
  added: number | null;
  removed: number | null;
}

/** A commit's message body plus the files it touched. */
export interface CommitDetail extends CommitLog {
  /** Full message minus the subject line, trimmed. Empty for one-line commits. */
  body: string;
  files: CommitFile[];
  /** Commit này có nhiều cha (merge) không — diff của nó cần chọn phía so sánh. */
  merge: boolean;
}

/**
 * Chỉ nhận SHA thật (hex 4–40 ký tự).
 *
 * git() dùng execFile nên không có shell để inject, nhưng một chuỗi mở đầu bằng
 * `-` vẫn bị chính git đọc thành flag (`--output=…` ghi đè file chẳng hạn). Chặn
 * ở cửa vào rẻ hơn nhiều so với rà từng chỗ nối tham số, và người dùng không bao
 * giờ gõ tay giá trị này — nó luôn đến từ danh sách log ta vừa in ra.
 */
function assertHash(hash: string): string {
  const h = hash.trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(h)) throw new Error('commit hash không hợp lệ');
  return h;
}

/**
 * Metadata + danh sách file của MỘT commit.
 *
 * Ba lần gọi git chứ không một, vì mỗi thứ chỉ một nguồn nói đúng được:
 *
 *   · `--numstat`     → số dòng thêm/bớt, nhưng KHÔNG phân biệt nổi thêm/xoá/sửa
 *                       ("0 1 f" có thể là xoá file, cũng có thể là sửa bớt 1 dòng)
 *   · `--name-status` → đúng chữ cái A/M/D/R, nhưng không có số dòng
 *
 * Gộp hai cờ vào một lệnh KHÔNG được: git chỉ nghe cờ cuối cùng và lặng lẽ bỏ
 * cờ kia, nên ta mất một nửa dữ liệu mà không có lỗi nào báo. Ghép theo THỨ TỰ
 * (cả hai liệt kê cùng một tập file, cùng thứ tự) thay vì theo tên — tên file
 * là thứ duy nhất có thể trùng lặp hoặc kỳ dị, thứ tự thì không.
 *
 * `-z` cho chuỗi phân tách bằng NUL: tên file có dấu cách hay tiếng Việt không
 * bị git bọc trong dấu nháy, khỏi phải viết bộ gỡ quote.
 *
 * Với commit MERGE, git mặc định không in file nào (diff so với nhiều cha là mơ
 * hồ). `-m --first-parent` bảo nó so với cha thứ nhất — tức "merge này mang gì
 * vào nhánh đích", đúng câu người xem lịch sử muốn hỏi.
 */
export async function commitDetail(repo: string, hash: string): Promise<CommitDetail> {
  const h = assertHash(hash);
  const FMT = ['%H', '%an', '%aI', '%ar', '%s', '%D', '%P', '%b'].join('%x1f');
  const SHOW = ['show', '--no-color', '--first-parent', '-m', '-z'];

  const [meta, numstat, nameStatus] = await Promise.all([
    git(repo, ['show', '--no-color', '--no-patch', `--format=${FMT}`, h]),
    git(repo, [...SHOW, '--numstat', '--format=', h]),
    git(repo, [...SHOW, '--name-status', '--format=', h]),
  ]);

  const [hash2, author, date, relDate, subject, refs, parents, body] = meta.split('\x1f');
  return {
    hash: hash2 || h,
    shortHash: (hash2 || h).slice(0, 7),
    author: author ?? '',
    date: date ?? '',
    relDate: relDate ?? '',
    subject: subject ?? '',
    refs: (refs ?? '').trim(),
    // %b là phần thân, đã không gồm subject. Lệnh này không kèm patch nên phần
    // đuôi chỉ có thể là thân commit — cắt \0 thừa của -z là đủ.
    body: (body ?? '').replace(/\0/g, '').trim(),
    merge: (parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1,
    files: mergeFileLists(parseNumstatZ(numstat), parseNameStatusZ(nameStatus)),
  };
}

/** Một bản ghi `-z --numstat`: "thêm\tbớt\t" rồi 1 path (hoặc 2 khi đổi tên). */
function parseNumstatZ(out: string): { added: number | null; removed: number | null; path: string }[] {
  const parts = out.split('\0');
  const rows: { added: number | null; removed: number | null; path: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    const [, a, r, inline] = m;
    // Đổi tên: path để trống ở trường này, tên cũ và tên mới nằm ở 2 trường sau.
    const path = inline || parts[i + 2] || parts[i + 1] || '';
    if (!inline) i += 2;
    rows.push({ added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r), path });
  }
  return rows;
}

/** Một bản ghi `-z --name-status`: "A" rồi 1 path; "R100" rồi tên cũ + tên mới. */
function parseNameStatusZ(out: string): { status: string; path: string; oldPath?: string }[] {
  const parts = out.split('\0').filter((s) => s !== '');
  const rows: { status: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!/^[A-Z]\d*$/.test(code)) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      rows.push({ status: letter, oldPath: parts[i + 1] ?? '', path: parts[i + 2] ?? '' });
      i += 2;
    } else {
      rows.push({ status: letter, path: parts[i + 1] ?? '' });
      i += 1;
    }
  }
  return rows;
}

/**
 * Ghép churn (numstat) vào trạng thái (name-status) theo thứ tự.
 *
 * name-status là bản CHÍNH: nó quyết định có bao nhiêu file và mỗi file là gì.
 * Thiếu numstat tương ứng (không nên xảy ra, nhưng git đổi format thì ta không
 * gãy) → churn để null, UI hiện "—" thay vì bịa số 0.
 */
function mergeFileLists(
  churn: { added: number | null; removed: number | null; path: string }[],
  status: { status: string; path: string; oldPath?: string }[],
): CommitFile[] {
  return status.map((s, i) => {
    const c = churn[i]?.path === s.path ? churn[i] : churn.find((x) => x.path === s.path) ?? churn[i];
    return {
      path: s.path,
      ...(s.oldPath ? { oldPath: s.oldPath } : {}),
      status: s.status,
      added: c?.added ?? null,
      removed: c?.removed ?? null,
    };
  });
}

/**
 * Diff của MỘT file trong MỘT commit (so với cha thứ nhất).
 *
 * Tách khỏi commitDetail() có chủ đích: một commit đụng 200 file thì gửi kèm
 * toàn bộ patch là vài MB cho một lần bấm, trong khi người xem hầu như chỉ mở
 * vài file. Danh sách file tải trước, patch tải khi bấm — giống hệt cách tab
 * "Thay đổi" đang làm với working tree.
 */
export async function commitFileDiff(repo: string, hash: string, file: string): Promise<string> {
  const h = assertHash(hash);
  // `--` ngăn git hiểu tên file thành ref khi trùng tên nhánh.
  return git(repo, ['show', '--no-color', '--first-parent', '-m', '--format=', h, '--', file]);
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

/** The two sides of a file for the side-by-side viewer. */
export interface FileVersions {
  /** Content BEFORE the change. */
  before: string;
  /** Content AFTER the change. */
  after: string;
  /** Where each side came from, for the panel headers. */
  beforeLabel: string;
  afterLabel: string;
  /** True when either side isn't valid UTF-8 text — the UI shows a note instead. */
  binary: boolean;
  /** Set when a side could not be read at all (e.g. file deleted on disk). */
  note?: string;
}

/** NUL byte ⇒ treat as binary; git itself uses the same heuristic. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Read one blob out of git (`git show <rev>:<file>`) as a Buffer. Returns null
 * when the path doesn't exist at that revision — a NEW file has no HEAD side,
 * and that is a normal outcome, not an error.
 */
function showBlob(repo: string, rev: string, file: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['show', `${rev}:${file}`],
      { cwd: repo, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr?.toString() || (err as Error).message || '').trim();
          // "exists on disk, but not in" / "does not exist" ⇒ absent at that rev.
          if (/does not exist|exists on disk|unknown revision|invalid object name/i.test(msg)) {
            resolve(null);
            return;
          }
          reject(new Error(msg || 'git show failed'));
          return;
        }
        resolve(stdout as unknown as Buffer);
      },
    );
  });
}

/**
 * The before/after contents of one file, for the side-by-side viewer.
 *
 *   staged=true  → HEAD  vs the index      (what `git diff --cached` compares)
 *   staged=false → index vs the working tree (what `git diff` compares)
 *
 * The index side is read as `:file` — the same revision syntax git uses for a
 * staged blob — so a partially-staged file shows the right middle state. When
 * the file is untracked there is no index entry and `before` is simply empty.
 */
export async function fileVersions(repo: string, file: string, staged: boolean): Promise<FileVersions> {
  const beforeRev = staged ? 'HEAD' : ':0';
  const beforeLabel = staged ? 'HEAD (đã commit)' : 'Index (đã stage / HEAD)';
  const afterLabel = staged ? 'Index (đã stage)' : 'Working tree (trên đĩa)';

  const beforeBuf = await showBlob(repo, beforeRev, file);

  let afterBuf: Buffer | null = null;
  let note: string | undefined;
  if (staged) {
    afterBuf = await showBlob(repo, ':0', file);
    if (!afterBuf) note = 'File không có trong index (đã stage xóa).';
  } else {
    // Working tree: read straight off disk. The path is confined to the
    // authorized repo by resolve+prefix check, same guard as everywhere else.
    const abs = path.resolve(repo, file);
    const root = path.resolve(repo);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path escapes repo');
    try {
      afterBuf = await fs.readFile(abs);
    } catch {
      afterBuf = null;
      note = 'File không còn trên đĩa (đã xóa).';
    }
  }

  const binary = (!!beforeBuf && looksBinary(beforeBuf)) || (!!afterBuf && looksBinary(afterBuf));
  return {
    before: beforeBuf && !binary ? beforeBuf.toString('utf8') : '',
    after: afterBuf && !binary ? afterBuf.toString('utf8') : '',
    beforeLabel,
    afterLabel,
    binary,
    note,
  };
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

// ── Merge (local, SourceTree-style) ──────────────────────────────────────────

export interface MergeResult {
  /** 'merged' = commit created, 'fast-forward' = HEAD moved, 'up-to-date' =
   *  nothing to do, 'conflict' = merge left in progress for the user to resolve. */
  outcome: 'merged' | 'fast-forward' | 'up-to-date' | 'conflict';
  /** git's own output (or the conflict explanation). */
  output: string;
  /** Files with conflicts, when outcome is 'conflict'. */
  conflicts: string[];
  /** Set only when the source was a remote-tracking ref: which remote was
   *  refreshed first, and whether that fetch succeeded (a failure is not fatal —
   *  the merge proceeds against the local copy). */
  fetched?: { remote: string; ok: boolean; error?: string };
}

/**
 * Validate a ref the user wants to merge FROM. Accepts a local branch, a
 * remote-tracking ref (`origin/dev`) or a tag — anything git can resolve — but
 * refuses characters git itself rejects in ref names and a leading dash (which
 * would be read as a flag). The ref must also actually exist in this repo.
 */
function validateMergeRefSyntax(raw: unknown): string {
  const ref = typeof raw === 'string' ? raw.trim() : '';
  if (!ref) throw new Error('cần chọn branch để merge');
  if (ref.startsWith('-')) throw new Error('tên branch không hợp lệ');
  if (/[\s~^:?*[\]\\]/.test(ref) || ref.includes('..')) throw new Error('tên branch không hợp lệ');
  return ref;
}

/** Assert the ref resolves to a commit in this repo. Separate from the syntax
 *  check so a fetch can run in between — a pruned remote branch must be reported
 *  as "not found", not as a raw git failure mid-merge. */
async function assertMergeRefExists(repo: string, ref: string): Promise<void> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new Error(`không tìm thấy branch/ref "${ref}" trong repo này`);
  }
}

/**
 * The remote a ref belongs to, or null when it is not a remote-tracking ref.
 *
 * A prefix match alone would be wrong: a local branch may legitimately be named
 * `origin/foo`, and `git branch --list` would still show it. So the ref must both
 * start with a CONFIGURED remote name and resolve as a remote-tracking ref
 * (`refs/remotes/<ref>`) — that is what makes fetching it meaningful.
 */
async function remoteOfRef(repo: string, ref: string): Promise<string | null> {
  const slash = ref.indexOf('/');
  if (slash <= 0) return null;
  const candidate = ref.slice(0, slash);
  let names: string[] = [];
  try {
    names = (await git(repo, ['remote'])).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
  if (!names.includes(candidate)) return null;
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`]);
  } catch {
    return null;
  }
  return candidate;
}

/** Paths git reports as unmerged (conflicted) right now. */
async function conflictedFiles(repo: string): Promise<string[]> {
  try {
    const out = await git(repo, ['diff', '--name-only', '--diff-filter=U']);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Merge `ref` INTO the currently checked-out branch — the SourceTree
 * "Merge <branch> into current branch" action.
 *
 * Preconditions are checked up front rather than letting git fail halfway:
 * a detached HEAD has no branch to merge into, an already-running merge must be
 * finished first, and a dirty working tree would make a conflict impossible to
 * untangle (git itself refuses, but the message is much clearer from here).
 *
 * On conflict the merge is deliberately LEFT in progress — that is what the user
 * wants to resolve in their editor. `abortMerge` is the escape hatch.
 *
 * `--no-ff` (opt-in) forces a merge commit even when a fast-forward is possible,
 * matching SourceTree's "Create a commit even if merge resolved via fast-forward".
 */
export async function mergeBranch(
  repo: string,
  refRaw: unknown,
  opts: { noFf?: boolean; message?: string } = {},
): Promise<MergeResult> {
  const ref = validateMergeRefSyntax(refRaw);

  // Merging a remote-tracking ref (origin/dev) without fetching would merge a
  // STALE local copy — silently missing whatever landed on the server since the
  // last fetch. Update just that remote first. Best effort: offline / no
  // credential must not block merging the copy we already have, so a failure is
  // reported in the result instead of thrown.
  let fetched: MergeResult['fetched'];
  const remote = await remoteOfRef(repo, ref);
  if (remote) {
    try {
      await git(repo, ['fetch', '--prune', '--', remote], { env: { GIT_TERMINAL_PROMPT: '0' } });
      fetched = { remote, ok: true };
    } catch (e) {
      fetched = { remote, ok: false, error: ((e as Error).message || 'fetch failed').split('\n')[0] };
    }
  }

  // After the fetch — a --prune may have just removed a branch deleted upstream.
  await assertMergeRefExists(repo, ref);
  const st = await status(repo);

  if (st.detached) throw new Error('đang ở detached HEAD — checkout một branch trước khi merge');
  if (await isMerging(repo)) {
    throw new Error('đang có merge dở dang — xử lý conflict rồi commit, hoặc hủy merge trước');
  }
  if (ref === st.branch) throw new Error('không thể merge một branch vào chính nó');
  // Any local modification (staged or not) blocks a safe merge. Untracked files
  // are fine — git only complains if the merge would overwrite one, and it says so.
  if (st.files.some((f) => f.group !== 'untracked')) {
    throw new Error('working tree có thay đổi chưa commit — commit hoặc bỏ thay đổi trước khi merge');
  }

  const args = ['merge', '--no-edit'];
  if (opts.noFf) args.push('--no-ff');
  const msg = (opts.message || '').trim();
  if (msg) args.push('-m', msg);
  args.push('--', ref);

  let output: string;
  try {
    output = await git(repo, args, { withStderr: true });
  } catch (e) {
    const raw = (e as Error).message || 'merge failed';
    const conflicts = await conflictedFiles(repo);
    if (conflicts.length || (await isMerging(repo))) {
      return {
        outcome: 'conflict',
        output: `Merge "${ref}" bị conflict ở ${conflicts.length} file — xử lý rồi commit, hoặc hủy merge.`,
        conflicts,
        fetched,
      };
    }
    throw new Error(raw.split('\n').slice(0, 4).join('\n'));
  }

  const text = output.trim();
  if (/Already up to date|Already up-to-date/i.test(text)) {
    return { outcome: 'up-to-date', output: text, conflicts: [], fetched };
  }
  return {
    outcome: /Fast-forward/i.test(text) ? 'fast-forward' : 'merged',
    output: text,
    conflicts: [],
    fetched,
  };
}

/** Abort an in-progress merge, restoring the pre-merge state (`git merge --abort`). */
export async function abortMerge(repo: string): Promise<string> {
  if (!(await isMerging(repo))) throw new Error('không có merge nào đang dở dang');
  return git(repo, ['merge', '--abort'], { withStderr: true });
}

export async function push(repo: string): Promise<string> {
  const st = await status(repo);
  // No upstream yet → set it on push so the first push of a new branch works.
  if (!st.upstream && st.branch && !st.detached) {
    return git(repo, ['push', '-u', 'origin', st.branch]);
  }
  return git(repo, ['push']);
}
