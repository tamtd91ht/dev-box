'use client';

// Hộp thoại "trang này đang mở ở tab khác rồi" — dùng chung cho tab Browser và
// tab Links.
//
// Vì sao phải HỎI thay vì tự quyết: trước đây mở trùng URL là tự nhảy về tab
// có sẵn, nhưng nhiều lúc người ta cần HAI tab cùng một trang (so hai bản ghi,
// hai môi trường cùng một dashboard). Tự quyết kiểu nào cũng sai một nửa số
// lần — nên hỏi. Enter/nút đậm = chuyển tới tab đã mở (giữ thói quen cũ),
// Esc = huỷ, không làm gì.
//
// Chủ nhà (workspace) phải tự bật `data-popup-over-webview` khi hộp thoại mở —
// <webview> vẽ ở tầng native, đè mọi HTML bất kể z-index.

import { useEffect } from 'react';

export default function DupTabDialog({ url, existingName, onGoExisting, onOpenNew, onCancel }: {
  url: string;
  /** Tên tab đang mở sẵn trang này. */
  existingName: string;
  onGoExisting: () => void;
  onOpenNew: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="bt-modal-back" onMouseDown={onCancel}>
      <div className="bt-modal" onMouseDown={(e) => e.stopPropagation()}>
        <b>🔁 Trang này đang mở sẵn</b>
        <p className="small" style={{ color: 'var(--muted)', margin: 0, wordBreak: 'break-all' }}>
          <code>{url}</code> đang mở ở tab <b>{existingName}</b>.
        </p>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="ghost sm" onClick={onCancel}>Hủy</button>
          <button className="ghost sm" onClick={onOpenNew}>⊞ Mở thêm tab mới</button>
          <button autoFocus onClick={onGoExisting}>↪ Chuyển tới tab đã mở</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Khoá nhận diện "cùng một trang trên cùng một phiên": partition + URL đã
 * chuẩn hoá (bỏ #fragment và / cuối — đổi fragment không phải trang khác,
 * "…/a" với "…/a/" là một). Dùng để dò tab trùng TRƯỚC khi mở.
 */
export function tabUrlKey(partition: string, url: string): string {
  let u = url;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    u = parsed.toString();
  } catch { /* URL lạ — so nguyên văn */ }
  return `${partition}|${u.endsWith('/') ? u.slice(0, -1) : u}`;
}
