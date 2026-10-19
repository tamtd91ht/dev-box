'use client';

// Dịch nhanh — vỏ CHẠY TRONG TRANG, chỉ dùng khi mở DevBox bằng trình duyệt
// thường (mount cạnh StockTickerHost trong page.tsx).
//
// Bản desktop KHÔNG dùng vỏ này: <webview> (Zalo, Browser…) vẽ ở tầng native,
// đè mọi HTML, nên chấm + bảng vẽ trong trang sẽ bị che, còn muốn nổi lên thì
// phải đẩy cả webview đi — đang chat mà mở bảng dịch là mất khung chat. Desktop
// dùng WebContentsView riêng nổi trên cửa sổ (components/TranslateFloat.tsx +
// attachTranslateFloat trong electron/main.cjs), ở đây nhận ra điều đó qua
// window.workspace.translateFloat và không vẽ gì.
//
// Phần bảng (dịch, gợi ý, đọc, xem thêm) dùng chung: components/translate/TranslatePanel.tsx.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import TranslatePanel from '@/components/translate/TranslatePanel';
import { DEFAULT_PAIRS, shortLang, type LangPair } from '@/lib/translate';

const POS_KEY = 'qtrans.dot';
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export default function QuickTranslate() {
  /** null = chưa biết (SSR / chưa mount) · true = desktop có view nổi riêng. */
  const [floatHost, setFloatHost] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [pair, setPair] = useState<LangPair>(DEFAULT_PAIRS[0]);
  const [prefill, setPrefill] = useState<{ text: string; n: number } | undefined>();
  /** Khoảng cách chấm tới mép PHẢI / DƯỚI — đổi kích thước cửa sổ vẫn bám góc. */
  const [pos, setPos] = useState({ right: 22, bottom: 64 });

  useEffect(() => {
    setFloatHost(!!window.workspace?.translateFloat);
    try {
      const p = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null') as { right?: number; bottom?: number } | null;
      if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) setPos({ right: Number(p.right), bottom: Number(p.bottom) });
    } catch { /* nicety */ }
  }, []);

  const toggle = useCallback(() => {
    setOpen((v) => {
      if (!v) {
        // Chữ đang bôi đen trong trang → điền sẵn.
        const sel = window.getSelection()?.toString().trim() ?? '';
        if (sel && sel.length <= 2000) setPrefill((p) => ({ text: sel, n: (p?.n ?? 0) + 1 }));
      }
      return !v;
    });
  }, []);

  useEffect(() => {
    if (floatHost !== false) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyY') { e.preventDefault(); toggle(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [floatHost, toggle]);

  // ── Kéo chấm ────────────────────────────────────────────────────────────────
  const drag = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null);
  const onDotDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDotMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setPos({
      right: clamp(d.right - dx, 4, window.innerWidth - 40),
      bottom: clamp(d.bottom - dy, 4, window.innerHeight - 40),
    });
  };
  const onDotUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      try { window.localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* nicety */ }
    } else toggle();
  };

  /** Bảng mở về PHÍA TRONG màn hình tính từ chấm. */
  const panelStyle = useMemo((): CSSProperties => {
    const vw = typeof window === 'undefined' ? 1600 : window.innerWidth;
    const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
    const s: CSSProperties = { position: 'fixed' };
    if (pos.right < vw / 2) s.right = pos.right; else s.left = vw - pos.right - 34;
    if (pos.bottom < vh / 2) s.bottom = pos.bottom + 44; else s.top = vh - pos.bottom + 6;
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tính lại khi mở / dời chấm
  }, [pos.right, pos.bottom, open]);

  if (floatHost !== false) return null;

  return (
    <>
      <button
        className={`qtr-dot${open ? ' on' : ''}`}
        style={{ position: 'fixed', right: pos.right, bottom: pos.bottom }}
        title="Dịch nhanh (Ctrl+Shift+Y) — kéo để dời chỗ"
        aria-label="Dịch nhanh"
        aria-expanded={open}
        // Không cho chấm giành focus — focus phải vào ô nhập của bảng vừa mở.
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={onDotDown}
        onPointerMove={onDotMove}
        onPointerUp={onDotUp}
        onPointerCancel={() => { drag.current = null; }}
      >
        <span aria-hidden>文</span>
        <span className="qtr-dot-pair" aria-hidden>{shortLang(pair.from)}→{shortLang(pair.to)}</span>
      </button>
      <TranslatePanel
        open={open}
        onCollapse={() => setOpen(false)}
        prefill={prefill}
        onPairChange={setPair}
        style={panelStyle}
      />
    </>
  );
}
