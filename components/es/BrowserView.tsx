'use client';

// Data browser — chọn index rồi truy vấn bằng MỘT ô body _search kiểu Kibana
// Dev Tools: query / aggs / sort / _source / size gõ chung một chỗ, gợi ý đầy
// đủ theo ngữ cảnh (tên field lấy từ mapping). Self-contained state; the shell
// remounts it per connection (key={activeId}).
//
// Everything here is read-only: _search / _count / _mapping, all bounded
// server-side (size ≤200, from+size ≤10k, 15s timeout, scripting rejected).
//
// Bố cục: chưa chọn index thì cây indices chiếm cột trái; chọn xong cây TỰ ẨN
// cho rộng chỗ đọc kết quả — đổi index bằng combobox trên đầu (gõ để lọc,
// Enter chọn), hoặc ☰ để mở lại cây.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listEsIndices,
  esMapping,
  searchEs,
  countEs,
  prettyDoc,
  fmtBytes,
  fmtCount,
  type EsIndexInfo,
  type EsSearchResult,
  type WireDoc,
} from '@/lib/es';
import { flattenEsMapping, type EsField } from '@/lib/esDsl';
import QueryEditor from './QueryEditor';
import AggsResult from './AggsResult';
import { useSplit } from '@/lib/useSplit';
import Splitter from '../Splitter';

export interface BrowserViewProps {
  connectionId: string;
  /** Index pre-selected from the Overview jump (optional). */
  initialIndex?: string;
}

type IdxTab = 'docs' | 'mapping' | 'info';

const healthColor = (h: string) =>
  h === 'green' ? 'var(--ok)' : h === 'red' ? 'var(--err)' : 'var(--warn, #d5a021)';

export default function BrowserView({ connectionId, initialIndex }: BrowserViewProps) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const tree = useSplit({ varName: '--es-tree', min: 160, max: 520, gap: 12 });
  const [indices, setIndices] = useState<EsIndexInfo[]>([]);
  const [idxLoading, setIdxLoading] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  const [selected, setSelected] = useState<string>('');
  /** Cây indices tự ẩn khi đã chọn index — mở lại bằng nút ☰. */
  const [showTree, setShowTree] = useState(true);

  const [idxTab, setIdxTab] = useState<IdxTab>('docs');
  /** NGUYÊN body _search (JSON) — trống = match_all, size mặc định 50. */
  const [body, setBody] = useState('');

  const [result, setResult] = useState<EsSearchResult | null>(null);
  const [countInfo, setCountInfo] = useState<string | null>(null);
  const [mapping, setMapping] = useState<WireDoc | null>(null);
  /** Field trải từ mapping — nuôi autocomplete tên field trong ô body. */
  const [fields, setFields] = useState<EsField[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadIndices = useCallback(async () => {
    setIdxLoading(true); setError(null);
    try { setIndices(await listEsIndices(connectionId)); }
    catch (e) { setError((e as Error).message); }
    finally { setIdxLoading(false); }
  }, [connectionId]);

  useEffect(() => { void loadIndices(); }, [loadIndices]);

  /** `over.from` chỉ dùng cho phân trang Prev/Next — nó đè lên from trong body. */
  const runSearch = useCallback(async (over?: { from?: number }) => {
    if (!selected) return;
    setBusy(true); setError(null); setCountInfo(null);
    try {
      const r = await searchEs(connectionId, selected, { body, from: over?.from });
      setResult(r);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, body]);

  const runCount = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await countEs(connectionId, selected, '', body);
      setCountInfo(`${fmtCount(r.count)} document${r.count === 1 ? '' : 's'} · ${r.tookMs}ms`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, body]);

  const loadMapping = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const m = await esMapping(connectionId, selected);
      setMapping(m);
      setFields(flattenEsMapping(m.json));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected]);

  const selectIndex = useCallback((name: string) => {
    setSelected(name);
    setShowTree(false); // nhường chỗ cho kết quả — mở lại bằng ☰
    setIdxTab('docs');
    setBody('');
    setResult(null); setCountInfo(null); setMapping(null); setFields([]); setError(null);
  }, []);

  // Mapping nạp ngầm ngay khi chọn index (không chặn UI, lỗi thì im lặng) — cần
  // sớm vì nó là nguồn gợi ý tên field cho ô body, không chỉ cho tab Mapping.
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    esMapping(connectionId, selected)
      .then((m) => { if (alive) { setMapping(m); setFields(flattenEsMapping(m.json)); } })
      .catch(() => { /* tab Mapping vẫn có nút tải lại */ });
    return () => { alive = false; };
  }, [connectionId, selected]);

  // Jump from Overview: select the requested index once.
  const jumpedRef = useRef('');
  useEffect(() => {
    if (initialIndex && jumpedRef.current !== initialIndex) {
      jumpedRef.current = initialIndex;
      selectIndex(initialIndex);
    }
  }, [initialIndex, selectIndex]);

  // Auto-run match_all on selection.
  const lastAuto = useRef('');
  useEffect(() => {
    if (!selected) return;
    const key = `${connectionId}/${selected}`;
    if (lastAuto.current === key) return;
    lastAuto.current = key;
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, connectionId]);

  const selectedInfo = indices.find((i) => i.name === selected) ?? null;
  const filteredIndices = indices.filter((i) => !treeFilter || i.name.includes(treeFilter));
  const treeVisible = showTree || !selected;

  return (
    <div className={`es-browser${treeVisible ? '' : ' es-browser-solo'}`} ref={tree.ref} style={tree.style}>
      {/* ── Indices list (ẩn khi đã chọn index) ──────────────────────── */}
      {treeVisible && (
        <div className="es-tree">
          <div className="status-line" style={{ justifyContent: 'space-between' }}>
            <strong>Indices</strong>
            <button className="chip-btn" onClick={loadIndices} disabled={idxLoading}>↻</button>
          </div>
          <input
            className="input"
            value={treeFilter}
            onChange={(e) => setTreeFilter(e.target.value)}
            placeholder="lọc index…"
            style={{ margin: '6px 0' }}
          />
          {idxLoading && indices.length === 0 && <p className="empty"><span className="spinner" /> Đang tải…</p>}
          <ul className="es-idx-list">
            {filteredIndices.map((ix) => (
              <li key={ix.name}>
                <button
                  className={`es-idx-item${selected === ix.name ? ' active' : ''}`}
                  onClick={() => selectIndex(ix.name)}
                  title={`${fmtCount(ix.docsCount)} docs · ${fmtBytes(ix.sizeBytes)}`}
                >
                  <span style={{ color: healthColor(ix.health) }}>●</span>{' '}
                  {ix.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Query + results ──────────────────────────────────────────── */}
      <div className="es-main">
        {!selected ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn một index ở danh sách bên trái để truy vấn.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                <button
                  className="chip-btn"
                  title={treeVisible ? 'Ẩn danh sách indices' : 'Hiện danh sách indices'}
                  onClick={() => setShowTree((v) => !v)}
                >☰</button>
                <IndexPicker indices={indices} value={selected} onPick={selectIndex} />
              </div>
              <div className="es-subnav">
                <button className={idxTab === 'docs' ? 'on' : ''} onClick={() => setIdxTab('docs')}>Documents</button>
                <button className={idxTab === 'mapping' ? 'on' : ''} onClick={() => { setIdxTab('mapping'); if (!mapping) void loadMapping(); }}>Mapping</button>
                <button className={idxTab === 'info' ? 'on' : ''} onClick={() => setIdxTab('info')}>Info</button>
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

            {idxTab === 'docs' && (
              <>
                <div className="es-querybar">
                  <QueryEditor
                    mode="body"
                    value={body}
                    onChange={setBody}
                    onRun={() => void runSearch()}
                    fields={fields}
                    label={`Body _search — như Kibana Dev Tools (trống = match_all)${fields.length ? ` · ${fields.length} field từ mapping` : ''}`}
                    placeholder='{ "query": { "term": { "field": "value" } }, "aggs": { … }, "sort": [{ "createdAt": "desc" }], "size": 50 }'
                  />
                  <div className="status-line" style={{ gap: 8 }}>
                    <button className="sm" disabled={busy} onClick={() => void runSearch()}>
                      {busy ? <span className="spinner" aria-hidden /> : '▶'} Search
                    </button>
                    <button className="ghost sm" disabled={busy} onClick={() => void runCount()}>Count</button>
                    {countInfo && <span className="badge">{countInfo}</span>}
                    <span className="es-hint" style={{ marginLeft: 'auto' }}>size ≤ 200 · size 0 = chỉ lấy aggs · script bị chặn</span>
                  </div>
                </div>

                {result && (
                  <>
                    <div className="status-line" style={{ justifyContent: 'space-between' }}>
                      <span className="badge">
                        {fmtCount(result.total)}{result.totalRelation === 'gte' ? '+' : ''} khớp · hiển thị {result.docs.length} · from {result.from} · {result.tookMs}ms
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="chip-btn" disabled={busy || result.size === 0 || result.from === 0}
                          onClick={() => void runSearch({ from: Math.max(0, result.from - result.size) })}>← Prev</button>
                        <button className="chip-btn" disabled={busy || result.size === 0 || result.from + result.docs.length >= Math.min(result.total, 10000 - result.size)}
                          onClick={() => void runSearch({ from: result.from + result.size })}>Next →</button>
                      </div>
                    </div>
                    <div className="es-results">
                      {result.aggs && (
                        <>
                          <div className="status-line" style={{ gap: 8 }}>
                            <strong style={{ fontSize: 12.5 }}>Σ Aggregations</strong>
                          </div>
                          <AggsResult json={result.aggs.json} truncated={result.aggs.truncated} />
                        </>
                      )}
                      {result.docs.length === 0 && (
                        <p className="empty">{result.size === 0 ? 'size = 0 — chỉ lấy aggregations, không lấy document.' : 'Không có document nào khớp.'}</p>
                      )}
                      {result.docs.map((d, i) => (
                        <DocCard key={`${result.from}-${i}`} json={d.json} truncated={d.truncated} index={result.from + i} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {idxTab === 'mapping' && (
              mapping
                ? (
                  <>
                    {mapping.truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
                    <pre className="code es-doc-body" style={{ maxHeight: '64vh' }}>{mapping.json}</pre>
                  </>
                )
                : <p className="empty">{busy ? 'Đang tải mapping…' : 'Chưa tải được mapping.'}</p>
            )}

            {idxTab === 'info' && (
              selectedInfo ? (
                <table className="es-table">
                  <tbody>
                    <tr><td>Health</td><td style={{ textAlign: 'left' }}>{selectedInfo.health}</td></tr>
                    <tr><td>Status</td><td style={{ textAlign: 'left' }}>{selectedInfo.status}</td></tr>
                    <tr><td>Documents</td><td style={{ textAlign: 'left' }}>{fmtCount(selectedInfo.docsCount)}</td></tr>
                    <tr><td>Store size</td><td style={{ textAlign: 'left' }}>{fmtBytes(selectedInfo.sizeBytes)}</td></tr>
                    <tr><td>Shards</td><td style={{ textAlign: 'left' }}>{selectedInfo.primaries} primary × {selectedInfo.replicas} replica</td></tr>
                  </tbody>
                </table>
              ) : <p className="empty">Không có thông tin index (tải lại danh sách).</p>
            )}
          </>
        )}
      </div>
      {treeVisible && <Splitter {...tree.grip} />}
    </div>
  );
}

/**
 * Combobox đổi index khi cây indices đang ẩn: hiện tên index đang chọn, focus
 * vào là gõ để lọc, Enter chọn kết quả đầu, Esc trả về tên cũ.
 */
function IndexPicker({ indices, value, onPick }: {
  indices: EsIndexInfo[];
  value: string;
  onPick: (name: string) => void;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  useEffect(() => { setText(value); }, [value]);

  // Chưa gõ gì (text còn là tên đang chọn) thì hiện cả danh sách.
  const needle = text.trim() === value ? '' : text.trim();
  const list = indices.filter((i) => !needle || i.name.includes(needle)).slice(0, 50);

  return (
    <div className="es-ixpick">
      <input
        className="input mono"
        value={text}
        onFocus={(e) => { setOpen(true); e.target.select(); }}
        onBlur={() => { setOpen(false); setText(value); }}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && list.length) { onPick(list[0].name); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { (e.target as HTMLInputElement).blur(); }
        }}
        placeholder="gõ để tìm index…"
        title="Đổi index — gõ để lọc, Enter chọn kết quả đầu tiên"
      />
      {open && list.length > 0 && (
        <div className="es-ixpick-menu">
          {list.map((ix) => (
            <button
              key={ix.name}
              // preventDefault để input không blur trước khi click kịp chạy
              onMouseDown={(e) => { e.preventDefault(); }}
              onClick={() => { onPick(ix.name); setOpen(false); }}
            >
              <span style={{ color: healthColor(ix.health) }}>●</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{ix.name}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11 }}>{fmtCount(ix.docsCount)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One document rendered as collapsible pretty JSON with a copy button. */
function DocCard({ json, truncated, index }: { json: string; truncated: boolean; index: number }) {
  const [open, setOpen] = useState(false);
  const pretty = prettyDoc(json);
  const oneLine = json.replace(/\s+/g, ' ');
  return (
    <div className="es-doc">
      <div className="es-doc-head" onClick={() => setOpen((v) => !v)}>
        <span className="es-tree-caret">{open ? '▾' : '▸'}</span>
        <span className="es-doc-idx">#{index + 1}</span>
        {!open && <code className="es-doc-preview">{oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine}</code>}
        {truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
        <button
          className="chip-btn"
          title="Copy JSON"
          onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(pretty); }}
        >⧉</button>
      </div>
      {open && <pre className="code es-doc-body">{pretty}</pre>}
    </div>
  );
}
