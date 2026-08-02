'use client';

// Code Studio — mini-IDE trong DevBox (mô phỏng IntelliJ, theme Darcula).
//
// NHIỀU PROJECT SONG SONG: thanh project phía trên là các tab (như IntelliJ mở
// nhiều window) — mỗi project mở là MỘT <ProjectWorkspace> mount-and-keep:
// cây file, tab editor, phiên terminal của project nào giữ nguyên project đó,
// chuyển tab không mất state (giống cách app giữ các workspace tab chính —
// stacked cùng một ô, cái không active chỉ visibility:hidden nên Monaco/xterm
// vẫn giữ nguyên kích thước, không cần re-layout).
//
// Mỗi workspace: trái = cây file (context menu CRUD), phải = Monaco nhiều tab
// (Ctrl+S lưu), dưới = terminal thật (node-pty + xterm). Project lấy từ CÙNG
// registry với tab Git (.gitprojects.json).

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import FileTree from './code/FileTree';
import TerminalPane, { type TermTab } from './code/TerminalPane';
import type { OpenFile } from './code/EditorPane';
import { cProjects, cRead, cWrite, type CodeProject, type TreeEntry } from '@/lib/code';

// Monaco chỉ chạy client — tránh SSR đụng window.
const EditorPane = dynamic(() => import('./code/EditorPane'), {
  ssr: false,
  loading: () => <div className="cs-editor-empty"><span className="spinner" /> Đang tải editor…</div>,
});

const LS_OPEN = 'code.openProjects';
const LS_ACTIVE = 'code.activeProject';
const LS_SIDE = 'code.sideWidth';
const LS_TERM = 'code.termHeight';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Toàn bộ IDE của MỘT project — mount-and-keep khi mở nhiều project. */
function ProjectWorkspace({
  project,
  visible,
  onDirty,
}: {
  project: CodeProject;
  visible: boolean;
  /** Báo số file chưa lưu lên tab project (chấm ● + confirm khi đóng). */
  onDirty: (n: number) => void;
}) {
  // Editor state
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activeRel, setActiveRel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Terminal state
  const [termTabs, setTermTabs] = useState<TermTab[]>([]);
  const [termActive, setTermActive] = useState<string | null>(null);
  const [termOpen, setTermOpen] = useState(true);
  const [pendingCwd, setPendingCwd] = useState<string | null>(null);

  // Layout (px) + drag — dùng chung LS key cho mọi project (cảm giác một IDE).
  const [sideW, setSideW] = useState(280);
  const [termH, setTermH] = useState(260);
  const dragRef = useRef<null | { kind: 'side' | 'term'; start: number; base: number }>(null);

  useEffect(() => {
    setSideW(clamp(Number(localStorage.getItem(LS_SIDE)) || 280, 180, 560));
    setTermH(clamp(Number(localStorage.getItem(LS_TERM)) || 260, 120, 640));
  }, []);

  const dirtyCount = files.filter((f) => f.content !== f.savedContent).length;
  useEffect(() => {
    onDirty(dirtyCount);
  }, [dirtyCount, onDirty]);

  const openFile = useCallback(async (entry: TreeEntry) => {
    setErr(null);
    const existing = files.find((f) => f.rel === entry.rel);
    if (existing) {
      setActiveRel(entry.rel);
      return;
    }
    try {
      const r = await cRead(project.id, entry.rel);
      setFiles((cur) => [
        ...cur,
        { rel: entry.rel, name: entry.name, content: r.content, savedContent: r.content, mtime: r.mtime, binary: r.binary },
      ]);
      setActiveRel(entry.rel);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [files, project.id]);

  const changeFile = useCallback((rel: string, content: string) => {
    setFiles((cur) => cur.map((f) => (f.rel === rel ? { ...f, content } : f)));
  }, []);

  const saveFile = useCallback(async (rel: string) => {
    const f = files.find((x) => x.rel === rel);
    if (!f || f.content === f.savedContent) return;
    setSaving(true);
    setErr(null);
    try {
      const { mtime } = await cWrite(project.id, rel, f.content, f.mtime);
      setFiles((cur) => cur.map((x) => (x.rel === rel ? { ...x, savedContent: x.content, mtime } : x)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [files, project.id]);

  const closeFile = useCallback((rel: string) => {
    setFiles((cur) => {
      const left = cur.filter((f) => f.rel !== rel);
      setActiveRel((a) => (a === rel ? (left.length ? left[left.length - 1].rel : null) : a));
      return left;
    });
  }, []);

  // Kéo thanh chia.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'side') setSideW(clamp(d.base + (e.clientX - d.start), 180, 560));
      else setTermH(clamp(d.base - (e.clientY - d.start), 120, 640));
    };
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(LS_SIDE, String(sideW));
      localStorage.setItem(LS_TERM, String(termH));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [sideW, termH]);

  const startDrag = (kind: 'side' | 'term') => (e: React.MouseEvent) => {
    dragRef.current = { kind, start: kind === 'side' ? e.clientX : e.clientY, base: kind === 'side' ? sideW : termH };
    document.body.style.cursor = kind === 'side' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className={`cs-ws${visible ? ' on' : ''}`} aria-hidden={!visible}>
      <div className="cs-toolbar">
        <span className="cs-path" title={project.root}>{project.root}</span>
        <span className="cs-path sep" aria-hidden>·</span>
        <span className="cs-path file" title={activeRel ?? ''}>{activeRel ?? ''}</span>
        <span style={{ flex: 1 }} />
        {err && <span className="cs-toolbar-err" title={err}>{err}</span>}
        {dirtyCount > 0 && (
          <button className="cs-save" disabled={saving || !activeRel} onClick={() => activeRel && void saveFile(activeRel)}>
            {saving ? <span className="spinner" aria-hidden /> : '💾'} Lưu (Ctrl+S){dirtyCount > 1 ? ` · ${dirtyCount} file chưa lưu` : ''}
          </button>
        )}
        <button
          className={`cs-term-toggle${termOpen ? ' on' : ''}`}
          onClick={() => setTermOpen((v) => !v)}
          title={termOpen ? 'Ẩn terminal' : 'Hiện terminal'}
        >
          ⌨
        </button>
      </div>

      <div className="cs-main" style={{ gridTemplateColumns: `${sideW}px 5px 1fr` }}>
        <FileTree
          projectId={project.id}
          projectName={project.name}
          onOpenFile={(e) => void openFile(e)}
          onTerminalHere={(rel) => {
            setTermOpen(true);
            setPendingCwd(rel);
          }}
          activeRel={activeRel ?? undefined}
        />
        <div className="cs-divider v" onMouseDown={startDrag('side')} title="Kéo để đổi cỡ" />
        <EditorPane
          files={files}
          activeRel={activeRel}
          onSelect={setActiveRel}
          onClose={closeFile}
          onChange={changeFile}
          onSave={(rel) => void saveFile(rel)}
        />
      </div>

      {termOpen && (
        <>
          <div className="cs-divider h" onMouseDown={startDrag('term')} title="Kéo để đổi cỡ" />
          <div style={{ height: termH, flex: 'none', minHeight: 0 }}>
            <TerminalPane
              projectId={project.id}
              tabs={termTabs}
              activeId={termActive}
              onTabs={setTermTabs}
              onActive={setTermActive}
              pendingCwd={pendingCwd}
              onPendingConsumed={() => setPendingCwd(null)}
              visible={visible && termOpen}
            />
          </div>
        </>
      )}
    </div>
  );
}

export default function CodeStudio() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<CodeProject[]>([]);
  /** Project ids đang MỞ (mỗi cái một workspace mounted). */
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [dirtyByProject, setDirtyByProject] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    cProjects()
      .then(({ projects: list }) => {
        setProjects(list);
        setEnabled(true);
        // Khôi phục các project đã mở phiên trước (lọc id còn tồn tại).
        let open: string[] = [];
        try {
          open = (JSON.parse(localStorage.getItem(LS_OPEN) ?? '[]') as string[]).filter((id) =>
            list.some((p) => p.id === id),
          );
        } catch { /* hỏng thì thôi */ }
        const remembered = localStorage.getItem(LS_ACTIVE) ?? '';
        if (open.length === 0) {
          const first = [remembered, list[0]?.id ?? ''].find((id) => id && list.some((p) => p.id === id));
          if (first) open = [first];
        }
        setOpenIds(open);
        setActiveId(open.includes(remembered) ? remembered : open[0] ?? '');
      })
      .catch((e) => {
        if ((e as Error & { status?: number }).status === 403) setEnabled(false);
        else {
          setEnabled(true);
          setErr((e as Error).message);
        }
      });
  }, []);

  useEffect(() => {
    if (enabled) localStorage.setItem(LS_OPEN, JSON.stringify(openIds));
  }, [openIds, enabled]);
  useEffect(() => {
    if (activeId) localStorage.setItem(LS_ACTIVE, activeId);
  }, [activeId]);

  const openProject = (id: string) => {
    if (!id) return;
    setOpenIds((cur) => (cur.includes(id) ? cur : [...cur, id]));
    setActiveId(id);
  };

  const closeProject = (id: string) => {
    const dirty = dirtyByProject[id] ?? 0;
    const name = projects.find((p) => p.id === id)?.name ?? id;
    if (dirty > 0 && !window.confirm(`"${name}" còn ${dirty} file chưa lưu — đóng project và bỏ thay đổi?`)) return;
    setOpenIds((cur) => {
      const left = cur.filter((x) => x !== id);
      setActiveId((a) => (a === id ? (left[left.length - 1] ?? '') : a));
      return left;
    });
    setDirtyByProject((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
  };

  const reportDirty = useCallback((id: string, n: number) => {
    setDirtyByProject((m) => (m[id] === n ? m : { ...m, [id]: n }));
  }, []);

  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', width: 'min(560px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>{'</>'}</div>
          <div className="office-hero-title">Code Studio đang tắt</div>
          <p className="office-hero-sub">
            Đặt <code>CODE_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
          </p>
        </div>
      </div>
    );
  }
  if (enabled === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  const openProjects = openIds
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is CodeProject => !!p);
  const closable = projects.filter((p) => !openIds.includes(p.id));

  return (
    <div className="cs-root">
      {/* ── Project tabs (nhiều project song song) ── */}
      <div className="cs-projbar">
        <span className="cs-logo" aria-hidden>{'</>'}</span>
        {openProjects.map((p) => (
          <span key={p.id} className={`cs-proj-tab${p.id === activeId ? ' on' : ''}`} title={p.root}>
            <button className="cs-proj-main" onClick={() => setActiveId(p.id)}>
              <span aria-hidden>🗀</span> {p.name}
              {(dirtyByProject[p.id] ?? 0) > 0 && <span className="cs-dirty" title="Có file chưa lưu">●</span>}
            </button>
            <button className="cs-proj-x" title="Đóng project (terminal của nó vẫn bị đóng)" onClick={() => closeProject(p.id)}>✕</button>
          </span>
        ))}
        {closable.length > 0 && (
          <select
            className="cs-proj-add"
            value=""
            onChange={(e) => openProject(e.target.value)}
            title="Mở thêm project song song"
          >
            <option value="" disabled>＋ Mở project…</option>
            {closable.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        <span style={{ flex: 1 }} />
        {err && <span className="cs-toolbar-err" title={err}>{err}</span>}
      </div>

      {/* ── Stacked workspaces: mount-and-keep, cái không active chỉ ẩn ── */}
      <div className="cs-stack">
        {openProjects.length === 0 && (
          <div className="cs-editor-empty">
            <div className="cs-empty-logo" aria-hidden>{'</>'}</div>
            <p>{projects.length ? 'Chọn "＋ Mở project…" để bắt đầu.' : 'Chưa có project nào — sang tab Git đăng ký thư mục project trước.'}</p>
          </div>
        )}
        {openProjects.map((p) => (
          <ProjectWorkspace
            key={p.id}
            project={p}
            visible={p.id === activeId}
            onDirty={(n) => reportDirty(p.id, n)}
          />
        ))}
      </div>
    </div>
  );
}
