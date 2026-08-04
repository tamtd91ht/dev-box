'use client';

// Trạm nhận cảnh báo Công việc (server quét mỗi phút — lib/workWatch).
//
// Mount MỘT lần ngoài mọi pane. Poll feed sự kiện; sự kiện mới → toast
// (deadline = urgent ở lại tới khi bấm, ngày bắt đầu = warn) + ghi hòm thông
// báo (badge đỏ trên tab Công việc — lib/noticeStore).
//
// Mốc "đã xem tới đâu" lưu localStorage theo TIMESTAMP sự kiện (không phải
// seq): reload UI hay restart server đều không nhắc trùng.

import { useEffect, useRef } from 'react';
import { automation } from '@/lib/automation/runtime';
import { notices } from '@/lib/noticeStore';

const POLL_MS = 60_000;
const SEEN_KEY = 'work.alerts.lastAt';

interface AlertItem {
  kind: 'start' | 'deadline';
  message: string;
  at: number;
  task: { name: string; project: string };
}

interface WorkWatchSnapshot {
  enabled: boolean;
  alerts: AlertItem[];
}

function loadSeen(): number {
  try { return Number(window.localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; }
}

export default function WorkAlertHost() {
  const seenAt = useRef(0);

  useEffect(() => {
    seenAt.current = loadSeen();
    let stopped = false;

    async function tick() {
      try {
        const res = await fetch('/api/work');
        if (!res.ok) return;
        const snap = (await res.json()) as WorkWatchSnapshot;
        if (stopped || !snap.enabled) return;
        const fresh = (snap.alerts ?? []).filter((a) => a.at > seenAt.current).sort((a, b) => a.at - b.at);
        if (!fresh.length) return;
        for (const a of fresh) {
          const title = a.kind === 'deadline' ? '⏰ Sắp tới deadline' : '📋 Công việc bắt đầu hôm nay';
          const level = a.kind === 'deadline' ? 'urgent' : 'warn';
          automation.systemNotify(level, title, a.message, 'công việc');
          notices.add({ tab: 'work', level, title, body: a.message, source: 'công việc' });
        }
        seenAt.current = Math.max(...fresh.map((a) => a.at));
        try { window.localStorage.setItem(SEEN_KEY, String(seenAt.current)); } catch { /* nicety */ }
      } catch {
        /* server đang khởi động — thử lại tick sau */
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  return null;
}
