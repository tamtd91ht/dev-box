'use client';

// Thanh Tìm & thay thế của Word workspace.
//
// Tìm chạy ngay trên bản đang xem (không gọi server): mỗi lần gõ là quét lại
// và tô sáng các khối có kết quả, Enter / ↑↓ để nhảy giữa các kết quả.
// "Thay tất cả" cập nhật bản xem ngay và ghi MỘT op replaceAll — server sẽ
// thay lại trên file gốc khi bấm Lưu, nên định dạng của các đoạn khác
// không bị đụng tới.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchHit, SearchOptions } from '@/lib/wordDocUtils';

export interface WordFindPanelProps {
  onFind: (find: string, opts: SearchOptions) => SearchHit[];
  onJump: (blockIndex: number) => void;
  onReplaceAll: (find: string, replace: string, opts: SearchOptions) => number;
  onClose: () => void;
}

export default function WordFindPanel({ onFind, onJump, onReplaceAll, onClose }: WordFindPanelProps) {
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Quét lại mỗi khi từ khóa hoặc tuỳ chọn đổi.
  useEffect(() => {
    if (find === '') { setHits([]); setAt(0); return; }
    const found = onFind(find, { matchCase, whole });
    setHits(found);
    setAt(0);
    if (found.length > 0) onJump(found[0].i);
    // onFind/onJump đổi mỗi lần blocks đổi — chỉ chạy lại theo điều kiện tìm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, matchCase, whole]);

  const step = useCallback((dir: 1 | -1) => {
    if (hits.length === 0) return;
    const next = (at + dir + hits.length) % hits.length;
    setAt(next);
    onJump(hits[next].i);
  }, [hits, at, onJump]);

  const doReplaceAll = () => {
    if (find === '') return;
    const n = onReplaceAll(find, replace, { matchCase, whole });
    if (n > 0) { setHits([]); setAt(0); }
  };

  return (
    <div className="word-find">
      <input
        ref={inputRef}
        className="word-find-input"
        placeholder="Tìm gì…"
        value={find}
        onChange={(e) => setFind(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') onClose();
        }}
      />
      <span className="word-find-count">
        {find === '' ? '—' : hits.length === 0 ? 'không thấy' : `${at + 1}/${hits.length}`}
      </span>
      <button className="ghost sm" onClick={() => step(-1)} disabled={hits.length === 0} title="Kết quả trước (Shift+Enter)">↑</button>
      <button className="ghost sm" onClick={() => step(1)} disabled={hits.length === 0} title="Kết quả sau (Enter)">↓</button>

      <input
        className="word-find-input"
        placeholder="Thay bằng…"
        value={replace}
        onChange={(e) => setReplace(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      />
      <button
        className="ghost sm"
        onClick={doReplaceAll}
        disabled={find === '' || hits.length === 0}
        title={hits.length === 0 ? 'Chưa có kết quả nào để thay' : `Thay tất cả ${hits.length} chỗ`}
      >
        ⇄ Thay tất cả
      </button>

      <label className="small word-find-opt" title="Phân biệt chữ HOA và chữ thường">
        <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Aa
      </label>
      <label className="small word-find-opt" title="Chỉ khớp nguyên từ, không khớp một phần của từ khác">
        <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> Nguyên từ
      </label>

      <span style={{ flex: 1 }} />
      <button className="ghost sm" onClick={onClose} title="Đóng (Esc)">✕</button>
    </div>
  );
}
