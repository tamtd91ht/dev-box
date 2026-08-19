'use client';

// Thanh công cụ extension của tab Browser — chỗ bấm icon để mở popup, giống
// vùng icon extension bên phải thanh địa chỉ của Chrome.
//
// VÌ SAO CẦN: Electron KHÔNG dựng thanh công cụ cho extension. Extension nào
// sống bằng popup (bấm icon → hiện bảng nhỏ) thì trên <webview> coi như mất
// hẳn giao diện, dù code bên trong vẫn chạy được. Thanh này dựng lại phần đó.
//
// POPUP CHẠY THẬT, KHÔNG PHẢI DỰNG LẠI: popup nạp bằng chính URL
// `chrome-extension://<id>/popup.html` trong một <webview> riêng, nên nó ở
// ĐÚNG origin của extension — `chrome.storage`, `chrome.runtime` và messaging
// sang service worker đều là hàng thật của Electron, không phải đồ giả.
//
// PHẦN PHẢI VÁ là mấy API Electron không cấp:
//   · chrome.tabs.query/update — popup cần biết tab đang xem và điều hướng nó
//   · chrome.cookies.getAll    — đọc cookie HttpOnly của profile
// Hai thứ này bơm vào popup qua preload riêng (electron/ext-popup-preload.cjs).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ExtItem {
  path: string;
  name: string;
  version: string;
  enabled: boolean;
  loaded: boolean;
  missing: boolean;
  id: string;
  popupUrl: string;
  actionTitle: string;
  iconUrl: string;
  warnings: string[];
  matches: string[];
}

/** Kích thước popup của Chrome — bám theo để layout của extension không vỡ. */
const POPUP_W = 380;
const POPUP_H = 600;

export default function BrowserExtBar({
  partition,
  activeUrl,
  onNavigate,
  onManage,
}: {
  /** Partition của tab đang xem — popup hỏi cookie/tab theo profile này. */
  partition: string;
  /** URL tab đang xem — trả lời cho chrome.tabs.query. */
  activeUrl: string;
  /** chrome.tabs.update → đổi địa chỉ tab đang xem. */
  onNavigate: (url: string) => void;
  /** Mở bảng quản lý extension (🧩). */
  onManage: () => void;
}) {
  const [items, setItems] = useState<ExtItem[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  /** createPortal cần document — server render không có. */
  const [mounted, setMounted] = useState(false);
  /** Vị trí neo popup, tính từ thanh công cụ (px so với viewport). */
  const [pos, setPos] = useState({ top: 0, right: 0 });

  useEffect(() => setMounted(true), []);

  const refresh = useCallback(async () => {
    try {
      const r = await window.browserExt?.list();
      if (r?.ok) setItems(r.items as ExtItem[]);
    } catch {
      /* thanh phụ trợ — im lặng */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Danh sách đổi khi người dùng thêm/bật/tắt trong bảng quản lý. Không có
  // event nào báo, nên nghe lại mỗi lần bảng đó đóng (onManage đổi state cha)
  // và khi cửa sổ lấy lại focus — đủ để thanh không bị lệch thực tế.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // Popup đã portal ra body nên nó KHÔNG còn neo theo thanh công cụ được nữa —
  // phải tự tính toạ độ. Đo lại khi mở, và khi cửa sổ đổi kích thước.
  useEffect(() => {
    if (!openId) return;
    const place = () => {
      const r = barRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({
        top: Math.round(r.bottom + 6),
        // Neo mép PHẢI theo mép phải của thanh: popup rộng 380px, neo trái sẽ
        // tràn ra ngoài khi thanh nằm sát bên phải cửa sổ.
        right: Math.max(8, Math.round(window.innerWidth - r.right)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [openId]);

  // Bấm ra ngoài / Esc → đóng popup, đúng như Chrome.
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: MouseEvent) => {
      if (!popupRef.current?.contains(e.target as Node)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null); };
    // `capture` để bắt trước khi trang trong webview nuốt sự kiện.
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [openId]);

  /** Chỉ extension đã nạp thật + có popup mới lên thanh công cụ. */
  const withPopup = items.filter((e) => e.enabled && e.loaded && e.popupUrl);
  const open = withPopup.find((e) => e.id === openId) || null;

  // Popup cần biết tab nào đang xem để trả lời chrome.tabs.query.
  //
  // Bối cảnh đi NGAY TRONG URL chứ không gửi qua IPC sau khi attach: script của
  // popup chạy ngay lúc tải, gọi chrome.tabs.query gần như tức thì — gửi sau
  // thì đã muộn, popup đã đọc phải giá trị rỗng.
  //
  // Tham số nằm ở HASH (#) chứ không phải query (?): nhiều popup tự đọc
  // `location.search` cho router của chúng, thêm tham số lạ vào đó là làm hỏng
  // router của người ta.
  const wvRef = useRef<HTMLElement | null>(null);
  const popupSrc = open
    ? open.popupUrl + '#__devbox=' + encodeURIComponent(JSON.stringify({ partition, activeUrl }))
    : '';

  // Chẩn đoán khi popup trắng. Script của extension ném lỗi thì <webview> chỉ
  // hiện nền trắng và không báo gì — bắt console-message mức error cùng
  // did-fail-load để có cái mà đọc, thay vì phải mở DevTools mới biết.
  const [diag, setDiag] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setDiag('');
    if (!open) return;
    // Popup của OTool gọi API rồi mới vẽ — mất vài giây, trong lúc đó <webview>
    // là nền trắng trơn. Không báo gì thì nhìn y như hỏng.
    setLoading(true);
    const el = wvRef.current;
    if (!el) return;
    const done = () => setLoading(false);
    const onMsg = (ev: Event) => {
      const e = ev as Event & { level?: number; message?: string };
      // level 3 = error trong Electron.
      if (e.level === 3 && e.message) setDiag((d) => d || `Lỗi trong popup: ${e.message}`);
    };
    const onFail = (ev: Event) => {
      const e = ev as Event & { errorCode?: number; errorDescription?: string };
      // -3 = ABORTED, xảy ra khi điều hướng bị thay thế — không phải lỗi thật.
      if (e.errorCode === -3) return;
      setDiag(`Không tải được popup: ${e.errorDescription || e.errorCode}`);
    };
    el.addEventListener('console-message', onMsg as EventListener);
    el.addEventListener('did-fail-load', onFail as EventListener);
    el.addEventListener('dom-ready', done);
    el.addEventListener('did-finish-load', done);
    el.addEventListener('did-stop-loading', done);
    return () => {
      el.removeEventListener('console-message', onMsg as EventListener);
      el.removeEventListener('did-fail-load', onFail as EventListener);
      el.removeEventListener('dom-ready', done);
      el.removeEventListener('did-finish-load', done);
      el.removeEventListener('did-stop-loading', done);
    };
  }, [open]);

  return (
    <div className="bx-bar" ref={barRef}>
      {/* POPUP KHÔNG PHỤ THUỘC TRANG ĐANG XEM — đúng như Chrome: `matches` chỉ
          chi phối content script, còn nút trên thanh công cụ thì bấm ở đâu cũng
          mở được. Bản trước làm mờ icon khi URL không khớp là sai nguyên tắc,
          và còn dựa trên `activeUrl` vốn là URL LÚC MỞ TAB chứ không phải địa
          chỉ hiện tại (trang tự chuyển hướng là lệch ngay). Đã bỏ hẳn. */}
      {withPopup.map((e) => (
        <button
          key={e.id}
          className={`bx-bar-btn${openId === e.id ? ' on' : ''}`}
          title={e.actionTitle || e.name}
          onClick={() => setOpenId((v) => (v === e.id ? null : e.id))}
        >
          <ExtIcon url={e.iconUrl} name={e.name} />
        </button>
      ))}

      <button className="bx-bar-btn bx-bar-manage" onClick={onManage} title="Quản lý extension">
        🧩
      </button>

      {/* PORTAL ra document.body — BẮT BUỘC, không phải cho đẹp.
          Thanh tab (.lv-tabbar) có `overflow-x: auto`, mà overflow khác
          `visible` thì CẮT CỤT mọi con tràn ra ngoài — popup nằm dưới thanh tab
          bị clip sạch, kể cả nút đóng. Nhìn y như "bấm xong chẳng có gì".
          Ra thẳng body thì không cha nào cắt được nữa. */}
      {open && mounted && createPortal(
        <div
          className="bx-popup"
          ref={popupRef}
          style={{ width: POPUP_W, maxHeight: POPUP_H, top: pos.top, right: pos.right }}
        >
          <div className="bx-popup-head">
            <b>{open.name}</b>
            <span style={{ flex: 1 }} />
            <button
              className="ghost sm"
              onClick={() => {
                const el = wvRef.current as (HTMLElement & { openDevTools?: () => void }) | null;
                try { el?.openDevTools?.(); } catch { /* chưa attach */ }
              }}
              title="Mở DevTools của popup — xem lỗi khi popup trắng"
            >
              🔍
            </button>
            <button className="ghost sm" onClick={() => setOpenId(null)} title="Đóng (Esc)">✕</button>
          </div>
          {/* Popup nạp bằng chính URL chrome-extension:// nên nó ở ĐÚNG origin
              của extension — chrome.storage/runtime là hàng thật. Preload riêng
              chỉ bù chrome.tabs + chrome.cookies. */}
          <div className="bx-popup-body">
            <webview
              ref={wvRef as unknown as React.Ref<HTMLElement>}
              src={popupSrc}
              partition={partition}
              style={{ width: '100%', height: '100%', border: 0 }}
            />
            {loading && (
              <div className="bx-popup-loading">
                <span className="spinner" aria-hidden /> Đang mở…
              </div>
            )}
          </div>
          {/* Popup trắng là ca hay gặp nhất và khó đoán nhất — script của
              extension ném lỗi thì <webview> chỉ hiện nền trắng, không báo gì.
              Dòng này gom lỗi console + did-fail-load để nhìn là biết ngay. */}
          {diag && <div className="bx-popup-diag" title={diag}>{diag}</div>}
        </div>,
        document.body,
      )}

      {/* chrome.tabs.update từ popup đi qua đây: preload gửi ipc lên main,
          main phát ngược xuống renderer, và tab Browser tự điều hướng — xem
          onNavigate ở BrowserTabWorkspace. */}
      <ExtNavBridge onNavigate={onNavigate} />
    </div>
  );
}

/**
 * Icon extension, tự lùi về 🧩 khi ảnh không tải được.
 *
 * Không có nhánh lùi này thì trình duyệt vẽ biểu tượng "ảnh vỡ" — nhìn như app
 * hỏng, trong khi chỉ là extension không khai icon hoặc khai sai đường dẫn.
 */
function ExtIcon({ url, name }: { url: string; name: string }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [url]);   // đổi extension thì thử lại từ đầu
  if (!url || bad) return <span aria-hidden>🧩</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={name} width={16} height={16} onError={() => setBad(true)} />
  );
}

/** Nghe yêu cầu điều hướng do popup phát ra và chuyển cho tab Browser. */
function ExtNavBridge({ onNavigate }: { onNavigate: (url: string) => void }) {
  useEffect(() => {
    const off = window.browserExt?.onNavigate?.((url: string) => {
      if (typeof url === 'string' && url) onNavigate(url);
    });
    return () => { off?.(); };
  }, [onNavigate]);
  return null;
}
