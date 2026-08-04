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

export default function MailWatchHost({ onUnread }: { onUnread: (n: number) => void }) {
  useEffect(() => {
    let stopped = false;

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

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [onUnread]);

  return null;
}
