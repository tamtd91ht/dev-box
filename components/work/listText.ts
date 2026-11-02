// Gạch đầu dòng cho <textarea> chữ thô — kiểu ghi chú họp:
//   · Enter trên dòng "• abc"  → dòng mới tự có "• " (số "1." thì tăng lên "2.")
//   · Enter trên dòng chỉ còn "• " → bỏ dấu, thoát danh sách
//   · Tab / Shift+Tab trên dòng danh sách → thụt vào / lùi ra 2 dấu cách
//   · toggleBullets() — nút "• Danh sách": bật / tắt dấu cho các dòng đang chọn
// Sửa qua execCommand('insertText') để Ctrl+Z vẫn hoàn tác được và React nhận
// sự kiện input như gõ tay; trình duyệt không hỗ trợ thì gán value thẳng.

import type React from 'react';

const ITEM = /^(\s*)([-*•]|\d+[.)])(\s+)/;
export const BULLET = '• ';

/** Thay đoạn [from, to) của textarea bằng `text`, rồi đặt con trỏ / vùng chọn. */
function replaceRange(ta: HTMLTextAreaElement, from: number, to: number, text: string, sel?: [number, number]) {
  ta.focus();
  ta.setSelectionRange(from, to);
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    ta.setRangeText(text, from, to, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (sel) ta.setSelectionRange(sel[0], sel[1]);
}

/** Vị trí đầu / cuối của các dòng phủ vùng chọn. */
function lineSpan(v: string, s: number, e: number): [number, number] {
  const start = v.lastIndexOf('\n', s - 1) + 1;
  const nl = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
  return [start, nl < 0 ? v.length : nl];
}

/** Gắn vào onKeyDown của textarea. Trả true nếu đã xử lý phím. */
export function listKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  const ta = e.currentTarget;
  const v = ta.value;
  const s = ta.selectionStart;
  const end = ta.selectionEnd;
  if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;

  if (e.key === 'Enter' && !e.shiftKey) {
    const [ls] = lineSpan(v, s, s);
    const m = ITEM.exec(v.slice(ls, s));
    if (!m) return false;
    e.preventDefault();
    const [, indent, mark, gap] = m;
    if (v.slice(ls, s).trim() === mark && v.slice(end, lineSpan(v, end, end)[1]).trim() === '') {
      // Dòng rỗng chỉ có dấu → thoát danh sách.
      replaceRange(ta, ls, end, '');
      return true;
    }
    const num = /^(\d+)([.)])$/.exec(mark);
    const next = num ? `${Number(num[1]) + 1}${num[2]}` : mark;
    replaceRange(ta, s, end, `\n${indent}${next}${gap}`);
    return true;
  }

  if (e.key === 'Tab') {
    const [ls, le] = lineSpan(v, s, end);
    const lines = v.slice(ls, le).split('\n');
    if (!lines.some((l) => ITEM.test(l))) return false; // không phải danh sách → Tab chuyển ô như thường
    e.preventDefault();
    const out = lines.map((l) => (!ITEM.test(l) ? l : e.shiftKey ? l.replace(/^ {1,2}/, '') : `  ${l}`));
    const text = out.join('\n');
    const delta = out[0].length - lines[0].length;
    replaceRange(ta, ls, le, text, s === end
      ? [Math.max(ls, s + delta), Math.max(ls, s + delta)]
      : [ls, ls + text.length]);
    return true;
  }
  return false;
}

/** Bật / tắt dấu đầu dòng cho các dòng đang chọn (hoặc dòng có con trỏ). */
export function toggleBullets(ta: HTMLTextAreaElement | null) {
  if (!ta) return;
  const v = ta.value;
  const [ls, le] = lineSpan(v, ta.selectionStart, ta.selectionEnd);
  const lines = v.slice(ls, le).split('\n');
  const filled = lines.filter((l) => l.trim());
  const allOn = filled.length > 0 && filled.every((l) => ITEM.test(l));
  const out = lines.map((l) => {
    if (allOn) return l.replace(ITEM, '$1');
    if (ITEM.test(l) || (!l.trim() && lines.length > 1)) return l;
    const ind = /^\s*/.exec(l)![0];
    return `${ind}${BULLET}${l.slice(ind.length)}`;
  });
  const text = out.join('\n');
  const caret = ls + text.length;
  replaceRange(ta, ls, le, text, lines.length > 1 ? [ls, caret] : [caret, caret]);
}
