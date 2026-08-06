'use client';

// Hộp thoại đặt đầu trang / chân trang.
//
// Giữ đúng phạm vi một nhân viên văn phòng cần: một dòng chữ, chọn căn lề,
// và tuỳ chọn chèn SỐ TRANG tự động (field PAGE của Word — Word tự đánh số
// khi in, không phải số cứng). Áp cho section mặc định của tài liệu.

import { useEffect, useState } from 'react';
import type { HeaderFooter } from '@/lib/word';
import { runsText } from '@/lib/word';

export interface WordHeaderFooterModalProps {
  part: 'header' | 'footer';
  current?: HeaderFooter;
  onApply: (text: string, jc: 'l' | 'c' | 'r', pageNum: boolean) => void;
  onClose: () => void;
}

export default function WordHeaderFooterModal({ part, current, onApply, onClose }: WordHeaderFooterModalProps) {
  const initialText = current?.paras.map((p) => runsText(p.runs)).join(' ').trim() ?? '';
  const [text, setText] = useState(initialText);
  const [jc, setJc] = useState<'l' | 'c' | 'r'>(current?.paras[0]?.fmt?.jc === 'l' || current?.paras[0]?.fmt?.jc === 'r'
    ? current.paras[0].fmt.jc
    : 'c');
  const [pageNum, setPageNum] = useState(current?.hasPageNum ?? part === 'footer');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const label = part === 'header' ? 'Đầu trang' : 'Chân trang';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{part === 'header' ? '⌃' : '⌄'} {label}</h3>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <label className="small" style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
          Nội dung {label.toLowerCase()}
        </label>
        <input
          autoFocus
          placeholder={part === 'header' ? 'VD: Công ty ABC — Báo cáo tuần' : 'VD: Trang'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onApply(text, jc, pageNum); }}
          style={{ width: '100%', marginBottom: 10 }}
        />

        <label className="small" style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
          Căn lề
        </label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {([['l', 'Trái'], ['c', 'Giữa'], ['r', 'Phải']] as const).map(([v, name]) => (
            <button
              key={v}
              className={`sheet-fmt-btn${jc === v ? ' on' : ''}`}
              onClick={() => setJc(v)}
            >
              {name}
            </button>
          ))}
        </div>

        <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
          <input type="checkbox" checked={pageNum} onChange={(e) => setPageNum(e.target.checked)} />
          Chèn số trang tự động (Word tự đánh số khi in)
        </label>

        <div className="sheet-save-note">
          Xem trước: <b>{text || '(trống)'}</b>{pageNum && <> <code>⟨số trang⟩</code></>} — căn {jc === 'l' ? 'trái' : jc === 'r' ? 'phải' : 'giữa'}.
          {' '}Áp cho toàn bộ tài liệu; bấm <b>Lưu</b> mới ghi vào file.
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="ghost sm" onClick={onClose}>Hủy</button>
          <button className="sm" onClick={() => onApply(text, jc, pageNum)}>✓ Áp dụng</button>
        </div>
      </div>
    </div>
  );
}
