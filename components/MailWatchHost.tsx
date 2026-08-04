'use client';

// Trạm theo dõi mail chưa đọc (server đếm INBOX UNSEEN 10 phút/lần —
// lib/mailWatch). Mount MỘT lần ngoài mọi pane; poll snapshot và đẩy TỔNG số
// chưa đọc lên shell qua onUnread → page.tsx vẽ badge đỏ trên tab Mail.
//
// Đây là BỘ ĐẾM SỐNG (như badge tin nhắn Workspace), không phải hòm thông báo:
// số chỉ về 0 khi mail thực sự được đọc/xử lý trên server mail, không phải khi
// mở tab. Không render gì.

import { useEffect } from 'react';

/** Poll nhẹ — chỉ đọc snapshot in-memory của server, không chạm IMAP. */
const POLL_MS = 60_000;

interface MailWatchSnapshot {
  totalUnseen: number;
}

/** Event tên này (window) = "trạng thái đã đọc vừa đổi — đếm lại NGAY".
 *  MailWorkspace bắn sau khi mở/xóa mail chưa đọc; ai cần cũng bắn được. */
export const MAIL_REFRESH_EVENT = 'devbox:mail-refresh';

export default function MailWatchHost({ onUnread }: { onUnread: (n: number) => void }) {
  useEffect(() => {
    let stopped = false;
    let refreshing = false;

    async function tick() {
      try {
        const res = await fetch('/api/mail/watch');
        if (!res.ok) return;
        const snap = (await res.json()) as MailWatchSnapshot;
        if (!stopped) onUnread(snap.totalUnseen ?? 0);
      } catch {
        /* server đang khởi động / offline — thử lại ở tick sau */
      }
    }

    /** Đọc/xóa mail xong → POST bắt server chạy MỘT chu kỳ đếm ngay (snapshot
     *  nền 10 phút/lần quá chậm cho badge). Gộp các tín hiệu dồn dập. */
    async function refreshNow() {
      if (refreshing) return;
      refreshing = true;
      try {
        const res = await fetch('/api/mail/watch', { method: 'POST' });
        if (!res.ok) return;
        const snap = (await res.json()) as MailWatchSnapshot;
        if (!stopped) onUnread(snap.totalUnseen ?? 0);
      } catch {
        /* thử lại ở tick định kỳ */
      } finally {
        refreshing = false;
      }
    }
    const onRefresh = () => void refreshNow();

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    window.addEventListener(MAIL_REFRESH_EVENT, onRefresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener(MAIL_REFRESH_EVENT, onRefresh);
    };
  }, [onUnread]);

  return null;
}
