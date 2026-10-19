'use client';

// Hộp "Bố cục trang": khổ giấy, hướng giấy và lề — những thứ người dùng văn phòng
// chỉnh nhiều nhất trước khi in. Áp cho section cuối của tài liệu (khổ mặc định của
// file). Nhập theo cm / mm như ở Việt Nam, đổi sang point lúc áp.

import { useMemo, useState } from 'react';
import type { PageSetup } from '@/lib/word';

const PT_PER_MM = 72 / 25.4;
const PT_PER_CM = PT_PER_MM * 10;

/** Khổ giấy phổ biến — mm, cạnh ngắn × cạnh dài. */
const SIZES: { key: string; label: string; w: number; h: number }[] = [
  { key: 'a4', label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  { key: 'a3', label: 'A3 (297 × 420 mm)', w: 297, h: 420 },
  { key: 'a5', label: 'A5 (148 × 210 mm)', w: 148, h: 210 },
  { key: 'letter', label: 'Letter (215,9 × 279,4 mm)', w: 215.9, h: 279.4 },
  { key: 'legal', label: 'Legal (215,9 × 355,6 mm)', w: 215.9, h: 355.6 },
];

/** Bộ lề dựng sẵn — cm [trên, dưới, trái, phải]. */
const MARGIN_PRESETS: { key: string; label: string; hint: string; m: [number, number, number, number] }[] = [
  { key: 'vn', label: 'Hành chính VN', hint: 'Trên 2 · Dưới 2 · Trái 3 · Phải 1,5 cm (thể thức văn bản hành chính)', m: [2, 2, 3, 1.5] },
  { key: 'normal', label: 'Bình thường (Word)', hint: '2,54 cm cả bốn phía', m: [2.54, 2.54, 2.54, 2.54] },
  { key: 'narrow', label: 'Hẹp', hint: '1,27 cm cả bốn phía', m: [1.27, 1.27, 1.27, 1.27] },
  { key: 'wide', label: 'Rộng', hint: 'Trên/dưới 2,54 · Trái/phải 5,08 cm', m: [2.54, 2.54, 5.08, 5.08] },
];

const r2 = (x: number) => Math.round(x * 100) / 100;
const roundPt = (x: number) => Math.round(x * 20) / 20; // bước 1 twip, khớp server

/** Đoán khổ giấy hiện tại từ kích thước (point), dung sai ~1,5pt. */
function sizeKeyOf(p: PageSetup): string {
  const short = Math.min(p.w, p.h) / PT_PER_MM;
  const long = Math.max(p.w, p.h) / PT_PER_MM;
  return SIZES.find((s) => Math.abs(s.w - short) < 0.6 && Math.abs(s.h - long) < 0.6)?.key ?? 'custom';
}

export default function WordPageSetupModal({ page, onApply, onClose }: {
  page: PageSetup;
  onApply: (p: PageSetup) => void;
  onClose: () => void;
}) {
  const [size, setSize] = useState(() => sizeKeyOf(page));
  const [landscape, setLandscape] = useState(!!page.landscape || page.w > page.h);
  // Kích thước tuỳ chỉnh (mm), theo cạnh ngắn × dài.
  const [cw, setCw] = useState(() => r2(Math.min(page.w, page.h) / PT_PER_MM));
  const [ch, setCh] = useState(() => r2(Math.max(page.w, page.h) / PT_PER_MM));
  const [mt, setMt] = useState(() => r2(page.mt / PT_PER_CM));
  const [mb, setMb] = useState(() => r2(page.mb / PT_PER_CM));
  const [ml, setMl] = useState(() => r2(page.ml / PT_PER_CM));
  const [mr, setMr] = useState(() => r2(page.mr / PT_PER_CM));

  const dims = useMemo(() => {
    const s = SIZES.find((x) => x.key === size);
    return s ? { short: s.w, long: s.h } : { short: Math.min(cw, ch), long: Math.max(cw, ch) };
  }, [size, cw, ch]);

  const next: PageSetup = useMemo(() => {
    const short = roundPt(dims.short * PT_PER_MM);
    const long = roundPt(dims.long * PT_PER_MM);
    return {
      w: landscape ? long : short,
      h: landscape ? short : long,
      mt: roundPt(mt * PT_CM), mb: roundPt(mb * PT_CM), ml: roundPt(ml * PT_CM), mr: roundPt(mr * PT_CM),
      ...(landscape ? { landscape: true } : {}),
    };
  }, [dims, landscape, mt, mb, ml, mr]);

  // Cùng luật với server (lib/wordClient · pageSetup): báo lỗi sớm, đúng chỗ.
  const error = useMemo(() => {
    if (![mt, mb, ml, mr].every((m) => Number.isFinite(m) && m >= 0 && m <= 25)) return 'Lề phải từ 0 đến 25 cm.';
    if (!(dims.short >= 36 && dims.long <= 1000)) return 'Khổ giấy tuỳ chỉnh phải từ 36 mm đến 1000 mm.';
    if (next.mt + next.mb > next.h - 36 || next.ml + next.mr > next.w - 36) return 'Lề quá lớn so với khổ giấy — phải còn ít nhất 1,3 cm cho nội dung.';
    return null;
  }, [mt, mb, ml, mr, dims, next]);

  const applyPreset = (m: [number, number, number, number]) => { setMt(m[0]); setMb(m[1]); setMl(m[2]); setMr(m[3]); };
  const num = (v: string) => (v === '' ? NaN : Number(v.replace(',', '.')));

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>📐 Bố cục trang</h3>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <div className="fc-form">
          <label className="fc-fld"><span>Khổ giấy</span>
            <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
              {SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              <option value="custom">Tuỳ chỉnh…</option>
            </select>
          </label>
          {size === 'custom' && (
            <div className="fc-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <label className="fc-fld"><span>Cạnh ngắn (mm)</span>
                <input className="input" type="number" step="0.1" value={cw} onChange={(e) => setCw(num(e.target.value))} /></label>
              <label className="fc-fld"><span>Cạnh dài (mm)</span>
                <input className="input" type="number" step="0.1" value={ch} onChange={(e) => setCh(num(e.target.value))} /></label>
            </div>
          )}

          <div className="fc-fld"><span>Hướng giấy</span>
            <div className="api-bodytype">
              <label><input type="radio" checked={!landscape} onChange={() => setLandscape(false)} /> ▯ Dọc</label>
              <label><input type="radio" checked={landscape} onChange={() => setLandscape(true)} /> ▭ Ngang</label>
            </div>
          </div>

          <div className="fc-fld"><span>Lề (cm)</span>
            <div className="fc-sugg" style={{ marginTop: 0, marginBottom: 4 }}>
              {MARGIN_PRESETS.map((p) => (
                <button key={p.key} type="button" className="chip-btn" title={p.hint} onClick={() => applyPreset(p.m)}>{p.label}</button>
              ))}
            </div>
            <div className="fc-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <label className="fc-fld"><span>Trên</span><input className="input" type="number" step="0.1" min="0" value={mt} onChange={(e) => setMt(num(e.target.value))} /></label>
              <label className="fc-fld"><span>Dưới</span><input className="input" type="number" step="0.1" min="0" value={mb} onChange={(e) => setMb(num(e.target.value))} /></label>
              <label className="fc-fld"><span>Trái</span><input className="input" type="number" step="0.1" min="0" value={ml} onChange={(e) => setMl(num(e.target.value))} /></label>
              <label className="fc-fld"><span>Phải</span><input className="input" type="number" step="0.1" min="0" value={mr} onChange={(e) => setMr(num(e.target.value))} /></label>
            </div>
          </div>

          <p className="small" style={{ color: 'var(--muted)', margin: 0 }}>
            Áp cho khổ mặc định của cả tài liệu (section cuối). Section khác trong file (nếu có) giữ nguyên.
          </p>
        </div>

        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{error}</pre>}
        <div className="fc-foot">
          <button className="sm" disabled={!!error} onClick={() => onApply(next)}>✓ Áp dụng</button>
          <button className="ghost sm" onClick={onClose}>Hủy</button>
        </div>
      </div>
    </div>
  );
}

const PT_CM = PT_PER_CM;
