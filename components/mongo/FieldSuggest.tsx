'use client';

// Field autocomplete for the query boxes.
//
// The parent owns the textarea; this component only watches the caret. When the
// word being typed looks like a field name (or a `$` operator), it offers the
// paths sampled from the collection and inserts the pick back at the caret.
// Purely additive — ignore it and typing behaves exactly as before.
//
// Ở đây chỉ còn phần NỐI DÂY: luật chèn nằm ở lib/mongoSuggest (có
// scripts/check-mongo-query.ts soát), phần danh sách + phím ở JsonSuggest
// (dùng chung với ô sắp xếp của màn xuất ES).

import { useMemo } from 'react';
import type { FieldInfo } from '@/lib/mongo';
import { buildMatches, tokenAt } from '@/lib/mongoSuggest';
import JsonSuggest, { type JsonSuggestPick } from '../JsonSuggest';

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
  onPick: (replacement: JsonSuggestPick) => void;
  /** Rendered under the box; hidden when there is nothing to offer. */
  disabled?: boolean;
}

export default function FieldSuggest({ fields, value, caret, onPick, disabled }: FieldSuggestProps) {
  const token = disabled ? null : tokenAt(value, caret);
  const matches = useMemo(() => buildMatches(fields, value, token), [fields, value, token]);
  return <JsonSuggest matches={matches} token={token} onPick={onPick} />;
}
