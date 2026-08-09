'use client';

// Tab Console — Dev Tools của Kibana thu nhỏ, chạy thẳng vào cluster đang chọn.
//
//   · Gõ NGUYÊN lệnh REST: `GET my_index/_search` + body JSON bên dưới. Nhiều
//     lệnh sống chung một editor, Ctrl+Enter chạy lệnh đang đặt con trỏ (lệnh
//     đó được kẻ viền trái để biết mình sắp chạy cái nào).
//   · Autocomplete: dòng lệnh gợi ý method → tên index thật → endpoint
//     (_search/_count/_mapping…); trong body gợi ý key của body (size, sort,
//     aggs…), clause Query DSL và TÊN FIELD lấy từ mapping của index trong lệnh.
//   · Lịch sử lệnh lưu ở localStorage — bấm để nạp lại vào editor.
//   · Nội dung editor cũng được nhớ, mở lại tab là còn nguyên.
//
// READ-ONLY: server chỉ nhận GET/HEAD/POST và chặn mọi endpoint đổi trạng thái
// (xem consoleRequest trong lib/esClient.ts) — lệnh ghi bị từ chối kèm lý do.

import '@/lib/monacoSetup'; // Monaco local /monaco/vs — phải config trước lần init đầu
import Editor, { type Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs, Position as MonacoPosition } from 'monaco-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  esConsole,
  listEsIndices,
  esMapping,
  fmtCount,
  type PublicEsConnection,
  type EsConsoleResult,
} from '@/lib/es';
import {
  esQueryContext,
  esBodySuggestions,
  needsLeadingComma,
  flattenEsMapping,
  type EsField,
} from '@/lib/esDsl';
import {
  parseConsoleRequests,
  requestAtLine,
  loadEsConsoleHistory,
  pushEsConsoleHistory,
  removeEsConsoleHistory,
  clearEsConsoleHistory,
  historyToText,
  loadEsConsoleDraft,
  saveEsConsoleDraft,
  type EsConsoleHistoryEntry,
} from '@/lib/esConsole';
import { defineEsThemes, useEsTheme, ES_MONO } from './esMonaco';

const LANG = 'es-console';

/** Ngữ cảnh cho autocomplete của từng model console (index + field theo index). */
interface ConsoleCtx {
  indices: string[];
  fieldsOf: (index: string | null) => EsField[];
}
const ctxByModel = new WeakMap<MonacoEditorNs.ITextModel, () => ConsoleCtx>();

const METHODS: { name: string; detail: string }[] = [
  { name: 'GET', detail: 'đọc — dùng được với mọi endpoint đọc' },
  { name: 'POST', detail: 'chỉ cho _search / _count / _mget / _msearch…' },
  { name: 'HEAD', detail: 'kiểm tra tồn tại (không có body)' },
];

/** Endpoint gõ ở gốc (không kèm index). */
const ROOT_ENDPOINTS: [string, string][] = [
  ['_cat/indices?v&s=store.size:desc', 'danh sách index, sắp theo dung lượng'],
  ['_cat/nodes?v', 'node + heap/cpu/disk'],
  ['_cat/health?v', 'sức khoẻ cluster (dạng bảng)'],
  ['_cat/aliases?v', 'alias đang có'],
  ['_cat/shards?v', 'phân bố shard'],
  ['_cat/count', 'tổng số document'],
  ['_cluster/health', 'sức khoẻ cluster (JSON)'],
  ['_cluster/stats', 'thống kê toàn cluster'],
  ['_cluster/settings', 'setting cluster'],
  ['_nodes/stats', 'thống kê chi tiết theo node'],
  ['_alias', 'toàn bộ alias'],
  ['_mapping', 'mapping mọi index'],
  ['_search', 'search toàn cluster'],
  ['_resolve/index/*', 'giải alias / index pattern'],
];

/** Endpoint gõ sau tên index. */
const INDEX_ENDPOINTS: [string, string][] = [
  ['_search', 'tìm document'],
  ['_count', 'đếm document khớp'],
  ['_mapping', 'mapping của index'],
  ['_settings', 'settings của index'],
  ['_stats', 'thống kê index'],
  ['_field_caps?fields=*', 'kiểu dữ liệu của từng field'],
  ['_analyze', 'thử analyzer trên một chuỗi'],
  ['_alias', 'alias trỏ vào index'],
  ['_doc/', 'lấy một document theo _id'],
];

/** Tên index trong đường dẫn (null nếu lệnh không nhắm vào index nào). */
function pathIndex(p: string): string | null {
  const first = p.replace(/^\//, '').split('?')[0].split('/')[0];
  return first && !first.startsWith('_') && !first.includes('*') ? first : null;
}

const wired = new WeakSet<object>();

function ensureConsoleSetup(monaco: Monaco) {
  defineEsThemes(monaco);
  if (wired.has(monaco)) return;
  wired.add(monaco);

  monaco.languages.register({ id: LANG });
  monaco.languages.setLanguageConfiguration(LANG, {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });
  // Tô màu tối thiểu: dòng lệnh (method + path), comment, và JSON của body.
  monaco.languages.setMonarchTokensProvider(LANG, {
    tokenizer: {
      root: [
        [/^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)(\s+)(\S+)/, ['keyword', 'white', 'string.link']],
        [/^\s*(#|\/\/).*$/, 'comment'],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
        [/"(?:[^"\\]|\\.)*"/, 'string.value.json'],
        [/-?\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
        [/\b(true|false|null)\b/, 'keyword'],
        [/[{}[\]]/, 'delimiter.bracket'],
        [/[,:]/, 'delimiter'],
      ],
    },
  });

  const K = monaco.languages.CompletionItemKind;
  const kindOf: Record<string, number> = {
    clause: K.Class, option: K.Property, field: K.Field, value: K.Value,
  };

  monaco.languages.registerCompletionItemProvider(LANG, {
    triggerCharacters: ['"', ':', ',', '{', '[', ' ', '.', '/'],
    provideCompletionItems(model: MonacoEditorNs.ITextModel, position: MonacoPosition) {
      const getCtx = ctxByModel.get(model);
      if (!getCtx) return { suggestions: [] };
      const { indices, fieldsOf } = getCtx();

      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const line = position.lineNumber;
      const before = model.getLineContent(line).slice(0, position.column - 1);

      const requests = parseConsoleRequests(text);
      const owner = [...requests].reverse().find((r) => r.startLine <= line) ?? null;
      const inBody = !!owner && line > owner.startLine && line <= owner.endLine;

      // ── Dòng lệnh: method + đường dẫn ────────────────────────────────────
      if (!inBody) {
        const wordStart = position.column - 1 - (/[^\s]*$/.exec(before)?.[0].length ?? 0);
        const range = {
          startLineNumber: line, startColumn: wordStart + 1,
          endLineNumber: line, endColumn: position.column,
        };
        const methodMatch = /^\s*(GET|POST|HEAD|PUT|DELETE|PATCH)\s+(\S*)$/i.exec(before);
        if (!methodMatch) {
          if (/\s/.test(before.trim())) return { suggestions: [] };
          return {
            suggestions: METHODS.map((m, n) => ({
              label: m.name,
              kind: K.Keyword,
              detail: m.detail,
              insertText: `${m.name} `,
              sortText: String(n),
              range,
            })),
          };
        }

        const typed = methodMatch[2];
        const slash = typed.lastIndexOf('/');
        const prefix = slash >= 0 ? typed.slice(0, slash + 1) : '';
        const items: { label: string; detail: string; insert: string; kind: number }[] = prefix
          ? INDEX_ENDPOINTS.map(([e, d]) => ({ label: prefix + e, detail: d, insert: prefix + e, kind: K.Method }))
          : [
            ...indices.map((ix) => ({ label: ix, detail: 'index', insert: ix, kind: K.Folder })),
            ...ROOT_ENDPOINTS.map(([e, d]) => ({ label: e, detail: d, insert: e, kind: K.Method })),
          ];
        return {
          suggestions: items.map((it, n) => ({
            label: it.label,
            kind: it.kind,
            detail: it.detail,
            insertText: it.insert,
            filterText: it.label,
            sortText: `${it.kind === K.Folder ? 0 : 1}${String(n).padStart(4, '0')}`,
            range: {
              startLineNumber: line,
              startColumn: position.column - typed.length,
              endLineNumber: line,
              endColumn: position.column,
            },
          })),
        };
      }

      // ── Trong body JSON ──────────────────────────────────────────────────
      const bodyStart = model.getOffsetAt({ lineNumber: owner!.startLine + 1, column: 1 });
      const ctx = esQueryContext(text.slice(bodyStart), offset - bodyStart);
      const suggestions = esBodySuggestions(ctx, fieldsOf(pathIndex(owner!.path)));
      if (suggestions.length === 0) return { suggestions: [] };

      const start = model.getPositionAt(bodyStart + ctx.replaceStart);
      const end = model.getPositionAt(bodyStart + ctx.replaceEnd);
      const range = {
        startLineNumber: start.lineNumber, startColumn: start.column,
        endLineNumber: end.lineNumber, endColumn: end.column,
      };
      const quoted = text[bodyStart + ctx.replaceStart] === '"';
      const comma = needsLeadingComma(ctx) ? ', ' : '';

      return {
        suggestions: suggestions.map((it) => ({
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

export interface ConsoleViewProps {
  connection: PublicEsConnection;
}

export default function ConsoleView({ connection }: ConsoleViewProps) {
  const theme = useEsTheme();
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const [text, setText] = useState('');
  const [cursorLine, setCursorLine] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EsConsoleResult | null>(null);
  const [history, setHistory] = useState<EsConsoleHistoryEntry[]>([]);
  const [histOpen, setHistOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  const [indices, setIndices] = useState<string[]>([]);
  /** mapping đã trải, cache theo index — nuôi gợi ý tên field trong body. */
  const fieldCache = useRef<Map<string, EsField[]>>(new Map());
  const fetching = useRef<Set<string>>(new Set());
  const [fieldsVersion, setFieldsVersion] = useState(0);

  useEffect(() => {
    setText(loadEsConsoleDraft());
    setHistory(loadEsConsoleHistory());
  }, []);

  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => saveEsConsoleDraft(text), 400);
    return () => clearTimeout(t);
  }, [text]);

  // Danh sách index của cluster đang chọn → gợi ý đường dẫn.
  useEffect(() => {
    let alive = true;
    fieldCache.current = new Map();
    setIndices([]);
    listEsIndices(connection.id)
      .then((list) => { if (alive) setIndices(list.map((i) => i.name).sort((a, b) => a.localeCompare(b))); })
      .catch(() => { /* console vẫn gõ tay được */ });
    return () => { alive = false; };
  }, [connection.id]);

  const requests = useMemo(() => parseConsoleRequests(text), [text]);
  const current = useMemo(() => requestAtLine(requests, cursorLine), [requests, cursorLine]);

  // Nạp mapping của index trong lệnh đang đứng — chỉ một lần mỗi index.
  useEffect(() => {
    const idx = current ? pathIndex(current.path) : null;
    if (!idx || fieldCache.current.has(idx) || fetching.current.has(idx)) return;
    fetching.current.add(idx);
    esMapping(connection.id, idx)
      .then((m) => {
        fieldCache.current.set(idx, flattenEsMapping(m.json));
        setFieldsVersion((v) => v + 1);
      })
      .catch(() => { fieldCache.current.set(idx, []); })
      .finally(() => { fetching.current.delete(idx); });
  }, [current, connection.id]);

  // Provider chạy ngoài React → cho nó một getter đọc state mới nhất.
  const ctxRef = useRef<ConsoleCtx>({ indices: [], fieldsOf: () => [] });
  ctxRef.current = {
    indices,
    fieldsOf: (idx) => (idx ? fieldCache.current.get(idx) ?? [] : []),
  };
  void fieldsVersion; // re-render khi mapping về để badge số field cập nhật

  // Kẻ viền lệnh đang đặt con trỏ — biết ngay ▶ sẽ chạy cái nào.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    decorationsRef.current = ed.deltaDecorations(
      decorationsRef.current,
      current
        ? [{
          range: { startLineNumber: current.startLine, startColumn: 1, endLineNumber: current.endLine, endColumn: 1 },
          options: { isWholeLine: true, className: 'es-con-active', linesDecorationsClassName: 'es-con-activebar' },
        }]
        : [],
    );
  }, [current]);

  const runRef = useRef<() => void>(() => {});

  const doRun = useCallback(async () => {
    const req = current;
    if (!req) { setError('Chưa có lệnh nào — gõ ví dụ: GET _cat/indices?v'); return; }
    setBusy(true); setError(null);
    try {
      const r = await esConsole(connection.id, { method: req.method, path: req.path, body: req.body });
      setResult(r);
      setHistory(pushEsConsoleHistory({
        method: r.method, path: r.path, body: req.body,
        connectionId: connection.id, connectionName: `${connection.project} / ${connection.name}`,
        status: r.status, ok: r.ok, tookMs: r.tookMs,
      }));
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [current, connection]);
  runRef.current = () => void doRun();

  const asCurl = useCallback(() => {
    if (!current) return '';
    const scheme = connection.tls ? 'https' : 'http';
    const path = current.path.startsWith('/') ? current.path : `/${current.path}`;
    const head = `curl -X ${current.method} "${scheme}://${connection.nodes[0]}${path}"`;
    return current.body
      ? `${head} -H 'content-type: application/json' -d '${current.body.replace(/'/g, `'\\''`)}'`
      : head;
  }, [current, connection]);

  const loadFromHistory = useCallback((e: EsConsoleHistoryEntry) => {
    const ed = editorRef.current;
    const snippet = historyToText(e);
    if (!ed) { setText((t) => `${snippet}\n${t}`); return; }
    // Chèn lên đầu editor rồi nhảy con trỏ tới đó — không đè mất scratchpad.
    const model = ed.getModel();
    if (!model) return;
    ed.executeEdits('es-history', [{
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: `${snippet}\n`,
      forceMoveMarkers: true,
    }]);
    ed.setPosition({ lineNumber: 1, column: 1 });
    ed.revealLine(1);
    ed.focus();
  }, []);

  const statusTone = !result ? '' : result.ok ? 'var(--ok)' : 'var(--err)';
  // `_cat/*` trả text thuần, response quá dài thì bị cắt giữa chừng — cả hai
  // đều không phải JSON hợp lệ, mở bằng language json là dính gạch đỏ vô cớ.
  const respLang = result && !result.truncated && /^\s*[{[]/.test(result.json) ? 'json' : 'plaintext';

  return (
    <div className={`es-console${histOpen ? ' with-hist' : ''}`}>
      <div className="es-con-pane">
        <div className="es-con-bar">
          <button className="sm" disabled={busy || !current} onClick={() => void doRun()}
            title={current ? `Chạy: ${current.method} ${current.path}` : 'Đặt con trỏ vào một lệnh'}>
            {busy ? <span className="spinner" aria-hidden /> : '▶'} Chạy
          </button>
          <code className="es-con-cur" title="Lệnh đang đặt con trỏ">
            {current ? `${current.method} ${current.path}` : '— chưa có lệnh —'}
          </code>
          <button className="chip-btn" disabled={!current} title="Copy lệnh dạng cURL"
            onClick={() => {
              void navigator.clipboard?.writeText(asCurl()).then(() => {
                setCopied(true); setTimeout(() => setCopied(false), 1500);
              });
            }}>{copied ? '✓ Đã copy' : '⧉ cURL'}</button>
          <button className={`chip-btn${histOpen ? ' on' : ''}`} title="Lịch sử lệnh đã chạy"
            onClick={() => setHistOpen((v) => !v)}>🕘 Lịch sử ({history.length})</button>
        </div>

        <div className="es-con-editor">
          <Editor
            path={`es-console:/${connection.id}.escon`}
            language={LANG}
            theme={theme}
            value={text}
            onChange={(v) => setText(v ?? '')}
            beforeMount={ensureConsoleSetup}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              const model = editor.getModel();
              if (model) ctxByModel.set(model, () => ctxRef.current);
              editor.onDidChangeCursorPosition((e) => setCursorLine(e.position.lineNumber));
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
            }}
            loading={<span className="spinner" aria-hidden />}
            options={{
              fontSize: 12.5,
              fontFamily: ES_MONO,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              renderLineHighlight: 'none',
              overviewRulerLanes: 0,
              padding: { top: 8, bottom: 8 },
              quickSuggestions: { other: true, strings: true, comments: false },
              suggestOnTriggerCharacters: true,
              acceptSuggestionOnEnter: 'on',
              tabCompletion: 'on',
              automaticLayout: true,
              fixedOverflowWidgets: true,
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            }}
          />
        </div>
      </div>

      <div className="es-con-pane">
        <div className="es-con-bar">
          <strong className="es-con-restitle">Kết quả</strong>
          {result && (
            <>
              <span className="badge" style={{ color: statusTone }}>
                {result.status} {result.ok ? 'OK' : 'ERROR'}
              </span>
              <span className="badge">{result.tookMs}ms · {result.node}</span>
              <span className="badge" title="Kích thước response">{fmtCount(result.json.length)} ký tự</span>
              {result.truncated && <span className="badge" style={{ color: 'var(--err)' }}>đã cắt bớt</span>}
              <button className="chip-btn" title="Copy response"
                onClick={() => void navigator.clipboard?.writeText(result.json)}>⧉</button>
            </>
          )}
        </div>
        <div className="es-con-editor">
          {error ? (
            <pre className="code es-con-err">⚠ {error}</pre>
          ) : result ? (
            <Editor
              path={`es-console-resp:/${connection.id}.json`}
              language={respLang}
              theme={theme}
              value={result.json}
              beforeMount={defineEsThemes}
              loading={<span className="spinner" aria-hidden />}
              options={{
                readOnly: true,
                fontSize: 12.5,
                fontFamily: ES_MONO,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                folding: true,
                renderLineHighlight: 'none',
                overviewRulerLanes: 0,
                padding: { top: 8, bottom: 8 },
                automaticLayout: true,
                scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
              }}
            />
          ) : (
            <p className="empty" style={{ margin: 'auto', padding: 16 }}>
              Đặt con trỏ vào một lệnh rồi bấm ▶ (hoặc Ctrl+Enter).
            </p>
          )}
        </div>
      </div>

      {histOpen && (
        <aside className="es-con-hist">
          <div className="status-line" style={{ justifyContent: 'space-between' }}>
            <strong>Lệnh gần đây</strong>
            {history.length > 0 && (
              <button className="chip-btn" title="Xoá toàn bộ lịch sử"
                onClick={() => setHistory(clearEsConsoleHistory())}>Xoá hết</button>
            )}
          </div>
          {history.length === 0 && <p className="empty">Chạy một lệnh là nó xuất hiện ở đây.</p>}
          <ul className="es-con-histlist">
            {history.map((e) => (
              <li key={e.id} className="es-con-histrow">
                <button className="es-con-histmain" title={`${e.connectionName} · ${new Date(e.at).toLocaleString('vi-VN')} · ${e.status} · ${e.tookMs}ms\n\nBấm để chèn lại vào editor`}
                  onClick={() => loadFromHistory(e)}>
                  <span className={`es-con-hm ${e.ok ? 'ok' : 'err'}`}>{e.method}</span>
                  <span className="es-con-hp">{e.path}</span>
                  {e.body && <span className="es-con-hb">body</span>}
                </button>
                <button className="chip-btn" title="Bỏ khỏi lịch sử"
                  onClick={() => setHistory(removeEsConsoleHistory(e.id))}>✕</button>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
