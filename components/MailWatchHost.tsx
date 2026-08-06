'use client';

// Trạm theo dõi mail chưa đọc (server đếm INBOX UNSEEN 10 phút/lần —
// lib/mailWatch). Mount MỘT lần ngoài mọi pane; poll snapshot và đẩy TỔNG số
// chưa đọc lên shell qua onUnread → page.tsx vẽ badge đỏ trên tab Mail.
//
// Đây là BỘ ĐẾM SỐNG (như badge tin nhắn Workspace), không phải hòm thông báo:
// số chỉ về 0 khi mail thực sự được đọc/xử lý trên server mail, không phải khi
// mở tab. Không render gì.

import { useEffect, useRef } from 'react';
import { MAIL_MUTED_EVENT, loadMutedMail } from '@/lib/mailMuted';

/** Poll nhẹ — chỉ đọc snapshot in-memory của server, không chạm IMAP. */
const POLL_MS = 60_000;

interface MailWatchSnapshot {
  totalUnseen: number;
  accounts?: { id: string; unseen: number }[];
}

/**
 * Tổng chưa đọc SAU khi trừ các hòm thư đang ẩn thông báo.
 *
 * Cố tình KHÔNG dùng thẳng `totalUnseen` của server: cờ ẩn là lựa chọn trên máy
 * này (localStorage), server không biết và cũng không cần biết — nó cứ đếm đủ
 * mọi hòm thư như cũ. Việc lọc thuộc về client.
 *
 * Snapshot cũ chưa có mảng `accounts` thì đành lấy tổng của server: thà báo dư
 * còn hơn nuốt mất mail (và bản mới luôn có mảng này).
 */
function audibleTotal(snap: MailWatchSnapshot): number {
  if (!Array.isArray(snap.accounts)) return snap.totalUnseen ?? 0;
  const muted = loadMutedMail();
  return snap.accounts.reduce((sum, a) => sum + (muted.has(a.id) ? 0 : a.unseen || 0), 0);
}

/** Event tên này (window) = "trạng thái đã đọc vừa đổi — đếm lại NGAY".
 *  MailWorkspace bắn sau khi mở/xóa mail chưa đọc; ai cần cũng bắn được. */
export const MAIL_REFRESH_EVENT = 'devbox:mail-refresh';

export default function MailWatchHost({ onUnread }: { onUnread: (n: number) => void }) {
  // Snapshot gần nhất, giữ lại để khi người dùng bật/tắt ẩn thông báo thì tính
  // lại tổng NGAY từ số liệu đang có — không phải chờ hết 60 giây tới lần poll
  // sau, cũng không phải gọi lại server chỉ vì một cú bấm ở client.
  const lastSnap = useRef<MailWatchSnapshot | null>(null);

  useEffect(() => {
    let stopped = false;
    let refreshing = false;

    async function tick() {
      try {
        const res = await fetch('/api/mail/watch');
        if (!res.ok) return;
        const snap = (await res.json()) as MailWatchSnapshot;
        lastSnap.current = snap;
        if (!stopped) onUnread(audibleTotal(snap));
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
        lastSnap.current = snap;
        if (!stopped) onUnread(audibleTotal(snap));
      } catch {
        /* thử lại ở tick định kỳ */
      } finally {
        refreshing = false;
      }
    }
    const onRefresh = () => void refreshNow();

    /** Bật/tắt ẩn thông báo → tính lại tổng từ snapshot đang giữ, tức thì. */
    const onMutedChange = () => {
      if (lastSnap.current && !stopped) onUnread(audibleTotal(lastSnap.current));
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    window.addEventListener(MAIL_REFRESH_EVENT, onRefresh);
    window.addEventListener(MAIL_MUTED_EVENT, onMutedChange);
    // Ẩn ở cửa sổ DevBox khác → `storage` bắn sang đây, bám theo luôn cho khớp.
    window.addEventListener('storage', onMutedChange);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener(MAIL_REFRESH_EVENT, onRefresh);
      window.removeEventListener(MAIL_MUTED_EVENT, onMutedChange);
      window.removeEventListener('storage', onMutedChange);
    };
  }, [onUnread]);

  return null;
}
