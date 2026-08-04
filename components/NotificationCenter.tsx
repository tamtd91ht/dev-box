'use client';

// Chuông thông báo trên appbar — mở panel xem lịch sử thông báo đã lưu local
// (lib/noticeStore: TTL 2 ngày, tối đa 300). Badge đỏ trên chuông = tổng chưa
// đọc; mở panel là đánh dấu đã đọc tất cả (lịch sử vẫn còn để xem lại). Nút
// "Xóa tất cả" dọn sạch hòm.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { notices, type AppNotice } from '@/lib/noticeStore';

const LEVEL_ICON: Record<AppNotice['level'], string> = {
  info: '💬',
  warn: '⚠',
  urgent: '🚨',
};

/** "x phút trước" — đủ dùng cho hòm 2 ngày. */
function relTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'vừa xong';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return `${Math.round(h / 24)} ngày trước`;
}

export default function NotificationCenter() {
  const snap = useSyncExternalStore(notices.subscribe, notices.getSnapshot, notices.getServerSnapshot);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Mở panel = đã xem tất cả (badge trên chuông + trên các tab tắt).
  useEffect(() => {
    if (open) notices.markAllRead();
  }, [open, snap.unreadTotal]);

  // Click ra ngoài thì đóng.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="ntc" ref={rootRef}>
      <button
        type="button"
        className={`ntc-bell${snap.unreadTotal > 0 ? ' has-unread' : ''}`}
        title="Thông báo (lưu local, tự xóa sau 2 ngày)"
        aria-label="Thông báo"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>🔔</span>
        {snap.unreadTotal > 0 && (
          <span className="ms-unread">{snap.unreadTotal > 99 ? '99+' : snap.unreadTotal}</span>
        )}
      </button>

      {open && (
        <div className="ntc-panel" role="dialog" aria-label="Danh sách thông báo">
          <div className="ntc-head">
            <span className="ntc-title">Thông báo</span>
            <span className="ntc-hint">lưu local · tự xóa sau 2 ngày</span>
            <button
              type="button"
              className="ntc-clear"
              disabled={!snap.notices.length}
              onClick={() => notices.clearAll()}
            >
              Xóa tất cả
            </button>
          </div>
          <div className="ntc-list">
            {snap.notices.length === 0 ? (
              <div className="ntc-empty">Chưa có thông báo nào.</div>
            ) : (
              snap.notices.map((n) => (
                <div key={n.id} className={`ntc-item lv-${n.level}`}>
                  <span className="ntc-ico" aria-hidden>{LEVEL_ICON[n.level]}</span>
                  <span className="ntc-body">
                    <span className="ntc-item-title">{n.title}</span>
                    {n.body ? <span className="ntc-text">{n.body}</span> : null}
                    <span className="ntc-meta">
                      <b>{n.tab}</b> · {n.source} · {relTime(n.at)}
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
