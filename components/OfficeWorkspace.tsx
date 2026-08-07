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
// Markdown (.md) KHÔNG ở đây — nó là định dạng text nên nằm ở tab Tools cùng
// JSON / XML / HTML (xem components/ToolsWorkspace.tsx).

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import FolderPicker from './FolderPicker';
import SheetWorkspace from './SheetWorkspace';
import WordWorkspace from './WordWorkspace';

type Kind = 'sheet' | 'word';

const KIND_META: Record<Kind, { icon: string; label: string; exts: string[]; pickTitle: string }> = {
  sheet: { icon: '▦', label: 'Bảng tính', exts: ['xlsx', 'csv'], pickTitle: 'Chọn file .xlsx / .csv' },
  word: { icon: '🗎', label: 'Văn bản', exts: ['docx'], pickTitle: 'Chọn file .docx' },
};

interface OfficeTab {
  /** Khóa ổn định — dùng làm React key nên KHÔNG bao giờ đổi trong đời tab. */
  id: string;
  kind: Kind;
  /** Đường dẫn mở lúc tạo tab (undefined = tab trống, editor hiện màn hình chào). */
  initialPath?: string;
  /** Đường dẫn THẬT hiện tại + số thay đổi, do editor báo lên. */
  path: string | null;
  dirtyCount: number;
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

export default function OfficeWorkspace() {
  // Mở sẵn một tab bảng tính trống ngay từ render đầu — vào tab Office là thấy
  // màn hình chào của editor (có recents + Tạo file mới), không phải khung rỗng.
  const first = useRef<OfficeTab>({ id: nextId(), kind: 'sheet', path: null, dirtyCount: 0 });
  const [tabs, setTabs] = useState<OfficeTab[]>([first.current]);
  const [activeId, setActiveId] = useState<string>(first.current.id);
  /** Đang chọn file để mở vào tab MỚI (null = không mở hộp thoại nào). */
  const [picking, setPicking] = useState<Kind | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [menuOpen]);

  const openTab = useCallback((kind: Kind, initialPath?: string) => {
    const t: OfficeTab = { id: nextId(), kind, initialPath, path: initialPath ?? null, dirtyCount: 0 };
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
    setMenuOpen(false);
  }, []);

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
    <div className="office-layout">
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

        <div className="office-tab-add" ref={menuRef}>
          <button className="office-tab-addbtn" onClick={() => setMenuOpen((v) => !v)} title="Mở tài liệu trong tab mới">
            ＋<span className="office-tab-caret" aria-hidden>▾</span>
          </button>
          {menuOpen && (
            <div className="office-tab-menu" role="menu">
              <button role="menuitem" onClick={() => { setMenuOpen(false); setPicking('sheet'); }}>
                <span aria-hidden>▦</span> Mở bảng tính…
              </button>
              <button role="menuitem" onClick={() => { setMenuOpen(false); setPicking('word'); }}>
                <span aria-hidden>🗎</span> Mở văn bản…
              </button>
              <span className="office-tab-menu-sep" aria-hidden />
              {/* Tab trống → editor hiện màn hình chào (có recents + Tạo file mới). */}
              <button role="menuitem" onClick={() => openTab('sheet')}>
                <span aria-hidden>▦</span> Bảng tính mới
              </button>
              <button role="menuitem" onClick={() => openTab('word')}>
                <span aria-hidden>🗎</span> Văn bản mới
              </button>
            </div>
          )}
        </div>
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

      {picking && (
        <FolderPicker
          title={KIND_META[picking].pickTitle}
          fileExts={KIND_META[picking].exts}
          onPickFile={(p) => { openTab(picking, p); setPicking(null); }}
          onPick={() => {}}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
