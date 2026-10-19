// Toạ độ CON TRỎ trong một <textarea> — để bảng gợi ý nổi ngay dưới dòng đang
// gõ thay vì dính dưới đáy ô (ô query giờ cao hết khung: đáy ô có thể cách dòng
// đang gõ cả chục dòng, hoặc nằm ngoài màn hình).
//
// Cách làm quen thuộc: dựng một <div> "gương" chép đúng font/padding/bề rộng/
// cách xuống dòng của textarea, đổ phần chữ trước con trỏ vào, đặt một <span>
// ở vị trí con trỏ rồi đo offset của span.

const COPY = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize',
] as const;

/**
 * Vị trí đặt bảng gợi ý (góc trên-trái) cho con trỏ ở `pos`, tính theo hệ toạ
 * độ của offsetParent của textarea (khung bọc có `position: relative`).
 * Đã trừ phần cuộn trong textarea và kẹp trong vùng nhìn thấy của ô.
 */
export function caretPopupPos(
  ta: HTMLTextAreaElement, pos: number, popupWidth = 300,
): { top: number; left: number } {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement('div');
  const st = mirror.style as unknown as Record<string, string>;
  for (const k of COPY) st[k] = (cs as unknown as Record<string, string>)[k];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.overflow = 'hidden';
  // Bề rộng gương = vùng chữ thật (trừ thanh cuộn dọc nếu có).
  mirror.style.width = `${ta.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`;
  mirror.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = ta.value.slice(pos, pos + 1) || '.';
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 18;
  const y = mark.offsetTop - ta.scrollTop;
  const x = mark.offsetLeft - ta.scrollLeft;
  document.body.removeChild(mirror);

  // Kẹp trong ô: dòng đang gõ cuộn khuất thì bảng vẫn dính mép ô, không bay ra ngoài.
  const maxY = ta.clientHeight - lineH;
  const top = ta.offsetTop + Math.max(0, Math.min(y, maxY)) + lineH + 2;
  const maxLeft = Math.max(0, ta.offsetWidth - Math.min(popupWidth, ta.offsetWidth));
  const left = ta.offsetLeft + Math.max(0, Math.min(x, maxLeft));
  return { top, left };
}
