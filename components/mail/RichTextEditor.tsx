'use client';

// Ô soạn thảo có định dạng cho mail (đậm/nghiêng/gạch chân, danh sách, link,
// màu chữ, trích dẫn). Dùng cho cả composer và ô soạn CHỮ KÝ.
//
// VÌ SAO contentEditable + document.execCommand:
//
// execCommand đúng là API đã deprecated, nhưng cho ĐÚNG bài toán này nó vẫn là
// lựa chọn hợp lý nhất: mọi trình duyệt còn hỗ trợ đầy đủ, và cái ta cần sinh
// ra là HTML MAIL — thứ phải chạy trong Outlook/Gmail của người nhận, tức là
// HTML đời cũ với thẻ <b>/<i>/<font> chứ không phải DOM hiện đại. Thay thế
// "đúng chuẩn" là kéo cả một editor framework (Slate/TipTap ~100KB+) rồi vẫn
// phải tự serialize ra HTML mail — đắt hơn nhiều mà kết quả không tốt hơn.
//
// KHÔNG dùng React controlled input: đặt lại innerHTML mỗi lần gõ sẽ nhảy con
// trỏ về đầu. Ở đây DOM tự giữ nội dung, chỉ báo ra ngoài qua onChange; giá trị
// từ ngoài chỉ ghi vào khi KHÁC nội dung đang có (nạp draft lần đầu).

import { useCallback, useEffect, useRef } from 'react';

export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Chiều cao tối thiểu của vùng gõ. */
  minHeight?: number;
  /** Ctrl/⌘+Enter — composer dùng để gửi luôn. */
  onSubmit?: () => void;
  /** Bớt nút cho ô nhỏ (ô chữ ký không cần trích dẫn). */
  compact?: boolean;
  /** Đặt con trỏ vào ĐẦU ô ngay khi mở — composer cần, vì chỗ gõ nằm phía trên
   *  chữ ký và phần trích dẫn. Không có thì con trỏ rơi xuống cuối, người dùng
   *  phải tự lăn lên. */
  autoFocusTop?: boolean;
}

interface ToolButton {
  cmd: string;
  arg?: string;
  icon: string;
  title: string;
  /** Chỉ hiện ở thanh đầy đủ. */
  full?: boolean;
}

const TOOLS: ToolButton[] = [
  { cmd: 'bold', icon: 'B', title: 'Đậm (Ctrl+B)' },
  { cmd: 'italic', icon: 'I', title: 'Nghiêng (Ctrl+I)' },
  { cmd: 'underline', icon: 'U', title: 'Gạch chân (Ctrl+U)' },
  { cmd: 'strikeThrough', icon: 'S', title: 'Gạch ngang' },
  { cmd: 'insertUnorderedList', icon: '•', title: 'Danh sách chấm' },
  { cmd: 'insertOrderedList', icon: '1.', title: 'Danh sách số' },
  { cmd: 'formatBlock', arg: 'blockquote', icon: '❝', title: 'Trích dẫn', full: true },
  { cmd: 'removeFormat', icon: '✕', title: 'Xoá định dạng' },
];

export default function RichTextEditor({
  value, onChange, placeholder, minHeight = 220, onSubmit, compact = false,
  autoFocusTop = false,
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // CỐ Ý khởi tạo rỗng, KHÔNG phải `value`: đây là "nội dung đang nằm trong
  // DOM", mà lúc mới mount thì div còn trống. Khởi tạo bằng `value` thì lượt
  // effect đầu thấy `value === lastHtml` nên BỎ QUA việc ghi vào DOM — ô soạn
  // hiện ra trống trơn, và chữ ký / phần trích dẫn reply bị mất luôn khi gửi.
  const lastHtml = useRef('');

  // Nạp giá trị từ ngoài (mở draft reply/forward, chèn chữ ký) — chỉ khi thực
  // sự khác, nếu không mỗi lần gõ sẽ ghi đè và con trỏ nhảy về đầu.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value !== lastHtml.current) {
      el.innerHTML = value;
      lastHtml.current = value;
    }
  }, [value]);

  // Con trỏ vào ĐẦU ô ngay khi mở (chạy MỘT lần, sau khi effect trên đã ghi
  // nội dung vào DOM). Chỗ gõ của composer nằm phía trên chữ ký + phần trích
  // dẫn, nên rơi xuống cuối là sai chỗ.
  useEffect(() => {
    if (!autoFocusTop) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      // Đặt vào node con ĐẦU TIÊN nếu có (thường là <p><br></p> ta chừa sẵn),
      // không thì vào chính el — collapse(true) = dính mép trái.
      range.selectNodeContents(el.firstChild ?? el);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch { /* selection API kén chọn — có focus là đủ dùng */ }
    // Chỉ chạy lúc mount: value đổi về sau là do người dùng gõ, kéo con trỏ về
    // đầu lúc đó là phá.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const html = el.innerHTML;
    lastHtml.current = html;
    onChange(html);
  }, [onChange]);

  const exec = useCallback((cmd: string, arg?: string) => {
    ref.current?.focus();
    try {
      document.execCommand(cmd, false, arg);
    } catch { /* lệnh không được hỗ trợ — bỏ qua */ }
    emit();
  }, [emit]);

  /** Chèn link: hỏi URL rồi bọc phần đang bôi đen (không bôi thì chèn chính URL). */
  const addLink = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    const selected = sel?.toString() ?? '';
    const url = window.prompt('Địa chỉ liên kết:', 'https://');
    if (!url || url === 'https://') return;
    // Chỉ nhận http(s)/mailto — javascript: trong mail là cờ đỏ với mọi bộ lọc spam.
    if (!/^(https?:|mailto:)/i.test(url)) {
      window.alert('Chỉ nhận liên kết http(s):// hoặc mailto:');
      return;
    }
    if (selected) exec('createLink', url);
    else exec('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`);
  }, [exec]);

  const tools = compact ? TOOLS.filter((t) => !t.full) : TOOLS;

  return (
    <div className="rte">
      <div className="rte-bar">
        {tools.map((t) => (
          <button
            key={t.cmd + (t.arg ?? '')}
            type="button"
            className={`rte-btn rte-${t.cmd}`}
            title={t.title}
            // onMouseDown + preventDefault: giữ nguyên vùng bôi đen trong ô soạn.
            // Dùng onClick thì ô mất focus trước, lệnh không biết áp lên đâu.
            onMouseDown={(e) => { e.preventDefault(); exec(t.cmd, t.arg); }}
          >
            {t.icon}
          </button>
        ))}
        <button type="button" className="rte-btn" title="Chèn liên kết"
          onMouseDown={(e) => { e.preventDefault(); addLink(); }}>🔗</button>
        <label className="rte-btn rte-color" title="Màu chữ">
          A
          <input
            type="color"
            defaultValue="#202124"
            onChange={(e) => exec('foreColor', e.target.value)}
          />
        </label>
      </div>
      <div
        ref={ref}
        className="rte-area"
        style={{ minHeight }}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={emit}
        onBlur={emit}
        onKeyDown={(e) => {
          if (onSubmit && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          }
        }}
        // Dán từ Word/webmail kéo theo cả rừng style rác và <script>. Dán dạng
        // text thuần rồi để người dùng tự định dạng lại — sạch và đoán được.
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain');
          if (!text) return;
          e.preventDefault();
          document.execCommand('insertText', false, text);
          emit();
        }}
      />
    </div>
  );
}

/** HTML → text thuần cho phần `text` của mail (client text-only đọc bản này).
 *  Không phải parser đầy đủ, chỉ cần đọc được: xuống dòng đúng chỗ, bỏ thẻ. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')       // & phải giải mã CUỐI, không thì &amp;lt; sai
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
