'use client';

// Trạm theo dõi tiến trình tự pull Git (server chạy 10 phút/lần — lib/gitAutoPull).
//
// Mount MỘT lần ngoài mọi pane (cạnh AutomationHost) nên hoạt động ở bất kỳ tab
// nào. Poll snapshot của server; khi một CHU KỲ MỚI hoàn tất (runSeq đổi):
//   · repo conflict → toast urgent (ở lại tới khi bấm) + OS notification, VÀ
//     ghi vào hòm thông báo (badge đỏ trên tab Git — lib/noticeStore).
//   · repo pull lỗi (không phải conflict) → chỉ ghi hòm mức warn, không toast
//     để lỗi mạng lặt vặt không làm phiền realtime.
//
// Không render gì — toast do AutomationHost vẽ, badge do page.tsx vẽ.

import { useEffect, useRef } from 'react';
import { automation } from '@/lib/automation/runtime';
import { notices } from '@/lib/noticeStore';

/** Poll nhẹ hơn chu kỳ pull nhiều — chỉ đọc snapshot in-memory của server. */
const POLL_MS = 60_000;

interface PullResultInfo {
  name: string;
  outcome: 'pulled' | 'up-to-date' | 'skipped' | 'conflict' | 'error';
  message: string;
}

interface AutoPullSnapshot {
  enabled: boolean;
  runSeq: number;
  conflicts: { projectName: string; repoName: string; message: string }[];
  projects: { projectName: string; results: PullResultInfo[] }[];
}

export default function GitAutoPullHost() {
  // runSeq đã thông báo rồi — mỗi chu kỳ pull chỉ nhắc một lần, nhưng chu kỳ
  // sau vẫn nhắc lại nếu conflict chưa được xử lý.
  const notifiedSeq = useRef(-1);

  useEffect(() => {
    let stopped = false;

    async function tick() {
      try {
        const res = await fetch('/api/git/auto-pull');
        if (!res.ok) return;
        const snap = (await res.json()) as AutoPullSnapshot;
        if (stopped || !snap.enabled) return;
        if (snap.runSeq === notifiedSeq.current) return; // chưa có chu kỳ mới
        notifiedSeq.current = snap.runSeq;

        if (snap.conflicts?.length) {
          const lines = snap.conflicts
            .map((c) => `${c.projectName}/${c.repoName}: ${c.message}`)
            .join('\n');
          const title = `⎇ Git: ${snap.conflicts.length} repo đang conflict`;
          automation.systemNotify('urgent', title, lines, 'git auto-pull');
          notices.add({ tab: 'git', level: 'urgent', title, body: lines, source: 'git auto-pull' });
        }

        // Lỗi pull khác (mạng, quyền, …) — vào hòm để xem sau, không toast.
        const errors = (snap.projects ?? []).flatMap((p) =>
          p.results
            .filter((r) => r.outcome === 'error')
            .map((r) => `${p.projectName}/${r.name}: ${r.message}`),
        );
        if (errors.length) {
          notices.add({
            tab: 'git',
            level: 'warn',
            title: `⎇ Git: ${errors.length} repo pull lỗi`,
            body: errors.join('\n'),
            source: 'git auto-pull',
          });
        }
      } catch {
        /* server đang khởi động / offline — thử lại ở tick sau */
      }
    }

    void tick(); // báo ngay khi mở app nếu đã có conflict
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}
