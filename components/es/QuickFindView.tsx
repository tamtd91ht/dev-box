'use client';

// Quick-find for Elasticsearch — same experience as the Mongo tab: named preset
// buttons (connection + curated queryable fields), run = tick fields,
// fill values, AND across them (bool.filter). Field types map to ES clauses
// (Exact→term · Text→match · Số/Boolean→term); list mode ("a,b") → terms /
// bool.should. Pressing Run collapses the setup panel into a one-line summary
// so results get the screen; a second tab picks the returned fields (_source),
// chip-suggested from live sample documents. Results: one document per row,
// click → pretty-JSON modal. Export re-queries everything into a styled .xlsx.
//
// ĐÍCH TÌM CHỌN LÚC CHẠY, KHÔNG CHỐT TRONG PRESET. Index ở đây phần lớn chia
// theo thời gian (…_11_2025, …_12_2025) nên preset chỉ giữ index MẶC ĐỊNH và
// được phép để trống; mỗi lần bấm nút đều chọn lại được, CHỌN NHIỀU INDEX một
// lượt (ES nhận "a,b"). Thiếu index thì tới lúc bấm Chạy mới báo, không chặn
// từ lúc lưu preset.
// Mọi chỗ chọn index đều là DANH SÁCH THẬT lấy từ cluster (TargetPicker) —
// không có ô gõ tay, vì gõ sai một cái tên thì query trả rỗng mà không ai biết.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePresetSync } from '@/lib/presetSync';
import {
  searchEs,
  listEsIndices,
  prettyDoc,
  deriveEsFieldNames,
  type PublicEsConnection,
  type EsSearchResult,
  type WireDoc,
} from '@/lib/es';
import {
  loadEsQuickFinds,
  addEsQuickFind,
  updateEsQuickFind,
  removeEsQuickFind,
  buildEsQuickQuery,
  ES_QUICK_FIELD_TYPES,
  type EsQuickFind,
  type EsQuickFindField,
  type EsQuickFieldType,
} from '@/lib/esQuickFinds';
import ExportModal from './ExportModal';
import JsonViewer from './JsonViewer';
import TargetPicker from '../TargetPicker';

export interface QuickFindViewProps {
  connections: PublicEsConnection[];
}

/** Index nào cũng chọn từ danh sách thật của cluster — dùng chung cho ô cấu
 *  hình preset và ô chọn lúc chạy, nên gom vào một hook nhỏ. */
function useIndexOptions(connectionId: string) {
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    if (!connectionId) { setOptions([]); return; }
    setLoading(true);
    listEsIndices(connectionId)
      .then((is) => setOptions(is.map((i) => i.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => setOptions([]))
      .finally(() => setLoading(false));
  }, [connectionId]);
  // Đổi cluster thì danh sách cũ vô nghĩa — xoá ngay, đợi mở picker mới nạp.
  useEffect(() => { setOptions([]); }, [connectionId]);
  return { options, loading, load };
}

interface RunField extends EsQuickFindField {
  checked: boolean;
  value: string;
  list: boolean;
}

type RunTab = 'conditions' | 'source';

export default function QuickFindView({ connections }: QuickFindViewProps) {
  const [quickFinds, setQuickFinds] = useState<EsQuickFind[]>([]);
  const [edit, setEdit] = useState<EsQuickFind | 'new' | null>(null);
  const [run, setRun] = useState<EsQuickFind | null>(null);
  const [runFields, setRunFields] = useState<RunField[]>([]);
  /** Index dùng CHO LẦN CHẠY NÀY — lấy sẵn từ preset nhưng đổi thoải mái, vì
   *  index theo tháng thì preset không thể chốt cứng được. */
  const [runIndices, setRunIndices] = useState<string[]>([]);
  const runIdx = useIndexOptions(run?.connectionId ?? '');
  /** Chuỗi index gửi cho ES — nhiều index thì nối bằng dấu phẩy. */
  const indexArg = runIndices.join(',');

  const [panelOpen, setPanelOpen] = useState(true);
  const [runTab, setRunTab] = useState<RunTab>('conditions');

  // _source picker (run-time only).
  const [srcSuggestions, setSrcSuggestions] = useState<string[]>([]);
  const [srcSelected, setSrcSelected] = useState<string[]>([]);
  const [srcCustom, setSrcCustom] = useState('');
  const [srcLoading, setSrcLoading] = useState(false);

  const [result, setResult] = useState<EsSearchResult | null>(null);
  const [from, setFrom] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<WireDoc | null>(null);

  const [lastQuery, setLastQuery] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reloadQf = useCallback(() => setQuickFinds(loadEsQuickFinds()), []);
  useEffect(() => { reloadQf(); }, [reloadQf]);
  usePresetSync('es.quickfinds', reloadQf);

  const connName = useCallback(
    (id: string) => connections.find((c) => c.id === id)?.name ?? null,
    [connections],
  );

  const startRun = useCallback((p: EsQuickFind) => {
    setRun(p);
    setRunFields(p.fields.map((f) => ({ ...f, checked: false, value: '', list: false })));
    setRunIndices(p.indices);
    setPanelOpen(true); setRunTab('conditions');
    setSrcSuggestions([]); setSrcSelected([]); setSrcCustom('');
    setResult(null); setFrom(0); setError(null); setSelectedDoc(null);
  }, []);

  const buildSource = useCallback(
    (): string => (srcSelected.length ? JSON.stringify(srcSelected) : ''),
    [srcSelected],
  );

  const doRun = useCallback(async (over?: { from?: number }) => {
    if (!run) return;
    // Preset để trống index là chuyện bình thường (index theo tháng) — chỉ tới
    // lúc bấm tìm mà vẫn chưa chọn thì mới báo.
    if (runIndices.length === 0) {
      setError('Chưa chọn index — bấm “Index” ở trên và chọn ít nhất một cái từ danh sách.');
      return;
    }
    const effFrom = over?.from ?? 0;
    setBusy(true); setError(null);
    try {
      const query = buildEsQuickQuery(
        runFields.filter((f) => f.checked).map((f) => ({ path: f.path, type: f.type, value: f.value, list: f.list })),
      );
      const r = await searchEs(run.connectionId, indexArg, {
        query, sort: '', source: buildSource(), size: run.limit, from: effFrom,
      });
      setResult(r);
      setFrom(r.from);
      setLastQuery(query);
      setPanelOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [run, runFields, buildSource, runIndices, indexArg]);

  const openSourceTab = useCallback(async () => {
    setRunTab('source');
    if (!run || srcSuggestions.length > 0 || runIndices.length === 0) return;
    const have = result?.docs?.length ? result.docs : null;
    if (have) { setSrcSuggestions(deriveEsFieldNames(have)); return; }
    setSrcLoading(true);
    try {
      const sample = await searchEs(run.connectionId, indexArg, { query: '', sort: '', source: '', size: 5, from: 0 });
      setSrcSuggestions(deriveEsFieldNames(sample.docs));
    } catch { /* best-effort */ }
    finally { setSrcLoading(false); }
  }, [run, result, srcSuggestions.length, runIndices.length, indexArg]);

  const enabledCount = runFields.filter((f) => f.checked).length;

  const querySummary = useMemo(() => {
    const parts = runFields
      .filter((f) => f.checked)
      .map((f) => (f.list ? `${f.path}:$in[${f.value.trim() || '?'}]` : `${f.path}:${f.value.trim() || '?'}`));
    return parts.length ? `{${parts.join(', ')}}` : '{ }';
  }, [runFields]);

  return (
    <div className="es-qf">
      <div className="status-line" style={{ justifyContent: 'space-between' }}>
        <strong>Tìm nhanh</strong>
        <button className="chip-btn" onClick={() => setEdit('new')}>+ Tạo nút tìm nhanh</button>
      </div>

      {quickFinds.length === 0 && !edit && (
        <p className="empty">
          Chưa có nút tìm nhanh nào. Tạo một nút (ví dụ “Tìm customer”), chọn cluster và khai báo sẵn
          các field hay query — lúc chạy chọn index rồi tích field, điền giá trị. Index để trống trong
          cấu hình cũng được: index theo tháng thì chọn ngay lúc tìm.
        </p>
      )}

      <div className="es-qf-dock">
        {quickFinds.map((p) => {
          const missing = !connName(p.connectionId);
          return (
            <div key={p.id} className={`es-qf-chip${run?.id === p.id ? ' active' : ''}`}>
              <button
                className="es-qf-chip-main"
                title={missing
                  ? 'Connection của preset này đã bị xoá — sửa lại preset'
                  : `${connName(p.connectionId)} · ${p.indices.length ? p.indices.join(', ') : 'chưa đặt index — chọn lúc chạy'}`}
                onClick={() => startRun(p)}
              >
                🔎 {p.name}{missing && ' ⚠'}
              </button>
              <button className="chip-btn" title="Sửa" onClick={() => setEdit(p)}>✎</button>
              <button
                className="chip-btn"
                title="Xoá nút này"
                onClick={() => {
                  setQuickFinds(removeEsQuickFind(p.id));
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
        <div className="es-qf-run">
          <div className="status-line" style={{ justifyContent: 'space-between' }}>
            <strong>🔎 {run.name}</strong>
            <span className="badge">
              {connName(run.connectionId) ?? '⚠ connection đã xoá'} · size {run.limit}
            </span>
          </div>

          {/* Đích tìm của LẦN CHẠY NÀY. Preset chỉ điền sẵn — index đặt theo
              tháng thì đổi ở đây, không phải quay vào sửa preset. */}
          <div className="es-qf-target">
            <TargetPicker
              label="Index"
              multi
              options={runIdx.options}
              loading={runIdx.loading}
              value={runIndices}
              onChange={(v) => { setRunIndices(v); setSrcSuggestions([]); }}
              onOpen={() => { if (runIdx.options.length === 0) runIdx.load(); }}
              onReload={runIdx.load}
              placeholder="— chọn index để tìm —"
            />
            {runIndices.length > 0 && (
              <span className="small" style={{ color: 'var(--faint)' }}>
                tìm trên {runIndices.length} index một lượt
              </span>
            )}
            {run.indices.length > 0 && indexArg !== run.indices.join(',') && (
              <button className="chip-btn" title={`Về index mặc định của preset: ${run.indices.join(', ')}`}
                onClick={() => { setRunIndices(run.indices); setSrcSuggestions([]); }}>
                ↺ Về mặc định
              </button>
            )}
          </div>

          {!panelOpen && (
            <div className="es-qf-summary">
              <code className="es-qf-summary-q" title={querySummary}>{querySummary}</code>
              {srcSelected.length > 0 && (
                <span className="badge" title={srcSelected.join(', ')}>→ {srcSelected.length} field</span>
              )}
              <button className="chip-btn" title="Sửa điều kiện" onClick={() => { setPanelOpen(true); setRunTab('conditions'); }}>✎ Điều kiện</button>
              <button className="chip-btn" title="Chọn field trả về" onClick={() => { setPanelOpen(true); void openSourceTab(); }}>
                ⚙ Trường trả về{srcSelected.length > 0 ? ` (${srcSelected.length})` : ''}
              </button>
            </div>
          )}

          {panelOpen && (
            <>
              <div className="es-subnav">
                <button className={runTab === 'conditions' ? 'on' : ''} onClick={() => setRunTab('conditions')}>
                  Điều kiện{enabledCount > 0 ? ` (${enabledCount})` : ''}
                </button>
                <button className={runTab === 'source' ? 'on' : ''} onClick={() => void openSourceTab()}>
                  Trường trả về{srcSelected.length > 0 ? ` (${srcSelected.length})` : ''}
                </button>
              </div>

              {runTab === 'conditions' && (
                <div className="es-qf-fields">
                  {runFields.map((f, i) => (
                    <div key={`${f.path}-${i}`} className={`es-qf-field${f.checked ? ' on' : ''}`}>
                      <label className="es-qf-pick" title={f.path}>
                        <input
                          type="checkbox"
                          checked={f.checked}
                          onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))}
                        />
                        <span className="es-qf-labeltext">
                          <b>{f.label}</b>
                          <code>{f.path}</code>
                        </span>
                      </label>
                      <select
                        className="input es-qf-type"
                        value={f.type}
                        disabled={!f.checked}
                        title="Kiểu match — Exact dùng term (keyword/ID), Text dùng match (field analyzed)"
                        onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value as EsQuickFieldType, list: e.target.value === 'boolean' ? false : x.list } : x)))}
                      >
                        {ES_QUICK_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <select
                        className="input es-qf-mode"
                        value={f.list ? 'list' : 'single'}
                        disabled={!f.checked || f.type === 'boolean'}
                        title={f.type === 'boolean' ? 'Boolean chỉ so sánh bằng' : 'Single = 1 giá trị · List = nhiều giá trị cách nhau dấu phẩy → terms'}
                        onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, list: e.target.value === 'list' } : x)))}
                      >
                        <option value="single">= single</option>
                        <option value="list">∈ list (terms)</option>
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
                            : f.type === 'number' ? 'số' : f.type === 'text' ? 'từ khoá (match)' : 'giá trị chính xác (term)'}
                          onChange={(e) => setRunFields((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !busy && enabledCount > 0) void doRun(); }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {runTab === 'source' && (
                <div className="es-qf-proj">
                  <p className="es-hint">
                    Tích field muốn trả về (<code>_source</code>) — để trống = trả nguyên document.
                    Field gợi ý lấy từ documents thật của index; <code>_id</code> luôn có sẵn.
                  </p>
                  {srcLoading && <p className="empty"><span className="spinner" /> Đang lấy mẫu field…</p>}
                  <div className="es-qf-projgrid">
                    {srcSuggestions.map((f) => (
                      <button
                        key={f}
                        className={`es-qf-projchip${srcSelected.includes(f) ? ' on' : ''}`}
                        onClick={() => setSrcSelected((sel) => (sel.includes(f) ? sel.filter((x) => x !== f) : [...sel, f]))}
                      >{srcSelected.includes(f) ? '☑' : '☐'} {f}</button>
                    ))}
                  </div>
                  <div className="status-line" style={{ gap: 8 }}>
                    <input
                      className="input mono"
                      style={{ flex: 1, maxWidth: 320 }}
                      value={srcCustom}
                      onChange={(e) => setSrcCustom(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        const f = srcCustom.trim();
                        if (!f) return;
                        setSrcSuggestions((s) => (s.includes(f) ? s : [...s, f].sort((a, b) => a.localeCompare(b))));
                        setSrcSelected((sel) => (sel.includes(f) ? sel : [...sel, f]));
                        setSrcCustom('');
                      }}
                      placeholder="thêm field / nested path — vd. profile.phone"
                    />
                    {srcSelected.length > 0 && (
                      <button className="ghost sm" onClick={() => setSrcSelected([])}>Bỏ chọn hết</button>
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
                <span className="badge">
                  {result.total.toLocaleString('en-US')}{result.totalRelation === 'gte' ? '+' : ''} khớp · hiển thị {result.docs.length} · from {result.from} · {result.tookMs}ms
                </span>
                <button className="chip-btn" disabled={busy || from === 0} onClick={() => void doRun({ from: Math.max(0, from - run.limit) })}>← Prev</button>
                <button className="chip-btn" disabled={busy || result.from + result.docs.length >= result.total} onClick={() => void doRun({ from: from + run.limit })}>Next →</button>
                <button
                  className="chip-btn"
                  disabled={busy || result.docs.length === 0 || !lastQuery}
                  title="Xuất toàn bộ kết quả khớp query ra file Excel có định dạng"
                  onClick={() => setExportOpen(true)}
                >📄 Xuất báo cáo</button>
              </>
            )}
          </div>

          {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
          {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

          {result && (
            <div className={`es-qf-rows${panelOpen ? '' : ' expanded'}`}>
              {result.docs.length === 0 && <p className="empty">Không có document nào khớp.</p>}
              {result.docs.map((d, i) => (
                <button
                  key={`${result.from}-${i}`}
                  className="es-qf-row"
                  title="Bấm để xem JSON đầy đủ"
                  onClick={() => setSelectedDoc(d)}
                >
                  <span className="es-doc-idx">#{result.from + i + 1}</span>
                  <span className="es-qf-row-text">{d.json}</span>
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
          index={indexArg}
          query={lastQuery}
          querySummary={querySummary}
          fieldSuggestions={[...new Set(['_id', ...srcSuggestions, ...srcSelected, ...run.fields.map((f) => f.path), ...deriveEsFieldNames(result.docs)])]}
          initialPaths={srcSelected.length ? ['_id', ...srcSelected] : ['_id', ...deriveEsFieldNames(result.docs)].slice(0, 8)}
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
  initial: EsQuickFind | null;
  connections: PublicEsConnection[];
  onCancel: () => void;
  onSaved: (list: EsQuickFind[]) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? connections[0]?.id ?? '');
  const [indices, setIndices] = useState<string[]>(initial?.indices ?? []);
  const [limit, setLimit] = useState(initial?.limit ?? 50);
  const [fields, setFields] = useState<EsQuickFindField[]>(
    initial?.fields?.length ? initial.fields : [{ label: 'Tenant', path: 'tenantId', type: 'keyword' }],
  );

  const idx = useIndexOptions(connectionId);

  const validFields = useMemo(
    () => fields.filter((f) => f.label.trim() && f.path.trim()),
    [fields],
  );
  // Index KHÔNG bắt buộc — thiếu thì lúc chạy chọn, chỉ bấm tìm mới báo lỗi.
  const canSave = !!name.trim() && !!connectionId && validFields.length > 0;

  const saveBody = (): Omit<EsQuickFind, 'id'> => ({
    name: name.trim(),
    connectionId,
    indices,
    fields: validFields.map((f) => ({ label: f.label.trim(), path: f.path.trim(), type: f.type })),
    limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
  });

  return (
    <div className="es-form es-qf-form">
      <div className="status-line"><strong>{initial ? 'Sửa nút tìm nhanh' : 'Tạo nút tìm nhanh'}</strong></div>

      <div className="es-form-row">
        <label className="es-field" style={{ flex: 1 }}>
          <span>Tên nút <b style={{ color: 'var(--err)' }}>*</b></span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tìm customer" />
        </label>
        <label className="es-field" style={{ flex: 1 }}>
          <span>Elastic connection</span>
          <select className="input" value={connectionId} onChange={(e) => { setConnectionId(e.target.value); setIndices([]); }}>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.project} / {c.name}</option>)}
          </select>
        </label>
      </div>

      <div className="es-form-row">
        <label className="es-field" style={{ flex: 1 }}>
          <span>Index mặc định <i style={{ color: 'var(--faint)', fontStyle: 'normal' }}>(không bắt buộc)</i></span>
          <TargetPicker
            label="Index"
            multi
            options={idx.options}
            loading={idx.loading}
            value={indices}
            onChange={setIndices}
            onOpen={() => { if (idx.options.length === 0) idx.load(); }}
            onReload={idx.load}
            disabled={!connectionId}
            placeholder="— để trống, chọn lúc chạy —"
          />
          <span className="es-hint">
            Index đặt theo thời gian thì cứ để trống — lúc bấm tìm nhanh chọn sau. Chọn được nhiều index một lượt.
          </span>
        </label>
        <label className="es-field" style={{ flex: '0 0 90px' }}>
          <span>Size ≤200</span>
          <input className="input" type="number" min={1} max={200} value={limit}
            onChange={(e) => setLimit(Math.min(Math.max(Number(e.target.value) || 50, 1), 200))} />
        </label>
      </div>

      <div className="es-field">
        <span>Fields cho phép query (tên hiển thị · field path · kiểu match mặc định)</span>
        {fields.map((f, i) => (
          <div key={i} className="es-form-row" style={{ alignItems: 'center' }}>
            <input className="input" style={{ flex: 1 }} value={f.label} placeholder="Tenant"
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input className="input mono" style={{ flex: 1.4 }} value={f.path} placeholder="tenantId"
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
            <select className="input" style={{ flex: '0 0 130px' }} value={f.type}
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value as EsQuickFieldType } : x)))}>
              {ES_QUICK_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button className="chip-btn" title="Bỏ field này" disabled={fields.length <= 1}
              onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <div>
          <button className="ghost sm" onClick={() => setFields((fs) => [...fs, { label: '', path: '', type: 'keyword' }])}>
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
          onClick={() => onSaved(initial ? updateEsQuickFind(initial.id, saveBody()) : addEsQuickFind(saveBody()))}
        >{initial ? 'Lưu' : 'Tạo'}</button>
      </div>
    </div>
  );
}

// ── Document modal ────────────────────────────────────────────────────────────

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
        {/* Monaco read-only: tô màu JSON + Ctrl+F tìm trong CẢ document (kể cả
            phần đang cuộn khuất), thay cho <pre> đơn sắc trước đây. */}
        <JsonViewer value={pretty} path="es-qf-doc:/modal.json" maxHeight={620} />
      </div>
    </div>
  );
}
