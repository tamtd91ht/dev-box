'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchGitProjects,
  mutateGitProject,
  type GitProjectsState,
  gitAction,
  codeLabel,
  defaultCloneName,
  type CloneResult,
  type DiscardAllResult,
  type RepoInfo,
  type RepoStatus,
  type BranchInfo,
  type ChangedFile,
  type FileVersions,
  type CommitLog,
  type CommitDetail,
  type CommitFile,
  type RepoOverview,
  type RepoState,
  type PullResult,
  type GitProject,
  type ReviewMrResult,
  type MergeRequestSummary,
  type ListMrsResult,
  type MergeMrResult,
  type MergeResult,
  type GitLabTokenStatusResult,
  type ListGitLabTokensResult,
  type ListNamespacesResult,
  type NamespaceOption,
  type CreateRepoResult,
  GITLAB_PATH_RE,
} from '@/lib/git';
import FolderPicker from './FolderPicker';

/** localStorage keys remembering the last-selected project + repo. */
import { readLocal, writeLocal } from '@/lib/localKeys';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';
import DiffView from './git/DiffView';

const LAST_REPO_KEY = 'git.lastRepo';
const LAST_PROJECT_KEY = 'git.lastProject';

interface SelectedFile {
  path: string;
  staged: boolean;
}

/** "+12 −3" cho một file; "nhị phân" khi git không đếm dòng được. */
function churnLabel(f: CommitFile): string {
  if (f.added === null || f.removed === null) return 'nhị phân';
  const parts: string[] = [];
  if (f.added) parts.push(`+${f.added}`);
  if (f.removed) parts.push(`−${f.removed}`);
  return parts.join(' ') || '±0';
}

/** Tổng churn của cả commit, bỏ qua file nhị phân (không có số để cộng). */
function churnSummary(files: CommitFile[]): string {
  let added = 0;
  let removed = 0;
  let binary = 0;
  for (const f of files) {
    if (f.added === null || f.removed === null) binary++;
    else {
      added += f.added;
      removed += f.removed;
    }
  }
  const bits: string[] = [];
  if (added) bits.push(`+${added}`);
  if (removed) bits.push(`−${removed}`);
  if (binary) bits.push(`${binary} nhị phân`);
  return bits.join(' · ');
}

/** ISO → "14/08/2026 08:51" (giờ địa phương), cho dòng meta của commit. */
function fmtCommitDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
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
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const listSplit = useSplit({ varName: '--split-rail', min: 180, max: 560, gap: 18 });
  // Tab Lịch sử có tỉ lệ khác hẳn tab Thay đổi (danh sách commit hẹp, chỗ đọc
  // diff rộng) nên dùng BIẾN RIÊNG — dùng chung '--split-rail' thì kéo bên này
  // lại đổi luôn bên kia, và biến CSS di truyền xuống con nên rất khó lần ra.
  const historySplit = useSplit({ varName: '--split-log', min: 220, max: 620, gap: 18 });
  /** Split TRONG panel chi tiết commit: cột file (trái) | diff (phải). Tách
   *  var riêng với hai split ngoài — biến CSS di truyền, trùng tên là cấp
   *  trong ăn nhầm số của cấp ngoài (xem chú thích useSplit). */
  const commitSplit = useSplit({ varName: '--split-cfiles', min: 200, max: 640, gap: 14 });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // ── Projects (named root folders) ───────────────────────────────────────────
  const [projects, setProjects] = useState<GitProject[]>([]);
  const [projectsConfigured, setProjectsConfigured] = useState(false);
  const [safeBase, setSafeBase] = useState('');
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  // Clone dialog — clones a remote repo into the active project's root folder.
  const [cloneOpen, setCloneOpen] = useState(false);
  // Create dialog — creates a NEW GitLab project, then clones it into that root.
  const [createOpen, setCreateOpen] = useState(false);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repo, setRepo] = useState<string>('');
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [branchInfo, setBranchInfo] = useState<BranchInfo | null>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [diff, setDiff] = useState<string>('');
  /** File open in the side-by-side before/after viewer (null = closed). */
  const [viewFile, setViewFile] = useState<{ file: ChangedFile; staged: boolean } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState('');
  const [showBranches, setShowBranches] = useState(false);
  // ── Local merge (branch A → branch hiện tại, kiểu SourceTree) ────────────────
  // `mergeFrom` = ref được chọn để merge vào branch đang checkout; `mergeNoFf` ép
  // tạo merge commit; `mergeConflicts` giữ danh sách file conflict của lần merge
  // gần nhất để hiển thị ngay dưới panel.
  const [mergeFrom, setMergeFrom] = useState('');
  const [mergeNoFf, setMergeNoFf] = useState(false);
  const [mergeConflicts, setMergeConflicts] = useState<string[]>([]);
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
  /** Gập toàn bộ phần đầu (tab dự án, TẤT CẢ REPO, thanh repo) để nhường chỗ
   *  tối đa cho vùng diff — hàng tab Thay đổi/History trở thành thanh tóm tắt
   *  mỏng (tên repo + branch + Pull/Push/↻). Nhớ lựa chọn qua các lần mở app. */
  const [headerHidden, setHeaderHidden] = useState(false);
  useEffect(() => { if (readLocal('git.headerCollapsed') === '1') setHeaderHidden(true); }, []);
  const toggleHeader = useCallback(() => {
    setHeaderHidden((v) => { writeLocal('git.headerCollapsed', v ? '0' : '1'); return !v; });
  }, []);
  const [commits, setCommits] = useState<CommitLog[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  // ── Xem nội dung thay đổi của một commit trong tab Lịch sử ──────────────────
  // `openCommit` = commit đang mở (null = chỉ xem danh sách). Danh sách file tải
  // trước; patch của từng file tải khi bấm, vì một commit có thể đụng hàng trăm
  // file mà người xem chỉ mở vài cái.
  const [openCommit, setOpenCommit] = useState<CommitDetail | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitFile, setCommitFile] = useState<string>('');
  const [commitDiff, setCommitDiff] = useState<string>('');
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  /** Hiện phần mô tả (body) của commit message. Một cờ chung cho cả phiên chứ
   *  không theo từng commit: ai đã gập là đang muốn dồn chỗ cho diff, mở commit
   *  khác cũng vẫn muốn thế. */
  const [commitBodyOpen, setCommitBodyOpen] = useState(true);
  // Per-repo overview (state/ahead/behind) shared by the repo dropdown and the
  // all-repos panel. Keyed by repo path. Populated lazily on dropdown open / check.
  const [overview, setOverview] = useState<Record<string, RepoOverview>>({});
  const [overviewLoading, setOverviewLoading] = useState(false);

  const repoRef = useRef(repo);
  repoRef.current = repo;
  const projectRef = useRef(activeProjectId);
  projectRef.current = activeProjectId;

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
    setViewFile(null);
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

  /** Mở một commit: tải thân message + danh sách file, chọn sẵn file đầu tiên. */
  const openCommitDetail = useCallback(async (hash: string) => {
    const path = repoRef.current;
    if (!path) return;
    setCommitLoading(true);
    setOpenCommit(null);
    setCommitFile('');
    setCommitDiff('');
    try {
      const d = await gitAction<CommitDetail>('commit-detail', { repo: path, hash });
      if (repoRef.current !== path) return;
      setOpenCommit(d);
      // Mở sẵn file đầu tiên: gần như lần nào người xem cũng muốn thấy diff ngay,
      // bắt bấm thêm một nhát nữa chỉ để thấy thứ hiển nhiên là thừa.
      if (d.files.length) setCommitFile(d.files[0].path);
    } catch (e) {
      if (repoRef.current !== path) return;
      setError((e as Error).message);
    } finally {
      setCommitLoading(false);
    }
  }, []);

  /** Patch của MỘT file trong commit đang mở — tải khi chọn file. */
  useEffect(() => {
    if (!repo || !openCommit || !commitFile) {
      setCommitDiff('');
      return;
    }
    let cancelled = false;
    const hash = openCommit.hash;
    setCommitDiffLoading(true);
    gitAction<{ diff: string }>('commit-diff', { repo, hash, file: commitFile })
      .then((r) => {
        if (!cancelled) setCommitDiff(r.diff);
      })
      .catch((e) => {
        if (!cancelled) setCommitDiff(`# không lấy được diff: ${(e as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setCommitDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, openCommit, commitFile]);

  // Đổi repo/branch thì commit đang mở không còn thuộc ngữ cảnh nào — đóng lại,
  // nếu không panel bên phải vẫn vẽ diff của repo cũ.
  useEffect(() => {
    setOpenCommit(null);
    setCommitFile('');
    setCommitDiff('');
  }, [repo, status?.branch]);

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
  // Chưa có repo nào thì BUỘC hiện phần đầu — mọi lối cấu hình nằm ở đó.
  const headerCollapsed = headerHidden && repos.length > 0;
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
    setSelected(null);
  }

  // A fresh clone lands under the active project's root → re-detect the repos of
  // that project, then select the new one.
  async function afterClone(res: CloneResult) {
    setCloneOpen(false);
    await loadRepos(projectRef.current);
    setRepo(res.path);
    flash(`Đã clone ${res.name}`);
  }

  // A new GitLab project was created. When it was cloned too, treat it exactly
  // like a fresh clone. When the clone failed the project still exists on GitLab,
  // so the modal stays open to show the URL + the reason — don't close it here.
  async function afterCreate(res: CreateRepoResult) {
    if (!res.clone) return;
    setCreateOpen(false);
    await loadRepos(projectRef.current);
    setRepo(res.clone.path);
    flash(`Đã tạo & clone ${res.project.pathWithNamespace}`);
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
    setMergeConflicts([]); // stale — they belonged to the previous branch
    setSelected(null);
  }

  /**
   * Merge the selected branch INTO the branch currently checked out — the
   * SourceTree "Merge <branch> into <current>" action. Runs outside run() because
   * a conflict is a legitimate outcome that must NOT be rendered as an error: the
   * merge stays in progress and the conflicted files are listed for the user.
   */
  async function doMerge() {
    const ref = mergeFrom.trim();
    if (!ref || !repo || busy || !status) return;
    const target = status.branch;
    const summary = [
      `Merge "${ref}" vào branch hiện tại "${target}"?`,
      '',
      mergeNoFf
        ? '• Luôn tạo merge commit (--no-ff)'
        : '• Fast-forward nếu có thể, ngược lại tạo merge commit',
      '• Nếu conflict: merge được giữ lại để bạn xử lý thủ công',
    ];
    if (!window.confirm(summary.join('\n'))) return;

    setBusy(true);
    setError(null);
    setMergeConflicts([]);
    try {
      const res = await gitAction<MergeResult>('merge', { repo, branch: ref, noFf: mergeNoFf });
      if (repoRef.current === repo) {
        setStatus(res.status);
        setBranchInfo(res.branches);
      }
      setSelected(null);
      // Fetch hỏng nghĩa là đã merge bản local (có thể cũ) — phải nói rõ, vì đó
      // đúng là tình huống mà fetch sinh ra để tránh.
      const staleWarn = res.fetched && !res.fetched.ok
        ? ` ⚠ không fetch được ${res.fetched.remote} (${res.fetched.error ?? 'lỗi'}) — đã merge bản local có thể đã cũ`
        : '';
      if (res.outcome === 'conflict') {
        setMergeConflicts(res.conflicts);
        setError(res.output + staleWarn);
      } else {
        setMergeFrom('');
        const label =
          res.outcome === 'up-to-date'
            ? `"${target}" đã có sẵn "${ref}"`
            : res.outcome === 'fast-forward'
              ? `Fast-forward "${ref}" → "${target}"`
              : `Đã merge "${ref}" → "${target}"`;
        if (staleWarn) setError(label + staleWarn);
        else flash(label);
      }
    } catch (e) {
      setError(`Merge failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** Abort the in-progress merge, restoring the pre-merge state. */
  async function doAbortMerge() {
    if (!repo || busy) return;
    if (!window.confirm('Hủy merge đang dở dang và quay lại trạng thái trước khi merge?')) return;
    await run('Hủy merge', async () => {
      const res = await gitAction<{ output: string; status: RepoStatus; branches: BranchInfo }>(
        'abort-merge',
        { repo },
      );
      if (repoRef.current === repo) setBranchInfo(res.branches);
      return { output: res.output, status: res.status };
    });
    setMergeConflicts([]);
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
      {!headerCollapsed && <ProjectTabs
        projects={projects}
        activeId={activeProjectId}
        configured={projectsConfigured}
        manageOpen={manageOpen}
        onSelect={(id) => setActiveProjectId(id)}
        onToggleManage={() => setManageOpen((o) => !o)}
        onChanged={(next, preferId) => {
          // Server trả kèm `configured` nên áp thẳng, KHÔNG GET lại: danh sách
          // rỗng có thể là "chưa cấu hình" hoặc "vừa xoá hết" — chỉ server phân
          // biệt được (xem listProjects trong lib/gitProjects) — mà thêm một
          // vòng GET nữa thì chỉ cần nó lỗi vặt là cả tab Git chuyển sang màn
          // "Git tool đang tắt".
          setProjects(next.projects);
          setProjectsConfigured(next.configured);
          if (next.base) setSafeBase(next.base);
          setActiveProjectId((cur) => {
            const candidates = [preferId, cur].filter(Boolean) as string[];
            return candidates.find((id) => next.projects.some((p) => p.id === id))
              ?? next.projects[0]?.id
              ?? '';
          });
        }}
      />}

      {!headerCollapsed && activeProject && (
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
            onClick={() => setCreateOpen(true)}
            disabled={busy || !!commandRunning}
            title={`Tạo repo mới trên GitLab rồi clone về ${activeProject.root}`}
          >
            ⊕ Tạo repo…
          </button>
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
              <b>Clone repo…</b> để tải một repo về thư mục này, hoặc <b>Tạo repo…</b> để tạo repo mới trên GitLab.
            </p>
          )}
        </div>
      ) : (
        <>
      {/* ── All-repos overview (status check + pull all) ───────────────────── */}
      {!headerCollapsed && <AllReposPanel
        activeRepo={repo}
        projectId={activeProjectId}
        rows={overviewRows}
        loading={overviewLoading}
        onCheck={loadOverview}
        onOpenRepo={(p) => setRepo(p)}
        onAfterPull={() => refresh(repo)}
      />}

      {/* ── Repo + branch bar ──────────────────────────────────────────────── */}
      {!headerCollapsed && (
      <div className="panel">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="small" style={{ color: 'var(--muted)' }}>Repo</label>
          {/* CỐ Ý không tự kiểm tra khi mở dropdown: mỗi lần mở là chạy `git
              status` cho TẤT CẢ repo, mở ra mở vào vài lần là spam. Badge (↓)
              chỉ hiện sau khi bấm "Kiểm tra tất cả" ở panel phía trên — kiểm
              tra là việc chủ động, không phải tác dụng phụ của việc mở menu. */}
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            disabled={busy}
            title={overviewLoading ? 'Đang kiểm tra trạng thái repo…' : 'Chọn repo — bấm “Kiểm tra tất cả” ở trên để xem repo nào cần pull (↓)'}
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

            {/* ── Merge branch khác vào branch hiện tại (kiểu SourceTree) ────── */}
            <div style={{ marginTop: 14, borderTop: '1px solid var(--border, rgba(127,127,127,.2))', paddingTop: 12 }}>
              {branchInfo.merging ? (
                // Merge dở dang: không cho merge tiếp — chỉ xử lý conflict rồi commit,
                // hoặc hủy về trạng thái trước.
                <>
                  <div className="badge warn" style={{ marginBottom: 8 }}>
                    ⚠ Đang có merge dở dang — xử lý conflict rồi <b>Commit</b> để hoàn tất, hoặc hủy merge.
                  </div>
                  <button className="ghost sm" onClick={doAbortMerge} disabled={busy || !!commandRunning} title="git merge --abort">
                    ✕ Hủy merge
                  </button>
                </>
              ) : (
                <>
                  <div className="small" style={{ color: 'var(--muted)', marginBottom: 8 }}>
                    Merge vào branch hiện tại{status && !status.detached ? <> (<b>{status.branch}</b>)</> : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      value={mergeFrom}
                      onChange={(e) => setMergeFrom(e.target.value)}
                      style={{ flex: 1, minWidth: 200, maxWidth: 300, fontFamily: 'var(--mono)', fontSize: 12 }}
                      disabled={busy || !!commandRunning || !!status?.detached}
                    >
                      <option value="">— chọn branch nguồn —</option>
                      {branchInfo.branches
                        .filter((b) => b !== branchInfo.current)
                        .map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      {branchInfo.remotes.length > 0 && (
                        <optgroup label="remote">
                          {branchInfo.remotes.map((b) => (
                            <option key={b} value={b}>{b}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)' }} title="Luôn tạo merge commit kể cả khi fast-forward được">
                      <input
                        type="checkbox"
                        checked={mergeNoFf}
                        onChange={(e) => setMergeNoFf(e.target.checked)}
                        disabled={busy || !!commandRunning}
                      />
                      no-ff
                    </label>
                    <button
                      className="sm"
                      onClick={doMerge}
                      disabled={busy || !!commandRunning || !mergeFrom.trim() || !!status?.detached}
                      title={`git merge ${mergeFrom || '<branch>'}`}
                    >
                      ⤵ Merge
                    </button>
                  </div>
                  {status?.detached && (
                    <div className="small" style={{ color: 'var(--muted)', marginTop: 6 }}>
                      Đang detached HEAD — checkout một branch trước khi merge.
                    </div>
                  )}
                </>
              )}

              {mergeConflicts.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="small" style={{ color: 'var(--err)', marginBottom: 4 }}>
                    {mergeConflicts.length} file conflict:
                  </div>
                  <pre className="code" style={{ margin: 0, maxHeight: 140, overflow: 'auto' }}>
                    {mergeConflicts.join('\n')}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}

        {error && <pre className="code" style={{ color: 'var(--err)', marginTop: 10, marginBottom: 0 }}>{error}</pre>}
        {notice && <div className="small" style={{ color: 'var(--ok)', marginTop: 10 }}>{notice}</div>}
      </div>
      )}

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
        {/* Đang gập phần đầu: hàng tab kiêm luôn thanh tóm tắt — phân cấp
            Project › Repo CHỌN ĐƯỢC tại chỗ (khỏi phải Mở rộng chỉ để nhảy
            repo khác), kèm badge branch và bộ nút tối thiểu Pull/Push/↻. */}
        {headerCollapsed && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 6, minWidth: 0 }}>
            <select
              value={activeProjectId}
              onChange={(e) => setActiveProjectId(e.target.value)}
              disabled={busy || !!commandRunning}
              title="Project — thư mục gốc chứa các repo"
              style={{ padding: '4px 6px', fontSize: 12, maxWidth: 150 }}
            >
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span aria-hidden style={{ color: 'var(--muted)' }}>›</span>
            <select
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              disabled={busy || !!commandRunning || reposLoading}
              title={repo || 'Chọn repo'}
              style={{ padding: '4px 6px', fontFamily: 'var(--mono)', fontSize: 12, maxWidth: 300 }}
            >
              {repos.map((r) => (
                <option key={r.path} value={r.path}>{repoOptionLabel(r.name, overview[r.path])}</option>
              ))}
            </select>
            {status && (
              <span
                className={branchWarn ? 'badge warn' : 'badge info'}
                style={{ fontFamily: 'var(--mono)' }}
                title={branchWarn
                  ? `Repo đang ở branch ${status.branch} — quy ước dự án: code trên dev`
                  : 'branch hiện tại'}
              >
                ⎇ {status.detached ? '(detached)' : status.branch}
                {status.ahead > 0 ? ` ↑${status.ahead}` : ''}
                {status.behind > 0 ? ` ↓${status.behind}` : ''}
              </span>
            )}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {headerCollapsed && (
          <>
            <button className="ghost sm" onClick={() => run('Pull', () => gitAction('pull', { repo }))}
              disabled={busy || !!commandRunning} title="git pull --ff-only">↓ Pull</button>
            <button className="ghost sm" onClick={() => run('Push', () => gitAction('push', { repo }))}
              disabled={busy || !!commandRunning || (!!status && status.ahead === 0 && !!status.upstream)}
              title="git push">↑ Push{status && status.ahead > 0 ? ` (${status.ahead})` : ''}</button>
            <button className="ghost sm" onClick={() => refresh(repo)} disabled={busy || !!commandRunning}
              title="Làm mới trạng thái">↻</button>
          </>
        )}
        {view === 'history' && !headerCollapsed && (
          <button className="ghost sm" onClick={() => loadLog(repo)} disabled={logLoading} title="Làm mới history">
            ↻
          </button>
        )}
        <button
          className="ghost sm"
          onClick={toggleHeader}
          aria-expanded={!headerCollapsed}
          title={headerCollapsed
            ? 'Hiện lại phần trên (chọn repo, TẤT CẢ REPO, branch/merge…)'
            : 'Thu gọn phần trên — nhường tối đa chỗ cho vùng diff'}
        >
          {headerCollapsed ? '⌄ Mở rộng' : '⌃ Thu gọn'}
        </button>
      </div>

      {/* Gập phần đầu thì lỗi/thông báo (vốn nằm trong panel repo) phải hiện ở
          đây — pull/push lỗi mà im lặng thì tưởng đã xong. */}
      {headerCollapsed && (error || notice) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {error && <pre className="code" style={{ color: 'var(--err)', margin: 0 }}>{error}</pre>}
          {notice && <div className="small" style={{ color: 'var(--ok)' }}>{notice}</div>}
        </div>
      )}

      {view === 'history' ? (
        /* ── History: danh sách commit | nội dung thay đổi ───────────────── */
        <div className="layout layout-log" ref={historySplit.ref} style={historySplit.style}>
          <div className="panel">
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
                  <button
                    key={c.hash}
                    type="button"
                    className={`log-row log-pick${openCommit?.hash === c.hash ? ' active' : ''}`}
                    onClick={() => openCommitDetail(c.hash)}
                    title={`${c.hash}\n${c.author} · ${c.date}\n\nBấm để xem nội dung thay đổi`}
                  >
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
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Phải: chi tiết commit. Bố cục CHIA CỘT chứ không xếp chồng —
              bản cũ xếp dọc (message → danh sách file → diff) nên diff luôn bị
              đẩy xuống đáy, còn chưa đến 1/4 màn hình khi commit đụng ~10 file.
              Giờ: header + mô tả (gập được) chiếm dải mỏng trên cùng, phần còn
              lại là file (trái) | diff (phải) — diff ăn gần trọn chiều cao,
              đúng bố cục GitHub Desktop/Fork. */}
          <div className="panel commit-pane">
            {commitLoading ? (
              <div className="empty" style={{ padding: '24px 8px' }}>
                <div className="empty-ico">⌛</div>
                <p className="small">Đang tải nội dung commit…</p>
              </div>
            ) : !openCommit ? (
              <div className="empty">
                <div className="empty-ico">≡</div>
                <p>Chọn một commit bên trái để xem nội dung thay đổi.</p>
              </div>
            ) : (
              <>
                <div className="status-line">
                  <h3 style={{ margin: 0, flex: 1, minWidth: 0 }}>{openCommit.subject}</h3>
                  {openCommit.merge && (
                    <span className="badge info" title="Commit merge — so với cha thứ nhất">
                      merge
                    </span>
                  )}
                  <code className="log-hash" title={openCommit.hash}>
                    {openCommit.shortHash}
                  </code>
                </div>
                <div
                  className="small"
                  style={{ color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {openCommit.author} · {openCommit.relDate} · {fmtCommitDate(openCommit.date)}
                  </span>
                  {openCommit.body && (
                    <button
                      className={`ghost sm${commitBodyOpen ? ' on' : ''}`}
                      onClick={() => setCommitBodyOpen((v) => !v)}
                      title={commitBodyOpen
                        ? 'Gập mô tả commit — nhường chỗ cho diff'
                        : 'Hiện mô tả đầy đủ của commit'}
                    >
                      {commitBodyOpen ? '⌃' : '⌄'} Mô tả
                    </button>
                  )}
                </div>

                {openCommit.body && commitBodyOpen && (
                  <pre
                    className="code"
                    style={{ marginTop: 8, maxHeight: '16vh', overflow: 'auto', whiteSpace: 'pre-wrap', flex: 'none' }}
                  >
                    {openCommit.body}
                  </pre>
                )}

                {openCommit.files.length === 0 ? (
                  <div className="empty" style={{ padding: '18px 8px' }}>
                    <div className="empty-ico">≡</div>
                    <p className="small">
                      Commit này không đổi file nào (commit rỗng, hoặc merge không mang thay đổi vào
                      nhánh này).
                    </p>
                  </div>
                ) : (
                  <div className="commit-detail" ref={commitSplit.ref} style={commitSplit.style}>
                    <div className="commit-detail-files">
                      <div className="status-line">
                        <h3 style={{ margin: 0, flex: 1, fontSize: 13 }}>
                          {openCommit.files.length} file thay đổi
                        </h3>
                        <span className="small" style={{ color: 'var(--muted)' }}>
                          {churnSummary(openCommit.files)}
                        </span>
                      </div>
                      <div className="commit-files">
                        {openCommit.files.map((f) => (
                          <button
                            key={f.path}
                            type="button"
                            className={`commit-file${commitFile === f.path ? ' active' : ''}`}
                            onClick={() => setCommitFile(f.path)}
                            title={f.oldPath ? `${f.oldPath}  →  ${f.path}` : f.path}
                          >
                            <span className={`cf-badge st-${f.status}`}>{f.status}</span>
                            <span className="cf-path">
                              {f.oldPath && <span className="cf-old">{f.oldPath} → </span>}
                              {f.path}
                            </span>
                            <span className="cf-churn small">{churnLabel(f)}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="commit-detail-diff">
                      {!commitFile ? (
                        <div className="empty" style={{ padding: '24px 8px' }}>
                          <div className="empty-ico">≡</div>
                          <p className="small">Chọn một file bên trái để xem diff.</p>
                        </div>
                      ) : commitDiffLoading ? (
                        <div className="empty" style={{ padding: '24px 8px' }}>
                          <div className="empty-ico">⌛</div>
                          <p className="small">đang tải diff…</p>
                        </div>
                      ) : (
                        /* Tên file do DiffView hiện — bỏ <h3> ở đây, nếu không
                           cùng một đường dẫn hiện hai lần liền nhau. */
                        <DiffView patch={commitDiff} path={commitFile} />
                      )}
                    </div>
                    <Splitter {...commitSplit.grip} />
                  </div>
                )}
              </>
            )}
          </div>
          <Splitter {...historySplit.grip} />
        </div>
      ) : (
      /* ── Changes + diff ─────────────────────────────────────────────────── */
      <div className="layout" ref={listSplit.ref} style={listSplit.style}>
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
              onView={(f) => setViewFile({ file: f, staged: true })}
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
              onView={(f) => setViewFile({ file: f, staged: false })}
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
              onView={(f) => setViewFile({ file: f, staged: false })}
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
              {/* Đường dẫn + badge + số dòng nằm TRONG DiffView để đi kèm công
                  tắc chế độ xem — tách thành hàng riêng thì hai cụm thông tin về
                  cùng một file lại ở hai chỗ. DiffView cũng tự lo ca "không có
                  diff" (binary / file mới chưa stage). */}
              <DiffView
                patch={diff}
                path={selected.path}
                badge={selected.staged ? 'staged' : 'working'}
              />
            </>
          ) : (
            <div className="empty">
              <div className="empty-ico">≡</div>
              <p>Chọn một file bên trái để xem diff.</p>
            </div>
          )}
        </div>
        <Splitter {...listSplit.grip} />
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

      {createOpen && activeProject && (
        <CreateRepoModal
          projectId={activeProjectId}
          projectName={activeProject.name}
          root={activeProject.root}
          existingNames={repos.map((r) => r.name)}
          onClose={() => setCreateOpen(false)}
          onCreated={afterCreate}
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

      {viewFile && repo && (
        <DiffViewerModal
          repo={repo}
          file={viewFile.file}
          staged={viewFile.staged}
          onClose={() => setViewFile(null)}
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

// ── Create repo modal (new GitLab project → clone) ──────────────────────────────

interface CreateRepoModalProps {
  /** Project whose root folder the new repo is cloned into. */
  projectId: string;
  projectName: string;
  root: string;
  /** Repo folder names already in the root — used to warn before submitting. */
  existingNames: string[];
  onClose: () => void;
  onCreated: (res: CreateRepoResult) => void;
}

/**
 * Create a brand-new project on GitLab and clone it into the active project's
 * root — the other half of CloneRepoModal, which only brings down repos that
 * already exist.
 *
 * The host can't be derived from a repo's `origin` here (there is no repo yet),
 * so it is typed, with the hosts that already have a saved PAT offered as
 * suggestions. Namespaces load from the host once it's known, so the user picks a
 * group instead of remembering a numeric namespace id.
 */
function CreateRepoModal({ projectId, projectName, root, existingNames, onClose, onCreated }: CreateRepoModalProps) {
  const [host, setHost] = useState('');
  const [knownHosts, setKnownHosts] = useState<string[]>([]);
  const [namespaces, setNamespaces] = useState<NamespaceOption[]>([]);
  const [namespaceId, setNamespaceId] = useState('');
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState<string | null>(null);
  const [projPath, setProjPath] = useState('');
  const [name, setName] = useState('');
  // Until the user edits the display name, it follows the path.
  const [nameEdited, setNameEdited] = useState(false);
  const [visibility, setVisibility] = useState('private');
  const [description, setDescription] = useState('');
  const [initReadme, setInitReadme] = useState(true);
  const [doClone, setDoClone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  // Set when the project was created but the clone failed — the project EXISTS,
  // so the form must not be resubmitted as-is.
  const [created, setCreated] = useState<CreateRepoResult | null>(null);

  const path = projPath.trim();
  const label = (nameEdited ? name : projPath).trim();
  const pathValid = !path || GITLAB_PATH_RE.test(path);
  const taken = !!path && existingNames.includes(path);
  const canSubmit = !busy && !created && !!host.trim() && !!path && pathValid && (!doClone || !taken);

  // Hosts with a saved PAT — offered as suggestions, and the first one is a safe
  // default since it's the only host we can authenticate against anyway.
  useEffect(() => {
    let alive = true;
    gitAction<ListGitLabTokensResult>('list-gitlab-tokens')
      .then((res) => {
        if (!alive) return;
        const hosts = res.tokens.map((t) => t.host);
        setKnownHosts(hosts);
        setHost((h) => h || hosts[0] || '');
      })
      .catch(() => {
        /* suggestions are optional — the host can always be typed */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Load the namespaces of `host` (needs its saved token). Called on blur and
  // after a token is saved, not on every keystroke.
  const loadNamespaces = useCallback(async () => {
    const h = host.trim();
    if (!h) return;
    setNsLoading(true);
    setNsError(null);
    try {
      const res = await gitAction<ListNamespacesResult>('list-gitlab-namespaces', { host: h });
      setNamespaces(res.namespaces);
      // Default to the personal namespace, which listNamespaces sorts first.
      setNamespaceId((cur) => cur || (res.namespaces[0] ? String(res.namespaces[0].id) : ''));
    } catch (e) {
      setNamespaces([]);
      setNsError((e as Error).message);
    } finally {
      setNsLoading(false);
    }
  }, [host]);

  // Auto-load once for the prefilled host so the namespace picker is ready.
  const autoLoaded = useRef('');
  useEffect(() => {
    const h = host.trim();
    if (h && autoLoaded.current !== h) {
      autoLoaded.current = h;
      loadNamespaces();
    }
  }, [host, loadNamespaces]);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await gitAction<CreateRepoResult>('create-repo', {
        projectId,
        host: host.trim(),
        path,
        name: label,
        namespaceId: namespaceId || undefined,
        visibility,
        description: description.trim(),
        initReadme,
        clone: doClone,
      });
      setCreated(res);
      // Clone failures keep the modal open (the caller no-ops) so the user can see
      // the project URL and clone it manually.
      if (res.cloneError) setErr(res.cloneError);
      onCreated(res);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [canSubmit, projectId, host, path, label, namespaceId, visibility, description, initReadme, doClone, onCreated]);

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canSubmit) submit();
  };
  const fieldStyle: React.CSSProperties = { width: '100%', fontFamily: 'var(--mono)', fontSize: 12, marginTop: 4 };

  return (
    // Backdrop click is ignored while working — closing mid-create would hide an
    // operation that already changed state on GitLab.
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Tạo repo mới → {projectName}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div className="small" style={{ color: 'var(--muted)', marginBottom: 10 }}>
          Tạo project trên GitLab qua API{doClone ? <> rồi clone vào <code className="small">{root}</code></> : null}.
          Dùng Personal Access Token đã lưu cho host (scope <code>api</code>).
        </div>

        {/* ── Host + namespace ──────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label className="small" style={{ color: 'var(--muted)' }}>Host GitLab</label>
            <input
              type="text"
              list="gitlab-known-hosts"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onBlur={loadNamespaces}
              placeholder="gitlab.example.com"
              autoFocus
              disabled={busy}
              style={fieldStyle}
            />
            <datalist id="gitlab-known-hosts">
              {knownHosts.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label className="small" style={{ color: 'var(--muted)' }}>
              Namespace {nsLoading ? '· đang tải…' : namespaces.length ? `· ${namespaces.length}` : ''}
            </label>
            <select
              value={namespaceId}
              onChange={(e) => setNamespaceId(e.target.value)}
              disabled={busy || nsLoading || !namespaces.length}
              style={fieldStyle}
            >
              {!namespaces.length && <option value="">— chưa tải được —</option>}
              {namespaces.map((ns) => (
                <option key={ns.id} value={String(ns.id)}>
                  {ns.fullPath}{ns.kind === 'user' ? ' (cá nhân)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        {nsError && (
          <div className="small" style={{ color: 'var(--err)', marginTop: 6 }}>
            {nsError}
            {/token|401|403/i.test(nsError) && (
              <button className="sm" style={{ marginLeft: 8 }} onClick={() => setTokenOpen(true)}>
                🔑 Nhập token GitLab
              </button>
            )}
          </div>
        )}

        {/* ── Path + display name ───────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
          <div style={{ flex: '1 1 200px' }}>
            <label className="small" style={{ color: 'var(--muted)' }}>Path (slug) *</label>
            <input
              type="text"
              value={projPath}
              onChange={(e) => setProjPath(e.target.value)}
              onKeyDown={onEnter}
              placeholder="my-service"
              disabled={busy}
              style={fieldStyle}
            />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label className="small" style={{ color: 'var(--muted)' }}>Tên hiển thị</label>
            <input
              type="text"
              value={label}
              onChange={(e) => {
                setNameEdited(true);
                setName(e.target.value);
              }}
              onKeyDown={onEnter}
              placeholder="mặc định = path"
              disabled={busy}
              style={fieldStyle}
            />
          </div>
        </div>

        {/* ── Visibility + description ──────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
          <div style={{ flex: '0 1 150px' }}>
            <label className="small" style={{ color: 'var(--muted)' }}>Visibility</label>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
              disabled={busy}
              style={fieldStyle}
            >
              <option value="private">private</option>
              <option value="internal">internal</option>
              <option value="public">public</option>
            </select>
          </div>
          <div style={{ flex: '1 1 240px' }}>
            <label className="small" style={{ color: 'var(--muted)' }}>Mô tả (tùy chọn)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={onEnter}
              disabled={busy}
              style={{ ...fieldStyle, fontFamily: 'inherit' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={initReadme} onChange={(e) => setInitReadme(e.target.checked)} disabled={busy} />
            Khởi tạo README (repo có default branch)
          </label>
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={doClone} onChange={(e) => setDoClone(e.target.checked)} disabled={busy} />
            Clone về máy sau khi tạo
          </label>
        </div>

        {!pathValid && (
          <div className="badge warn" style={{ marginTop: 10 }}>
            ⚠ Path chỉ gồm chữ/số/<code>._-</code> và phải bắt đầu bằng chữ hoặc số.
          </div>
        )}
        {doClone && taken && (
          <div className="badge warn" style={{ marginTop: 10 }}>
            ⚠ Thư mục <b>{path}</b> đã có trong project — đổi path khác hoặc bỏ tick clone.
          </div>
        )}

        {/* The project already exists on GitLab — say so plainly, since a retry of
            the same path would now be rejected as taken. */}
        {created && (
          <div className="small" style={{ marginTop: 10 }}>
            <span className="badge ok">✓ Đã tạo trên GitLab</span>{' '}
            <a href={created.project.webUrl} target="_blank" rel="noreferrer">
              {created.project.pathWithNamespace}
            </a>
            <div style={{ color: 'var(--muted)', marginTop: 4, fontFamily: 'var(--mono)' }}>{created.project.httpUrl}</div>
            {created.cloneError && (
              <div style={{ marginTop: 6 }}>
                Chưa clone được — dùng <b>⧉ Clone repo…</b> với URL trên để thử lại.
              </div>
            )}
          </div>
        )}

        {err && <pre className="code" style={{ color: 'var(--err)', margin: '10px 0 0' }}>{err}</pre>}
        {err && !created && /token|401|403/i.test(err) && (
          <button className="sm" style={{ marginTop: 8 }} onClick={() => setTokenOpen(true)}>
            🔑 Nhập token GitLab
          </button>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
          {/* A token is filed per host, so the host must be known before saving one. */}
          <button
            className="ghost sm"
            onClick={() => setTokenOpen(true)}
            disabled={busy || !host.trim()}
            title={host.trim() ? `Token GitLab cho ${host.trim()}` : 'Nhập host GitLab trước'}
          >
            🔑 Token
          </button>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onClose} disabled={busy}>
            {created ? 'Đóng' : 'Hủy'}
          </button>
          <button className="sm" onClick={submit} disabled={!canSubmit} title="Tạo project trên GitLab">
            {busy ? <><span className="spinner" aria-hidden /> Đang tạo…</> : '⊕ Tạo repo'}
          </button>
        </div>

        {busy && doClone && (
          <div className="small" style={{ color: 'var(--muted)', marginTop: 8 }}>
            Tạo project rồi clone về — có thể mất chút thời gian.
          </div>
        )}

        {tokenOpen && (
          <GitLabTokenModal
            host={host.trim()}
            onClose={() => setTokenOpen(false)}
            onSaved={() => {
              setTokenOpen(false);
              setErr(null);
              loadNamespaces();
            }}
          />
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
  /** Authorized repo whose `origin` names the host. Omit when `host` is given. */
  repo?: string;
  /** Explicit host — used when there is no repo yet (creating a new project). */
  host?: string;
  onClose: () => void;
  /** Called after a successful save/remove so the caller can retry its request. */
  onSaved: () => void;
}

/**
 * Save the Personal Access Token used for the GitLab REST API (MR list + merge).
 *
 * This is deliberately separate from the credential `git push` uses: a self-hosted
 * instance may accept an account password over HTTPS for git, but the REST API
 * only accepts a PAT. With a `repo`, the host is derived server-side from its own
 * origin remote so the token can't be filed under the wrong host; the explicit
 * `host` form exists for creating a NEW project, where no repo exists yet.
 * The token is write-only from the browser's point of view: the server returns
 * just a redacted preview, never the value back.
 */
function GitLabTokenModal({ repo, host, onClose, onSaved }: GitLabTokenModalProps) {
  const [status, setStatus] = useState<GitLabTokenStatusResult | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      if (host) {
        // No repo to read `origin` from — match the typed host against the saved
        // list to get the same redacted status the repo-scoped action returns.
        const { tokens } = await gitAction<ListGitLabTokensResult>('list-gitlab-tokens');
        const key = host.trim().toLowerCase();
        setStatus({ host: key, token: tokens.find((t) => t.host === key) ?? null });
      } else {
        setStatus(await gitAction<GitLabTokenStatusResult>('gitlab-token-status', { repo }));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [repo, host]);

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
  manageOpen: boolean;
  onSelect: (id: string) => void;
  onToggleManage: () => void;
  onChanged: (state: GitProjectsState, preferId?: string) => void;
}

/** Horizontal project tab-bar + inline add/edit/remove manager. Each tab is a
 *  named root folder; `configured=false` means the single tab is the implicit
 *  auto-detected default (shown with a hint to add a real project). */
function ProjectTabs({
  projects,
  activeId,
  configured,
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
        const added = next.projects.find((p) => p.root === root.trim())
          ?? next.projects.find((p) => !projects.some((q) => q.id === p.id));
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
    async (id: string, isAuto = false) => {
      const msg = isAuto
        ? 'Bỏ thư mục tự nhận diện khỏi tab Git?\n\nTab Git sẽ trống cho tới khi bạn thêm project. '
          + 'Không xóa gì trên đĩa.'
        : 'Xóa project này khỏi danh sách? (không xóa thư mục trên đĩa)';
      if (!window.confirm(msg)) return;
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
              danh sách repo cho máy này (lưu ở <code className="small">configs/gitprojects.json</code>, đã gitignore).
            </div>
          )}

          {projects.length === 0 && (
            <div className="small" style={{ color: 'var(--muted)', marginBottom: 8 }}>
              Danh sách project đang trống — tab Git chưa trỏ vào thư mục nào. Thêm một project bên dưới.
            </div>
          )}

          {/* Hiện cả khi `!configured`: lúc đó danh sách chỉ có thư mục TỰ NHẬN
              DIỆN, và nó cũng phải bỏ được — nếu không, người dùng xoá project
              cuối cùng xong sẽ thấy nó "mọc lại" mà không còn nút nào để bỏ. */}
          {projects.length > 0 && (
            <div className="proj-list">
              {projects.map((p) => (
                <div key={p.id} className={`proj-list-row ${p.id === editingId ? 'editing' : ''}`}>
                  <code className="proj-list-name">{p.name}</code>
                  {!configured && <span className="proj-tab-badge" title="Thư mục app tự nhận diện, chưa phải project bạn thêm">auto</span>}
                  <code className="small proj-list-root" title={p.root}>{p.root}</code>
                  {configured && <button className="ghost sm" onClick={() => startEdit(p)} disabled={busy}>Sửa</button>}
                  <button
                    className="ghost sm"
                    onClick={() => remove(p.id, !configured)}
                    disabled={busy}
                    title={configured
                      ? 'Bỏ project khỏi danh sách của app (không đụng thư mục trên đĩa)'
                      : 'Bỏ thư mục tự nhận diện — tab Git sẽ trống cho tới khi bạn thêm project'}
                  >{configured ? 'Xóa' : 'Bỏ'}</button>
                </div>
              ))}
            </div>
          )}

          <div className="proj-form" style={{ marginTop: configured ? 10 : 0 }}>
            {/* KHÔNG nhắc `base` ở đây nữa: nó chỉ là thư mục MỞ SẴN của hộp
                chọn, không phải giới hạn. validateRoot chấp nhận mọi thư mục có
                thật trên máy (xem lib/gitProjects) — câu "phải nằm trong…" cũ
                làm người dùng tưởng không thêm được project ở ổ/nhánh khác. */}
            <div className="small" style={{ color: 'var(--muted)', marginBottom: 6 }}>
              {editingId ? 'Sửa project' : 'Thêm project'} — thư mục gốc là thư mục <b>chứa các repo git</b>.
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

// ── Side-by-side file viewer ──────────────────────────────────────────────────

/** One visual row of the split view: either side may be missing (a pure add or
 *  delete), which is what renders as the greyed filler on the opposite side. */
interface SideRow {
  leftNo: number | null;
  rightNo: number | null;
  left: string | null;
  right: string | null;
  kind: 'same' | 'add' | 'del' | 'mod';
}

/**
 * Align two files line-by-line so equal lines sit on the same row.
 *
 * Classic LCS over whole lines. The table is O(n·m), so above LCS_LIMIT lines
 * we fall back to a naive positional zip — a 50k-line file would otherwise lock
 * the browser for seconds to produce a diff nobody reads line-by-line anyway.
 */
const LCS_LIMIT = 3000;

function alignLines(beforeText: string, afterText: string): SideRow[] {
  const a = beforeText === '' ? [] : beforeText.replace(/\r\n/g, '\n').split('\n');
  const b = afterText === '' ? [] : afterText.replace(/\r\n/g, '\n').split('\n');

  if (a.length > LCS_LIMIT || b.length > LCS_LIMIT) {
    const rows: SideRow[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const l = i < a.length ? a[i] : null;
      const r = i < b.length ? b[i] : null;
      rows.push({
        leftNo: l === null ? null : i + 1,
        rightNo: r === null ? null : i + 1,
        left: l,
        right: r,
        kind: l === r ? 'same' : l === null ? 'add' : r === null ? 'del' : 'mod',
      });
    }
    return rows;
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: SideRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ leftNo: i + 1, rightNo: j + 1, left: a[i], right: b[j], kind: 'same' });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ leftNo: i + 1, rightNo: null, left: a[i], right: null, kind: 'del' });
      i++;
    } else {
      rows.push({ leftNo: null, rightNo: j + 1, left: null, right: b[j], kind: 'add' });
      j++;
    }
  }
  while (i < n) rows.push({ leftNo: i + 1, rightNo: null, left: a[i], right: null, kind: 'del' });
  while (j < m) rows.push({ leftNo: null, rightNo: j + 1, left: null, right: b[j], kind: 'add' });

  // Pair each run of deletions with the additions that immediately follow it, so
  // an edited line shows old-vs-new on one row instead of two stacked halves.
  return pairRuns(rows);
}

/** Collapse adjacent del-run + add-run into paired 'mod' rows. */
function pairRuns(rows: SideRow[]): SideRow[] {
  const out: SideRow[] = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k].kind !== 'del') {
      out.push(rows[k]);
      k++;
      continue;
    }
    const dels: SideRow[] = [];
    while (k < rows.length && rows[k].kind === 'del') dels.push(rows[k++]);
    const adds: SideRow[] = [];
    while (k < rows.length && rows[k].kind === 'add') adds.push(rows[k++]);

    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      out.push({
        leftNo: dels[p].leftNo,
        rightNo: adds[p].rightNo,
        left: dels[p].left,
        right: adds[p].right,
        kind: 'mod',
      });
    }
    for (let p = pairs; p < dels.length; p++) out.push(dels[p]);
    for (let p = pairs; p < adds.length; p++) out.push(adds[p]);
  }
  return out;
}

interface FileVersionsSummary {
  added: number;
  removed: number;
  modified: number;
}

function summarize(rows: SideRow[]): FileVersionsSummary {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const r of rows) {
    if (r.kind === 'add') added++;
    else if (r.kind === 'del') removed++;
    else if (r.kind === 'mod') modified++;
  }
  return { added, removed, modified };
}

const SIDE_ROW_BG: Record<SideRow['kind'], { left: string; right: string }> = {
  same: { left: 'transparent', right: 'transparent' },
  add: { left: 'rgba(127,127,127,.06)', right: 'rgba(63,185,80,.14)' },
  del: { left: 'rgba(248,81,73,.14)', right: 'rgba(127,127,127,.06)' },
  mod: { left: 'rgba(248,81,73,.12)', right: 'rgba(63,185,80,.12)' },
};

interface DiffViewerModalProps {
  repo: string;
  file: ChangedFile;
  /** Which comparison to show: staged → HEAD vs index, else index vs worktree. */
  staged: boolean;
  onClose: () => void;
}

/**
 * Full-screen split view of ONE file: the content before the change on the left,
 * after on the right, aligned line-for-line. This is deliberately separate from
 * the unified patch in the right-hand panel — that one answers "what does the
 * patch say", this one answers "what does the file look like on each side".
 *
 * Both panes scroll as one element (a single grid), so the two sides can never
 * drift out of alignment.
 */
function DiffViewerModal({ repo, file, staged, onClose }: DiffViewerModalProps) {
  const [data, setData] = useState<FileVersions | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  /** Hide unchanged lines, keeping a few lines of context around each change. */
  const [onlyChanges, setOnlyChanges] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    gitAction<FileVersions>('file-versions', { repo, file: file.path, staged })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, file.path, staged]);

  // Esc closes, matching the other modals in this workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = useMemo(() => (data ? alignLines(data.before, data.after) : []), [data]);
  const stats = useMemo(() => summarize(rows), [rows]);

  // When collapsing, keep CONTEXT lines on each side of every changed row and
  // mark the gaps so the user sees how much was skipped.
  const CONTEXT = 3;
  const visible = useMemo(() => {
    if (!onlyChanges) return rows.map((r, i) => ({ row: r, index: i, gapBefore: 0 }));
    const keep = new Set<number>();
    rows.forEach((r, i) => {
      if (r.kind === 'same') return;
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) keep.add(k);
    });
    const out: { row: SideRow; index: number; gapBefore: number }[] = [];
    let prev = -1;
    for (let i = 0; i < rows.length; i++) {
      if (!keep.has(i)) continue;
      out.push({ row: rows[i], index: i, gapBefore: i - prev - 1 });
      prev = i;
    }
    return out;
  }, [rows, onlyChanges]);

  const mono: React.CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 12,
    lineHeight: '18px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    padding: '0 8px',
    minWidth: 0,
  };
  const gutter: React.CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    lineHeight: '18px',
    color: 'var(--muted)',
    textAlign: 'right',
    padding: '0 6px',
    userSelect: 'none',
    borderRight: '1px solid var(--border, rgba(127,127,127,.2))',
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(1400px, 96vw)', maxWidth: '96vw', display: 'flex', flexDirection: 'column', maxHeight: '92vh' }}
      >
        <div className="status-line" style={{ gap: 8 }}>
          <span className={`badge ${staged ? 'info' : ''}`}>{staged ? 'staged' : 'working'}</span>
          <span className={`git-badge ${gitBadgeClass(file.code)}`} title={file.code} style={gitBadgeStyle(file.code)}>
            {codeLabel(file.code)}
          </span>
          <code className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
          </code>
          {!loading && !error && !data?.binary && (
            <span className="small" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--ok, #3fb950)' }}>+{stats.added}</span>{' '}
              <span style={{ color: 'var(--err, #f85149)' }}>−{stats.removed}</span>{' '}
              <span style={{ color: 'var(--accent, #6c8cff)' }}>~{stats.modified}</span>
            </span>
          )}
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
            Chỉ dòng thay đổi
          </label>
          <button className="ghost sm" onClick={onClose}>✕ Đóng</button>
        </div>

        {loading && (
          <div className="empty" style={{ padding: '32px 8px' }}>
            <span className="spinner" aria-hidden /> <span className="small">Đang tải nội dung…</span>
          </div>
        )}
        {error && <p className="small" style={{ color: 'var(--err, #f85149)' }}>{error}</p>}

        {!loading && !error && data && (
          <>
            {data.note && <p className="small" style={{ color: 'var(--muted)', margin: '8px 0 0' }}>{data.note}</p>}
            {data.binary ? (
              <div className="empty" style={{ padding: '32px 8px' }}>
                <div className="empty-ico">⛃</div>
                <p className="small">File nhị phân — không hiển thị được nội dung theo dòng.</p>
              </div>
            ) : (
              <div
                style={{
                  marginTop: 10,
                  border: '1px solid var(--border, rgba(127,127,127,.2))',
                  borderRadius: 6,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  flex: 1,
                }}
              >
                {/* Sticky headers — the two panes scroll together below. */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '48px 1fr 48px 1fr',
                    borderBottom: '1px solid var(--border, rgba(127,127,127,.2))',
                    background: 'var(--panel, rgba(127,127,127,.08))',
                  }}
                >
                  <div />
                  <div className="small" style={{ padding: '6px 8px', fontWeight: 600 }}>
                    ← Trước · {data.beforeLabel}
                  </div>
                  <div />
                  <div className="small" style={{ padding: '6px 8px', fontWeight: 600 }}>
                    → Sau · {data.afterLabel}
                  </div>
                </div>

                <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr 48px 1fr', alignItems: 'stretch' }}>
                    {visible.map(({ row, index, gapBefore }) => {
                      const bg = SIDE_ROW_BG[row.kind];
                      return (
                        <React.Fragment key={index}>
                          {gapBefore > 0 && (
                            <div
                              style={{
                                gridColumn: '1 / -1',
                                padding: '2px 8px',
                                fontSize: 11,
                                color: 'var(--muted)',
                                background: 'rgba(127,127,127,.08)',
                                borderTop: '1px solid var(--border, rgba(127,127,127,.2))',
                                borderBottom: '1px solid var(--border, rgba(127,127,127,.2))',
                              }}
                            >
                              ⋯ bỏ qua {gapBefore} dòng không đổi
                            </div>
                          )}
                          <div style={{ ...gutter, background: bg.left }}>{row.leftNo ?? ''}</div>
                          <div style={{ ...mono, background: bg.left }}>{row.left ?? ''}</div>
                          <div style={{ ...gutter, background: bg.right, borderLeft: '1px solid var(--border, rgba(127,127,127,.2))' }}>
                            {row.rightNo ?? ''}
                          </div>
                          <div style={{ ...mono, background: bg.right }}>{row.right ?? ''}</div>
                        </React.Fragment>
                      );
                    })}
                    {!rows.length && (
                      <div className="small" style={{ gridColumn: '1 / -1', padding: 16, color: 'var(--muted)' }}>
                        Hai bên giống hệt nhau (không có thay đổi nội dung).
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
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
  /** Open the side-by-side before/after viewer for this file. */
  onView: (f: ChangedFile) => void;
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
  onView,
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
      <div className="gf-list">
        {files.map((f) => {
          const isSel = selected?.path === f.path && selected?.staged === staged;
          // Tách thư mục / tên file: tên file in đậm màu thường, thư mục mờ đi.
          // Danh sách cũ in cả đường dẫn một màu một cỡ nên mắt phải đọc hết
          // chuỗi mới thấy tên file — trong khi tên file là thứ cần nhận ra đầu
          // tiên. SourceTree cũng tách hai phần như vậy.
          const shown = f.origPath ? `${f.origPath} → ${f.path}` : f.path;
          const cut = shown.lastIndexOf('/');
          const dir = cut >= 0 ? shown.slice(0, cut + 1) : '';
          const base = cut >= 0 ? shown.slice(cut + 1) : shown;
          return (
            <div
              key={`${f.group}:${f.path}`}
              className={`gf-row${isSel ? ' active' : ''}`}
              onClick={() => onSelect(f)}
              title={shown}
            >
              <span className={`git-badge ${gitBadgeClass(f.code)}`} title={f.code} style={gitBadgeStyle(f.code)}>
                {codeLabel(f.code)}
              </span>
              <span className="gf-name">
                {dir && <span className="gf-dir">{dir}</span>}
                <span className="gf-base">{base}</span>
              </span>
              {/* Các nút chỉ hiện khi trỏ vào hàng (hoặc hàng đang chọn). Trước
                  đây ba nút luôn hiện trên MỌI hàng, nên một danh sách 20 file là
                  60 nút giành lấy sự chú ý — chính chỗ làm giao diện rối nhất. */}
              <span className="gf-acts">
                <button
                  className="ghost sm"
                  onClick={(e) => { e.stopPropagation(); onView(f); }}
                  title="Xem thay đổi 2 ô: nội dung trước ↔ sau"
                >⇄</button>
                {onDiscard && (
                  <button
                    className="ghost sm gf-danger"
                    onClick={(e) => { e.stopPropagation(); onDiscard(f); }}
                    disabled={busy}
                    title={discardTitle}
                  >✕</button>
                )}
                <button
                  className="ghost sm"
                  onClick={(e) => { e.stopPropagation(); onRow(f); }}
                  disabled={busy}
                  title={rowLabel}
                >
                  {rowLabel}
                </button>
              </span>
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
