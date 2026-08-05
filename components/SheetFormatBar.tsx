'use client';

// Ribbon định dạng của Sheet workspace (chỉ .xlsx — CSV không có style).
//
// Chỉ gồm những thứ một user Excel dùng hằng ngày: chèn/xóa dòng-cột, font
// (kiểu · cỡ · B I U S · màu chữ · màu nền · viền), căn lề (ngang · dọc · wrap),
// định dạng số (numFmt + thêm/bớt thập phân), trộn ô, xóa định dạng.
//
// Component này KHÔNG giữ state của bảng tính: nó chỉ đọc `style` (style hiệu
// dụng của ô đang chọn — để nút nào đang bật thì sáng) và phát ra StylePatch.
// Patch dùng ngữ nghĩa undefined=giữ / null=xóa nên bấm "đậm" không làm mất
// màu hay cỡ chữ sẵn có của ô.

import { useEffect, useRef, useState } from 'react';
import { adjustDecimals } from '@/lib/numFmt';
import type { BorderPreset, StylePatch, WireStyle } from '@/lib/sheet';

const FONTS = [
  'Calibri', 'Arial', 'Times New Roman', 'Segoe UI', 'Tahoma',
  'Verdana', 'Courier New', 'Consolas', 'Cambria', 'Roboto',
];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 36, 48];

const NUM_FORMATS: { v: string; label: string }[] = [
  { v: '', label: 'Chung' },
  { v: '#,##0', label: 'Số  1,234' },
  { v: '#,##0.00', label: 'Số  1,234.00' },
  { v: '#,##0 "₫"', label: 'Tiền  1,234 ₫' },
  { v: '$#,##0.00', label: 'Tiền  $1,234.00' },
  { v: '0%', label: 'Phần trăm  12%' },
  { v: '0.00%', label: 'Phần trăm  12.34%' },
  { v: 'dd/mm/yyyy', label: 'Ngày  31/12/2026' },
  { v: 'dd/mm/yyyy hh:mm', label: 'Ngày giờ' },
  { v: 'hh:mm:ss', label: 'Giờ  13:45:00' },
  { v: '@', label: 'Văn bản' },
];

const BORDERS: { v: BorderPreset; label: string }[] = [
  { v: 'all', label: 'Tất cả các ô' },
  { v: 'outer', label: 'Viền ngoài vùng' },
  { v: 'top', label: 'Cạnh trên' },
  { v: 'bottom', label: 'Cạnh dưới' },
  { v: 'left', label: 'Cạnh trái' },
  { v: 'right', label: 'Cạnh phải' },
  { v: 'none', label: 'Bỏ hết viền' },
];

/** Icon căn lề ngang: 4 gạch xếp theo mép trái/giữa/phải (như Excel). */
function AlignIcon({ ha }: { ha: 'l' | 'c' | 'r' | 'j' }) {
  const runs = [11, 7, 10, 6];
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden focusable="false">
      {runs.map((run, i) => {
        const w = ha === 'j' ? 12 : run;
        const x = ha === 'r' ? 13 - w : ha === 'c' ? (14 - w) / 2 : 1;
        return <rect key={i} x={x} y={1 + i * 3} width={w} height="1.6" rx="0.8" fill="currentColor" />;
      })}
    </svg>
  );
}

/** Icon căn lề dọc: hai gạch nằm sát mép trên/giữa/dưới của khung ô. */
function VAlignIcon({ va }: { va: 't' | 'm' | 'b' }) {
  const y = va === 't' ? 2 : va === 'm' ? 4.4 : 6.8;
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden focusable="false">
      <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="1.6" fill="none" stroke="currentColor" strokeOpacity="0.35" />
      <rect x="3" y={y} width="8" height="1.5" rx="0.75" fill="currentColor" />
      <rect x="3" y={y + 2.2} width="5" height="1.5" rx="0.75" fill="currentColor" />
    </svg>
  );
}

export interface SheetFormatBarProps {
  /** Style hiệu dụng của ô đang chọn — quyết định nút nào đang "bật". */
  style: WireStyle | undefined;
  /** Chưa chọn ô nào → khoá cả thanh. */
  disabled: boolean;
  /** "A1" hoặc "A1:C5" — dùng trong tooltip cho rõ đang áp vào đâu. */
  rangeLabel: string;
  canMerge: boolean;
  canUnmerge: boolean;
  canDeleteRow: boolean;
  canDeleteCol: boolean;
  /** Số dòng/cột vùng chọn đang phủ — nút chèn/xóa làm đúng số đó (như Excel). */
  rowSpan: number;
  colSpan: number;
  onFormat: (p: StylePatch) => void;
  onMerge: () => void;
  onUnmerge: () => void;
  onInsertRow: (dir: 'above' | 'below') => void;
  onDeleteRow: () => void;
  onInsertCol: (dir: 'left' | 'right') => void;
  onDeleteCol: () => void;
}

export default function SheetFormatBar({
  style, disabled, rangeLabel, canMerge, canUnmerge, canDeleteRow, canDeleteCol,
  rowSpan, colSpan, onFormat, onMerge, onUnmerge,
  onInsertRow, onDeleteRow, onInsertCol, onDeleteCol,
}: SheetFormatBarProps) {
  // Kéo trong bảng màu bắn ra hàng chục event — chỉ áp sau khi tay dừng lại.
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (colorTimer.current) clearTimeout(colorTimer.current); }, []);
  const pickColor = (key: 'fc' | 'bg', v: string) => {
    if (colorTimer.current) clearTimeout(colorTimer.current);
    colorTimer.current = setTimeout(() => onFormat({ [key]: v } as StylePatch), 120);
  };

  const [bdOpen, setBdOpen] = useState(false);
  const bdRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!bdOpen) return;
    const away = (e: MouseEvent) => {
      if (!bdRef.current?.contains(e.target as Node)) setBdOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [bdOpen]);

  const nf = style?.nf ?? '';
  const nfKnown = NUM_FORMATS.some((f) => f.v === nf);
  const decUp = adjustDecimals(nf, 1);
  const decDown = adjustDecimals(nf, -1);

  /** Nút toggle: bấm lần nữa là tắt (null = xóa thuộc tính). */
  const toggle = (key: 'b' | 'i' | 'u' | 'st' | 'wr') => onFormat({ [key]: style?.[key] ? null : 1 } as StylePatch);
  /** Bấm lại chính kiểu căn đang bật → bỏ căn, như Excel. */
  const setHa = (v: 'l' | 'c' | 'r' | 'j') => onFormat({ ha: style?.ha === v ? null : v });
  const setVa = (v: 't' | 'm' | 'b') => onFormat({ va: style?.va === v ? null : v });

  // Giữ focus ở lưới khi bấm nút (để mũi tên/gõ tiếp tục chạy trên ô).
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const btn = (on: unknown) => `sheet-fmt-btn${on ? ' on' : ''}`;

  return (
    <div className="sheet-fmtbar" role="toolbar" aria-label="Định dạng">
      {/* ── Dòng & cột ─────────────────────────────────────────────── */}
      <div className="sheet-fmt-group">
        <button className="sheet-fmt-btn" disabled={disabled} onMouseDown={keepFocus}
          onClick={() => onInsertRow('above')}
          title={`Chèn ${rowSpan > 1 ? `${rowSpan} dòng` : 'dòng'} LÊN TRÊN dòng hiện tại`}>
          <span aria-hidden>⤒</span> Dòng
        </button>
        <button className="sheet-fmt-btn" disabled={disabled} onMouseDown={keepFocus}
          onClick={() => onInsertRow('below')}
          title={`Chèn ${rowSpan > 1 ? `${rowSpan} dòng` : 'dòng'} XUỐNG DƯỚI dòng hiện tại`}>
          <span aria-hidden>⤓</span> Dòng
        </button>
        <button className="sheet-fmt-btn danger" disabled={disabled || !canDeleteRow} onMouseDown={keepFocus}
          onClick={onDeleteRow} title={`Xóa ${rowSpan > 1 ? `${rowSpan} dòng` : 'dòng'} hiện tại`}>
          <span aria-hidden>✕</span> Dòng
        </button>
        <button className="sheet-fmt-btn" disabled={disabled} onMouseDown={keepFocus}
          onClick={() => onInsertCol('left')}
          title={`Chèn ${colSpan > 1 ? `${colSpan} cột` : 'cột'} sang BÊN TRÁI cột hiện tại`}>
          <span aria-hidden>⇤</span> Cột
        </button>
        <button className="sheet-fmt-btn" disabled={disabled} onMouseDown={keepFocus}
          onClick={() => onInsertCol('right')}
          title={`Chèn ${colSpan > 1 ? `${colSpan} cột` : 'cột'} sang BÊN PHẢI cột hiện tại`}>
          <span aria-hidden>⇥</span> Cột
        </button>
        <button className="sheet-fmt-btn danger" disabled={disabled || !canDeleteCol} onMouseDown={keepFocus}
          onClick={onDeleteCol} title={`Xóa ${colSpan > 1 ? `${colSpan} cột` : 'cột'} hiện tại`}>
          <span aria-hidden>✕</span> Cột
        </button>
      </div>

      <span className="sheet-fmt-sep" aria-hidden />

      {/* ── Font ───────────────────────────────────────────────────── */}
      <div className="sheet-fmt-group">
        <select
          className="sheet-fmt-select font" disabled={disabled} value={style?.ff ?? 'Calibri'}
          onChange={(e) => onFormat({ ff: e.target.value })} title={`Kiểu chữ cho ${rangeLabel}`}
        >
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
          {style?.ff && !FONTS.includes(style.ff) && <option value={style.ff}>{style.ff}</option>}
        </select>
        <select
          className="sheet-fmt-select size" disabled={disabled} value={style?.fs ?? 11}
          onChange={(e) => onFormat({ fs: Number(e.target.value) })} title={`Cỡ chữ cho ${rangeLabel}`}
        >
          {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          {style?.fs && !SIZES.includes(style.fs) && <option value={style.fs}>{style.fs}</option>}
        </select>
        <button className={btn(style?.b)} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => toggle('b')} title="Đậm (Ctrl+B)"><b>B</b></button>
        <button className={btn(style?.i)} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => toggle('i')} title="Nghiêng (Ctrl+I)"><i>I</i></button>
        <button className={btn(style?.u)} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => toggle('u')} title="Gạch chân (Ctrl+U)"><u>U</u></button>
        <button className={btn(style?.st)} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => toggle('st')} title="Gạch ngang"><s>S</s></button>

        <label className={`sheet-fmt-color${disabled ? ' off' : ''}`} title={`Màu chữ cho ${rangeLabel}`}>
          <span className="sheet-fmt-color-ico">A</span>
          <span className="sheet-fmt-color-bar" style={{ background: style?.fc ?? 'var(--text)' }} />
          <input type="color" disabled={disabled} key={`fc:${style?.fc ?? ''}`}
            defaultValue={style?.fc ?? '#1f2933'} onChange={(e) => pickColor('fc', e.target.value)} />
        </label>
        <button className="sheet-fmt-btn tiny" disabled={disabled || !style?.fc} onMouseDown={keepFocus}
          onClick={() => onFormat({ fc: null })} title="Bỏ màu chữ (về mặc định)">⌫</button>

        <label className={`sheet-fmt-color${disabled ? ' off' : ''}`} title={`Màu nền ô cho ${rangeLabel}`}>
          <span className="sheet-fmt-color-ico">▩</span>
          <span className="sheet-fmt-color-bar" style={{ background: style?.bg ?? 'transparent' }} />
          <input type="color" disabled={disabled} key={`bg:${style?.bg ?? ''}`}
            defaultValue={style?.bg ?? '#ffff00'} onChange={(e) => pickColor('bg', e.target.value)} />
        </label>
        <button className="sheet-fmt-btn tiny" disabled={disabled || !style?.bg} onMouseDown={keepFocus}
          onClick={() => onFormat({ bg: null })} title="Bỏ màu nền">⌫</button>

        <div className="sheet-fmt-dd" ref={bdRef}>
          <button className={`sheet-fmt-btn${bdOpen ? ' on' : ''}`} disabled={disabled} onMouseDown={keepFocus}
            onClick={() => setBdOpen((o) => !o)} title={`Kẻ viền cho ${rangeLabel}`}>
            <span aria-hidden>▦</span> Viền ▾
          </button>
          {bdOpen && (
            <div className="sheet-fmt-menu">
              {BORDERS.map((b) => (
                <button key={b.v} onMouseDown={keepFocus}
                  onClick={() => { onFormat({ bd: b.v }); setBdOpen(false); }}>
                  {b.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <span className="sheet-fmt-sep" aria-hidden />

      {/* ── Căn lề ─────────────────────────────────────────────────── */}
      <div className="sheet-fmt-group">
        {(['l', 'c', 'r', 'j'] as const).map((v) => (
          <button key={v} className={btn(style?.ha === v)} disabled={disabled} onMouseDown={keepFocus}
            onClick={() => setHa(v)}
            title={{ l: 'Căn trái', c: 'Căn giữa', r: 'Căn phải', j: 'Căn đều hai bên' }[v]}>
            <AlignIcon ha={v} />
          </button>
        ))}
        {(['t', 'm', 'b'] as const).map((v) => (
          <button key={v} className={btn(style?.va === v)} disabled={disabled} onMouseDown={keepFocus}
            onClick={() => setVa(v)}
            title={{ t: 'Căn trên', m: 'Căn giữa theo chiều dọc', b: 'Căn dưới' }[v]}>
            <VAlignIcon va={v} />
          </button>
        ))}
        <button className={btn(style?.wr)} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => toggle('wr')} title="Xuống dòng trong ô (wrap text)">
          <span aria-hidden>↵</span>
        </button>
      </div>

      <span className="sheet-fmt-sep" aria-hidden />

      {/* ── Định dạng số ───────────────────────────────────────────── */}
      <div className="sheet-fmt-group">
        <select
          className="sheet-fmt-select nf" disabled={disabled} value={nf}
          onChange={(e) => onFormat({ nf: e.target.value === '' ? null : e.target.value })}
          title={`Định dạng số cho ${rangeLabel}`}
        >
          {NUM_FORMATS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
          {!nfKnown && <option value={nf}>{`Của file: ${nf}`}</option>}
        </select>
        <button className="sheet-fmt-btn" disabled={disabled || !decDown} onMouseDown={keepFocus}
          onClick={() => decDown && onFormat({ nf: decDown })} title="Bớt một số thập phân">.0<span aria-hidden>←</span></button>
        <button className="sheet-fmt-btn" disabled={disabled || !decUp} onMouseDown={keepFocus}
          onClick={() => decUp && onFormat({ nf: decUp })} title="Thêm một số thập phân">.00<span aria-hidden>→</span></button>
      </div>

      <span className="sheet-fmt-sep" aria-hidden />

      {/* ── Trộn ô & xóa định dạng ─────────────────────────────────── */}
      <div className="sheet-fmt-group">
        <button className="sheet-fmt-btn" disabled={disabled || !canMerge} onMouseDown={keepFocus}
          onClick={onMerge}
          title={canMerge ? `Trộn ${rangeLabel} thành một ô và căn giữa` : 'Chọn từ 2 ô trở lên để trộn'}>
          <span aria-hidden>⿴</span> Trộn &amp; giữa
        </button>
        <button className="sheet-fmt-btn" disabled={disabled || !canUnmerge} onMouseDown={keepFocus}
          onClick={onUnmerge} title={canUnmerge ? 'Bỏ trộn các ô trong vùng chọn' : 'Vùng chọn không có ô nào đang trộn'}>
          <span aria-hidden>⿲</span> Bỏ trộn
        </button>
        <button className="sheet-fmt-btn danger" disabled={disabled} onMouseDown={keepFocus}
          onClick={() => onFormat({ clear: 1 })} title={`Xóa toàn bộ định dạng của ${rangeLabel} (giữ nội dung)`}>
          <span aria-hidden>🧹</span> Xóa định dạng
        </button>
      </div>
    </div>
  );
}
