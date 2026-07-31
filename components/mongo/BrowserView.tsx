'use client';

// Data browser — the Robo3T-style core: a database → collection tree on the
// left, a query bar + results on the right. Self-contained state; the shell
// remounts it per connection (key={activeId}) so nothing leaks across clusters.
//
// Reads are unrestricted (find / count / aggregate / indexes / stats — all
// server-bounded by maxTimeMS + page caps). The ONLY write is "Update…", which
// opens UpdateModal and is triple-gated (env flag + per-connection readOnly +
// typed confirm), with the mandatory-filter rule enforced server-side.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listMongoDatabases,
  listMongoCollections,
  mongoCollectionStats,
  listMongoIndexes,
  findMongo,
  countMongo,
  aggregateMongo,
  prettyDoc,
  fmtBytes,
  fmtCount,
  type DatabaseInfo,
  type CollectionInfo,
  type CollStatsResult,
  type IndexInfo,
  type FindResult,
  type AggregateResult,
} from '@/lib/mongo';
import UpdateModal from './UpdateModal';

export interface BrowserViewProps {
  connectionId: string;
  readOnly: boolean;
  allowWrite: boolean;
  /** Database pre-selected from the Overview jump (optional). */
  initialDb?: string;
}

type CollTab = 'docs' | 'indexes' | 'stats';
type QueryMode = 'find' | 'aggregate';

const DEFAULT_LIMIT = 50;

export default function BrowserView({ connectionId, readOnly, allowWrite, initialDb }: BrowserViewProps) {
  // ── Tree state ──────────────────────────────────────────────────────────────
  const [dbs, setDbs] = useState<DatabaseInfo[]>([]);
  const [dbsLoading, setDbsLoading] = useState(false);
  const [openDb, setOpenDb] = useState<string>('');
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [collsLoading, setCollsLoading] = useState(false);
  const [selected, setSelected] = useState<{ db: string; coll: string } | null>(null);
  const [treeFilter, setTreeFilter] = useState('');

  // ── Query state ─────────────────────────────────────────────────────────────
  const [queryMode, setQueryMode] = useState<QueryMode>('find');
  const [filter, setFilter] = useState('');
  const [projection, setProjection] = useState('');
  const [sort, setSort] = useState('');
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [skip, setSkip] = useState(0);
  const [pipeline, setPipeline] = useState('');

  // ── Results ────────────────────────────────────────────────────────────────
  const [collTab, setCollTab] = useState<CollTab>('docs');
  const [result, setResult] = useState<FindResult | null>(null);
  const [aggResult, setAggResult] = useState<AggregateResult | null>(null);
  const [countInfo, setCountInfo] = useState<string | null>(null);
  const [stats, setStats] = useState<CollStatsResult | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((m: string) => {
    setNotice(m);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  // ── Tree loaders ────────────────────────────────────────────────────────────
  const loadDbs = useCallback(async () => {
    setDbsLoading(true); setError(null);
    try { setDbs(await listMongoDatabases(connectionId)); }
    catch (e) { setError((e as Error).message); }
    finally { setDbsLoading(false); }
  }, [connectionId]);

  useEffect(() => { void loadDbs(); }, [loadDbs]);

  const expandDb = useCallback(async (db: string) => {
    setOpenDb(db);
    setCollections([]); setCollsLoading(true); setError(null);
    try { setCollections(await listMongoCollections(connectionId, db)); }
    catch (e) { setError((e as Error).message); }
    finally { setCollsLoading(false); }
  }, [connectionId]);

  // Jump from Overview: open the requested DB once.
  const jumpedRef = useRef('');
  useEffect(() => {
    if (initialDb && jumpedRef.current !== initialDb) {
      jumpedRef.current = initialDb;
      void expandDb(initialDb);
    }
  }, [initialDb, expandDb]);

  // ── Query runners ───────────────────────────────────────────────────────────
  const runFind = useCallback(async (over?: { skip?: number }) => {
    if (!selected) return;
    const eff = { filter, projection, sort, limit, skip: over?.skip ?? skip };
    setBusy(true); setError(null); setAggResult(null); setCountInfo(null);
    try {
      const r = await findMongo(connectionId, selected.db, selected.coll, eff);
      setResult(r);
      setSkip(r.skip);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, filter, projection, sort, limit, skip]);

  const runCount = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await countMongo(connectionId, selected.db, selected.coll, filter);
      setCountInfo(`${fmtCount(r.count)} document${r.count === 1 ? '' : 's'}${r.estimated ? ' (ước lượng metadata)' : ''} · ${r.tookMs}ms`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, filter]);

  const runAggregate = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null); setResult(null); setCountInfo(null);
    try { setAggResult(await aggregateMongo(connectionId, selected.db, selected.coll, pipeline)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, pipeline]);

  const loadStats = useCallback(async () => {
    if (!selected) return;
    try { setStats(await mongoCollectionStats(connectionId, selected.db, selected.coll)); }
    catch { setStats(null); }
  }, [connectionId, selected]);

  const loadIndexes = useCallback(async () => {
    if (!selected) return;
    try { setIndexes(await listMongoIndexes(connectionId, selected.db, selected.coll)); }
    catch (e) { setError((e as Error).message); }
  }, [connectionId, selected]);

  /** Select a collection → reset the query panel and auto-run the first page. */
  const selectColl = useCallback((db: string, coll: string) => {
    setSelected({ db, coll });
    setCollTab('docs');
    setFilter(''); setProjection(''); setSort(''); setLimit(DEFAULT_LIMIT); setSkip(0);
    setPipeline(''); setQueryMode('find');
    setResult(null); setAggResult(null); setCountInfo(null); setStats(null); setIndexes([]);
    setError(null);
  }, []);

  // Auto-run after selection state settles (first page, stats, indexes).
  const lastAuto = useRef('');
  useEffect(() => {
    if (!selected) return;
    const key = `${connectionId}/${selected.db}/${selected.coll}`;
    if (lastAuto.current === key) return;
    lastAuto.current = key;
    void runFind({ skip: 0 });
    void loadStats();
    void loadIndexes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, connectionId]);

  const docs = queryMode === 'aggregate' ? aggResult?.docs ?? null : result?.docs ?? null;
  const filteredDbs = dbs.filter((d) => !treeFilter || d.name.includes(treeFilter));
  const filteredColls = collections.filter((c) => !treeFilter || c.name.includes(treeFilter));
  const writeArmed = allowWrite && !readOnly;

  return (
    <div className="mongo-browser">
      {/* ── Tree: databases → collections ─────────────────────────────── */}
      <div className="mongo-tree">
        <div className="status-line" style={{ justifyContent: 'space-between' }}>
          <strong>Databases</strong>
          <button className="chip-btn" onClick={loadDbs} disabled={dbsLoading}>↻</button>
        </div>
        <input
          className="input"
          value={treeFilter}
          onChange={(e) => setTreeFilter(e.target.value)}
          placeholder="lọc db / collection…"
          style={{ margin: '6px 0' }}
        />
        {dbsLoading && dbs.length === 0 && <p className="empty"><span className="spinner" /> Đang tải…</p>}
        <ul className="mongo-db-list">
          {filteredDbs.map((d) => (
            <li key={d.name}>
              <button
                className={`mongo-db-item${openDb === d.name ? ' open' : ''}`}
                onClick={() => (openDb === d.name ? setOpenDb('') : void expandDb(d.name))}
                title={fmtBytes(d.sizeOnDisk)}
              >
                <span className="mongo-tree-caret">{openDb === d.name ? '▾' : '▸'}</span>
                <span className="mongo-db-name">{d.name}</span>
              </button>
              {openDb === d.name && (
                <ul className="mongo-coll-list">
                  {collsLoading && <li className="empty" style={{ padding: '4px 8px' }}><span className="spinner" /></li>}
                  {filteredColls.map((c) => (
                    <li key={c.name}>
                      <button
                        className={`mongo-coll-item${selected?.db === d.name && selected?.coll === c.name ? ' active' : ''}`}
                        onClick={() => selectColl(d.name, c.name)}
                      >
                        {c.name}
                        {c.type !== 'collection' && <span className="badge" style={{ marginLeft: 6 }}>{c.type}</span>}
                      </button>
                    </li>
                  ))}
                  {!collsLoading && filteredColls.length === 0 && (
                    <li className="empty" style={{ padding: '4px 8px' }}>trống</li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* ── Query + results ───────────────────────────────────────────── */}
      <div className="mongo-main">
        {!selected ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn một collection ở cây bên trái để truy vấn.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <strong className="mongo-ns">{selected.db}.{selected.coll}</strong>
              <div className="mongo-subnav">
                <button className={collTab === 'docs' ? 'on' : ''} onClick={() => setCollTab('docs')}>Documents</button>
                <button className={collTab === 'indexes' ? 'on' : ''} onClick={() => { setCollTab('indexes'); void loadIndexes(); }}>
                  Indexes{indexes.length > 0 ? ` (${indexes.length})` : ''}
                </button>
                <button className={collTab === 'stats' ? 'on' : ''} onClick={() => { setCollTab('stats'); void loadStats(); }}>Stats</button>
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {collTab === 'docs' && (
              <>
                <div className="mongo-querybar">
                  <div className="mongo-subnav">
                    <button className={queryMode === 'find' ? 'on' : ''} onClick={() => setQueryMode('find')}>Find</button>
                    <button className={queryMode === 'aggregate' ? 'on' : ''} onClick={() => setQueryMode('aggregate')}>Aggregate</button>
                  </div>

                  {queryMode === 'find' ? (
                    <>
                      <label className="mongo-field"><span>Filter (JSON/EJSON — hỗ trợ {'{"$oid"}, {"$date"}'})</span>
                        <textarea
                          className="input mono"
                          rows={2}
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { setSkip(0); void runFind({ skip: 0 }); } }}
                          placeholder='{"tenantId": "t_123", "status": "ACTIVE"}'
                        />
                      </label>
                      <div className="mongo-form-row">
                        <label className="mongo-field" style={{ flex: 1 }}><span>Projection</span>
                          <input className="input mono" value={projection} onChange={(e) => setProjection(e.target.value)} placeholder='{"name": 1, "phone": 1}' />
                        </label>
                        <label className="mongo-field" style={{ flex: 1 }}><span>Sort</span>
                          <input className="input mono" value={sort} onChange={(e) => setSort(e.target.value)} placeholder='{"createdAt": -1}' />
                        </label>
                        <label className="mongo-field" style={{ flex: '0 0 90px' }}><span>Limit ≤200</span>
                          <input className="input" type="number" min={1} max={200} value={limit}
                            onChange={(e) => setLimit(Math.min(Math.max(Number(e.target.value) || DEFAULT_LIMIT, 1), 200))} />
                        </label>
                      </div>
                      <div className="status-line" style={{ gap: 8 }}>
                        <button className="sm" disabled={busy} onClick={() => { setSkip(0); void runFind({ skip: 0 }); }}>
                          {busy ? <span className="spinner" aria-hidden /> : '▶'} Find
                        </button>
                        <button className="ghost sm" disabled={busy} onClick={() => void runCount()}>Count</button>
                        <button
                          className="ghost sm"
                          disabled={busy || !writeArmed}
                          title={writeArmed
                            ? 'Update theo filter hiện tại (bắt buộc có query)'
                            : !allowWrite
                              ? 'MONGO_ALLOW_WRITE chưa bật — write đang khoá toàn tool'
                              : 'Connection này đang read-only'}
                          onClick={() => setUpdateOpen(true)}
                        >✎ Update…{!writeArmed && ' 🔒'}</button>
                        {countInfo && <span className="badge">{countInfo}</span>}
                      </div>
                    </>
                  ) : (
                    <>
                      <label className="mongo-field"><span>Pipeline (JSON array — $out/$merge bị chặn, tự thêm $limit 500)</span>
                        <textarea
                          className="input mono"
                          rows={5}
                          value={pipeline}
                          onChange={(e) => setPipeline(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void runAggregate(); }}
                          placeholder='[{"$match": {"tenantId": "t_123"}}, {"$group": {"_id": "$status", "n": {"$sum": 1}}}]'
                        />
                      </label>
                      <div className="status-line" style={{ gap: 8 }}>
                        <button className="sm" disabled={busy || !pipeline.trim()} onClick={() => void runAggregate()}>
                          {busy ? <span className="spinner" aria-hidden /> : '▶'} Aggregate
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* Results */}
                {docs && (
                  <>
                    <div className="status-line" style={{ justifyContent: 'space-between' }}>
                      <span className="badge">
                        {queryMode === 'aggregate'
                          ? `${docs.length} kết quả${aggResult?.capped ? ' (đã chạm trần 500)' : ''} · ${aggResult?.tookMs}ms`
                          : `${docs.length} docs · skip ${result?.skip ?? 0} · ${result?.tookMs}ms`}
                      </span>
                      {queryMode === 'find' && result && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="chip-btn"
                            disabled={busy || (result.skip ?? 0) === 0}
                            onClick={() => void runFind({ skip: Math.max(0, (result.skip ?? 0) - limit) })}
                          >← Prev</button>
                          <button
                            className="chip-btn"
                            disabled={busy || !result.hasMore}
                            onClick={() => void runFind({ skip: (result.skip ?? 0) + limit })}
                          >Next →</button>
                        </div>
                      )}
                    </div>
                    <div className="mongo-results">
                      {docs.length === 0 && <p className="empty">Không có document nào khớp.</p>}
                      {docs.map((d, i) => (
                        <DocCard key={`${result?.skip ?? 0}-${i}`} json={d.json} truncated={d.truncated} index={(queryMode === 'find' ? (result?.skip ?? 0) : 0) + i} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {collTab === 'indexes' && (
              <table className="mongo-table">
                <thead>
                  <tr><th style={{ textAlign: 'left' }}>Name</th><th style={{ textAlign: 'left' }}>Keys</th><th>Flags</th></tr>
                </thead>
                <tbody>
                  {indexes.map((ix) => (
                    <tr key={ix.name}>
                      <td style={{ textAlign: 'left' }}>{ix.name}</td>
                      <td style={{ textAlign: 'left' }}><code className="small">{ix.keyJson}</code></td>
                      <td>
                        {ix.unique && <span className="badge">unique</span>}{' '}
                        {ix.sparse && <span className="badge">sparse</span>}{' '}
                        {ix.partial && <span className="badge">partial</span>}{' '}
                        {ix.ttlSeconds !== undefined && <span className="badge">ttl {ix.ttlSeconds}s</span>}
                      </td>
                    </tr>
                  ))}
                  {indexes.length === 0 && <tr><td colSpan={3} className="empty">Chưa tải / không có index.</td></tr>}
                </tbody>
              </table>
            )}

            {collTab === 'stats' && (
              stats ? (
                <table className="mongo-table">
                  <tbody>
                    <tr><td>Documents</td><td style={{ textAlign: 'left' }}>{fmtCount(stats.count)}</td></tr>
                    <tr><td>Data size</td><td style={{ textAlign: 'left' }}>{fmtBytes(stats.size)}</td></tr>
                    <tr><td>Storage size</td><td style={{ textAlign: 'left' }}>{fmtBytes(stats.storageSize)}</td></tr>
                    <tr><td>Avg document</td><td style={{ textAlign: 'left' }}>{fmtBytes(stats.avgObjSize)}</td></tr>
                    <tr><td>Indexes</td><td style={{ textAlign: 'left' }}>{stats.nindexes} · {fmtBytes(stats.totalIndexSize)}</td></tr>
                  </tbody>
                </table>
              ) : <p className="empty">Không đọc được $collStats (thiếu quyền?).</p>
            )}
          </>
        )}
      </div>

      {updateOpen && selected && (
        <UpdateModal
          connectionId={connectionId}
          db={selected.db}
          coll={selected.coll}
          initialFilter={filter}
          onClose={() => setUpdateOpen(false)}
          onDone={(r) => {
            setUpdateOpen(false);
            flash(`Update xong — matched ${r.matched}, modified ${r.modified}`);
            void runFind({ skip: result?.skip ?? 0 }); // refresh the visible page
          }}
        />
      )}
    </div>
  );
}

/** One document rendered as collapsible pretty JSON with a copy button. */
function DocCard({ json, truncated, index }: { json: string; truncated: boolean; index: number }) {
  const [open, setOpen] = useState(false);
  const pretty = prettyDoc(json);
  const firstLine = summarize(json);
  return (
    <div className="mongo-doc">
      <div className="mongo-doc-head" onClick={() => setOpen((v) => !v)}>
        <span className="mongo-tree-caret">{open ? '▾' : '▸'}</span>
        <span className="mongo-doc-idx">#{index + 1}</span>
        {!open && <code className="mongo-doc-preview">{firstLine}</code>}
        {truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
        <button
          className="chip-btn"
          title="Copy JSON"
          onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(pretty); }}
        >⧉</button>
      </div>
      {open && <pre className="code mongo-doc-body">{pretty}</pre>}
    </div>
  );
}

/** Compact single-line preview: `{_id: …, field: …}` capped for the row. */
function summarize(json: string): string {
  const s = json.replace(/\s+/g, ' ');
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}
