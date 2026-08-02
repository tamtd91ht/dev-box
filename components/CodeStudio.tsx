'use client';

// Code Studio — mini-IDE trong DevBox (mô phỏng IntelliJ, theme Darcula):
//   trái  = cây file project (lazy, context menu CRUD)
//   phải  = editor Monaco nhiều tab, Ctrl+S lưu
//   dưới  = terminal thật (node-pty/ConPTY + xterm) — chạy mvn/gradle/git/claude
// Project lấy từ CÙNG registry với tab Git (.gitprojects.json): đăng ký một lần
// bên tab Git là Code Studio thấy ngay. Kéo được 2 thanh chia (sidebar/terminal),
// kích thước nhớ trong localStorage.

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

const LS_PROJECT = 'code.activeProject';
const LS_SIDE = 'code.sideWidth';
const LS_TERM = 'code.termHeight';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export default function CodeStudio() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);

  // Editor state
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activeRel, setActiveRel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Terminal state (per project — đổi project là bộ tab terminal riêng).
  const [termTabs, setTermTabs] = useState<TermTab[]>([]);
  const [termActive, setTermActive] = useState<string | null>(null);
  const [termOpen, setTermOpen] = useState(true);
  const [pendingCwd, setPendingCwd] = useState<string | null>(null);

  // Layout (px) + drag
  const [sideW, setSideW] = useState(280);
  const [termH, setTermH] = useState(260);
  const dragRef = useRef<null | { kind: 'side' | 'term'; start: number; base: number }>(null);

  useEffect(() => {
    setSideW(clamp(Number(localStorage.getItem(LS_SIDE)) || 280, 180, 560));
    setTermH(clamp(Number(localStorage.getItem(LS_TERM)) || 260, 120, 640));
  }, []);

  useEffect(() => {
    cProjects()
      .then(({ projects: list }) => {
        setProjects(list);
        setEnabled(true);
        const remembered = localStorage.getItem(LS_PROJECT) ?? '';
        setProjectId((cur) => {
          const pick = [cur, remembered].find((id) => id && list.some((p) => p.id === id));
          return pick || list[0]?.id || '';
        });
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
    if (projectId) localStorage.setItem(LS_PROJECT, projectId);
  }, [projectId]);

  // Đổi project → dọn editor + terminal (phiên server cứ để chạy nền, tab Code
  // của project kia quay lại sẽ tạo phiên mới; kill hàng loạt là việc của nút ✕).
  const switchProject = (id: string) => {
    if (id === projectId) return;
    const dirty = files.some((f) => f.content !== f.savedContent);
    if (dirty && !window.confirm('Có file chưa lưu — đổi project và bỏ thay đổi?')) return;
    setProjectId(id);
    setFiles([]);
    setActiveRel(null);
    setTermTabs([]);
    setTermActive(null);
  };

  const openFile = useCallback(async (entry: TreeEntry) => {
    setErr(null);
    const existing = files.find((f) => f.rel === entry.rel);
    if (existing) {
      setActiveRel(entry.rel);
      return;
    }
    try {
      const r = await cRead(projectId, entry.rel);
      setFiles((cur) => [
        ...cur,
        { rel: entry.rel, name: entry.name, content: r.content, savedContent: r.content, mtime: r.mtime, binary: r.binary },
      ]);
      setActiveRel(entry.rel);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [files, projectId]);

  const changeFile = useCallback((rel: string, content: string) => {
    setFiles((cur) => cur.map((f) => (f.rel === rel ? { ...f, content } : f)));
  }, []);

  const saveFile = useCallback(async (rel: string) => {
    const f = files.find((x) => x.rel === rel);
    if (!f || f.content === f.savedContent) return;
    setSaving(true);
    setErr(null);
    try {
      const { mtime } = await cWrite(projectId, rel, f.content, f.mtime);
      setFiles((cur) => cur.map((x) => (x.rel === rel ? { ...x, savedContent: x.content, mtime } : x)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [files, projectId]);

  const closeFile = useCallback((rel: string) => {
    setFiles((cur) => {
      const left = cur.filter((f) => f.rel !== rel);
      setActiveRel((a) => (a === rel ? (left.length ? left[left.length - 1].rel : null) : a));
      return left;
    });
  }, []);

  // Kéo thanh chia — mousedown trên divider, move trên window.
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

  const project = projects.find((p) => p.id === projectId);
  const dirtyCount = files.filter((f) => f.content !== f.savedContent).length;

  return (
    <div className="cs-root">
      {/* ── Toolbar ── */}
      <div className="cs-toolbar">
        <span className="cs-logo" aria-hidden>{'</>'}</span>
        <select
          className="cs-project"
          value={projectId}
          onChange={(e) => switchProject(e.target.value)}
          title={project?.root ?? ''}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span className="cs-path" title={activeRel ?? ''}>{activeRel ?? ''}</span>
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

      {/* ── Main: tree | editor ── */}
      <div className="cs-main" style={{ gridTemplateColumns: `${sideW}px 5px 1fr` }}>
        {project ? (
          <FileTree
            key={project.id}
            projectId={project.id}
            projectName={project.name}
            onOpenFile={(e) => void openFile(e)}
            onTerminalHere={(rel) => {
              setTermOpen(true);
              setPendingCwd(rel);
            }}
            activeRel={activeRel ?? undefined}
          />
        ) : (
          <div className="cs-tree">
            <p className="cs-tree-err">Chưa có project nào — sang tab Git đăng ký thư mục project trước.</p>
          </div>
        )}
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

      {/* ── Terminal (collapsible) ── */}
      {termOpen && project && (
        <>
          <div className="cs-divider h" onMouseDown={startDrag('term')} title="Kéo để đổi cỡ" />
          <div style={{ height: termH, flex: 'none', minHeight: 0 }}>
            <TerminalPane
              key={project.id}
              projectId={project.id}
              tabs={termTabs}
              activeId={termActive}
              onTabs={setTermTabs}
              onActive={setTermActive}
              pendingCwd={pendingCwd}
              onPendingConsumed={() => setPendingCwd(null)}
              visible={termOpen}
            />
          </div>
        </>
      )}
    </div>
  );
}
