'use client';

// Ô JSON của tab API — dùng cho CẢ ô soạn body lẫn ô xem response.
//
// VÌ SAO ĐỔI TỪ <textarea>/<pre> SANG MONACO: người dùng cần GẤP/MỞ từng khối
// JSON bằng nút +/- ở lề. Payload thật hay dài vài trăm dòng lồng nhiều tầng;
// không gấp được thì muốn xem field thứ hai ở cấp ngoài cùng phải cuộn qua cả
// một object con. Tự viết bộ gấp trên textarea nghĩa là tự viết cả parser lẫn
// phần vẽ lề — trong khi Monaco đã có sẵn, ĐÃ NẰM TRONG repo (tab Code/Tools/
// ES dùng rồi, tải từ /monaco local nên không thêm một byte mạng nào).
//
// Kèm theo, không mất công thêm: tô màu cú pháp, Ctrl+F có đếm số khớp, và
// gạch đỏ ngay dòng JSON sai.
//
// Ô SOẠN và Ô XEM chung một component để hai bên không trôi lệch kiểu chữ/màu
// mỗi lần chỉnh một bên — khác nhau đúng một cờ `readOnly`.

import '@/lib/monacoSetup'; // Monaco local /monaco/vs — phải config trước init đầu
import Editor, { type Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';

const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/** Theme khớp bảng màu app. Đăng ký một lần cho mỗi instance monaco. */
const themed = new WeakSet<object>();
function defineApiThemes(monaco: Monaco): void {
  if (themed.has(monaco)) return;
  themed.add(monaco);
  monaco.editor.defineTheme('api-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: '9CDCFE' },
      { token: 'string.value.json', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'keyword', foreground: '569CD6' },
    ],
    colors: {
      'editor.background': '#0c1020',
      'editor.foreground': '#dfe4f2',
      'editor.lineHighlightBackground': '#151b30',
      'editorLineNumber.foreground': '#3f4967',
      'editorLineNumber.activeForeground': '#8b9dff',
      'editorCursor.foreground': '#8b9dff',
      'editorIndentGuide.background1': '#1d2540',
      'scrollbarSlider.background': '#33405f80',
    },
  });
  monaco.editor.defineTheme('api-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#ffffff' },
  });
}

/** Theo theme app (html[data-theme]) — đổi theme là editor đổi theo. */
function useApiTheme(): string {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const read = () => setDark(document.documentElement.getAttribute('data-theme') !== 'light');
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return dark ? 'api-dark' : 'api-light';
}

export interface JsonBoxProps {
  value: string;
  /** Bỏ trống = chỉ đọc (ô xem response). */
  onChange?: (v: string) => void;
  /** Model path phải DUY NHẤT giữa các ô đang mount cùng lúc: trùng path là
   *  dùng chung model, nội dung hai ô sẽ đè lên nhau. */
  path: string;
  language?: 'json' | 'plaintext';
  height: number;
  placeholder?: string;
  /** Ctrl+Enter — ô soạn body dùng để bấm Send luôn. */
  onSubmit?: () => void;
}

export default function JsonBox({
  value, onChange, path, language = 'json', height, placeholder, onSubmit,
}: JsonBoxProps) {
  const theme = useApiTheme();
  // Giữ callback mới nhất trong ref: addCommand chỉ chạy lúc mount nên nó đóng
  // gói bản `onSubmit` của lượt render đầu — không có ref thì Ctrl+Enter gửi
  // đi bản draft cũ.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  return (
    <Editor
      path={path}
      language={language}
      theme={theme}
      value={value}
      onChange={onChange ? (v) => onChange(v ?? '') : undefined}
      beforeMount={defineApiThemes}
      onMount={(ed: editor.IStandaloneCodeEditor, monaco: Monaco) => {
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => submitRef.current?.());
      }}
      loading={<span className="spinner" aria-hidden />}
      height={height}
      options={{
        readOnly: !onChange,
        // Ô chỉ-đọc vẫn cho bôi đen + Ctrl+C, chỉ chặn con trỏ nhấp nháy.
        domReadOnly: !onChange,
        placeholder,
        fontSize: 12.5,
        fontFamily: MONO,
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 4,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
        // Trọng tâm của cả file này: nút +/- ở lề, LUÔN hiện (mặc định Monaco
        // chỉ hiện khi rê chuột vào lề — người dùng không biết là có).
        folding: true,
        showFoldingControls: 'always',
        foldingHighlight: true,
        renderLineHighlight: onChange ? 'line' : 'none',
        overviewRulerLanes: 0,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        padding: { top: 6, bottom: 6 },
        automaticLayout: true,
        fixedOverflowWidgets: true,
      }}
    />
  );
}
