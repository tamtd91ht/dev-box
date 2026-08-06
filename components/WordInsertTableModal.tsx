'use client';

// Hộp thoại chèn bảng: chọn số dòng/cột bằng lưới rê chuột (như Word) hoặc
// gõ số trực tiếp, kèm tuỳ chọn "dòng đầu là tiêu đề" — dòng tiêu đề được in
// đậm, tô nền nhạt và lặp lại ở đầu mỗi trang khi in.

import { useEffect, useState } from 'react';

const MAX_R = 10;
const MAX_C = 8;

export interface WordInsertTableModalProps {
  onInsert: (rows: number, cols: number, header: boolean) => void;
  onClose: () => void;
}

export default function WordInsertTableModal({ onInsert, onClose }: WordInsertTableModalProps) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const [header, setHeader] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter') onInsert(rows, cols, header);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cols, header, onInsert, onClose]);

  const shownR = hover?.r ?? rows;
  const shownC = hover?.c ?? cols;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(420px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>▦ Chèn bảng</h3>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <div
          className="word-tblpick"
          onMouseLeave={() => setHover(null)}
          role="grid"
          aria-label="Chọn kích thước bảng"
        >
          {Array.from({ length: MAX_R }, (_, r) => (
            <div key={r} className="word-tblpick-row">
              {Array.from({ length: MAX_C }, (_, c) => (
                <button
                  key={c}
                  type="button"
                  className={`word-tblpick-cell${r < shownR && c < shownC ? ' on' : ''}`}
                  onMouseEnter={() => setHover({ r: r + 1, c: c + 1 })}
                  onClick={() => { setRows(r + 1); setCols(c + 1); onInsert(r + 1, c + 1, header); }}
                  aria-label={`${r + 1} dòng ${c + 1} cột`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="small" style={{ textAlign: 'center', color: 'var(--muted)', margin: '6px 0 10px' }}>
          {shownR} dòng × {shownC} cột
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Dòng
            <input
              type="number" min={1} max={200} value={rows} style={{ width: 70 }}
              onChange={(e) => setRows(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
            />
          </label>
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Cột
            <input
              type="number" min={1} max={30} value={cols} style={{ width: 70 }}
              onChange={(e) => setCols(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
            />
          </label>
        </div>

        <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 }}>
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
          Dòng đầu là tiêu đề (in đậm, nền nhạt, lặp lại mỗi trang khi in)
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="ghost sm" onClick={onClose}>Hủy</button>
          <button className="sm" onClick={() => onInsert(rows, cols, header)}>
            ▦ Chèn bảng {rows}×{cols}
          </button>
        </div>
      </div>
    </div>
  );
}
