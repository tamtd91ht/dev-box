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
import { tokenAt, isEditKey, isNavKey } from './VarInput';

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
/**
 * Biến đang được BÔI ĐEN TRỌN (click vào `{{tên}}`) theo model: gợi ý lúc đó
 * thay CẢ token `{{…}}` chứ không chỉ phần tên. Xoá khi vùng chọn đổi khác.
 */
const swaps = new Map<string, { line: number; start: number; end: number }>();

function registerVarCompletion(monaco: Monaco): void {
  if (varsReady.has(monaco)) return;
  varsReady.add(monaco);
  for (const lang of ['json', 'plaintext']) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['{'],
      provideCompletionItems(model: editor.ITextModel, pos: Position, context: languages.CompletionContext) {
        const ref = modelVars.get(model.uri.toString());
        if (!ref) return { suggestions: [] };
        const all = (mk: (name: string, detail: string, group: string) => languages.CompletionItem) => [
          ...Object.entries(ref.current).map(([k, v]) => mk(k, v || '(rỗng)', '1')),
          ...Object.entries(DYNAMIC_VARS).map(([k, d]) => mk(k, d.desc, '2')),
        ];
        // Đang bôi đen trọn một biến → mục chọn thay cả `{{…}}`, hiện đủ danh sách
        // (filterText mở đầu bằng chính token nên không mục nào bị lọc mất).
        const sw = swaps.get(model.uri.toString());
        if (sw && sw.line === pos.lineNumber && sw.end === pos.column) {
          const range = { startLineNumber: sw.line, endLineNumber: sw.line, startColumn: sw.start, endColumn: sw.end };
          const tokText = model.getValueInRange(range);
          const cur = /\{\{\s*([^{}\s]*)/.exec(tokText)?.[1] ?? '';
          return {
            suggestions: all((name, detail, group) => ({
              label: name,
              kind: monaco.languages.CompletionItemKind.Variable,
              insertText: `{{${name}}}`,
              range,
              detail,
              sortText: `${name === cur ? '0' : group}${name}`,
              filterText: tokText + name,
            })),
          };
        }
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
        return {
          suggestions: all((name, detail, group) => ({
            label: name,
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: `${name}}}`,
            range,
            detail,
            sortText: `${name === current ? '0' : group}${name}`,
            filterText: swap ? m[1] + name : name,
          })),
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
          /**
           * Bôi đen TRỌN biến đang chứa vùng chọn / con trỏ rồi mở gợi ý đổi biến.
           * Gõ / dán lúc đó là thay cả `{{tên}}` (vd "{{tenantId}}" → "23"), không
           * chèn chữ vào giữa tên. Trả false nếu không đứng trong biến nào.
           */
          /** Biến vừa được CLICK vào (cột 1-based, end loại trừ) — xem chốt chặn onKeyDown. */
          let armed: { line: number; start: number; end: number } | null = null;
          const selectToken = (x: editor.ICodeEditor): boolean => {
            const model = x.getModel();
            const sel = x.getSelection();
            if (!model || !sel || sel.startLineNumber !== sel.endLineNumber) return false;
            const ln = sel.startLineNumber;
            const tok = tokenAt(model.getLineContent(ln), sel.startColumn - 1, sel.endColumn - 1);
            if (!tok || !tok.name) return false;
            armed = { line: ln, start: tok.start + 1, end: tok.end + 1 };
            swaps.set(model.uri.toString(), armed);
            // Hướng chọn trái → phải: con trỏ nằm cuối token, khớp điều kiện của provider.
            x.setSelection({ startLineNumber: ln, endLineNumber: ln, startColumn: tok.start + 1, endColumn: tok.end + 1 }, 'api');
            x.trigger('api.vars', 'editor.action.triggerSuggest', {});
            return true;
          };
          // Mục chuột phải: đứng trong một biến → đổi; ngoài → chèn `{{}}` rồi gợi ý.
          e.addAction({
            id: 'api.vars',
            label: 'Chèn / đổi biến {{…}}',
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 0,
            run: (x) => {
              if (selectToken(x)) return;
              const sel = x.getSelection();
              if (sel) x.executeEdits('api.vars', [{ range: sel, text: '{{}}' }]);
              const p2 = x.getPosition();
              if (p2) x.setPosition({ lineNumber: p2.lineNumber, column: p2.column - 2 });
              x.trigger('api.vars', 'editor.action.triggerSuggest', {});
            },
          });
          // Click (hoặc double-click / kéo chọn gọn trong) VÀO một biến → bôi đen
          // trọn biến + gợi ý đổi. Click chỗ khác: như thường. Phím ← → vẫn đi
          // vào giữa tên được để sửa tay.
          //
          // HOÃN sang lượt sau: Monaco / Chromium còn xử lý nốt cú click SAU sự
          // kiện mouseup (click vào vùng đang bôi đen thì thu về con trỏ) — chọn
          // ngay tại đây là bị đặt lại mất.
          e.onMouseUp((ev) => {
            if (ev.event.rightButton) return;
            armed = null;
            setTimeout(() => { if (e.hasTextFocus()) selectToken(e); }, 0);
          });
          // CHỐT CHẶN: phím sửa đầu tiên sau khi click vào biến luôn thay / xoá
          // TRỌN `{{tên}}` — bôi đen lại ngay trước khi Monaco chèn ký tự, phòng
          // khi vùng chọn bị đặt lại. Đi bằng ← → = muốn sửa tay tên → thôi chặn.
          e.onKeyDown((kev) => {
            const b = kev.browserEvent;
            if (isNavKey(b)) { armed = null; return; }
            if (!armed || !isEditKey(b)) return;
            const a = armed;
            armed = null;
            const sel = e.getSelection();
            const model = e.getModel();
            if (!sel || !model || sel.startLineNumber !== a.line || sel.endLineNumber !== a.line) return;
            if (sel.startColumn < a.start || sel.endColumn > a.end) return;
            const tok = tokenAt(model.getLineContent(a.line), a.start - 1, a.start);
            if (!tok || tok.start + 1 !== a.start) return;
            const range = { startLineNumber: a.line, endLineNumber: a.line, startColumn: tok.start + 1, endColumn: tok.end + 1 };
            if (b.key === 'Backspace' || b.key === 'Delete') {
              // Xoá thẳng: phím xoá đi qua keybinding của Monaco, có thể chạy
              // trước khi vùng chọn mới kịp áp → tự xoá cho chắc, chặn phím gốc.
              kev.preventDefault();
              kev.stopPropagation();
              e.executeEdits('api.vars', [{ range, text: '' }]);
              return;
            }
            // Ký tự / dán: chỉ cần bôi đen — Monaco gõ đè lên vùng chọn hiện tại.
            e.setSelection(range, 'api');
          });
          // Vùng chọn rời khỏi token đã bôi đen → thôi chế độ thay cả token.
          e.onDidChangeCursorSelection((ev) => {
            if (ev.source === 'api') return;
            const uri = e.getModel()?.uri.toString();
            const sw = uri ? swaps.get(uri) : undefined;
            const s = ev.selection;
            if (uri && sw && !(s.startLineNumber === sw.line && s.startColumn === sw.start && s.endColumn === sw.end)) swaps.delete(uri);
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
