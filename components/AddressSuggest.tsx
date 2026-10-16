'use client';

// Danh sách GỢI Ý cho ô địa chỉ — như thanh địa chỉ trình duyệt: gõ vài chữ là
// hiện lại những trang đã vào, chọn bằng ↑↓ + Enter, khỏi phải nhớ và gõ lại
// cả URL dài.
//
// Dùng chung cho HAI ô địa chỉ của tab Browser:
//   • ô ở trang new-tab / panel ＋ (BrowserTabWorkspace)
//   • ô địa chỉ trong từng tab (LinkViewer)
// Hai chỗ đó khác nhau về khung bao và cách "đi tới", nên component này chỉ lo
// PHẦN DANH SÁCH; ô <input> vẫn do chủ khung dựng và giữ state chữ đang gõ.
// Nhờ vậy không phải đụng vào logic điều hướng/URL đã có ở hai nơi.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { makeSuggester, historyRemove, webSuggest, type HistoryEntry } from '@/lib/browserHistory';
import { usePopupOverWebview } from '@/lib/useOverWebview';
import { normalizeUrl } from '@/lib/bookmarks';

interface Props {
  /** Chữ đang gõ trong ô địa chỉ. */
  query: string;
  /** Ô đang có focus / danh sách đang được phép hiện. */
  open: boolean;
  /** Chọn một gợi ý → chủ khung điều hướng tới URL này. */
  onPick: (url: string) => void;
  /** Người dùng bỏ danh sách (Esc, bấm ra ngoài). */
  onClose: () => void;
  /** Gắn phía trên ô nhập thay vì phía dưới — cho ô nằm sát đáy khung. */
  above?: boolean;
  /** Ô địa chỉ này nằm TRONG khung có <webview> (LinkViewer) → cần cờ nổi lên
   *  trên guest, không thì danh sách bị trang web che kín và bấm không được. */
  overWebview?: boolean;
}

/** Bao nhiêu dòng gợi ý — quá dài thì che mất trang, quá ngắn thì thiếu. */
const LIMIT = 8;

const shortUrl = (u: string): string => u.replace(/^https?:\/\//, '').replace(/^www\./, '');

/**
 * Handle bàn phím + state của danh sách gợi ý, tách ra thành hook vì ô <input>
 * do CHỦ KHUNG dựng: phím ↑↓/Enter/Esc bắn ở input, mà danh sách lại ở đây.
 *
 * Chủ khung dùng như sau:
 *   const sg = useAddressSuggest({ query: draft, onPick: navigate });
 *   <input ... onKeyDown={(e) => { if (sg.onKeyDown(e)) return; ...phím của mình }} />
 *   <AddressSuggest {...sg.listProps} />
 *
 * `onKeyDown` trả về true = "tôi đã xử lý phím này", chủ khung đừng làm gì nữa.
 * Nhờ chốt đó, Enter khi đang chọn một gợi ý sẽ đi tới GỢI Ý, còn Enter khi
 * không chọn gì vẫn đi tới đúng chữ người dùng gõ như trước.
 */
export function useAddressSuggest(opts: {
  query: string;
  onPick: (url: string) => void;
  /** Đang được phép hiện (ô có focus). Mặc định true. */
  enabled?: boolean;
  /** Chữ gõ ngắn hơn mức này thì KHÔNG gợi ý (0 = ô trống vẫn hiện "gần đây").
   *  Ô trang new-tab đặt 1: trang trắng, chỉ gợi ý khi người dùng gõ. ↓ vẫn
   *  mở được danh sách gần đây, như Chrome. */
  minChars?: number;
  /** Alt+Enter: mở đích trong TAB MỚI (không truyền = Alt+Enter như Enter thường). */
  onPickNewTab?: (url: string) => void;
}) {
  const { query, onPick, enabled = true, minChars = 0, onPickNewTab } = opts;
  /** Gợi ý tìm kiếm của Google cho câu đang gõ. */
  const [web, setWeb] = useState<string[]>([]);
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [sel, setSel] = useState(-1);   // -1 = chưa chọn dòng nào (giữ chữ đang gõ)
  const [open, setOpen] = useState(false);
  /** Người dùng đã Esc/chọn xong với ĐÚNG câu này → đừng bật lại danh sách cho
   *  tới khi chữ đổi. Không có cờ này thì Esc xong effect chạy lại và danh sách
   *  bật lên ngay lập tức. */
  const dismissedRef = useRef<string | null>(null);

  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const newTabRef = useRef(onPickNewTab);
  newTabRef.current = onPickNewTab;

  // Gợi ý web: hoãn 150ms, bỏ kết quả về muộn. Chỉ hỏi khi chữ giống TỪ KHÓA —
  // có scheme / không dấu cách mà có dấu chấm (URL, host) thì không gửi lên Google.
  useEffect(() => {
    const q = query.trim();
    const looksUrl = /^[a-z]+:\/\//i.test(q) || (!/\s/.test(q) && /[./:]/.test(q));
    if (!enabled || q.length < Math.max(1, minChars) || looksUrl) { setWeb([]); return; }
    let live = true;
    const t = setTimeout(() => {
      void webSuggest(q).then((r) => { if (live) setWeb(r.filter((x) => x.toLowerCase() !== q.toLowerCase())); })
        .catch(() => { if (live) setWeb([]); });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [query, enabled, minChars]);
  const total = list.length + web.length;
  /** Dòng thứ i: lịch sử (url) rồi tới gợi ý web (chữ tìm kiếm). */
  const textAt = (i: number): string | null =>
    i < 0 ? null : i < list.length ? list[i].url : (web[i - list.length] ?? null);

  // Một suggester cho cả vòng đời component — nó tự chống gõ dồn và tự bỏ
  // những kết quả về muộn hơn lần gõ mới nhất.
  const sugRef = useRef<ReturnType<typeof makeSuggester> | null>(null);
  useEffect(() => {
    sugRef.current = makeSuggester((rows) => {
      setList(rows);
      // Danh sách mới → bỏ dòng đang chọn: giữ chỉ số cũ là chọn nhầm sang một
      // URL khác hẳn, Enter một cái là đi tới trang không ai muốn.
      setSel(-1);
    });
    return () => { sugRef.current?.dispose(); sugRef.current = null; };
  }, []);

  useEffect(() => {
    if (!enabled) { setOpen(false); sugRef.current?.cancel(); return; }
    if (query.trim().length < minChars) {
      sugRef.current?.cancel();
      setList([]); setSel(-1); setOpen(false);
      return;
    }
    if (dismissedRef.current === query) { setOpen(false); return; }
    sugRef.current?.query(query, LIMIT);
    setOpen(true);
  }, [query, enabled, minChars]);

  // Câu đang gõ ĐÃ đổi so với lúc Esc → cho phép danh sách hiện lại.
  useEffect(() => {
    if (dismissedRef.current !== null && dismissedRef.current !== query) dismissedRef.current = null;
  }, [query]);

  const close = useCallback(() => {
    dismissedRef.current = query;
    setOpen(false);
    setSel(-1);
    sugRef.current?.cancel();
  }, [query]);

  const pick = useCallback((url: string) => {
    dismissedRef.current = query;
    setOpen(false);
    setSel(-1);
    onPickRef.current(url);
  }, [query]);

  /** Bỏ một địa chỉ khỏi lịch sử ngay trên danh sách (Shift+Delete / nút ✕). */
  const drop = useCallback((url: string) => {
    // Bỏ khỏi danh sách đang hiện TRƯỚC khi API trả về: đợi round-trip thì
    // dòng vừa xoá còn nằm đó cả nhịp, trông như bấm không ăn.
    setList((cur) => cur.filter((e) => e.url !== url));
    setSel(-1);
    void historyRemove(url).catch(() => {});
  }, []);

  // Dòng "chữ đang gõ" luôn đứng đầu như Chrome (tìm Google / mở URL) nên danh
  // sách hiện cả khi lịch sử không khớp gì.
  const typed = query.trim().length > 0;
  const visible = open && (total > 0 || typed);

  /**
   * @returns true nếu phím đã được danh sách gợi ý xử lý.
   */
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    // Alt+Enter = tab mới, như Chrome. Đích là dòng đang chọn, không chọn gì thì
    // là chữ đang gõ (URL hoặc tìm Google).
    if (e.key === 'Enter' && e.altKey && newTabRef.current) {
      const raw = (sel >= 0 ? textAt(sel) : null) ?? e.currentTarget.value;
      const target = normalizeUrl(raw);
      if (target) {
        e.preventDefault();
        close();
        newTabRef.current(target);
        return true;
      }
    }
    if (!visible) {
      // Danh sách đang tắt: ↓ mở lại (như Chrome — bấm ↓ ở ô địa chỉ trống là
      // xem lại các trang gần đây).
      if (e.key === 'ArrowDown') {
        if (total > 0) {
          e.preventDefault();
          dismissedRef.current = null;
          setOpen(true);
          setSel(0);
          return true;
        }
        // Ô trống dưới ngưỡng minChars: chưa có danh sách → nạp "gần đây" rồi mở.
        if (enabled && query.trim().length < minChars) {
          e.preventDefault();
          sugRef.current?.query(query, LIMIT);
          setOpen(true);
          return true;
        }
      }
      return false;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSel((i) => (i + 1 >= total ? -1 : i + 1)); // qua cuối → về lại chữ đang gõ
        return true;
      case 'ArrowUp':
        e.preventDefault();
        setSel((i) => (i <= -1 ? total - 1 : i - 1));
        return true;
      case 'Enter':
        if (sel >= 0 && textAt(sel)) { e.preventDefault(); pick(sel < list.length ? list[sel].url : normalizeUrl(textAt(sel)!)); return true; }
        // Không chọn dòng nào → để chủ khung đi tới đúng chữ đã gõ.
        close();
        return false;
      case 'Tab':
        // Tab = điền gợi ý đầu vào ô nhưng CHƯA đi — đúng như trình duyệt.
        if (total > 0) { e.preventDefault(); setSel(0); return true; }
        return false;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        return true;
      case 'Delete':
        // Shift+Delete xoá dòng đang chọn khỏi lịch sử, như Chrome.
        if (e.shiftKey && sel >= 0 && list[sel]) { e.preventDefault(); drop(list[sel].url); return true; }
        return false;
      default:
        return false;
    }
  }, [visible, list, web, sel, pick, close, drop, enabled, query, minChars]);

  /** URL của dòng đang chọn — chủ khung hiện nó trong ô nhập cho giống Chrome. */
  const preview = textAt(sel);

  const listProps = useMemo(() => ({
    rows: list, web, sel, visible, query, onPick: pick, onHover: setSel, onDrop: drop, onClose: close,
  }), [list, web, sel, visible, query, pick, drop, close]);

  return { onKeyDown, listProps, close, visible, preview };
}

type ListProps = ReturnType<typeof useAddressSuggest>['listProps'] & {
  above?: boolean;
  overWebview?: boolean;
};

/** Danh sách gợi ý. Đặt trong một khung `position: relative` của chủ khung. */
export default function AddressSuggest({
  rows, web, sel, visible, query, onPick, onHover, onDrop, onClose, above, overWebview,
}: ListProps) {
  // Danh sách của ô địa chỉ trong tab nằm ngay trên <webview>: không bật cờ thì
  // trang web (vẽ ở tầng native) che kín, bấm vào là bấm vào trang.
  usePopupOverWebview(!!overWebview && visible);

  // Bấm ra ngoài thì đóng. Nghe ở 'mousedown' để đóng TRƯỚC khi ô nhập mất
  // focus — nghe 'click' thì thứ tự đảo và cú bấm vào chính một dòng gợi ý bị
  // tính là "bấm ra ngoài".
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    const onDown = (ev: MouseEvent) => {
      const box = boxRef.current;
      if (!box) return;
      const t = ev.target as Node | null;
      if (t && (box.contains(t) || box.parentElement?.contains(t))) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [visible, onClose]);

  if (!visible) return null;

  const q = query.trim();
  const target = q ? normalizeUrl(q) : '';
  const isSearch = target.startsWith('https://www.google.com/search?q=');
  // Tô đậm phần khớp với chữ đang gõ — mắt quét nhanh hơn nhiều.
  const mark = (text: string) => {
    if (!q) return text;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text;
    return <>{text.slice(0, i)}<b>{text.slice(i, i + q.length)}</b>{text.slice(i + q.length)}</>;
  };

  return (
    <div ref={boxRef} className={`addr-sug${above ? ' addr-sug--above' : ''}`} role="listbox">
      {q && (
        <div
          className="addr-sug-row addr-sug-typed"
          role="option"
          aria-selected={false}
          onMouseDown={(ev) => { ev.preventDefault(); onPick(target); }}
          title={target}
        >
          <span className="addr-sug-ico" aria-hidden>{isSearch ? '🔍' : '🌐'}</span>
          <span className="addr-sug-text">
            <span className="addr-sug-title">{q}</span>
            <span className="addr-sug-url">{isSearch ? 'Tìm trên Google' : 'Mở địa chỉ'}</span>
          </span>
        </div>
      )}
      {rows.map((e, i) => (
        <div
          key={e.url}
          className={`addr-sug-row${i === sel ? ' on' : ''}`}
          role="option"
          aria-selected={i === sel}
          // mousedown chứ không click: click chỉ bắn sau mouseup, mà giữa hai
          // mốc đó ô nhập đã mất focus và luồng "bấm ra ngoài" có thể đã đóng
          // danh sách — cú bấm rơi vào khoảng trống.
          onMouseDown={(ev) => { ev.preventDefault(); onPick(e.url); }}
          onMouseEnter={() => onHover(i)}
          title={e.url}
        >
          <span className="addr-sug-ico" aria-hidden>🕘</span>
          <span className="addr-sug-text">
            <span className="addr-sug-title">{mark(e.title || e.host || shortUrl(e.url))}</span>
            <span className="addr-sug-url">{mark(shortUrl(e.url))}</span>
          </span>
          {e.visitCount > 1 && <span className="addr-sug-n" title={`Đã vào ${e.visitCount} lần`}>{e.visitCount}</span>}
          <button
            className="addr-sug-x"
            title="Bỏ khỏi lịch sử (Shift+Delete)"
            onMouseDown={(ev) => { ev.preventDefault(); ev.stopPropagation(); onDrop(e.url); }}
          >
            ✕
          </button>
        </div>
      ))}
      {web.map((w, j) => {
        const i = rows.length + j;
        return (
          <div
            key={`w:${w}`}
            className={`addr-sug-row${i === sel ? ' on' : ''}`}
            role="option"
            aria-selected={i === sel}
            onMouseDown={(ev) => { ev.preventDefault(); onPick(normalizeUrl(w)); }}
            onMouseEnter={() => onHover(i)}
            title={w}
          >
            <span className="addr-sug-ico" aria-hidden>🔍</span>
            <span className="addr-sug-text">
              <span className="addr-sug-title">{mark(w)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
