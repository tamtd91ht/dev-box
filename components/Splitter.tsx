'use client';

// Thanh kéo giữa hai cột — phần nhìn thấy của lib/useSplit.ts.
//
// Đặt làm con CUỐI của thẻ có grid-template-columns; nó `position:absolute` nên
// KHÔNG đẻ thêm ô cho grid, chỉ nằm đè lên khe hở giữa hai cột.
//
// Lúc kéo có một tấm PHỦ TRONG SUỐT trùm cả cửa sổ: không có nó thì con trỏ đi
// qua <iframe>/<webview> là chuột rơi vào trang khách, thanh kéo đứng chết tại
// chỗ (tab Workspace, ô xem HTML ở Tools đều dính). Tấm phủ giữ luôn con trỏ
// col-resize trên toàn màn hình.

import type { SplitGrip } from '@/lib/useSplit';

export default function Splitter({
  hidden, dragging, left, width, value, min, max, step, onStart, onNudge, onReset,
}: SplitGrip) {
  if (hidden) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? step * 3 : step;
    if (e.key === 'ArrowLeft') { e.preventDefault(); onNudge(-d); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); onNudge(d); }
    else if (e.key === 'Home') { e.preventDefault(); onNudge(-9999); }
    else if (e.key === 'End') { e.preventDefault(); onNudge(9999); }
    else if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onReset(); }
  };

  return (
    <>
      <div
        className={`split-grip${dragging ? ' on' : ''}`}
        style={{ left, width }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Kéo để đổi bề rộng hai cột"
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        onPointerDown={(e) => { e.preventDefault(); onStart(); }}
        onDoubleClick={onReset}
        onKeyDown={onKeyDown}
        title="Kéo để nới cột · đúp chuột về mặc định · ←/→ chỉnh từng bước (chỉ áp dụng trong phiên này)"
      >
        <span className="split-grip-line" aria-hidden />
      </div>
      {dragging && <div className="split-veil" aria-hidden />}
    </>
  );
}
