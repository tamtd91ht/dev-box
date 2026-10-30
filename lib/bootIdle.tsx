'use client';

// Khởi động theo tầng: mở app thì TAB ĐANG XEM lên trước, việc nền xếp sau.
//
// Trình duyệt chỉ mở 6 kết nối cùng lúc tới localhost:3000 (xem
// lib/apiFetch.ts). Lúc mở app, Monitor (đo ~20 cụm, 3 probe song song, có
// probe Kafka tới 4s), automation runtime (100KB rule + watch), thông báo mail,
// git auto-pull… cùng xin socket ngay mili-giây đầu — tab người dùng đang nhìn
// phải xếp hàng sau chúng.
//
// `whenBootIdle()` resolve khi: trang đã `load` + đã qua BOOT_SETTLE_MS kể từ
// lúc điều hướng + trình duyệt rảnh một nhịp (requestIdleCallback). Mọi việc
// nền chờ mốc này; tab đang xem thì không chờ gì cả.

import { useEffect, useState, type ReactNode } from 'react';

/** Đo trên bản production: tab đang xem có nội dung sau ~0.5–1.3s. */
const BOOT_SETTLE_MS = 2500;

let boot: Promise<void> | null = null;

export function whenBootIdle(): Promise<void> {
  if (typeof window === 'undefined') return new Promise<void>(() => {}); // server: không bao giờ
  if (!boot) {
    boot = new Promise<void>((resolve) => {
      const idle = () => {
        if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: 2000 });
        else resolve();
      };
      // performance.now() tính từ lúc bắt đầu điều hướng — nạp lại trang là đếm lại.
      const afterLoad = () => setTimeout(idle, Math.max(0, BOOT_SETTLE_MS - performance.now()));
      if (document.readyState === 'complete') afterLoad();
      else window.addEventListener('load', afterLoad, { once: true });
    });
  }
  return boot;
}

export function useBootIdle(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let off = false;
    void whenBootIdle().then(() => { if (!off) setReady(true); });
    return () => { off = true; };
  }, []);
  return ready;
}

/** Chỉ mount `children` sau mốc khởi động — cho các host chạy nền (poller, watcher). */
export function AfterBoot({ children }: { children: ReactNode }) {
  return useBootIdle() ? <>{children}</> : null;
}
