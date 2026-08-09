'use client';

// Data browser — indices list on the left, query DSL + results on the right.
// Self-contained state; the shell remounts it per connection (key={activeId}).
//
// Everything here is read-only: _search / _count / _mapping, all bounded
// server-side (size ≤200, 15s timeout, scripting rejected). The query box
// takes the `query` CLAUSE only (match/term/bool…) — size/from/sort/_source
// have their own inputs, so a beginner can just hit Search for match_all.

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
import { useSplit } from '@/lib/useSplit';
import Splitter from '../Splitter';

export interface BrowserViewProps {
  connectionId: string;
  /** Index pre-selected from the Overview jump (optional). */
  initialIndex?: string;
}

type IdxTab = 'docs' | 'mapping' | 'info';

const DEFAULT_SIZE = 50;

export default function BrowserView({ connectionId, initialIndex }: BrowserViewProps) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const tree = useSplit({ varName: '--es-tree', min: 160, max: 520, gap: 12 });
  const [indices, setIndices] = useState<EsIndexInfo[]>([]);
  const [idxLoading, setIdxLoading] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  const [selected, setSelected] = useState<string>('');

  const [idxTab, setIdxTab] = useState<IdxTab>('docs');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('');
  const [source, setSource] = useState('');
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [from, setFrom] = useState(0);

  const [result, setResult] = useState<EsSearchResult | null>(null);
  const [countInfo, setCountInfo] = useState<string | null>(null);
  const [mapping, setMapping] = useState<WireDoc | null>(null);
  /** Field trải từ mapping — nuôi autocomplete tên field trong ô Query DSL. */
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

  const runSearch = useCallback(async (over?: { from?: number }) => {
    if (!selected) return;
    const effFrom = over?.from ?? 0;
    setBusy(true); setError(null); setCountInfo(null);
    try {
      const r = await searchEs(connectionId, selected, { query, sort, source, size, from: effFrom });
      setResult(r);
      setFrom(r.from);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, query, sort, source, size]);

  const runCount = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await countEs(connectionId, selected, query);
      setCountInfo(`${fmtCount(r.count)} document${r.count === 1 ? '' : 's'} · ${r.tookMs}ms`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, query]);

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
    setIdxTab('docs');
    setQuery(''); setSort(''); setSource(''); setSize(DEFAULT_SIZE); setFrom(0);
    setResult(null); setCountInfo(null); setMapping(null); setFields([]); setError(null);
  }, []);

  // Mapping nạp ngầm ngay khi chọn index (không chặn UI, lỗi thì im lặng) — cần
  // sớm vì nó là nguồn gợi ý tên field cho ô Query DSL, không chỉ cho tab Mapping.
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
    void runSearch({ from: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, connectionId]);

  const selectedInfo = indices.find((i) => i.name === selected) ?? null;
  const filteredIndices = indices.filter((i) => !treeFilter || i.name.includes(treeFilter));

  return (
    <div className="es-browser" ref={tree.ref} style={tree.style}>
      {/* ── Indices list ─────────────────────────────────────────────── */}
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
                <span style={{ color: ix.health === 'green' ? 'var(--ok)' : ix.health === 'red' ? 'var(--err)' : 'var(--warn, #d5a021)' }}>●</span>{' '}
                {ix.name}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Query + results ──────────────────────────────────────────── */}
      <div className="es-main">
        {!selected ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn một index ở danh sách bên trái để truy vấn.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <strong className="es-ns">{selected}</strong>
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
                    value={query}
                    onChange={setQuery}
                    onRun={() => { setFrom(0); void runSearch({ from: 0 }); }}
                    fields={fields}
                    label={`Query DSL — chỉ phần "query" (trống = match_all; script bị chặn)${fields.length ? ` · ${fields.length} field từ mapping` : ''}`}
                  />
                  <div className="es-form-row">
                    <label className="es-field" style={{ flex: 1 }}><span>Sort</span>
                      <input className="input mono" value={sort} onChange={(e) => setSort(e.target.value)} placeholder='[{"createdAt": "desc"}]' />
                    </label>
                    <label className="es-field" style={{ flex: 1 }}><span>_source (fields, phẩy hoặc JSON array)</span>
                      <input className="input mono" value={source} onChange={(e) => setSource(e.target.value)} placeholder="name, phone, status" />
                    </label>
                    <label className="es-field" style={{ flex: '0 0 90px' }}><span>Size ≤200</span>
                      <input className="input" type="number" min={1} max={200} value={size}
                        onChange={(e) => setSize(Math.min(Math.max(Number(e.target.value) || DEFAULT_SIZE, 1), 200))} />
                    </label>
                  </div>
                  <div className="status-line" style={{ gap: 8 }}>
                    <button className="sm" disabled={busy} onClick={() => { setFrom(0); void runSearch({ from: 0 }); }}>
                      {busy ? <span className="spinner" aria-hidden /> : '▶'} Search
                    </button>
                    <button className="ghost sm" disabled={busy} onClick={() => void runCount()}>Count</button>
                    {countInfo && <span className="badge">{countInfo}</span>}
                  </div>
                </div>

                {result && (
                  <>
                    <div className="status-line" style={{ justifyContent: 'space-between' }}>
                      <span className="badge">
                        {fmtCount(result.total)}{result.totalRelation === 'gte' ? '+' : ''} khớp · hiển thị {result.docs.length} · from {result.from} · {result.tookMs}ms
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="chip-btn" disabled={busy || result.from === 0}
                          onClick={() => void runSearch({ from: Math.max(0, result.from - size) })}>← Prev</button>
                        <button className="chip-btn" disabled={busy || result.from + result.docs.length >= Math.min(result.total, 10000 - size)}
                          onClick={() => void runSearch({ from: result.from + size })}>Next →</button>
                      </div>
                    </div>
                    <div className="es-results">
                      {result.docs.length === 0 && <p className="empty">Không có document nào khớp.</p>}
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
      <Splitter {...tree.grip} />
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
