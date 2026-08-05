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

import { useEffect, useRef, useState } from 'react';
import type { WebviewElement } from '@/lib/workspace/types';

/** Partition riêng cho consent — tách khỏi mọi workspace/bookmark khác. */
export const GOOGLE_AUTH_PARTITION = 'persist:google-oauth';

export default function GoogleAuthWindow({ url, onDone, onCancel }: {
  url: string;
  /** Gọi khi webview đã điều hướng tới callback → phía server đã có code. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<WebviewElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const doneRef = useRef(false);

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
      if (doneRef.current || !here.includes('/api/google/callback')) return;
      doneRef.current = true;
      onDone();
    };

    el.addEventListener('did-stop-loading', onStop);
    return () => el.removeEventListener('did-stop-loading', onStop);
  }, [onDone]);

  // Esc để hủy (phím trong guest không bubble ra host nên chỉ ăn khi focus host).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="mail-compose-backdrop gauth-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="panel gauth-modal">
        <div className="gauth-head">
          <b>Ⓖ Đăng nhập Google</b>
          <span className="small" style={{ color: 'var(--muted)' }}>
            trong app — không dùng Edge/Chrome của máy
          </span>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" title="Đăng xuất phiên Google trong khung này (chọn tài khoản khác)"
            onClick={() => void window.workspace?.clearSession(GOOGLE_AUTH_PARTITION).then(() => {
              setStatus('loading');
              try { ref.current?.loadURL(url); } catch { ref.current?.reload(); }
            })}>
            ⎋ Đổi tài khoản
          </button>
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>
        <div className="gauth-body">
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            className="gauth-webview"
            src={url}
            partition={GOOGLE_AUTH_PARTITION}
          />
          {status === 'loading' && (
            <div className="ws-overlay">
              <div className="ws-spinner" />
              <p>Đang mở trang đăng nhập Google…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
