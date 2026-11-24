'use client';

// Clone cả group GitLab: nhập URL/ID group → quét mọi repo (gồm nhóm con) → tick
// chọn → nhập branch (trống = mặc định của từng repo) → chọn thư mục cha → clone.
//
// Clone chạy thành job nền phía server (lib/gitGroupClone) và hộp này chỉ hỏi
// tiến độ — mọi request đều ngắn và đi qua apiFetch nên không dính pool 6 socket.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  gitActionLong,
  mutateGitProject,
  type CloneJob,
  type CloneJobItem,
  type CloneTargetsCheck,
  type GitProject,
  type GitProjectsState,
  type GroupRepo,
  type GroupScanResult,
  type ListGitLabTokensResult,
} from '@/lib/git';
import FolderPicker from '../FolderPicker';

export interface GroupCloneDone {
  /** Thư mục cha (đã chuẩn hoá) các repo được clone vào. */
  parent: string;
  /** Số repo clone thành công trong lượt vừa rồi. */
  cloned: number;
  /** Có khi thư mục cha vừa được thêm thành project mới. */
  state?: GitProjectsState;
  /** Project (cũ hoặc vừa thêm) có root là thư mục cha. */
  projectId?: string;
}

interface Props {
  projects: GitProject[];
  /** Thư mục cha điền sẵn — root của project đang mở, nếu nó chứa được repo. */
  defaultParent: string;
  onClose: () => void;
  /** Gọi sau MỖI lượt clone có ít nhất một repo về — hộp thoại vẫn mở. */
  onDone: (res: GroupCloneDone) => void;
}

const LAST_GROUP_KEY = 'git.groupClone.lastGroup';
const LAST_HOST_KEY = 'git.groupClone.lastHost';

function readLs(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function writeLs(key: string, v: string) {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    /* không lưu được cũng không sao */
  }
}

/** So đường dẫn kiểu Windows: không phân biệt hoa thường, / hay \, dấu cuối. */
function normPath(p: string): string {
  return p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Tên thư mục đích cho từng repo. Mặc định là `path` của project (clone phẳng vào
 * thư mục cha). Hai repo ở hai nhóm con trùng `path` thì lấy đường dẫn tương đối
 * nối bằng "-" để không đè nhau (vd "api-core" và "web-core").
 */
function folderNames(repos: GroupRepo[]): Map<number, string> {
  const count = new Map<string, number>();
  for (const r of repos) count.set(r.path.toLowerCase(), (count.get(r.path.toLowerCase()) ?? 0) + 1);
  const out = new Map<number, string>();
  for (const r of repos) {
    out.set(r.id, (count.get(r.path.toLowerCase()) ?? 0) > 1 ? r.relativePath.replace(/\//g, '-') : r.path);
  }
  return out;
}

const ITEM_META: Record<CloneJobItem['state'], { label: string; color: string }> = {
  pending: { label: 'đang chờ', color: 'var(--muted)' },
  running: { label: 'đang clone…', color: 'var(--accent, #6c8cff)' },
  done: { label: '✓ xong', color: 'var(--ok, #3fb950)' },
  error: { label: '✗ lỗi', color: 'var(--err, #f85149)' },
  cancelled: { label: 'đã dừng', color: 'var(--warn, #d29922)' },
};

export default function GroupCloneModal({ projects, defaultParent, onClose, onDone }: Props) {
  // ── Bước 1: group + quét ────────────────────────────────────────────────────
  const [groupInput, setGroupInput] = useState('');
  const [host, setHost] = useState('');
  const [knownHosts, setKnownHosts] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scan, setScan] = useState<GroupScanResult | null>(null);
  // Thiếu/sai token → mở ô nhập ngay trong hộp này, lưu xong quét lại luôn.
  const [tokenHost, setTokenHost] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [savingToken, setSavingToken] = useState(false);

  // ── Bước 2: chọn repo ───────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [filter, setFilter] = useState('');

  // ── Bước 3: branch + thư mục cha ────────────────────────────────────────────
  const [branch, setBranch] = useState('');
  const [fallbackDefault, setFallbackDefault] = useState(true);
  const [proto, setProto] = useState<'https' | 'ssh'>('https');
  const [parent, setParent] = useState(defaultParent);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [check, setCheck] = useState<CloneTargetsCheck | null>(null);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [checkTick, setCheckTick] = useState(0);
  const [addProject, setAddProject] = useState(true);
  const [projectName, setProjectName] = useState('');

  // ── Bước 4: job clone ───────────────────────────────────────────────────────
  const [job, setJob] = useState<CloneJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);

  const running = starting || (!!job && !job.finished);
  const locked = running || scanning;

  // URL đầy đủ (hoặc "host/path") đã tự mang host → ẩn ô host.
  const inputHasHost = /^https?:\/\//i.test(groupInput.trim()) || /^[^/\s]+\.[^/\s]+\/./.test(groupInput.trim());

  useEffect(() => {
    setGroupInput(readLs(LAST_GROUP_KEY));
    const lastHost = readLs(LAST_HOST_KEY);
    if (lastHost) setHost(lastHost);
    gitActionLong<ListGitLabTokensResult>('list-gitlab-tokens')
      .then(({ tokens }) => {
        const hosts = tokens.map((t) => t.host);
        setKnownHosts(hosts);
        // Chỉ có đúng một host đã lưu token → gần như chắc chắn là host cần dùng.
        if (!lastHost && hosts.length === 1) setHost(hosts[0]);
      })
      .catch(() => {});
  }, []);

  const doScan = useCallback(async () => {
    const gi = groupInput.trim();
    if (!gi || scanning) return;
    setScanning(true);
    setScanErr(null);
    setTokenHost('');
    try {
      const res = await gitActionLong<GroupScanResult>('scan-gitlab-group', { group: gi, host: host.trim() }, 110_000);
      setScan(res);
      setJob(null);
      setRunErr(null);
      setFilter('');
      // Mặc định chọn hết, trừ repo đã archive (thường là đồ bỏ).
      setSelected(new Set(res.repos.filter((r) => !r.archived).map((r) => r.id)));
      setProjectName((n) => n || res.group.name);
      writeLs(LAST_GROUP_KEY, gi);
      writeLs(LAST_HOST_KEY, res.host);
    } catch (e) {
      const err = e as Error & { needToken?: boolean; host?: string };
      setScanErr(err.message);
      if (err.needToken && err.host) setTokenHost(err.host);
    } finally {
      setScanning(false);
    }
  }, [groupInput, host, scanning]);

  const saveToken = useCallback(async () => {
    const t = tokenInput.trim();
    if (!t || !tokenHost || savingToken) return;
    setSavingToken(true);
    try {
      await gitActionLong('set-gitlab-token', { host: tokenHost, token: t });
      setTokenInput('');
      setTokenHost('');
      setScanErr(null);
      setSavingToken(false);
      await doScan();
    } catch (e) {
      setScanErr((e as Error).message);
      setSavingToken(false);
    }
  }, [tokenInput, tokenHost, savingToken, doScan]);

  const names = useMemo(() => (scan ? folderNames(scan.repos) : new Map<number, string>()), [scan]);

  // Thư mục cha / danh sách đổi → hỏi server tên nào đã có sẵn. Trễ 300ms để gõ
  // đường dẫn không bắn request từng phím.
  useEffect(() => {
    const p = parent.trim();
    if (!scan || !p) {
      setCheck(null);
      setCheckErr(null);
      return;
    }
    let dead = false;
    const timer = setTimeout(() => {
      gitActionLong<CloneTargetsCheck>('check-clone-targets', { parent: p, names: Array.from(names.values()) })
        .then((res) => {
          if (dead) return;
          setCheck(res);
          setCheckErr(null);
        })
        .catch((e) => {
          if (dead) return;
          setCheck(null);
          setCheckErr((e as Error).message);
        });
    }, 300);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [scan, parent, names, checkTick]);

  const existing = useMemo(() => new Set((check?.existing ?? []).map((n) => n.toLowerCase())), [check]);
  const isExisting = useCallback(
    (r: GroupRepo) => existing.has((names.get(r.id) ?? '').toLowerCase()),
    [existing, names],
  );

  const visible = useMemo(() => {
    if (!scan) return [];
    const q = filter.trim().toLowerCase();
    return q ? scan.repos.filter((r) => r.relativePath.toLowerCase().includes(q)) : scan.repos;
  }, [scan, filter]);

  /** Repo sẽ thực sự được clone: đã tick VÀ chưa có trên đĩa. */
  const toClone = useMemo(
    () => (scan ? scan.repos.filter((r) => selected.has(r.id) && !isExisting(r)) : []),
    [scan, selected, isExisting],
  );

  const parentProject = useMemo(() => {
    const key = normPath(check?.parent ?? parent);
    return key ? projects.find((p) => normPath(p.root) === key) ?? null : null;
  }, [projects, check, parent]);

  const selectAll = () =>
    setSelected((cur) => {
      const next = new Set(cur);
      for (const r of visible) if (!isExisting(r)) next.add(r.id);
      return next;
    });
  const selectNone = () =>
    setSelected((cur) => {
      const next = new Set(cur);
      for (const r of visible) next.delete(r.id);
      return next;
    });
  const toggle = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canStart = !locked && !!scan && toClone.length > 0 && !!parent.trim() && !!check && !check.selfRepo;

  const start = useCallback(async () => {
    if (!canStart || !scan) return;
    setStarting(true);
    setRunErr(null);
    try {
      const res = await gitActionLong<CloneJob>('clone-group-start', {
        parent: parent.trim(),
        branch: branch.trim(),
        fallbackDefault,
        items: toClone.map((r) => ({
          key: String(r.id),
          url: proto === 'ssh' ? r.sshUrl : r.httpUrl,
          name: names.get(r.id) ?? r.path,
        })),
      });
      finishedFor.current = '';
      setJob(res);
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setStarting(false);
    }
  }, [canStart, scan, parent, branch, fallbackDefault, toClone, proto, names]);

  // Hỏi tiến độ mỗi giây cho tới khi job xong. Lỗi lẻ (một nhịp hụt) thì bỏ qua,
  // nhịp sau hỏi lại; lỗi "không tìm thấy job" thì dừng hẳn.
  const jobId = job?.id ?? '';
  const jobFinished = !!job?.finished;
  useEffect(() => {
    if (!jobId || jobFinished) return;
    let dead = false;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      gitActionLong<CloneJob>('clone-group-status', { jobId })
        .then((j) => {
          if (!dead) setJob(j);
        })
        .catch((e) => {
          if (dead) return;
          if (/không tìm thấy job/i.test((e as Error).message)) {
            setRunErr((e as Error).message);
            setJob((cur) => (cur ? { ...cur, finished: true } : cur));
          }
        })
        .finally(() => {
          busy = false;
        });
    }, 1000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [jobId, jobFinished]);

  // Job vừa xong (đúng một lần mỗi job): dò lại thư mục cha để repo đã về hiện
  // "đã có", thêm project nếu được yêu cầu, rồi báo cho GitWorkspace nạp lại.
  const finishedFor = useRef('');
  useEffect(() => {
    if (!job || !job.finished || finishedFor.current === job.id) return;
    finishedFor.current = job.id;
    setCheckTick((n) => n + 1);
    const cloned = job.items.filter((i) => i.state === 'done').length;
    if (!cloned) return;
    (async () => {
      const existingProject = projects.find((p) => normPath(p.root) === normPath(job.parent));
      if (existingProject) {
        onDone({ parent: job.parent, cloned, projectId: existingProject.id });
        return;
      }
      if (!addProject) {
        onDone({ parent: job.parent, cloned });
        return;
      }
      try {
        const label = projectName.trim() || scan?.group.name || 'group';
        const state = await mutateGitProject('POST', { name: label, root: job.parent });
        const added = state.projects.find((p) => normPath(p.root) === normPath(job.parent));
        onDone({ parent: job.parent, cloned, state, projectId: added?.id });
      } catch (e) {
        setRunErr(`Clone xong nhưng chưa thêm được project: ${(e as Error).message}`);
        onDone({ parent: job.parent, cloned });
      }
    })();
    // Chỉ phụ thuộc job — các giá trị khác đọc tại thời điểm job xong là đúng ý.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const cancel = useCallback(() => {
    if (!jobId) return;
    gitActionLong<CloneJob>('clone-group-cancel', { jobId })
      .then(setJob)
      .catch(() => {});
  }, [jobId]);

  const itemByKey = useMemo(() => {
    const m = new Map<string, CloneJobItem>();
    for (const i of job?.items ?? []) m.set(i.key, i);
    return m;
  }, [job]);

  const tally = useMemo(() => {
    const t = { done: 0, error: 0, cancelled: 0, total: job?.items.length ?? 0 };
    for (const i of job?.items ?? []) {
      if (i.state === 'done') t.done++;
      else if (i.state === 'error') t.error++;
      else if (i.state === 'cancelled') t.cancelled++;
    }
    return t;
  }, [job]);

  const visibleSelected = visible.filter((r) => selected.has(r.id) && !isExisting(r)).length;
  const mono: React.CSSProperties = { fontFamily: 'var(--mono)', fontSize: 12 };
  const label: React.CSSProperties = { color: 'var(--muted)' };
  // CSS chung viết HOA mọi <label> (nhãn ô nhập). Dòng repo và dòng checkbox cũng
  // là <label> để bấm cả dòng — phải trả chữ về nguyên dạng, tên repo phân biệt hoa thường.
  const plain: React.CSSProperties = { textTransform: 'none', letterSpacing: 'normal', fontWeight: 'normal' };

  return (
    <>
      {/* Đang clone thì không cho đóng bằng bấm nền — job vẫn chạy nhưng người
          dùng sẽ mất chỗ xem tiến độ. */}
      <div className="modal-backdrop" onClick={() => !running && onClose()}>
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(860px, 96vw)', maxHeight: '90vh' }}>
          <div className="status-line" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0, flex: 1 }}>Clone cả group GitLab</h3>
            <button className="ghost sm" onClick={onClose} disabled={running}>✕</button>
          </div>

          {/* ── 1. Group ─────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '3 1 320px', minWidth: 0 }}>
              <label className="small" style={label}>Đường dẫn hoặc ID group</label>
              <input
                type="text"
                value={groupInput}
                onChange={(e) => setGroupInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doScan()}
                placeholder="https://gitlab.example.com/nhom/nhom-con  ·  nhom/nhom-con  ·  1234"
                autoFocus
                disabled={locked}
                style={{ width: '100%', marginTop: 4, ...mono }}
              />
            </div>
            {!inputHasHost && (
              <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                <label className="small" style={label}>Host GitLab</label>
                <input
                  type="text"
                  list="group-clone-hosts"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && doScan()}
                  placeholder="gitlab.example.com"
                  disabled={locked}
                  style={{ width: '100%', marginTop: 4, ...mono }}
                />
                <datalist id="group-clone-hosts">
                  {knownHosts.map((h) => <option key={h} value={h} />)}
                </datalist>
              </div>
            )}
            <button className="sm" onClick={doScan} disabled={locked || !groupInput.trim() || (!inputHasHost && !host.trim())}>
              {scanning ? <><span className="spinner" aria-hidden /> Đang quét…</> : scan ? '↻ Quét lại' : '🔍 Quét'}
            </button>
          </div>

          {scanErr && <pre className="code" style={{ color: 'var(--err)', margin: '10px 0 0', whiteSpace: 'pre-wrap' }}>{scanErr}</pre>}

          {tokenHost && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <span className="small" style={label}>Token cho <b>{tokenHost}</b></span>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveToken()}
                placeholder="glpat-…"
                disabled={savingToken}
                autoComplete="off"
                style={{ flex: '1 1 240px', ...mono }}
              />
              <button className="sm" onClick={saveToken} disabled={savingToken || !tokenInput.trim()}>
                {savingToken ? '…' : '🔑 Lưu & quét'}
              </button>
              <span className="small" style={{ ...label, flexBasis: '100%' }}>
                Token chỉ lưu trên máy này (configs/gitlabtokens.json), không gửi ra trình duyệt.
              </span>
            </div>
          )}

          {/* ── 2. Danh sách repo ────────────────────────────────────────── */}
          {scan && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
                <span className="small">
                  <b>{scan.group.fullPath}</b> · {scan.repos.length} repo
                  {' · '}đã chọn <b>{toClone.length}</b>
                  {existing.size > 0 && <> · {existing.size} đã có sẵn</>}
                </span>
                <span style={{ flex: 1 }} />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Lọc theo tên…"
                  style={{ width: 170, fontSize: 12 }}
                />
                <button className="ghost sm" onClick={selectAll} disabled={locked || !visible.length}
                  title={filter.trim() ? 'Chọn mọi repo đang hiện theo bộ lọc' : 'Chọn mọi repo'}>
                  ☑ Chọn tất cả
                </button>
                <button className="ghost sm" onClick={selectNone} disabled={locked || !visibleSelected}
                  title={filter.trim() ? 'Bỏ chọn mọi repo đang hiện theo bộ lọc' : 'Bỏ chọn mọi repo'}>
                  ☐ Bỏ chọn tất cả
                </button>
              </div>

              {scan.truncated && (
                <div className="badge warn" style={{ marginBottom: 6 }}>
                  ⚠ Group quá lớn — chỉ hiện {scan.repos.length} repo đầu. Quét từng nhóm con để lấy đủ.
                </div>
              )}

              <div style={{
                border: '1px solid var(--glass-brd)', borderRadius: 8, overflow: 'auto',
                flex: '1 1 auto', minHeight: 140, maxHeight: '38vh',
              }}>
                {!scan.repos.length && (
                  <div className="small" style={{ ...label, padding: 12 }}>
                    Group này không có repo nào mà token của bạn thấy được.
                  </div>
                )}
                {!!scan.repos.length && !visible.length && (
                  <div className="small" style={{ ...label, padding: 12 }}>Không repo nào khớp bộ lọc.</div>
                )}
                {visible.map((r) => {
                  const have = isExisting(r);
                  const item = itemByKey.get(String(r.id));
                  const folder = names.get(r.id) ?? r.path;
                  const meta = item ? ITEM_META[item.state] : null;
                  return (
                    <label
                      key={r.id}
                      style={{
                        display: 'flex', gap: 8, alignItems: 'center', padding: '5px 10px',
                        borderBottom: '1px solid var(--glass-brd)', cursor: have || locked ? 'default' : 'pointer',
                        opacity: have && !item ? 0.6 : 1, ...plain,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(r.id) && !have}
                        disabled={have || locked}
                        onChange={() => toggle(r.id)}
                      />
                      <span style={{ ...mono, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={`${r.pathWithNamespace}\n→ thư mục: ${folder}`}>
                        {r.relativePath}
                        {folder !== r.path && <span style={label}> → {folder}</span>}
                      </span>
                      {r.archived && <span className="badge" title="Repo đã archive trên GitLab">archived</span>}
                      {r.emptyRepo && <span className="badge" title="Repo chưa có commit nào">rỗng</span>}
                      {r.defaultBranch && (
                        <span className="small" style={{ ...label, ...mono }} title="Branch mặc định">⎇ {r.defaultBranch}</span>
                      )}
                      {meta ? (
                        <span className="small" style={{ color: meta.color, whiteSpace: 'nowrap' }} title={item?.message || undefined}>
                          {item?.state === 'running' && <span className="spinner" aria-hidden />} {meta.label}
                          {item?.state === 'done' && item.message ? ' *' : ''}
                        </span>
                      ) : have ? (
                        <span className="badge ok" title={`Đã có thư mục ${folder} trong thư mục cha`}>đã có</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>

              {/* Lỗi/ghi chú từng repo — hiện đủ chữ, không bắt rê chuột đọc title. */}
              {job && job.items.some((i) => i.message) && (
                <pre className="code" style={{ margin: '8px 0 0', maxHeight: 110, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11 }}>
                  {job.items.filter((i) => i.message).map((i) => `${i.state === 'error' ? '✗' : '•'} ${i.name}: ${i.message}`).join('\n')}
                </pre>
              )}

              {/* ── 3. Branch + thư mục cha ──────────────────────────────── */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <label className="small" style={label}>Branch</label>
                  <input
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="để trống = branch mặc định của từng repo"
                    disabled={locked}
                    style={{ width: '100%', marginTop: 4, ...mono }}
                  />
                </div>
                <div style={{ flex: '0 0 auto' }}>
                  <label className="small" style={label}>Giao thức</label>
                  <select value={proto} onChange={(e) => setProto(e.target.value as 'https' | 'ssh')} disabled={locked}
                    style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                    <option value="https">HTTPS</option>
                    <option value="ssh">SSH</option>
                  </select>
                </div>
              </div>
              {branch.trim() && (
                <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, ...plain }}>
                  <input type="checkbox" checked={fallbackDefault} onChange={(e) => setFallbackDefault(e.target.checked)} disabled={locked} />
                  Repo nào không có branch <code className="small">{branch.trim()}</code> thì lấy branch mặc định (bỏ tick = báo lỗi repo đó)
                </label>
              )}

              <div style={{ marginTop: 10 }}>
                <label className="small" style={label}>Thư mục cha trên máy</label>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <input
                    type="text"
                    value={parent}
                    onChange={(e) => setParent(e.target.value)}
                    placeholder="D:\works\ten-du-an"
                    disabled={locked}
                    style={{ flex: 1, minWidth: 0, ...mono }}
                  />
                  <button className="ghost sm" onClick={() => setPickerOpen(true)} disabled={locked}>📂 Browse</button>
                </div>
              </div>
              {checkErr && parent.trim() && (
                <div className="badge warn" style={{ marginTop: 6 }}>⚠ {checkErr}</div>
              )}
              {check?.selfRepo && (
                <div className="badge warn" style={{ marginTop: 6 }}>
                  ⚠ Thư mục này chính là một repo git — chọn thư mục cha khác để chứa các repo.
                </div>
              )}
              {check && !check.selfRepo && (
                parentProject ? (
                  <div className="small" style={{ ...label, marginTop: 6 }}>
                    Thư mục này là project <b>{parentProject.name}</b> — repo clone về sẽ hiện ngay trong project đó.
                  </div>
                ) : (
                  <div className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', ...plain }}>
                      <input type="checkbox" checked={addProject} onChange={(e) => setAddProject(e.target.checked)} disabled={locked} />
                      Thêm thư mục này thành project trong tab Git, tên
                    </label>
                    <input
                      type="text"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      disabled={locked || !addProject}
                      style={{ width: 180, fontSize: 12 }}
                    />
                  </div>
                )
              )}
            </>
          )}

          {runErr && <pre className="code" style={{ color: 'var(--err)', margin: '10px 0 0', whiteSpace: 'pre-wrap' }}>{runErr}</pre>}

          {/* ── 4. Xác nhận ──────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
            <span className="small" style={{ flex: 1, ...label }}>
              {job ? (
                job.finished ? (
                  <>
                    <b style={{ color: 'var(--ok, #3fb950)' }}>✓ {tally.done}</b> xong
                    {tally.error > 0 && <> · <b style={{ color: 'var(--err, #f85149)' }}>✗ {tally.error}</b> lỗi (vẫn đang tick — bấm clone để thử lại)</>}
                    {tally.cancelled > 0 && <> · {tally.cancelled} đã dừng</>}
                  </>
                ) : (
                  <>
                    <span className="spinner" aria-hidden /> Đang clone {tally.done + tally.error}/{tally.total}
                    {job.cancelled && ' — đang dừng, chờ repo dở chạy nốt…'}
                  </>
                )
              ) : (
                'Clone dùng credential git của máy (không dùng token API).'
              )}
            </span>
            {job && !job.finished ? (
              <button className="ghost sm" onClick={cancel} disabled={job.cancelled}>■ Dừng</button>
            ) : (
              <button className="ghost sm" onClick={onClose} disabled={running}>Đóng</button>
            )}
            <button className="sm" onClick={start} disabled={!canStart}
              title={scan ? `git clone ${toClone.length} repo vào ${parent.trim() || '…'}` : 'Quét group trước'}>
              {running ? <><span className="spinner" aria-hidden /> Đang clone…</> : `⇊ Clone ${toClone.length} repo`}
            </button>
          </div>
        </div>
      </div>

      {/* Ngoài .modal: .modal có backdrop-filter nên phần tử fixed bên trong bị nhốt. */}
      {pickerOpen && (
        <FolderPicker
          initial={parent.trim() || undefined}
          title="Chọn thư mục cha"
          hint="Các repo sẽ được clone thành thư mục con của thư mục đang mở."
          onPick={(picked) => {
            setParent(picked);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
