'use client';

// Apps workspace — cấu hình + start/stop các app local (Next.js, bot, …)
// ngay trong DevBox: trỏ thư mục gốc project, đặt hậu tố lệnh (npm run <cmd>),
// quản lý theo name/project/description/tags, xem log live. Server giữ process
// (app/api/apps); UI chỉ poll trạng thái + log.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtRel } from '@/lib/google';
import FolderPicker from './FolderPicker';

interface AppEntry {
  id: string; name: string; root: string; cmd: string; port?: number;
  project?: string; description?: string; tags?: string[];
}
interface ListResult {
  apps: AppEntry[];
  running: Record<string, { pid: number; startedAt: number; port?: number }>;
  installed?: Record<string, boolean>;
}

async function api<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/apps', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { result: T }).result;
}

/** Một app trong manifest dùng chung (configs/apps.shared.json) — xem lib/appManifest.ts. */
interface MissingApp {
  name: string; cmd: string; project?: string; port?: number;
  description?: string; tags?: string[]; rel?: string; anchor?: string;
  /** Thư mục DevBox tự dò ra trên máy này (đã kiểm có package.json). */
  suggestedRoot?: string;
}
interface ManifestStatus { present: boolean; total: number; missing: MissingApp[]; extra: string[] }

type Draft = { name?: string; root?: string; cmd?: string; port?: string; project?: string; description?: string; tagsText?: string };
const splitTags = (s?: string) => (s ?? '').split(',').map((t) => t.trim()).filter(Boolean);

function Fields({ d, onChange }: { d: Draft; onChange: (d: Draft) => void }) {
  const [picking, setPicking] = useState(false);
  return (
    <>
      <div className="glink-meta-pair">
        <input className="input" placeholder="Thư mục gốc project (chứa package.json) *" value={d.root ?? ''}
          onChange={(e) => onChange({ ...d, root: e.target.value })} />
        <button className="ghost sm" style={{ flex: 'none' }} onClick={() => setPicking(true)}
          title="Duyệt chọn thư mục project trên máy">📂 Chọn…</button>
        <input className="input mail-port" style={{ width: 130 }} placeholder="lệnh *" value={d.cmd ?? ''}
          onChange={(e) => onChange({ ...d, cmd: e.target.value })} title="Hậu tố: chạy `npm run <lệnh>`" />
        <input className="input mail-port" style={{ width: 90 }} type="number" placeholder="Port" value={d.port ?? ''}
          onChange={(e) => onChange({ ...d, port: e.target.value })}
          title="Cổng mong muốn (optional). DevBox set PORT + -p khi start; nếu cổng bận sẽ tự nhảy sang cổng trống kế tiếp. Bỏ trống = để app tự quyết." />
      </div>
      {picking && (
        <FolderPicker
          initial={d.root?.trim() || undefined}
          title="Chọn thư mục gốc project"
          hint="Thư mục hợp lệ có package.json (được đánh dấu trong danh sách)."
          marker="package.json"
          onPick={(p) => { onChange({ ...d, root: p }); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
      <div className="glink-meta-pair">
        <input className="input" placeholder="Tên hiển thị (mặc định: tên thư mục)" value={d.name ?? ''}
          onChange={(e) => onChange({ ...d, name: e.target.value })} />
        <input className="input" placeholder="Dự án (optional)" value={d.project ?? ''}
          onChange={(e) => onChange({ ...d, project: e.target.value })} />
      </div>
      <input className="input" placeholder="Mô tả ngắn (optional)" value={d.description ?? ''}
        onChange={(e) => onChange({ ...d, description: e.target.value })} />
      <input className="input" placeholder="Tags, cách nhau dấu phẩy (optional)" value={d.tagsText ?? ''}
        onChange={(e) => onChange({ ...d, tagsText: e.target.value })} />
    </>
  );
}

/**
 * Dải "app dùng chung" — đối chiếu configs/apps.shared.json (đi theo repo) với
 * app đã đăng ký trên máy này. Máy mới chỉ thấy tab Apps trắng trơn nếu không có
 * cái này: apps.json chứa đường dẫn theo máy nên cố ý không sync.
 *
 * Thiếu app nào thì DevBox tự dò thư mục qua project tab Git; dò ra là bấm một
 * nút, dò không ra thì tự chọn thư mục.
 */
function ManifestBar({ status, onAdopted, onError }: {
  status: ManifestStatus;
  onAdopted: (r: ListResult & { manifest: ManifestStatus }) => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<MissingApp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const adopt = async (m: MissingApp, root: string) => {
    setBusy(m.name);
    try {
      onAdopted(await api<ListResult & { manifest: ManifestStatus }>('adopt', {
        name: m.name, cmd: m.cmd, port: m.port, project: m.project,
        description: m.description, tags: m.tags, root,
      }));
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(null); setPicking(null); }
  };

  if (!status.present && status.missing.length === 0) return null;

  return (
    <div className="app-manifest">
      <button className="app-manifest-head" onClick={() => setOpen((v) => !v)}>
        <span className="es-tree-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        <b>App dùng chung</b>
        <span className="small" style={{ color: 'var(--muted)' }}>
          {status.total} app trong manifest
          {status.missing.length > 0 && ` · máy này thiếu ${status.missing.length}`}
        </span>
        {status.missing.length > 0 && <span className="app-manifest-badge">{status.missing.length}</span>}
      </button>

      {open && (
        <div className="app-manifest-body">
          <p className="es-hint">
            Danh sách này đi theo repo dev-box (<code>configs/apps.shared.json</code>) — chỉ gồm tên,
            lệnh <code>npm run</code>, cổng và tag. Thư mục gốc là của riêng từng máy nên phải trỏ tại chỗ.
          </p>
          {status.missing.length === 0 && (
            <p className="empty">Máy này đã có đủ app trong manifest.</p>
          )}
          {status.missing.map((m) => (
            <div key={`${m.project ?? ''}/${m.name}`} className="app-manifest-row">
              <span className="app-manifest-name">
                <b>{m.name}</b>
                <code>npm run {m.cmd}</code>
                {m.project && <span className="badge">📁 {m.project}</span>}
                {m.rel && <span className="small" style={{ color: 'var(--muted)' }} title={m.anchor ? `Tính từ root project Git "${m.anchor}"` : undefined}>…/{m.rel}</span>}
              </span>
              {m.suggestedRoot ? (
                <button className="sm" disabled={busy === m.name} title={`Thêm với thư mục ${m.suggestedRoot}`}
                  onClick={() => void adopt(m, m.suggestedRoot as string)}>
                  {busy === m.name ? <span className="spinner" aria-hidden /> : '＋'} Thêm ({m.suggestedRoot})
                </button>
              ) : (
                <button className="ghost sm" disabled={busy === m.name} onClick={() => setPicking(m)}
                  title="DevBox chưa dò ra thư mục — chọn tay">📂 Trỏ thư mục…</button>
              )}
            </div>
          ))}
          {status.extra.length > 0 && (
            <p className="es-hint">
              Máy này có {status.extra.length} app chưa nằm trong manifest ({status.extra.join(', ')}) —
              bấm <b>⇪ Đồng bộ manifest</b> nếu muốn chia sẻ cho máy khác.
            </p>
          )}
        </div>
      )}

      {picking && (
        <FolderPicker
          initial={picking.suggestedRoot}
          title={`Thư mục gốc của "${picking.name}" trên máy này`}
          hint="Thư mục hợp lệ có package.json (được đánh dấu trong danh sách)."
          marker="package.json"
          onPick={(p) => void adopt(picking, p)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

/** Khung log live của một app — poll 1.5s, tự cuộn đáy. */
function LogPane({ id }: { id: string }) {
  const [lines, setLines] = useState<{ seq: number; line: string }[]>([]);
  const lastSeq = useRef(0);
  const boxRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    lastSeq.current = 0; setLines([]);
    let alive = true;
    const tick = async () => {
      try {
        const r = await api<{ lines: { seq: number; line: string }[] }>('logs', { id, afterSeq: lastSeq.current });
        if (!alive || !r.lines.length) return;
        lastSeq.current = r.lines[r.lines.length - 1].seq;
        setLines((cur) => [...cur, ...r.lines].slice(-2000));
        requestAnimationFrame(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight));
      } catch { /* server restart — thôi poll lượt này */ }
    };
    void tick();
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [id]);
  return <pre ref={boxRef} className="app-log">{lines.map((l) => l.line).join('\n') || '(chưa có log)'}</pre>;
}

export default function AppsWorkspace() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [running, setRunning] = useState<ListResult['running']>({});
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>({});
  const [logId, setLogId] = useState<string | null>(null);
  const [fProject, setFProject] = useState<string | null>(null);
  const [fTag, setFTag] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ManifestStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  const apply = (r: ListResult) => { setApps(r.apps); setRunning(r.running); setInstalled(r.installed ?? {}); };
  const reload = useCallback(async () => {
    try { apply(await api<ListResult>('list')); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void reload(); const t = setInterval(() => void reload(), 5000); return () => clearInterval(t); }, [reload]);

  // Manifest chỉ đọc lại khi danh sách app đổi — nó chạm đĩa (dò thư mục) nên
  // không nên bám nhịp poll 5s của trạng thái process.
  const reloadManifest = useCallback(async () => {
    try { setManifest((await api<{ manifest: ManifestStatus }>('manifest')).manifest); }
    catch { /* manifest hỏng không được chặn tab Apps */ }
  }, []);
  useEffect(() => { void reloadManifest(); }, [reloadManifest, apps.length]);

  const act = async (action: string, params: Record<string, unknown>, id?: string) => {
    setErr(null); if (id) setBusyId(id);
    try { apply(await api<ListResult>(action, params)); } catch (e) { setErr((e as Error).message); }
    finally { setBusyId(null); void reloadManifest(); }
  };

  const projects = [...new Set(apps.map((a) => a.project).filter(Boolean) as string[])].sort();
  const tags = [...new Set(apps.flatMap((a) => a.tags ?? []))].sort();
  const shown = apps.filter((a) => (!fProject || a.project === fProject) && (!fTag || (a.tags ?? []).includes(fTag)));

  return (
    <div className="panel sheet-panel">
      <div className="g-list-wrap" style={{ padding: '2px 0' }}>
        <div className="g-toolbar">
          <b style={{ fontSize: 14 }}>⚙ Apps</b>
          <span className="small" style={{ color: 'var(--muted)' }}>start/stop project local — npm run &lt;lệnh&gt;</span>
          <span style={{ flex: 1 }} />
          <button className={`chip-btn${showAdd ? ' on' : ''}`} onClick={() => setShowAdd((v) => !v)}>＋ Thêm app</button>
          <button
            className="chip-btn"
            disabled={syncing || apps.length === 0}
            title={'Ghi đè configs/apps.shared.json bằng danh sách app của MÁY NÀY, rồi commit theo repo dev-box '
              + 'để máy khác thấy. Chỉ ghi tên/lệnh/cổng/tag — thư mục gốc vẫn là của riêng từng máy.'}
            onClick={async () => {
              setSyncing(true); setErr(null);
              try { setManifest((await api<{ manifest: ManifestStatus }>('syncManifest')).manifest); }
              catch (e) { setErr((e as Error).message); }
              finally { setSyncing(false); }
            }}
          >{syncing ? <span className="spinner" aria-hidden /> : '⇪'} Đồng bộ manifest</button>
          <button className="ghost sm" onClick={() => void reload()} title="Tải lại">↻</button>
        </div>

        {manifest && (
          <ManifestBar
            status={manifest}
            onAdopted={(r) => { apply(r); setManifest(r.manifest); }}
            onError={setErr}
          />
        )}
        {showAdd && (
          <div className="glink-meta-form">
            <Fields d={draft} onChange={setDraft} />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="sm" disabled={!draft.root?.trim() || !draft.cmd?.trim()}
                onClick={() => void act('add', { ...draft, tags: splitTags(draft.tagsText) }).then(() => { setDraft({}); setShowAdd(false); })}>
                ＋ Đăng ký
              </button>
              <button className="ghost sm" onClick={() => setShowAdd(false)}>Hủy</button>
            </div>
          </div>
        )}

        {(projects.length > 0 || tags.length > 0) && (
          <div className="glink-filters">
            {projects.map((p) => (
              <button key={p} className={`chip-btn${fProject === p ? ' on' : ''}`} onClick={() => setFProject(fProject === p ? null : p)}>📁 {p}</button>
            ))}
            {projects.length > 0 && tags.length > 0 && <span className="glink-filter-sep" aria-hidden />}
            {tags.map((t) => (
              <button key={t} className={`chip-btn${fTag === t ? ' on' : ''}`} onClick={() => setFTag(fTag === t ? null : t)}>#{t}</button>
            ))}
            {(fProject || fTag) && (
              <button className="ghost sm" onClick={() => { setFProject(null); setFTag(null); }}>✕ Bỏ lọc ({shown.length}/{apps.length})</button>
            )}
          </div>
        )}

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <div className="g-list">
          {shown.map((a) => {
            const run = running[a.id];
            // installed chưa nạp (undefined) → coi như đã cài, khỏi nhấp nháy cảnh báo.
            const ready = installed[a.id] !== false;
            return (
              <div key={a.id}>
                <div className="g-row" style={{ cursor: 'default' }}>
                  <span className={`mail-dot${run ? '' : ' off'}`} title={run ? `Đang chạy · pid ${run.pid}` : 'Đang tắt'} />
                  <span className="g-name">
                    <span className="g-base">
                      {a.name}
                      {a.project && <span className="glink-badge">📁 {a.project}</span>}
                      {(a.tags ?? []).map((t) => <span key={t} className="glink-tag">#{t}</span>)}
                      {run && <span className="glink-badge glink-profile">▶ {fmtRel(new Date(run.startedAt).toISOString())}</span>}
                      {run?.port && (
                        <a className="glink-badge app-port" href={`http://localhost:${run.port}`} target="_blank" rel="noreferrer"
                          title={`Đang chạy ở cổng ${run.port}${a.port && run.port !== a.port ? ` (cổng ${a.port} bận nên nhảy sang)` : ''} — bấm để mở`}>
                          🌐 :{run.port}{a.port && run.port !== a.port ? ' ⚠' : ''}
                        </a>
                      )}
                      {!ready && <span className="glink-badge app-need-install" title="Project chưa có node_modules">⚠ chưa cài</span>}
                    </span>
                    <span className="g-meta">{a.description ? `${a.description} · ` : ''}{a.root} · npm run {a.cmd}{a.port ? ` · port ${a.port}` : ''}</span>
                  </span>
                  {run ? (
                    <button className="ghost sm" disabled={busyId === a.id} onClick={() => void act('stop', { id: a.id }, a.id)} title="Dừng (kill cả cây process)">■ Stop</button>
                  ) : ready ? (
                    <button className="ghost sm" disabled={busyId === a.id} onClick={() => void act('start', { id: a.id }, a.id)} title={`npm run ${a.cmd}`}>▶ Start</button>
                  ) : (
                    <button className="sm" disabled={busyId === a.id}
                      onClick={() => { setLogId(a.id); void act('install', { id: a.id }, a.id); }}
                      title="Project chưa cài dependencies — chạy npm install (xem tiến trình ở log)">
                      📦 npm install
                    </button>
                  )}
                  <button className="ghost sm" onClick={() => setLogId(logId === a.id ? null : a.id)} title="Xem log">📜</button>
                  <button className="ghost sm" onClick={() => {
                    if (editId === a.id) setEditId(null);
                    else { setEditId(a.id); setEditDraft({ name: a.name, root: a.root, cmd: a.cmd, port: a.port ? String(a.port) : '', project: a.project ?? '', description: a.description ?? '', tagsText: (a.tags ?? []).join(', ') }); }
                  }} title="Sửa cấu hình">✎</button>
                  <button className="ghost sm" onClick={() => {
                    if (window.confirm(`Bỏ app "${a.name}" khỏi danh sách? (không đụng tới project)`)) void act('remove', { id: a.id });
                  }} title="Bỏ khỏi danh sách">✕</button>
                </div>
                {editId === a.id && (
                  <div className="glink-meta-form glink-edit">
                    <Fields d={editDraft} onChange={setEditDraft} />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="sm" onClick={() => void act('update', { id: a.id, ...editDraft, tags: splitTags(editDraft.tagsText) }).then(() => setEditId(null))}>💾 Lưu thay đổi</button>
                      <button className="ghost sm" onClick={() => setEditId(null)}>Hủy</button>
                    </div>
                  </div>
                )}
                {logId === a.id && <LogPane id={a.id} />}
              </div>
            );
          })}
          {apps.length === 0 && !err && (
            <div className="empty" style={{ padding: '24px 8px' }}>
              <p className="small">Chưa có app nào. Bấm "＋ Thêm app": trỏ thư mục gốc project + hậu tố lệnh (vd <code>dev</code> cho <code>npm run dev</code>) là start/stop được ngay tại đây.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
