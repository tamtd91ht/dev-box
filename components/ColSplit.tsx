'use client';

// Chia đôi theo CHIỀU NGANG cho các tab truy vấn: truy vấn bên trái, kết quả bên phải, kéo thanh giữa để đổi độ rộng.
// Port từ vhs-monitor (browse/shared/SplitPane). Khác components/api/SplitPane (API: thu gọn ô, dọc/ngang) — cái này
// đơn giản hơn và TỰ ĐO chiều cao: từ mép trên khung tới đáy cửa sổ (đo lại khi đổi cỡ cửa sổ / bố cục phía trên đổi),
// mỗi bên tự cuộn riêng nên kết quả luôn có tối đa chiều cao. Tỉ lệ nhớ theo máy (localStorage[storageKey]).
// Màn hẹp (≤ 860px) → xếp dọc như cũ.
//
// Dùng: <ColSplit storageKey="…"><LeftPane/><RightPane/></ColSplit> — đúng HAI con.

import { Children, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

const MIN_PCT = 18;
const MAX_PCT = 82;
const BOTTOM_GAP = 24;
const MIN_HEIGHT = 360;

const clamp = (n: number) => Math.min(MAX_PCT, Math.max(MIN_PCT, n));

export default function ColSplit({ storageKey, children, defaultPct = 40 }: {
  storageKey: string;
  children: ReactNode;
  defaultPct?: number;
}) {
  const [left, right] = Children.toArray(children) as ReactNode[];
  const [pct, setPct] = useState<number>(defaultPct);
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Đọc tỉ lệ đã lưu SAU mount (đọc ở useState làm server/client lệch nhau).
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      if (v) setPct(clamp(v));
    } catch { /* localStorage bị chặn — dùng mặc định */ }
  }, [storageKey]);

  const save = (v: number) => { try { localStorage.setItem(storageKey, String(Math.round(v * 10) / 10)); } catch { /* bỏ qua */ } };

  // Đo chiều cao còn lại: từ mép trên khung tới đáy VÙNG LÀM VIỆC (`.workspace` — phần giữa header và footer của app,
  // tự cuộn), không phải đáy cửa sổ: footer chiếm ~60px dưới cùng nên đo theo cửa sổ sẽ tràn xuống dưới footer.
  // Vị trí tính theo toạ độ NỘI DUNG của vùng cuộn (cộng scrollTop) để cuộn trang không làm chiều cao đổi.
  const fit = useCallback(() => {
    const el = root.current;
    if (!el || el.offsetParent === null) return; // đang ẩn (tab khác)
    const ws = el.closest('.workspace') as HTMLElement | null;
    const rect = el.getBoundingClientRect();
    let h: number;
    if (ws) {
      const wr = ws.getBoundingClientRect();
      const posInContent = rect.top - wr.top + ws.scrollTop;
      h = ws.clientHeight - posInContent - BOTTOM_GAP;
    } else {
      h = window.innerHeight - (rect.top + window.scrollY) - BOTTOM_GAP;
    }
    el.style.setProperty('--cs-split-h', `${Math.max(MIN_HEIGHT, Math.floor(h))}px`);
  }, []);

  useEffect(() => {
    fit();
    window.addEventListener('resize', fit);
    const ro = new ResizeObserver(fit); // bật lại từ trạng thái ẩn, hoặc bố cục phía trên đổi cao
    if (root.current) ro.observe(root.current);
    ro.observe(document.body);
    const ws = root.current?.closest('.workspace');
    if (ws) ro.observe(ws);
    return () => { window.removeEventListener('resize', fit); ro.disconnect(); };
  }, [fit]);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = root.current;
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const rect = el.getBoundingClientRect();
    let last = pct;
    const move = (ev: PointerEvent) => { last = clamp(((ev.clientX - rect.left) / rect.width) * 100); setPct(last); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setDragging(false);
      save(last);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 2;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = clamp(pct - step);
    else if (e.key === 'ArrowRight') next = clamp(pct + step);
    else if (e.key === 'Home') next = defaultPct;
    if (next === null) return;
    e.preventDefault();
    setPct(next);
    save(next);
  };

  return (
    <div ref={root} className={`cs-split${dragging ? ' dragging' : ''}`} style={{ ['--cs-split-l' as string]: `${pct}%` }}>
      <div className="cs-split-left">{left}</div>
      <div
        className="cs-split-bar"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(pct)}
        tabIndex={0}
        title="Kéo để đổi độ rộng · nháy đúp về mặc định"
        onPointerDown={onDown}
        onKeyDown={onKey}
        onDoubleClick={() => { setPct(defaultPct); save(defaultPct); }}
      />
      <div className="cs-split-right">{right}</div>
    </div>
  );
}
