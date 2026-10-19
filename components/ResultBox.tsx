'use client';

// Khung kết quả có nút "mở rộng" — dùng chung cho Mongo / ES / Postgres.
//
// Kết quả query bị dồn xuống dưới ô soạn query và chỉ cao tối đa ~56–58vh. Bấm
// ⤢ thì khung (thanh trạng thái + phân trang + danh sách kết quả) bung ra phủ gần
// kín cửa sổ; bấm ⤡ hoặc Esc để thu lại.
//
// Bung bằng CSS (`position: fixed`) chứ KHÔNG chuyển DOM sang portal: phần tử giữ
// nguyên chỗ trong cây React nên thẻ đang mở, ô tìm trong kết quả, vị trí cuộn…
// đều còn nguyên. Lúc thu lại khung là `display: contents` — không tạo hộp nào,
// bố cục cũ y hệt như chưa bọc.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

/** Trạng thái mở rộng + Esc để thu lại. */
export function useResultExpand(): { expanded: boolean; toggle: () => void; close: () => void } {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const close = useCallback(() => setExpanded(false), []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Có hộp thoại (xem JSON đầy đủ, xuất báo cáo…) đang mở trên khung: Esc
      // thuộc về nó, không thu khung kết quả nằm bên dưới.
      if (document.querySelector('.modal-backdrop, .tw-modal-back')) return;
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  return { expanded, toggle, close };
}

/** Nút ⤢/⤡ đặt trong thanh công cụ của khung kết quả. */
export function ExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="chip-btn"
      title={expanded ? 'Thu nhỏ kết quả (Esc)' : 'Phóng to vùng kết quả cho dễ xem'}
      aria-pressed={expanded}
      onClick={onToggle}
    >{expanded ? '⤡ Thu nhỏ' : '⤢ Mở rộng'}</button>
  );
}

/** `onFind`: Ctrl+F khi focus đang ở trong khung kết quả thì mở ô tìm của khung. */
export default function ResultBox({ expanded, onFind, children }: { expanded: boolean; onFind?: () => void; children: ReactNode }) {
  const onKeyDown = onFind
    ? (e: ReactKeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); onFind(); }
      }
    : undefined;
  return (
    <div
      className={`res-box${expanded ? ' res-max' : ''}`}
      role={expanded ? 'region' : undefined}
      aria-label={expanded ? 'Kết quả (đang phóng to)' : undefined}
      onKeyDown={onKeyDown}
    >{children}</div>
  );
}

// ── Tìm trong kết quả ──────────────────────────────────────────────────────
//
// Lọc theo chuỗi con, không phân biệt hoa/thường: dòng không khớp bị ẩn, dòng
// khớp tô sáng chỗ trùng. Dùng cho ES / Postgres / QuickFind — những chỗ kết quả
// là danh sách phẳng. (Mongo Browser có ResultFindBar riêng vì phải mở cả cây JSON.)

export interface FilterRow<T> {
  item: T;
  /** Vị trí trong danh sách GỐC — để đánh số #n và key không lệch khi lọc. */
  index: number;
}

export interface ResultFilter<T> {
  open: boolean;
  setOpen: (v: boolean) => void;
  query: string;
  setQuery: (q: string) => void;
  /** Chuỗi tìm đã trim + lowercase; rỗng khi ô tìm đóng. */
  needle: string;
  rows: FilterRow<T>[];
  total: number;
  close: () => void;
  toggle: () => void;
}

export function useResultFilter<T>(items: readonly T[] | undefined, textOf: (t: T) => string): ResultFilter<T> {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const needle = open ? query.trim().toLowerCase() : '';
  const textOfRef = useRef(textOf);
  textOfRef.current = textOf;

  const rows = useMemo<FilterRow<T>[]>(() => {
    const out: FilterRow<T>[] = [];
    (items ?? []).forEach((item, index) => {
      if (!needle || textOfRef.current(item).toLowerCase().includes(needle)) out.push({ item, index });
    });
    return out;
  }, [items, needle]);

  const close = useCallback(() => { setOpen(false); setQuery(''); }, []);
  const toggle = useCallback(() => {
    setOpen((v) => !v);
    setQuery('');
  }, []);
  return { open, setOpen, query, setQuery, needle, rows, total: items?.length ?? 0, close, toggle };
}

/** Nút 🔍 mở/đóng ô tìm. */
export function FindButton({ flt }: { flt: Pick<ResultFilter<unknown>, 'open' | 'toggle'> }) {
  return (
    <button type="button" className="chip-btn" aria-pressed={flt.open} title="Tìm trong kết quả (Ctrl+F)" onClick={flt.toggle}>🔍</button>
  );
}

/** Ô tìm — chỉ hiện khi `flt.open`. Esc đóng. */
export function FilterBar({ flt }: { flt: ResultFilter<unknown> }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (flt.open) { ref.current?.focus(); ref.current?.select(); }
  }, [flt.open]);
  if (!flt.open) return null;
  return (
    <div className="mongo-find res-find">
      <input
        ref={ref}
        className="input mono"
        value={flt.query}
        placeholder="Tìm trong kết quả đã tải…"
        onChange={(e) => flt.setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); flt.close(); } }}
      />
      <span className="mongo-find-count">
        {flt.needle ? (flt.rows.length === 0 ? 'không thấy' : `${flt.rows.length}/${flt.total} khớp`) : ''}
      </span>
      <button className="chip-btn" onClick={flt.close} title="Đóng (Esc)">✕</button>
    </div>
  );
}

/** Chữ có tô chỗ khớp `needle` (đã lowercase). Tối đa 200 chỗ để dòng JSON dài không nặng. */
export function Hl({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const low = text.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  let n = 0;
  while (n < 200) {
    const i = low.indexOf(needle, at);
    if (i < 0) break;
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i} className="mongo-hit">{text.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
    n++;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
