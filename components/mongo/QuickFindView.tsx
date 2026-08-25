'use client';

// Quick-find — the Mongo counterpart of the Kafka preset dock. An operator
// defines a named button ("Tìm tenant") targeting one connection + database +
// collection with a curated field list; running it is: tick the fields you
// have values for → fill them → Run. The filter is equality-per-field with
// implicit AND; each field has a type (Text/ObjectId/Number/Boolean, default
// from the preset, overridable per run) so "_id" typed as hex becomes a real
// ObjectId in the query.
//
// SCREEN BUDGET: pressing Run COLLAPSES the setup panel into a one-line query
// summary ("domain = alice AND is_deleted = false · trả về 3 field") so the
// results strip gets the vertical space; ✎ on the summary reopens the panel.
//
// The setup panel has two tabs:
//   Điều kiện    — the preset's fields as checkboxes + typed values (AND).
//   Trường trả về — a RUN-TIME projection picker, deliberately NOT part of the
//                   preset config: field chips are DISCOVERED from sample
//                   documents of the live collection (plus free-text add for
//                   nested paths), tick what you want returned. Empty = full
//                   documents; `_id` has its own keep/exclude toggle.
//
// Results render one document per row as single-line plaintext in a
// horizontally-scrollable strip; clicking a row opens the full pretty JSON in
// a modal (same flow as the Kafka message search → drawer).
//
// ĐÍCH TÌM CHỌN LÚC CHẠY, KHÔNG CHỐT TRONG PRESET: database/collection trong
// cấu hình chỉ là MẶC ĐỊNH và được phép để trống (collection chia theo tháng
// thì chốt cứng là vô nghĩa). Mỗi lần chạy đều chọn lại được từ DANH SÁCH THẬT
// của server (TargetPicker — không có ô gõ tay); thiếu đích thì tới lúc bấm
// Chạy mới báo lỗi.
//
// Presets live in localStorage (lib/mongoQuickFinds) — personal bookmarks,
// like Kafka's. Queries reuse the same /api/mongo find action as the data
// browser, so every server-side bound (maxTimeMS, limit clamp) applies here too.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePresetSync } from '@/lib/presetSync';
import {
  findMongo,
  listMongoDatabases,
  listMongoCollections,
  prettyDoc,
  type PublicMongoConnection,
  type FindResult,
  type WireDoc,
} from '@/lib/mongo';
import {
  loadQuickFinds,
  addQuickFind,
  updateQuickFind,
  removeQuickFind,
  buildQuickFilter,
  buildQuickSort,
  QUICK_FIELD_TYPES,
  type MongoQuickFind,
  type QuickFindField,
  type QuickFieldType,
  type QuickSortDir,
} from '@/lib/mongoQuickFinds';
import ExportModal from './ExportModal';
import TargetPicker from '../TargetPicker';

export interface QuickFindViewProps {
  connections: PublicMongoConnection[];
}

/** Per-field state while running a preset. */
interface RunField extends QuickFindField {
  checked: boolean;
  value: string;
  /** true = comma-separated list → `{$in: [...]}` instead of equality. */
  list: boolean;
}

type RunTab = 'conditions' | 'projection';

/** Union of top-level keys across sample docs → projection suggestions. */
function deriveFieldNames(docs: WireDoc[]): string[] {
  const keys = new Set<string>();
  for (const d of docs.slice(0, 25)) {
    try {
      for (const k of Object.keys(JSON.parse(d.json) as Record<string, unknown>)) keys.add(k);
    } catch { /* truncated doc — skip */ }
  }
  keys.delete('_id'); // _id has its own toggle
  return [...keys].sort((a, b) => a.localeCompare(b));
}

export default function QuickFindView({ connections }: QuickFindViewProps) {
  const [quickFinds, setQuickFinds] = useState<MongoQuickFind[]>([]);
  const [edit, setEdit] = useState<MongoQuickFind | 'new' | null>(null);
  const [run, setRun] = useState<MongoQuickFind | null>(null);
  /** Đích của LẦN CHẠY NÀY — preset chỉ điền sẵn. Collection đặt theo tháng thì
   *  đổi thẳng ở đây, khỏi quay vào sửa preset. */
  const [runDb, setRunDb] = useState('');
  const [runColl, setRunColl] = useState('');
  const [dbOpts, setDbOpts] = useState<string[]>([]);
  const [collOpts, setCollOpts] = useState<string[]>([]);
  const [dbBusy, setDbBusy] = useState(false);
  const [collBusy, setCollBusy] = useState(false);
  const [runFields, setRunFields] = useState<RunField[]>([]);

  // Setup panel visibility + tab. Collapsed after a successful run.
  const [panelOpen, setPanelOpen] = useState(true);
  const [runTab, setRunTab] = useState<RunTab>('conditions');

  // Projection (run-time only, never persisted into the preset).
  const [projSuggestions, setProjSuggestions] = useState<string[]>([]);
  const [projSelected, setProjSelected] = useState<string[]>([]);
  const [projKeepId, setProjKeepId] = useState(true);
  const [projCustom, setProjCustom] = useState('');
  const [projLoading, setProjLoading] = useState(false);

  const [result, setResult] = useState<FindResult | null>(null);
  const [skip, setSkip] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<WireDoc | null>(null);

  // Export report — needs the EXACT filter of the last successful run.
  const [lastFilter, setLastFilter] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Presets live in localStorage — hydrate on mount (client-only).
  const reloadQf = useCallback(() => setQuickFinds(loadQuickFinds()), []);
  useEffect(() => { reloadQf(); }, [reloadQf]);
  usePresetSync('mongo.quickfinds', reloadQf);

  const connName = useCallback(
    (id: string) => connections.find((c) => c.id === id)?.name ?? null,
    [connections],
  );

  const loadDbs = useCallback(() => {
    if (!run) return;
    setDbBusy(true);
    listMongoDatabases(run.connectionId)
      .then((ds) => setDbOpts(ds.map((d) => d.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => setDbOpts([]))
      .finally(() => setDbBusy(false));
  }, [run]);

  const loadColls = useCallback(() => {
    if (!run || !runDb) { setCollOpts([]); return; }
    setCollBusy(true);
    listMongoCollections(run.connectionId, runDb)
      .then((cs) => setCollOpts(cs.map((c) => c.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => setCollOpts([]))
      .finally(() => setCollBusy(false));
  }, [run, runDb]);

  // Đổi database thì danh sách collection cũ vô nghĩa.
  useEffect(() => { setCollOpts([]); }, [runDb]);

  /** Open the run panel for a preset — every field starts unticked and empty. */
  const startRun = useCallback((p: MongoQuickFind) => {
    setRun(p);
    setRunFields(p.fields.map((f) => ({ ...f, checked: false, value: '', list: false })));
    setRunDb(p.database); setRunColl(p.collection);
    setDbOpts([]); setCollOpts([]);
    setPanelOpen(true); setRunTab('conditions');
    setProjSuggestions([]); setProjSelected([]); setProjKeepId(true); setProjCustom('');
    setResult(null); setSkip(0); setError(null); setSelectedDoc(null);
  }, []);

  /** Projection string for the find call — '' = full documents. */
  const buildProjection = useCallback((): string => {
    if (projSelected.length === 0) return '';
    const proj: Record<string, 0 | 1> = {};
    for (const f of projSelected) proj[f] = 1;
    if (!projKeepId) proj._id = 0;
    return JSON.stringify(proj);
  }, [projSelected, projKeepId]);

  const doRun = useCallback(async (over?: { skip?: number }) => {
    if (!run) return;
    // Preset để trống database/collection là hợp lệ — chỉ lúc bấm tìm mà vẫn
    // chưa chọn thì mới báo.
    if (!runDb || !runColl) {
      setError(`Chưa chọn ${!runDb ? 'database' : 'collection'} — bấm nút ở trên rồi chọn từ danh sách.`);
      return;
    }
    const effSkip = over?.skip ?? 0;
    setBusy(true); setError(null);
    try {
      const filter = buildQuickFilter(
        runFields.filter((f) => f.checked).map((f) => ({ path: f.path, type: f.type, value: f.value, list: f.list })),
      );
      const r = await findMongo(run.connectionId, runDb, runColl, {
        filter, projection: buildProjection(), sort: buildQuickSort(run.sort), limit: run.limit, skip: effSkip,
      });
      setResult(r);
      setSkip(r.skip);
      setLastFilter(filter); // the export re-queries with exactly this filter
      setPanelOpen(false); // results take the screen; the summary bar carries the query
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [run, runFields, buildProjection, runDb, runColl]);

  /**
   * Discover projectable fields when the tab opens: reuse the docs we already
   * have; otherwise sample 5 full documents from the live collection.
   */
  const openProjectionTab = useCallback(async () => {
    setRunTab('projection');
    if (!run || projSuggestions.length > 0 || !runDb || !runColl) return;
    const have = result?.docs?.length ? result.docs : null;
    if (have) { setProjSuggestions(deriveFieldNames(have)); return; }
    setProjLoading(true);
    try {
      const sample = await findMongo(run.connectionId, runDb, runColl, {
        filter: '', projection: '', sort: '', limit: 5, skip: 0,
      });
      setProjSuggestions(deriveFieldNames(sample.docs));
    } catch { /* suggestions are best-effort — free-text add still works */ }
    finally { setProjLoading(false); }
  }, [run, result, projSuggestions.length, runDb, runColl]);

  const toggleProj = useCallback((f: string) => {
    setProjSelected((sel) => (sel.includes(f) ? sel.filter((x) => x !== f) : [...sel, f]));
  }, []);

  const addCustomProj = useCallback(() => {
    const f = projCustom.trim();
    if (!f) return;
    setProjSuggestions((s) => (s.includes(f) ? s : [...s, f].sort((a, b) => a.localeCompare(b))));
    setProjSelected((sel) => (sel.includes(f) ? sel : [...sel, f]));
    setProjCustom('');
  }, [projCustom]);

  const enabledCount = runFields.filter((f) => f.checked).length;

  /** One-line compact summary: `{domain:alice, is_deleted:false}` · list → `domain:$in[alice,bob]`. */
  const querySummary = useMemo(() => {
    const parts = runFields
      .filter((f) => f.checked)
      .map((f) => (f.list ? `${f.path}:$in[${f.value.trim() || '?'}]` : `${f.path}:${f.value.trim() || '?'}`));
    return parts.length ? `{${parts.join(', ')}}` : '{ }';
  }, [runFields]);

  return (
    <div className="mongo-qf">
      {/* ── Preset buttons ──────────────────────────────────────────────── */}
      <div className="status-line" style={{ justifyContent: 'space-between' }}>
        <strong>Tìm nhanh</strong>
        <button className="chip-btn" onClick={() => setEdit('new')}>+ Tạo nút tìm nhanh</button>
      </div>

      {quickFinds.length === 0 && !edit && (
        <p className="empty">
          Chưa có nút tìm nhanh nào. Tạo một nút (ví dụ “Tìm tenant”), chọn cluster và khai báo sẵn
          các field hay query — lúc chạy chọn database/collection rồi tích field, điền giá trị.
          Để trống trong cấu hình cũng được: collection theo tháng thì chọn ngay lúc tìm.
        </p>
      )}

      <div className="mongo-qf-dock">
        {quickFinds.map((p) => {
          const missing = !connName(p.connectionId);
          return (
            <div key={p.id} className={`mongo-qf-chip${run?.id === p.id ? ' active' : ''}`}>
              <button
                className="mongo-qf-chip-main"
                title={missing
                  ? 'Connection của preset này đã bị xoá — sửa lại preset'
                  : `${connName(p.connectionId)} · ${p.database && p.collection ? `${p.database}.${p.collection}` : 'chưa đặt đích — chọn lúc chạy'}`}
                onClick={() => startRun(p)}
              >
                🔎 {p.name}{missing && ' ⚠'}
              </button>
              <button className="chip-btn" title="Sửa" onClick={() => setEdit(p)}>✎</button>
              <button
                className="chip-btn"
                title="Xoá nút này"
                onClick={() => {
                  setQuickFinds(removeQuickFind(p.id));
                  if (run?.id === p.id) { setRun(null); setResult(null); }
                }}
              >✕</button>
            </div>
          );
        })}
      </div>

      {/* ── Config form ─────────────────────────────────────────────────── */}
      {edit && (
        <QuickFindForm
          initial={edit === 'new' ? null : edit}
          connections={connections}
          onCancel={() => setEdit(null)}
          onSaved={(list) => { setQuickFinds(list); setEdit(null); }}
        />
      )}

      {/* ── Run panel ───────────────────────────────────────────────────── */}
      {run && !edit && (
        <div className="mongo-qf-run">
          <div className="status-line" style={{ justifyContent: 'space-between' }}>
            <strong>🔎 {run.name}</strong>
            <span className="badge">
              {connName(run.connectionId) ?? '⚠ connection đã xoá'} · limit {run.limit}
              {run.sort && ` · sort ${run.sort.path} ${run.sort.dir === 'desc' ? '↓' : '↑'}`}
            </span>
          </div>

          {/* Đích tìm của LẦN CHẠY NÀY — preset chỉ điền sẵn. */}
          <div className="mongo-qf-target">
            <TargetPicker
              label="Database"
              options={dbOpts}
              loading={dbBusy}
              value={runDb ? [runDb] : []}
              onChange={(v) => { setRunDb(v[0] ?? ''); setRunColl(''); setProjSuggestions([]); }}
              onOpen={() => { if (dbOpts.length === 0) loadDbs(); }}
              onReload={loadDbs}
              placeholder="— chọn database —"
            />
            <TargetPicker
              label="Collection"
              options={collOpts}
              loading={collBusy}
              value={runColl ? [runColl] : []}
              onChange={(v) => { setRunColl(v[0] ?? ''); setProjSuggestions([]); }}
              onOpen={() => { if (collOpts.length === 0) loadColls(); }}
              onReload={loadColls}
              disabled={!runDb}
              placeholder={runDb ? '— chọn collection —' : '— chọn database trước —'}
            />
            {(run.database || run.collection) && `${runDb}.${runColl}` !== `${run.database}.${run.collection}` && (
              <button className="chip-btn" title={`Về mặc định của preset: ${run.database}.${run.collection}`}
                onClick={() => { setRunDb(run.database); setRunColl(run.collection); setProjSuggestions([]); }}>
                ↺ Về mặc định
              </button>
            )}
          </div>

          {/* Collapsed: one-line query summary, results get the screen. */}
          {!panelOpen && (
            <div className="mongo-qf-summary">
              <code className="mongo-qf-summary-q" title={querySummary}>{querySummary}</code>
              {projSelected.length > 0 && (
                <span className="badge" title={projSelected.join(', ')}>→ {projSelected.length} field{projKeepId ? ' + _id' : ''}</span>
              )}
              <button className="chip-btn" title="Sửa điều kiện" onClick={() => { setPanelOpen(true); setRunTab('conditions'); }}>✎ Điều kiện</button>
              <button className="chip-btn" title="Chọn field trả về" onClick={() => { setPanelOpen(true); void openProjectionTab(); }}>
                ⚙ Trường trả về{projSelected.length > 0 ? ` (${projSelected.length})` : ''}
              </button>
            </div>
          )}

          {panelOpen && (
            <>
              <div className="mongo-subnav">
                <button className={runTab === 'conditions' ? 'on' : ''} onClick={() => setRunTab('conditions')}>
                  Điều kiện{enabledCount > 0 ? ` (${enabledCount})` : ''}
                </button>
                <button className={runTab === 'projection' ? 'on' : ''} onClick={() => void openProjectionTab()}>
                  Trường trả về{projSelected.length > 0 ? ` (${projSelected.length})` : ''}
                </button>
              </div>

              {runTab === 'conditions' && (
                <div className="mongo-qf-fields">
                  {runFields.map((f, i) => (
                    <div key={`${f.path}-${i}`} className={`mongo-qf-field${f.checked ? ' on' : ''}`}>
                      <label className="mongo-qf-pick" title={f.path}>
                        <input
                          type="checkbox"
                          checked={f.checked}
                          onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))}
                        />
                        <span className="mongo-qf-labeltext">
                          <b>{f.label}</b>
                          <code>{f.path}</code>
                        </span>
                      </label>
                      <select
                        className="input mongo-qf-type"
                        value={f.type}
                        disabled={!f.checked}
                        title="Kiểu giá trị — quyết định cách convert trước khi query"
                        onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value as QuickFieldType, list: e.target.value === 'boolean' ? false : x.list } : x)))}
                      >
                        {QUICK_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <select
                        className="input mongo-qf-mode"
                        value={f.list ? 'list' : 'single'}
                        disabled={!f.checked || f.type === 'boolean'}
                        title={f.type === 'boolean' ? 'Boolean chỉ so sánh bằng' : 'Single = so sánh bằng · List = nhiều giá trị cách nhau dấu phẩy → $in'}
                        onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, list: e.target.value === 'list' } : x)))}
                      >
                        <option value="single">= single</option>
                        <option value="list">∈ list ($in)</option>
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
                            ? 'nhiều giá trị, cách nhau dấu phẩy — vd. alice,bob'
                            : f.type === 'objectId' ? '24 ký tự hex — sẽ convert sang ObjectId' : f.type === 'number' ? 'số' : 'giá trị (so sánh bằng)'}
                          onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !busy && enabledCount > 0) void doRun(); }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {runTab === 'projection' && (
                <div className="mongo-qf-proj">
                  <p className="mongo-qf-hint">
                    Tích field muốn trả về — để trống = trả về nguyên document. Field gợi ý được lấy
                    từ documents thật của collection; field nested (vd. <code>profile.phone</code>) thêm ở ô dưới.
                  </p>
                  {projLoading && <p className="empty"><span className="spinner" /> Đang lấy mẫu field…</p>}
                  <div className="mongo-qf-projgrid">
                    <button
                      className={`mongo-qf-projchip special${projKeepId ? ' on' : ''}`}
                      title="_id luôn được MongoDB trả về trừ khi chủ động loại"
                      onClick={() => setProjKeepId((v) => !v)}
                    >{projKeepId ? '☑' : '☐'} _id</button>
                    {projSuggestions.map((f) => (
                      <button
                        key={f}
                        className={`mongo-qf-projchip${projSelected.includes(f) ? ' on' : ''}`}
                        onClick={() => toggleProj(f)}
                      >{projSelected.includes(f) ? '☑' : '☐'} {f}</button>
                    ))}
                  </div>
                  <div className="status-line" style={{ gap: 8 }}>
                    <input
                      className="input mono"
                      style={{ flex: 1, maxWidth: 320 }}
                      value={projCustom}
                      onChange={(e) => setProjCustom(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addCustomProj()}
                      placeholder="thêm field / nested path — vd. profile.phone"
                    />
                    <button className="ghost sm" disabled={!projCustom.trim()} onClick={addCustomProj}>+ Thêm</button>
                    {projSelected.length > 0 && (
                      <button className="ghost sm" onClick={() => setProjSelected([])}>Bỏ chọn hết</button>
                    )}
                  </div>
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
                <span className="badge">{result.docs.length} docs · skip {result.skip} · {result.tookMs}ms</span>
                <button className="chip-btn" disabled={busy || skip === 0} onClick={() => void doRun({ skip: Math.max(0, skip - run.limit) })}>← Prev</button>
                <button className="chip-btn" disabled={busy || !result.hasMore} onClick={() => void doRun({ skip: skip + run.limit })}>Next →</button>
                <button
                  className="chip-btn"
                  disabled={busy || result.docs.length === 0 || !lastFilter}
                  title="Xuất toàn bộ kết quả khớp query ra file Excel có định dạng"
                  onClick={() => setExportOpen(true)}
                >📄 Xuất báo cáo</button>
              </>
            )}
          </div>

          {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
          {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

          {result && (
            <div className={`mongo-qf-rows${panelOpen ? '' : ' expanded'}`}>
              {result.docs.length === 0 && <p className="empty">Không có document nào khớp.</p>}
              {result.docs.map((d, i) => (
                <button
                  key={`${result.skip}-${i}`}
                  className="mongo-qf-row"
                  title="Bấm để xem JSON đầy đủ"
                  onClick={() => setSelectedDoc(d)}
                >
                  <span className="mongo-doc-idx">#{result.skip + i + 1}</span>
                  <span className="mongo-qf-row-text">{d.json}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedDoc && <DocModal doc={selectedDoc} onClose={() => setSelectedDoc(null)} />}

      {exportOpen && run && result && (
        <ExportModal
          connectionId={run.connectionId}
          db={runDb}
          coll={runColl}
          filter={lastFilter}
          querySummary={querySummary}
          fieldSuggestions={[...new Set(['_id', ...projSuggestions, ...projSelected, ...run.fields.map((f) => f.path), ...deriveFieldNames(result.docs)])]}
          initialPaths={projSelected.length
            ? (projKeepId ? ['_id', ...projSelected] : projSelected)
            : ['_id', ...deriveFieldNames(result.docs)].slice(0, 8)}
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
  initial: MongoQuickFind | null;
  connections: PublicMongoConnection[];
  onCancel: () => void;
  onSaved: (list: MongoQuickFind[]) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? connections[0]?.id ?? '');
  const [database, setDatabase] = useState(initial?.database ?? '');
  const [collection, setCollection] = useState(initial?.collection ?? '');
  const [limit, setLimit] = useState(initial?.limit ?? 50);
  // Sort là TUỲ CHỌN — path trống nghĩa là không sort, giữ thứ tự tự nhiên.
  const [sortPath, setSortPath] = useState(initial?.sort?.path ?? '');
  const [sortDir, setSortDir] = useState<QuickSortDir>(initial?.sort?.dir ?? 'desc');
  const [fields, setFields] = useState<QuickFindField[]>(
    initial?.fields?.length ? initial.fields : [{ label: 'ID', path: '_id', type: 'objectId' }],
  );

  // Datalist suggestions — best-effort (a denied listDatabases just means no
  // suggestions; the inputs still accept free text).
  const [dbOptions, setDbOptions] = useState<string[]>([]);
  const [collOptions, setCollOptions] = useState<string[]>([]);
  const [dbBusy, setDbBusy] = useState(false);
  const [collBusy, setCollBusy] = useState(false);

  const loadDbs = useCallback(() => {
    if (!connectionId) { setDbOptions([]); return; }
    setDbBusy(true);
    listMongoDatabases(connectionId)
      .then((ds) => setDbOptions(ds.map((d) => d.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => setDbOptions([]))
      .finally(() => setDbBusy(false));
  }, [connectionId]);

  const loadColls = useCallback(() => {
    if (!connectionId || !database) { setCollOptions([]); return; }
    setCollBusy(true);
    listMongoCollections(connectionId, database)
      .then((cs) => setCollOptions(cs.map((c) => c.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => setCollOptions([]))
      .finally(() => setCollBusy(false));
  }, [connectionId, database]);
  // Đổi connection/database thì danh sách cũ vô nghĩa — xoá, mở picker mới nạp.
  useEffect(() => { setDbOptions([]); setCollOptions([]); }, [connectionId]);
  useEffect(() => { setCollOptions([]); }, [database]);

  const validFields = useMemo(
    () => fields.filter((f) => f.label.trim() && f.path.trim()),
    [fields],
  );
  // Database/collection KHÔNG bắt buộc — collection theo tháng thì chọn lúc
  // chạy, chỉ khi bấm tìm mà vẫn trống mới báo lỗi.
  const canSave = !!name.trim() && !!connectionId && validFields.length > 0;

  const saveBody = (): Omit<MongoQuickFind, 'id'> => ({
    name: name.trim(),
    connectionId,
    database: database.trim(),
    collection: collection.trim(),
    fields: validFields.map((f) => ({ label: f.label.trim(), path: f.path.trim(), type: f.type })),
    limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
    // Luôn có mặt trong patch (kể cả undefined) — updateQuickFind merge nông,
    // thiếu khoá là sort cũ sống lại sau khi người dùng đã xoá.
    sort: sortPath.trim() ? { path: sortPath.trim(), dir: sortDir } : undefined,
  });

  return (
    <div className="mongo-form mongo-qf-form">
      <div className="status-line"><strong>{initial ? 'Sửa nút tìm nhanh' : 'Tạo nút tìm nhanh'}</strong></div>

      <div className="mongo-form-row">
        <label className="mongo-field" style={{ flex: 1 }}>
          <span>Tên nút <b style={{ color: 'var(--err)' }}>*</b></span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tìm tenant" />
        </label>
        <label className="mongo-field" style={{ flex: 1 }}>
          <span>MongoDB connection</span>
          <select className="input" value={connectionId} onChange={(e) => { setConnectionId(e.target.value); setDatabase(''); setCollection(''); }}>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.project} / {c.name}</option>)}
          </select>
        </label>
      </div>

      <div className="mongo-form-row">
        <label className="mongo-field" style={{ flex: 1 }}>
          <span>Database mặc định <i style={{ color: 'var(--faint)', fontStyle: 'normal' }}>(không bắt buộc)</i></span>
          <TargetPicker
            label="Database"
            options={dbOptions}
            loading={dbBusy}
            value={database ? [database] : []}
            onChange={(v) => { setDatabase(v[0] ?? ''); setCollection(''); }}
            onOpen={() => { if (dbOptions.length === 0) loadDbs(); }}
            onReload={loadDbs}
            disabled={!connectionId}
            placeholder="— để trống, chọn lúc chạy —"
          />
        </label>
        <label className="mongo-field" style={{ flex: 1 }}>
          <span>Collection mặc định <i style={{ color: 'var(--faint)', fontStyle: 'normal' }}>(không bắt buộc)</i></span>
          <TargetPicker
            label="Collection"
            options={collOptions}
            loading={collBusy}
            value={collection ? [collection] : []}
            onChange={(v) => setCollection(v[0] ?? '')}
            onOpen={() => { if (collOptions.length === 0) loadColls(); }}
            onReload={loadColls}
            disabled={!database}
            placeholder={database ? '— để trống, chọn lúc chạy —' : '— chọn database trước —'}
          />
        </label>
        <label className="mongo-field" style={{ flex: '0 0 90px' }}>
          <span>Limit ≤200</span>
          <input className="input" type="number" min={1} max={200} value={limit}
            onChange={(e) => setLimit(Math.min(Math.max(Number(e.target.value) || 50, 1), 200))} />
        </label>
      </div>

      <div className="mongo-form-row">
        <label className="mongo-field" style={{ flex: 1 }}>
          <span>Sắp xếp theo field <i style={{ color: 'var(--faint)', fontStyle: 'normal' }}>(không bắt buộc — trống = thứ tự tự nhiên)</i></span>
          <input
            className="input mono"
            value={sortPath}
            onChange={(e) => setSortPath(e.target.value)}
            placeholder="vd. created_at — hỗ trợ nested path (profile.updated_at)"
            list="mongo-qf-sort-paths"
          />
          <datalist id="mongo-qf-sort-paths">
            {[...new Set(fields.map((f) => f.path.trim()).filter(Boolean))].map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>
        <label className="mongo-field" style={{ flex: '0 0 160px' }}>
          <span>Chiều</span>
          <select
            className="input"
            value={sortDir}
            disabled={!sortPath.trim()}
            title={sortPath.trim() ? 'Chiều sắp xếp' : 'Điền field sort trước'}
            onChange={(e) => setSortDir(e.target.value as QuickSortDir)}
          >
            <option value="desc">↓ giảm dần (mới nhất trước)</option>
            <option value="asc">↑ tăng dần</option>
          </select>
        </label>
      </div>

      <div className="mongo-field">
        <span>Fields cho phép query (tên hiển thị · field path · kiểu mặc định)</span>
        {fields.map((f, i) => (
          <div key={i} className="mongo-form-row" style={{ alignItems: 'center' }}>
            <input className="input" style={{ flex: 1 }} value={f.label} placeholder="ID"
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input className="input mono" style={{ flex: 1.4 }} value={f.path} placeholder="_id"
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
            <select className="input" style={{ flex: '0 0 110px' }} value={f.type}
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value as QuickFieldType } : x)))}>
              {QUICK_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button className="chip-btn" title="Bỏ field này" disabled={fields.length <= 1}
              onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <div>
          <button className="ghost sm" onClick={() => setFields((fs) => [...fs, { label: '', path: '', type: 'text' }])}>
            + Thêm field
          </button>
        </div>
      </div>

      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={!canSave}
          title={canSave ? 'Lưu preset' : 'Cần tên + connection + ít nhất 1 field đủ label/path'}
          onClick={() => onSaved(initial ? updateQuickFind(initial.id, saveBody()) : addQuickFind(saveBody()))}
        >{initial ? 'Lưu' : 'Tạo'}</button>
      </div>
    </div>
  );
}

// ── Document modal (pretty JSON, same flow as Kafka's message drawer) ─────────

function DocModal({ doc, onClose }: { doc: WireDoc; onClose: () => void }) {
  const pretty = prettyDoc(doc.json);
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Document</h3>
          {doc.truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
          <button
            className="ghost sm"
            onClick={() => { void navigator.clipboard?.writeText(pretty).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
          >{copied ? '✓ Đã copy' : '⧉ Copy'}</button>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>
        <pre className="code mongo-doc-body" style={{ maxHeight: '70vh' }}>{pretty}</pre>
      </div>
    </div>
  );
}
