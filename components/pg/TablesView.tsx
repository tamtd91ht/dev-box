'use client';

// "📋 Bảng" — khảo sát cấu trúc từng database: danh sách MỌI bảng/view kèm kích
// thước + thống kê hoạt động (dead tuple, seq/idx scan, vacuum/analyze gần
// nhất), bấm một bảng để xem cột, index, ràng buộc, FK ngược, trigger,
// partition và DDL tái dựng.
//
// Chỉ đọc catalog/thống kê (xem lib/pgClient mục 6): KHÔNG pg_total_relation_size,
// không COUNT(*) tự động — "Đếm chính xác" là nút bấm tay, chạy READ ONLY như
// mọi truy vấn khác. Muốn xem DỮ LIỆU thì "↗ Mở ở Dữ liệu" chuyển sang BrowserView.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listPgDatabases,
  pgTableCatalog,
  pgTableDetail,
  queryPg,
  fmtBytes,
  fmtCount,
  type PgDatabaseInfo,
  type PgRelKind,
  type PgTableDetail,
  type PgTableStat,
} from '@/lib/pg';
import { readLocal, writeLocal } from '@/lib/localKeys';
import { useSplit } from '@/lib/useSplit';
import Splitter from '../Splitter';

export interface TablesViewProps {
  connectionId: string;
  defaultDb: string;
  /** Database được chọn sẵn (vd. từ Tổng quan). */
  initialDb?: string;
  onOpenInBrowser: (db: string, schema: string, table: string) => void;
}

type SortKey = 'name' | 'rows' | 'table' | 'index' | 'total' | 'dead' | 'seq' | 'vacuum';
type DetailTab = 'columns' | 'indexes' | 'constraints' | 'refs' | 'triggers' | 'partitions' | 'view' | 'ddl';

const KIND_LABEL: Record<PgRelKind, string> = {
  table: 'table',
  partitioned: 'partitioned',
  view: 'view',
  matview: 'mat. view',
  foreign: 'foreign',
};

const CON_LABEL: Record<string, string> = {
  p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE', t: 'TRIGGER',
};

/** Vẽ tối đa ngần này dòng — db vài nghìn bảng (partition theo ngày…) vẫn mượt. */
const RENDER_CAP = 1000;

const dbKey = (connId: string) => `pg.tablesDb.${connId}`;

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

function deadPct(t: PgTableStat): number | null {
  if (t.deadTup === null || t.liveTup === null) return null;
  const all = t.deadTup + t.liveTup;
  return all > 0 ? (t.deadTup / all) * 100 : 0;
}

/** Bảng lớn mà phần lớn lượt đọc là quét tuần tự — thường là thiếu index. */
function seqHeavy(t: PgTableStat): boolean {
  return t.estRows >= 10_000 && (t.seqScan ?? 0) > 100 && (t.seqScan ?? 0) > (t.idxScan ?? 0);
}

function agoText(iso: string | null): string {
  if (!iso) return 'chưa';
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 3600) return `${Math.round(sec / 60)} phút`;
  if (sec < 86400) return `${Math.round(sec / 3600)} giờ`;
  return `${Math.round(sec / 86400)} ngày`;
}

const relName = (t: { schema: string; name: string }) => (t.schema === 'public' ? t.name : `${t.schema}.${t.name}`);

export default function TablesView({ connectionId, defaultDb, initialDb, onOpenInBrowser }: TablesViewProps) {
  const split = useSplit({ varName: '--pg-tlist', min: 320, max: 1100, gap: 12 });

  const [dbs, setDbs] = useState<PgDatabaseInfo[]>([]);
  const [db, setDb] = useState('');
  const [rawCatalog, setCatalog] = useState<PgTableStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useState('');
  const [schemaF, setSchemaF] = useState('');
  const [kindF, setKindF] = useState<'' | PgRelKind>('');
  const [hideParts, setHideParts] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'total', desc: true });

  const [selected, setSelected] = useState<{ schema: string; name: string } | null>(null);
  const [detail, setDetail] = useState<PgTableDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [dtab, setDtab] = useState<DetailTab>('columns');
  const [exact, setExact] = useState<{ key: string; n: number | null; busy: boolean; err?: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Danh sách db + db mở lần trước (nhớ theo connection). initialDb thắng: đó là
  // thao tác chủ động vừa bấm ở Tổng quan.
  useEffect(() => {
    let off = false;
    listPgDatabases(connectionId)
      .then((list) => {
        if (off) return;
        setDbs(list);
        const remembered = readLocal(dbKey(connectionId)) ?? '';
        const pick = [initialDb, remembered, defaultDb].find((d) => d && list.some((x) => x.name === d));
        setDb(pick || list[0]?.name || '');
      })
      .catch((e) => { if (!off) setError((e as Error).message); });
    return () => { off = true; };
  }, [connectionId, defaultDb, initialDb]);

  const loadCatalog = useCallback(async (target: string) => {
    if (!target) return;
    setLoading(true); setError(null);
    try { setCatalog(await pgTableCatalog(connectionId, target)); }
    catch (e) { setCatalog([]); setError((e as Error).message); }
    finally { setLoading(false); }
  }, [connectionId]);

  useEffect(() => {
    if (!db) return;
    writeLocal(dbKey(connectionId), db);
    setSelected(null); setDetail(null); setSchemaF('');
    void loadCatalog(db);
  }, [db, connectionId, loadCatalog]);

  const loadDetail = useCallback(async (schema: string, name: string) => {
    setDetailBusy(true); setDetailErr(null);
    try { setDetail(await pgTableDetail(connectionId, db, schema, name)); }
    catch (e) { setDetail(null); setDetailErr((e as Error).message); }
    finally { setDetailBusy(false); }
  }, [connectionId, db]);

  const select = useCallback((schema: string, name: string) => {
    setSelected({ schema, name });
    setDetail(null);
    setExact(null);
    void loadDetail(schema, name);
  }, [loadDetail]);

  // Tab con không còn hợp lệ với loại bảng mới (vd. đang ở "Partition" rồi bấm
  // sang một view) → về Cột.
  useEffect(() => {
    if (!detail) return;
    const ok: Record<DetailTab, boolean> = {
      columns: true, ddl: true, indexes: true, constraints: true, refs: true, triggers: true,
      partitions: detail.kind === 'partitioned',
      view: detail.viewDefinition !== null,
    };
    if (!ok[dtab]) setDtab('columns');
  }, [detail, dtab]);

  /** Bấm vào "schema.table(col)" / "schema.table" → nhảy tới bảng đó (cùng db). */
  const jumpTo = useCallback((ref: string) => {
    const m = /^([^.]+)\.([^(]+)/.exec(ref);
    if (m) select(m[1], m[2]);
  }, [select]);

  const countExact = useCallback(async () => {
    if (!selected) return;
    const key = `${db}/${selected.schema}/${selected.name}`;
    setExact({ key, n: null, busy: true });
    try {
      const r = await queryPg(connectionId, db, `SELECT count(*) AS n FROM ${quoteIdent(selected.schema)}.${quoteIdent(selected.name)}`);
      const row = r.rows[0] ? (JSON.parse(r.rows[0].json) as { n: unknown }) : null;
      setExact({ key, n: Number(row?.n ?? 0), busy: false });
    } catch (e) {
      setExact({ key, n: null, busy: false, err: (e as Error).message });
    }
  }, [connectionId, db, selected]);

  const copy = useCallback((label: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
  }, []);

  // Bảng partitioned tự nó không chứa dòng nào (relpages = 0) — dữ liệu nằm ở
  // partition con. Cộng dồn con lên cha, không thì cha hiện "0 dòng · 0 B" và bị
  // xếp cuối khi sort theo dung lượng, trong khi nó thường là bảng to nhất.
  const catalog = useMemo(() => {
    const sum = new Map<string, { rows: number; table: number; index: number }>();
    for (const t of rawCatalog) {
      if (!t.partitionOf) continue;
      const cur = sum.get(t.partitionOf) ?? { rows: 0, table: 0, index: 0 };
      cur.rows += t.estRows; cur.table += t.tableBytes; cur.index += t.indexBytes;
      sum.set(t.partitionOf, cur);
    }
    if (sum.size === 0) return rawCatalog;
    // Partition lồng nhau (con cũng partitioned): cộng từ lá lên dần cho tới gốc.
    const total = (key: string, seen = new Set<string>()): { rows: number; table: number; index: number } => {
      const own = sum.get(key) ?? { rows: 0, table: 0, index: 0 };
      const acc = { ...own };
      for (const t of rawCatalog) {
        const k = `${t.schema}.${t.name}`;
        if (t.partitionOf === key && t.kind === 'partitioned' && !seen.has(k)) {
          seen.add(k);
          const sub = total(k, seen);
          acc.rows += sub.rows; acc.table += sub.table; acc.index += sub.index;
        }
      }
      return acc;
    };
    return rawCatalog.map((t) => {
      if (t.kind !== 'partitioned') return t;
      const agg = total(`${t.schema}.${t.name}`);
      return { ...t, estRows: agg.rows, tableBytes: t.tableBytes + agg.table, indexBytes: t.indexBytes + agg.index };
    });
  }, [rawCatalog]);

  const schemas = useMemo(() => [...new Set(catalog.map((t) => t.schema))].sort(), [catalog]);
  const partCount = useMemo(() => catalog.filter((t) => t.partitionOf).length, [catalog]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = catalog.filter((t) =>
      (!schemaF || t.schema === schemaF)
      && (!kindF || t.kind === kindF)
      && (!hideParts || !t.partitionOf)
      && (!needle || `${t.schema}.${t.name}`.toLowerCase().includes(needle) || (t.comment ?? '').toLowerCase().includes(needle)));
    const val = (t: PgTableStat): number | string => {
      switch (sort.key) {
        case 'name': return `${t.schema}.${t.name}`;
        case 'rows': return t.estRows;
        case 'table': return t.tableBytes;
        case 'index': return t.indexBytes;
        case 'total': return t.tableBytes + t.indexBytes;
        case 'dead': return deadPct(t) ?? -1;
        case 'seq': return t.seqScan ?? -1;
        case 'vacuum': return t.lastVacuum ? new Date(t.lastVacuum).getTime() : 0;
      }
    };
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }, [catalog, filter, schemaF, kindF, hideParts, sort]);

  const totals = useMemo(() => {
    let data = 0, index = 0, est = 0, tables = 0, views = 0;
    for (const t of rows) {
      // Đang hiện cả partition con thì bảng cha (đã cộng dồn con) không tính nữa — tránh đếm hai lần.
      if (!hideParts && t.kind === 'partitioned') { tables++; continue; }
      data += t.tableBytes; index += t.indexBytes;
      if (t.kind === 'view' || t.kind === 'matview') views++;
      else { tables++; est += t.estRows; }
    }
    return { data, index, est, tables, views };
  }, [rows, hideParts]);

  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' }));
  const th = (k: SortKey, label: string, title?: string) => (
    <th key={k} className="pg-sortable" onClick={() => sortBy(k)} title={title}>
      {label}{sort.key === k ? (sort.desc ? ' ▾' : ' ▴') : ''}
    </th>
  );

  const exactKey = selected ? `${db}/${selected.schema}/${selected.name}` : '';
  const selStat = selected ? catalog.find((t) => t.schema === selected.schema && t.name === selected.name) : undefined;

  return (
    <div className="pg-tables-view">
      <div className="pg-tables-bar">
        <label className="pg-field">
          <span>Database</span>
          <select className="input" value={db} onChange={(e) => setDb(e.target.value)}>
            {dbs.map((d) => <option key={d.name} value={d.name}>{d.name} · {fmtBytes(d.sizeBytes)}</option>)}
          </select>
        </label>
        <label className="pg-field grow">
          <span>Lọc theo tên / ghi chú</span>
          <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="vd. order, log_…" />
        </label>
        <label className="pg-field">
          <span>Schema</span>
          <select className="input" value={schemaF} onChange={(e) => setSchemaF(e.target.value)}>
            <option value="">tất cả ({schemas.length})</option>
            {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="pg-field">
          <span>Loại</span>
          <select className="input" value={kindF} onChange={(e) => setKindF(e.target.value as '' | PgRelKind)}>
            <option value="">tất cả</option>
            {(Object.keys(KIND_LABEL) as PgRelKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        {partCount > 0 && (
          <label className="pg-check" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
            <input type="checkbox" checked={hideParts} onChange={(e) => setHideParts(e.target.checked)} />
            Ẩn {partCount} partition con
          </label>
        )}
        <button className="chip-btn" style={{ alignSelf: 'flex-end' }} disabled={loading || !db} onClick={() => void loadCatalog(db)}>
          {loading ? <span className="spinner" aria-hidden /> : '↻'} Tải lại
        </button>
      </div>

      <div className="status-line" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="badge">{totals.tables} bảng{totals.views ? ` · ${totals.views} view` : ''}</span>
        <span className="badge" title="Ước lượng theo pg_class.reltuples — cập nhật sau VACUUM/ANALYZE">~{fmtCount(totals.est)} dòng</span>
        <span className="badge">dữ liệu {fmtBytes(totals.data)}</span>
        <span className="badge">index {fmtBytes(totals.index)}</span>
        <span className="xhint">Kích thước/số dòng là ước lượng từ catalog — không xin khoá bảng nào.</span>
      </div>

      {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

      <div className={`pg-tables${selected ? ' with-detail' : ''}`} ref={split.ref} style={selected ? split.style : undefined}>
        <div className="pg-tables-list">
          {loading && catalog.length === 0 && <p className="empty"><span className="spinner" /> Đang tải danh sách bảng…</p>}
          {!loading && rows.length === 0 && !error && <p className="empty">Không có bảng nào khớp.</p>}
          {rows.length > 0 && (
            <table className="pg-table">
              <thead>
                <tr>
                  {th('name', 'Bảng')}
                  {th('rows', '~Dòng', 'Ước lượng (reltuples)')}
                  {th('table', 'Dữ liệu', 'Heap + TOAST')}
                  {th('index', 'Index')}
                  {th('total', 'Tổng')}
                  {th('dead', 'Dead', 'Tỉ lệ dead tuple — cao là autovacuum đang đuối')}
                  {th('seq', 'Seq / Idx', 'Số lượt quét tuần tự / quét bằng index (từ lần reset thống kê)')}
                  {th('vacuum', 'Vacuum', 'VACUUM (tay hoặc autovacuum) gần nhất')}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, RENDER_CAP).map((t) => {
                  const dp = deadPct(t);
                  const on = selected?.schema === t.schema && selected?.name === t.name;
                  const isView = t.kind === 'view';
                  return (
                    <tr key={`${t.schema}.${t.name}`} className={on ? 'pg-row-on' : ''} style={{ cursor: 'pointer' }}
                      onClick={() => select(t.schema, t.name)}
                      title={t.comment ?? undefined}>
                      <td>
                        <span className="pg-tname">{relName(t)}</span>
                        {t.kind !== 'table' && <span className="pg-kind">{KIND_LABEL[t.kind]}</span>}
                        {t.partitionOf && <span className="pg-kind" title={`partition của ${t.partitionOf}`}>part</span>}
                        {(t.kind === 'table' || t.kind === 'partitioned') && !t.hasPk && !t.partitionOf && (
                          <span className="pg-kind warn" title="Bảng không có PRIMARY KEY — replication logic / update theo dòng sẽ gặp khó">no PK</span>
                        )}
                      </td>
                      <td>{isView ? '—' : fmtCount(t.estRows)}</td>
                      <td>{isView ? '—' : fmtBytes(t.tableBytes)}</td>
                      <td title={`${t.indexCount} index`}>{isView ? '—' : `${fmtBytes(t.indexBytes)}`}</td>
                      <td><b>{isView ? '—' : fmtBytes(t.tableBytes + t.indexBytes)}</b></td>
                      <td className={dp !== null && dp >= 20 && (t.deadTup ?? 0) > 1000 ? 'pg-warn' : ''}>
                        {dp === null ? '—' : `${dp.toFixed(dp < 10 ? 1 : 0)}%`}
                      </td>
                      <td className={seqHeavy(t) ? 'pg-warn' : ''} title={seqHeavy(t) ? 'Bảng lớn mà đa số lượt đọc là quét tuần tự — xem có thiếu index không' : undefined}>
                        {t.seqScan === null ? '—' : `${fmtCount(t.seqScan)} / ${fmtCount(t.idxScan ?? 0)}`}
                      </td>
                      <td title={t.lastVacuum ?? ''}>{isView ? '—' : agoText(t.lastVacuum)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {rows.length > RENDER_CAP && (
            <p className="xhint">Đang hiện {RENDER_CAP}/{rows.length} — gõ ô lọc để thu hẹp.</p>
          )}
        </div>

        {selected && (
          <div className="pg-tables-detail">
            <div className="status-line" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <strong className="pg-ns">{db} › {selected.schema}.{selected.name}</strong>
              <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <button className="chip-btn" title="Mở bảng này ở mục Dữ liệu để chạy SQL"
                  onClick={() => onOpenInBrowser(db, selected.schema, selected.name)}>↗ Mở ở Dữ liệu</button>
                {selStat?.kind !== 'view' && (
                  <button className="chip-btn" disabled={exact?.busy}
                    title="SELECT count(*) — chạy READ ONLY, timeout 15s; bảng to có thể lâu"
                    onClick={() => void countExact()}>
                    {exact?.busy ? <span className="spinner" aria-hidden /> : '#'} Đếm chính xác
                  </button>
                )}
                <button className="chip-btn" onClick={() => copy('name', `${quoteIdent(selected.schema)}.${quoteIdent(selected.name)}`)}>
                  {copied === 'name' ? '✓ Đã copy' : '⧉ Tên'}
                </button>
                <button className="chip-btn" title="Đóng khung chi tiết" onClick={() => { setSelected(null); setDetail(null); }}>✕</button>
              </span>
            </div>

            {exact && exact.key === exactKey && !exact.busy && (
              exact.err
                ? <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{exact.err}</pre>
                : <div className="badge" style={{ color: 'var(--ok)' }}>Đếm chính xác: {exact.n?.toLocaleString('vi-VN')} dòng</div>
            )}

            {detailBusy && !detail && <p className="empty"><span className="spinner" /> Đang đọc cấu trúc…</p>}
            {detailErr && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{detailErr}</pre>}

            {detail && (
              <>
                <div className="pg-kpis">
                  <div className="pg-kpi"><span className="pg-kpi-label">Loại</span><b>{KIND_LABEL[detail.kind]}</b></div>
                  <div className="pg-kpi"><span className="pg-kpi-label">Owner</span><b>{detail.owner}</b></div>
                  {selStat && detail.kind !== 'view' && (
                    <>
                      <div className="pg-kpi"><span className="pg-kpi-label">~Dòng</span><b>{fmtCount(selStat.estRows)}</b></div>
                      <div className="pg-kpi"><span className="pg-kpi-label">Dữ liệu / Index</span><b>{fmtBytes(selStat.tableBytes)} / {fmtBytes(selStat.indexBytes)}</b></div>
                      <div className="pg-kpi"><span className="pg-kpi-label">Ghi (ins+upd+del)</span><b>{selStat.writes === null ? '—' : fmtCount(selStat.writes)}</b></div>
                      <div className="pg-kpi"><span className="pg-kpi-label">Analyze gần nhất</span><b title={selStat.lastAnalyze ?? ''}>{agoText(selStat.lastAnalyze)}</b></div>
                    </>
                  )}
                  {detail.partitionKey && <div className="pg-kpi"><span className="pg-kpi-label">Partition by</span><b>{detail.partitionKey}</b></div>}
                </div>
                {detail.comment && <p className="xhint" style={{ margin: 0 }}>💬 {detail.comment}</p>}

                <div className="pg-subnav subnav-sm">
                  {([
                    ['columns', `Cột (${detail.columns.length})`, true],
                    ['indexes', `Index (${detail.indexes.length})`, detail.kind !== 'view'],
                    ['constraints', `Ràng buộc (${detail.constraints.length})`, detail.kind !== 'view'],
                    ['refs', `Được tham chiếu (${detail.referencedBy.length})`, detail.kind !== 'view'],
                    ['triggers', `Trigger (${detail.triggers.length})`, true],
                    ['partitions', `Partition (${detail.partitions.length})`, detail.kind === 'partitioned'],
                    ['view', 'Định nghĩa view', detail.viewDefinition !== null],
                    ['ddl', 'DDL', true],
                  ] as [DetailTab, string, boolean][]).filter(([, , show]) => show).map(([k, label]) => (
                    <button key={k} className={dtab === k ? 'on' : ''} onClick={() => setDtab(k)}>{label}</button>
                  ))}
                </div>

                <div className="pg-tables-detail-body">
                  {dtab === 'columns' && (
                    <table className="pg-table pg-table-left">
                      <thead><tr><th>#</th><th>Cột</th><th>Kiểu</th><th>Null</th><th>Default</th><th>Ghi chú</th></tr></thead>
                      <tbody>
                        {detail.columns.map((c, i) => (
                          <tr key={c.name}>
                            <td className="pg-rownum">{i + 1}</td>
                            <td>
                              <code className="small">{c.name}</code>
                              {c.pkPos !== null && <span className="pg-kind pk" title={`Khoá chính, vị trí ${c.pkPos}`}>PK</span>}
                              {c.references && (
                                <button className="pg-link pg-fk" title="Nhảy tới bảng được tham chiếu" onClick={() => jumpTo(c.references!)}>
                                  → {c.references}
                                </button>
                              )}
                            </td>
                            <td>{c.type}</td>
                            <td>{c.nullable ? 'YES' : <b>NO</b>}</td>
                            <td><code className="small">
                              {c.identity ? `IDENTITY ${c.identity}` : c.generated ? `GENERATED (${c.generated})` : c.default ?? ''}
                            </code></td>
                            <td className="pg-wrap">{c.comment ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {dtab === 'indexes' && (
                    <table className="pg-table pg-table-left">
                      <thead><tr><th>Tên</th><th>Size</th><th>Scans</th><th>Định nghĩa</th></tr></thead>
                      <tbody>
                        {detail.indexes.map((ix) => {
                          const unused = ix.scans === 0 && !ix.primary && !ix.unique;
                          return (
                            <tr key={ix.name}>
                              <td>
                                {ix.name}
                                {ix.primary && <span className="pg-kind pk">PK</span>}
                                {!ix.primary && ix.unique && <span className="pg-kind">UNIQUE</span>}
                                {!ix.valid && <span className="pg-kind warn" title="Index hỏng / CREATE INDEX CONCURRENTLY dở dang — không được dùng">INVALID</span>}
                              </td>
                              <td>{fmtBytes(ix.sizeBytes)}</td>
                              <td className={unused ? 'pg-warn' : ''} title={unused ? 'Chưa được dùng lần nào từ lần reset thống kê — có thể là index thừa (vẫn tốn ghi + dung lượng)' : undefined}>
                                {ix.scans === null ? '—' : fmtCount(ix.scans)}
                              </td>
                              <td className="pg-wrap"><code className="small">{ix.definition}</code></td>
                            </tr>
                          );
                        })}
                        {detail.indexes.length === 0 && <tr><td colSpan={4} className="empty">Không có index.</td></tr>}
                      </tbody>
                    </table>
                  )}

                  {dtab === 'constraints' && (
                    <table className="pg-table pg-table-left">
                      <thead><tr><th>Tên</th><th>Loại</th><th>Định nghĩa</th></tr></thead>
                      <tbody>
                        {detail.constraints.map((k) => (
                          <tr key={k.name}>
                            <td>{k.name}</td>
                            <td>{CON_LABEL[k.type] ?? k.type}</td>
                            <td className="pg-wrap"><code className="small">{k.definition}</code></td>
                          </tr>
                        ))}
                        {detail.constraints.length === 0 && <tr><td colSpan={3} className="empty">Không có ràng buộc.</td></tr>}
                      </tbody>
                    </table>
                  )}

                  {dtab === 'refs' && (
                    <table className="pg-table pg-table-left">
                      <thead><tr><th>Từ bảng</th><th>Constraint</th><th>Định nghĩa</th></tr></thead>
                      <tbody>
                        {detail.referencedBy.map((r) => (
                          <tr key={`${r.fromTable}.${r.name}`}>
                            <td><button className="pg-link" onClick={() => jumpTo(r.fromTable)}>{r.fromTable}</button></td>
                            <td>{r.name}</td>
                            <td className="pg-wrap"><code className="small">{r.definition}</code></td>
                          </tr>
                        ))}
                        {detail.referencedBy.length === 0 && <tr><td colSpan={3} className="empty">Không bảng nào có FK trỏ tới bảng này.</td></tr>}
                      </tbody>
                    </table>
                  )}

                  {dtab === 'triggers' && (
                    <table className="pg-table pg-table-left">
                      <thead><tr><th>Tên</th><th>Bật</th><th>Định nghĩa</th></tr></thead>
                      <tbody>
                        {detail.triggers.map((t) => (
                          <tr key={t.name}>
                            <td>{t.name}</td>
                            <td>{t.enabled ? 'YES' : <span className="pg-warn">NO</span>}</td>
                            <td className="pg-wrap"><code className="small">{t.definition}</code></td>
                          </tr>
                        ))}
                        {detail.triggers.length === 0 && <tr><td colSpan={3} className="empty">Không có trigger.</td></tr>}
                      </tbody>
                    </table>
                  )}

                  {dtab === 'partitions' && (
                    <table className="pg-table pg-table-left">
                      <thead><tr><th>Partition</th><th>Khoảng</th></tr></thead>
                      <tbody>
                        {detail.partitions.map((p) => (
                          <tr key={p.name}>
                            <td><button className="pg-link" onClick={() => jumpTo(p.name)}>{p.name}</button></td>
                            <td className="pg-wrap"><code className="small">{p.bound}</code></td>
                          </tr>
                        ))}
                        {detail.partitions.length === 0 && <tr><td colSpan={2} className="empty">Chưa có partition con.</td></tr>}
                      </tbody>
                    </table>
                  )}

                  {(dtab === 'view' || dtab === 'ddl') && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
                      <div className="status-line" style={{ justifyContent: 'space-between' }}>
                        <span className="xhint">
                          {dtab === 'ddl' ? 'Tái dựng từ catalog — đủ để đọc/so sánh, không thay cho pg_dump --schema-only.' : 'pg_get_viewdef'}
                        </span>
                        <button className="chip-btn" onClick={() => copy(dtab, dtab === 'ddl' ? detail.ddl : detail.viewDefinition ?? '')}>
                          {copied === dtab ? '✓ Đã copy' : '⧉ Copy'}
                        </button>
                      </div>
                      <pre className="code pg-doc-body" style={{ maxHeight: '60vh' }}>{dtab === 'ddl' ? detail.ddl : detail.viewDefinition}</pre>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {selected && <Splitter {...split.grip} />}
      </div>
    </div>
  );
}
