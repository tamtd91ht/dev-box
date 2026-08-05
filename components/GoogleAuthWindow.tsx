'use client';

// Đăng nhập Google NGAY TRONG APP thay vì quăng URL ra trình duyệt mặc định.
//
// VÌ SAO: shell.openExternal() đưa URL cho Windows → Windows mở TRÌNH DUYỆT MẶC
// ĐỊNH (Edge trên máy này), rồi Edge/Chrome lại tự chọn profile vừa dùng gần
// nhất. Ai có nhiều tài khoản Chrome sẽ liên tục đăng nhập nhầm profile, phải
// copy URL dán qua cửa sổ khác — rất bất tiện.
//
// Consent chạy trong <webview> với partition RIÊNG nên:
//   · không liên quan Edge/Chrome hay profile nào của máy,
//   · phiên đăng nhập Google ở đây độc lập, thêm nhiều tài khoản tuần tự được,
//   · redirect về http://localhost:3000/api/google/callback vẫn chạy y nguyên
//     (chính app đang serve cổng đó) → KHÔNG cần đổi gì trong Google Cloud.
//
// Google chặn "embedded browser" bằng cách soi UA ở các host đăng nhập; main
// process đã có workaround trình UA Firefox cho accounts.google.com
// (configurePartition trong electron/main.cjs) nên luồng này lọt.
//
// NÚT CONTINUE Ở ĐÁY TRANG: trang consent của Google cao hơn khung, mà cuộn
// bằng chuột trong <webview> lồng trong modal thì không đáng tin (hit-testing
// của Electron lệch khi có compositing ancestor). Nên ở đây KHÔNG dựa vào cuộn:
//   1. tự thu nhỏ (zoom) guest đến khi cả trang vừa khung → nút Continue hiện
//      ra mà không cần cuộn,
//   2. còn thừa thì có nút ↓ / ⤓ ở header cuộn guest bằng executeJavaScript —
//      chạy trong chính guest nên không phụ thuộc chuột,
//   3. wheel rơi vào host (đúng triệu chứng hit-testing lệch) được chuyển tiếp
//      xuống guest.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebviewElement } from '@/lib/workspace/types';

/** Partition riêng cho consent — tách khỏi mọi workspace/bookmark khác. */
export const GOOGLE_AUTH_PARTITION = 'persist:google-oauth';

/** Không thu nhỏ quá mức này — dưới đây chữ của Google bắt đầu khó đọc. */
const MIN_ZOOM = 0.6;
const ZOOM_STEP = 0.1;

/**
 * Tìm phần tử cuộn THẬT của trang guest. Trang consent của Google khóa
 * html/body (height:100%; overflow:hidden) và cuộn bằng một div bên trong, nên
 * `window.scrollBy` không nhích được pixel nào — phải soi ra div đó.
 * Trả về expression, dùng chung cho cả đo và cuộn.
 */
const PICK_SCROLLER = `(() => {
  const over = (el) => (el.scrollHeight || 0) - (el.clientHeight || 0);
  let best = document.scrollingElement || document.body;
  let bestOver = best ? over(best) : 0;
  for (const el of document.querySelectorAll('body *')) {
    const o = over(el);
    if (o <= 8 || o <= bestOver) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    best = el; bestOver = o;
  }
  return { el: best, over: Math.max(0, bestOver) };
})()`;

/** dy hữu hạn = cuộn tương đối; Infinity = xuống đáy. */
function scrollJs(dy: number): string {
  const to = Number.isFinite(dy)
    ? `s.el.scrollTop + (${Number(dy) || 0})`
    : 's.el.scrollHeight';
  return `(() => {
    const s = ${PICK_SCROLLER};
    if (!s.el || s.over <= 0) return 0;
    s.el.scrollTop = ${to};
    return s.el.scrollTop;
  })()`;
}

/** Phần còn thiếu (px CSS của guest) + chiều cao khung, để tính zoom vừa khít. */
const MEASURE_JS = `(() => {
  const s = ${PICK_SCROLLER};
  return { over: s.over, view: document.documentElement.clientHeight || 0 };
})()`;

export default function GoogleAuthWindow({ url, onDone, onCancel }: {
  url: string;
  /** Gọi khi webview đã điều hướng tới callback → phía server đã có code. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<WebviewElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const doneRef = useRef(false);

  /** Chạy code trong guest, im lặng bỏ qua nếu guest chưa attach / đã đóng. */
  const inGuest = useCallback((code: string, gesture = false) => {
    try { ref.current?.executeJavaScript(code, gesture)?.catch(() => {}); }
    catch { /* chưa attach */ }
  }, []);

  const applyZoom = useCallback((z: number) => {
    const next = Math.min(1, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
    zoomRef.current = next;
    setZoom(next);
    try { ref.current?.setZoomFactor(next); } catch { /* guest chưa attach */ }
  }, []);

  /** Thu nhỏ dần đến khi cả trang consent vừa khung (tối đa 3 vòng). */
  const fitToView = useCallback(async () => {
    const el = ref.current;
    if (!el) return;
    for (let i = 0; i < 3; i++) {
      let m: { over: number; view: number };
      try {
        m = (await el.executeJavaScript(MEASURE_JS)) as { over: number; view: number };
      } catch { return; }
      if (!m || !m.view || m.over <= 4) return;               // đã vừa khung
      const want = zoomRef.current * (m.view / (m.view + m.over));
      if (want >= zoomRef.current - 0.005) return;            // không nhỏ thêm được
      if (zoomRef.current <= MIN_ZOOM) return;
      applyZoom(want);
      // Đợi guest relayout xong mới đo lại, không thì vòng sau đọc số cũ.
      await new Promise((r) => setTimeout(r, 150));
    }
  }, [applyZoom]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // CHỈ đóng ở did-stop-loading: lúc did-navigate thì route callback MỚI bắt
    // đầu chạy, chưa kịp đổi code → ghi token. Đóng sớm là poll status sẽ đua
    // với việc ghi file và có thể không thấy tài khoản mới.
    const onStop = () => {
      setStatus('ready');
      let here = '';
      try { here = el.getURL(); } catch { return; }
      if (here.includes('/api/google/callback')) {
        if (doneRef.current) return;
        doneRef.current = true;
        onDone();
        return;
      }
      void fitToView();
    };

    // Zoom là thuộc tính của guest nên phải set lại sau mỗi lần điều hướng.
    const onReady = () => { applyZoom(zoomRef.current); };

    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('dom-ready', onReady);
    return () => {
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('dom-ready', onReady);
    };
  }, [onDone, applyZoom, fitToView]);

  // Chuyển tiếp wheel rơi vào HOST xuống guest. Khi hit-testing đúng thì guest
  // đã ăn wheel và handler này không bao giờ chạy → không có chuyện cuộn đôi.
  useEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      inGuest(scrollJs(dy));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [inGuest]);

  // Esc để hủy (phím trong guest không bubble ra host nên chỉ ăn khi focus host).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Lưới an toàn: nếu did-stop-loading không bao giờ nổ (trang treo long-poll)
  // thì overlay vẫn phải tắt, không để nó ngồi che mãi trên webview.
  useEffect(() => {
    if (status !== 'loading') return;
    const t = setTimeout(() => setStatus('ready'), 12_000);
    return () => clearTimeout(t);
  }, [status]);

  const scrollBy = (dy: number) => inGuest(scrollJs(dy), true);

  return (
    <div className="mail-compose-backdrop gauth-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="panel gauth-modal">
        <div className="gauth-head">
          <b>Ⓖ Đăng nhập Google</b>
          <span className="small" style={{ color: 'var(--muted)' }}>
            trong app — không dùng Edge/Chrome của máy
          </span>
          <span style={{ flex: 1 }} />
          <span className="gauth-tools">
            <button className="ghost sm" title="Cuộn xuống trong trang Google"
              onClick={() => scrollBy(240)}>↓</button>
            <button className="ghost sm" title="Xuống cuối trang — nơi có nút Continue / Tiếp tục"
              onClick={() => scrollBy(Infinity)}>⤓</button>
            <button className="ghost sm" title="Thu nhỏ trang để thấy trọn nút Continue"
              onClick={() => applyZoom(zoomRef.current - ZOOM_STEP)}
              disabled={zoom <= MIN_ZOOM}>−</button>
            <span className="gauth-zoom" title="Mức thu nhỏ trang Google">{Math.round(zoom * 100)}%</span>
            <button className="ghost sm" title="Phóng to lại"
              onClick={() => applyZoom(zoomRef.current + ZOOM_STEP)}
              disabled={zoom >= 1}>＋</button>
          </span>
          <button className="ghost sm" title="Đăng xuất phiên Google trong khung này (chọn tài khoản khác)"
            onClick={() => void window.workspace?.clearSession(GOOGLE_AUTH_PARTITION).then(() => {
              setStatus('loading');
              try { ref.current?.loadURL(url); } catch { ref.current?.reload(); }
            })}>
            ⎋ Đổi tài khoản
          </button>
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>
        <div className="gauth-body" ref={bodyRef}>
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            className="gauth-webview"
            src={url}
            partition={GOOGLE_AUTH_PARTITION}
          />
          {status === 'loading' && (
            <div className="ws-overlay gauth-overlay">
              <div className="ws-spinner" />
              <p>Đang mở trang đăng nhập Google…</p>
            </div>
          )}
        </div>
        <div className="gauth-foot small">
          Không thấy nút <b>Continue / Tiếp tục</b>? Bấm <b>⤓</b> để xuống cuối trang hoặc <b>−</b> để thu nhỏ.
        </div>
      </div>
    </div>
  );
}
