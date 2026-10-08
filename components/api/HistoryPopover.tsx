'use client';

// Nút 🕘 ở thanh URL: danh sách các lần gửi gần đây, bấm một dòng để mở lại thành
// một tab request. Dữ liệu ở lib/apiHistory (localStorage, per-máy).

import { useEffect, useState } from 'react';
import { clearHistory, loadHistory, type HistoryItem } from '@/lib/apiHistory';

function ago(at: number): string {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return new Date(at).toLocaleDateString('vi-VN');
}

export default function HistoryPopover({
  version, onOpen,
}: {
  /** Đổi giá trị này (vd tăng sau mỗi lần gửi) để danh sách đọc lại localStorage. */
  version: number;
  onOpen: (draft: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HistoryItem[]>([]);

  useEffect(() => { if (open) setItems(loadHistory()); }, [open, version]);

  return (
    <span className="api-pop-wrap">
      <button className={`ghost sm${open ? ' on' : ''}`} onClick={() => setOpen((v) => !v)}
        title="Lịch sử các lần gửi" aria-haspopup="dialog" aria-expanded={open}>🕘</button>
      {open && (
        <>
          <div className="api-pop-veil" onClick={() => setOpen(false)} aria-hidden />
          <div className="api-pop api-hist" role="dialog" aria-label="Lịch sử gửi">
            <div className="api-hist-head">
              <b>Lịch sử gửi</b><span style={{ flex: 1 }} />
              {items.length > 0 && (
                <button className="ghost sm" onClick={() => { clearHistory(); setItems([]); }}>Xoá hết</button>
              )}
            </div>
            {items.length === 0 && <p className="small" style={{ color: 'var(--muted)', margin: 8 }}>Chưa có lần gửi nào.</p>}
            {items.map((it) => (
              <button key={it.id} className="api-hist-item" onClick={() => { onOpen(it.draft); setOpen(false); }}
                title={it.bodyDropped ? `${it.url}\n(body quá lớn nên không lưu — gửi lại sẽ thiếu body)` : it.url}>
                <span className={`api-m api-m--${it.method.toLowerCase()}`}>{it.method}</span>
                <span className="api-hist-url">{it.url}</span>
                {it.status !== undefined
                  ? <span className={`api-status api-status--${Math.floor(it.status / 100)}`}>{it.status}</span>
                  : <span className="api-status api-status--5" title={it.error}>lỗi</span>}
                <span className="small" style={{ color: 'var(--muted)' }}>{it.timeMs !== undefined ? `${it.timeMs}ms · ` : ''}{ago(it.at)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
