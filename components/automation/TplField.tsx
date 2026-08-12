'use client';

// Ô nhập có GỢI Ý BIẾN template: gõ `{{` là hiện danh sách biến của trigger
// đang chọn, gõ tiếp để lọc, Enter/Tab/click để chèn (tự đóng `}}`).
//
// Danh sách biến đi qua React context thay vì prop: các form action nằm sâu
// nhiều tầng trong ActionCard, mà biến khả dụng là thuộc tính của RULE (trigger
// quyết định) chứ không phải của từng ô — luồn prop qua 6 sub-form chỉ để chở
// một mảng ai cũng dùng chung là nhiễu. RuleEditor bọc section Hành động bằng
// <TplVars vars={…}>; ô nào nằm ngoài provider thì thành input thường (không
// gợi ý), không hỏng gì.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { FieldDef } from '@/lib/automation/catalog';

const VarsCtx = createContext<FieldDef[]>([]);

export function TplVars({ vars, children }: { vars: FieldDef[]; children: ReactNode }) {
  return <VarsCtx.Provider value={vars}>{children}</VarsCtx.Provider>;
}

const MAX_ITEMS = 8;

/** Đoạn `{{fragment` chưa đóng ngay trước con trỏ — chỗ duy nhất gợi ý bật lên. */
const OPEN_RE = /\{\{\s*([a-zA-Z0-9_.]*)$/;

interface TplProps {
  value: string;
  onChange: (v: string) => void;
  as?: 'input' | 'textarea';
  placeholder?: string;
  rows?: number;
  style?: CSSProperties;
  className?: string;
}

export function TplInput(props: Omit<TplProps, 'as' | 'rows'>) {
  return <TplField {...props} as="input" />;
}

export function TplTextarea(props: Omit<TplProps, 'as'>) {
  return <TplField {...props} as="textarea" />;
}

function TplField({ value, onChange, as = 'input', placeholder, rows, style, className }: TplProps) {
  const vars = useContext(VarsCtx);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [frag, setFrag] = useState<string | null>(null); // null = đóng gợi ý
  const [fragStart, setFragStart] = useState(0);
  const [active, setActive] = useState(0);

  const items =
    frag === null || !vars.length
      ? []
      : (() => {
          const q = frag.replace(/^fields\./, '').toLowerCase();
          const starts = vars.filter((v) => v.name.toLowerCase().startsWith(q));
          const rest = vars.filter(
            (v) =>
              !v.name.toLowerCase().startsWith(q) &&
              (v.name.toLowerCase().includes(q) || v.label.toLowerCase().includes(q)),
          );
          return [...starts, ...rest].slice(0, MAX_ITEMS);
        })();

  useEffect(() => {
    if (active >= items.length) setActive(0);
  }, [items.length, active]);

  /** Đọc lại vị trí con trỏ sau mỗi thay đổi và quyết định mở/đóng gợi ý. */
  const detect = (text: string, caret: number) => {
    const m = OPEN_RE.exec(text.slice(0, caret));
    if (m) {
      setFrag(m[1]);
      setFragStart(caret - m[1].length);
      setActive(0);
    } else {
      setFrag(null);
    }
  };

  const handleChange = (text: string, caret: number) => {
    onChange(text);
    detect(text, caret);
  };

  const insert = (name: string) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? fragStart + (frag?.length ?? 0);
    const after = value.slice(caret);
    const close = after.startsWith('}}') ? '' : '}}';
    const next = value.slice(0, fragStart) + name + close + after;
    onChange(next);
    setFrag(null);
    // Trả con trỏ về ngay sau `}}` — người dùng gõ tiếp không phải bấm chuột.
    const pos = fragStart + name.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (frag === null || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insert(items[active]?.name ?? items[0].name);
    } else if (e.key === 'Escape') {
      setFrag(null);
    }
  };

  const shared = {
    value,
    placeholder,
    className,
    onKeyDown,
    onBlur: () => setFrag(null),
    // Click đổi vị trí con trỏ cũng phải đóng/mở lại gợi ý cho đúng chỗ.
    onClick: () => {
      const el = ref.current;
      if (el) detect(value, el.selectionStart ?? value.length);
    },
  } as const;

  return (
    <div className="tpl-wrap" style={style}>
      {as === 'textarea' ? (
        <textarea
          {...shared}
          rows={rows}
          ref={(el) => {
            ref.current = el;
          }}
          onChange={(e) => handleChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        />
      ) : (
        <input
          {...shared}
          ref={(el) => {
            ref.current = el;
          }}
          onChange={(e) => handleChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        />
      )}
      {items.length ? (
        <div className="tpl-suggest" role="listbox">
          {items.map((f, i) => (
            <button
              key={f.name}
              type="button"
              className={i === active ? 'active' : ''}
              // Hover đọc được Ý NGHĨA đầy đủ + ví dụ — label trong dòng chỉ đủ nhận mặt.
              title={[f.label, f.hint, f.sample !== undefined ? `Ví dụ: ${f.sample}` : '']
                .filter(Boolean)
                .join('\n')}
              // preventDefault để không blur ô nhập trước khi insert chạy.
              onMouseDown={(e) => {
                e.preventDefault();
                insert(f.name);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <code>{`{{${f.name}}}`}</code>
              <span>{f.label}</span>
              {f.sample !== undefined ? <em>{String(f.sample)}</em> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
