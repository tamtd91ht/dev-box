'use client';

// Field autocomplete for the query boxes.
//
// The parent owns the textarea; this component only watches the caret. When the
// word being typed looks like a field name (or a `$` operator), it offers the
// paths sampled from the collection and inserts the pick back at the caret.
// Purely additive — ignore it and typing behaves exactly as before.
//
// Toàn bộ phần "chèn cái gì, con trỏ đi đâu" nằm ở lib/mongoSuggest.ts (có
// scripts/check-mongo-suggest.ts soát); ở đây chỉ còn danh sách + phím.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldInfo } from '@/lib/mongo';
import { buildMatches, tokenAt, type Match } from '@/lib/mongoSuggest';

export interface FieldSuggestProps {
  /** Sampled paths for the selected collection. */
  fields: FieldInfo[];
  /** The live text of the box being edited. */
  value: string;
  /** Caret offset inside `value` — the parent reports it on every event. */
  caret: number;
  /**
   * Apply a completion: parent replaces [from, to) with `text`, then puts the
   * caret at `from + caretOffset` (mặc định là cuối đoạn vừa chèn).
   */
  onPick: (replacement: {
    from: number; to: number; text: string; caretOffset?: number; selectLen?: number;
  }) => void;
  /** Rendered under the box; hidden when there is nothing to offer. */
  disabled?: boolean;
}

export default function FieldSuggest({ fields, value, caret, onPick, disabled }: FieldSuggestProps) {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  const token = disabled ? null : tokenAt(value, caret);

  const matches = useMemo<Match[]>(() => {
    if (!token || token.word.toLowerCase() === dismissed) return [];
    return buildMatches(fields, value, token);
  }, [token, fields, dismissed, value]);

  useEffect(() => { setActive(0); }, [token?.word]);

  // Arrow keys / Enter / Escape are handled here so the textarea keeps focus.
  useEffect(() => {
    if (matches.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % matches.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); }
      else if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        pick(matches[active]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(token?.word.toLowerCase() ?? '');
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  function pick(m: Match) {
    if (!token) return;
    setDismissed('');
    onPick({ from: m.from, to: m.to, text: m.insert, caretOffset: m.caretOffset, selectLen: m.selectLen });
  }

  if (matches.length === 0) return null;

  return (
    <div className="mongo-suggest" ref={boxRef} role="listbox">
      {matches.map((m, i) => (
        <button
          key={m.label}
          role="option"
          aria-selected={i === active}
          className={`mongo-suggest-item${i === active ? ' active' : ''}`}
          // Mouse-down (not click) so the textarea never loses focus mid-pick.
          onMouseDown={(e) => { e.preventDefault(); pick(m); }}
          onMouseEnter={() => setActive(i)}
        >
          <span className="mongo-suggest-path">{m.label}</span>
          {m.preview !== m.label && <span className="mongo-suggest-prev">{m.preview}</span>}
          <span className="mongo-suggest-type">{m.hint}</span>
        </button>
      ))}
      <span className="mongo-suggest-hint">↑↓ chọn · Tab/Enter chèn · Esc bỏ qua</span>
    </div>
  );
}
