'use client';

// Code Studio — editor pane: tab bar + Monaco với theme "Darcula" tự định nghĩa
// (bảng màu IntelliJ cho dân Java). Multi-model theo `path` nên mỗi file giữ
// riêng undo history + view state khi chuyển tab. Ctrl+S lưu file đang mở.
//
// Monaco được @monaco-editor/react tải từ CDN (jsdelivr) lần đầu — desktop app
// có mạng nên chấp nhận được; bundle offline là việc tối ưu sau.

import { useEffect, useRef } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { monacoLang, fileIcon } from '@/lib/code';

export interface OpenFile {
  rel: string;
  name: string;
  content: string;
  /** Nội dung như trên đĩa lúc đọc/lưu gần nhất — khác content = dirty. */
  savedContent: string;
  mtime: number;
  binary: boolean;
}

interface Props {
  files: OpenFile[];
  activeRel: string | null;
  onSelect: (rel: string) => void;
  onClose: (rel: string) => void;
  onChange: (rel: string, content: string) => void;
  onSave: (rel: string) => void;
}

/** IntelliJ Darcula — đăng ký một lần cho mỗi monaco instance. */
function defineDarcula(monaco: Monaco) {
  monaco.editor.defineTheme('darcula', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '808080' },
      { token: 'comment.doc', foreground: '629755', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'CC7832' },
      { token: 'number', foreground: '6897BB' },
      { token: 'string', foreground: '6A8759' },
      { token: 'type', foreground: 'A9B7C6' },
      { token: 'annotation', foreground: 'BBB529' },
      { token: 'tag', foreground: 'E8BF6A' },
      { token: 'attribute.name', foreground: 'BABABA' },
      { token: 'attribute.value', foreground: '6A8759' },
      { token: 'delimiter', foreground: 'A9B7C6' },
    ],
    colors: {
      'editor.background': '#2B2B2B',
      'editor.foreground': '#A9B7C6',
      'editor.lineHighlightBackground': '#323232',
      'editor.selectionBackground': '#214283',
      'editorCursor.foreground': '#BBBBBB',
      'editorLineNumber.foreground': '#606366',
      'editorLineNumber.activeForeground': '#A4A3A3',
      'editorGutter.background': '#313335',
      'editorIndentGuide.background1': '#373737',
      'editorWhitespace.foreground': '#3B3B3B',
      'scrollbarSlider.background': '#55555580',
      'scrollbarSlider.hoverBackground': '#66666690',
      'editorWidget.background': '#3C3F41',
      'input.background': '#45494A',
      'minimap.background': '#2B2B2B',
    },
  });
}

export default function EditorPane({ files, activeRel, onSelect, onClose, onChange, onSave }: Props) {
  const active = files.find((f) => f.rel === activeRel) ?? null;

  // Ctrl+S handler đọc file active MỚI NHẤT qua ref — addCommand chỉ gắn 1 lần.
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveRef.current = () => {
      if (active && active.content !== active.savedContent) onSave(active.rel);
    };
  }, [active, onSave]);

  if (!active) {
    return (
      <div className="cs-editor-empty">
        <div className="cs-empty-logo" aria-hidden>{'</>'}</div>
        <p>Chọn file bên trái để mở — hoặc chuột phải để tạo file mới.</p>
        <p className="cs-empty-hint">Ctrl+S lưu · nhiều tab · terminal ở dưới (⌨)</p>
      </div>
    );
  }

  return (
    <div className="cs-editor">
      <div className="cs-tabs" role="tablist">
        {files.map((f) => (
          <span key={f.rel} className={`cs-tab${f.rel === activeRel ? ' on' : ''}`} role="tab" aria-selected={f.rel === activeRel}>
            <button className="cs-tab-main" onClick={() => onSelect(f.rel)} title={f.rel}>
              <span aria-hidden>{fileIcon(f.name, 'file')}</span>
              <span className="cs-tab-name">{f.name}</span>
              {f.content !== f.savedContent && <span className="cs-dirty" title="Chưa lưu (Ctrl+S)">●</span>}
            </button>
            <button
              className="cs-tab-x"
              title="Đóng tab"
              onClick={() => {
                if (f.content !== f.savedContent && !window.confirm(`"${f.name}" chưa lưu — đóng và bỏ thay đổi?`)) return;
                onClose(f.rel);
              }}
            >
              ✕
            </button>
          </span>
        ))}
      </div>

      {active.binary ? (
        <div className="cs-editor-empty">
          <p>File nhị phân — không mở được trong editor.</p>
        </div>
      ) : (
        <div className="cs-monaco">
          <Editor
            path={active.rel}
            defaultValue={active.content}
            language={monacoLang(active.name)}
            theme="darcula"
            beforeMount={defineDarcula}
            onMount={(editor, monaco) => {
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
            }}
            onChange={(v) => onChange(active.rel, v ?? '')}
            options={{
              fontSize: 13,
              fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
              fontLigatures: true,
              minimap: { enabled: true, scale: 1 },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderWhitespace: 'none',
              tabSize: 4,
              detectIndentation: true,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              padding: { top: 6 },
            }}
          />
        </div>
      )}
    </div>
  );
}
