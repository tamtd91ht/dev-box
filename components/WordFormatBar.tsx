'use client';

// Ribbon định dạng của Word workspace.
//
// Gồm những thứ một nhân viên văn phòng dùng khi soạn báo cáo: kiểu đoạn
// (Tiêu đề · Đề mục 1-3 · Văn bản), font (kiểu · cỡ · B I U S · màu chữ ·
// tô sáng), căn lề, giãn dòng, khoảng cách đoạn, thụt lề, danh sách
// (gạch đầu dòng / đánh số), chèn bảng · ngắt trang, và xóa định dạng.
//
// Component KHÔNG giữ nội dung tài liệu: nó chỉ đọc định dạng hiệu dụng của
// chỗ đang chọn (để nút nào đang bật thì sáng) rồi phát ra patch. Patch dùng
// ngữ nghĩa undefined=giữ / null=xóa nên bấm "đậm" không làm mất màu hay cỡ
// chữ sẵn có.

import { useEffect, useRef, useState } from 'react';
import type { ParaFormat, ParaFormatPatch, RunFormat, RunFormatPatch } from '@/lib/word';

const FONTS = [
  'Times New Roman', 'Arial', 'Calibri', 'Segoe UI', 'Tahoma',
  'Verdana', 'Cambria', 'Courier New', 'Roboto', 'Arial Narrow',
];
const SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48];

/** Kiểu đoạn — id là styleId thật trong file .docx. */
const PARA_STYLES: { v: string; label: string; hint: string }[] = [
  { v: 'Normal', label: 'Văn bản', hint: 'Đoạn văn thường' },
  { v: 'Title', label: 'Tiêu đề lớn', hint: 'Tên của cả văn bản' },
  { v: 'Subtitle', label: 'Tiêu đề phụ', hint: 'Dòng phụ dưới tiêu đề lớn' },
  { v: 'Heading1', label: 'Đề mục 1', hint: 'Mục cấp 1 — vào được mục lục' },
  { v: 'Heading2', label: 'Đề mục 2', hint: 'Mục cấp 2' },
  { v: 'Heading3', label: 'Đề mục 3', hint: 'Mục cấp 3' },
  { v: 'Heading4', label: 'Đề mục 4', hint: 'Mục cấp 4' },
  { v: 'Quote', label: 'Trích dẫn', hint: 'Đoạn trích, in nghiêng' },
  { v: 'Caption', label: 'Chú thích', hint: 'Chú thích cho ảnh / bảng' },
];

const LINE_SPACINGS = [
  { v: 1, label: '1,0' },
  { v: 1.15, label: '1,15' },
  { v: 1.3, label: '1,3' },
  { v: 1.5, label: '1,5' },
  { v: 2, label: '2,0' },
];

/** Bảng tô sáng của Word — chỉ dùng đúng tên Word chấp nhận. */
const HIGHLIGHTS: { v: string; label: string; css: string }[] = [
  { v: 'yellow', label: 'Vàng', css: '#ffff00' },
  { v: 'green', label: 'Xanh lá', css: '#00ff00' },
  { v: 'cyan', label: 'Xanh lơ', css: '#00ffff' },
  { v: 'magenta', label: 'Hồng', css: '#ff00ff' },
  { v: 'red', label: 'Đỏ', css: '#ff0000' },
  { v: 'blue', label: 'Xanh dương', css: '#0000ff' },
  { v: 'darkYellow', label: 'Vàng đậm', css: '#808000' },
  { v: 'lightGray', label: 'Xám nhạt', css: '#c0c0c0' },
];

/** Icon căn lề ngang: 4 gạch xếp theo mép trái/giữa/phải (như Word). */
function AlignIcon({ jc }: { jc: 'l' | 'c' | 'r' | 'j' }) {
  const runs = [11, 7, 10, 6];
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden focusable="false">
      {runs.map((run, i) => {
        const w = jc === 'j' ? 12 : run;
        const x = jc === 'r' ? 13 - w : jc === 'c' ? (14 - w) / 2 : 1;
        return <rect key={i} x={x} y={1 + i * 3} width={w} height="1.6" rx="0.8" fill="currentColor" />;
      })}
    </svg>
  );
}

export interface WordFormatBarProps {
  /** Định dạng chữ hiệu dụng ở chỗ đang chọn (đoạn hoặc cụm từ bôi đen). */
  run: RunFormat | undefined;
  /** Định dạng đoạn của đoạn đang chọn. */
  para: ParaFormat | undefined;
  /** Chưa chọn đoạn nào → khoá cả thanh. */
  disabled: boolean;
  /** Mô tả chỗ đang áp — dùng trong tooltip ("đoạn 3", "cụm từ đang chọn"). */
  targetLabel: string;
  /** Đang bôi đen một cụm từ (khác với chọn cả đoạn). */
  hasSelection: boolean;
  /** Đang chọn ô trong bảng → hiện nhóm nút bảng. */
  inTable: boolean;
  onRunFormat: (p: RunFormatPatch) => void;
  onParaFormat: (p: ParaFormatPatch) => void;
  onInsertTable: () => void;
  onPageBreak: () => void;
  /** Nhóm nút thao tác bảng (chỉ bật khi đang ở trong bảng). */
  onTableRow?: (dir: 'above' | 'below') => void;
  onTableRowDelete?: () => void;
  onTableCol?: (dir: 'left' | 'right') => void;
  onTableColDelete?: () => void;
  onTableBorder?: () => void;
}

export default function WordFormatBar({
  run, para, disabled, targetLabel, hasSelection, inTable,
  onRunFormat, onParaFormat, onInsertTable, onPageBreak,
  onTableRow, onTableRowDelete, onTableCol, onTableColDelete, onTableBorder,
}: WordFormatBarProps) {
  // Kéo trong bảng màu bắn ra hàng chục event — chỉ áp sau khi tay dừng lại.
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (colorTimer.current) clearTimeout(colorTimer.current); }, []);
  const pickColor = (v: string) => {
    if (colorTimer.current) clearTimeout(colorTimer.current);
    colorTimer.current = setTimeout(() => onRunFormat({ fc: v }), 120);
  };

  const [hlOpen, setHlOpen] = useState(false);
  const hlRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hlOpen) return;
    const away = (e: MouseEvent) => {
      if (!hlRef.current?.contains(e.target as Node)) setHlOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [hlOpen]);

  /** Giữ nguyên vùng bôi đen khi bấm nút trên ribbon. */
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const btn = (on: unknown) => `sheet-fmt-btn${on ? ' on' : ''}`;

  const toggle = (key: 'b' | 'i' | 'u' | 'st') => onRunFormat({ [key]: run?.[key] ? null : 1 } as RunFormatPatch);
  /** Bấm lại chính kiểu căn đang bật → bỏ căn, như Word. */
  const setJc = (v: 'l' | 'c' | 'r' | 'j') => onParaFormat({ jc: para?.jc === v ? null : v });
  const setList = (v: 'bullet' | 'number') => onParaFormat({ list: para?.list === v ? null : v });

  const style = para?.style ?? 'Normal';
  const styleKnown = PARA_STYLES.some((s) => s.v === style);
  const ls = para?.ls ?? 0;
  const indent = para?.il ?? 0;

  return (
    <div className="sheet-fmtbar word-fmtbar" role="toolbar" aria-label="Định dạng văn bản">
      {/* ── Kiểu đoạn ──────────────────────────────────────────────── */}
      <div className="sheet-fmt-group">
        <select
          className="sheet-fmt-select wstyle" disabled={disabled} value={styleKnown ? style : ''}
          onChange={(e) => onParaFormat({ style: e.target.value === 'Normal' ? null : e.target.value })}
          title={`Kiểu đoạn cho ${targetLabel} — Đề mục sẽ hiện trong mục lục`}
        >
          {PARA_STYLES.map((s) => <option key={s.v} value={s.v} title={s.hint}>{s.label}</option>)}
          {!styleKnown && <option value="">{`Của file: ${style}`}</option>}
        </select>
      </div>

      <span className="sheet-fmt-sep" aria-hidden />

      {/* ── Font ───────────────────────────────────────────────────── */}
      <div className="sheet-fmt-group">
        <select
          className="sheet-fmt-select font" disabled={disabled} value={run?.ff ?? 'Times New Roman'}
          onChange={(e) => onRunFormat({ ff: e.target.value })} title={`Kiểu chữ cho ${targetLabel}`}
        >
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
          {run?.ff && !FONTS.includes(run.ff) && <option value={run.ff}>{run.ff}</option>}
        </select>
        <select
          className="sheet-fmt-select size" disabled={disabled} value={run?.fs ?? 13}
          onChange={(e) => onRunFormat({ fs: Number(e.target.value) })} title={`Cỡ chữ cho ${targetLabel}`}
        >
          {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          {run?.fs && !SIZES.includes(run.fs) && <option value={run.fs}>{run.fs}</option>}
        </select>
        <button className={btn(run?.b)} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => toggle('b')} title="Đậm (Ctrl+B)"><b>B</b></button>
        <button className={btn(run?.i)} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => toggle('i')} title="Nghiêng (Ctrl+I)"><i>I</i></button>
        <button className={btn(run?.u)} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => toggle('u')} title="Gạch chân (Ctrl+U)"><u>U</u></button>
        <button className={btn(run?.st)} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => toggle('st')} title="Gạch ngang"><s>S</s></button>

        <label className={`sheet-fmt-color${disabled ? ' off' : ''}`} title={`Màu chữ cho ${targetLabel}`}>
          <span className="sheet-fmt-color-ico">A</span>
          <span className="sheet-fmt-color-bar" style={{ background: run?.fc ?? 'var(--text)' }} />
          <input type="color" disabled={disabled} key={`fc:${run?.fc ?? ''}`}
            defaultValue={run?.fc ?? '#1f2933'} onChange={(e) => pickColor(e.target.value)} />
        </label>
        <button className="sheet-fmt-btn tiny" disabled={disabled || !run?.fc} onMouseDown={keepFocus}
          onClick={() => onRunFormat({ fc: null })} title="Bỏ màu chữ (về mặc định)">⌫</button>

        <div className="sheet-fmt-dd" ref={hlRef}>
          <button className={`sheet-fmt-btn${run?.hl ? ' on' : ''}`} disabled={disabled} onMouseDown={keepFocus}
            onClick={() => setHlOpen((o) => !o)} title={`Tô sáng chữ cho ${targetLabel}`}>
            <span aria-hidden style={{ background: HIGHLIGHTS.find((h) => h.v === run?.hl)?.css ?? 'transparent', padding: '0 3px', borderRadius: 3 }}>🖍</span> ▾
          </button>
          {hlOpen && (
            <div className="sheet-fmt-menu word-hl-menu">
              {HIGHLIGHTS.map((h) => (
                <button key={h.v} onMouseDown={keepFocus}
                  onClick={() => { onRunFormat({ hl: h.v }); setHlOpen(false); }}>
                  <span className="word-hl-swatch" style={{ background: h.css }} aria-hidden /> {h.label}
                </button>
              ))}
              <button onMouseDown={keepFocus} onClick={() => { onRunFormat({ hl: null }); setHlOpen(false); }}>
                <span className="word-hl-swatch none" aria-hidden /> Bỏ tô sáng
              </button>
            </div>
          )}
        </div>
      </div>

      <span className="sheet-fmt-sep" aria-hidden />

      {/* ── Căn lề & giãn dòng ─────────────────────────────────────── */}
      <div className="sheet-fmt-group">
        {(['l', 'c', 'r', 'j'] as const).map((v) => (
          <button key={v} className={btn(para?.jc === v)} disabled={disabled} onMouseDown={keepFocus}
            onClick={() => setJc(v)}
            title={{ l: 'Căn trái', c: 'Căn giữa', r: 'Căn phải', j: 'Căn đều hai bên' }[v]}>
            <AlignIcon jc={v} />
          </button>
        ))}
        <select
          className="sheet-fmt-select ls" disabled={disabled} value={ls || ''}
          onChange={(e) => onParaFormat({ ls: e.target.value === '' ? null : Number(e.target.value) })}
          title={`Giãn dòng cho ${targetLabel}`}
        >
          <option value="">Giãn dòng</option>
          {LINE_SPACINGS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
        <button className="sheet-fmt-btn" disabled={disabled} onMouseDown={keepFocus}
          onClick={() => onParaFormat({ sa: Math.min(720, (para?.sa ?? 0) + 6) })}
          title="Thêm khoảng cách sau đoạn (+6pt)">⇕+</button>
        <button className="sheet-fmt-btn" disabled={disabled || !para?.sa} onMouseDown={keepFocus}
          onClick={() => onParaFormat({ sa: Math.max(0, (para?.sa ?? 0) - 6) || null })}
          title="Bớt khoảng cách sau đoạn (−6pt)">⇕−</button>
      </div>

      <span className="sheet-fmt-sep" aria-hidden />

      {/* ── Danh sách & thụt lề ────────────────────────────────────── */}
      <div className="sheet-fmt-group">
        <button className={btn(para?.list === 'bullet')} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => setList('bullet')} title="Danh sách gạch đầu dòng">☰•</button>
        <button className={btn(para?.list === 'number')} disabled={disabled} onMouseDown={keepFocus}
          onClick={() => setList('number')} title="Danh sách đánh số">☰1</button>
        <button className="sheet-fmt-btn" disabled={disabled || indent <= 0} onMouseDown={keepFocus}
          onClick={() => onParaFormat({ il: Math.max(0, indent - 18) || null })}
          title="Giảm thụt lề trái">⇤</button>
        <button className="sheet-fmt-btn" disabled={disabled} onMouseDown={keepFocus}
          onClick={() => onParaFormat({ il: Math.min(720, indent + 18) })}
          title="Tăng thụt lề trái">⇥</button>
        <button className="sheet-fmt-btn" disabled={disabled} onMouseDown={keepFocus}
          onClick={() => onParaFormat({ ifl: para?.ifl ? null : 18 })}
          title="Thụt dòng đầu tiên của đoạn (1cm)">↦</button>
      </div>

      <span className="sheet-fmt-sep" aria-hidden />

      {/* ── Chèn ───────────────────────────────────────────────────── */}
      <div className="sheet-fmt-group">
        <button className="sheet-fmt-btn" disabled={disabled} onMouseDown={keepFocus}
          onClick={onInsertTable} title="Chèn bảng mới ngay dưới đoạn đang chọn">
          <span aria-hidden>▦</span> Bảng
        </button>
        <button className="sheet-fmt-btn" disabled={disabled} onMouseDown={keepFocus}
          onClick={onPageBreak} title="Chèn ngắt trang — phần sau sẽ sang trang mới">
          <span aria-hidden>⤓</span> Ngắt trang
        </button>
      </div>

      {inTable && (
        <>
          <span className="sheet-fmt-sep" aria-hidden />
          <div className="sheet-fmt-group">
            <button className="sheet-fmt-btn" onMouseDown={keepFocus}
              onClick={() => onTableRow?.('above')} title="Chèn dòng lên trên ô đang chọn">
              <span aria-hidden>⤒</span> Dòng
            </button>
            <button className="sheet-fmt-btn" onMouseDown={keepFocus}
              onClick={() => onTableRow?.('below')} title="Chèn dòng xuống dưới ô đang chọn">
              <span aria-hidden>⤓</span> Dòng
            </button>
            <button className="sheet-fmt-btn danger" onMouseDown={keepFocus}
              onClick={onTableRowDelete} title="Xóa dòng đang chọn">
              <span aria-hidden>✕</span> Dòng
            </button>
            <button className="sheet-fmt-btn" onMouseDown={keepFocus}
              onClick={() => onTableCol?.('left')} title="Chèn cột sang bên trái">
              <span aria-hidden>⇤</span> Cột
            </button>
            <button className="sheet-fmt-btn" onMouseDown={keepFocus}
              onClick={() => onTableCol?.('right')} title="Chèn cột sang bên phải">
              <span aria-hidden>⇥</span> Cột
            </button>
            <button className="sheet-fmt-btn danger" onMouseDown={keepFocus}
              onClick={onTableColDelete} title="Xóa cột đang chọn">
              <span aria-hidden>✕</span> Cột
            </button>
            <button className="sheet-fmt-btn" onMouseDown={keepFocus}
              onClick={onTableBorder} title="Bật / tắt đường kẻ của bảng">
              <span aria-hidden>▦</span> Viền
            </button>
          </div>
        </>
      )}

      <span className="sheet-fmt-sep" aria-hidden />

      <div className="sheet-fmt-group">
        <button className="sheet-fmt-btn danger" disabled={disabled} onMouseDown={keepFocus}
          onClick={() => { onRunFormat({ clear: 1 }); onParaFormat({ clear: 1 }); }}
          title={`Xóa toàn bộ định dạng của ${targetLabel} (giữ nguyên nội dung)`}>
          <span aria-hidden>🧹</span> Xóa định dạng
        </button>
        {hasSelection && <span className="word-fmt-hint">áp cho cụm từ đang bôi đen</span>}
      </div>
    </div>
  );
}
