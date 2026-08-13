'use client';

// Ctrl+F inside the result pane.
//
// The browser's own find cannot see collapsed tree nodes, so results get their
// own bar: it drives the `highlight` prop of every JsonView, counts the hits,
// and scrolls the active one into view. Ctrl+F is captured only while the
// result pane has documents — elsewhere the native find is left alone.

import { useEffect, useRef } from 'react';

export interface ResultFindBarProps {
  query: string;
  onQuery: (q: string) => void;
  /** Total hits across every rendered document. */
  total: number;
  /** Zero-based index of the active hit. */
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}

export default function ResultFindBar({ query, onQuery, total, index, onIndex, onClose }: ResultFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  // Keep the active hit on screen as the user steps through.
  useEffect(() => {
    if (total === 0) return;
    const el = document.getElementById(`mongo-hit-${index}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [index, total, query]);

  const step = (delta: number) => {
    if (total === 0) return;
    onIndex((index + delta + total) % total);
  };

  return (
    <div className="mongo-find">
      <input
        ref={inputRef}
        className="input mono"
        value={query}
        placeholder="Tìm trong kết quả…"
        onChange={(e) => { onQuery(e.target.value); onIndex(0); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
      />
      <span className="mongo-find-count">
        {query ? (total === 0 ? 'không thấy' : `${index + 1}/${total}`) : ''}
      </span>
      <button className="chip-btn" disabled={total === 0} onClick={() => step(-1)} title="Kết quả trước (Shift+Enter)">↑</button>
      <button className="chip-btn" disabled={total === 0} onClick={() => step(1)} title="Kết quả sau (Enter)">↓</button>
      <button className="chip-btn" onClick={onClose} title="Đóng (Esc)">✕</button>
    </div>
  );
}
