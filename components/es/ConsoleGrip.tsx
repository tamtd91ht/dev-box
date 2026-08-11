'use client';

// Thanh kéo của tab Console — phần nhìn thấy của lib/useConsoleSplit.ts.
//
// Dùng lại class `.split-grip` / `.split-veil` của Splitter (components/Splitter)
// để hai chỗ kéo trong cùng app trông và bấm y như nhau. Khác Splitter ở chỗ:
// nhận `step` từ ngoài, vì grip giữa chạy theo % còn grip lịch sử theo px.
//
// Tấm phủ trong suốt lúc kéo là bắt buộc: không có nó, con trỏ đi qua Monaco
// (canvas + iframe của widget) là chuột rơi vào editor và thanh kéo đứng chết.

import type { ConsoleGrip } from '@/lib/useConsoleSplit';

export interface ConsoleGripProps extends ConsoleGrip {
  /** Bước nhảy khi chỉnh bằng ←/→ (đơn vị của `value`). */
  step: number;
}

export default function ConsoleGripBar({
  left, width, dragging, label, value, min, max, step, onStart, onNudge, onReset,
}: ConsoleGripProps) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? step * 3 : step;
    if (e.key === 'ArrowLeft') { e.preventDefault(); onNudge(-d); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); onNudge(d); }
    else if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onReset(); }
  };

  return (
    <>
      <div
        className={`split-grip${dragging ? ' on' : ''}`}
        style={{ left, width }}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        onPointerDown={(e) => { e.preventDefault(); onStart(); }}
        onDoubleClick={onReset}
        onKeyDown={onKeyDown}
        title={`${label} · đúp chuột về mặc định · ←/→ chỉnh từng bước`}
      >
        <span className="split-grip-line" aria-hidden />
      </div>
      {dragging && <div className="split-veil" aria-hidden />}
    </>
  );
}
