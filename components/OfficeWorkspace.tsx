'use client';

// Office workspace — MỘT dãy tab, mỗi tab là một tài liệu đang mở.
//
// Mở lẫn lộn hai loại cạnh nhau: ▦ Bảng tính (Excel/CSV) và 🗎 Văn bản (.docx),
// icon trên tab cho biết loại nào. Cùng mô hình với tab Kafka / Browser: mỗi tab
// là một INSTANCE riêng của editor, MOUNT MỘT LẦN rồi ở đó — nên tài liệu, lịch
// sử sửa và cuộn của từng tab sống độc lập, đổi tab không mất gì.
//
// Chính vì thế shell này gần như không có state của tài liệu: SheetWorkspace và
// WordWorkspace tự giữ hết (file, ops, dirty). Shell chỉ biết danh sách tab và
// nhận lại tên file + số thay đổi qua onDocState để vẽ tiêu đề tab + dấu ●.
//
// THÊM TAB chỉ hỏi đúng MỘT câu — bảng tính hay văn bản:
//   ＋  mở ngay tab cùng loại với tab đang xem (không bung menu)
//   ▾   bung menu hai mục để chọn loại khác
// Không có "Mở …" ở đây nữa: tab mới luôn trống và màn hình chào của chính
// editor mới là chỗ mở file có sẵn / tạo file mới / bấm lại file gần đây — gộp
// vào menu thì vừa lặp, vừa thiếu mất danh sách gần đây.
//
// Markdown (.md) KHÔNG ở đây — nó là định dạng text nên nằm ở tab Tools cùng
// JSON / XML / HTML (xem components/ToolsWorkspace.tsx).

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import SheetWorkspace from './SheetWorkspace';
import WordWorkspace from './WordWorkspace';

type Kind = 'sheet' | 'word';

const KIND_META: Record<Kind, { icon: string; label: string; hint: string }> = {
  sheet: { icon: '▦', label: 'Bảng tính', hint: 'Excel .xlsx / .csv' },
  word: { icon: '🗎', label: 'Văn bản', hint: 'Word .docx' },
};

interface OfficeTab {
  /** Khóa ổn định — dùng làm React key nên KHÔNG bao giờ đổi trong đời tab. */
  id: string;
  kind: Kind;
  /** Đường dẫn THẬT hiện tại + số thay đổi, do editor báo lên. */
  path: string | null;
  dirtyCount: number;
  /**
   * File mà tab phải tự mở ngay khi mount ("Open with" từ Explorer).
   *
   * Chỉ dùng cho lượt mount đầu — editor đọc một lần rồi thôi (seededRef bên
   * trong SheetWorkspace/WordWorkspace), sau đó `path` ở trên mới là nguồn sự
   * thật. Đọc lại field này về sau sẽ ra đường dẫn cũ.
   */
  initialPath?: string;
}

interface OfficeWorkspaceProps {
  /**
   * Mở file từ bên ngoài. Cha (app/page.tsx) giữ một ref tới hàm này để gọi
   * khi Explorer nhờ mở một .xlsx/.csv/.docx.
   */
  onReady?: (api: OfficeApi) => void;
}

export interface OfficeApi {
  /** Mở một file trên đĩa trong tab mới. Đuôi file quyết định loại editor. */
  openFile: (absPath: string) => void;
}

/** Đuôi file → loại editor. Khớp với OPENABLE_EXTS trong electron/main.cjs. */
function kindForPath(p: string): Kind {
  return /\.docx$/i.test(p) ? 'word' : 'sheet';
}

/** Tab mới lấy id tăng dần — không dùng path làm id vì mở 2 tab cùng file là hợp lệ. */
let seq = 0;
const nextId = () => `t${++seq}`;

const base = (p: string) => p.split(/[\\/]/).pop() || p;

/** Overlay panes in the same grid cell; hide inactive with visibility (keeps
 *  layout + scroll state — no <webview> here so this is always safe). */
function paneStyle(on: boolean): CSSProperties {
  const s: CSSProperties = { gridColumn: '1 / -1', gridRow: '1', minHeight: 0, display: 'flex', flexDirection: 'column' };
  return on ? s : { ...s, visibility: 'hidden', pointerEvents: 'none' };
}

export default function OfficeWorkspace({ onReady }: OfficeWorkspaceProps = {}) {
  // Mở sẵn một tab bảng tính trống ngay từ render đầu — vào tab Office là thấy
  // màn hình chào của editor (có recents + Tạo file mới), không phải khung rỗng.
  const first = useRef<OfficeTab>({ id: nextId(), kind: 'sheet', path: null, dirtyCount: 0 });
  const [tabs, setTabs] = useState<OfficeTab[]>([first.current]);
  const [activeId, setActiveId] = useState<string>(first.current.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /**
   * Tràn viền: cả tab Office phủ kín cửa sổ.
   *
   * Ẩn KHUNG NGOÀI của app (thanh menu, rail bên trái, chân trang) chứ không
   * ẩn gì của editor — dãy tab tài liệu, ribbon định dạng, thanh trạng thái
   * đều còn nguyên, chỉ là giờ được cả màn hình. Không nhớ qua phiên: mở app
   * lên mà thấy mất thanh menu thì hoảng.
   */
  const [zen, setZen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    // Esc đóng menu — bắt ở giai đoạn capture để không đụng Esc thoát tràn viền.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenuOpen(false);
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [menuOpen]);

  // Esc để thoát tràn viền — nhưng nhường trước cho những thứ Esc đang phục vụ:
  // hộp thoại đang mở, và ô đang gõ dở (Esc ở đó là "hủy sửa đoạn này").
  useEffect(() => {
    if (!zen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop')) return;
      setZen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zen]);

  /** Tab mới luôn mở TRỐNG — màn hình chào của editor lo phần mở file có sẵn /
   *  tạo file mới / danh sách gần đây, nên shell không cần biết đường dẫn. */
  const openTab = useCallback((kind: Kind) => {
    const t: OfficeTab = { id: nextId(), kind, path: null, dirtyCount: 0 };
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
    setMenuOpen(false);
  }, []);

  /**
   * Mở một file có sẵn trên đĩa vào tab mới ("Open with" từ Explorer).
   *
   * Tab đầu tiên của phiên luôn là một bảng tính TRỐNG chưa ai đụng vào — mở
   * file vào thẳng đó thay vì đẻ thêm tab, để bật app từ một file .xlsx không
   * để lại một tab rỗng thừa bên cạnh. Chỉ tái dùng khi đúng loại và còn
   * nguyên trắng (chưa có file, chưa sửa gì).
   */
  const openFile = useCallback((absPath: string) => {
    const kind = kindForPath(absPath);
    // Tab mang id MỚI kể cả khi thay thế tab trắng: initialPath chỉ được editor
    // đọc lúc mount, giữ nguyên id thì React tái dùng instance cũ và file không
    // bao giờ mở ra.
    const t: OfficeTab = { id: nextId(), kind, path: null, dirtyCount: 0, initialPath: absPath };
    setTabs((prev) => {
      const blank = prev.length === 1 && prev[0].kind === kind
        && prev[0].path === null && prev[0].dirtyCount === 0 && !prev[0].initialPath;
      return blank ? [t] : [...prev, t];
    });
    setActiveId(t.id);
  }, []);

  // Đưa openFile lên cho cha. Chạy một lần (openFile ổn định) — cha chỉ cất
  // vào ref chứ không setState, nên không có vòng render nào ở đây.
  useEffect(() => { onReady?.({ openFile }); }, [onReady, openFile]);

  /**
   * Đóng một tab.
   *
   * Hỏi xác nhận và tính tab kế tiếp NGAY TẠI ĐÂY, không đưa vào trong updater
   * của setTabs: updater phải thuần (React gọi nó hai lần ở StrictMode), nếu
   * nhét window.confirm vào đó thì người dùng bị hỏi hai lần.
   */
  const closeTab = useCallback((id: string) => {
    const i = tabs.findIndex((x) => x.id === id);
    if (i < 0) return;
    const t = tabs[i];
    // Đóng tab là MẤT các thay đổi chưa lưu — hỏi lại, cùng kiểu với confirm
    // đã có ở "tải lại" / "tạo file mới" trong hai editor.
    if (t.dirtyCount > 0) {
      const what = t.path ? `"${base(t.path)}"` : 'tài liệu này';
      if (!window.confirm(`${what} đang có ${t.dirtyCount} thay đổi chưa lưu — đóng tab sẽ mất hết. Tiếp tục?`)) return;
    }
    reportersRef.current.delete(id);
    if (id === activeId) {
      // Chuyển sang tab bên phải, không có thì bên trái (như mọi editor).
      const rest = tabs.filter((x) => x.id !== id);
      setActiveId(rest[i]?.id ?? rest[i - 1]?.id ?? '');
    }
    setTabs((prev) => prev.filter((x) => x.id !== id));
  }, [tabs, activeId]);

  /**
   * Editor báo tên file + số thay đổi lên.
   *
   * Hàm truyền xuống phải có ĐỊNH DANH ỔN ĐỊNH: editor gọi nó trong một useEffect
   * phụ thuộc chính nó, nên nếu mỗi lần render lại tạo một closure mới thì effect
   * chạy lại → setTabs → render → vòng lặp vô hạn. Vì vậy cache một callback cho
   * mỗi tab id (chỉ tạo lần đầu) thay vì viết inline `(s) => setDocState(t.id, s)`.
   * setTabs cũng trả về `prev` nguyên vẹn khi giá trị không đổi, chặn render vô ích.
   */
  const reportersRef = useRef(new Map<string, (s: { path: string | null; dirtyCount: number }) => void>());
  const reporterFor = useCallback((id: string) => {
    const cache = reportersRef.current;
    let fn = cache.get(id);
    if (!fn) {
      fn = (s) => setTabs((prev) => {
        const t = prev.find((x) => x.id === id);
        if (!t || (t.path === s.path && t.dirtyCount === s.dirtyCount)) return prev;
        return prev.map((x) => (x.id === id ? { ...x, path: s.path, dirtyCount: s.dirtyCount } : x));
      });
      cache.set(id, fn);
    }
    return fn;
  }, []);

  const dirtyTotal = tabs.reduce((n, t) => n + t.dirtyCount, 0);
  /** Loại của tab đang xem — nút ＋ mở thêm tab cùng loại (đang làm bảng tính
   *  thì thường là muốn thêm bảng tính nữa). */
  const activeKind: Kind = tabs.find((t) => t.id === activeId)?.kind ?? 'sheet';

  // Cảnh báo khi đóng cả cửa sổ mà còn thay đổi chưa lưu ở BẤT KỲ tab nào —
  // trước đây mỗi editor là một tab duy nhất nên nhìn thấy ngay, giờ tab kia có
  // thể đang bị che.
  useEffect(() => {
    if (dirtyTotal === 0) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyTotal]);

  return (
    <div className={`office-layout${zen ? ' zen' : ''}`}>
      <div className="office-tabs" role="tablist" aria-label="Tài liệu đang mở">
        {tabs.map((t) => {
          const on = t.id === activeId;
          const name = t.path ? base(t.path) : `${KIND_META[t.kind].label} mới`;
          return (
            <div key={t.id} className={`office-tab${on ? ' on' : ''}`}>
              <button
                role="tab"
                aria-selected={on}
                className="office-tab-main"
                onClick={() => setActiveId(t.id)}
                title={t.path ?? `${KIND_META[t.kind].label} — chưa mở file`}
              >
                <span className="office-tab-ico" aria-hidden>{KIND_META[t.kind].icon}</span>
                <span className="office-tab-name">{name}</span>
                {t.dirtyCount > 0 && (
                  <span className="office-tab-dot" title={`${t.dirtyCount} thay đổi chưa lưu`} aria-hidden>●</span>
                )}
              </button>
              <button
                className="office-tab-x"
                onClick={() => closeTab(t.id)}
                title={`Đóng ${name}`}
                aria-label={`Đóng ${name}`}
              >✕</button>
            </div>
          );
        })}

        {/* Thêm tab: ＋ mở thẳng một tab CÙNG LOẠI với tab đang xem (việc hay làm
            nhất, khỏi qua menu), ▾ mới bung menu để đổi loại. Menu chỉ còn HAI
            mục — chọn loại thôi, còn mở file có sẵn hay tạo file mới thì làm
            ngay trên màn hình chào của tab vừa mở (ở đó có cả file gần đây). */}
        <div className="office-tab-add" ref={menuRef}>
          <div className="office-tab-addgrp">
            <button
              className="office-tab-addbtn"
              onClick={() => openTab(activeKind)}
              title={`Tab ${KIND_META[activeKind].label.toLowerCase()} mới — bấm ▾ để chọn loại khác`}
            >＋</button>
            <button
              className="office-tab-addcaret"
              onClick={() => setMenuOpen((v) => !v)}
              title="Chọn loại tài liệu cho tab mới"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Chọn loại tài liệu"
            ><span aria-hidden>▾</span></button>
          </div>
          {menuOpen && (
            <div className="office-tab-menu" role="menu">
              {(Object.keys(KIND_META) as Kind[]).map((k) => (
                <button key={k} role="menuitem" onClick={() => openTab(k)}>
                  <span className="office-tab-menu-ico" aria-hidden>{KIND_META[k].icon}</span>
                  <span className="office-tab-menu-txt">
                    <b>{KIND_META[k].label}</b>
                    <span className="office-tab-menu-hint">{KIND_META[k].hint}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className={`office-zen-btn${zen ? ' on' : ''}`}
          onClick={() => setZen((v) => !v)}
          title={zen
            ? 'Thu về khung thường — hiện lại thanh menu của app (Esc)'
            : 'Tràn viền: tài liệu chiếm cả cửa sổ, ẩn thanh menu / rail / chân trang của app. Mọi thanh công cụ của editor vẫn còn.'}
          aria-pressed={zen}
        >
          <span aria-hidden>{zen ? '⤡' : '⤢'}</span> {zen ? 'Thu lại' : 'Tràn viền'}
        </button>
      </div>

      <div className="office-body">
        {tabs.length === 0 && (
          <div className="panel" style={{ margin: 'auto', textAlign: 'center' }}>
            <p className="small" style={{ color: 'var(--muted)' }}>
              Không có tài liệu nào đang mở — bấm <b>＋</b> để mở bảng tính hoặc văn bản.
            </p>
          </div>
        )}
        {tabs.map((t) => (
          <div key={t.id} style={paneStyle(t.id === activeId)} aria-hidden={t.id !== activeId}>
            {/* `active`: phím tắt bắt trên window (Ctrl+S của Word) chỉ được
                chạy ở tab đang xem — xem WordWorkspaceProps.active. */}
            {t.kind === 'sheet'
              ? <SheetWorkspace initialPath={t.initialPath} onDocState={reporterFor(t.id)} active={t.id === activeId} />
              : <WordWorkspace initialPath={t.initialPath} onDocState={reporterFor(t.id)} active={t.id === activeId} />}
          </div>
        ))}
      </div>

    </div>
  );
}
