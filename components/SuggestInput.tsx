'use client';

// Ô nhập MỘT DÒNG có gợi ý: gõ vài chữ, ↑↓ chọn, Tab hoặc Enter điền, Esc bỏ qua.
// Dùng cho tên database / collection / field code — mọi chỗ có danh sách giá trị biết trước.
//
// Gợi ý chỉ hiện khi ô đang focus và có kết quả khớp (không phân biệt hoa thường; khớp đầu chuỗi xếp trước,
// khớp giữa chuỗi xếp sau). Enter/Tab chỉ bị chặn KHI có bảng gợi ý và đang chọn một mục — không thì phím
// đi tiếp như bình thường (Enter gửi form, Tab sang ô kế).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface SuggestOption {
  value: string;
  /** Nhãn phụ bên phải (kiểu field, số lần gặp…). */
  hint?: string;
}

const MAX_SHOWN = 10;

export function rankOptions(options: SuggestOption[], q: string): SuggestOption[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return options.slice(0, MAX_SHOWN);
  const starts: SuggestOption[] = [];
  const has: SuggestOption[] = [];
  for (const o of options) {
    const v = o.value.toLowerCase();
    if (v === needle) continue; // đã gõ đúng rồi — khỏi gợi lại chính nó
    if (v.startsWith(needle)) starts.push(o);
    else if (v.includes(needle)) has.push(o);
  }
  return [...starts, ...has].slice(0, MAX_SHOWN);
}

export interface SuggestInputProps {
  value: string;
  onChange: (v: string) => void;
  options: Array<string | SuggestOption>;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Hiện cả danh sách khi ô còn rỗng (mặc định: chỉ hiện sau khi gõ hoặc bấm ↓). */
  showWhenEmpty?: boolean;
  /** Gọi sau khi điền bằng gợi ý (Tab/Enter/chuột). */
  onPick?: (v: string) => void;
  /** Enter khi KHÔNG có gợi ý nào đang chọn (vd. để chạy truy vấn). */
  onEnter?: () => void;
  title?: string;
}

export default function SuggestInput(props: SuggestInputProps) {
  const { value, onChange, options, placeholder, disabled, className, showWhenEmpty, onPick, onEnter, title } = props;
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [forced, setForced] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  // Toạ độ popup (position: fixed) — thoát khỏi overflow của khung cuộn cha (vd. danh sách cột trong hộp thoại xuất Excel).
  const [pos, setPos] = useState<React.CSSProperties | null>(null);

  const opts = useMemo<SuggestOption[]>(() => options.map((o) => (typeof o === 'string' ? { value: o } : o)), [options]);
  const matches = useMemo(
    () => (focus && (value.trim() || showWhenEmpty || forced) && dismissed !== value ? rankOptions(opts, value) : []),
    [focus, value, opts, showWhenEmpty, forced, dismissed],
  );

  useEffect(() => { setActive(0); }, [value]);

  const shown = matches.length > 0;
  useLayoutEffect(() => {
    if (!shown) { setPos(null); return; }
    const place = () => {
      const r = wrap.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const up = below < 200 && r.top > below; // chật phía dưới → mở lên trên
      setPos({
        position: 'fixed', left: r.left, minWidth: Math.max(260, r.width), maxWidth: Math.max(r.width, 420),
        marginTop: 0, ...(up ? { top: 'auto', bottom: window.innerHeight - r.top + 2, maxHeight: Math.min(260, r.top - 8) } : { top: r.bottom + 2, maxHeight: Math.min(260, below - 8) }),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [shown, value]);

  function pick(o: SuggestOption) {
    onChange(o.value);
    setDismissed(o.value);
    setForced(false);
    onPick?.(o.value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!matches.length) setForced(true);
      else setActive((i) => (i + 1) % matches.length);
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + matches.length) % matches.length);
    } else if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') {
      if (matches.length) {
        e.preventDefault();
        pick(matches[active] ?? matches[0]);
      } else if (e.key === 'Enter') onEnter?.();
    } else if (e.key === 'Escape' && matches.length) {
      e.preventDefault();
      setDismissed(value);
    }
  }

  return (
    <div className="json-suggest-wrap" ref={wrap} style={{ position: 'relative', minWidth: 0 }}>
      <input
        className={className ?? 'input'}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        title={title}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => { setDismissed(null); onChange(e.target.value); }}
        onFocus={() => setFocus(true)}
        onBlur={() => { setFocus(false); setForced(false); }}
        onKeyDown={onKeyDown}
      />
      {matches.length > 0 && (
        <div className="json-suggest" role="listbox" style={pos ?? undefined}>
          {matches.map((m, i) => (
            <button
              key={m.value}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`json-suggest-item${i === active ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(m); }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="json-suggest-path">{m.value}</span>
              {m.hint && <span className="json-suggest-type">{m.hint}</span>}
            </button>
          ))}
          <span className="json-suggest-hint">↑↓ chọn · Tab/Enter điền · Esc bỏ qua</span>
        </div>
      )}
    </div>
  );
}
