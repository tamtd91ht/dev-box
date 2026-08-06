'use client';

// Màn hình TIẾP CẬN NHANH các tab đang làm việc (Ctrl+`, hoặc nút 🕘 trên
// header). Giống khu "vừa xem" của Chrome: đang làm Kafka → có mail thì nhảy
// qua Mail đọc → bấm Ctrl+` chọn lại Kafka là về đúng chỗ cũ, khỏi dò menu.
//
//   · Danh sách xếp theo VỪA DÙNG (mới nhất trước), kèm "mở lúc nào".
//   · Gõ để lọc theo tên tab; ↑/↓ chọn, Enter mở, Esc đóng.
//   · ✕ trên từng thẻ để bỏ khỏi danh sách; "Xoá hết" dọn sạch.
//   · Ctrl+Tab (không cần mở màn hình này) nhảy thẳng về tab trước đó.
//
// Tab vẫn LUÔN còn trên thanh menu — xoá ở đây chỉ là dọn danh sách vừa dùng,
// không đóng hay tắt tính năng nào.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecentTab } from '@/lib/recentTabs';

/** Nhãn hiển thị của một tab — app truyền vào vì nó nắm TABS + packs. */
export interface TabInfo {
  key: string;
  icon: string;
  label: string;
  /** Nhãn phụ: badge của tab lõi, hoặc tên project với pack. */
  badge?: string;
  /** Số thông báo chưa đọc để chấm đỏ lên thẻ. */
  unread?: number;
}

export interface QuickTabsProps {
  open: boolean;
  /** Tab đang mở — đánh dấu "đang xem", không cho tự chọn lại chính nó. */
  current: string;
  recents: RecentTab[];
  /** Tra cứu nhãn cho một khoá tab; trả undefined nếu tab không còn tồn tại. */
  info: (key: string) => TabInfo | undefined;
  onPick: (key: string) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/** "vừa xong · 5 phút trước · 2 giờ trước · hôm qua" */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'vừa xong';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.round(h / 24);
  return d === 1 ? 'hôm qua' : `${d} ngày trước`;
}

export default function QuickTabs({
  open, current, recents, info, onPick, onRemove, onClear, onClose,
}: QuickTabsProps) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Mỗi lần mở lại: xoá ô tìm, chọn mục đầu (tab vừa dùng trước đó).
  useEffect(() => {
    if (!open) return;
    setQ(''); setSel(0);
    // autoFocus không ăn khi phần tử vừa mount trong overlay → focus tay.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  /** Ghép recents với nhãn; bỏ tab không còn tồn tại (pack đã xoá chẳng hạn). */
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return recents
      .map((r) => ({ r, t: info(r.key) }))
      .filter((x): x is { r: RecentTab; t: TabInfo } => !!x.t)
      .filter(({ t }) => !needle
        || t.label.toLowerCase().includes(needle)
        || t.key.toLowerCase().includes(needle)
        || (t.badge ?? '').toLowerCase().includes(needle));
  }, [recents, info, q]);

  // Giữ ô chọn nằm trong danh sách khi lọc làm nó ngắn lại.
  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, rows.length - 1))); }, [rows.length]);

  const pick = useCallback((key: string) => { onPick(key); onClose(); }, [onPick, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = rows[sel];
      if (hit) pick(hit.r.key);
    } else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  // Cuộn theo mục đang chọn khi đi bằng phím.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.qt-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  return (
    <div className="qt-backdrop" onClick={onClose}>
      <div
        className="qt-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Tiếp cận nhanh các tab đang làm"
      >
        <div className="qt-head">
          <span className="qt-head-ico" aria-hidden>🕘</span>
          <input
            ref={inputRef}
            className="qt-search"
            placeholder="Tìm tab đang làm…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
          />
          {recents.length > 0 && (
            <button className="ghost sm" onClick={onClear} title="Xoá sạch danh sách vừa dùng">
              Xoá hết
            </button>
          )}
          <button className="ghost sm" onClick={onClose} title="Đóng (Esc)">✕</button>
        </div>

        <div className="qt-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="empty" style={{ padding: '26px 10px' }}>
              <p className="small" style={{ color: 'var(--muted)' }}>
                {recents.length === 0
                  ? 'Chưa có tab nào được ghi nhận — cứ làm việc bình thường, các tab vừa mở sẽ hiện ở đây.'
                  : 'Không có tab nào khớp từ khoá.'}
              </p>
            </div>
          )}
          {rows.map(({ r, t }, i) => (
            <div
              key={r.key}
              className={`qt-row${i === sel ? ' sel' : ''}${r.key === current ? ' cur' : ''}`}
              onMouseEnter={() => setSel(i)}
            >
              <button className="qt-open" onClick={() => pick(r.key)} title={`Mở tab ${t.label}`}>
                <span className="qt-rank" aria-hidden>{i + 1}</span>
                <span className="qt-ico" aria-hidden>{t.icon}</span>
                <span className="qt-name">
                  <span className="qt-label">
                    {t.label}
                    {r.key === current && <span className="qt-cur-tag">đang xem</span>}
                    {(t.unread ?? 0) > 0 && (
                      <span className="qt-unread" title={`${t.unread} thông báo mới`}>
                        {(t.unread ?? 0) > 99 ? '99+' : t.unread}
                      </span>
                    )}
                  </span>
                  <span className="qt-meta">
                    {ago(r.at)}
                    {t.badge && <> · {t.badge}</>}
                    {r.count > 1 && <> · đã mở {r.count} lần</>}
                  </span>
                </span>
              </button>
              <button
                className="ghost sm qt-del"
                onClick={(e) => { e.stopPropagation(); onRemove(r.key); }}
                title="Bỏ khỏi danh sách vừa dùng (tab vẫn còn trên menu)"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="qt-foot small">
          <span><b className="qt-kbd">Ctrl</b><b className="qt-kbd">`</b> mở màn hình này</span>
          <span aria-hidden>·</span>
          <span><b className="qt-kbd">Ctrl</b><b className="qt-kbd">Tab</b> quay lại tab trước</span>
          <span style={{ flex: 1 }} />
          <span><b className="qt-kbd">↑</b><b className="qt-kbd">↓</b> chọn · <b className="qt-kbd">↵</b> mở</span>
        </div>
      </div>
    </div>
  );
}
