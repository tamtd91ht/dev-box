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
import type { editor, languages, Position } from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { DYNAMIC_VARS } from '@/lib/apiVars';
import { tokenAt } from './VarInput';

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

// ── Gợi ý biến {{…}} trong ô body ───────────────────────────────────────────
//
// Provider đăng ký MỘT lần cho mỗi instance monaco, áp cho mọi model json/
// plaintext — nên phải tự lọc: chỉ model nằm trong bảng này (ô body đang soạn,
// có truyền `vars`) mới được gợi ý; ô xem response thì không.
const modelVars = new Map<string, { current: Record<string, string> }>();
const varsReady = new WeakSet<object>();

function registerVarCompletion(monaco: Monaco): void {
  if (varsReady.has(monaco)) return;
  varsReady.add(monaco);
  for (const lang of ['json', 'plaintext']) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['{'],
      provideCompletionItems(model: editor.ITextModel, pos: Position, context: languages.CompletionContext) {
        const ref = modelVars.get(model.uri.toString());
        if (!ref) return { suggestions: [] };
        const line = model.getLineContent(pos.lineNumber);
        const m = /\{\{\s*([\w.$-]*)$/.exec(line.slice(0, pos.column - 1));
        if (!m) return { suggestions: [] };
        // Nuốt luôn phần tên còn lại + `}}` sau con trỏ: chọn biến là THAY cả
        // token (JSON tự đóng ngoặc nên gõ `{{` thường đã có sẵn `}}` phía sau).
        const tail = /^([\w.$-]*)(\s*\}\})?/.exec(line.slice(pos.column - 1));
        const range = {
          startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber,
          startColumn: pos.column - m[1].length,
          endColumn: pos.column + (tail?.[0].length ?? 0),
        };
        const current = m[1] + (tail?.[1] ?? '');
        // Gọi TAY (Ctrl+Space, menu chuột phải, bôi đen) trên một biến đã đủ
        // `{{…}}` = muốn ĐỔI biến → hiện hết, không lọc theo tên đang có.
        const swap = context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke && !!tail?.[2] && !!current;
        const mk = (name: string, detail: string, group: string) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Variable,
          insertText: `${name}}}`,
          range,
          detail,
          sortText: `${name === current ? '0' : group}${name}`,
          filterText: swap ? m[1] + name : name,
        });
        return {
          suggestions: [
            ...Object.entries(ref.current).map(([k, v]) => mk(k, v || '(rỗng)', '1')),
            ...Object.entries(DYNAMIC_VARS).map(([k, d]) => mk(k, d.desc, '2')),
          ],
        };
      },
    });
  }
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
  language?: 'json' | 'plaintext' | 'xml' | 'html';
  /** Số px, hoặc '100%' để lấp đầy khung cha (khung cha phải có chiều cao xác định). */
  height: number | string;
  placeholder?: string;
  /** Ctrl+Enter — ô soạn body dùng để bấm Send luôn. */
  onSubmit?: () => void;
  /** Nhận editor sau khi mount — để nút ngoài (🔍 tìm) gọi được action của Monaco. */
  onEditor?: (ed: editor.IStandaloneCodeEditor) => void;
  /** Có = ô soạn có gợi ý biến: gõ `{{`, bôi đen một biến để đổi, chuột phải → Chèn / đổi biến. */
  vars?: Record<string, string>;
}

export default function JsonBox({
  value, onChange, path, language = 'json', height, placeholder, onSubmit, onEditor, vars,
}: JsonBoxProps) {
  const theme = useApiTheme();
  // Giữ callback mới nhất trong ref: addCommand chỉ chạy lúc mount nên nó đóng
  // gói bản `onSubmit` của lượt render đầu — không có ref thì Ctrl+Enter gửi
  // đi bản draft cũ.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  // Biến mới nhất cho provider (đọc qua ref, không phải đăng ký lại).
  const varsRef = useRef(vars ?? {});
  varsRef.current = vars ?? {};
  const [ed, setEd] = useState<editor.IStandaloneCodeEditor | null>(null);
  // Đổi tab request = Editor đổi MODEL ngay trong cùng instance (theo `path`),
  // nên đăng ký theo uri của model hiện tại, chạy lại mỗi khi path đổi.
  const withVars = !!vars;
  useEffect(() => {
    const uri = ed?.getModel()?.uri.toString();
    if (!uri || !withVars) return;
    modelVars.set(uri, varsRef);
    return () => { modelVars.delete(uri); };
  }, [ed, path, withVars]);

  return (
    <Editor
      path={path}
      language={language}
      theme={theme}
      value={value}
      onChange={onChange ? (v) => onChange(v ?? '') : undefined}
      beforeMount={(monaco) => { defineApiThemes(monaco); registerVarCompletion(monaco); }}
      onMount={(e: editor.IStandaloneCodeEditor, monaco: Monaco) => {
        e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => submitRef.current?.());
        if (withVars) {
          // Mục chuột phải: đứng trong một biến → đổi; ngoài → chèn `{{}}` rồi gợi ý.
          e.addAction({
            id: 'api.vars',
            label: 'Chèn / đổi biến {{…}}',
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 0,
            run: (x) => {
              const model = x.getModel();
              const pos = x.getPosition();
              if (!model || !pos) return;
              const line = model.getLineContent(pos.lineNumber);
              const tok = tokenAt(line, pos.column - 1, pos.column - 1);
              if (tok) {
                x.setPosition({ lineNumber: pos.lineNumber, column: tok.nameEnd + 1 });
              } else {
                const sel = x.getSelection();
                if (sel) x.executeEdits('api.vars', [{ range: sel, text: '{{}}' }]);
                const p2 = x.getPosition();
                if (p2) x.setPosition({ lineNumber: p2.lineNumber, column: p2.column - 2 });
              }
              x.trigger('api.vars', 'editor.action.triggerSuggest', {});
            },
          });
          // Bôi đen (một phần) một biến → mời đổi biến luôn, như ô một dòng.
          e.onDidChangeCursorSelection((ev) => {
            const s = ev.selection;
            if (s.isEmpty() || s.startLineNumber !== s.endLineNumber || ev.source === 'api') return;
            const model = e.getModel();
            if (!model) return;
            const line = model.getLineContent(s.startLineNumber);
            const tok = tokenAt(line, s.startColumn - 1, s.endColumn - 1);
            if (!tok || !tok.name) return;
            // Đặt con trỏ ngay cuối tên rồi gọi gợi ý: provider thấy `{{tên|}}`
            // và trả về đủ danh sách, chọn mục nào là thay cả token.
            e.setSelection({
              startLineNumber: s.startLineNumber, endLineNumber: s.startLineNumber,
              startColumn: tok.nameEnd + 1, endColumn: tok.nameEnd + 1,
            }, 'api');
            e.trigger('api.vars', 'editor.action.triggerSuggest', {});
          });
        }
        setEd(e);
        onEditor?.(e);
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
