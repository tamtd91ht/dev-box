// Kéo đổi bề rộng cột — dùng chung cho mọi view chia 2 cột (rail | nội dung).
//
// Sinh ra vì màn hình hẹp: mấy tab chia 3 cột (rail cluster + danh sách + nội
// dung) ăn mất ~870px trước khi tới chỗ cần đọc. Kéo thanh giữa hai cột để
// nới đúng ô đang cần, xong việc thì trả về như cũ.
//
// BA NGUYÊN TẮC — đọc trước khi sửa:
//
// 1. TẠM THỜI, KHÔNG NHỚ. Không đụng localStorage. Mở lại app là mọi view về
//    đúng bề rộng thiết kế ban đầu. Cố ý vậy: đây là công cụ "nới ra xem cho
//    rõ cái này đã", không phải thiết lập cá nhân — nhớ lại thì lần sau mở lên
//    thấy layout lạ mà không nhớ vì sao. (Trong một phiên thì vẫn giữ, chuyển
//    tab qua lại không mất.)
//
// 2. MẶC ĐỊNH KHÔNG ĐỔI GÌ. Khi chưa kéo, hook KHÔNG ghi gì vào style — CSS
//    của view chạy y như trước, kể cả minmax() và media query. Chỉ khi kéo mới
//    ghi một con số vào BIẾN CSS RIÊNG của view đó.
//
// 3. THANH KÉO ĐẶT NỔI, không phải ô thứ ba của grid. Vì các view khác nhau ở
//    `align-items` (Kafka `stretch`, ES/Mongo `start`) và ở `gap` (12/14/18px):
//    nếu để nó làm con của grid thì ở view `start` nó cao 0px, bấm không trúng,
//    còn `gap` sẽ bị tính hai lần. Đặt `position:absolute` phủ đúng khe hở giữa
//    hai cột thì miễn nhiễm với cả hai thứ đó, và grid vẫn đúng 2 track.
//
// Bề rộng cột trái ĐO TỪ DOM (ResizeObserver) chứ không nhận từ tham số, nên
// hook chạy đúng cả khi CSS ghi minmax() — và khi cửa sổ hẹp lại, media query
// gập về 1 cột thì tự phát hiện ra để giấu thanh kéo đi.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

export interface SplitOptions {
  /**
   * Tên biến CSS mà view dùng trong grid-template-columns, vd '--es-rail'.
   * PHẢI đặt riêng cho từng cấp: biến CSS di truyền xuống con, nên hai split
   * lồng nhau (rail cluster ⊃ danh sách index) mà trùng tên thì cấp trong ăn
   * phải con số của cấp ngoài.
   */
  varName: string;
  /** Chặn dưới/trên cho cột trái (px). */
  min: number;
  max: number;
  /** `gap` của grid (px) — thanh kéo phủ đúng khe hở đó. */
  gap: number;
  /** Bước nhảy khi chỉnh bằng ←/→ (px). */
  step?: number;
}

export interface SplitGrip {
  /** Layout đang gập 1 cột (màn hẹp) → không vẽ thanh kéo. */
  hidden: boolean;
  dragging: boolean;
  /** Vị trí + bề rộng thanh kéo, tính theo khung chứa. */
  left: number;
  width: number;
  value: number;
  min: number;
  max: number;
  onStart: () => void;
  onNudge: (delta: number) => void;
  onReset: () => void;
  step: number;
}

/** Thanh kéo hẹp quá thì khó trúng chuột — nới vùng bấm ra tối thiểu 10px. */
const MIN_HIT = 10;

export function useSplit({ varName, min, max, gap, step = 16 }: SplitOptions) {
  /** Bề rộng người dùng đã kéo. null = chưa đụng tới → để CSS tự quyết. */
  const [width, setWidth] = useState<number | null>(null);
  /** Bề rộng THẬT của cột trái lúc này (đo từ DOM). */
  const [rail, setRail] = useState(0);
  /** Đã gập về 1 cột (media query) — cột trái chiếm gần hết khung. */
  const [stacked, setStacked] = useState(true);
  const [dragging, setDragging] = useState(false);

  const boxRef = useRef<HTMLElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const measure = useCallback(() => {
    const box = boxRef.current;
    const first = box?.firstElementChild as HTMLElement | null;
    if (!box || !first) return;
    // View đang bị ẨN (display:none — tab không được xem) đo ra 0 hết. Số 0 đó
    // không phải kích thước thật: nhận nó vào là `stacked` bật (tưởng màn hẹp,
    // giấu luôn thanh kéo) và `clamp` bên dưới bóp bề rộng đã kéo về `min`.
    // Bỏ qua; ResizeObserver báo lại ngay khi view hiện trở lại.
    if (box.clientWidth === 0) return;
    setRail(first.offsetWidth);
    // Gập 1 cột thì cột trái rộng bằng cả khung — lúc đó khe hở không còn.
    setStacked(first.offsetWidth >= box.clientWidth - gap);
  }, [gap]);

  /** Gắn vào chính thẻ có grid-template-columns. */
  const ref = useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    boxRef.current = el;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    roRef.current = ro;
    measure();
  }, [measure]);

  useEffect(() => () => roRef.current?.disconnect(), []);

  /** Kẹp lại theo khung THẬT lúc này: ô phải luôn còn ít nhất `min` để không
   *  ai kéo cho nó biến mất, và giá trị cũ không bao giờ vượt khung hiện tại. */
  const clamp = useCallback((w: number) => {
    const box = boxRef.current;
    // clientWidth 0 = view đang ẩn (xem measure): không có khung thật để kẹp
    // theo, nên xử như chưa biết khung — giữ nguyên bề rộng người dùng đã kéo.
    const room = box && box.clientWidth > 0 ? box.clientWidth - gap - min : max;
    return Math.max(min, Math.min(Math.min(max, room), w));
  }, [min, max, gap]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const box = boxRef.current;
      if (!box) return;
      setWidth(clamp(e.clientX - box.getBoundingClientRect().left));
    };
    const stop = () => setDragging(false);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, clamp]);

  // Cửa sổ co lại nhỏ hơn bề rộng đã kéo → kẹp lại, nếu không cột phải bị bóp
  // mất tăm ở đúng cái màn hình hẹp mà tính năng này sinh ra để phục vụ.
  useEffect(() => {
    if (width == null) return;
    const c = clamp(width);
    if (c !== width) setWidth(c);
  }, [width, clamp, rail]);

  const style: CSSProperties = { position: 'relative' };
  if (width != null) (style as Record<string, string>)[varName] = `${Math.round(width)}px`;

  const hit = Math.max(gap, MIN_HIT);
  const grip: SplitGrip = {
    hidden: stacked,
    dragging,
    left: rail + (gap - hit) / 2,
    width: hit,
    value: Math.round(width ?? rail),
    min,
    max,
    step,
    onStart: () => setDragging(true),
    onNudge: (d) => setWidth((w) => clamp((w ?? rail) + d)),
    onReset: () => setWidth(null),
  };

  return { ref, style, grip };
}
