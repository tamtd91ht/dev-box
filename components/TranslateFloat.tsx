'use client';

// Dịch nhanh — vỏ NỔI cho bản desktop. Trang này (app/translate-float) chạy
// trong một WebContentsView riêng mà main process đặt chồng lên cửa sổ, đúng
// bằng phần đang vẽ: thu gọn thì chỉ cái chấm, mở ra thì chấm + bảng. Ngoài
// khung đó cửa sổ vẫn là của view bên dưới — đang chat Zalo vẫn bấm vào ô chat
// và gõ bình thường, bảng dịch vẫn nằm đó, rê chuột vào là dùng tiếp được.
// Bảng chỉ ẩn khi bấm "— Thu gọn" hoặc Ctrl+Shift+Y (xem attachTranslateFloat
// trong electron/main.cjs).
//
// Mở bảng thì ẨN chấm: view là hình chữ nhật, giữ chấm cạnh bảng thì dải trống
// bên cạnh chấm (trong suốt nhưng vẫn là view) sẽ chặn chuột của Zalo bên
// dưới. Bảng mở đúng tại góc của chấm; kéo bảng bằng chỗ trống trên thanh tiêu đề.
//
// Trang tự đo kích thước phần đang vẽ và báo lên (tf:size); main đặt view theo
// góc của chấm và báo lại hướng bung (flipX/flipY) khi chấm bị kéo sang nửa
// trái/trên cửa sổ. Kéo: gửi độ dời theo toạ độ MÀN HÌNH, vì cả view chạy theo
// con trỏ nên toạ độ trong trang không dùng được.

import { useCallback, useEffect, useRef, useState } from 'react';
import TranslatePanel from '@/components/translate/TranslatePanel';
import { DEFAULT_PAIRS, shortLang, type LangPair } from '@/lib/translate';
import type { TranslateFloatState } from '@/lib/workspace/types';

const POS_KEY = 'qtrans.float.pos';
/** Khoảng đệm quanh nội dung cho bóng đổ — khớp `padding` của .tf-wrap. */
const PAD = 7;

export default function TranslateFloat() {
  const [st, setSt] = useState<TranslateFloatState>({ open: false, flipX: false, flipY: false, maxW: 0, maxH: 0 });
  const [pair, setPair] = useState<LangPair>(DEFAULT_PAIRS[0]);
  const [prefill, setPrefill] = useState<{ text: string; n: number } | undefined>();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const api = typeof window === 'undefined' ? undefined : window.workspace?.translateFloat;

  // Nền trong suốt: view của main có nền #0000, trang cũng phải trong suốt thì
  // bóng đổ / bo góc mới không ra khung chữ nhật.
  useEffect(() => {
    document.documentElement.classList.add('tf-page');
    return () => document.documentElement.classList.remove('tf-page');
  }, []);

  // Theme đổi ở trang chính (localStorage chung origin) → đổi theo ngay.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'apitester.theme' && e.newValue) document.documentElement.setAttribute('data-theme', e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!api) return;
    let pos: { right: number; bottom: number } | undefined;
    try {
      const p = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null') as { right?: number; bottom?: number } | null;
      if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) pos = { right: Number(p.right), bottom: Number(p.bottom) };
    } catch { /* nicety */ }
    void api.init(pos).then((s) => { if (s) setSt(s); });
    return api.onState((s) => {
      setSt({ open: s.open, flipX: s.flipX, flipY: s.flipY, maxW: s.maxW, maxH: s.maxH });
      if (s.prefill) setPrefill((p) => ({ text: s.prefill!, n: (p?.n ?? 0) + 1 }));
    });
  }, [api]);

  // Báo kích thước phần đang vẽ mỗi khi nó đổi (gõ dài, mở gợi ý, "Xem thêm"…).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !api) return;
    const report = () => api.setSize(el.offsetWidth, el.offsetHeight);
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [api]);

  const setOpen = useCallback((open: boolean) => {
    setSt((s) => ({ ...s, open }));
    api?.setOpen(open);
  }, [api]);

  // ── Kéo (chấm, hoặc chỗ trống trên thanh tiêu đề của bảng) ──────────────────
  const drag = useRef<{ sx: number; sy: number; moved: boolean; dot: boolean } | null>(null);
  const startDrag = (e: React.PointerEvent<HTMLElement>, dot: boolean) => {
    drag.current = { sx: e.screenX, sy: e.screenY, moved: false, dot };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDotDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button === 0) startDrag(e, true);
  };
  /** Nắm thanh tiêu đề: chỉ chỗ trống — bấm chip / nút trên đó vẫn là bấm. */
  const onWrapDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || !t.closest('.qtr-head') || t.closest('button, select, input, textarea')) return;
    startDrag(e, false);
  };
  const onDotMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !api) return;
    const dx = e.screenX - d.sx;
    const dy = e.screenY - d.sy;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      api.dragStart();
    }
    api.dragMove(dx, dy);
  };
  const onDotUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      void api?.dragEnd().then((p) => {
        if (p) try { window.localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* nicety */ }
      });
    } else if (d.dot) setOpen(!st.open);
  };

  const dot = (
    <button
      className={`qtr-dot tf-dot${st.open ? ' on' : ''}`}
      title={st.open ? 'Thu gọn (Ctrl+Shift+Y) — kéo để dời chỗ' : 'Dịch nhanh (Ctrl+Shift+Y) — kéo để dời chỗ'}
      aria-label="Dịch nhanh"
      aria-expanded={st.open}
      // move / up / cancel nổi lên .tf-wrap xử lý chung với kéo thanh tiêu đề.
      onPointerDown={onDotDown}
    >
      <span aria-hidden>文</span>
      <span className="qtr-dot-pair" aria-hidden>{shortLang(pair.from)}→{shortLang(pair.to)}</span>
    </button>
  );

  return (
    <div className={`tf-root${st.flipX ? ' flip-x' : ''}${st.flipY ? ' flip-y' : ''}`}>
      <div
        className="tf-wrap"
        ref={wrapRef}
        style={{ padding: PAD }}
        onPointerDown={onWrapDown}
        onPointerMove={onDotMove}
        onPointerUp={onDotUp}
        onPointerCancel={() => { drag.current = null; }}
      >
        <TranslatePanel
          open={st.open}
          onCollapse={() => setOpen(false)}
          prefill={prefill}
          onPairChange={setPair}
          className="tf-panel"
          // Bảng không to hơn khung cửa sổ (chừa chỗ cho chấm + đệm). Không dùng
          // 100vw/100vh trong CSS: viewport của view CHÍNH LÀ kích thước bảng.
          style={st.maxW ? { maxWidth: st.maxW - 2 * PAD - 8, maxHeight: st.maxH - 2 * PAD - 60 } : undefined}
        />
        {!st.open && dot}
      </div>
    </div>
  );
}
