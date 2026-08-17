'use client';

// Field autocomplete for the query boxes.
//
// The parent owns the textarea; this component only watches the caret. When the
// word being typed looks like a field name (or a `$` operator), it offers the
// paths sampled from the collection and inserts the pick back at the caret.
// Purely additive — ignore it and typing behaves exactly as before.
//
// CHÈN CẢ CẶP KEY-VALUE, KHÔNG CHỈ TÊN FIELD: gõ `email` rồi Enter sẽ ra
// `"email": ""` với con trỏ nằm SẴN giữa hai dấu nháy của value — gõ tiếp là
// xong câu query, không phải tự thêm nháy/hai chấm. Khuôn value bám theo kiểu
// BSON đã sample được (objectId → {"$oid": ""}, date → {"$date": ""},
// number → 0…) nên phần hay sai nhất của EJSON được điền sẵn đúng.
//
// Khi con trỏ đang ở VỊ TRÍ VALUE (ngay sau `:`) thì không chèn cặp nữa — lúc
// đó người dùng đang gõ giá trị, chèn `"x": ""` vào đấy là hỏng cú pháp.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldInfo } from '@/lib/mongo';

/** Query operators worth suggesting once the user types a `$`. */
const OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options',
  '$elemMatch', '$all', '$size', '$mod', '$expr', '$text',
];

/** Toán tử nhận MẢNG làm toán hạng — chèn `[]` thay vì `""`. */
const ARRAY_OPERATORS = new Set(['$in', '$nin', '$and', '$or', '$nor', '$all']);
/** Toán tử nhận giá trị boolean. */
const BOOL_OPERATORS = new Set(['$exists']);

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
  onPick: (replacement: { from: number; to: number; text: string; caretOffset?: number }) => void;
  /** Rendered under the box; hidden when there is nothing to offer. */
  disabled?: boolean;
}

/**
 * The token under the caret, if it can start a field or operator name.
 *
 * `from`/`to` là ĐOẠN SẼ BỊ THAY, không chỉ là chữ đang gõ: nếu người dùng đã
 * tự mở dấu nháy (`{"ema` → con trỏ sau `ema`) thì dấu `"` đó phải nằm TRONG
 * đoạn bị thay. Không thế thì chèn `"email": ""` vào sau nó ra `{""email": ""}`
 * — dư một dấu nháy, đúng lỗi người dùng gặp. Nháy đóng ngay sau con trỏ cũng
 * bị nuốt cùng, vì khuôn chèn đã tự mang nháy của nó.
 */
function tokenAt(value: string, caret: number): {
  word: string; from: number; to: number; quoted: boolean;
} | null {
  let from = caret;
  while (from > 0 && /[A-Za-z0-9_$.]/.test(value[from - 1])) from--;
  const word = value.slice(from, caret);
  if (!word) return null;

  // Lùi qua dấu nháy mở mà người dùng đã tự gõ (cả " và ').
  const quoted = from > 0 && (value[from - 1] === '"' || value[from - 1] === "'");
  if (quoted) from--;

  // Nuốt luôn dấu nháy đóng ngay sau con trỏ, nếu có, để không còn nháy mồ côi.
  let to = caret;
  if (value[to] === '"' || value[to] === "'") to++;

  return { word, from, to, quoted };
}

/**
 * Con trỏ có đang ở CHỖ ĐẶT GIÁ TRỊ không (ngay sau một `:` của cặp key-value)?
 * Bỏ qua khoảng trắng và phần token đang gõ để nhìn ký tự có nghĩa gần nhất.
 * Ở vị trí đó ta chỉ gợi ý tên field trần (vd `{"a": "$b"}`), không chèn cặp.
 */
function atValuePosition(value: string, from: number): boolean {
  let i = from - 1;
  while (i >= 0 && /\s/.test(value[i])) i--;
  return i >= 0 && value[i] === ':';
}

/** Ký tự có nghĩa ngay sau con trỏ — dùng để biết có cần thêm dấu phẩy không. */
function nextMeaningful(value: string, caret: number): string {
  let i = caret;
  while (i < value.length && /\s/.test(value[i])) i++;
  return value[i] ?? '';
}

/**
 * Khuôn value theo kiểu BSON sample được. Trả về [text, vị trí con trỏ trong text].
 * Con trỏ luôn rơi vào GIỮA chỗ cần gõ tiếp (trong nháy, trong ngoặc).
 */
function valueTemplate(type: string): [string, number] {
  switch (type) {
    case 'objectId': return ['{"$oid": ""}', 11];      // {"$oid": "|"}
    case 'date':     return ['{"$date": ""}', 12];     // {"$date": "|"}
    case 'number':
    case 'int':
    case 'long':
    case 'double':
    case 'decimal128': return ['0', 0];                // |0 — gõ đè được ngay
    case 'boolean':  return ['true', 0];
    case 'array':    return ['[]', 1];                 // [|]
    case 'object':   return ['{}', 1];                 // {|}
    case 'null':     return ['null', 0];
    default:         return ['""', 1];                 // "|"  (string và mọi kiểu lạ)
  }
}

/** Khuôn value cho một toán tử `$…`. */
function operatorTemplate(op: string): [string, number] {
  if (ARRAY_OPERATORS.has(op)) return ['[]', 1];
  if (BOOL_OPERATORS.has(op)) return ['true', 0];
  return ['""', 1];
}

interface Match {
  /** Chuỗi hiện trên danh sách (tên field / tên toán tử). */
  label: string;
  /** Nhãn kiểu bên phải. */
  hint: string;
  /** Đoạn text thật sự được chèn. */
  insert: string;
  /** Vị trí con trỏ TRONG `insert` sau khi chèn. */
  caretOffset: number;
  /** Bản xem trước hiện mờ bên dưới label, cho biết sẽ chèn ra cái gì. */
  preview: string;
}

export default function FieldSuggest({ fields, value, caret, onPick, disabled }: FieldSuggestProps) {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  const token = disabled ? null : tokenAt(value, caret);

  const matches = useMemo<Match[]>(() => {
    if (!token) return [];
    const w = token.word.toLowerCase();
    if (w === dismissed) return [];

    // Sau dấu `:` là chỗ của GIÁ TRỊ — chỉ chèn tên trần, giữ nguyên hành vi cũ.
    const bare = atValuePosition(value, token.from);
    // `,` đứng ngay sau nghĩa là đã có cặp tiếp theo → không tự thêm dấu phẩy.
    // Đo từ `token.to` (đã qua nháy đóng) chứ không từ `caret`, nếu không thì
    // dấu nháy đóng sẽ bị coi là "còn nội dung phía sau" và sinh phẩy thừa.
    const after = nextMeaningful(value, token.to);
    const needComma = !bare && after !== '' && after !== ',' && after !== '}' && after !== ']';

    /**
     * Ở chỗ đặt GIÁ TRỊ ta chỉ chèn tên trần — nhưng `tokenAt` đã nuốt cặp nháy
     * người dùng tự gõ, nên phải trả lại, không thì `{"a": "$b"}` mất nháy.
     */
    const bareInsert = (name: string): [string, number] =>
      token.quoted ? [`"${name}"`, name.length + 1] : [name, name.length];

    if (w.startsWith('$')) {
      return OPERATORS.filter((o) => o.startsWith(w)).slice(0, 8).map((o) => {
        if (bare) {
          const [ins, off] = bareInsert(o);
          return { label: o, hint: 'operator', insert: ins, caretOffset: off, preview: ins };
        }
        const [tpl, off] = operatorTemplate(o);
        const insert = `"${o}": ${tpl}${needComma ? ',' : ''}`;
        return { label: o, hint: 'operator', insert, caretOffset: o.length + 4 + off, preview: `"${o}": ${tpl}` };
      });
    }

    return fields
      .filter((f) => f.path.toLowerCase().includes(w))
      // Prefix matches first — typing `ten` should surface `tenantId` above `clientTenant`.
      .sort((a, b) => Number(b.path.toLowerCase().startsWith(w)) - Number(a.path.toLowerCase().startsWith(w)))
      .slice(0, 8)
      .map((f) => {
        if (bare) {
          const [ins, off] = bareInsert(f.path);
          return { label: f.path, hint: f.type, insert: ins, caretOffset: off, preview: ins };
        }
        const [tpl, off] = valueTemplate(f.type);
        const insert = `"${f.path}": ${tpl}${needComma ? ',' : ''}`;
        // `"` + path + `": ` = path.length + 4 ký tự trước khi tới value.
        return { label: f.path, hint: f.type, insert, caretOffset: f.path.length + 4 + off, preview: `"${f.path}": ${tpl}` };
      });
  }, [token, fields, dismissed, value, caret]);

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
        setDismissed(token?.word ?? '');
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  function pick(m: Match) {
    if (!token) return;
    setDismissed('');
    onPick({ from: token.from, to: token.to, text: m.insert, caretOffset: m.caretOffset });
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
