'use client';

// Chia đôi một vùng thành hai ô kéo được bằng chuột: ô thứ nhất | ô thứ hai
// (dir='h', cạnh nhau) hoặc trên / dưới (dir='v').
//
// Dùng cho tab API: Request ở một ô, Response ở ô kia, để Response tận dụng hết
// chiều cao thay vì bị đẩy xuống dưới form.
//
//   · Kéo thanh giữa để đổi tỉ lệ (`frac` = phần của ô thứ nhất, 0..1). Đúp chuột
//     về 50/50; ←/→ (hoặc ↑/↓ khi xếp dọc) chỉnh từng bước khi thanh đang focus.
//   · Thu gọn một ô (`collapsed`): ô đó co thành một dải mỏng có nút mở lại, ô
//     còn lại chiếm hết chỗ. Nội dung ô bị thu KHÔNG unmount (chỉ ẩn) — Monaco
//     đang soạn dở, vị trí cuộn… còn nguyên khi mở lại.
//   · Lúc kéo có tấm phủ trong suốt trùm cửa sổ (.split-veil) để con trỏ đi qua
//     iframe/webview không làm thanh kéo đứng chết — cùng lý do với Splitter.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type SplitDir = 'h' | 'v';
export type SplitCollapsed = 'first' | 'second' | null;

const MIN_FRAC = 0.12;
const MAX_FRAC = 0.88;
const STEP = 0.03;

const clamp = (f: number) => Math.max(MIN_FRAC, Math.min(MAX_FRAC, f));

export interface SplitPaneProps {
  dir: SplitDir;
  /** Phần của ô thứ nhất, 0..1. */
  frac: number;
  onFrac: (f: number) => void;
  collapsed: SplitCollapsed;
  onCollapsed: (c: SplitCollapsed) => void;
  first: ReactNode;
  second: ReactNode;
  /** Nhãn hiện trên dải khi ô tương ứng bị thu gọn. */
  firstLabel: string;
  secondLabel: string;
}

export default function SplitPane({
  dir, frac, onFrac, collapsed, onCollapsed, first, second, firstLabel, secondLabel,
}: SplitPaneProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const box = boxRef.current;
      if (!box) return;
      const r = box.getBoundingClientRect();
      const size = dir === 'h' ? r.width : r.height;
      // Khung đang ẩn / chưa có kích thước: không có gì để tính, bỏ qua thay vì
      // ghi NaN vào tỉ lệ.
      if (size <= 0) return;
      const pos = dir === 'h' ? e.clientX - r.left : e.clientY - r.top;
      onFrac(clamp(pos / size));
    };
    const stop = () => setDragging(false);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = dir === 'h' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, dir, onFrac]);

  const onKeyDown = (e: KeyboardEvent) => {
    const back = dir === 'h' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = dir === 'h' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back) { e.preventDefault(); onFrac(clamp(frac - STEP)); }
    else if (e.key === fwd) { e.preventDefault(); onFrac(clamp(frac + STEP)); }
    else if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onFrac(0.5); }
  };

  const f = clamp(frac);
  const paneStyle = (which: 'first' | 'second') => {
    if (collapsed === which) return { display: 'none' } as const;
    if (collapsed) return { flex: '1 1 0%' } as const; // ô còn lại ăn hết chỗ
    return { flex: `${which === 'first' ? f : 1 - f} 1 0%` } as const;
  };

  const strip = (which: 'first' | 'second', label: string) => (
    <button
      type="button"
      className={`api-strip api-strip--${dir}`}
      onClick={() => onCollapsed(null)}
      title={`Mở lại ${label}`}
      aria-label={`Mở lại ${label}`}
    >
      <span aria-hidden>{which === 'first' ? (dir === 'h' ? '▸' : '▾') : (dir === 'h' ? '◂' : '▴')}</span>
      <span className="api-strip-label">{label}</span>
    </button>
  );

  return (
    <div ref={boxRef} className={`api-split api-split--${dir}`}>
      {collapsed === 'first' && strip('first', firstLabel)}
      <div className="api-pane" style={paneStyle('first')}>{first}</div>
      {!collapsed && (
        <div
          className={`api-divider api-divider--${dir}${dragging ? ' on' : ''}`}
          role="separator"
          aria-orientation={dir === 'h' ? 'vertical' : 'horizontal'}
          aria-valuenow={Math.round(f * 100)}
          aria-valuemin={Math.round(MIN_FRAC * 100)}
          aria-valuemax={Math.round(MAX_FRAC * 100)}
          aria-label={`Kéo để đổi kích thước ${firstLabel} / ${secondLabel}`}
          tabIndex={0}
          onPointerDown={(e) => { e.preventDefault(); setDragging(true); }}
          onDoubleClick={() => onFrac(0.5)}
          onKeyDown={onKeyDown}
          title="Kéo để đổi kích thước · đúp chuột về 50/50 · phím mũi tên chỉnh từng bước"
        >
          <span className="api-divider-line" aria-hidden />
        </div>
      )}
      <div className="api-pane" style={paneStyle('second')}>{second}</div>
      {collapsed === 'second' && strip('second', secondLabel)}
      {dragging && <div className="split-veil" style={{ cursor: dir === 'h' ? 'col-resize' : 'row-resize' }} aria-hidden />}
    </div>
  );
}
