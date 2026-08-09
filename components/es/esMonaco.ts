'use client';

// Phần Monaco dùng chung của tab Elasticsearch: theme bám app + hook đọc theme.
// Tách riêng vì cả ô Query DSL (QueryEditor) lẫn tab Console đều cần, mà mỗi
// file lại tự đăng ký provider của mình.

import type { Monaco } from '@monaco-editor/react';
import { useEffect, useState } from 'react';

export const ES_MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

const themed = new WeakSet<object>();

/** Đăng ký theme sáng/tối khớp bảng màu app — chạy một lần mỗi instance monaco. */
export function defineEsThemes(monaco: Monaco): void {
  if (themed.has(monaco)) return;
  themed.add(monaco);

  monaco.editor.defineTheme('es-query-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: '9CDCFE' },
      { token: 'string.value.json', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'string.link', foreground: '4EC9B0' },
      { token: 'comment', foreground: '6b7594' },
    ],
    colors: {
      'editor.background': '#0c1020',
      'editor.foreground': '#dfe4f2',
      'editor.lineHighlightBackground': '#151b30',
      'editorLineNumber.foreground': '#3f4967',
      'editorLineNumber.activeForeground': '#8b9dff',
      'editorCursor.foreground': '#8b9dff',
      'editorIndentGuide.background1': '#1d2540',
      'editorWidget.background': '#101731',
      'editorSuggestWidget.background': '#101731',
      'editorSuggestWidget.selectedBackground': '#23305a',
      'editorSuggestWidget.border': '#2a3355',
      'scrollbarSlider.background': '#33405f80',
    },
  });

  monaco.editor.defineTheme('es-query-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'string.link', foreground: '0f766e' },
      { token: 'comment', foreground: '8a93aa' },
    ],
    colors: {
      'editor.background': '#fbfcff',
      'editor.lineHighlightBackground': '#eef1f9',
      'editorLineNumber.foreground': '#a3abc2',
    },
  });
}

/** Theme monaco bám theo data-theme của app (ThemeToggle đổi lúc nào cũng theo). */
export function useEsTheme(): 'es-query-dark' | 'es-query-light' {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const read = () => setDark(document.documentElement.getAttribute('data-theme') !== 'light');
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return dark ? 'es-query-dark' : 'es-query-light';
}
