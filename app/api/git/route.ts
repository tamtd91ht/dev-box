// /api/git — server-side Git operations for the local SourceTree-style workspace.
//
//   GET                → { enabled, repos } capability probe (safe when disabled).
//   POST { action, … } → run one authorized git operation.
//
// Gated by GIT_TOOL_ENABLED (see lib/gitCore). When the flag is off — as on any
// k8s/production deployment — every call returns 403 and no git process runs.
// Every repo path is authorized against the configured Git root before use.

import path from 'path';
import { NextResponse, type NextRequest } from 'next/server';
import {
  GIT_ENABLED,
  detectRepos,
  authorizeRepo,
  status,
  statusAll,
  pullAll,
  branches,
  log,
  diffFile,
  stage,
  unstage,
  discard,
  discardStaged,
  discardAll,
  clean,
  cloneRepo,
  commit,
  checkout,
  pull,
  push,
} from '@/lib/gitCore';
import { getProject, allowedRoots } from '@/lib/gitProjects';
import { runReviewMr, runScanSecurity, serviceNameFromRepoPath, validateBranch } from '@/lib/reviewMr';
import { listOpenMergeRequests, mergeMergeRequest, repoGitLabRef } from '@/lib/gitlabMr';
import { listTokens, setToken, deleteToken, tokenStatus } from '@/lib/gitlabTokens';

export const runtime = 'nodejs';

/**
 * Resolve the root folder a repo-scoped request operates under. When a projectId
 * is given it must match a configured project; otherwise fall back to the legacy
 * single-root behaviour (detectRepos() with its GIT_ROOT default).
 */
async function resolveRoot(projectId: unknown): Promise<string | undefined> {
  if (typeof projectId === 'string' && projectId) {
    const project = await getProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);
    return project.root;
  }
  return undefined;
}

/**
 * Same as resolveRoot, but for actions that MUST know the folder they write into
 * (clone). With no projectId, fall back to the first effective project root —
 * which is the legacy/auto default when nothing is configured.
 */
async function resolveRootRequired(projectId: unknown): Promise<string> {
  const root = await resolveRoot(projectId);
  if (root) return root;
  const roots = await allowedRoots();
  if (!roots.length) throw new Error('chưa cấu hình project nào để clone vào');
  return roots[0];
}

function disabled() {
  return NextResponse.json(
    { error: 'Git tool is disabled. Set GIT_TOOL_ENABLED=true to enable it (local dev only).' },
    { status: 403 },
  );
}

export async function GET() {
  if (!GIT_ENABLED) return NextResponse.json({ enabled: false, repos: [] });
  // Legacy capability probe (no project → default root). The project-aware UI
  // fetches repos per-project via the `repos` action below.
  const repos = await detectRepos();
  return NextResponse.json({ enabled: true, repos });
}

export async function POST(req: NextRequest) {
  if (!GIT_ENABLED) return disabled();

  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== 'string') {
    return NextResponse.json({ error: 'expected { action, … }' }, { status: 400 });
  }
  const { action } = body as { action: string };

  try {
    // Actions that operate across all repos under a project's root (or the legacy
    // default root when no projectId is supplied).
    if (action === 'repos') {
      const root = await resolveRoot(body.projectId);
      return NextResponse.json({ repos: await detectRepos(root) });
    }
    if (action === 'status-all') {
      const root = await resolveRoot(body.projectId);
      return NextResponse.json({ repos: await statusAll(root) });
    }
    if (action === 'pull-all') {
      const root = await resolveRoot(body.projectId);
      return NextResponse.json({ results: await pullAll(root) });
    }
    if (action === 'clone') {
      // Clones into a NEW folder under the project's root — the target path is
      // built server-side from the validated single-segment name, never taken
      // from the client, so the clone can't land outside the project.
      const root = await resolveRootRequired(body.projectId);
      const result = await cloneRepo(root, body.url, body.name, body.branch);
      return NextResponse.json(result);
    }

    // GitLab API token management — host-scoped, not repo-scoped, so these run
    // before authorizeRepo. The token itself is NEVER echoed back: responses
    // carry only a redacted preview (last 4 chars) + savedAt.
    if (action === 'list-gitlab-tokens') {
      return NextResponse.json({ tokens: await listTokens() });
    }
    if (action === 'set-gitlab-token') {
      // savedAt is stamped here (the request boundary) so lib/gitlabTokens stays
      // free of ambient clock reads.
      const saved = await setToken(body.host, body.token, new Date().toISOString());
      return NextResponse.json({ token: saved });
    }
    if (action === 'delete-gitlab-token') {
      return NextResponse.json({ removed: await deleteToken(body.host) });
    }

    // All remaining actions require an authorized repo path — allowed against the
    // set of every configured project root.
    const repo = await authorizeRepo(body.repo, await allowedRoots());

    switch (action) {
      case 'status':
        return NextResponse.json(await status(repo));

      case 'branches':
        return NextResponse.json(await branches(repo));

      case 'log': {
        const limit = typeof body.limit === 'number' ? body.limit : 30;
        return NextResponse.json({ commits: await log(repo, limit) });
      }

      case 'diff': {
        const file = String(body.file ?? '');
        if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });
        const patch = await diffFile(repo, file, !!body.staged);
        return NextResponse.json({ diff: patch });
      }

      case 'stage':
        await stage(repo, asFiles(body.files));
        return NextResponse.json(await status(repo));

      case 'unstage':
        await unstage(repo, asFiles(body.files));
        return NextResponse.json(await status(repo));

      case 'discard':
        await discard(repo, asFiles(body.files));
        return NextResponse.json(await status(repo));

      case 'discard-staged':
        await discardStaged(repo, asFiles(body.files));
        return NextResponse.json(await status(repo));

      case 'clean':
        await clean(repo, asFiles(body.files));
        return NextResponse.json(await status(repo));

      case 'discard-all': {
        // Wipe every local change in this repo (reset --hard + clean -fd).
        const result = await discardAll(repo);
        return NextResponse.json({ ...result, status: await status(repo) });
      }

      case 'commit': {
        const out = await commit(repo, String(body.message ?? ''));
        return NextResponse.json({ output: out, status: await status(repo) });
      }

      case 'checkout': {
        const out = await checkout(repo, String(body.branch ?? ''), !!body.create);
        return NextResponse.json({ output: out, status: await status(repo), branches: await branches(repo) });
      }

      case 'pull': {
        const out = await pull(repo);
        return NextResponse.json({ output: out, status: await status(repo) });
      }

      case 'push': {
        const out = await push(repo);
        return NextResponse.json({ output: out, status: await status(repo) });
      }

      case 'review-mr': {
        // Run Claude Code's /review-mr-dev against this repo. Service is derived
        // from the authorized path; cwd/OMICX_BASE_PATH must be the project root.
        const service = serviceNameFromRepoPath(repo);
        const branch = validateBranch(body.branch);
        const projectRoot = path.dirname(repo);
        const result = await runReviewMr({ cwd: projectRoot, service, branch });
        return NextResponse.json(result);
      }

      case 'scan-security': {
        // Run Claude Code's /scan-security on this repo's current branch.
        const service = serviceNameFromRepoPath(repo);
        const projectRoot = path.dirname(repo);
        const result = await runScanSecurity({ cwd: projectRoot, service });
        return NextResponse.json(result);
      }

      case 'gitlab-token-status': {
        // Which GitLab host this repo's origin points at, and whether a token is
        // configured for it — lets the UI prefill the host and show state without
        // the user hunting for it. Redacted: never includes the token.
        const ref = await repoGitLabRef(repo);
        return NextResponse.json({ host: ref.host, token: await tokenStatus(ref.host) });
      }

      case 'list-mrs': {
        // Open GitLab MRs of this repo targeting `branch` (default 'dev'). Token
        // is resolved server-side (saved PAT for the host, else git credential) —
        // never taken from the client.
        const target = validateBranch(body.branch) || 'dev';
        const { ref, mrs } = await listOpenMergeRequests(repo, target);
        return NextResponse.json({ targetBranch: target, project: ref.projectPath, baseUrl: ref.baseUrl, mrs });
      }

      case 'merge-mr': {
        // Merge one MR by iid via the GitLab MR merge API (respects GitLab rules).
        const iid = typeof body.iid === 'number' ? body.iid : Number(body.iid);
        const result = await mergeMergeRequest(repo, iid);
        return NextResponse.json(result);
      }

      default:
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'git operation failed' }, { status: 400 });
  }
}

/** Coerce the request `files` field into a clean string array. */
function asFiles(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}
