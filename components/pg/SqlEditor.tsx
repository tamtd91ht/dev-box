'use client';

// Ô soạn SQL có GỢI Ý kiểu IDE cho tab PostgreSQL.
//
//   · gõ `se`        → SELECT
//   · gõ `WHERE ten` → cột `tenantId`, nhận xong thành `tenantId = ''` với con
//                      trỏ nằm sẵn giữa hai nháy
//   · ↑↓ chọn · Tab/Enter nhận · Esc đóng · Ctrl+Space bật lại
//
// Toàn bộ phần NGHĨ (cắt từ đang gõ, đoán ngữ cảnh, xếp hạng) nằm ở
// lib/sqlComplete.ts — hàm thuần, có scripts/check-sql-complete.ts kiểm riêng.
// Ở đây chỉ còn việc vẽ và nối phím, nên chỗ dễ sai nhất không nằm trong React.
//
// DÙNG <textarea> THẬT chứ không phải editor tự vẽ: người dùng vẫn cần chọn
// chữ, chuột phải, undo/redo, kéo thả — những thứ một div contenteditable phải
// dựng lại từ đầu và luôn thiếu một góc nào đó.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applySuggestion, completeSql,
  type SqlColumnRef, type SqlSuggestion, type SqlTableRef,
} from '@/lib/sqlComplete';

const ICON: Record<SqlSuggestion['kind'], string> = {
  keyword: '🔑', column: '▦', table: '▤', function: 'ƒ',
};

export interface SqlEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** Ctrl+Enter — chạy câu lệnh. */
  onRun: () => void;
  columns?: SqlColumnRef[];
  tables?: SqlTableRef[];
  rows?: number;
}

export default function SqlEditor({ value, onChange, onRun, columns, tables, rows = 3 }: SqlEditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [caret, setCaret] = useState(0);
  /**
   * Con trỏ cần đặt lại SAU khi React vẽ xong giá trị mới. Đặt ngay trong
   * handler là vô ích: React ghi lại `value` sau đó và trình duyệt đẩy con trỏ
   * về cuối — nên phải đợi một nhịp (useEffect bên dưới).
   */
  const pendingCaret = useRef<number | null>(null);

  const list = useMemo(
    () => (open ? completeSql({ text: value, caret, columns, tables }) : []),
    [open, value, caret, columns, tables],
  );

  // Danh sách đổi thì con trỏ chọn phải về đầu, nếu không nó trỏ vào mục cũ đã
  // biến mất và Enter nhận nhầm thứ người dùng không nhìn thấy.
  useEffect(() => { setSel(0); }, [list.length, value]);

  useEffect(() => {
    if (pendingCaret.current == null) return;
    const el = ref.current;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    if (!el) return;
    el.focus();
    el.setSelectionRange(pos, pos);
    setCaret(pos);
  }, [value]);

  const accept = useCallback((s: SqlSuggestion) => {
    const el = ref.current;
    const pos = el ? el.selectionStart : caret;
    const next = applySuggestion(value, pos, s);
    pendingCaret.current = next.caret;
    onChange(next.text);
    setOpen(false);
  }, [value, caret, onChange]);

  const sync = useCallback(() => {
    const el = ref.current;
    if (el) setCaret(el.selectionStart);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter chạy câu lệnh — ưu tiên cao nhất, kể cả khi đang mở gợi ý.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setOpen(false);
      onRun();
      return;
    }
    // Ctrl+Space: bật gợi ý theo yêu cầu, như mọi IDE.
    if (e.code === 'Space' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sync();
      setOpen(true);
      return;
    }
    if (!open || list.length === 0) {
      // Gợi ý đang đóng: Tab giữ nguyên nghĩa thụt lề/chuyển ô của trình duyệt.
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSel((i) => (i + 1) % list.length);
        return;
      case 'ArrowUp':
        e.preventDefault();
        setSel((i) => (i - 1 + list.length) % list.length);
        return;
      case 'Tab':
      case 'Enter': {
        // Enter TRẦN (không Ctrl) khi đang mở gợi ý = nhận mục đang chọn. Muốn
        // xuống dòng thì Esc đóng gợi ý trước — giống hệt IDE.
        e.preventDefault();
        const pick = list[sel] ?? list[0];
        if (pick) accept(pick);
        return;
      }
      case 'Escape':
        // stopPropagation: Esc ở đây chỉ đóng gợi ý, KHÔNG được đóng luôn cả
        // modal/tab bên ngoài.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      default:
    }
  }, [open, list, sel, accept, onRun, sync]);

  return (
    <div className="sqled">
      <textarea
        ref={ref}
        className="input mono"
        rows={rows}
        value={value}
        style={{ minHeight: 70 }}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={sync}
        onClick={sync}
        // Bấm ra ngoài thì đóng — nhưng CHẬM một nhịp, nếu không cú click vào
        // chính một dòng gợi ý bị blur nuốt mất trước khi onMouseDown chạy.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {open && list.length > 0 && (
        <div className="sqled-pop" role="listbox" aria-label="Gợi ý SQL">
          {list.map((s, i) => (
            <button
              type="button"
              key={`${s.kind}:${s.value}`}
              role="option"
              aria-selected={i === sel}
              className={`sqled-row${i === sel ? ' on' : ''}`}
              // onMouseDown chứ không onClick: onClick chạy SAU blur của
              // textarea, lúc đó popup đã đóng và cú bấm rơi vào hư không.
              onMouseDown={(e) => { e.preventDefault(); accept(s); }}
              onMouseEnter={() => setSel(i)}
            >
              <span className="sqled-ico" aria-hidden>{ICON[s.kind]}</span>
              <span className="sqled-label">{s.label}</span>
              {s.detail && <span className="sqled-detail">{s.detail}</span>}
            </button>
          ))}
          <div className="sqled-hint">↑↓ chọn · Tab/Enter nhận · Esc đóng · Ctrl+Space gợi ý lại</div>
        </div>
      )}
    </div>
  );
}
