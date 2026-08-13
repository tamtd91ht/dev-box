'use client';

// Field autocomplete for the query boxes.
//
// The parent owns the textarea; this component only watches the caret. When the
// word being typed looks like a field name (or a `$` operator), it offers the
// paths sampled from the collection and inserts the pick back at the caret.
// Purely additive — ignore it and typing behaves exactly as before.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldInfo } from '@/lib/mongo';

/** Query operators worth suggesting once the user types a `$`. */
const OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options',
  '$elemMatch', '$all', '$size', '$mod', '$expr', '$text',
];

export interface FieldSuggestProps {
  /** Sampled paths for the selected collection. */
  fields: FieldInfo[];
  /** The live text of the box being edited. */
  value: string;
  /** Caret offset inside `value` — the parent reports it on every event. */
  caret: number;
  /** Apply a completion: parent replaces [from, to) with `text`. */
  onPick: (replacement: { from: number; to: number; text: string }) => void;
  /** Rendered under the box; hidden when there is nothing to offer. */
  disabled?: boolean;
}

/** The token under the caret, if it can start a field or operator name. */
function tokenAt(value: string, caret: number): { word: string; from: number } | null {
  let from = caret;
  while (from > 0 && /[A-Za-z0-9_$.]/.test(value[from - 1])) from--;
  const word = value.slice(from, caret);
  if (!word) return null;
  // Skip tokens that are clearly a value, not a key: preceded by a quote+colon.
  return { word, from };
}

export default function FieldSuggest({ fields, value, caret, onPick, disabled }: FieldSuggestProps) {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  const token = disabled ? null : tokenAt(value, caret);

  const matches = useMemo(() => {
    if (!token) return [];
    const w = token.word.toLowerCase();
    if (w === dismissed) return [];
    const pool: { label: string; hint: string }[] = w.startsWith('$')
      ? OPERATORS.filter((o) => o.startsWith(w)).map((o) => ({ label: o, hint: 'operator' }))
      : fields
          .filter((f) => f.path.toLowerCase().includes(w))
          // Prefix matches first — typing `ten` should surface `tenantId` above `clientTenant`.
          .sort((a, b) => Number(b.path.toLowerCase().startsWith(w)) - Number(a.path.toLowerCase().startsWith(w)))
          .map((f) => ({ label: f.path, hint: f.type }));
    return pool.slice(0, 8);
  }, [token, fields, dismissed]);

  useEffect(() => { setActive(0); }, [token?.word]);

  // Arrow keys / Enter / Escape are handled here so the textarea keeps focus.
  useEffect(() => {
    if (matches.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % matches.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); }
      else if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        pick(matches[active].label);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(token?.word ?? '');
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  function pick(label: string) {
    if (!token) return;
    setDismissed('');
    onPick({ from: token.from, to: caret, text: label });
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
          onMouseDown={(e) => { e.preventDefault(); pick(m.label); }}
          onMouseEnter={() => setActive(i)}
        >
          <span className="mongo-suggest-path">{m.label}</span>
          <span className="mongo-suggest-type">{m.hint}</span>
        </button>
      ))}
      <span className="mongo-suggest-hint">↑↓ chọn · Tab/Enter chèn · Esc bỏ qua</span>
    </div>
  );
}
