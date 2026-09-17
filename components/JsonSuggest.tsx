'use client';

// Bảng gợi ý nổi dưới một ô nhập JSON — phần NHÌN + PHÍM, dùng chung cho ô
// query Mongo (FieldSuggest) và ô sắp xếp của màn xuất ES.
//
// Component không tự nghĩ ra gợi ý: cha tính sẵn `matches` (lib/mongoSuggest,
// lib/esSortSuggest) rồi đưa vào. Nhờ thế mỗi ô có luật chèn riêng mà vẫn chung
// một cách bấm — ↑↓ chọn, Tab/Enter chèn, Esc bỏ qua.
//
// Phím nghe ở CAPTURE PHASE của document, không phải trên textarea: ô nhập vẫn
// giữ focus trong suốt quá trình chọn, và handler Enter của chính ô đó (đóng
// ngoặc + format) không chạy chồng lên — nó kiểm tra `defaultPrevented`.

import { useEffect, useState } from 'react';
import type { Match, Token } from '@/lib/mongoSuggest';

export interface JsonSuggestPick {
  from: number;
  to: number;
  text: string;
  caretOffset?: number;
  selectLen?: number;
}

export interface JsonSuggestProps {
  /** Gợi ý do cha tính. Rỗng = không hiện gì. */
  matches: Match[];
  /** Token dưới con trỏ — chỉ dùng để nhớ "đã Esc bỏ qua chữ nào". */
  token: Token | null;
  onPick: (r: JsonSuggestPick) => void;
}

export default function JsonSuggest({ matches, token, onPick }: JsonSuggestProps) {
  const [active, setActive] = useState(0);
  /** Chữ vừa bị Esc bỏ qua — gõ tiếp chữ khác là bảng hiện lại. */
  const [dismissed, setDismissed] = useState('');

  const word = token?.word.toLowerCase() ?? '';
  const shown = word && word === dismissed ? [] : matches;

  useEffect(() => { setActive(0); }, [word]);

  useEffect(() => {
    if (shown.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % shown.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + shown.length) % shown.length); }
      else if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        pick(shown[active]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(word);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  function pick(m: Match) {
    setDismissed('');
    onPick({ from: m.from, to: m.to, text: m.insert, caretOffset: m.caretOffset, selectLen: m.selectLen });
  }

  if (shown.length === 0) return null;

  return (
    <div className="json-suggest" role="listbox">
      {shown.map((m, i) => (
        <button
          key={m.label}
          role="option"
          aria-selected={i === active}
          className={`json-suggest-item${i === active ? ' active' : ''}`}
          // Mouse-down (not click) so the textarea never loses focus mid-pick.
          onMouseDown={(e) => { e.preventDefault(); pick(m); }}
          onMouseEnter={() => setActive(i)}
        >
          <span className="json-suggest-path">{m.label}</span>
          {m.preview !== m.label && <span className="json-suggest-prev">{m.preview}</span>}
          <span className="json-suggest-type">{m.hint}</span>
        </button>
      ))}
      <span className="json-suggest-hint">↑↓ chọn · Tab/Enter chèn · Esc bỏ qua</span>
    </div>
  );
}
