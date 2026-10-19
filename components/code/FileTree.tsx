'use client';

// Code Studio — cây file kiểu IntelliJ: lazy load từng cấp, context menu
// (chuột phải) với New file / New folder / Rename / Delete / Refresh /
// Terminal here. Thư mục đã mở giữ nguyên trạng thái expand khi refresh cha.

import { useCallback, useEffect, useRef, useState } from 'react';
import { cTree, cCreate, cRename, cRemove, fileIcon, type TreeEntry } from '@/lib/code';
import { RailHideButton } from '../RailCollapse';

interface Props {
  projectId: string;
  projectName: string;
  /** Mở file vào editor. */
  onOpenFile: (entry: TreeEntry) => void;
  /** Mở terminal tại folder rel. */
  onTerminalHere: (rel: string) => void;
  /** File đang active trong editor (highlight). */
  activeRel?: string;
  /** Thu gọn cột cây file — cha truyền vào thì mới vẽ nút « (RailCollapse). */
  onHide?: () => void;
}

interface Menu {
  x: number;
  y: number;
  /** Entry bị chuột phải; null = nền trống (thư mục gốc). */
  entry: TreeEntry | null;
}

/** Hộp nhập tên inline — Electron KHÔNG hỗ trợ window.prompt() nên phải tự vẽ. */
interface Ask {
  title: string;
  initial: string;
  submit: (value: string) => void;
}

export default function FileTree({ projectId, projectName, onOpenFile, onTerminalHere, activeRel, onHide }: Props) {
  /** children theo rel của thư mục cha ('' = gốc). */
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [askValue, setAskValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const loadDir = useCallback(async (rel: string) => {
    setLoadingDirs((s) => new Set(s).add(rel));
    try {
      const { entries } = await cTree(projectId, rel);
      setChildren((c) => ({ ...c, [rel]: entries }));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingDirs((s) => {
        const n = new Set(s);
        n.delete(rel);
        return n;
      });
    }
  }, [projectId]);

  useEffect(() => {
    void loadDir('');
  }, [loadDir]);

  // Click bất kỳ đâu → đóng context menu.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close, true);
    };
  }, [menu]);

  const toggle = (e: TreeEntry) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(e.rel)) n.delete(e.rel);
      else {
        n.add(e.rel);
        if (!children[e.rel]) void loadDir(e.rel);
      }
      return n;
    });
  };

  const openMenu = (ev: React.MouseEvent, entry: TreeEntry | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    const host = rootRef.current?.getBoundingClientRect();
    setMenu({ x: ev.clientX - (host?.left ?? 0), y: ev.clientY - (host?.top ?? 0), entry });
  };

  /** Thư mục đích cho New file/folder từ vị trí menu. */
  const targetDir = (m: Menu): string => {
    if (!m.entry) return '';
    if (m.entry.type === 'dir') return m.entry.rel;
    const i = m.entry.rel.lastIndexOf('/');
    return i === -1 ? '' : m.entry.rel.slice(0, i);
  };

  const parentOf = (rel: string): string => {
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
  };

  const doCreate = (kind: 'file' | 'dir', m: Menu) => {
    const dir = targetDir(m);
    setAskValue('');
    setAsk({
      title: kind === 'file' ? `File mới trong /${dir || '(gốc)'}` : `Thư mục mới trong /${dir || '(gốc)'}`,
      initial: '',
      submit: (raw) => {
        const name = raw.trim();
        if (!name) return;
        void (async () => {
          try {
            const rel = dir ? `${dir}/${name}` : name;
            await cCreate(projectId, rel, kind);
            await loadDir(dir);
            setExpanded((s) => new Set(s).add(dir));
            if (kind === 'file') onOpenFile({ name, rel, type: 'file' });
          } catch (e) {
            setErr((e as Error).message);
          }
        })();
      },
    });
  };

  const doRename = (m: Menu) => {
    const cur = m.entry;
    if (!cur) return;
    setAskValue(cur.name);
    setAsk({
      title: `Đổi tên "${cur.name}"`,
      initial: cur.name,
      submit: (raw) => {
        const name = raw.trim();
        if (!name || name === cur.name) return;
        void (async () => {
          try {
            await cRename(projectId, cur.rel, name);
            await loadDir(parentOf(cur.rel));
          } catch (e) {
            setErr((e as Error).message);
          }
        })();
      },
    });
  };

  const doDelete = async () => {
    if (!menu?.entry) return;
    const cur = menu.entry;
    if (!window.confirm(`Xóa ${cur.type === 'dir' ? 'thư mục' : 'file'} "${cur.name}"? (xóa thật trên đĩa)`)) return;
    try {
      await cRemove(projectId, cur.rel);
      await loadDir(parentOf(cur.rel));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const renderLevel = (rel: string, depth: number): React.ReactNode => {
    const list = children[rel];
    if (!list) return null;
    return list.map((e) => (
      <div key={e.rel}>
        <button
          className={`cs-node${activeRel === e.rel ? ' on' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (e.type === 'dir' ? toggle(e) : onOpenFile(e))}
          onDoubleClick={() => e.type === 'dir' && toggle(e)}
          onContextMenu={(ev) => openMenu(ev, e)}
          title={e.rel}
        >
          {e.type === 'dir' ? (
            <span className="cs-node-arrow">{expanded.has(e.rel) ? '▾' : '▸'}</span>
          ) : (
            <span className="cs-node-arrow" />
          )}
          <span className="cs-node-ico" aria-hidden>
            {e.type === 'dir' ? (expanded.has(e.rel) ? '📂' : '📁') : fileIcon(e.name, e.type)}
          </span>
          <span className="cs-node-name">{e.name}</span>
          {loadingDirs.has(e.rel) && <span className="spinner" aria-hidden />}
        </button>
        {e.type === 'dir' && expanded.has(e.rel) && renderLevel(e.rel, depth + 1)}
      </div>
    ));
  };

  return (
    <div className="cs-tree" ref={rootRef} onContextMenu={(ev) => openMenu(ev, null)}>
      <div className="cs-tree-head" title={projectName}>
        <span aria-hidden>🗀</span> {projectName}
        <button className="cs-tree-refresh" title="Refresh toàn bộ cây" onClick={() => { setChildren({}); setExpanded(new Set()); void loadDir(''); }}>⟳</button>
        {onHide && <RailHideButton onHide={onHide} className="cs-tree-refresh"
          title="Thu gọn cây file — nhường chỗ cho editor" />}
      </div>
      {err && <div className="cs-tree-err" title={err}>{err}</div>}
      <div className="cs-tree-scroll">{renderLevel('', 0)}</div>

      {menu && (
        <div className="cs-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { const m = menu; setMenu(null); doCreate('file', m); }}>＋ File mới</button>
          <button onClick={() => { const m = menu; setMenu(null); doCreate('dir', m); }}>＋ Thư mục mới</button>
          {menu.entry && (
            <>
              <hr />
              <button onClick={() => { const m = menu; setMenu(null); doRename(m); }}>✎ Đổi tên</button>
              <button className="danger" onClick={() => { setMenu(null); void doDelete(); }}>🗑 Xóa</button>
            </>
          )}
          <hr />
          <button onClick={() => { const m = menu; setMenu(null); onTerminalHere(targetDir(m)); }}>
            ⌨ Terminal tại đây
          </button>
          <button onClick={() => { const m = menu; setMenu(null); void loadDir(m.entry?.type === 'dir' ? m.entry.rel : targetDir(m)); }}>
            ⟳ Refresh
          </button>
        </div>
      )}

      {ask && (
        <div className="cs-ask-backdrop" onClick={() => setAsk(null)}>
          <div className="cs-ask" onClick={(e) => e.stopPropagation()}>
            <div className="cs-ask-title">{ask.title}</div>
            <input
              className="cs-ask-input"
              autoFocus
              value={askValue}
              onChange={(e) => setAskValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { ask.submit(askValue); setAsk(null); }
                if (e.key === 'Escape') setAsk(null);
              }}
            />
            <div className="cs-ask-actions">
              <button onClick={() => setAsk(null)}>Hủy</button>
              <button className="ok" onClick={() => { ask.submit(askValue); setAsk(null); }}>OK</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
