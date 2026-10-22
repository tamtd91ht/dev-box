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
  esBodySuggestions,
  needsLeadingComma,
  formatEsQuery,
  ES_TEMPLATES,
  ES_BODY_TEMPLATES,
  type EsField,
  type EsQueryContext,
  type EsSuggestion,
} from '@/lib/esDsl';
import { defineEsThemes, useEsTheme, ES_MONO } from './esMonaco';
import { hasRefs, maskRefs } from '@/lib/esQueryVars';

const SCHEME = 'es-query';

/**
 * Ô này nhập gì: `query` = chỉ phần "query" (Tìm nhanh cũ) · `body` = NGUYÊN
 * body _search kiểu Kibana Dev Tools (query/aggs/sort/_source/size chung một ô).
 */
export type QueryEditorMode = 'query' | 'body';

const SUGGEST_BY_MODE: Record<QueryEditorMode, (ctx: EsQueryContext, fields: EsField[], text: string) => EsSuggestion[]> = {
  query: esSuggestions,
  body: esBodySuggestions,
};

const TEMPLATES_BY_MODE: Record<QueryEditorMode, typeof ES_TEMPLATES> = {
  query: ES_TEMPLATES,
  body: ES_BODY_TEMPLATES,
};

// Field + mode của từng model. Đây LUÔN là cổng gác của provider: model nào
// không có trong map thì không phải ô query ES → không gợi ý. Dùng WeakMap trên
// chính đối tượng model nên không phụ thuộc cách monaco chuẩn hoá uri, và model
// bị dispose là tự rụng khỏi map.
const metaByModel = new WeakMap<MonacoEditorNs.ITextModel, { fields: EsField[]; mode: QueryEditorMode; vars: QueryVarName[] }>();

/** Biến truy vấn gợi ý khi gõ `{{` (lib/esQueryVars). */
export interface QueryVarName { name: string; detail: string }

/** Đang gõ dở placeholder `{{…` ngay trước con trỏ. */
const VAR_PREFIX_RE = /\{\{\s*([\w.]*)$/;

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
    // Chỉ mở khi đang gõ token thật (mở nháy, `.` đi tới sub-field). Có `{ [ , :`
    // và dấu cách thì vừa bấm `{` đã bật bảng gợi ý — dễ chèn nhầm cả clause.
    // `{` chỉ để bắt `{{` (biến truy vấn) — một `{` đơn không gợi ý gì, xem nhánh dưới.
    triggerCharacters: ['"', '.', '{'],
    provideCompletionItems(model: MonacoEditorNs.ITextModel, position: MonacoPosition, ctxInfo: { triggerCharacter?: string }) {
      const meta = metaByModel.get(model);
      if (!meta) return { suggestions: [] }; // model .json khác (tab Code) — không đụng vào

      // Trong placeholder `{{…`: chỉ gợi ý tên biến (field sau dấu `.` để người dùng tự gõ).
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column,
      });
      const vm = VAR_PREFIX_RE.exec(linePrefix);
      if (vm) {
        if (vm[1].includes('.') || meta.vars.length === 0) return { suggestions: [] };
        const range = {
          startLineNumber: position.lineNumber, startColumn: position.column - vm[1].length,
          endLineNumber: position.lineNumber, endColumn: position.column,
        };
        // Đã có `}}` ngay sau con trỏ (auto-close / gõ lại tên) thì đừng chèn thêm.
        const after = model.getValueInRange({
          startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column + 2,
        });
        return {
          suggestions: meta.vars.map((v) => ({
            label: v.name,
            kind: K.Variable,
            detail: `biến · ${v.detail}`,
            insertText: after === '}}' ? v.name : `${v.name}}}`,
            range,
          })),
        };
      }
      if (ctxInfo.triggerCharacter === '{') return { suggestions: [] };

      const text = model.getValue();
      const ctx = esQueryContext(text, model.getOffsetAt(position));
      const items = SUGGEST_BY_MODE[meta.mode](ctx, meta.fields, text);
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
  /** Chữ mờ trong ô khi trống (như placeholder của input) — để ô tự mô tả nó là gì. */
  placeholder?: string;
  /** Ô nhập phần `query` (mặc định) hay nguyên `body` _search. */
  mode?: QueryEditorMode;
  /** Giãn ô soạn hết chiều cao khung cha (cột trái tab Dữ liệu) thay vì cao theo số dòng. */
  fill?: boolean;
  /** Biến truy vấn gợi ý khi gõ `{{` — có biến thì placeholder `{{…}}` cũng không bị coi là lỗi cú pháp. */
  varNames?: QueryVarName[];
  /** Yêu cầu chèn một biến (nút "Chèn vào body" ở hộp Biến) — đổi `seq` là chèn một lần. */
  insertVar?: { name: string; field: string; seq: number } | null;
  /** Báo đã chèn xong `seq` — cha nhớ lại để ô mount lại không chèn lần nữa. */
  onInsertDone?: (seq: number) => void;
}

const NO_VARS: QueryVarName[] = [];

/** Thoát ký tự đặc biệt của cú pháp snippet Monaco trong chữ điền sẵn. */
const snippetText = (s: string) => s.replace(/[$}\\]/g, (c) => `\\${c}`);

/**
 * Chèn biến: ô trống → dựng sẵn cả khung `terms` (con trỏ đứng ở tên field của index này để sửa ngay — điền sẵn tên
 * field của biến vì hai bên hay trùng tên); ô đã có nội dung → chỉ chèn `{{tên}}` tại con trỏ.
 */
function varSnippet(empty: boolean, name: string, field: string): string {
  if (!empty) return `{{${name}}}`;
  return `{\n  "query": {\n    "terms": {\n      "\${1:${snippetText(field.replace(/\.keyword$/i, '') || 'field')}}": {{${name}}}\n    }\n  }\n}`;
}

/** Format chịu được placeholder `{{q1.x}}` đứng trần: đổi tạm thành chuỗi, format, rồi trả lại. */
function formatWithVars(text: string) {
  const { masked, restore } = maskRefs(text);
  const r = formatEsQuery(masked);
  return r.ok ? { ...r, text: restore(r.text) } : r;
}

export default function QueryEditor({ value, onChange, onRun, fields = [], label, placeholder, mode = 'query', fill = false, varNames = NO_VARS, insertVar = null, onInsertDone }: QueryEditorProps) {
  const theme = useEsTheme();
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [modelPath] = useState(() => `${SCHEME}:/browser/q-${++seq}.json`);
  const [problem, setProblem] = useState<string | null>(null);
  const [formatErr, setFormatErr] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const runRef = useRef(onRun);
  runRef.current = onRun;

  // Provider chạy ngoài vòng đời React → đẩy field + mode vào registry mỗi lần đổi.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) metaByModel.set(model, { fields, mode, vars: varNames });
  }, [fields, mode, varNames, mounted]);

  const lines = Math.max(3, Math.min(value.split('\n').length + 1, 18));
  const height = lines * 19 + 14;

  const doFormat = useCallback(() => {
    const r = formatWithVars(value);
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

  // Chèn biến theo yêu cầu từ ngoài — theo `seq`, chèn lại cùng biến lần nữa vẫn chạy.
  const insertedSeq = useRef(0);
  useEffect(() => {
    if (!insertVar || !mounted || insertVar.seq === insertedSeq.current) return;
    insertedSeq.current = insertVar.seq;
    const empty = !(editorRef.current?.getValue() ?? value).trim();
    insertTemplate(varSnippet(empty, insertVar.name, insertVar.field));
    onInsertDone?.(insertVar.seq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertVar, mounted]);

  return (
    <div className={`es-qed${fill ? ' fill' : ''}`}>
      <div className="es-qed-bar">
        <span className="es-qed-label">
          {label ?? 'Query DSL — chỉ phần "query" (trống = match_all)'}
        </span>
        <span className="es-qed-tpls">
          {TEMPLATES_BY_MODE[mode].map((t) => (
            <button key={t.label} className="chip-btn" title={t.title} onClick={() => insertTemplate(t.body)}>
              {t.label}
            </button>
          ))}
        </span>
        <button className="chip-btn" title="Pretty-print JSON (Shift+Alt+F)" onClick={doFormat}>⟲ Format</button>
        <button className="chip-btn" title="Xoá nội dung" disabled={!value} onClick={() => { onChange(''); setFormatErr(null); }}>✕</button>
      </div>

      <div className="es-qed-box" style={fill ? undefined : { height }}>
        <Editor
          path={modelPath}
          language="json"
          theme={theme}
          value={value}
          onChange={(v) => { onChange(v ?? ''); setFormatErr(null); }}
          beforeMount={ensureEsSetup}
          onValidate={(markers) => {
            // Placeholder `{{q1.x}}` đứng trần không phải JSON — nếu thay nó bằng chuỗi mà body hợp lệ thì lỗi
            // của trình kiểm JSON chỉ là do placeholder: xoá cả gạch đỏ lẫn dòng báo lỗi.
            const model = editorRef.current?.getModel();
            const text = model?.getValue() ?? '';
            if (markers.length && model && monacoRef.current && hasRefs(text) && formatEsQuery(maskRefs(text).masked).ok) {
              monacoRef.current.editor.setModelMarkers(model, 'json', []);
              setProblem(null);
              return;
            }
            const err = markers.find((m) => m.severity === 8 /* MarkerSeverity.Error */);
            setProblem(err ? `dòng ${err.startLineNumber}: ${err.message}` : null);
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;
            const model = editor.getModel();
            if (model) metaByModel.set(model, { fields, mode, vars: varNames });
            setMounted(true);
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
            editor.addAction({
              id: 'es-format-query',
              label: 'Format JSON query',
              keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
              run: (ed) => {
                const r = formatWithVars(ed.getValue());
                if (!r.ok) { setFormatErr(r.error ?? 'JSON không hợp lệ'); return; }
                setFormatErr(null);
                ed.executeEdits('es-format', [{ range: ed.getModel()!.getFullModelRange(), text: r.text }]);
                ed.pushUndoStop();
              },
            });
          }}
          loading={<span className="spinner" aria-hidden />}
          options={{
            placeholder,
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
            // 'smart' = Enter CHỈ nhận gợi ý khi người dùng đã gõ gì đó để lọc
            // (đang sửa dở một từ). Vừa bấm `{` rồi Enter thì chưa gõ chữ nào
            // nên vẫn là XUỐNG DÒNG, không dính nguyên clause đầu danh sách —
            // đúng cái bẫy mà 'off' sinh ra để tránh, nhưng không bắt phải rời
            // tay sang Tab/chuột cho ca thường gặp.
            acceptSuggestionOnEnter: 'smart',
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
        Ctrl+Space gợi ý · Enter/Tab nhận gợi ý · Tab nhảy chỗ điền · Ctrl+Enter chạy · Shift+Alt+F format
        {varNames.length > 0 && <> · gõ <code>{'{{'}</code> để chèn biến</>}
      </p>
    </div>
  );
}
