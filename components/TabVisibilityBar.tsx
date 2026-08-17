'use client';

// HIỆN/ẨN TÍNH NĂNG — nút ⚙ trên thanh tiêu đề + bảng bật lại tab đã ẩn.
//
// DevBox có hơn 20 tab, mỗi người chỉ dùng vài cái. Hover lên một tab trên menu
// rồi bấm ✕ là ẩn nó đi; đây là NƠI DUY NHẤT bật lại — nên nút luôn hiện, kể cả
// khi chưa ẩn gì, để người dùng biết đường quay lại.
//
// ẨN CHỈ LÀ CHUYỆN GIAO DIỆN — automation, watcher, mail poll của tab bị ẩn vẫn
// chạy nguyên (xem ghi chú đầu lib/hiddenTabs.ts). Bảng này nói rõ điều đó để
// không ai tưởng ẩn tab là tắt tính năng.

import { useEffect, useRef, useState } from 'react';
import * as hiddenTabs from '@/lib/hiddenTabs';
import type { TabInfo } from './QuickTabs';

export interface TabVisibilityBarProps {
  /** Khoá các tab đang bị ẩn. */
  hidden: string[];
  /** Mọi khoá tab có thể ẩn/hiện, theo thứ tự trên thanh menu. */
  allKeys: string[];
  /** Tra nhãn cho một khoá tab; undefined nghĩa là tab không còn (pack bị gỡ). */
  info: (key: string) => TabInfo | undefined;
}

export default function TabVisibilityBar({ hidden, allKeys, info }: TabVisibilityBarProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Bấm ra ngoài / Esc → đóng bảng, như mọi dropdown khác trong app.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // <webview> của Electron vẽ ở TẦNG NATIVE, nằm trên mọi phần tử HTML bất kể
  // z-index — bảng này sẽ bị pane Links/Browser/Workspace che mất. Cùng cách xử
  // lý như UltraBar: đặt cờ trên <html>, CSS tạm đẩy webview ra khỏi màn hình.
  useEffect(() => {
    const root = document.documentElement;
    if (open) root.setAttribute('data-modal-over-webview', '1');
    else root.removeAttribute('data-modal-over-webview');
    return () => root.removeAttribute('data-modal-over-webview');
  }, [open]);

  const nHidden = hidden.length;

  return (
    <div className="tvis" ref={boxRef}>
      <button
        className={`tvis-btn${nHidden > 0 ? ' is-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={
          nHidden > 0
            ? `Đang ẩn ${nHidden} tính năng khỏi menu — bấm để bật lại`
            : 'Hiện/ẩn tính năng trên menu'
        }
        aria-pressed={open}
        aria-label="Hiện/ẩn tính năng"
      >
        <span className="tvis-ico" aria-hidden>⚙</span>
        {nHidden > 0 && <span className="tvis-count">{nHidden}</span>}
      </button>

      {open && (
        <>
          <div className="tvis-scrim" onClick={() => setOpen(false)} aria-hidden />
          <div className="tvis-pop" role="dialog" aria-label="Hiện/ẩn tính năng">
            <div className="tvis-pop-head">
              <div>
                <b>Hiện/ẩn tính năng</b>
                <span className="tvis-pop-sub">
                  bỏ tick để ẩn khỏi menu — hover lên tab rồi bấm ✕ cũng được
                </span>
              </div>
              <button className="tvis-pop-x" onClick={() => setOpen(false)} aria-label="Đóng">×</button>
            </div>

            <div className="tvis-note">
              Ẩn chỉ giấu tab khỏi thanh menu. <b>Automation, watcher và thông báo
              của tab đó vẫn chạy bình thường</b> — bật lại là thấy nguyên trạng.
            </div>

            <div className="tvis-actions">
              <span className="tvis-stat">
                {nHidden === 0 ? 'Đang hiện tất cả' : `Đang ẩn ${nHidden}/${allKeys.length}`}
              </span>
              <button
                className="ghost sm"
                disabled={nHidden === 0}
                onClick={() => hiddenTabs.showAll()}
              >Hiện lại tất cả</button>
            </div>

            <div className="tvis-list">
              {allKeys.map((k) => {
                const t = info(k);
                if (!t) return null;
                const isHidden = hidden.includes(k);
                return (
                  <label key={k} className={`tvis-item${isHidden ? ' is-off' : ''}`}>
                    <input
                      type="checkbox"
                      checked={!isHidden}
                      onChange={() => hiddenTabs.toggle(k)}
                    />
                    <span className="tvis-item-ico" aria-hidden>{t.icon}</span>
                    <span className="tvis-item-label">{t.label}</span>
                    <span className="tvis-item-badge">{t.badge}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
