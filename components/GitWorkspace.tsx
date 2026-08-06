'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchGitProjects,
  mutateGitProject,
  gitAction,
  codeLabel,
  defaultCloneName,
  type CloneResult,
  type DiscardAllResult,
  type RepoInfo,
  type RepoStatus,
  type BranchInfo,
  type ChangedFile,
  type CommitLog,
  type RepoOverview,
  type RepoState,
  type PullResult,
  type GitProject,
  type ReviewMrResult,
  type MergeRequestSummary,
  type ListMrsResult,
  type MergeMrResult,
  type GitLabTokenStatusResult,
} from '@/lib/git';
import FolderPicker from './FolderPicker';

/** localStorage keys remembering the last-selected project + repo. */
import { readLocal, writeLocal } from '@/lib/localKeys';

const LAST_REPO_KEY = 'git.lastRepo';
const LAST_PROJECT_KEY = 'git.lastProject';

/** Colour a single diff line by its leading character. */
function diffLineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+') && !line.startsWith('+++')) return { color: 'var(--ok, #3fb950)' };
  if (line.startsWith('-') && !line.startsWith('---')) return { color: 'var(--err, #f85149)' };
  if (line.startsWith('@@')) return { color: 'var(--accent, #6c8cff)' };
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---'))
    return { color: 'var(--muted)', fontWeight: 600 };
  return {};
}

interface SelectedFile {
  path: string;
  staged: boolean;
}

/**
 * Label for a repo <option>, prefixed with a status glyph once the overview is
 * loaded. `↓` = needs pull (behind/diverged), `↑` = needs push, `✎` = uncommitted,
 * `•` = clean, `?` = unknown/no-upstream/error. Native <option> can't hold markup,
 * so the whole cue is a single leading character in the text.
 */
function repoOptionLabel(name: string, ov?: RepoOverview): string {
  if (!ov) return name;
  switch (ov.state) {
    case 'behind':
      return `↓ ${name}${ov.behind > 0 ? `  (${ov.behind})` : ''}`;
    case 'diverged':
      return `↓ ${name}  (⇅${ov.behind})`;
    case 'ahead':
      return `↑ ${name}`;
    case 'dirty':
      return `✎ ${name}`;
    case 'clean':
      return `• ${name}`;
    default:
      return `? ${name}`;
  }
}

/**
 * SourceTree-style Git workspace — local dev only (server gates on GIT_TOOL_ENABLED).
 * Pick an auto-detected repo, review status, stage/unstage individual files,
 * inspect per-file diffs, commit staged changes, pull (--ff-only), push, and
 * checkout / create branches. Independent of the API-explorer service selection.
 */
export default function GitWorkspace() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // ── Projects (named root folders) ───────────────────────────────────────────
  const [projects, setProjects] = useState<GitProject[]>([]);
  const [projectsConfigured, setProjectsConfigured] = useState(false);
  const [safeBase, setSafeBase] = useState('');
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  // Clone dialog — clones a remote repo into the active project's root folder.
  const [cloneOpen, setCloneOpen] = useState(false);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repo, setRepo] = useState<string>('');
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [branchInfo, setBranchInfo] = useState<BranchInfo | null>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState('');
  const [showBranches, setShowBranches] = useState(false);
  // ── Claude Code commands (/review-mr-dev, /scan-security) on the selected repo ─
  const [reviewBranch, setReviewBranch] = useState('');
  const [reviewPromptOpen, setReviewPromptOpen] = useState(false);
  // Which command is currently running (only one at a time), or null when idle.
  const [commandRunning, setCommandRunning] = useState<null | 'review' | 'scan'>(null);
  const [commandResult, setCommandResult] = useState<ReviewMrResult | null>(null);
  const [commandKind, setCommandKind] = useState<'review' | 'scan'>('review');
  const [resultOpen, setResultOpen] = useState(false);
  // ── Merge requests (GitLab) ──────────────────────────────────────────────────
  // When open, the MR modal lists open MRs of the active repo targeting `dev`.
  // `mrHighlight` (optional) marks the source branch just reviewed so the user can
  // spot & merge the MR they just reviewed.
  const [mrModalOpen, setMrModalOpen] = useState(false);
  const [mrHighlight, setMrHighlight] = useState<string>('');
  const [view, setView] = useState<'changes' | 'history'>('changes');
  const [commits, setCommits] = useState<CommitLog[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  // Per-repo overview (state/ahead/behind) shared by the repo dropdown and the
  // all-repos panel. Keyed by repo path. Populated lazily on dropdown open / check.
  const [overview, setOverview] = useState<Record<string, RepoOverview>>({});
  const [overviewLoading, setOverviewLoading] = useState(false);

  const repoRef = useRef(repo);
  repoRef.current = repo;
  const projectRef = useRef(activeProjectId);
  projectRef.current = activeProjectId;
  // Throttle guard for the shared repo-overview fetch (dropdown badges + panel).
  const overviewFetchedAt = useRef(0);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 3500);
  }, []);

  // ── Load / refresh the project list, then pick an active project ─────────────
  const loadProjects = useCallback(async (preferId?: string) => {
    const res = await fetchGitProjects();
    setEnabled(res.enabled);
    setProjects(res.projects);
    setProjectsConfigured(res.configured);
    setSafeBase(res.base);
    if (!res.enabled) return res;
    // Choose the active project: explicit preference → remembered → first.
    let remembered = '';
    try {
      remembered = readLocal(LAST_PROJECT_KEY) ?? '';
    } catch {
      /* ignore */
    }
    setActiveProjectId((cur) => {
      const candidates = [preferId, cur, remembered].filter(Boolean) as string[];
      const pick = candidates.find((id) => res.projects.some((p) => p.id === id));
      return pick ?? res.projects[0]?.id ?? '';
    });
    return res;
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // ── Detect the repos under the active project's root ─────────────────────────
  const loadRepos = useCallback(async (projectId: string) => {
    if (!projectId) {
      setRepos([]);
      setRepo('');
      return;
    }
    setReposLoading(true);
    try {
      const r = await gitAction<{ repos: RepoInfo[] }>('repos', { projectId });
      if (projectRef.current !== projectId) return; // stale project switch
      setRepos(r.repos);
      let initial = '';
      try {
        initial = readLocal(LAST_REPO_KEY + ':' + projectId) ?? '';
      } catch {
        /* ignore */
      }
      const exists = r.repos.some((x) => x.path === initial);
      setRepo(exists ? initial : r.repos[0]?.path ?? '');
    } catch {
      if (projectRef.current !== projectId) return;
      setRepos([]);
      setRepo('');
    } finally {
      if (projectRef.current === projectId) setReposLoading(false);
    }
  }, []);

  // Re-detect repos + remember the project whenever the active project changes.
  useEffect(() => {
    if (!activeProjectId) return;
    try {
      writeLocal(LAST_PROJECT_KEY, activeProjectId);
    } catch {
      /* ignore */
    }
    setOverview({}); // overview is per-project — clear on switch
    overviewFetchedAt.current = 0;
    loadRepos(activeProjectId);
  }, [activeProjectId, loadRepos]);

  // ── Overview of ALL repos (shared: repo dropdown badges + all-repos panel) ───
  // Scoped to the active project's root — the projectId is sent along.
  const loadOverview = useCallback(async () => {
    const projectId = projectRef.current;
    setOverviewLoading(true);
    try {
      const r = await gitAction<{ repos: RepoOverview[] }>('status-all', { projectId });
      if (projectRef.current !== projectId) return []; // stale project switch
      const map: Record<string, RepoOverview> = {};
      for (const o of r.repos) map[o.path] = o;
      setOverview(map);
      return r.repos;
    } catch {
      return [];
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  // Refresh the overview when the dropdown is about to open — but throttle so
  // rapid clicks don't spam git. Cheap `git status` per repo, run concurrently.
  const maybeLoadOverview = useCallback(() => {
    const now = Date.now();
    if (overviewLoading) return;
    if (now - overviewFetchedAt.current < 4000) return; // fresh enough
    overviewFetchedAt.current = now;
    loadOverview();
  }, [loadOverview, overviewLoading]);

  // Overview as an array in the same order as the detected repo list, so the
  // all-repos panel renders stably regardless of when each status resolved.
  const overviewRows = useMemo(
    () => repos.map((r) => overview[r.path]).filter((o): o is RepoOverview => !!o),
    [repos, overview],
  );

  // ── Load status + branches for the active repo ──────────────────────────────
  const refresh = useCallback(async (path: string) => {
    if (!path) return;
    setError(null);
    try {
      const [st, br] = await Promise.all([
        gitAction<RepoStatus>('status', { repo: path }),
        gitAction<BranchInfo>('branches', { repo: path }),
      ]);
      // Guard against a stale repo switch resolving late.
      if (repoRef.current !== path) return;
      setStatus(st);
      setBranchInfo(br);
    } catch (e) {
      if (repoRef.current !== path) return;
      setStatus(null);
      setBranchInfo(null);
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!repo) return;
    try {
      // Remember the last repo per-project so each tab restores its own selection.
      if (projectRef.current) writeLocal(LAST_REPO_KEY + ':' + projectRef.current, repo);
    } catch {
      /* ignore */
    }
    setSelected(null);
    setDiff('');
    setShowBranches(false);
    refresh(repo);
  }, [repo, refresh]);

  // ── Load the diff for the selected file ─────────────────────────────────────
  useEffect(() => {
    if (!repo || !selected) {
      setDiff('');
      return;
    }
    let cancelled = false;
    gitAction<{ diff: string }>('diff', { repo, file: selected.path, staged: selected.staged })
      .then((r) => {
        if (!cancelled) setDiff(r.diff);
      })
      .catch((e) => {
        if (!cancelled) setDiff(`# diff failed: ${(e as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, selected]);

  // ── Load recent commit history (only while the History tab is open) ──────────
  const loadLog = useCallback(async (path: string) => {
    if (!path) return;
    setLogLoading(true);
    try {
      const r = await gitAction<{ commits: CommitLog[] }>('log', { repo: path, limit: 50 });
      if (repoRef.current !== path) return;
      setCommits(r.commits);
    } catch (e) {
      if (repoRef.current !== path) return;
      setCommits([]);
      setError((e as Error).message);
    } finally {
      setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== 'history' || !repo) return;
    loadLog(repo);
    // Reload when the branch changes too — history is per-branch.
  }, [view, repo, status?.branch, loadLog]);

  // ── Grouped file lists ──────────────────────────────────────────────────────
  const staged = useMemo(() => status?.files.filter((f) => f.group === 'staged') ?? [], [status]);
  const unstaged = useMemo(
    () => status?.files.filter((f) => f.group === 'unstaged') ?? [],
    [status],
  );
  const untracked = useMemo(
    () => status?.files.filter((f) => f.group === 'untracked') ?? [],
    [status],
  );

  const clean = status && status.files.length === 0;
  const repoName = repos.find((r) => r.path === repo)?.name ?? '';
  // cloud-saas-* product repos must be coded on `dev` (branch_guard convention) —
  // warn (don't block) when committing elsewhere.
  const branchWarn =
    !!status && /^cloud-saas-/.test(repoName) && status.branch !== 'dev' && !status.detached;

  // ── Action runner: run, then refresh; surface git output/stderr ─────────────
  async function run(label: string, fn: () => Promise<{ output?: string; status?: RepoStatus }>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (res.status && repoRef.current === repo) setStatus(res.status);
      else await refresh(repo);
      const out = (res.output ?? '').trim();
      flash(out ? `${label}: ${out.split('\n')[0]}` : `${label} ✓`);
    } catch (e) {
      setError(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const stageFiles = (files: string[]) =>
    run('Stage', () => gitAction('stage', { repo, files })).then(() => refresh(repo));
  const unstageFiles = (files: string[]) =>
    run('Unstage', () => gitAction('unstage', { repo, files })).then(() => refresh(repo));

  async function discardFiles(files: string[]) {
    if (!files.length) return;
    if (!window.confirm(`Bỏ thay đổi ở ${files.length} file? Không khôi phục được.`)) return;
    await run('Discard', () => gitAction('discard', { repo, files }));
    setSelected(null);
  }

  // Staged file → unstage + revert its working-tree changes back to HEAD.
  async function discardStagedFiles(files: string[]) {
    if (!files.length) return;
    if (!window.confirm(`Bỏ thay đổi (đã stage) ở ${files.length} file? Không khôi phục được.`)) return;
    await run('Discard', () => gitAction('discard-staged', { repo, files }));
    setSelected(null);
  }

  // Untracked file → delete it from disk (git clean). Nothing to restore from.
  async function removeUntrackedFiles(files: string[]) {
    if (!files.length) return;
    if (!window.confirm(`Xóa ${files.length} file chưa theo dõi khỏi đĩa? Không khôi phục được.`)) return;
    await run('Remove', () => gitAction('clean', { repo, files }));
    setSelected(null);
  }

  /**
   * Throw away every local change in the repo at once (git reset --hard +
   * git clean -fd). Spelled out in the confirm because it is irreversible: staged
   * work included, untracked files deleted, gitignored files kept.
   */
  async function discardEverything() {
    if (!status || !status.files.length || busy) return;
    const lines = [
      `Bỏ TOÀN BỘ thay đổi trong repo ${repoName || '(repo này)'}?`,
      '',
      `• ${staged.length + unstaged.length} file quay về commit gần nhất (kể cả phần đã stage)`,
    ];
    if (untracked.length) lines.push(`• ${untracked.length} file chưa theo dõi bị XÓA khỏi đĩa`);
    lines.push('• file trong .gitignore (node_modules, .env…) được giữ nguyên', '', 'Không khôi phục được.');
    if (!window.confirm(lines.join('\n'))) return;
    await run('Bỏ tất cả', async () => {
      const res = await gitAction<DiscardAllResult>('discard-all', { repo });
      const parts = [`${res.reverted} file về HEAD`];
      if (res.removed) parts.push(`xóa ${res.removed} file mới`);
      if (res.abortedRebase) parts.push('đã hủy rebase dở dang');
      return { status: res.status, output: parts.join(', ') };
    });
    overviewFetchedAt.current = 0; // this repo's overview badge is now stale
    setSelected(null);
  }

  // A fresh clone lands under the active project's root → re-detect the repos of
  // that project, then select the new one.
  async function afterClone(res: CloneResult) {
    setCloneOpen(false);
    await loadRepos(projectRef.current);
    setRepo(res.path);
    overviewFetchedAt.current = 0; // overview is stale — a repo appeared
    flash(`Đã clone ${res.name}`);
  }

  async function doCommit() {
    if (!message.trim() || !staged.length) return;
    await run('Commit', () => gitAction('commit', { repo, message: message.trim() }));
    setMessage('');
    setSelected(null);
  }

  async function doCheckout(branch: string, create: boolean) {
    await run('Checkout', () => gitAction('checkout', { repo, branch, create }));
    const br = await gitAction<BranchInfo>('branches', { repo });
    if (repoRef.current === repo) setBranchInfo(br);
    if (create) setNewBranch('');
    setSelected(null);
  }

  // Run a long-running Claude Code command on the selected repo. Uses its own
  // busy flag (not run()) — these are long, non-git actions that don't refresh
  // git status. Only one command runs at a time.
  async function runCommand(
    kind: 'review' | 'scan',
    label: string,
    action: string,
    params: Record<string, unknown>,
  ) {
    if (commandRunning || !repo) return;
    setCommandRunning(kind);
    setCommandKind(kind);
    setError(null);
    setCommandResult(null);
    try {
      const res = await gitAction<ReviewMrResult>(action, { repo, ...params });
      setCommandResult(res);
      setResultOpen(true);
      flash(res.exitCode === 0 ? `${label} hoàn tất` : `${label} kết thúc (exit ${res.exitCode})`);
    } catch (e) {
      setError(`${label} failed: ${(e as Error).message}`);
    } finally {
      setCommandRunning(null);
    }
  }

  function doReviewMr() {
    setReviewPromptOpen(false);
    // Remember which branch was reviewed so the post-review MR modal can highlight
    // its MR (empty = reviewed all MRs → no single highlight).
    setMrHighlight(reviewBranch.trim());
    void runCommand('review', 'Review MR', 'review-mr', { branch: reviewBranch.trim() });
  }

  // Open the MR modal (open MRs targeting `dev`). `highlight` = a source branch to
  // visually mark (e.g. the branch just reviewed).
  const openMrModal = useCallback((highlight = '') => {
    setMrHighlight(highlight);
    setMrModalOpen(true);
  }, []);

  function doScanSecurity() {
    if (commandRunning || !repo) return;
    if (!window.confirm(`Chạy /scan-security trên repo ${repoName} (branch đang checkout)?`)) return;
    void runCommand('scan', 'Scan Security', 'scan-security', {});
  }

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // ── Background-activity indicator ────────────────────────────────────────────
  // Any action currently running, most-specific label first. Shown as a floating
  // spinner pill so the user knows work is still happening below.
  const activityLabel =
    commandRunning === 'review'
      ? 'Đang review MR…'
      : commandRunning === 'scan'
        ? 'Đang scan security…'
        : busy
          ? 'Đang chạy lệnh git…'
          : reposLoading
            ? 'Đang quét repo…'
            : overviewLoading
              ? 'Đang kiểm tra trạng thái repo…'
              : logLoading
                ? 'Đang tải history…'
                : null;

  // ── Disabled / loading states ───────────────────────────────────────────────
  if (enabled === null) {
    return <div className="empty"><div className="empty-ico">⎇</div><p>Đang kiểm tra Git…</p></div>;
  }
  if (!enabled) {
    return (
      <div className="empty">
        <div className="empty-ico">⎇</div>
        <p>
          Git tool đang tắt. Đây là tính năng <b>chỉ dùng khi chạy local</b>. Bật bằng cách đặt
          <code className="small"> GIT_TOOL_ENABLED=true</code> trong <code className="small">.env.local</code> rồi
          khởi động lại api-tester.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      {/* ── Project tabs (each = a named root folder) ───────────────────────── */}
      <ProjectTabs
        projects={projects}
        activeId={activeProjectId}
        configured={projectsConfigured}
        base={safeBase}
        manageOpen={manageOpen}
        onSelect={(id) => setActiveProjectId(id)}
        onToggleManage={() => setManageOpen((o) => !o)}
        onChanged={(nextProjects, preferId) => {
          setProjects(nextProjects);
          setProjectsConfigured(nextProjects.length > 0);
          if (nextProjects.length === 0) {
            // Fell back to auto-default — reload to pick it up.
            loadProjects();
          } else {
            setActiveProjectId((cur) =>
              preferId && nextProjects.some((p) => p.id === preferId)
                ? preferId
                : nextProjects.some((p) => p.id === cur)
                  ? cur
                  : nextProjects[0].id,
            );
          }
        }}
      />

      {activeProject && (
        <div
          className="small"
          style={{ color: 'var(--muted)', marginTop: -6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <span style={{ fontFamily: 'var(--mono)' }} title="thư mục gốc của project này">
            📁 {activeProject.root}
            {reposLoading ? ' · đang quét repo…' : ` · ${repos.length} repo`}
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="ghost sm"
            onClick={() => setCloneOpen(true)}
            disabled={busy || !!commandRunning}
            title={`git clone một repo về ${activeProject.root}`}
          >
            ⧉ Clone repo…
          </button>
        </div>
      )}

      {!repos.length ? (
        <div className="empty" style={{ marginTop: 4 }}>
          <div className="empty-ico">⎇</div>
          {reposLoading ? (
            <p>Đang quét repo…</p>
          ) : (
            <p>
              Không tìm thấy repo git nào trong <code className="small">{activeProject?.root ?? 'thư mục này'}</code>.
              Chọn/ thêm một project trỏ tới thư mục chứa các repo (bấm <b>Quản lý</b> phía trên), hoặc{' '}
              <b>Clone repo…</b> để tải một repo về thư mục này.
            </p>
          )}
        </div>
      ) : (
        <>
      {/* ── All-repos overview (status check + pull all) ───────────────────── */}
      <AllReposPanel
        activeRepo={repo}
        projectId={activeProjectId}
        rows={overviewRows}
        loading={overviewLoading}
        onCheck={loadOverview}
        onOpenRepo={(p) => setRepo(p)}
        onAfterPull={() => refresh(repo)}
      />

      {/* ── Repo + branch bar ──────────────────────────────────────────────── */}
      <div className="panel">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="small" style={{ color: 'var(--muted)' }}>Repo</label>
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            onMouseDown={maybeLoadOverview}
            onFocus={maybeLoadOverview}
            disabled={busy}
            title={overviewLoading ? 'Đang kiểm tra trạng thái repo…' : 'Mở để xem repo nào cần pull (↓)'}
            style={{ padding: '6px 10px', minWidth: 260, fontFamily: 'var(--mono)', fontSize: 12 }}
          >
            {repos.map((r) => (
              <option key={r.path} value={r.path}>{repoOptionLabel(r.name, overview[r.path])}</option>
            ))}
          </select>

          {status && (
            <>
              <span className="badge info" title={status.upstream ? `upstream ${status.upstream}` : 'chưa có upstream'}>
                ⎇ {status.detached ? '(detached)' : status.branch}
              </span>
              {status.ahead > 0 && <span className="badge" title="commit chưa push">↑ {status.ahead}</span>}
              {status.behind > 0 && <span className="badge warn" title="commit ở remote chưa pull">↓ {status.behind}</span>}
              <button className="ghost sm" onClick={() => setShowBranches((s) => !s)} disabled={busy}>
                {showBranches ? 'Ẩn branch' : 'Branch…'}
              </button>
            </>
          )}

          <span style={{ flex: 1 }} />

          <button
            className="sm"
            onClick={() => openMrModal('')}
            disabled={busy || !repo}
            title="Xem các merge request đang mở của repo này vào nhánh dev"
          >
            ⇥ MR → dev
          </button>
          <button
            className="sm"
            onClick={() => setReviewPromptOpen(true)}
            disabled={busy || !!commandRunning || !repo}
            title="Chạy Claude Code /review-mr-dev trên repo này"
          >
            {commandRunning === 'review' ? (
              <><span className="spinner" aria-hidden /> Đang review</>
            ) : (
              '🔍 Review MR'
            )}
          </button>
          <button
            className="sm"
            onClick={doScanSecurity}
            disabled={busy || !!commandRunning || !repo}
            title="Chạy Claude Code /scan-security trên branch đang checkout"
          >
            {commandRunning === 'scan' ? (
              <><span className="spinner" aria-hidden /> Đang scan</>
            ) : (
              '🛡 Scan Security'
            )}
          </button>
          <button
            className="sm"
            onClick={() => run('Pull', () => gitAction('pull', { repo }))}
            disabled={busy || !!commandRunning}
            title="git pull --ff-only"
          >
            ↓ Pull
          </button>
          <button
            className="sm"
            onClick={() => run('Push', () => gitAction('push', { repo }))}
            disabled={busy || !!commandRunning || (!!status && status.ahead === 0 && !!status.upstream)}
            title="git push"
          >
            ↑ Push{status && status.ahead > 0 ? ` (${status.ahead})` : ''}
          </button>
          <button className="ghost sm" onClick={() => refresh(repo)} disabled={busy || !!commandRunning} title="Làm mới trạng thái">
            ↻
          </button>
        </div>

        {branchWarn && (
          <div className="badge warn" style={{ marginTop: 10 }}>
            ⚠ Repo <b>{repoName}</b> đang ở branch <b>{status?.branch}</b> — quy ước dự án: code trên <b>dev</b>.
          </div>
        )}

        {showBranches && branchInfo && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border, rgba(127,127,127,.2))', paddingTop: 12 }}>
            <div className="small" style={{ color: 'var(--muted)', marginBottom: 8 }}>Checkout branch</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {branchInfo.branches.map((b) => (
                <button
                  key={b}
                  className={b === branchInfo.current ? 'sm' : 'ghost sm'}
                  onClick={() => b !== branchInfo.current && doCheckout(b, false)}
                  disabled={busy || !!commandRunning || b === branchInfo.current}
                  title={b === branchInfo.current ? 'branch hiện tại' : `checkout ${b}`}
                >
                  {b === branchInfo.current ? '● ' : ''}{b}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && newBranch.trim() && doCheckout(newBranch.trim(), true)}
                placeholder="tên branch mới"
                style={{ flex: 1, maxWidth: 260, fontFamily: 'var(--mono)', fontSize: 12 }}
                disabled={busy || !!commandRunning}
              />
              <button
                className="sm"
                onClick={() => newBranch.trim() && doCheckout(newBranch.trim(), true)}
                disabled={busy || !!commandRunning || !newBranch.trim()}
                title="git checkout -b"
              >
                + Tạo & checkout
              </button>
            </div>
          </div>
        )}

        {error && <pre className="code" style={{ color: 'var(--err)', marginTop: 10, marginBottom: 0 }}>{error}</pre>}
        {notice && <div className="small" style={{ color: 'var(--ok)', marginTop: 10 }}>{notice}</div>}
      </div>

      {/* ── Sub-tabs: Changes | History ────────────────────────────────────── */}
      <div className="gitsub" role="tablist" aria-label="Git view">
        <button
          role="tab"
          aria-selected={view === 'changes'}
          className={view === 'changes' ? 'on' : ''}
          onClick={() => setView('changes')}
        >
          <span aria-hidden>≡</span> Thay đổi
          {status && status.files.length > 0 ? ` (${status.files.length})` : ''}
        </button>
        <button
          role="tab"
          aria-selected={view === 'history'}
          className={view === 'history' ? 'on' : ''}
          onClick={() => setView('history')}
        >
          <span aria-hidden>⌛</span> History
        </button>
        {view === 'history' && (
          <>
            <span style={{ flex: 1 }} />
            <button className="ghost sm" onClick={() => loadLog(repo)} disabled={logLoading} title="Làm mới history">
              ↻
            </button>
          </>
        )}
      </div>

      {view === 'history' ? (
        /* ── History view ───────────────────────────────────────────────── */
        <div className="panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="status-line">
            <h3 style={{ margin: 0, flex: 1 }}>Commit gần đây</h3>
            <span className="small" style={{ color: 'var(--muted)' }}>
              {status && !status.detached ? `⎇ ${status.branch}` : ''} · {commits.length}
            </span>
          </div>

          {logLoading && commits.length === 0 ? (
            <div className="empty" style={{ padding: '24px 8px' }}>
              <div className="empty-ico">⌛</div>
              <p className="small">Đang tải history…</p>
            </div>
          ) : commits.length === 0 ? (
            <div className="empty" style={{ padding: '24px 8px' }}>
              <div className="empty-ico">⌛</div>
              <p className="small">Chưa có commit nào.</p>
            </div>
          ) : (
            <div className="log-list" style={{ marginTop: 10, overflow: 'auto', flex: 1, minHeight: 0 }}>
              {commits.map((c) => (
                <div key={c.hash} className="log-row" title={`${c.hash}\n${c.author} · ${c.date}`}>
                  <code className="log-hash">{c.shortHash}</code>
                  <div className="log-main">
                    <div className="log-subject">
                      {c.subject}
                      {c.refs && <span className="log-refs">{c.refs}</span>}
                    </div>
                    <div className="log-meta small">
                      {c.author} · {c.relDate}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
      /* ── Changes + diff ─────────────────────────────────────────────────── */
      <div className="layout">
        {/* Left: file groups */}
        <div className="panel">
          <div className="status-line">
            <h3 style={{ margin: 0, flex: 1 }}>Thay đổi</h3>
            {status && <span className="small" style={{ color: 'var(--muted)' }}>{status.files.length} file</span>}
            {status && status.files.length > 0 && (
              <button
                className="ghost sm"
                onClick={discardEverything}
                disabled={busy}
                style={{ color: 'var(--err, #f85149)' }}
                title="Bỏ toàn bộ thay đổi: git reset --hard + git clean -fd (giữ file trong .gitignore)"
              >
                ⟲ Bỏ tất cả
              </button>
            )}
          </div>

          {clean && (
            <div className="empty" style={{ padding: '24px 8px' }}>
              <div className="empty-ico">✓</div>
              <p className="small">Không có thay đổi — working tree sạch.</p>
            </div>
          )}

          {/* Staged */}
          {staged.length > 0 && (
            <FileGroupBlock
              title="Staged"
              files={staged}
              staged
              selected={selected}
              onSelect={(f) => setSelected({ path: f.path, staged: true })}
              onRow={(f) => unstageFiles([f.path])}
              rowLabel="unstage"
              onDiscard={(f) => discardStagedFiles([f.path])}
              discardTitle="Bỏ thay đổi (unstage + discard)"
              busy={busy}
              headerAction={{ label: 'Unstage all', onClick: () => unstageFiles(staged.map((f) => f.path)) }}
            />
          )}

          {/* Unstaged */}
          {unstaged.length > 0 && (
            <FileGroupBlock
              title="Chưa stage"
              files={unstaged}
              staged={false}
              selected={selected}
              onSelect={(f) => setSelected({ path: f.path, staged: false })}
              onRow={(f) => stageFiles([f.path])}
              rowLabel="stage"
              onDiscard={(f) => discardFiles([f.path])}
              busy={busy}
              headerAction={{ label: 'Stage all', onClick: () => stageFiles(unstaged.map((f) => f.path)) }}
            />
          )}

          {/* Untracked */}
          {untracked.length > 0 && (
            <FileGroupBlock
              title="Chưa theo dõi"
              files={untracked}
              staged={false}
              selected={selected}
              onSelect={(f) => setSelected({ path: f.path, staged: false })}
              onRow={(f) => stageFiles([f.path])}
              rowLabel="stage"
              onDiscard={(f) => removeUntrackedFiles([f.path])}
              discardTitle="Xóa file khỏi đĩa (git clean)"
              busy={busy}
              headerAction={{ label: 'Stage all', onClick: () => stageFiles(untracked.map((f) => f.path)) }}
            />
          )}

          {/* Commit box */}
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border, rgba(127,127,127,.2))', paddingTop: 12 }}>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message (chỉ commit phần đã stage)"
              rows={3}
              disabled={busy}
              style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <button
                className="sm"
                onClick={doCommit}
                disabled={busy || !message.trim() || !staged.length}
                title={!staged.length ? 'Chưa có file nào được stage' : 'git commit -m'}
              >
                ✓ Commit ({staged.length})
              </button>
              {!staged.length && <span className="small" style={{ color: 'var(--muted)' }}>stage file trước khi commit</span>}
            </div>
          </div>
        </div>

        {/* Right: diff view */}
        <div className="panel">
          {selected ? (
            <>
              <div className="status-line">
                <span className={`badge ${selected.staged ? 'info' : ''}`}>{selected.staged ? 'staged' : 'working'}</span>
                <code className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selected.path}
                </code>
              </div>
              {diff ? (
                <pre className="code" style={{ marginTop: 10, maxHeight: '60vh', overflow: 'auto' }}>
                  {diff.split('\n').map((line, i) => (
                    <div key={i} style={diffLineStyle(line)}>{line || ' '}</div>
                  ))}
                </pre>
              ) : (
                <div className="empty" style={{ padding: '24px 8px' }}>
                  <div className="empty-ico">≡</div>
                  <p className="small">
                    Không có diff hiển thị (file mới chưa stage, hoặc thay đổi binary). Stage để xem.
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="empty">
              <div className="empty-ico">≡</div>
              <p>Chọn một file bên trái để xem diff.</p>
            </div>
          )}
        </div>
      </div>
      )}
        </>
      )}

      {activityLabel && (
        <div className="activity-badge" role="status" aria-live="polite">
          <span className="spinner" aria-hidden />
          <span>
            {activityLabel}
            {commandRunning && <span className="activity-sub"> (có thể mất vài phút)</span>}
          </span>
        </div>
      )}

      {reviewPromptOpen && (
        <div className="modal-backdrop" onClick={() => setReviewPromptOpen(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(460px, 92vw)' }}
          >
            <div className="status-line" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>Review MR — {repoName || 'repo'}</h3>
              <button className="ghost sm" onClick={() => setReviewPromptOpen(false)}>✕</button>
            </div>
            <div className="small" style={{ color: 'var(--muted)', marginBottom: 8 }}>
              Nhập branch cần review, hoặc để trống để review <b>tất cả MR</b> của repo.
            </div>
            <input
              type="text"
              value={reviewBranch}
              onChange={(e) => setReviewBranch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doReviewMr()}
              placeholder="branch (trống = tất cả MR)"
              autoFocus
              style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, marginBottom: 12 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="ghost sm" onClick={() => setReviewPromptOpen(false)}>Hủy</button>
              <button className="sm" onClick={doReviewMr} title="Chạy Claude Code /review-mr-dev">
                🔍 Chạy review
              </button>
            </div>
          </div>
        </div>
      )}

      {resultOpen && commandResult && (
        <div className="modal-backdrop" onClick={() => setResultOpen(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(1000px, 94vw)', maxWidth: '94vw' }}
          >
            <div className="status-line" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>
                {commandKind === 'scan' ? 'Kết quả Scan Security' : 'Kết quả Review MR'}
              </h3>
              <span
                className={`badge ${commandResult.exitCode === 0 ? 'info' : 'warn'}`}
                title="mã thoát của tiến trình claude"
              >
                exit {commandResult.exitCode}
              </span>
              <button className="ghost sm" onClick={() => setResultOpen(false)}>✕</button>
            </div>
            <pre
              className="code"
              style={{ margin: 0, overflow: 'auto', whiteSpace: 'pre-wrap', maxHeight: '70vh' }}
            >
              {commandResult.output || '(không có output)'}
            </pre>
            {commandKind === 'review' && (
              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border, rgba(127,127,127,.2))',
                }}
              >
                <span className="small" style={{ flex: 1, color: 'var(--muted)' }}>
                  Review xong. Bạn có muốn merge{' '}
                  {mrHighlight ? <>MR của branch <b>{mrHighlight}</b></> : 'một MR'} vào <b>dev</b> không?
                </span>
                <button
                  className="sm"
                  onClick={() => {
                    setResultOpen(false);
                    openMrModal(mrHighlight);
                  }}
                  title="Xem & merge merge request vào nhánh dev"
                >
                  ⇥ Xem & merge MR
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {cloneOpen && activeProject && (
        <CloneRepoModal
          projectId={activeProjectId}
          projectName={activeProject.name}
          root={activeProject.root}
          existingNames={repos.map((r) => r.name)}
          onClose={() => setCloneOpen(false)}
          onCloned={afterClone}
        />
      )}

      {mrModalOpen && repo && (
        <MergeRequestsModal
          repo={repo}
          repoName={repoName}
          highlightBranch={mrHighlight}
          onClose={() => setMrModalOpen(false)}
          onMerged={(mr) => flash(`Đã merge MR !${mr.iid} vào dev`)}
        />
      )}
    </div>
  );
}

// ── Clone repo modal ────────────────────────────────────────────────────────────

interface CloneRepoModalProps {
  /** Project whose root folder the repo is cloned into. */
  projectId: string;
  projectName: string;
  root: string;
  /** Repo folder names already in the root — used to warn before submitting. */
  existingNames: string[];
  onClose: () => void;
  onCloned: (res: CloneResult) => void;
}

/**
 * `git clone <url>` into the active project's root, so the new repo shows up in
 * that project's repo list right away. The folder name is prefilled from the URL
 * and stays editable; the branch field is optional (empty = the remote default).
 * Auth uses the machine's own git credential — nothing is typed here.
 */
function CloneRepoModal({ projectId, projectName, root, existingNames, onClose, onCloned }: CloneRepoModalProps) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  // Until the user edits the name, it follows the URL.
  const [nameEdited, setNameEdited] = useState(false);
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const folder = (nameEdited ? name : defaultCloneName(url)).trim();
  const taken = !!folder && existingNames.includes(folder);
  const canSubmit = !busy && !!url.trim() && !!folder && !taken;

  const submit = useCallback(async () => {
    if (busy || !url.trim() || !folder) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await gitAction<CloneResult>('clone', {
        projectId,
        url: url.trim(),
        name: folder,
        branch: branch.trim(),
      });
      onCloned(res);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, url, folder, branch, projectId, onCloned]);

  return (
    // Backdrop click is ignored while cloning — closing mid-clone would hide a
    // long-running operation the user can't get back to.
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Clone repo → {projectName}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div className="small" style={{ color: 'var(--muted)', marginBottom: 10 }}>
          Repo sẽ được clone vào <code className="small">{root}</code> và tự xuất hiện trong danh sách repo của project.
        </div>

        <label className="small" style={{ color: 'var(--muted)' }}>URL repo</label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
          placeholder="https://gitlab.com/group/repo.git hoặc git@gitlab.com:group/repo.git"
          autoFocus
          disabled={busy}
          style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, margin: '4px 0 10px' }}
        />

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '2 1 240px' }}>
            <label className="small" style={{ color: 'var(--muted)' }}>Tên thư mục</label>
            <input
              type="text"
              value={folder}
              onChange={(e) => {
                setNameEdited(true);
                setName(e.target.value);
              }}
              onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
              placeholder="tự lấy từ URL"
              disabled={busy}
              style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, marginTop: 4 }}
            />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label className="small" style={{ color: 'var(--muted)' }}>Branch (tùy chọn)</label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
              placeholder="mặc định của remote"
              disabled={busy}
              style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, marginTop: 4 }}
            />
          </div>
        </div>

        {taken && (
          <div className="badge warn" style={{ marginTop: 10 }}>
            ⚠ Thư mục <b>{folder}</b> đã có trong project — đổi tên khác.
          </div>
        )}
        {err && <pre className="code" style={{ color: 'var(--err)', margin: '10px 0 0' }}>{err}</pre>}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
          <span className="small" style={{ flex: 1, color: 'var(--muted)' }}>
            Dùng credential git của máy (không nhập mật khẩu ở đây).
          </span>
          <button className="ghost sm" onClick={onClose} disabled={busy}>Hủy</button>
          <button className="sm" onClick={submit} disabled={!canSubmit} title="git clone">
            {busy ? <><span className="spinner" aria-hidden /> Đang clone…</> : '⧉ Clone'}
          </button>
        </div>

        {busy && (
          <div className="small" style={{ color: 'var(--muted)', marginTop: 8 }}>
            Đang tải repo về — với repo lớn có thể mất vài phút.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Merge requests modal (GitLab) ───────────────────────────────────────────────

interface MergeRequestsModalProps {
  repo: string;
  repoName: string;
  /** Source branch to visually highlight (e.g. the branch just reviewed), if any. */
  highlightBranch: string;
  onClose: () => void;
  onMerged: (mr: MergeMrResult) => void;
}

/** Colour + label for a GitLab merge_status / detailed_merge_status value. */
function mrStatusMeta(status: string, hasConflicts: boolean): { label: string; color: string } {
  if (hasConflicts || status === 'cannot_be_merged' || status === 'conflict') {
    return { label: 'xung đột', color: 'var(--err, #f85149)' };
  }
  if (status === 'can_be_merged' || status === 'mergeable') {
    return { label: 'merge được', color: 'var(--ok, #3fb950)' };
  }
  if (status === 'checking' || status === 'unchecked') {
    return { label: 'đang kiểm tra', color: 'var(--muted)' };
  }
  // ci_still_running, not_approved, discussions_not_resolved, draft_status, …
  return { label: status.replace(/_/g, ' '), color: 'var(--warn, #d29922)' };
}

/**
 * Lists the OPEN GitLab merge requests of `repo` targeting `dev`, each with a
 * Merge button. The API token is resolved server-side from the repo's own git
 * credential — nothing is entered here. Merging calls the GitLab MR merge API so
 * approval/pipeline/conflict rules on GitLab are honoured.
 */
function MergeRequestsModal({ repo, repoName, highlightBranch, onClose, onMerged }: MergeRequestsModalProps) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<ListMrsResult | null>(null);
  const [mergingIid, setMergingIid] = useState<number | null>(null);
  // MRs that succeeded this session — shown as merged, removed from actionable list.
  const [mergedIids, setMergedIids] = useState<Set<number>>(() => new Set());
  const [tokenOpen, setTokenOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await gitAction<ListMrsResult>('list-mrs', { repo, branch: 'dev' });
      setData(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    load();
  }, [load]);

  const doMerge = useCallback(
    async (mr: MergeRequestSummary) => {
      if (mergingIid) return;
      if (!window.confirm(`Merge MR !${mr.iid} "${mr.title}"\n(${mr.sourceBranch} → ${mr.targetBranch}) vào dev?`)) return;
      setMergingIid(mr.iid);
      setErr(null);
      try {
        const res = await gitAction<MergeMrResult>('merge-mr', { repo, iid: mr.iid });
        setMergedIids((s) => new Set(s).add(mr.iid));
        onMerged(res);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setMergingIid(null);
      }
    },
    [repo, mergingIid, onMerged],
  );

  const mrs = data?.mrs ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>
            Merge request → <b>dev</b> — {repoName || 'repo'}
          </h3>
          <button className="ghost sm" onClick={() => setTokenOpen(true)} title="Token GitLab dùng cho MR API">
            🔑 Token
          </button>
          <button className="ghost sm" onClick={load} disabled={loading} title="Làm mới danh sách MR">
            {loading ? <span className="spinner" aria-hidden /> : '↻'}
          </button>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        {data && (
          <div className="small" style={{ color: 'var(--muted)', marginBottom: 8, fontFamily: 'var(--mono)' }}>
            {data.project} · {mrs.length} MR đang mở vào <b>dev</b>
          </div>
        )}

        {err && (
          <div style={{ margin: '0 0 10px' }}>
            <pre className="code" style={{ color: 'var(--err)', margin: 0 }}>{err}</pre>
            {/* Token/permission failures are the common case here and are fixed in
                one place — offer the jump instead of making the user find it. */}
            {/token|401|403/i.test(err) && (
              <button className="sm" style={{ marginTop: 8 }} onClick={() => setTokenOpen(true)}>
                🔑 Nhập token GitLab
              </button>
            )}
          </div>
        )}

        {loading && !data ? (
          <div className="empty" style={{ padding: '28px 8px' }}>
            <div className="empty-ico">⇥</div>
            <p className="small">Đang tải merge request…</p>
          </div>
        ) : mrs.length === 0 && !err ? (
          <div className="empty" style={{ padding: '28px 8px' }}>
            <div className="empty-ico">✓</div>
            <p className="small">Không có merge request nào đang mở vào <b>dev</b>.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '64vh', overflow: 'auto' }}>
            {mrs.map((mr) => {
              const merged = mergedIids.has(mr.iid);
              const meta = mrStatusMeta(mr.mergeStatus, mr.hasConflicts);
              const isHighlight = !!highlightBranch && mr.sourceBranch === highlightBranch;
              const isMerging = mergingIid === mr.iid;
              return (
                <div
                  key={mr.iid}
                  className="panel"
                  style={{
                    padding: '10px 12px',
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    border: isHighlight ? '1px solid var(--accent, #6c8cff)' : undefined,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <code className="small" style={{ color: 'var(--accent, #6c8cff)' }}>!{mr.iid}</code>
                      {isHighlight && <span className="badge info" title="MR của branch bạn vừa review">vừa review</span>}
                      {mr.draft && <span className="badge warn">Draft</span>}
                      <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {mr.title}
                      </span>
                    </div>
                    <div className="small" style={{ color: 'var(--muted)', marginTop: 3, fontFamily: 'var(--mono)' }}>
                      <code>{mr.sourceBranch}</code> → <code>{mr.targetBranch}</code>
                      {mr.author && <> · {mr.author}</>}
                      {' · '}
                      <span style={{ color: meta.color, fontWeight: 700 }}>{meta.label}</span>
                    </div>
                  </div>
                  <a
                    className="ghost sm"
                    href={mr.webUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="Mở MR trên GitLab"
                    style={{ textDecoration: 'none' }}
                  >
                    ↗
                  </a>
                  {merged ? (
                    <span className="badge info" title="đã merge">✓ đã merge</span>
                  ) : (
                    <button
                      className="sm"
                      onClick={() => doMerge(mr)}
                      disabled={mergingIid !== null || mr.draft}
                      title={mr.draft ? 'MR đang là Draft — bỏ Draft trước khi merge' : `Merge MR !${mr.iid} vào dev`}
                    >
                      {isMerging ? <><span className="spinner" aria-hidden /> Đang merge</> : '⇥ Merge'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="small" style={{ color: 'var(--muted)', marginTop: 10 }}>
          Merge gọi GitLab MR API (tôn trọng approval/pipeline/conflict trên GitLab).
          Token dùng Personal Access Token đã lưu cho host (nút 🔑 Token).
        </div>

        {tokenOpen && (
          <GitLabTokenModal
            repo={repo}
            onClose={() => setTokenOpen(false)}
            onSaved={() => {
              setTokenOpen(false);
              load();
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── GitLab token modal ──────────────────────────────────────────────────────────

interface GitLabTokenModalProps {
  repo: string;
  onClose: () => void;
  /** Called after a successful save/remove so the caller can retry its request. */
  onSaved: () => void;
}

/**
 * Save the Personal Access Token used for the GitLab REST API (MR list + merge).
 *
 * This is deliberately separate from the credential `git push` uses: a self-hosted
 * instance may accept an account password over HTTPS for git, but the REST API
 * only accepts a PAT. The host is derived server-side from the repo's own origin
 * remote — not typed here — so the token can't be filed under the wrong host.
 * The token is write-only from the browser's point of view: the server returns
 * just a redacted preview, never the value back.
 */
function GitLabTokenModal({ repo, onClose, onSaved }: GitLabTokenModalProps) {
  const [status, setStatus] = useState<GitLabTokenStatusResult | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setStatus(await gitAction<GitLabTokenStatusResult>('gitlab-token-status', { repo }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    const t = token.trim();
    if (!t || !status?.host || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await gitAction('set-gitlab-token', { host: status.host, token: t });
      setToken('');
      await refresh();
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [token, status, busy, refresh, onSaved]);

  const remove = useCallback(async () => {
    if (!status?.host || busy) return;
    if (!window.confirm(`Xoá token GitLab đã lưu cho ${status.host}?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await gitAction('delete-gitlab-token', { host: status.host });
      await refresh();
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [status, busy, refresh, onSaved]);

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Token GitLab</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        {loading ? (
          <div className="empty" style={{ padding: '20px 8px' }}>
            <p className="small">Đang đọc trạng thái token…</p>
          </div>
        ) : (
          <>
            <div className="small" style={{ color: 'var(--muted)', marginBottom: 10 }}>
              Host: <code style={{ fontFamily: 'var(--mono)' }}>{status?.host || '—'}</code>
              {status?.token ? (
                <>
                  {' · '}
                  <span className="badge info">đã lưu {status.token.preview}</span>
                </>
              ) : (
                <>
                  {' · '}
                  <span className="badge warn">chưa có token</span>
                </>
              )}
            </div>

            <label className="small" style={{ display: 'block', marginBottom: 4 }}>
              Personal Access Token (scope <code>api</code>)
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder="glpat-…"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              style={{ width: '100%', fontFamily: 'var(--mono)' }}
            />

            {err && <pre className="code" style={{ color: 'var(--err)', margin: '10px 0 0' }}>{err}</pre>}

            <div className="status-line" style={{ marginTop: 12 }}>
              <div className="small" style={{ flex: 1, color: 'var(--muted)' }}>
                Tạo ở GitLab → Settings → Access Tokens. Token chỉ lưu trên máy này.
              </div>
              {status?.token && (
                <button className="ghost sm" onClick={remove} disabled={busy}>Xoá</button>
              )}
              <button className="sm" onClick={save} disabled={busy || !token.trim()}>
                {busy ? <><span className="spinner" aria-hidden /> Đang lưu</> : 'Lưu'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Project tabs ────────────────────────────────────────────────────────────────

interface ProjectTabsProps {
  projects: GitProject[];
  activeId: string;
  configured: boolean;
  base: string;
  manageOpen: boolean;
  onSelect: (id: string) => void;
  onToggleManage: () => void;
  onChanged: (projects: GitProject[], preferId?: string) => void;
}

/** Horizontal project tab-bar + inline add/edit/remove manager. Each tab is a
 *  named root folder; `configured=false` means the single tab is the implicit
 *  auto-detected default (shown with a hint to add a real project). */
function ProjectTabs({
  projects,
  activeId,
  configured,
  base,
  manageOpen,
  onSelect,
  onToggleManage,
  onChanged,
}: ProjectTabsProps) {
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const resetForm = () => {
    setName('');
    setRoot('');
    setEditingId(null);
    setErr(null);
  };

  const submit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      if (editingId) {
        const next = await mutateGitProject('PUT', { id: editingId, name: name.trim(), root: root.trim() });
        onChanged(next, editingId);
      } else {
        const next = await mutateGitProject('POST', { name: name.trim(), root: root.trim() });
        // Prefer the newly added project (its root is unique → find by root).
        const added = next.find((p) => p.root === root.trim()) ?? next.find((p) => !projects.some((q) => q.id === p.id));
        onChanged(next, added?.id);
      }
      resetForm();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [editingId, name, root, projects, onChanged]);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm('Xóa project này khỏi danh sách? (không xóa thư mục trên đĩa)')) return;
      setBusy(true);
      setErr(null);
      try {
        const next = await mutateGitProject('DELETE', { id });
        onChanged(next);
        if (editingId === id) resetForm();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [editingId, onChanged],
  );

  const startEdit = (p: GitProject) => {
    setEditingId(p.id);
    setName(p.name);
    setRoot(p.root);
    setErr(null);
  };

  return (
    <div className="proj-tabs">
      <div className="proj-tabbar" role="tablist" aria-label="Git projects">
        {projects.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={p.id === activeId}
            className={`proj-tab ${p.id === activeId ? 'on' : ''}`}
            onClick={() => onSelect(p.id)}
            title={p.root}
          >
            <span className="proj-tab-ico" aria-hidden>◧</span>
            {p.name}
            {!configured && <span className="proj-tab-badge">auto</span>}
          </button>
        ))}
        <button
          className={`proj-manage ${manageOpen ? 'on' : ''}`}
          onClick={onToggleManage}
          title="Thêm / sửa / xóa project"
        >
          {manageOpen ? '✕ Đóng' : '⚙ Quản lý'}
        </button>
      </div>

      {manageOpen && (
        <div className="panel proj-manage-panel" style={{ marginTop: 8 }}>
          {!configured && (
            <div className="small" style={{ color: 'var(--muted)', marginBottom: 8 }}>
              Chưa cấu hình project nào — đang dùng thư mục tự nhận diện. Thêm một project để cố định
              danh sách repo cho máy này (lưu ở <code className="small">.gitprojects.json</code>, đã gitignore).
            </div>
          )}

          {configured && projects.length > 0 && (
            <div className="proj-list">
              {projects.map((p) => (
                <div key={p.id} className={`proj-list-row ${p.id === editingId ? 'editing' : ''}`}>
                  <code className="proj-list-name">{p.name}</code>
                  <code className="small proj-list-root" title={p.root}>{p.root}</code>
                  <button className="ghost sm" onClick={() => startEdit(p)} disabled={busy}>Sửa</button>
                  <button className="ghost sm" onClick={() => remove(p.id)} disabled={busy}>Xóa</button>
                </div>
              ))}
            </div>
          )}

          <div className="proj-form" style={{ marginTop: configured ? 10 : 0 }}>
            <div className="small" style={{ color: 'var(--muted)', marginBottom: 6 }}>
              {editingId ? 'Sửa project' : 'Thêm project'} — thư mục gốc phải nằm trong{' '}
              <code className="small">{base || '(base an toàn)'}</code>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Tên project (vd: backend)"
                disabled={busy}
                style={{ flex: '1 1 180px', minWidth: 160, fontSize: 12 }}
              />
              <input
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                placeholder="Đường dẫn thư mục gốc"
                disabled={busy}
                style={{ flex: '2 1 300px', minWidth: 220, fontFamily: 'var(--mono)', fontSize: 12 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim() && root.trim()) submit();
                }}
              />
              <button className="ghost sm" onClick={() => setPickerOpen(true)} disabled={busy} title="Chọn thư mục">
                📂 Browse
              </button>
              <button className="sm" onClick={submit} disabled={busy || !name.trim() || !root.trim()}>
                {busy ? '…' : editingId ? 'Lưu' : '+ Thêm'}
              </button>
              {editingId && (
                <button className="ghost sm" onClick={resetForm} disabled={busy}>Hủy</button>
              )}
            </div>
            {err && <pre className="code" style={{ color: 'var(--err)', marginTop: 8, marginBottom: 0 }}>{err}</pre>}
          </div>
        </div>
      )}

      {pickerOpen && (
        <FolderPicker
          initial={root.trim() || undefined}
          title="Chọn thư mục gốc"
          hint="Bấm vào thư mục để đi vào; “Chọn thư mục này” để lấy thư mục đang mở làm gốc."
          onPick={(picked) => {
            setRoot(picked);
            // Prefill a name from the folder if empty, for convenience.
            setName((n) => n || picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '');
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

// ── All-repos overview panel ────────────────────────────────────────────────────

/** Vietnamese label + colour for each repo state. */
const STATE_META: Record<RepoState, { label: string; color: string }> = {
  clean: { label: 'sạch', color: 'var(--ok, #3fb950)' },
  dirty: { label: 'cần commit', color: 'var(--warn, #d29922)' },
  ahead: { label: 'cần push', color: 'var(--accent, #6c8cff)' },
  behind: { label: 'cần pull', color: 'var(--warn, #d29922)' },
  diverged: { label: 'phân kỳ', color: 'var(--err, #f85149)' },
  'no-upstream': { label: 'chưa có upstream', color: 'var(--muted)' },
  error: { label: 'lỗi', color: 'var(--err, #f85149)' },
};

const OUTCOME_META: Record<PullResult['outcome'], { label: string; color: string }> = {
  pulled: { label: 'đã pull', color: 'var(--ok, #3fb950)' },
  'up-to-date': { label: 'đã mới nhất', color: 'var(--muted)' },
  skipped: { label: 'bỏ qua', color: 'var(--warn, #d29922)' },
  conflict: { label: 'xung đột', color: 'var(--err, #f85149)' },
  error: { label: 'lỗi', color: 'var(--err, #f85149)' },
};

function stateBadge(color: string): React.CSSProperties {
  return {
    color,
    border: `1px solid ${color}`,
    borderRadius: 5,
    padding: '1px 8px',
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '.03em',
    whiteSpace: 'nowrap',
  };
}

/** States where a `git pull --ff-only` is the natural next action. */
function needsPull(state: RepoState): boolean {
  return state === 'behind' || state === 'diverged';
}

interface AllReposPanelProps {
  activeRepo: string;
  /** Active project id — scopes pull-all to that project's root. */
  projectId: string;
  rows: RepoOverview[];
  loading: boolean;
  /** Re-run status-all in the parent (shared with the repo dropdown). */
  onCheck: () => Promise<RepoOverview[]>;
  onOpenRepo: (path: string) => void;
  onAfterPull: () => void;
}

function AllReposPanel({ activeRepo, projectId, rows, loading, onCheck, onOpenRepo, onAfterPull }: AllReposPanelProps) {
  const [open, setOpen] = useState(false);
  const [pulls, setPulls] = useState<Record<string, PullResult>>({});
  const [busy, setBusy] = useState<null | 'pull-all'>(null);
  const [pullingPath, setPullingPath] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const anyBusy = !!busy || loading || !!pullingPath;

  const check = useCallback(async () => {
    setErr(null);
    setPulls({});
    await onCheck();
    setOpen(true);
  }, [onCheck]);

  const pullAll = useCallback(async () => {
    setBusy('pull-all');
    setErr(null);
    try {
      const r = await gitAction<{ results: PullResult[] }>('pull-all', { projectId });
      const map: Record<string, PullResult> = {};
      for (const p of r.results) map[p.path] = p;
      setPulls(map);
      setOpen(true);
      await onCheck(); // refresh ahead/behind after pulling
      onAfterPull();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [projectId, onCheck, onAfterPull]);

  // Pull a single repo (from its row's Pull button) via the single-repo action.
  const pullOne = useCallback(
    async (path: string) => {
      setPullingPath(path);
      setErr(null);
      try {
        const out = await gitAction<{ output?: string }>('pull', { repo: path });
        setPulls((m) => ({
          ...m,
          [path]: { name: '', path, outcome: 'pulled', message: (out.output ?? '').trim().split('\n')[0] || 'ff' },
        }));
        await onCheck();
        onAfterPull();
      } catch (e) {
        const msg = (e as Error).message || 'pull failed';
        const conflict = /non-fast-forward|not possible to fast-forward|diverge|would be overwritten|conflict/i.test(msg);
        setPulls((m) => ({
          ...m,
          [path]: { name: '', path, outcome: conflict ? 'conflict' : 'error', message: msg.split('\n')[0] },
        }));
      } finally {
        setPullingPath(null);
      }
    },
    [onCheck, onAfterPull],
  );

  // Summary counts for the header.
  const summary = useMemo(() => {
    const c = { dirty: 0, behind: 0, ahead: 0, other: 0 };
    for (const r of rows) {
      if (r.state === 'dirty') c.dirty++;
      else if (r.state === 'behind' || r.state === 'diverged') c.behind++;
      else if (r.state === 'ahead') c.ahead++;
      else if (r.state !== 'clean') c.other++;
    }
    return c;
  }, [rows]);

  const conflicts = Object.values(pulls).filter((p) => p.outcome === 'conflict');
  const pullableCount = rows.filter((r) => needsPull(r.state)).length;

  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Tất cả repo</h3>
        {rows.length > 0 && (
          <span className="small" style={{ color: 'var(--muted)' }}>
            {rows.length} repo
            {summary.dirty > 0 && <> · <b style={{ color: STATE_META.dirty.color }}>{summary.dirty} cần commit</b></>}
            {summary.behind > 0 && <> · <b style={{ color: STATE_META.behind.color }}>{summary.behind} cần pull</b></>}
            {summary.ahead > 0 && <> · <b style={{ color: STATE_META.ahead.color }}>{summary.ahead} cần push</b></>}
          </span>
        )}

        <span style={{ flex: 1 }} />

        <button className="sm" onClick={check} disabled={anyBusy} title="git status cho mọi repo">
          {loading ? <span className="spinner" aria-hidden /> : '↻'} Kiểm tra tất cả
        </button>
        <button
          className="sm"
          onClick={pullAll}
          disabled={anyBusy || (rows.length > 0 && pullableCount === 0)}
          title="git pull --ff-only mọi repo (bỏ qua repo có thay đổi chưa commit)"
        >
          {busy === 'pull-all' ? <span className="spinner" aria-hidden /> : '↓'} Pull tất cả{pullableCount > 0 ? ` (${pullableCount})` : ''}
        </button>
        {rows.length > 0 && (
          <button className="ghost sm" onClick={() => setOpen((o) => !o)} disabled={anyBusy}>
            {open ? 'Ẩn' : 'Hiện'}
          </button>
        )}
      </div>

      {err && <pre className="code" style={{ color: 'var(--err)', marginTop: 10, marginBottom: 0 }}>{err}</pre>}

      {conflicts.length > 0 && (
        <div className="badge warn" style={{ marginTop: 10 }}>
          ⚠ {conflicts.length} repo xung đột (không fast-forward được):{' '}
          <b>{conflicts.map((c) => rows.find((r) => r.path === c.path)?.name ?? c.path).join(', ')}</b>
        </div>
      )}

      {open && rows.length > 0 && (
        <div className="repo-grid" style={{ marginTop: 12 }}>
          {rows.map((r) => {
            const meta = STATE_META[r.state];
            const pull = pulls[r.path];
            const pm = pull ? OUTCOME_META[pull.outcome] : null;
            const canPull = needsPull(r.state);
            const isPulling = pullingPath === r.path;
            return (
              <div
                key={r.path}
                className={`repo-row ${r.path === activeRepo ? 'active' : ''}`}
                onClick={() => onOpenRepo(r.path)}
                title={`Mở ${r.name}`}
              >
                <span style={stateBadge(meta.color)}>{meta.label}</span>
                <code className="repo-name">{r.name}</code>
                <span className="small repo-branch" title={r.error || (r.detached ? 'detached HEAD' : `branch ${r.branch}`)}>
                  {r.state === 'error' ? '—' : `⎇ ${r.detached ? '(detached)' : r.branch}`}
                </span>
                <span className="small repo-counts">
                  {r.changes > 0 && <span title="file thay đổi" style={{ color: STATE_META.dirty.color }}>✎ {r.changes}</span>}
                  {r.ahead > 0 && <span title="commit chưa push" style={{ color: STATE_META.ahead.color }}>↑ {r.ahead}</span>}
                  {r.behind > 0 && <span title="commit chưa pull" style={{ color: STATE_META.behind.color }}>↓ {r.behind}</span>}
                </span>
                {pm && (
                  <span className="small" style={{ color: pm.color, whiteSpace: 'nowrap' }} title={pull?.message}>
                    {pm.label}
                  </span>
                )}
                {canPull && (
                  <button
                    className="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      pullOne(r.path);
                    }}
                    disabled={anyBusy}
                    title={r.state === 'diverged' ? 'git pull --ff-only (có thể xung đột do phân kỳ)' : 'git pull --ff-only'}
                  >
                    {isPulling ? <span className="spinner" aria-hidden /> : '↓ Pull'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(busy === 'pull-all' || pullingPath) && (
        <div className="activity-badge" role="status" aria-live="polite">
          <span className="spinner" aria-hidden />
          <span>{busy === 'pull-all' ? 'Đang pull tất cả repo…' : 'Đang pull repo…'}</span>
        </div>
      )}
    </div>
  );
}

// ── File group block ──────────────────────────────────────────────────────────

interface GroupProps {
  title: string;
  files: ChangedFile[];
  staged: boolean;
  selected: SelectedFile | null;
  onSelect: (f: ChangedFile) => void;
  onRow: (f: ChangedFile) => void;
  rowLabel: string;
  onDiscard?: (f: ChangedFile) => void;
  /** Tooltip for the ✕ discard/remove button (varies by group). */
  discardTitle?: string;
  busy: boolean;
  headerAction: { label: string; onClick: () => void };
}

function FileGroupBlock({
  title,
  files,
  staged,
  selected,
  onSelect,
  onRow,
  rowLabel,
  onDiscard,
  discardTitle = 'Bỏ thay đổi (discard)',
  busy,
  headerAction,
}: GroupProps) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="group-title" style={{ flex: 1 }}>{title} ({files.length})</span>
        <button className="ghost sm" onClick={headerAction.onClick} disabled={busy}>{headerAction.label}</button>
      </div>
      <div className="endpoint-list">
        {files.map((f) => {
          const isSel = selected?.path === f.path && selected?.staged === staged;
          return (
            <div
              key={`${f.group}:${f.path}`}
              className={`ep-item ${isSel ? 'active' : ''}`}
              onClick={() => onSelect(f)}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span className={`git-badge ${gitBadgeClass(f.code)}`} title={f.code} style={gitBadgeStyle(f.code)}>
                {codeLabel(f.code)}
              </span>
              <code className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.origPath ? `${f.origPath} → ${f.path}` : f.path}
              </code>
              {onDiscard && (
                <button
                  className="ghost sm"
                  onClick={(e) => { e.stopPropagation(); onDiscard(f); }}
                  disabled={busy}
                  title={discardTitle}
                >
                  ✕
                </button>
              )}
              <button
                className="ghost sm"
                onClick={(e) => { e.stopPropagation(); onRow(f); }}
                disabled={busy}
                title={rowLabel}
              >
                {rowLabel}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function gitBadgeClass(code: string): string {
  const c = code === '??' ? 'A' : code[0] !== '.' && code[0] !== '?' ? code[0] : code[1];
  return `gb-${c}`;
}

/** Inline colour by change type (kept local — no CSS file dependency). */
function gitBadgeStyle(code: string): React.CSSProperties {
  const label = codeLabel(code);
  const color =
    label === 'deleted' || label === 'conflict'
      ? 'var(--err, #f85149)'
      : label === 'new' || label === 'added'
        ? 'var(--ok, #3fb950)'
        : label === 'renamed' || label === 'copied'
          ? 'var(--accent, #6c8cff)'
          : 'var(--muted)';
  return {
    color,
    border: `1px solid ${color}`,
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '.03em',
    whiteSpace: 'nowrap',
  };
}
