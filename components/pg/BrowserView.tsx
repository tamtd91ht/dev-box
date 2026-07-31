'use client';

// Data browser — databases → tables tree on the left, SQL editor + tabular
// results on the right. Self-contained state; the shell remounts it per
// connection (key={activeId}).
//
// Every read runs server-side inside a READ ONLY transaction with a statement
// timeout — the database itself refuses writes smuggled into a "read" query.
// Results are row-capped (500). The ONLY write is the ✎ UPDATE modal
// (triple-gated, WHERE mandatory).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listPgDatabases,
  listPgTables,
  listPgColumns,
  listPgIndexes,
  queryPg,
  prettyDoc,
  fmtBytes,
  fmtCount,
  type PgDatabaseInfo,
  type PgTableInfo,
  type PgColumnInfo,
  type PgIndexInfo,
  type PgQueryResult,
  type WireRow,
} from '@/lib/pg';
import UpdateModal from './UpdateModal';

export interface BrowserViewProps {
  connectionId: string;
  defaultDb: string;
  readOnly: boolean;
  allowWrite: boolean;
  /** Database pre-selected from the Overview jump (optional). */
  initialDb?: string;
}

type TableTab = 'rows' | 'columns' | 'indexes';

export default function BrowserView({ connectionId, defaultDb, readOnly, allowWrite, initialDb }: BrowserViewProps) {
  // ── Tree ────────────────────────────────────────────────────────────────────
  const [dbs, setDbs] = useState<PgDatabaseInfo[]>([]);
  const [dbsLoading, setDbsLoading] = useState(false);
  const [openDb, setOpenDb] = useState<string>('');
  const [tables, setTables] = useState<PgTableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [selected, setSelected] = useState<{ db: string; schema: string; table: string } | null>(null);
  const [treeFilter, setTreeFilter] = useState('');

  // ── Query + results ─────────────────────────────────────────────────────────
  const [tab, setTab] = useState<TableTab>('rows');
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<PgQueryResult | null>(null);
  const [columns, setColumns] = useState<PgColumnInfo[]>([]);
  const [indexes, setIndexes] = useState<PgIndexInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<WireRow | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((m: string) => {
    setNotice(m);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const loadDbs = useCallback(async () => {
    setDbsLoading(true); setError(null);
    try { setDbs(await listPgDatabases(connectionId)); }
    catch (e) { setError((e as Error).message); }
    finally { setDbsLoading(false); }
  }, [connectionId]);

  useEffect(() => { void loadDbs(); }, [loadDbs]);

  const expandDb = useCallback(async (db: string) => {
    setOpenDb(db);
    setTables([]); setTablesLoading(true); setError(null);
    try { setTables(await listPgTables(connectionId, db)); }
    catch (e) { setError((e as Error).message); }
    finally { setTablesLoading(false); }
  }, [connectionId]);

  // Jump from Overview (or open the connection's default DB on first mount).
  const jumpedRef = useRef('');
  useEffect(() => {
    const target = initialDb || defaultDb;
    if (target && jumpedRef.current !== target) {
      jumpedRef.current = target;
      void expandDb(target);
    }
  }, [initialDb, defaultDb, expandDb]);

  const runQuery = useCallback(async (sqlOverride?: string) => {
    if (!selected) return;
    const eff = sqlOverride ?? sql;
    if (!eff.trim()) return;
    setBusy(true); setError(null);
    try { setResult(await queryPg(connectionId, selected.db, eff)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, sql]);

  const loadColumns = useCallback(async () => {
    if (!selected) return;
    try { setColumns(await listPgColumns(connectionId, selected.db, selected.schema, selected.table)); }
    catch (e) { setError((e as Error).message); }
  }, [connectionId, selected]);

  const loadIndexes = useCallback(async () => {
    if (!selected) return;
    try { setIndexes(await listPgIndexes(connectionId, selected.db, selected.schema, selected.table)); }
    catch (e) { setError((e as Error).message); }
  }, [connectionId, selected]);

  /** Select a table → prefill the SQL editor and auto-run the first page. */
  const selectTable = useCallback((db: string, schema: string, table: string) => {
    setSelected({ db, schema, table });
    setTab('rows');
    const q = `SELECT * FROM "${schema}"."${table}" LIMIT 50`;
    setSql(q);
    setResult(null); setColumns([]); setIndexes([]); setError(null);
  }, []);

  // Auto-run after selection settles.
  const lastAuto = useRef('');
  useEffect(() => {
    if (!selected) return;
    const key = `${connectionId}/${selected.db}/${selected.schema}/${selected.table}`;
    if (lastAuto.current === key) return;
    lastAuto.current = key;
    void runQuery(`SELECT * FROM "${selected.schema}"."${selected.table}" LIMIT 50`);
    void loadColumns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, connectionId]);

  const filteredDbs = dbs.filter((d) => !treeFilter || d.name.includes(treeFilter));
  const filteredTables = tables.filter((t) => !treeFilter || `${t.schema}.${t.name}`.includes(treeFilter));
  const writeArmed = allowWrite && !readOnly;
  const parsedRows = useMemo(
    () => (result ? result.rows.map((r) => { try { return JSON.parse(r.json) as Record<string, unknown>; } catch { return null; } }) : []),
    [result],
  );

  return (
    <div className="pg-browser">
      {/* ── Tree: databases → tables ──────────────────────────────────── */}
      <div className="pg-tree">
        <div className="status-line" style={{ justifyContent: 'space-between' }}>
          <strong>Databases</strong>
          <button className="chip-btn" onClick={loadDbs} disabled={dbsLoading}>↻</button>
        </div>
        <input
          className="input"
          value={treeFilter}
          onChange={(e) => setTreeFilter(e.target.value)}
          placeholder="lọc db / table…"
          style={{ margin: '6px 0' }}
        />
        {dbsLoading && dbs.length === 0 && <p className="empty"><span className="spinner" /> Đang tải…</p>}
        <ul className="pg-db-list">
          {filteredDbs.map((d) => (
            <li key={d.name}>
              <button
                className={`pg-db-item${openDb === d.name ? ' open' : ''}`}
                onClick={() => (openDb === d.name ? setOpenDb('') : void expandDb(d.name))}
                title={fmtBytes(d.sizeBytes)}
              >
                <span className="pg-tree-caret">{openDb === d.name ? '▾' : '▸'}</span>
                <span className="pg-db-name">{d.name}</span>
              </button>
              {openDb === d.name && (
                <ul className="pg-coll-list">
                  {tablesLoading && <li className="empty" style={{ padding: '4px 8px' }}><span className="spinner" /></li>}
                  {filteredTables.map((t) => (
                    <li key={`${t.schema}.${t.name}`}>
                      <button
                        className={`pg-coll-item${selected?.db === d.name && selected?.schema === t.schema && selected?.table === t.name ? ' active' : ''}`}
                        onClick={() => selectTable(d.name, t.schema, t.name)}
                        title={`~${fmtCount(t.estRows)} rows · ${fmtBytes(t.sizeBytes)}`}
                      >
                        {t.schema === 'public' ? t.name : `${t.schema}.${t.name}`}
                      </button>
                    </li>
                  ))}
                  {!tablesLoading && filteredTables.length === 0 && (
                    <li className="empty" style={{ padding: '4px 8px' }}>trống</li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* ── SQL + results ─────────────────────────────────────────────── */}
      <div className="pg-main">
        {!selected ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn một table ở cây bên trái để truy vấn.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <strong className="pg-ns">{selected.db} › {selected.schema}.{selected.table}</strong>
              <div className="pg-subnav">
                <button className={tab === 'rows' ? 'on' : ''} onClick={() => setTab('rows')}>Rows</button>
                <button className={tab === 'columns' ? 'on' : ''} onClick={() => { setTab('columns'); if (columns.length === 0) void loadColumns(); }}>
                  Columns{columns.length > 0 ? ` (${columns.length})` : ''}
                </button>
                <button className={tab === 'indexes' ? 'on' : ''} onClick={() => { setTab('indexes'); void loadIndexes(); }}>Indexes</button>
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {tab === 'rows' && (
              <>
                <div className="pg-querybar">
                  <label className="pg-field"><span>SQL (chạy trong transaction READ ONLY · timeout 15s · trần 500 dòng — Ctrl+Enter để chạy)</span>
                    <textarea
                      className="input mono"
                      rows={3}
                      value={sql}
                      onChange={(e) => setSql(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void runQuery(); }}
                      style={{ minHeight: 70 }}
                    />
                  </label>
                  <div className="status-line" style={{ gap: 8 }}>
                    <button className="sm" disabled={busy || !sql.trim()} onClick={() => void runQuery()}>
                      {busy ? <span className="spinner" aria-hidden /> : '▶'} Run
                    </button>
                    <button
                      className="ghost sm"
                      disabled={busy || !writeArmed}
                      title={writeArmed
                        ? 'UPDATE bảng này (bắt buộc WHERE)'
                        : !allowWrite
                          ? 'PG_ALLOW_WRITE chưa bật — write đang khoá toàn tool'
                          : 'Connection này đang read-only'}
                      onClick={() => setUpdateOpen(true)}
                    >✎ Update…{!writeArmed && ' 🔒'}</button>
                    {result && (
                      <span className="badge">
                        {result.rowCount} dòng{result.capped ? ' (chạm trần 500)' : ''} · {result.tookMs}ms
                      </span>
                    )}
                  </div>
                </div>

                {result && (
                  <div className="pg-results">
                    {result.rowCount === 0 && <p className="empty">Không có dòng nào.</p>}
                    {result.rowCount > 0 && (
                      <table className="pg-table pg-grid">
                        <thead>
                          <tr>
                            <th>#</th>
                            {result.columns.map((c) => <th key={c} style={{ textAlign: 'left' }}>{c}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {result.rows.map((r, i) => {
                            const row = parsedRows[i];
                            return (
                              <tr key={i} onClick={() => setSelectedRow(r)} title="Bấm để xem JSON đầy đủ" style={{ cursor: 'pointer' }}>
                                <td className="pg-rownum">{i + 1}</td>
                                {result.columns.map((c) => (
                                  <td key={c} style={{ textAlign: 'left' }}>
                                    <span className="pg-cell">{cellText(row?.[c])}</span>
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </>
            )}

            {tab === 'columns' && (
              <table className="pg-table">
                <thead>
                  <tr><th style={{ textAlign: 'left' }}>Column</th><th style={{ textAlign: 'left' }}>Type</th><th>Null</th><th style={{ textAlign: 'left' }}>Default</th></tr>
                </thead>
                <tbody>
                  {columns.map((c) => (
                    <tr key={c.name}>
                      <td style={{ textAlign: 'left' }}><code className="small">{c.name}</code></td>
                      <td style={{ textAlign: 'left' }}>{c.dataType}</td>
                      <td>{c.nullable ? 'YES' : 'NO'}</td>
                      <td style={{ textAlign: 'left' }}><code className="small">{c.default ?? ''}</code></td>
                    </tr>
                  ))}
                  {columns.length === 0 && <tr><td colSpan={4} className="empty">Chưa tải / không có cột.</td></tr>}
                </tbody>
              </table>
            )}

            {tab === 'indexes' && (
              <table className="pg-table">
                <thead>
                  <tr><th style={{ textAlign: 'left' }}>Name</th><th style={{ textAlign: 'left' }}>Definition</th></tr>
                </thead>
                <tbody>
                  {indexes.map((ix) => (
                    <tr key={ix.name}>
                      <td style={{ textAlign: 'left' }}>{ix.name}</td>
                      <td style={{ textAlign: 'left' }}><code className="small" style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{ix.definition}</code></td>
                    </tr>
                  ))}
                  {indexes.length === 0 && <tr><td colSpan={2} className="empty">Chưa tải / không có index.</td></tr>}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      {selectedRow && (
        <div className="modal-backdrop" onClick={() => setSelectedRow(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 94vw)' }}>
            <div className="status-line" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0, flex: 1 }}>Row</h3>
              {selectedRow.truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
              <button
                className="ghost sm"
                onClick={() => { void navigator.clipboard?.writeText(prettyDoc(selectedRow.json)); }}
              >⧉ Copy</button>
              <button className="ghost sm" onClick={() => setSelectedRow(null)}>✕</button>
            </div>
            <pre className="code pg-doc-body" style={{ maxHeight: '70vh' }}>{prettyDoc(selectedRow.json)}</pre>
          </div>
        </div>
      )}

      {updateOpen && selected && (
        <UpdateModal
          connectionId={connectionId}
          db={selected.db}
          schema={selected.schema}
          table={selected.table}
          columnSuggestions={columns.map((c) => c.name)}
          onClose={() => setUpdateOpen(false)}
          onDone={(updated) => {
            setUpdateOpen(false);
            flash(`UPDATE xong — ${updated} dòng`);
            void runQuery(); // refresh the visible result
          }}
        />
      )}
    </div>
  );
}

/** Render one cell value as compact text. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}
