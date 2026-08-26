'use client';

// Thanh dấu trang của tab Browser — bám cách làm của Chrome.
//
//   · dải ngang dưới thanh địa chỉ, folder là nút bấm mở menu thả xuống
//   · menu lồng nhiều cấp: folder con mở SANG BÊN, menu cha vẫn còn đó
//   · KÉO ô địa chỉ thả vào đây để lưu trang đang xem
//   · kéo thả sắp xếp lại, có VẠCH CHÈN cho biết sẽ rơi vào đâu
//   · rê một mục lên folder rồi giữ → folder tự bung ra (hover-expand)
//   · chuột phải: mở tab mới / sửa / xoá / thư mục mới
//
// VÌ SAO DỰNG MENU BẰNG TAY, KHÔNG DÙNG <details> hay thư viện: menu phải nổi
// TRÊN <webview>, mà guest của Electron vẽ ở tầng native — bất kỳ thứ gì render
// trong luồng tài liệu bình thường đều bị nó che. Nên menu portal ra body và bật
// cờ data-popup-over-webview (ẩn RIÊNG <webview>, giữ nguyên thanh tab + thanh
// dấu trang + layout), không phải data-modal-over-webview vốn đẩy cả pane đi.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { bmTree, type Bookmark, type BmNode } from '@/lib/bookmarks';
import { usePopupOverWebview } from '@/lib/useOverWebview';

/** Kiểu dữ liệu đặt vào dataTransfer khi kéo một mục sẵn có. */
const MIME = 'application/x-devbox-bookmark';

/** Rê lên folder bao lâu thì nó tự bung ra, như Chrome. */
const HOVER_OPEN_MS = 550;

/**
 * Đích thả đang được rê tới.
 *
 *   { at: 'before' | 'after', id }  → vạch chèn cạnh mục `id`
 *   { at: 'into', id }              → rơi VÀO TRONG folder `id`
 *   { at: 'end', id: null }         → chỗ trống cuối thanh (gốc cây)
 *   { at: 'end', id: folderId }     → chỗ trống cuối một menu folder
 */
interface DropTarget { at: 'before' | 'after' | 'into' | 'end'; id: string | null }

/** Một tầng menu đang mở. Mảng các tầng = đường dẫn folder đang bung. */
interface MenuLevel { node: BmNode; x: number; y: number }
interface CtxState { node: BmNode | null; x: number; y: number }

export interface BookmarkBarProps {
  bookmarks: Bookmark[];
  /** Mở một dấu trang (background = mở tab nền). */
  onOpen: (bm: Bookmark, background?: boolean) => void;
  /** Sửa — mở form của tab Browser. */
  onEdit: (bm: Bookmark) => void;
  onRemove: (bm: Bookmark) => void;
  /** Tạo thư mục trong `parentId` (bỏ trống = gốc). */
  onNewFolder: (parentId?: string) => void;
  /** Tạo thư mục MỚI (có thể nhiều cấp) rồi CHUYỂN mục `id` vào cấp trong cùng
   *  — không phải thêm bản sao. Dùng cho "thư mục mới, đưa mục này vào". */
  onNewFolderWith?: (id: string, parentId?: string) => void;
  /** Kéo thả: chuyển `id` vào `parentId`, chèn trước `beforeId`. */
  onMove: (id: string, parentId?: string, beforeId?: string) => void;
  /** Ẩn thanh dấu trang — mục cuối trong menu chuột phải, như Chrome. */
  onHideBar?: () => void;
  /** Thả URL từ ô địa chỉ vào thanh/thư mục, chèn trước `beforeId`. */
  onDropUrl: (url: string, parentId?: string, beforeId?: string) => void;
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a?.at === b?.at && a?.id === b?.id;

export default function BookmarkBar(props: BookmarkBarProps) {
  const { bookmarks, onOpen, onEdit, onRemove, onNewFolder, onNewFolderWith, onMove, onDropUrl, onHideBar } = props;
  const [levels, setLevels] = useState<MenuLevel[]>([]);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  // Hẹn giờ hover-expand: rê lên folder, giữ một nhịp thì nó bung.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverId = useRef<string | null>(null);
  // Đích thả mới nhất, đọc được NGAY trong onDrop. State React cập nhật bất
  // đồng bộ nên `drop` lúc thả có thể còn là giá trị của lần rê trước.
  const dropRef = useRef<DropTarget | null>(null);

  useEffect(() => setMounted(true), []);

  const tree = bmTree(bookmarks);
  const open = levels.length > 0 || !!ctx;

  const clearHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hoverId.current = null;
  }, []);

  const setTarget = useCallback((t: DropTarget | null) => {
    dropRef.current = t;
    setDrop((v) => (sameTarget(v, t) ? v : t));
  }, []);

  const closeAll = useCallback(() => {
    setLevels([]);
    setCtx(null);
    setTarget(null);
    clearHover();
  }, [clearHover, setTarget]);

  useEffect(() => () => clearHover(), [clearHover]);

  // Đóng menu khi bấm ra ngoài / Esc / đổi kích thước.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // Bấm TRONG menu thì không đóng — các row tự xử lý click của mình.
      if ((e.target as HTMLElement | null)?.closest?.('.bmk-menu')) return;
      closeAll();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAll(); };
    // `capture` để bắt trước khi trang bên trong webview nuốt sự kiện.
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeAll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeAll);
    };
  }, [open, closeAll]);

  // Menu nổi trên <webview>: guest vẽ ở tầng native, đè mọi phần tử HTML bất kể
  // z-index, nên phải đẩy nó ra khỏi màn hình lúc menu mở.
  //
  // Dùng `data-popup-over-webview` (chỉ ẩn <webview>) chứ KHÔNG dùng
  // `data-modal-over-webview` (đẩy cả pane ra -200vw). Cờ modal là để cho hộp
  // thoại phủ kín màn hình; đem dùng cho một menu bé thì thanh tab, thanh dấu
  // trang và cả trang web cùng bay theo — bấm chuột phải xong màn hình trắng
  // trơn, mất hết ngữ cảnh phía sau.
  usePopupOverWebview(open);

  /* ── Kéo ───────────────────────────────────────────────────────────────── */

  const dragStart = useCallback((e: React.DragEvent, node: BmNode) => {
    e.dataTransfer.setData(MIME, node.id);
    // Kèm URL để thả được ra ngoài app (ô nhập, cửa sổ khác) — Chrome cũng đặt
    // cả hai kiểu khi kéo một dấu trang.
    if (node.kind === 'link' && node.url) {
      e.dataTransfer.setData('text/uri-list', node.url);
      e.dataTransfer.setData('text/plain', node.url);
    }
    e.dataTransfer.effectAllowed = 'copyMove';
    setDragId(node.id);
    e.stopPropagation();
  }, []);

  const dragEnd = useCallback(() => {
    setDragId(null);
    setTarget(null);
    clearHover();
  }, [clearHover, setTarget]);

  /**
   * Cho phép thả, và ghi nhận đích.
   *
   * QUAN TRỌNG — `dropEffect` phải NẰM TRONG `effectAllowed` của nguồn kéo, nếu
   * không trình duyệt HUỶ cú thả và `onDrop` không bao giờ chạy. Tay cầm 🔖 ở ô
   * địa chỉ đặt effectAllowed='copyLink' (không có 'move'), nên gán cứng
   * dropEffect='move' như bản trước là tự chặn chính mình: kéo địa chỉ xuống
   * thanh trông như thả được mà chẳng lưu gì. Nay chọn theo nguồn — mục sẵn có
   * thì 'move', URL từ ngoài thì 'copy'.
   */
  const allow = useCallback((e: React.DragEvent, target: DropTarget) => {
    const isInternal = e.dataTransfer.types.includes(MIME);
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isInternal ? 'move' : 'copy';
    setTarget(target);
  }, [setTarget]);

  /** Rê qua một mục: nửa đầu → chèn trước, nửa sau → chèn sau (như Chrome). */
  const edgeOf = (e: React.DragEvent, horizontal: boolean): 'before' | 'after' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return horizontal
      ? (e.clientX < r.left + r.width / 2 ? 'before' : 'after')
      : (e.clientY < r.top + r.height / 2 ? 'before' : 'after');
  };

  /**
   * Rê lên một folder khi đang kéo → hẹn giờ bung nó ra, để thả được vào mục
   * nằm sâu bên trong mà không phải nhả chuột giữa đường.
   * `depth` là tầng menu mà folder đó sẽ mở ra.
   */
  const armHoverOpen = useCallback((node: BmNode, el: HTMLElement, depth: number) => {
    if (node.kind !== 'folder' || hoverId.current === node.id) return;
    clearHover();
    hoverId.current = node.id;
    const r = el.getBoundingClientRect();
    const pos = depth === 0 ? { x: r.left, y: r.bottom + 4 } : { x: r.right + 2, y: r.top };
    hoverTimer.current = setTimeout(() => {
      setLevels((ls) => [...ls.slice(0, depth), { node, ...pos }]);
    }, HOVER_OPEN_MS);
  }, [clearHover]);

  /**
   * Thả xuống. Quy đích về hai con số mà store hiểu: `parentId` + `beforeId`.
   *
   * 'before' → chèn trước chính nó; 'after' → chèn trước mục KẾ TIẾP trong cùng
   * cha (hết mục thì xuống cuối, beforeId = undefined).
   */
  const handleDrop = useCallback((e: React.DragEvent, fallback: DropTarget, siblings: BmNode[]) => {
    e.preventDefault();
    e.stopPropagation();
    const target = dropRef.current ?? fallback;
    clearHover();
    setTarget(null);
    setDragId(null);

    let parentId: string | undefined;
    let beforeId: string | undefined;

    if (target.at === 'into' || target.at === 'end') {
      parentId = target.id ?? undefined;
    } else {
      const i = siblings.findIndex((s) => s.id === target.id);
      const anchor = siblings[i];
      if (!anchor) return;
      parentId = anchor.parentId;
      beforeId = target.at === 'before' ? anchor.id : siblings[i + 1]?.id;
    }

    const movedId = e.dataTransfer.getData(MIME);
    if (movedId) {
      // Thả lên chính nó / vào trong chính nó — không có gì để làm.
      if (movedId === target.id) return;
      onMove(movedId, parentId, beforeId);
      return;
    }

    // Không phải mục sẵn có → URL kéo từ ô địa chỉ hoặc từ ngoài app. text/uri-list
    // theo chuẩn có thể nhiều dòng và có dòng chú thích mở đầu bằng '#'.
    const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '')
      .split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (url) onDropUrl(url, parentId, beforeId);
  }, [onMove, onDropUrl, clearHover, setTarget]);

  /** Lớp CSS vạch chèn / khung folder cho mục `id`. */
  const dropClass = (id: string) => {
    if (drop?.id !== id) return '';
    if (drop.at === 'into') return ' drop-into';
    if (drop.at === 'before') return ' drop-before';
    if (drop.at === 'after') return ' drop-after';
    return '';
  };

  /* ── Vẽ ────────────────────────────────────────────────────────────────── */

  /** Một mục trên thanh ngang (cấp gốc). */
  const chip = (node: BmNode) => {
    const isOpen = levels[0]?.node.id === node.id;
    return (
      <span
        key={node.id}
        className={`bmk-chip${node.kind === 'folder' ? ' folder' : ''}${isOpen ? ' open' : ''}${dragId === node.id ? ' dragging' : ''}${dropClass(node.id)}`}
        draggable
        onDragStart={(e) => dragStart(e, node)}
        onDragEnd={dragEnd}
        onDragOver={(e) => {
          // Rê vào GIỮA một folder = bỏ vào trong nó; rê ra hai rìa = chèn cạnh.
          // Chrome chia đúng như vậy, nên kéo sắp xếp lại không bị folder "hút".
          const r = e.currentTarget.getBoundingClientRect();
          const inner = node.kind === 'folder' && e.clientX > r.left + 10 && e.clientX < r.right - 10;
          allow(e, inner ? { at: 'into', id: node.id } : { at: edgeOf(e, true), id: node.id });
          if (inner) armHoverOpen(node, e.currentTarget as HTMLElement, 0);
        }}
        onDragLeave={() => { if (hoverId.current === node.id) clearHover(); }}
        onDrop={(e) => handleDrop(e, { at: 'into', id: node.id }, tree)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setLevels([]); setCtx({ node, x: e.clientX, y: e.clientY }); }}
        title={node.kind === 'folder' ? node.name : `${node.url}${node.profile ? ` · ${node.profile}` : ''}`}
      >
        <button
          className="bmk-chip-btn"
          onClick={(e) => {
            if (node.kind === 'folder') {
              // Bấm lại folder đang mở = đóng, đúng như Chrome.
              if (isOpen) { setLevels([]); return; }
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setCtx(null);
              setLevels([{ node, x: r.left, y: r.bottom + 4 }]);
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
  };

  /**
   * Một tầng menu thả xuống.
   *
   * `depth` là vị trí trong `levels`: mở folder con ở tầng d thì cắt các tầng
   * sâu hơn rồi thêm tầng d+1 — menu cha VẪN CÒN trên màn hình. Bản trước dùng
   * một biến `menu` duy nhất nên mở con là ghi đè cha, mất luôn đường lùi.
   */
  const dropdown = (lvl: MenuLevel, depth: number) => {
    const kids = lvl.node.children;
    const endMark = drop?.at === 'end' && drop.id === lvl.node.id ? ' drop-end' : '';
    return (
      <div
        key={lvl.node.id}
        className={`bmk-menu${endMark}`}
        style={{
          left: Math.max(4, Math.min(lvl.x, window.innerWidth - 264)),
          top: Math.max(4, Math.min(lvl.y, window.innerHeight - 120)),
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onDragOver={(e) => allow(e, { at: 'end', id: lvl.node.id })}
        onDrop={(e) => handleDrop(e, { at: 'end', id: lvl.node.id }, kids)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ node: lvl.node, x: e.clientX, y: e.clientY }); }}
      >
        {kids.length === 0 && <div className="bmk-menu-empty">Thư mục trống</div>}
        {kids.map((c) => {
          const openHere = levels[depth + 1]?.node.id === c.id;
          return (
            <div
              key={c.id}
              className={`bmk-menu-row${openHere ? ' open' : ''}${dragId === c.id ? ' dragging' : ''}${dropClass(c.id)}`}
              draggable
              onDragStart={(e) => dragStart(e, c)}
              onDragEnd={dragEnd}
              onDragOver={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const inner = c.kind === 'folder' && e.clientY > r.top + 5 && e.clientY < r.bottom - 5;
                allow(e, inner ? { at: 'into', id: c.id } : { at: edgeOf(e, false), id: c.id });
                if (inner) armHoverOpen(c, e.currentTarget as HTMLElement, depth + 1);
              }}
              onDragLeave={() => { if (hoverId.current === c.id) clearHover(); }}
              onDrop={(e) => handleDrop(e, { at: 'into', id: c.id }, kids)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ node: c, x: e.clientX, y: e.clientY }); }}
              // Rê chuột (không kéo) qua các mục: folder thì bung nhánh của nó,
              // link thì thu các nhánh sâu hơn — mỗi lúc chỉ một nhánh mở, đúng
              // như Chrome.
              onMouseEnter={(e) => {
                if (c.kind === 'folder') {
                  const r = e.currentTarget.getBoundingClientRect();
                  setLevels((ls) => [...ls.slice(0, depth + 1), { node: c, x: r.right + 2, y: r.top }]);
                } else {
                  setLevels((ls) => (ls.length > depth + 1 ? ls.slice(0, depth + 1) : ls));
                }
              }}
              onClick={() => { if (c.kind !== 'folder') { onOpen(c); closeAll(); } }}
              title={c.kind === 'folder' ? c.name : `${c.url}${c.profile ? ` · ${c.profile}` : ''}`}
            >
              <span aria-hidden>{c.kind === 'folder' ? '📁' : '🔖'}</span>
              <span className="bmk-menu-name">{c.name}</span>
              {c.profile && <span className="bmk-prof">{c.profile}</span>}
              {c.kind === 'folder' && <span className="bmk-menu-arrow" aria-hidden>›</span>}
            </div>
          );
        })}
      </div>
    );
  };

  /** Menu chuột phải. */
  const contextMenu = (c: CtxState) => (
    <div
      className="bmk-menu bmk-ctx"
      style={{
        left: Math.max(4, Math.min(c.x, window.innerWidth - 224)),
        top: Math.max(4, Math.min(c.y, window.innerHeight - 200)),
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {c.node?.kind === 'link' && (
        <button onClick={() => { onOpen(c.node!, false); closeAll(); }}>Mở</button>
      )}
      {c.node?.kind === 'link' && (
        <button onClick={() => { onOpen(c.node!, true); closeAll(); }}>Mở trong tab mới</button>
      )}
      {c.node && <button onClick={() => { onEdit(c.node!); closeAll(); }}>✎ Sửa</button>}
      <button onClick={() => { onNewFolder(c.node?.kind === 'folder' ? c.node.id : c.node?.parentId); closeAll(); }}>
        📁 Thư mục mới{c.node?.kind === 'folder' ? ' (bên trong)' : ''}
      </button>
      {/* Chuột phải lên MỘT DẤU TRANG: tạo thư mục rồi chuyển nó vào luôn —
          thao tác hay dùng nhất sau khi vừa kéo địa chỉ xuống thanh. */}
      {c.node && onNewFolderWith && (
        <button onClick={() => { onNewFolderWith(c.node!.id, c.node!.parentId); closeAll(); }}>
          📂 Thư mục mới, đưa mục này vào
        </button>
      )}
      {c.node && (
        <>
          <div className="bmk-menu-sep" />
          <button className="danger" onClick={() => { onRemove(c.node!); closeAll(); }}>
            ✕ Xoá{c.node.kind === 'folder' ? ' cả thư mục' : ''}
          </button>
        </>
      )}
      {/* Chrome để "Hiện thanh dấu trang" ở CUỐI menu chuột phải, dùng được cả
          khi bấm lên một dấu trang lẫn khi bấm vào chỗ trống. Giữ đúng chỗ đó. */}
      {onHideBar && (
        <>
          <div className="bmk-menu-sep" />
          <button onClick={() => { onHideBar(); closeAll(); }}>
            🔖 Ẩn thanh dấu trang
            <span className="bmk-menu-key">Ctrl+Shift+B</span>
          </button>
        </>
      )}
    </div>
  );

  return (
    <div
      className={`bmk-bar${drop?.at === 'end' && drop.id === null ? ' drop' : ''}`}
      // Thả vào khoảng trống của thanh = xuống cuối gốc cây. Các chip đã
      // stopPropagation trong allow()/handleDrop() nên handler này chỉ chạy khi
      // con trỏ thật sự ở chỗ trống.
      onDragOver={(e) => allow(e, { at: 'end', id: null })}
      onDrop={(e) => handleDrop(e, { at: 'end', id: null }, tree)}
      onContextMenu={(e) => { e.preventDefault(); setLevels([]); setCtx({ node: null, x: e.clientX, y: e.clientY }); }}
    >
      {/* Nhãn nhận diện đứng đầu thanh: thanh này nằm ngay dưới hàng tab và
          từng bị nhầm là hàng tab thứ hai — một nhãn nhỏ + vạch ngăn nói thẳng
          "đây là dấu trang" trước khi mắt kịp đoán. Không bấm được, chỉ để đọc. */}
      <span className="bmk-bar-tag" title="Thanh dấu trang — ẩn/hiện bằng Ctrl+Shift+B (hoặc menu ⋯)">
        <span aria-hidden>🔖</span> Dấu trang
      </span>
      {tree.map(chip)}
      {tree.length === 0 && (
        <span className="bmk-hint">
          Kéo <b>🔖</b> ở ô địa chỉ xuống đây để lưu · chuột phải để tạo thư mục
        </span>
      )}

      {mounted && levels.map((l, i) => createPortal(dropdown(l, i), document.body))}
      {mounted && ctx && createPortal(contextMenu(ctx), document.body)}
    </div>
  );
}
