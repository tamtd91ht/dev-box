'use client';

// Kích thước + trạng thái phóng to của cửa sổ SOẠN THƯ.
//
// VÌ SAO TÁCH HOOK RIÊNG: composer trước đây khoá cứng `width: min(720px,94vw)`
// và `max-height: 88vh`. Mail có bảng, ảnh, hoặc chuỗi trả lời dài thì gõ vài
// dòng đã phải cuộn — mà cuộn thì trôi mất phần trích dẫn đang cần đối chiếu.
// Ở đây gom cả ba cách nới: nút phóng to/thu nhỏ, kéo góc bằng chuột, và NHỚ
// lại cho lần soạn sau.
//
// VÌ SAO localStorage chứ không phải file config server: đây là thói quen theo
// MÀN HÌNH đang ngồi, không phải thiết lập của tài khoản mail. Máy hai màn
// khác độ phân giải mà đồng bộ kích thước sang nhau thì phiền hơn là tiện.

import { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'mail.composeSize';

/** Nhỏ hơn mức này thì thanh nút dưới đáy bắt đầu vỡ dòng. */
export const MIN_W = 420;
export const MIN_H = 320;

export interface ComposeSize { w: number; h: number }

/** Mặc định: đúng khổ cũ (720 rộng, 88% chiều cao) để ai quen rồi không thấy lạ. */
function defaultSize(): ComposeSize {
  if (typeof window === 'undefined') return { w: 720, h: 640 };
  return {
    w: Math.min(720, window.innerWidth - 32),
    h: Math.round(window.innerHeight * 0.88),
  };
}

/** Ép một kích thước vào trong màn hình hiện tại. Cần cả lúc đọc localStorage
 *  (đã đổi màn hình từ lần trước) lẫn lúc đang kéo. */
function clamp(s: ComposeSize): ComposeSize {
  if (typeof window === 'undefined') return s;
  return {
    w: Math.max(MIN_W, Math.min(s.w, window.innerWidth - 24)),
    h: Math.max(MIN_H, Math.min(s.h, window.innerHeight - 24)),
  };
}

function load(): ComposeSize {
  if (typeof window === 'undefined') return defaultSize();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<ComposeSize>;
      if (typeof v.w === 'number' && typeof v.h === 'number') return clamp({ w: v.w, h: v.h });
    }
  } catch { /* localStorage bị chặn / JSON hỏng — về mặc định */ }
  return defaultSize();
}

export interface ComposeSizeApi {
  /** Kích thước đang áp (chỉ dùng khi KHÔNG phóng to). */
  size: ComposeSize;
  maximized: boolean;
  toggleMax: () => void;
  /** Gắn vào tay kéo ở góc dưới-phải. */
  onResizeStart: (e: React.PointerEvent) => void;
  /** Đang kéo — tắt transition + chọn chữ trong lúc kéo cho khỏi giật. */
  resizing: boolean;
  /** style cho khung composer: phóng to thì gần full màn, không thì theo size. */
  style: React.CSSProperties;
}

export function useComposeSize(): ComposeSizeApi {
  // Đọc localStorage trong initializer chứ không phải effect: đọc ở effect thì
  // khung hiện ra khổ mặc định rồi mới nhảy sang khổ đã lưu — thấy rõ cú giật.
  // SSR không có window nên lần render đầu trên server dùng mặc định; client
  // hydrate lại ngay ở lượt đầu tiên.
  const [size, setSize] = useState<ComposeSize>(() => (typeof window === 'undefined' ? defaultSize() : load()));
  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);
  /** Mốc lúc bắt đầu kéo — tính theo delta chuột, không theo vị trí tuyệt đối,
   *  nên con trỏ không "trượt" khỏi tay kéo khi khung chạm giới hạn. */
  const from = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // Đổi kích thước cửa sổ app (kéo mép, Ultra View) → khung có thể to hơn màn.
  useEffect(() => {
    const onResize = () => setSize((s) => clamp(s));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const persist = useCallback((s: ComposeSize) => {
    try { window.localStorage.setItem(KEY, JSON.stringify(s)); }
    catch { /* chặn localStorage thì thôi, không phá việc soạn thư */ }
  }, []);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    // Kéo tay nắm = đang ở chế độ khung tự do; phóng to thì không kéo được.
    if (maximized) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    // setPointerCapture: chuột chạy nhanh ra ngoài tay nắm vẫn giữ được sự
    // kiện, không thì kéo mạnh một cái là rớt.
    el.setPointerCapture?.(e.pointerId);
    from.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
    setResizing(true);
  }, [maximized, size.w, size.h]);

  // Đăng ký move/up ở cấp window: pointer capture giữ sự kiện trên tay nắm,
  // nhưng nghe ở window thì vẫn đúng kể cả khi capture không được hỗ trợ.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const f = from.current;
      if (!f) return;
      setSize(clamp({ w: f.w + (e.clientX - f.x) * 2, h: f.h + (e.clientY - f.y) * 2 }));
    };
    const onUp = () => {
      setResizing(false);
      from.current = null;
      setSize((s) => { persist(s); return s; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [resizing, persist]);

  const toggleMax = useCallback(() => setMaximized((v) => !v), []);

  const style: React.CSSProperties = maximized
    ? { width: 'calc(100vw - 24px)', height: 'calc(100vh - 24px)', maxHeight: 'none' }
    : { width: size.w, height: size.h, maxHeight: 'none' };

  return { size, maximized, toggleMax, onResizeStart, resizing, style };
}
