'use client';

// Quick-find for PostgreSQL — same experience as the Mongo/ES tabs: named
// preset buttons (connection + database + schema.table + curated columns),
// run = tick columns, fill values, AND. The WHERE is built SERVER-SIDE from
// structured entries as parameterized clauses (`= $n` / `= ANY($n)`) — values
// never concatenate into SQL. Run collapses the panel into a one-line summary;
// the second tab picks returned columns (exact list from information_schema).
// Results: one row per line, click → pretty-JSON modal. Export → styled .xlsx.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  pgQuickFind,
  listPgDatabases,
  listPgTables,
  listPgColumns,
  prettyDoc,
  type PublicPgConnection,
  type PgQuickFindResult,
  type PgQuickEntry,
  type PgQuickFieldType,
  type WireRow,
} from '@/lib/pg';
import {
  loadPgQuickFinds,
  addPgQuickFind,
  updatePgQuickFind,
  removePgQuickFind,
  PG_QUICK_FIELD_TYPES,
  type PgQuickFind,
  type PgQuickFindField,
} from '@/lib/pgQuickFinds';
import ExportModal from './ExportModal';

export interface QuickFindViewProps {
  connections: PublicPgConnection[];
}

interface RunField extends PgQuickFindField {
  checked: boolean;
  value: string;
  list: boolean;
}

type RunTab = 'conditions' | 'columns';

export default function QuickFindView({ connections }: QuickFindViewProps) {
  const [quickFinds, setQuickFinds] = useState<PgQuickFind[]>([]);
  const [edit, setEdit] = useState<PgQuickFind | 'new' | null>(null);
  const [run, setRun] = useState<PgQuickFind | null>(null);
  const [runFields, setRunFields] = useState<RunField[]>([]);

  const [panelOpen, setPanelOpen] = useState(true);
  const [runTab, setRunTab] = useState<RunTab>('conditions');

  // Returned-columns picker (run-time only) — exact list from information_schema.
  const [colSuggestions, setColSuggestions] = useState<string[]>([]);
  const [colSelected, setColSelected] = useState<string[]>([]);
  const [colLoading, setColLoading] = useState(false);

  const [result, setResult] = useState<PgQuickFindResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<WireRow | null>(null);

  const [lastEntries, setLastEntries] = useState<PgQuickEntry[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { setQuickFinds(loadPgQuickFinds()); }, []);

  const connName = useCallback(
    (id: string) => connections.find((c) => c.id === id)?.name ?? null,
    [connections],
  );

  const startRun = useCallback((p: PgQuickFind) => {
    setRun(p);
    setRunFields(p.fields.map((f) => ({ ...f, checked: false, value: '', list: false })));
    setPanelOpen(true); setRunTab('conditions');
    setColSuggestions([]); setColSelected([]);
    setResult(null); setOffset(0); setError(null); setSelectedRow(null);
    setLastEntries([]);
  }, []);

  const buildEntries = useCallback(
    (): PgQuickEntry[] => runFields
      .filter((f) => f.checked)
      .map((f) => ({ column: f.column, type: f.type, value: f.value, list: f.list })),
    [runFields],
  );

  const doRun = useCallback(async (over?: { offset?: number }) => {
    if (!run) return;
    const effOffset = over?.offset ?? 0;
    setBusy(true); setError(null);
    try {
      const entries = buildEntries();
      const r = await pgQuickFind(run.connectionId, run.database, {
        schema: run.schema, table: run.table, entries,
        limit: run.limit, offset: effOffset,
        columns: colSelected.length ? colSelected : undefined,
      });
      setResult(r);
      setOffset(r.offset);
      setLastEntries(entries);
      setPanelOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [run, buildEntries, colSelected]);

  const openColumnsTab = useCallback(async () => {
    setRunTab('columns');
    if (!run || colSuggestions.length > 0) return;
    setColLoading(true);
    try {
      const cols = await listPgColumns(run.connectionId, run.database, run.schema, run.table);
      setColSuggestions(cols.map((c) => c.name));
    } catch { /* best-effort */ }
    finally { setColLoading(false); }
  }, [run, colSuggestions.length]);

  const enabledCount = runFields.filter((f) => f.checked).length;

  const querySummary = useMemo(() => {
    const parts = runFields
      .filter((f) => f.checked)
      .map((f) => (f.list ? `${f.column}:$in[${f.value.trim() || '?'}]` : `${f.column}:${f.value.trim() || '?'}`));
    return parts.length ? `{${parts.join(', ')}}` : '{ }';
  }, [runFields]);

  return (
    <div className="pg-qf">
      <div className="status-line" style={{ justifyContent: 'space-between' }}>
        <strong>Tìm nhanh</strong>
        <button className="chip-btn" onClick={() => setEdit('new')}>+ Tạo nút tìm nhanh</button>
      </div>

      {quickFinds.length === 0 && !edit && (
        <p className="empty">
          Chưa có nút tìm nhanh nào. Tạo một nút (ví dụ “Tìm extension”), chọn server + database +
          bảng và khai báo sẵn các cột hay query — lúc chạy chỉ việc tích và điền giá trị.
        </p>
      )}

      <div className="pg-qf-dock">
        {quickFinds.map((p) => {
          const missing = !connName(p.connectionId);
          return (
            <div key={p.id} className={`pg-qf-chip${run?.id === p.id ? ' active' : ''}`}>
              <button
                className="pg-qf-chip-main"
                title={missing ? 'Connection của preset này đã bị xoá — sửa lại preset' : `${connName(p.connectionId)} · ${p.database}.${p.schema}.${p.table}`}
                onClick={() => startRun(p)}
              >
                🔎 {p.name}{missing && ' ⚠'}
              </button>
              <button className="chip-btn" title="Sửa" onClick={() => setEdit(p)}>✎</button>
              <button
                className="chip-btn"
                title="Xoá nút này"
                onClick={() => {
                  setQuickFinds(removePgQuickFind(p.id));
                  if (run?.id === p.id) { setRun(null); setResult(null); }
                }}
              >✕</button>
            </div>
          );
        })}
      </div>

      {edit && (
        <QuickFindForm
          initial={edit === 'new' ? null : edit}
          connections={connections}
          onCancel={() => setEdit(null)}
          onSaved={(list) => { setQuickFinds(list); setEdit(null); }}
        />
      )}

      {run && !edit && (
        <div className="pg-qf-run">
          <div className="status-line" style={{ justifyContent: 'space-between' }}>
            <strong>🔎 {run.name}</strong>
            <span className="badge">
              {connName(run.connectionId) ?? '⚠ connection đã xoá'} · <code>{run.database}.{run.schema}.{run.table}</code> · limit {run.limit}
            </span>
          </div>

          {!panelOpen && (
            <div className="pg-qf-summary">
              <code className="pg-qf-summary-q" title={querySummary}>{querySummary}</code>
              {colSelected.length > 0 && (
                <span className="badge" title={colSelected.join(', ')}>→ {colSelected.length} cột</span>
              )}
              <button className="chip-btn" title="Sửa điều kiện" onClick={() => { setPanelOpen(true); setRunTab('conditions'); }}>✎ Điều kiện</button>
              <button className="chip-btn" title="Chọn cột trả về" onClick={() => { setPanelOpen(true); void openColumnsTab(); }}>
                ⚙ Cột trả về{colSelected.length > 0 ? ` (${colSelected.length})` : ''}
              </button>
            </div>
          )}

          {panelOpen && (
            <>
              <div className="pg-subnav">
                <button className={runTab === 'conditions' ? 'on' : ''} onClick={() => setRunTab('conditions')}>
                  Điều kiện{enabledCount > 0 ? ` (${enabledCount})` : ''}
                </button>
                <button className={runTab === 'columns' ? 'on' : ''} onClick={() => void openColumnsTab()}>
                  Cột trả về{colSelected.length > 0 ? ` (${colSelected.length})` : ''}
                </button>
              </div>

              {runTab === 'conditions' && (
                <div className="pg-qf-fields">
                  {runFields.map((f, i) => (
                    <div key={`${f.column}-${i}`} className={`pg-qf-field${f.checked ? ' on' : ''}`}>
                      <label className="pg-qf-pick" title={f.column}>
                        <input
                          type="checkbox"
                          checked={f.checked}
                          onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))}
                        />
                        <span className="pg-qf-labeltext">
                          <b>{f.label}</b>
                          <code>{f.column}</code>
                        </span>
                      </label>
                      <select
                        className="input pg-qf-type"
                        value={f.type}
                        disabled={!f.checked}
                        title="Kiểu giá trị — quyết định cách bind parameter"
                        onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value as PgQuickFieldType, list: e.target.value === 'boolean' ? false : x.list } : x)))}
                      >
                        {PG_QUICK_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <select
                        className="input pg-qf-mode"
                        value={f.list ? 'list' : 'single'}
                        disabled={!f.checked || f.type === 'boolean'}
                        title={f.type === 'boolean' ? 'Boolean chỉ so sánh bằng' : 'Single = so sánh bằng · List = nhiều giá trị cách nhau dấu phẩy → = ANY(...)'}
                        onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, list: e.target.value === 'list' } : x)))}
                      >
                        <option value="single">= single</option>
                        <option value="list">∈ list (ANY)</option>
                      </select>
                      {f.type === 'boolean' ? (
                        <select
                          className="input"
                          disabled={!f.checked}
                          value={f.value}
                          onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                        >
                          <option value="">— chọn —</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          className="input mono"
                          disabled={!f.checked}
                          value={f.value}
                          placeholder={f.list
                            ? 'nhiều giá trị, cách nhau dấu phẩy — vd. quidn,tamtd'
                            : f.type === 'number' ? 'số' : 'giá trị (so sánh bằng)'}
                          onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !busy && enabledCount > 0) void doRun(); }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {runTab === 'columns' && (
                <div className="pg-qf-proj">
                  <p className="pg-hint">
                    Tích cột muốn trả về — để trống = <code>SELECT *</code>. Danh sách lấy chính xác
                    từ <code>information_schema.columns</code> của bảng.
                  </p>
                  {colLoading && <p className="empty"><span className="spinner" /> Đang tải cột…</p>}
                  <div className="pg-qf-projgrid">
                    {colSuggestions.map((c) => (
                      <button
                        key={c}
                        className={`pg-qf-projchip${colSelected.includes(c) ? ' on' : ''}`}
                        onClick={() => setColSelected((sel) => (sel.includes(c) ? sel.filter((x) => x !== c) : [...sel, c]))}
                      >{colSelected.includes(c) ? '☑' : '☐'} {c}</button>
                    ))}
                  </div>
                  {colSelected.length > 0 && (
                    <div><button className="ghost sm" onClick={() => setColSelected([])}>Bỏ chọn hết</button></div>
                  )}
                </div>
              )}
            </>
          )}

          <div className="status-line" style={{ gap: 8 }}>
            <button className="sm" disabled={busy || enabledCount === 0} onClick={() => void doRun()}>
              {busy ? <span className="spinner" aria-hidden /> : '▶'} Chạy ({enabledCount} điều kiện, AND)
            </button>
            {result && (
              <>
                <span className="badge">{result.rowCount} dòng · offset {result.offset} · {result.tookMs}ms</span>
                <button className="chip-btn" disabled={busy || offset === 0} onClick={() => void doRun({ offset: Math.max(0, offset - run.limit) })}>← Prev</button>
                <button className="chip-btn" disabled={busy || !result.hasMore} onClick={() => void doRun({ offset: offset + run.limit })}>Next →</button>
                <button
                  className="chip-btn"
                  disabled={busy || result.rowCount === 0 || lastEntries.length === 0}
                  title="Xuất toàn bộ kết quả khớp query ra file Excel có định dạng"
                  onClick={() => setExportOpen(true)}
                >📄 Xuất báo cáo</button>
              </>
            )}
          </div>

          {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
          {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

          {result && (
            <div className={`pg-qf-rows${panelOpen ? '' : ' expanded'}`}>
              {result.rowCount === 0 && <p className="empty">Không có dòng nào khớp.</p>}
              {result.rows.map((r, i) => (
                <button
                  key={`${result.offset}-${i}`}
                  className="pg-qf-row"
                  title="Bấm để xem JSON đầy đủ"
                  onClick={() => setSelectedRow(r)}
                >
                  <span className="pg-doc-idx">#{result.offset + i + 1}</span>
                  <span className="pg-qf-row-text">{r.json}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedRow && (
        <div className="modal-backdrop" onClick={() => setSelectedRow(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 94vw)' }}>
            <div className="status-line" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0, flex: 1 }}>Row</h3>
              {selectedRow.truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
              <button className="ghost sm" onClick={() => { void navigator.clipboard?.writeText(prettyDoc(selectedRow.json)); }}>⧉ Copy</button>
              <button className="ghost sm" onClick={() => setSelectedRow(null)}>✕</button>
            </div>
            <pre className="code pg-doc-body" style={{ maxHeight: '70vh' }}>{prettyDoc(selectedRow.json)}</pre>
          </div>
        </div>
      )}

      {exportOpen && run && result && (
        <ExportModal
          connectionId={run.connectionId}
          db={run.database}
          schema={run.schema}
          table={run.table}
          entries={lastEntries}
          querySummary={querySummary}
          fieldSuggestions={colSuggestions.length ? colSuggestions : result.columns}
          initialPaths={colSelected.length ? colSelected : result.columns}
          defaultTitle={run.name}
          onClose={() => setExportOpen(false)}
          onDone={(rows, filename) => {
            setExportOpen(false);
            setNotice(`Đã xuất ${rows.toLocaleString('en-US')} dòng → ${filename}`);
            setTimeout(() => setNotice(null), 5000);
          }}
        />
      )}
    </div>
  );
}

// ── Preset config form ────────────────────────────────────────────────────────

function QuickFindForm({
  initial,
  connections,
  onCancel,
  onSaved,
}: {
  initial: PgQuickFind | null;
  connections: PublicPgConnection[];
  onCancel: () => void;
  onSaved: (list: PgQuickFind[]) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? connections[0]?.id ?? '');
  const [database, setDatabase] = useState(initial?.database ?? '');
  const [tableRef, setTableRef] = useState(initial ? `${initial.schema}.${initial.table}` : '');
  const [limit, setLimit] = useState(initial?.limit ?? 50);
  const [fields, setFields] = useState<PgQuickFindField[]>(
    initial?.fields?.length ? initial.fields : [{ label: 'Tenant', column: 'tenant_id', type: 'text' }],
  );

  const [dbOptions, setDbOptions] = useState<string[]>([]);
  const [tableOptions, setTableOptions] = useState<string[]>([]);
  const [colOptions, setColOptions] = useState<string[]>([]);

  useEffect(() => {
    if (!connectionId) { setDbOptions([]); return; }
    listPgDatabases(connectionId).then((ds) => setDbOptions(ds.map((d) => d.name))).catch(() => setDbOptions([]));
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !database.trim()) { setTableOptions([]); return; }
    listPgTables(connectionId, database.trim())
      .then((ts) => setTableOptions(ts.map((t) => `${t.schema}.${t.name}`)))
      .catch(() => setTableOptions([]));
  }, [connectionId, database]);

  const parsed = useMemo(() => {
    const s = tableRef.trim();
    if (!s) return null;
    const idx = s.indexOf('.');
    return idx === -1
      ? { schema: 'public', table: s }
      : { schema: s.slice(0, idx), table: s.slice(idx + 1) };
  }, [tableRef]);

  useEffect(() => {
    if (!connectionId || !database.trim() || !parsed) { setColOptions([]); return; }
    listPgColumns(connectionId, database.trim(), parsed.schema, parsed.table)
      .then((cs) => setColOptions(cs.map((c) => c.name)))
      .catch(() => setColOptions([]));
  }, [connectionId, database, parsed]);

  const validFields = useMemo(
    () => fields.filter((f) => f.label.trim() && f.column.trim()),
    [fields],
  );
  const canSave = !!name.trim() && !!connectionId && !!database.trim() && !!parsed && validFields.length > 0;

  const saveBody = (): Omit<PgQuickFind, 'id'> => ({
    name: name.trim(),
    connectionId,
    database: database.trim(),
    schema: parsed?.schema ?? 'public',
    table: parsed?.table ?? '',
    fields: validFields.map((f) => ({ label: f.label.trim(), column: f.column.trim(), type: f.type })),
    limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
  });

  return (
    <div className="pg-form pg-qf-form">
      <div className="status-line"><strong>{initial ? 'Sửa nút tìm nhanh' : 'Tạo nút tìm nhanh'}</strong></div>

      <div className="pg-form-row">
        <label className="pg-field" style={{ flex: 1 }}>
          <span>Tên nút <b style={{ color: 'var(--err)' }}>*</b></span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tìm extension" />
        </label>
        <label className="pg-field" style={{ flex: 1 }}>
          <span>PostgreSQL connection</span>
          <select className="input" value={connectionId} onChange={(e) => { setConnectionId(e.target.value); setDatabase(''); setTableRef(''); }}>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.project} / {c.name}</option>)}
          </select>
        </label>
      </div>

      <div className="pg-form-row">
        <label className="pg-field" style={{ flex: 1 }}>
          <span>Database</span>
          <input className="input mono" list="pg-qf-dbs" value={database}
            onChange={(e) => { setDatabase(e.target.value); setTableRef(''); }} placeholder="fusionpbx" />
          <datalist id="pg-qf-dbs">{dbOptions.map((d) => <option key={d} value={d} />)}</datalist>
        </label>
        <label className="pg-field" style={{ flex: 1 }}>
          <span>Bảng (schema.table — không có schema = public)</span>
          <input className="input mono" list="pg-qf-tables" value={tableRef}
            onChange={(e) => setTableRef(e.target.value)} placeholder="public.v_extensions" />
          <datalist id="pg-qf-tables">{tableOptions.map((t) => <option key={t} value={t} />)}</datalist>
        </label>
        <label className="pg-field" style={{ flex: '0 0 90px' }}>
          <span>Limit ≤200</span>
          <input className="input" type="number" min={1} max={200} value={limit}
            onChange={(e) => setLimit(Math.min(Math.max(Number(e.target.value) || 50, 1), 200))} />
        </label>
      </div>

      <div className="pg-field">
        <span>Cột cho phép query (tên hiển thị · column · kiểu mặc định)</span>
        {fields.map((f, i) => (
          <div key={i} className="pg-form-row" style={{ alignItems: 'center' }}>
            <input className="input" style={{ flex: 1 }} value={f.label} placeholder="Tenant"
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input className="input mono" style={{ flex: 1.4 }} value={f.column} list="pg-qf-cols" placeholder="tenant_id"
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))} />
            <select className="input" style={{ flex: '0 0 110px' }} value={f.type}
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value as PgQuickFieldType } : x)))}>
              {PG_QUICK_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button className="chip-btn" title="Bỏ cột này" disabled={fields.length <= 1}
              onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <datalist id="pg-qf-cols">{colOptions.map((c) => <option key={c} value={c} />)}</datalist>
        <div>
          <button className="ghost sm" onClick={() => setFields((fs) => [...fs, { label: '', column: '', type: 'text' }])}>
            + Thêm cột
          </button>
        </div>
      </div>

      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={!canSave}
          title={canSave ? 'Lưu preset' : 'Cần tên + connection + database + bảng + ít nhất 1 cột đủ label/column'}
          onClick={() => onSaved(initial ? updatePgQuickFind(initial.id, saveBody()) : addPgQuickFind(saveBody()))}
        >{initial ? 'Lưu' : 'Tạo'}</button>
      </div>
    </div>
  );
}
