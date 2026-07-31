// Read-only git helpers the bot needs beyond lib/gitCore.ts: fetch the remote,
// find the feature branches ahead of origin/dev, and read a branch's HEAD sha +
// author. Everything runs via execFile('git', [...]) — never a shell string —
// so branch names can't be interpreted as flags or commands. Read-only: fetch +
// rev-list + rev-parse + log only, never checkout/merge/push.

import { execFile } from 'child_process';

const GIT_TIMEOUT_MS = 60_000; // fetch across a repo can be slow
const MAX_BUFFER = 8 * 1024 * 1024;

const PROTECTED = new Set(['dev', 'prod', 'master', 'stg', 'HEAD']);

function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, ...args],
      { maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || (err as Error).message || '').toString().trim();
          reject(new Error(msg || 'git command failed'));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}

/** git fetch origin --prune — refresh remote refs before inspecting them. */
export async function fetch(repo: string): Promise<void> {
  await git(repo, ['fetch', 'origin', '--prune']);
}

export interface BranchState {
  /** Branch short name without the origin/ prefix, e.g. "dev_duynh". */
  branch: string;
  /** Commits this branch is ahead of origin/dev. */
  ahead: number;
  /** Full sha of the branch HEAD. */
  headSha: string;
  /** Author (%an) of the branch's first commit ahead of origin/dev. */
  author: string;
}

/** List remote feature branches (origin/*) that are ahead of origin/dev. */
export async function featureBranchesAheadDev(repo: string): Promise<string[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']);
  const candidates = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Keep only origin/<name>; drop the bare "origin" (origin/HEAD) token.
    .filter((l) => l.startsWith('origin/'))
    .map((l) => l.slice('origin/'.length))
    .filter((b) => b && !PROTECTED.has(b));

  const ahead: string[] = [];
  for (const b of candidates) {
    if ((await aheadCount(repo, b)) > 0) ahead.push(b);
  }
  return ahead;
}

/** How many commits origin/<branch> is ahead of origin/dev. */
export async function aheadCount(repo: string, branch: string): Promise<number> {
  const out = await git(repo, ['rev-list', '--count', `origin/dev..origin/${branch}`]);
  return parseInt(out.trim(), 10) || 0;
}

/** Does origin/<branch> exist? */
export async function remoteBranchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Full HEAD sha of origin/<branch>. */
export async function headSha(repo: string, branch: string): Promise<string> {
  const out = await git(repo, ['rev-parse', `origin/${branch}`]);
  return out.trim();
}

/**
 * Author of the branch — matches how /review-mr-dev derives {git-username}:
 * the author (%an) of the first commit on the branch ahead of origin/dev.
 */
export async function branchAuthor(repo: string, branch: string): Promise<string> {
  // origin/dev..origin/<branch> lists commits unique to the branch, oldest last;
  // take the oldest (the branch's first commit) with -1 after reversing.
  const out = await git(repo, [
    'log',
    '--reverse',
    '--format=%an',
    `origin/dev..origin/${branch}`,
  ]);
  const first = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  return first || 'unknown';
}

/** Resolve the full state of one branch (ahead / sha / author) in one place. */
export async function branchState(repo: string, branch: string): Promise<BranchState> {
  const [ahead, sha, author] = await Promise.all([
    aheadCount(repo, branch),
    headSha(repo, branch),
    branchAuthor(repo, branch),
  ]);
  return { branch, ahead, headSha: sha, author };
}
