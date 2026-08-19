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

  return (
    <div className="bx-bar">
      {withPopup.map((e) => (
        <button
          key={e.id}
          className={`bx-bar-btn${openId === e.id ? ' on' : ''}`}
          title={e.actionTitle || e.name}
          onClick={() => setOpenId((v) => (v === e.id ? null : e.id))}
        >
          {e.iconUrl
            /* eslint-disable-next-line @next/next/no-img-element */
            ? <img src={e.iconUrl} alt={e.name} width={16} height={16} />
            : <span aria-hidden>🧩</span>}
        </button>
      ))}

      <button className="bx-bar-btn bx-bar-manage" onClick={onManage} title="Quản lý extension">
        🧩
      </button>

      {open && (
        <div className="bx-popup" ref={popupRef} style={{ width: POPUP_W, height: POPUP_H }}>
          <div className="bx-popup-head">
            <b>{open.name}</b>
            <span style={{ flex: 1 }} />
            <button className="ghost sm" onClick={() => setOpenId(null)} title="Đóng (Esc)">✕</button>
          </div>
          {/* Popup nạp bằng chính URL chrome-extension:// nên nó ở ĐÚNG origin
              của extension — chrome.storage/runtime là hàng thật. Preload riêng
              chỉ bù chrome.tabs + chrome.cookies. */}
          <webview
            ref={wvRef as unknown as React.Ref<HTMLElement>}
            src={popupSrc}
            partition={partition}
            style={{ width: '100%', flex: 1, border: 0 }}
          />
        </div>
      )}

      {/* chrome.tabs.update từ popup đi qua đây: preload gửi ipc lên main,
          main phát ngược xuống renderer, và tab Browser tự điều hướng — xem
          onNavigate ở BrowserTabWorkspace. */}
      <ExtNavBridge onNavigate={onNavigate} />
    </div>
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
