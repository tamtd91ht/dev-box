'use client';

// Thanh dấu trang của tab Browser — bám cách làm của Chrome.
//
//   · dải ngang dưới thanh địa chỉ, folder là nút bấm mở menu thả xuống
//   · menu lồng nhiều cấp: folder trong folder mở tiếp sang bên
//   · KÉO ô địa chỉ thả vào đây để lưu trang đang xem
//   · kéo thả để sắp xếp lại, thả vào folder để chuyển vào trong
//   · chuột phải: mở tab mới / sửa / xoá / thư mục mới
//
// VÌ SAO DỰNG MENU BẰNG TAY, KHÔNG DÙNG <details> hay thư viện: menu phải nổi
// TRÊN <webview>, mà guest của Electron vẽ ở tầng native — bất kỳ thứ gì render
// trong luồng tài liệu bình thường đều bị nó che. Nên menu portal ra body và
// dùng cờ data-modal-over-webview, cùng cách các modal khác trong app đang làm.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { bmTree, type Bookmark, type BmNode } from '@/lib/bookmarks';

/** Kiểu dữ liệu đặt vào dataTransfer khi kéo. */
const MIME = 'application/x-devbox-bookmark';

export interface BookmarkBarProps {
  bookmarks: Bookmark[];
  /** Mở một dấu trang (background = mở tab nền). */
  onOpen: (bm: Bookmark, background?: boolean) => void;
  /** Sửa — mở form của tab Browser. */
  onEdit: (bm: Bookmark) => void;
  onRemove: (bm: Bookmark) => void;
  /** Tạo thư mục trong `parentId` (bỏ trống = gốc). */
  onNewFolder: (parentId?: string) => void;
  /** Kéo thả: chuyển `id` vào `parentId`, chèn trước `beforeId`. */
  onMove: (id: string, parentId?: string, beforeId?: string) => void;
  /** Thả URL từ ô địa chỉ vào thanh/thư mục. */
  onDropUrl: (url: string, parentId?: string) => void;
}

interface MenuState { node: BmNode; x: number; y: number }
interface CtxState { node: BmNode | null; x: number; y: number }

export default function BookmarkBar(props: BookmarkBarProps) {
  const { bookmarks, onOpen, onEdit, onRemove, onNewFolder, onMove, onDropUrl } = props;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);   // id đang được rê tới
  const [mounted, setMounted] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setMounted(true), []);

  const tree = bmTree(bookmarks);

  // Đóng menu khi bấm ra ngoài / Esc / cuộn.
  useEffect(() => {
    if (!menu && !ctx) return;
    const close = () => { setMenu(null); setCtx(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // `capture` để bắt trước khi trang bên trong webview nuốt sự kiện.
    document.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [menu, ctx]);

  // Menu nổi trên <webview>: guest vẽ ở tầng native, đè mọi phần tử HTML bất
  // kể z-index. Cờ này đẩy tạm các pane webview ra ngoài màn hình.
  useEffect(() => {
    const root = document.documentElement;
    if (menu || ctx) root.setAttribute('data-modal-over-webview', '1');
    else root.removeAttribute('data-modal-over-webview');
    return () => root.removeAttribute('data-modal-over-webview');
  }, [menu, ctx]);

  /** Bắt đầu kéo một mục sẵn có. */
  const dragStart = useCallback((e: React.DragEvent, node: BmNode) => {
    e.dataTransfer.setData(MIME, node.id);
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  }, []);

  /**
   * Thả vào một chỗ: có thể là mục sẵn có (MIME) hoặc URL kéo từ ô địa chỉ.
   *
   * `intoFolder` = thả VÀO TRONG folder; ngược lại là thả CẠNH `node` (chèn
   * trước nó) trong cùng thư mục cha.
   */
  const handleDrop = useCallback((e: React.DragEvent, node: BmNode | null, intoFolder: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setDropOn(null);

    const movedId = e.dataTransfer.getData(MIME);
    const parentId = intoFolder && node ? node.id : node?.parentId;
    const beforeId = intoFolder ? undefined : node?.id;

    if (movedId) {
      if (movedId === node?.id) return;          // thả lên chính nó
      onMove(movedId, parentId, beforeId);
      return;
    }

    // Không phải mục sẵn có → coi là URL kéo từ ô địa chỉ / trang ngoài.
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (url && url.trim()) onDropUrl(url.trim(), parentId);
  }, [onMove, onDropUrl]);

  const allowDrop = (e: React.DragEvent, id: string | null) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id !== dropOn) setDropOn(id);
  };

  /** Một mục trên thanh ngang (cấp gốc). */
  const chip = (node: BmNode) => (
    <span
      key={node.id}
      className={`bmk-chip${node.kind === 'folder' ? ' folder' : ''}${dropOn === node.id ? ' drop' : ''}`}
      draggable
      onDragStart={(e) => dragStart(e, node)}
      onDragOver={(e) => allowDrop(e, node.id)}
      onDragLeave={() => setDropOn((v) => (v === node.id ? null : v))}
      onDrop={(e) => handleDrop(e, node, node.kind === 'folder')}
      onContextMenu={(e) => { e.preventDefault(); setMenu(null); setCtx({ node, x: e.clientX, y: e.clientY }); }}
      title={node.kind === 'folder' ? node.name : `${node.url}${node.profile ? ` · ${node.profile}` : ''}`}
    >
      <button
        className="bmk-chip-btn"
        onClick={(e) => {
          if (node.kind === 'folder') {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setCtx(null);
            setMenu({ node, x: r.left, y: r.bottom + 4 });
          } else {
            onOpen(node);
          }
        }}
        // Chuột giữa = mở tab nền, đúng thói quen trình duyệt.
        onAuxClick={(e) => { if (e.button === 1 && node.kind === 'link') { e.preventDefault(); onOpen(node, true); } }}
      >
        <span aria-hidden>{node.kind === 'folder' ? '📁' : '🔖'}</span>
        <span className="bmk-chip-name">{node.name}</span>
        {node.profile && <span className="bmk-prof">{node.profile}</span>}
      </button>
    </span>
  );

  /** Menu thả xuống của một folder, lồng được nhiều cấp. */
  const dropdown = (m: MenuState) => (
    <div
      className="bmk-menu"
      style={{ left: Math.min(m.x, window.innerWidth - 260), top: m.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onDragOver={(e) => allowDrop(e, m.node.id)}
      onDrop={(e) => handleDrop(e, m.node, true)}
    >
      {m.node.children.length === 0 && <div className="bmk-menu-empty">Thư mục trống</div>}
      {m.node.children.map((c) => (
        <div
          key={c.id}
          className={`bmk-menu-row${dropOn === c.id ? ' drop' : ''}`}
          draggable
          onDragStart={(e) => dragStart(e, c)}
          onDragOver={(e) => { e.stopPropagation(); allowDrop(e, c.id); }}
          onDrop={(e) => handleDrop(e, c, c.kind === 'folder')}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ node: c, x: e.clientX, y: e.clientY }); }}
          onClick={(e) => {
            if (c.kind === 'folder') {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              // Folder con mở SANG BÊN như Chrome, không đè lên menu cha.
              setMenu({ node: c, x: r.right + 2, y: r.top });
            } else {
              onOpen(c);
              setMenu(null);
            }
          }}
        >
          <span aria-hidden>{c.kind === 'folder' ? '📁' : '🔖'}</span>
          <span className="bmk-menu-name">{c.name}</span>
          {c.kind === 'folder' && <span className="bmk-menu-arrow" aria-hidden>›</span>}
        </div>
      ))}
    </div>
  );

  /** Menu chuột phải. */
  const contextMenu = (c: CtxState) => (
    <div
      className="bmk-menu bmk-ctx"
      style={{ left: Math.min(c.x, window.innerWidth - 220), top: Math.min(c.y, window.innerHeight - 200) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {c.node?.kind === 'link' && (
        <button onClick={() => { onOpen(c.node!, false); setCtx(null); }}>Mở</button>
      )}
      {c.node?.kind === 'link' && (
        <button onClick={() => { onOpen(c.node!, true); setCtx(null); }}>Mở trong tab mới</button>
      )}
      {c.node && <button onClick={() => { onEdit(c.node!); setCtx(null); }}>✎ Sửa</button>}
      <button onClick={() => { onNewFolder(c.node?.kind === 'folder' ? c.node.id : c.node?.parentId); setCtx(null); }}>
        📁 Thư mục mới{c.node?.kind === 'folder' ? ' (bên trong)' : ''}
      </button>
      {c.node && (
        <>
          <div className="bmk-menu-sep" />
          <button className="danger" onClick={() => { onRemove(c.node!); setCtx(null); }}>
            ✕ Xoá{c.node.kind === 'folder' ? ' cả thư mục' : ''}
          </button>
        </>
      )}
    </div>
  );

  return (
    <div
      className={`bmk-bar${dropOn === '__root' ? ' drop' : ''}`}
      ref={barRef}
      // Thả vào khoảng trống của thanh = đưa về gốc cây.
      onDragOver={(e) => allowDrop(e, '__root')}
      onDragLeave={() => setDropOn((v) => (v === '__root' ? null : v))}
      onDrop={(e) => handleDrop(e, null, false)}
      onContextMenu={(e) => { e.preventDefault(); setMenu(null); setCtx({ node: null, x: e.clientX, y: e.clientY }); }}
    >
      {tree.map(chip)}
      {tree.length === 0 && (
        <span className="bmk-hint">Kéo địa chỉ từ ô trên xuống đây để lưu · chuột phải để tạo thư mục</span>
      )}

      {mounted && menu && createPortal(dropdown(menu), document.body)}
      {mounted && ctx && createPortal(contextMenu(ctx), document.body)}
    </div>
  );
}
