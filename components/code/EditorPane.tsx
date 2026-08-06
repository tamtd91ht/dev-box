'use client';

// Code Studio — editor pane: tab bar + Monaco theme "Darcula" + hạ tầng
// NAVIGATION nối vào symbol index server (lib/codeSearch.ts):
//
//   • DefinitionProvider  → Ctrl+Click / Ctrl+B / F12 nhảy đúng khai báo,
//     kể cả file CHƯA MỞ (EditorOpener chặn URI lạ → mở tab mới đúng dòng)
//   • HoverProvider       → rê chuột lên symbol thấy dòng khai báo + vị trí
//   • CompletionProvider  → autocomplete tên class/method/hằng toàn project
//   • Find Usages (Alt+F7 / chuột phải) → panel dưới editor, click nhảy tới
//
// Model Monaco đặt path "<projectId>/<rel>" — nhiều project mở song song thì
// hai file trùng rel (vd. pom.xml) không đè model của nhau. Providers đăng ký
// MỘT LẦN cho cả app (module singleton); mỗi EditorPane chỉ ghi danh callback
// openAt của workspace mình vào registry theo projectId.

import { useCallback, useEffect, useRef, useState } from 'react';
import '@/lib/monacoSetup'; // Monaco local /monaco/vs — phải config trước lần init đầu
import Editor, { type Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs, Position as MonacoPosition, Uri as MonacoUri, IRange } from 'monaco-editor';
import {
  monacoLang, fileIcon, symbolIcon, cDefs, cUsages, cCallGraph, cCompletions,
  type SymbolKind, type TextHit,
} from '@/lib/code';

export interface OpenFile {
  rel: string;
  name: string;
  content: string;
  savedContent: string;
  mtime: number;
  binary: boolean;
}

export interface RevealTarget {
  rel: string;
  line: number;
  /** Đổi seq để reveal lại cùng một dòng. */
  seq: number;
}

interface Props {
  projectId: string;
  files: OpenFile[];
  activeRel: string | null;
  reveal: RevealTarget | null;
  onSelect: (rel: string) => void;
  onClose: (rel: string) => void;
  onChange: (rel: string, content: string) => void;
  onSave: (rel: string) => void;
  /** Mở file (fetch nếu cần) và nhảy tới dòng — dùng bởi definition/usages. */
  onOpenAt: (rel: string, line?: number) => void;
  onOpenPalette: () => void;
}

// ── Global registries (module singleton — bundle client chỉ có một) ──────────

/** projectId → openAt của workspace đang mount. */
const openAtRegistry = new Map<string, (rel: string, line?: number) => void>();

/** Completion symbols cache theo project (TTL 60s). */
const completionCache = new Map<string, { ts: number; symbols: { name: string; kind: SymbolKind }[] }>();

const NAV_LANGS = [
  'java', 'kotlin', 'typescript', 'javascript', 'python', 'go', 'csharp', 'php',
  'cpp', 'c', 'sql', 'xml', 'yaml', 'json', 'shell', 'powershell', 'ini', 'plaintext',
];
const COMPLETION_LANGS = ['java', 'kotlin', 'typescript', 'javascript', 'python', 'go', 'csharp', 'php'];

/** "/myproject/src/Main.java" → { projectId: 'myproject', rel: 'src/Main.java' } */
function splitModelPath(path: string): { projectId: string; rel: string } | null {
  const p = path.replace(/^\/+/, '');
  const i = p.indexOf('/');
  if (i <= 0) return null;
  return { projectId: p.slice(0, i), rel: p.slice(i + 1) };
}

let providersReady = false;
function ensureProviders(monaco: Monaco) {
  if (providersReady) return;
  providersReady = true;

  // Ctrl+Click / F12: hỏi server defs theo word, trả Location — URI của file
  // chưa mở sẽ đi qua EditorOpener bên dưới.
  for (const lang of NAV_LANGS) {
    monaco.languages.registerDefinitionProvider(lang, {
      provideDefinition: async (model: MonacoEditorNs.ITextModel, position: MonacoPosition) => {
        const loc = splitModelPath(model.uri.path);
        const word = model.getWordAtPosition(position);
        if (!loc || !word) return null;
        try {
          const { defs } = await cDefs(loc.projectId, word.word);
          return defs.slice(0, 20).map((d) => ({
            uri: monaco.Uri.from({ scheme: 'file', path: `/${loc.projectId}/${d.rel}` }),
            range: new monaco.Range(d.line, 1, d.line, 1),
          }));
        } catch {
          return null;
        }
      },
    });

    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model: MonacoEditorNs.ITextModel, position: MonacoPosition) => {
        const loc = splitModelPath(model.uri.path);
        const word = model.getWordAtPosition(position);
        if (!loc || !word) return null;
        try {
          const { defs } = await cDefs(loc.projectId, word.word);
          if (!defs.length) return null;
          const top = defs.slice(0, 3);
          return {
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            contents: top.map((d) => ({
              value: `**${symbolIcon(d.kind)} ${d.name}** · \`${d.rel}:${d.line}\`\n\`\`\`java\n${d.sig}\n\`\`\``,
            })),
          };
        } catch {
          return null;
        }
      },
    });
  }

  // monaco.languages.CompletionItemKind: Method=0, Class=5, Interface=7, Constant=14, Enum=15
  const KIND_MAP: Record<SymbolKind, number> = {
    class: 5, interface: 7, enum: 15, record: 5, object: 5, trait: 7,
    method: 0, constant: 14,
  };

  for (const lang of COMPLETION_LANGS) {
    monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems: async (model: MonacoEditorNs.ITextModel, position: MonacoPosition) => {
        const loc = splitModelPath(model.uri.path);
        const word = model.getWordUntilPosition(position);
        if (!loc || word.word.length < 2) return { suggestions: [] };
        let cached = completionCache.get(loc.projectId);
        if (!cached || Date.now() - cached.ts > 60_000) {
          try {
            const { symbols } = await cCompletions(loc.projectId);
            cached = { ts: Date.now(), symbols };
            completionCache.set(loc.projectId, cached);
          } catch {
            return { suggestions: [] };
          }
        }
        const prefix = word.word.toLowerCase();
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        return {
          suggestions: cached.symbols
            .filter((s) => s.name.toLowerCase().startsWith(prefix))
            .slice(0, 100)
            .map((s) => ({
              label: s.name,
              kind: (KIND_MAP[s.kind] ?? 18) as never,
              insertText: s.name,
              range,
              detail: s.kind,
            })),
        };
      },
    });
  }

  // File chưa có model (chưa mở tab) → Monaco gọi opener này thay vì bó tay.
  monaco.editor.registerEditorOpener({
    openCodeEditor: (
      _source: MonacoEditorNs.ICodeEditor,
      resource: MonacoUri,
      selectionOrPosition?: IRange | MonacoPosition,
    ) => {
      const loc = splitModelPath(resource.path);
      if (!loc) return false;
      const openAt = openAtRegistry.get(loc.projectId);
      if (!openAt) return false;
      let line: number | undefined;
      if (selectionOrPosition && 'startLineNumber' in selectionOrPosition) line = selectionOrPosition.startLineNumber;
      else if (selectionOrPosition && 'lineNumber' in selectionOrPosition) line = selectionOrPosition.lineNumber;
      openAt(loc.rel, line);
      return true;
    },
  });
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

interface UsagesState {
  word: string;
  hits: TextHit[];
  truncated: boolean;
  loading: boolean;
}

interface CallGraphState {
  word: string;
  loading: boolean;
  callers: { enclosing: string; enclosingType?: string; rel: string; line: number; preview: string }[];
  callees: { name: string; rel: string; line: number; sig: string; callLine: number }[];
  truncated: boolean;
}

export default function EditorPane({
  projectId, files, activeRel, reveal, onSelect, onClose, onChange, onSave, onOpenAt, onOpenPalette,
}: Props) {
  const active = files.find((f) => f.rel === activeRel) ?? null;
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [usages, setUsages] = useState<UsagesState | null>(null);
  const [callg, setCallg] = useState<CallGraphState | null>(null);

  // Refs cho handler gắn 1 lần trong onMount.
  const saveRef = useRef<() => void>(() => {});
  const paletteRef = useRef(onOpenPalette);
  paletteRef.current = onOpenPalette;
  const usagesRef = useRef<(word: string) => void>(() => {});
  const callgRef = useRef<(word: string) => void>(() => {});

  useEffect(() => {
    saveRef.current = () => {
      if (active && active.content !== active.savedContent) onSave(active.rel);
    };
  }, [active, onSave]);

  // Ghi danh openAt cho EditorOpener (Ctrl+Click sang file chưa mở).
  useEffect(() => {
    openAtRegistry.set(projectId, onOpenAt);
    return () => {
      if (openAtRegistry.get(projectId) === onOpenAt) openAtRegistry.delete(projectId);
    };
  }, [projectId, onOpenAt]);

  const runUsages = useCallback(async (word: string) => {
    setUsages({ word, hits: [], truncated: false, loading: true });
    try {
      const r = await cUsages(projectId, word, activeRel ?? undefined);
      setUsages({ word, hits: r.hits, truncated: r.truncated, loading: false });
    } catch {
      setUsages((u) => (u && u.word === word ? { ...u, loading: false } : u));
    }
  }, [projectId, activeRel]);
  usagesRef.current = (w) => void runUsages(w);

  const runCallGraph = useCallback(async (word: string) => {
    setUsages(null); // hai panel dùng chung chỗ — mở call graph thì đóng usages
    setCallg({ word, loading: true, callers: [], callees: [], truncated: false });
    try {
      const r = await cCallGraph(projectId, word);
      setCallg({ word, loading: false, callers: r.callers, callees: r.callees, truncated: r.truncated });
    } catch {
      setCallg((c) => (c && c.word === word ? { ...c, loading: false } : c));
    }
  }, [projectId]);
  callgRef.current = (w) => void runCallGraph(w);

  // Reveal: nhảy tới dòng khi file active khớp target (mở từ palette/usages/defs).
  useEffect(() => {
    if (!reveal || !active || active.rel !== reveal.rel) return;
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    const t = setTimeout(() => {
      ed.revealLineInCenter(reveal.line);
      ed.setPosition({ lineNumber: reveal.line, column: 1 });
      ed.focus();
      // Flash dòng đích ~1.2s cho dễ thấy.
      const ids = ed.deltaDecorations([], [{
        range: new monaco.Range(reveal.line, 1, reveal.line, 1),
        options: { isWholeLine: true, className: 'cs-flash-line' },
      }]);
      setTimeout(() => ed.deltaDecorations(ids, []), 1200);
    }, 60);
    return () => clearTimeout(t);
  }, [reveal, active]);

  if (!active) {
    return (
      <div className="cs-editor-empty">
        <div className="cs-empty-logo" aria-hidden>{'</>'}</div>
        <p>Chọn file bên trái để mở — hoặc Ctrl+Shift+N tìm class/file.</p>
        <p className="cs-empty-hint">Ctrl+S lưu · Ctrl+Click đến khai báo · Alt+F7 find usages · Ctrl+Alt+H call hierarchy</p>
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
            path={`${projectId}/${active.rel}`}
            defaultValue={active.content}
            language={monacoLang(active.name)}
            theme="darcula"
            beforeMount={(monaco) => {
              defineDarcula(monaco);
              ensureProviders(monaco);
            }}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              monacoRef.current = monaco;
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
              editor.addCommand(
                monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyN,
                () => paletteRef.current(),
              );
              // Ctrl+B = Go to Declaration (dùng DefinitionProvider phía trên).
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => {
                editor.trigger('cs', 'editor.action.revealDefinition', null);
              });
              editor.addAction({
                id: 'cs-find-usages',
                label: 'Find Usages',
                keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F7],
                contextMenuGroupId: 'navigation',
                contextMenuOrder: 1.5,
                run: (ed) => {
                  const pos = ed.getPosition();
                  const w = pos && ed.getModel()?.getWordAtPosition(pos);
                  if (w) usagesRef.current(w.word);
                },
              });
              // Call Hierarchy: đứng ở tên hàm → thấy ai gọi + nó gọi ai.
              editor.addAction({
                id: 'cs-call-hierarchy',
                label: 'Call Hierarchy — ai gọi / gọi ai',
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyH],
                contextMenuGroupId: 'navigation',
                contextMenuOrder: 1.6,
                run: (ed) => {
                  const pos = ed.getPosition();
                  const w = pos && ed.getModel()?.getWordAtPosition(pos);
                  if (w) callgRef.current(w.word);
                },
              });
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
              definitionLinkOpensInPeek: false,
            }}
          />
        </div>
      )}

      {/* ── Panel Find Usages ── */}
      {usages && (
        <div className="cs-usages">
          <div className="cs-usages-head">
            <span>
              🔎 Usages của <b>{usages.word}</b>
              {usages.loading
                ? ' — đang quét…'
                : ` — ${usages.hits.length} kết quả${usages.truncated ? ' (đã cắt bớt)' : ''}`}
            </span>
            {usages.loading && <span className="spinner" aria-hidden />}
            <span style={{ flex: 1 }} />
            <button className="cs-tab-x" title="Đóng" onClick={() => setUsages(null)}>✕</button>
          </div>
          <div className="cs-usages-list">
            {usages.hits.map((h, i) => (
              <button key={`${h.rel}:${h.line}:${i}`} className="cs-usage-row" onClick={() => onOpenAt(h.rel, h.line)} title={`${h.rel}:${h.line}`}>
                <span className="cs-usage-loc">{h.rel}:{h.line}</span>
                <span className="cs-usage-prev">{h.preview}</span>
              </button>
            ))}
            {!usages.loading && usages.hits.length === 0 && (
              <div className="cs-pal-empty">Không thấy usage nào.</div>
            )}
          </div>
        </div>
      )}

      {/* ── Panel Call Hierarchy (callers / callees) ── */}
      {callg && (
        <div className="cs-usages">
          <div className="cs-usages-head">
            <span>
              🔗 Call hierarchy: <b>{callg.word}()</b>
              {callg.loading ? ' — đang phân tích…' : ` — ${callg.callers.length} nơi gọi · ${callg.callees.length} hàm được gọi${callg.truncated ? ' (cắt bớt)' : ''}`}
            </span>
            {callg.loading && <span className="spinner" aria-hidden />}
            <span style={{ flex: 1 }} />
            <button className="cs-tab-x" title="Đóng" onClick={() => setCallg(null)}>✕</button>
          </div>
          <div className="cs-usages-list">
            {!callg.loading && (
              <>
                <div className="cs-ch-section">⬆ Được gọi từ (callers)</div>
                {callg.callers.map((c, i) => (
                  <button key={`cr-${c.rel}:${c.line}:${i}`} className="cs-usage-row" onClick={() => onOpenAt(c.rel, c.line)} title={`${c.rel}:${c.line}`}>
                    <span className="cs-usage-loc">{c.enclosingType ? `${c.enclosingType}.` : ''}{c.enclosing}</span>
                    <span className="cs-usage-prev">{c.rel}:{c.line} · {c.preview}</span>
                  </button>
                ))}
                {callg.callers.length === 0 && <div className="cs-pal-empty">Không thấy nơi gọi (có thể gọi động/qua interface).</div>}

                <div className="cs-ch-section">⬇ Gọi tới (callees)</div>
                {callg.callees.map((c, i) => (
                  <button key={`ce-${c.rel}:${c.line}:${i}`} className="cs-usage-row" onClick={() => onOpenAt(c.rel, c.line)} title={`${c.rel}:${c.line}`}>
                    <span className="cs-usage-loc">{c.name}()</span>
                    <span className="cs-usage-prev">{c.rel}:{c.line} · {c.sig}</span>
                  </button>
                ))}
                {callg.callees.length === 0 && <div className="cs-pal-empty">Không rút được lời gọi nào trong thân hàm.</div>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
