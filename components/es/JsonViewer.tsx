'use client';

// Khung xem JSON chỉ-đọc cho tab Elasticsearch (document, mapping, aggs).
//
// Trước đây mấy chỗ này là <pre class="code"> — chữ đơn sắc, và muốn tìm một
// field trong document dài thì Ctrl+F của trình duyệt chỉ thấy phần đang hiện
// trên màn hình. Dùng Monaco read-only giải quyết cả hai cùng lúc:
//
//   · tô màu JSON (key / string / number khác màu) — đọc nhanh hơn hẳn
//   · Ctrl+F là widget tìm kiếm CỦA MONACO: đếm số khớp, F3/Enter nhảy khớp kế,
//     tìm được cả phần đang cuộn ngoài tầm nhìn, có regex + match-case
//   · gấp/mở (folding) từng khối, cuộn mượt với document lớn
//
// Chiều cao TỰ CO theo nội dung tới `maxHeight` rồi mới cuộn trong khung, để
// document ngắn không để lại khoảng trống thừa còn document dài không đẩy cả
// trang xuống dưới.

import '@/lib/monacoSetup'; // Monaco local /monaco/vs — phải config trước lần init đầu
import Editor from '@monaco-editor/react';
import { useMemo } from 'react';
import { defineEsThemes, useEsTheme, ES_MONO } from './esMonaco';

const LINE_H = 18;
const PAD = 16;

export interface JsonViewerProps {
  /** Nội dung — thường đã pretty-print sẵn. */
  value: string;
  /** Trần chiều cao (px). Vượt thì cuộn bên trong khung. */
  maxHeight?: number;
  /** Chiều cao tối thiểu (px) — tránh khung 1 dòng nhìn như lỗi render. */
  minHeight?: number;
  /** Đường dẫn model, phải DUY NHẤT cho mỗi khung đang mount cùng lúc: hai
   *  Editor dùng chung path là dùng chung model, nội dung sẽ đè lên nhau. */
  path: string;
  /** `_cat/*` trả text thuần chứ không phải JSON — để 'plaintext' cho khỏi báo
   *  lỗi cú pháp đỏ lòm trên thứ vốn không phải JSON. */
  language?: 'json' | 'plaintext';
}

export default function JsonViewer({
  value, maxHeight = 420, minHeight = 60, path, language = 'json',
}: JsonViewerProps) {
  const theme = useEsTheme();

  const height = useMemo(() => {
    const lines = value ? value.split('\n').length : 1;
    return Math.min(maxHeight, Math.max(minHeight, lines * LINE_H + PAD));
  }, [value, maxHeight, minHeight]);

  // Editor chỉ được dựng khi component này mount, và người gọi chỉ mount nó khi
  // thẻ document đã mở — nên một trang 200 document không tạo 200 instance.
  return (
    <div className="es-jsonview" style={{ height }}>
      <Editor
        path={path}
        language={language}
        theme={theme}
        value={value}
        beforeMount={defineEsThemes}
        loading={<span className="spinner" aria-hidden />}
        options={{
          readOnly: true,
          // Con trỏ vẫn phải bấm vào được thì Ctrl+F mới mở đúng khung này,
          // và người dùng còn bôi đen copy một đoạn.
          domReadOnly: false,
          fontSize: 12.5,
          fontFamily: ES_MONO,
          lineHeight: LINE_H,
          lineNumbers: 'off',
          lineDecorationsWidth: 4,
          glyphMargin: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          folding: true,
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
          padding: { top: 6, bottom: 6 },
          automaticLayout: true,
          // Widget tìm kiếm nổi ra ngoài khung — khung thấp thì ô tìm kiếm
          // không bị cắt mất một nửa.
          fixedOverflowWidgets: true,
          find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
        }}
      />
    </div>
  );
}
