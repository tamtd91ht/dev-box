'use client';

// Trạm nền cho CHUYỂN ĐỔI FILE (tab Tools).
//
// Mount MỘT lần ngoài mọi pane, làm hai việc:
//   1. Job PDF dừng ở 'need-render' (Next server không gọi được Electron) →
//      lấy HTML về, nhờ window.workspace.htmlToPdf in bằng Chromium của app,
//      gửi base64 ngược lên server ghi file. Bản web thuần không có API này →
//      báo lỗi rõ cho job thay vì để nó treo mãi.
//   2. Job xong/lỗi → toast + ghi hòm thông báo KÈM ĐƯỜNG DẪN file kết quả
//      (yêu cầu: chạy ngầm, xong chỉ cần báo đường dẫn).
//
// Mốc "đã báo tới đâu" giữ trong ref theo id job — job sống trong RAM server
// nên restart server là danh sách rỗng, không lo báo trùng qua các phiên.

import { useEffect, useRef } from 'react';
import { automation } from '@/lib/automation/runtime';
import { notices } from '@/lib/noticeStore';
import { cList, cRenderHtml, cRenderDone, cRenderFail, TARGET_LABEL } from '@/lib/convert';

const POLL_MS = 2000;

export default function ConvertHost() {
  // Job đã bắn thông báo — không bắn lại ở lượt poll sau.
  const notified = useRef<Set<string>>(new Set());
  // Job đang in PDF — chặn in trùng khi lượt poll sau vẫn thấy 'need-render'.
  const rendering = useRef<Set<string>>(new Set());

  useEffect(() => {
    let stopped = false;

    const renderPdf = async (id: string) => {
      if (rendering.current.has(id)) return;
      rendering.current.add(id);
      try {
        const bridge = window.workspace?.htmlToPdf;
        if (typeof bridge !== 'function') {
          await cRenderFail(id, 'Tạo PDF cần bản desktop (npm run desktop) — bản web trong trình duyệt không in được PDF.');
          return;
        }
        const { html } = await cRenderHtml(id);
        const res = await bridge(html);
        if (!res.ok || !res.base64) {
          await cRenderFail(id, res.error || 'Chromium không in được PDF.');
          return;
        }
        await cRenderDone(id, res.base64);
      } catch (e) {
        await cRenderFail(id, (e as Error).message).catch(() => {});
      } finally {
        rendering.current.delete(id);
      }
    };

    const tick = async () => {
      let jobs;
      try {
        jobs = await cList();
      } catch {
        return; // server tạm không trả lời — lượt sau thử lại
      }
      if (stopped) return;

      for (const j of jobs) {
        if (j.status === 'need-render') {
          void renderPdf(j.id);
          continue;
        }
        if (j.status !== 'done' && j.status !== 'error') continue;
        if (notified.current.has(j.id)) continue;
        notified.current.add(j.id);

        // Thông báo KÈM ĐƯỜNG DẪN — đó là thứ người dùng cần sau khi job chạy ngầm.
        if (j.status === 'done') {
          const title = `✅ Đã chuyển xong: ${j.outName}`;
          const body = `${j.srcName} → ${TARGET_LABEL[j.target]}${j.useAi ? ' (AI)' : ''}\n${j.outAbs}`;
          automation.systemNotify('info', title, body, 'chuyển đổi file');
          notices.add({ tab: 'tools', level: 'info', title, body, source: 'chuyển đổi file' });
        } else {
          const title = `⚠ Chuyển đổi lỗi: ${j.srcName}`;
          const body = j.error || 'Không rõ nguyên nhân.';
          automation.systemNotify('warn', title, body, 'chuyển đổi file');
          notices.add({ tab: 'tools', level: 'warn', title, body, source: 'chuyển đổi file' });
        }
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  return null;
}
