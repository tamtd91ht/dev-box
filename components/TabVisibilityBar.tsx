'use client';

// CÀI ĐẶT — nút ⚙ trên thanh tiêu đề: hiện/ẩn tính năng + tải file về.
//
// DevBox có hơn 20 tab, mỗi người chỉ dùng vài cái. Hover lên một tab trên menu
// rồi bấm ✕ là ẩn nó đi (có bước xác nhận); đây là NƠI DUY NHẤT bật lại — nên
// nút luôn hiện, kể cả khi chưa ẩn gì, để người dùng biết đường quay lại.
//
// ẨN CHỈ LÀ CHUYỆN GIAO DIỆN — automation, watcher, mail poll của tab bị ẩn vẫn
// chạy nguyên (xem ghi chú đầu lib/hiddenTabs.ts). Bảng này nói rõ điều đó để
// không ai tưởng ẩn tab là tắt tính năng.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as hiddenTabs from '@/lib/hiddenTabs';
import DownloadPrefs from './DownloadPrefs';
import type { TabInfo } from './QuickTabs';
import { useModalOverWebview } from '@/lib/useOverWebview';

export interface TabVisibilityBarProps {
  /** Khoá các tab đang bị ẩn. */
  hidden: string[];
  /** Mọi khoá tab có thể ẩn/hiện, theo thứ tự trên thanh menu. */
  allKeys: string[];
  /** Tra nhãn cho một khoá tab; undefined nghĩa là tab không còn (pack bị gỡ). */
  info: (key: string) => TabInfo | undefined;
  /**
   * Yêu cầu ẩn đang chờ xác nhận (do bấm ✕ trên menu). Component này dựng hộp
   * xác nhận cho nó vì hộp phải nổi trên mọi pane — cùng lý do portal bên dưới.
   */
  pending: string | null;
  onResolvePending: (confirmed: boolean) => void;
}

export default function TabVisibilityBar({
  hidden, allKeys, info, pending, onResolvePending,
}: TabVisibilityBarProps) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Portal chỉ dựng được sau khi đã mount (server render không có document).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Bấm ra ngoài / Esc → đóng bảng, như mọi dropdown khác trong app.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
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
  // z-index — pane Links/Browser/Workspace sẽ che bảng. Cùng cách xử lý như
  // UltraBar: đặt cờ trên <html>, CSS tạm đẩy webview ra khỏi màn hình.
  useModalOverWebview(open || !!pending);

  const nHidden = hidden.length;
  const pendingInfo = pending ? info(pending) : undefined;

  // Esc = huỷ ẩn. Enter = xác nhận, vì nút "Ẩn" được focus sẵn.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onResolvePending(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending, onResolvePending]);

  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (pending) confirmBtnRef.current?.focus(); }, [pending]);

  /** Tab đang hiện / đang ẩn, giữ đúng thứ tự thanh menu. */
  const { shownKeys, hiddenKeys } = useMemo(() => {
    const s: string[] = [], h: string[] = [];
    for (const k of allKeys) (hidden.includes(k) ? h : s).push(k);
    return { shownKeys: s, hiddenKeys: h };
  }, [allKeys, hidden]);

  return (
    <div className="tvis">
      <button
        ref={btnRef}
        className={`tvis-btn${nHidden > 0 ? ' is-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={
          nHidden > 0
            ? `Đang ẩn ${nHidden} tính năng khỏi menu — bấm để bật lại`
            : 'Cài đặt — hiện/ẩn tính năng, nơi lưu file tải về'
        }
        aria-pressed={open}
        aria-label="Cài đặt"
      >
        <span className="tvis-ico" aria-hidden>⚙</span>
        {nHidden > 0 && <span className="tvis-count">{nHidden}</span>}
      </button>

      {/* PORTAL ra document.body — BẮT BUỘC, không phải cho đẹp: `.appbar` có
          `position: sticky; z-index: 40` nên nó TẠO STACKING CONTEXT. Bảng nằm
          bên trong appbar thì z-index 9100 của nó chỉ có nghĩa BÊN TRONG context
          đó; so với `.body` bên ngoài, cả cụm appbar chỉ đáng giá 40 — pane
          workspace (nhất là ở Ultra View, nơi các panel bên trong tự dựng lớp
          z-index riêng) sẽ đè lên. Ra thẳng body thì fixed = viewport thật và
          z-index thắng mọi pane. Cùng lý do NotificationCenter đã portal. */}
      {mounted && open && createPortal(
        <>
          <div className="tvis-scrim" onClick={() => setOpen(false)} aria-hidden />
          <div className="tvis-pop" role="dialog" aria-label="Cài đặt" ref={popRef}>
            <div className="tvis-pop-head">
              <div>
                <b>Cài đặt</b>
                <span className="tvis-pop-sub">
                  hiện/ẩn tính năng trên menu · nơi lưu file tải về
                </span>
              </div>
              <button className="tvis-pop-x" onClick={() => setOpen(false)} aria-label="Đóng">×</button>
            </div>

            {/* Tải file — chỉ hiện trên bản desktop (xem DownloadPrefs). */}
            <DownloadPrefs />

            <div className="tvis-group">Hiện/ẩn tính năng</div>

            <div className="tvis-note">
              Ẩn chỉ giấu tab khỏi thanh menu. <b>Automation, watcher và thông báo
              của tab đó vẫn chạy bình thường</b> — bật lại là thấy nguyên trạng.
            </div>

            <div className="tvis-actions">
              <span className="tvis-stat">
                {nHidden === 0
                  ? `Đang hiện tất cả ${allKeys.length} tính năng`
                  : `Đang ẩn ${nHidden}/${allKeys.length}`}
              </span>
              <button
                className="ghost sm"
                disabled={nHidden === 0}
                onClick={() => hiddenTabs.showAll()}
              >Hiện lại tất cả</button>
            </div>

            {/* Nhóm "đang ẩn" lên đầu: vào bảng này chủ yếu để tìm lại cái đã
                ẩn, bắt cuộn qua 20 tab đang hiện mới thấy là ngược việc. */}
            {hiddenKeys.length > 0 && (
              <>
                <div className="tvis-group">Đang ẩn — bấm để hiện lại</div>
                <div className="tvis-list">
                  {hiddenKeys.map((k) => {
                    const t = info(k);
                    if (!t) return null;
                    return (
                      <label key={k} className="tvis-item is-off">
                        <input type="checkbox" checked={false} onChange={() => hiddenTabs.show(k)} />
                        <span className="tvis-item-ico" aria-hidden>{t.icon}</span>
                        <span className="tvis-item-label">{t.label}</span>
                        <span className="tvis-item-badge">{t.badge}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            <div className="tvis-group">Đang hiện trên menu</div>
            <div className="tvis-list">
              {shownKeys.map((k) => {
                const t = info(k);
                if (!t) return null;
                return (
                  <label key={k} className="tvis-item">
                    <input type="checkbox" checked onChange={() => hiddenTabs.hide(k)} />
                    <span className="tvis-item-ico" aria-hidden>{t.icon}</span>
                    <span className="tvis-item-label">{t.label}</span>
                    <span className="tvis-item-badge">{t.badge}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </>,
        document.body,
      )}

      {/* Xác nhận trước khi ẩn (bấm ✕ trên menu). Cũng portal, cùng lý do. */}
      {mounted && pending && createPortal(
        <>
          <div className="tvis-scrim" onClick={() => onResolvePending(false)} aria-hidden />
          <div className="tvis-confirm" role="alertdialog" aria-label="Xác nhận ẩn tính năng">
            <div className="tvis-confirm-head">
              <span className="tvis-confirm-ico" aria-hidden>{pendingInfo?.icon ?? '▤'}</span>
              <b>Ẩn “{pendingInfo?.label ?? pending}” khỏi menu?</b>
            </div>
            <p className="tvis-confirm-body">
              Tab này sẽ biến mất khỏi thanh menu. <b>Automation và thông báo của
              nó vẫn chạy bình thường.</b> Bật lại bất cứ lúc nào ở nút ⚙ trên
              thanh tiêu đề.
            </p>
            <div className="tvis-confirm-acts">
              <button className="ghost sm" onClick={() => onResolvePending(false)}>Huỷ</button>
              <button ref={confirmBtnRef} className="sm" onClick={() => onResolvePending(true)}>Ẩn tính năng</button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
