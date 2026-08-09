'use client';

// Ô nhập Query DSL của tab Elasticsearch — Monaco (JSON) thay cho <textarea>,
// với trải nghiệm gần Kibana Dev Tools:
//   · gợi ý theo NGỮ CẢNH: ở gốc/trong `filter` → tên clause (bool, term, terms,
//     match, range…); trong `bool` → must/should/filter/must_not; trong
//     `{"term": {│}}` → TÊN FIELD THẬT lấy từ mapping của index; trong
//     `{"range": {"ts": {│}}}` → gte/gt/lte/lt…  (logic ở lib/esDsl.ts)
//   · chọn gợi ý là chèn luôn khung JSON (snippet có placeholder, Tab để nhảy)
//   · nút "Format" + Shift+Alt+F: pretty-print, chịu được cả JSON "lỏng" copy từ
//     log (key không nháy, nháy đơn, dấu phẩy thừa)
//   · chip mẫu sẵn cho các dạng hay dùng · báo lỗi cú pháp ngay dưới ô nhập
//   · Ctrl/⌘+Enter = chạy query
//
// Completion provider đăng ký trên language 'json' nhưng CHỈ chạy cho model có
// uri scheme `es-query:` — để không lây gợi ý ES sang editor .json ở tab Code.

import '@/lib/monacoSetup'; // Monaco local /monaco/vs — phải config trước lần init đầu
import Editor, { type Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs, Position as MonacoPosition } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  esQueryContext,
  esSuggestions,
  needsLeadingComma,
  formatEsQuery,
  ES_TEMPLATES,
  type EsField,
} from '@/lib/esDsl';
import { defineEsThemes, useEsTheme, ES_MONO } from './esMonaco';

const SCHEME = 'es-query';

// Field của index theo từng model. Đây LUÔN là cổng gác của provider: model nào
// không có trong map thì không phải ô query ES → không gợi ý. Dùng WeakMap trên
// chính đối tượng model nên không phụ thuộc cách monaco chuẩn hoá uri, và model
// bị dispose là tự rụng khỏi map.
const fieldsByModel = new WeakMap<MonacoEditorNs.ITextModel, EsField[]>();

const wired = new WeakSet<object>();
let seq = 0;

function ensureEsSetup(monaco: Monaco) {
  defineEsThemes(monaco);
  if (wired.has(monaco)) return;
  wired.add(monaco);

  const K = monaco.languages.CompletionItemKind;
  const kindOf: Record<string, number> = {
    clause: K.Class,
    option: K.Property,
    field: K.Field,
    value: K.Value,
  };

  monaco.languages.registerCompletionItemProvider('json', {
    triggerCharacters: ['"', ':', ',', '{', '[', ' ', '.'],
    provideCompletionItems(model: MonacoEditorNs.ITextModel, position: MonacoPosition) {
      const fields = fieldsByModel.get(model);
      if (!fields) return { suggestions: [] }; // model .json khác (tab Code) — không đụng vào

      const text = model.getValue();
      const ctx = esQueryContext(text, model.getOffsetAt(position));
      const items = esSuggestions(ctx, fields);
      if (items.length === 0) return { suggestions: [] };

      const start = model.getPositionAt(ctx.replaceStart);
      const end = model.getPositionAt(ctx.replaceEnd);
      const range = {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
      // Vùng thay thế ôm cả dấu nháy đang gõ dở → phần người dùng đã gõ bắt đầu
      // bằng `"`, nên filterText cũng phải có `"` thì monaco mới lọc đúng.
      const quoted = text[ctx.replaceStart] === '"';
      const comma = needsLeadingComma(ctx) ? ', ' : '';

      return {
        suggestions: items.map((it) => ({
          label: it.label,
          kind: kindOf[it.kind] ?? K.Text,
          detail: it.detail,
          documentation: it.doc ? { value: it.doc } : undefined,
          insertText: comma + it.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          filterText: quoted ? `"${it.label}` : it.label,
          sortText: it.sort,
          range,
        })),
      };
    },
  });
}

export interface QueryEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** Ctrl/⌘+Enter trong editor. */
  onRun: () => void;
  /** Field lấy từ mapping của index đang chọn — dùng để gợi ý tên field. */
  fields?: EsField[];
  /** Nhãn nhỏ phía trên ô nhập. */
  label?: string;
}

export default function QueryEditor({ value, onChange, onRun, fields = [], label }: QueryEditorProps) {
  const theme = useEsTheme();
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const [modelPath] = useState(() => `${SCHEME}:/browser/q-${++seq}.json`);
  const [problem, setProblem] = useState<string | null>(null);
  const [formatErr, setFormatErr] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const runRef = useRef(onRun);
  runRef.current = onRun;

  // Provider chạy ngoài vòng đời React → đẩy field vào registry mỗi lần đổi.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) fieldsByModel.set(model, fields);
  }, [fields, mounted]);

  const lines = Math.max(3, Math.min(value.split('\n').length + 1, 18));
  const height = lines * 19 + 14;

  const doFormat = useCallback(() => {
    const r = formatEsQuery(value);
    if (!r.ok) { setFormatErr(r.error ?? 'JSON không hợp lệ'); return; }
    setFormatErr(null);
    if (r.text !== value) onChange(r.text);
  }, [value, onChange]);

  const insertTemplate = useCallback((body: string) => {
    const ed = editorRef.current;
    if (!ed) { onChange(body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$0/g, '')); return; }
    ed.focus();
    if (!ed.getValue().trim()) ed.setValue('');
    const snippets = ed.getContribution('snippetController2') as unknown as
      { insert?: (t: string) => void } | null;
    if (snippets?.insert) snippets.insert(body);
    else ed.trigger('es-tpl', 'type', { text: body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$0/g, '') });
  }, [onChange]);

  return (
    <div className="es-qed">
      <div className="es-qed-bar">
        <span className="es-qed-label">{label ?? 'Query DSL — chỉ phần "query" (trống = match_all)'}</span>
        <span className="es-qed-tpls">
          {ES_TEMPLATES.map((t) => (
            <button key={t.label} className="chip-btn" title={t.title} onClick={() => insertTemplate(t.body)}>
              {t.label}
            </button>
          ))}
        </span>
        <button className="chip-btn" title="Pretty-print JSON (Shift+Alt+F)" onClick={doFormat}>⟲ Format</button>
        <button className="chip-btn" title="Xoá nội dung query" disabled={!value} onClick={() => { onChange(''); setFormatErr(null); }}>✕</button>
      </div>

      <div className="es-qed-box" style={{ height }}>
        <Editor
          path={modelPath}
          language="json"
          theme={theme}
          value={value}
          onChange={(v) => { onChange(v ?? ''); setFormatErr(null); }}
          beforeMount={ensureEsSetup}
          onValidate={(markers) => {
            const err = markers.find((m) => m.severity === 8 /* MarkerSeverity.Error */);
            setProblem(err ? `dòng ${err.startLineNumber}: ${err.message}` : null);
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            const model = editor.getModel();
            if (model) fieldsByModel.set(model, fields);
            setMounted(true);
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
            editor.addAction({
              id: 'es-format-query',
              label: 'Format JSON query',
              keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
              run: (ed) => {
                const r = formatEsQuery(ed.getValue());
                if (!r.ok) { setFormatErr(r.error ?? 'JSON không hợp lệ'); return; }
                setFormatErr(null);
                ed.executeEdits('es-format', [{ range: ed.getModel()!.getFullModelRange(), text: r.text }]);
                ed.pushUndoStop();
              },
            });
          }}
          loading={<span className="spinner" aria-hidden />}
          options={{
            fontSize: 12.5,
            fontFamily: ES_MONO,
            lineNumbers: 'on',
            lineNumbersMinChars: 2,
            lineDecorationsWidth: 4,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            folding: true,
            renderLineHighlight: 'line',
            overviewRulerLanes: 0,
            scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            padding: { top: 6, bottom: 6 },
            // Key JSON nằm trong chuỗi — không bật strings thì gõ `"te` không gợi ý.
            quickSuggestions: { other: true, strings: true, comments: false },
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnEnter: 'on',
            tabCompletion: 'on',
            formatOnPaste: true,
            automaticLayout: true,
            fixedOverflowWidgets: true,
          }}
        />
      </div>

      {(formatErr ?? problem) && (
        <p className="es-qed-err">⚠ {formatErr ?? problem}</p>
      )}
      <p className="es-hint es-qed-hint">
        Ctrl+Space gợi ý · Tab nhảy chỗ điền · Ctrl+Enter chạy · Shift+Alt+F format
      </p>
    </div>
  );
}
