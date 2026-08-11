'use client';

// Hai thanh kéo cho tab Console: editor │ kết quả │ lịch sử.
//
// Vì sao KHÔNG dùng lib/useSplit.ts: hook đó phục vụ grid 2 track (rail | nội
// dung), đo bề rộng cột trái từ DOM và CỐ Ý không nhớ gì. Console cần ba thứ nó
// không có, và không nên nhồi vào nó:
//
//   · HAI grip, tỉ lệ hai bên ràng buộc nhau (kéo grip giữa thì cột lịch sử
//     phải đứng yên).
//   · NHỚ LẠI giữa các lần mở. Ở đây tỉ lệ editor/kết quả là thói quen làm việc
//     (người soạn lệnh dài muốn editor rộng, người đọc response muốn ngược lại),
//     khác hẳn cái "nới ra xem cho rõ rồi trả lại" của rail.
//   · Đơn vị PHẦN TRĂM cho hai cột co giãn + px cho cột lịch sử, nên khung to
//     nhỏ thế nào thì tỉ lệ vẫn giữ.
//
// Grip đặt absolute phủ khe hở giữa hai cột — cùng lý do đã ghi ở useSplit.ts:
// làm con của grid thì nó thành track thứ tư và `gap` bị tính hai lần.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { readLocal, writeLocal } from './localKeys';

const KEY = 'es.console.split';

/** % bề rộng cột editor trong phần co giãn (editor + kết quả). */
const DEFAULT_LEFT_PCT = 50;
const MIN_PCT = 20;
const MAX_PCT = 80;

/** Bề rộng cột lịch sử (px). */
const DEFAULT_HIST = 232;
const HIST_MIN = 150;
const HIST_MAX = 460;

const GAP = 10;
/** Khe hở 10px khó trúng chuột — nới vùng bấm ra. */
const HIT = 12;

interface Saved { leftPct: number; hist: number }

function loadSaved(): Saved {
  const fallback = { leftPct: DEFAULT_LEFT_PCT, hist: DEFAULT_HIST };
  try {
    const raw = readLocal(KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<Saved>;
    return {
      leftPct: typeof v.leftPct === 'number' ? clampPct(v.leftPct) : DEFAULT_LEFT_PCT,
      hist: typeof v.hist === 'number' ? clampHist(v.hist) : DEFAULT_HIST,
    };
  } catch {
    return fallback;
  }
}

function clampPct(p: number): number {
  return Math.max(MIN_PCT, Math.min(MAX_PCT, p));
}
function clampHist(w: number): number {
  return Math.max(HIST_MIN, Math.min(HIST_MAX, w));
}

/** Một thanh kéo — khớp với props của components/es/ConsoleGrip.tsx. */
export interface ConsoleGrip {
  left: number;
  width: number;
  dragging: boolean;
  label: string;
  value: number;
  min: number;
  max: number;
  onStart: () => void;
  onNudge: (delta: number) => void;
  onReset: () => void;
}

export interface ConsoleSplit {
  /** Gắn vào chính thẻ có grid-template-columns. */
  ref: (el: HTMLElement | null) => void;
  style: CSSProperties;
  /** Grip giữa editor và kết quả. */
  mid: ConsoleGrip | null;
  /** Grip giữa kết quả và lịch sử — null khi cột lịch sử đang đóng. */
  hist: ConsoleGrip | null;
}

/**
 * @param histOpen Cột lịch sử đang mở — quyết định có grip thứ hai hay không.
 */
export function useConsoleSplit(histOpen: boolean): ConsoleSplit {
  const [leftPct, setLeftPct] = useState(DEFAULT_LEFT_PCT);
  const [hist, setHist] = useState(DEFAULT_HIST);
  /** 'mid' | 'hist' | null — grip đang bị kéo. */
  const [drag, setDrag] = useState<'mid' | 'hist' | null>(null);
  /** Bề rộng khung, đo từ DOM — grip cần nó để đổi % ↔ px. */
  const [boxW, setBoxW] = useState(0);
  /** Khung hẹp → CSS gập về 1 cột, lúc đó không vẽ grip. */
  const [stacked, setStacked] = useState(true);

  const boxRef = useRef<HTMLElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  // Đọc localStorage sau khi mount — SSR không có window, và đọc trong
  // useState initialiser sẽ làm HTML server khác client (hydration mismatch).
  useEffect(() => {
    const s = loadSaved();
    setLeftPct(s.leftPct);
    setHist(s.hist);
  }, []);

  const persist = useCallback((next: Partial<Saved>) => {
    writeLocal(KEY, JSON.stringify({ leftPct, hist, ...next }));
  }, [leftPct, hist]);

  const ref = useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    boxRef.current = el;
    if (!el) return;
    const measure = () => {
      setBoxW(el.clientWidth);
      // Cùng ngưỡng với media query ở globals.css (.es-console gập ở 1100px).
      setStacked(el.clientWidth < 700);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
    measure();
  }, []);

  useEffect(() => () => roRef.current?.disconnect(), []);

  /** Bề rộng phần co giãn (đã trừ cột lịch sử + các khe hở). */
  const flexW = Math.max(1, boxW - (histOpen ? hist + GAP : 0) - GAP);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const box = boxRef.current;
      if (!box) return;
      const x = e.clientX - box.getBoundingClientRect().left;
      if (drag === 'mid') {
        setLeftPct(clampPct((x / flexW) * 100));
      } else {
        // Cột lịch sử ở mép phải → bề rộng đo từ mép phải vào. Trừ đúng GAP để
        // mép trái cột lịch sử trùng con trỏ (grip đặt ở boxW - hist - GAP).
        setHist(clampHist(box.clientWidth - x - GAP));
      }
    };
    const stop = () => setDrag(null);
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
  }, [drag, flexW]);

  // Ghi lại khi thả chuột, không ghi từng frame lúc đang kéo.
  const wasDragging = useRef<'mid' | 'hist' | null>(null);
  useEffect(() => {
    if (drag) { wasDragging.current = drag; return; }
    if (!wasDragging.current) return;
    wasDragging.current = null;
    persist({});
  }, [drag, persist]);

  const style: CSSProperties = {
    position: 'relative',
    // Hai biến này lái grid-template-columns của .es-console.
    ['--es-con-left' as string]: `${leftPct.toFixed(2)}%`,
    ['--es-con-hist' as string]: `${Math.round(hist)}px`,
  };

  const midX = flexW * (leftPct / 100);
  const mid: ConsoleGrip | null = stacked ? null : {
    left: midX + (GAP - HIT) / 2,
    width: HIT,
    dragging: drag === 'mid',
    label: 'Kéo để đổi bề rộng editor / kết quả',
    value: Math.round(leftPct),
    min: MIN_PCT,
    max: MAX_PCT,
    onStart: () => setDrag('mid'),
    onNudge: (d) => setLeftPct((p) => { const n = clampPct(p + d); persist({ leftPct: n }); return n; }),
    onReset: () => { setLeftPct(DEFAULT_LEFT_PCT); persist({ leftPct: DEFAULT_LEFT_PCT }); },
  };

  const histGrip: ConsoleGrip | null = stacked || !histOpen ? null : {
    left: boxW - hist - GAP + (GAP - HIT) / 2,
    width: HIT,
    dragging: drag === 'hist',
    label: 'Kéo để đổi bề rộng cột lịch sử',
    value: Math.round(hist),
    min: HIST_MIN,
    max: HIST_MAX,
    onStart: () => setDrag('hist'),
    // Kéo sang phải = cột lịch sử HẸP đi, nên đảo dấu để ←/→ khớp với chuột.
    onNudge: (d) => setHist((w) => { const n = clampHist(w - d); persist({ hist: n }); return n; }),
    onReset: () => { setHist(DEFAULT_HIST); persist({ hist: DEFAULT_HIST }); },
  };

  return { ref, style, mid, hist: histGrip };
}
