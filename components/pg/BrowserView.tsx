'use client';

// Data browser — databases → tables tree on the left, SQL editor + tabular
// results on the right. Self-contained state; the shell remounts it per
// connection (key={activeId}).
//
// NHIỀU TAB QUERY: mỗi tab là một ĐIỂM LÀM VIỆC đầy đủ — database + bảng đang
// chọn, tab con (Rows/Columns/Indexes), câu SQL, và kết quả của riêng nó. Nhờ
// vậy mở song song vài bảng để đối chiếu mà không phải xoá câu đang viết dở.
// Bộ tab được nhớ theo từng connection (xem lib/queryTabs); riêng KẾT QUẢ chỉ
// sống trong RAM, không ghi xuống localStorage.
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
import SqlEditor from './SqlEditor';
import { useSplit } from '@/lib/useSplit';
import Splitter from '../Splitter';
import QueryTabBar from '../QueryTabBar';
import { useQueryTabs } from '@/lib/queryTabs';

export interface BrowserViewProps {
  connectionId: string;
  defaultDb: string;
  readOnly: boolean;
  allowWrite: boolean;
  /** Database pre-selected from the Overview jump (optional). */
  initialDb?: string;
}

type TableTab = 'rows' | 'columns' | 'indexes';

/**
 * Trạng thái của MỘT tab query, được nhớ lại giữa các lần mở app.
 *
 * Chỉ những thứ NGƯỜI DÙNG gõ/chọn. Cố ý KHÔNG có `result`: dữ liệu cũ hiện
 * lại như vừa chạy xong là sai lệch nguy hiểm (bảng có thể đã đổi), và một
 * trang 500 dòng × nhiều tab thì quá to cho localStorage.
 */
interface PgTabState {
  /** Database đang bung ở cây bên trái khi tab này được mở. */
  openDb: string;
  selected: { db: string; schema: string; table: string } | null;
  tab: TableTab;
  /** Câu SQL đang soạn — thứ đáng tiếc nhất khi mất. */
  sql: string;
}

/** Kết quả + metadata của một tab, sống trong RAM (xem ghi chú ở PgTabState). */
interface PgTabRuntime {
  result: PgQueryResult | null;
  columns: PgColumnInfo[];
  indexes: PgIndexInfo[];
  error: string | null;
  busy: boolean;
}

const EMPTY_RUNTIME: PgTabRuntime = { result: null, columns: [], indexes: [], error: null, busy: false };

const TABS: TableTab[] = ['rows', 'columns', 'indexes'];

function blankPgTab(): PgTabState {
  return { openDb: '', selected: null, tab: 'rows', sql: '' };
}

function isPgTabState(v: unknown): v is PgTabState {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  if (typeof x.openDb !== 'string' || typeof x.sql !== 'string') return false;
  if (!TABS.includes(x.tab as TableTab)) return false;
  if (x.selected !== null && x.selected !== undefined) {
    const sel = x.selected as Record<string, unknown>;
    if (typeof sel.db !== 'string' || typeof sel.schema !== 'string' || typeof sel.table !== 'string') return false;
  }
  return true;
}

/** Nhãn mặc định của tab: bảng đang mở, hoặc "Tab mới" khi chưa chọn gì. */
function pgTabTitle(s: PgTabState): string {
  if (!s.selected) return 'Tab mới';
  return s.selected.schema === 'public'
    ? s.selected.table
    : `${s.selected.schema}.${s.selected.table}`;
}

/**
 * Vỏ ngoài: ĐỌC XONG bộ tab đã lưu rồi mới dựng khung làm việc.
 *
 * Phải tách làm hai component vì mọi thứ bên trong đọc thẳng từ tab đang mở.
 * Đọc localStorage ngay trong render đầu thì HTML dựng ở server (không có
 * window) lệch với client và React báo lỗi hydrate; còn nhồi lại bằng effect
 * sau khi mount thì ô SQL loé lên rỗng một nhịp rồi mới có chữ.
 */
export default function BrowserView(props: BrowserViewProps) {
  const tabs = useQueryTabs<PgTabState>('pg', props.connectionId, blankPgTab, isPgTabState, pgTabTitle);
  if (!tabs.ready || !tabs.active) {
    return <p className="empty" style={{ margin: 'auto' }}><span className="spinner" /> Đang mở lại phiên trước…</p>;
  }
  return <BrowserViewInner {...props} tabs={tabs} />;
}

function BrowserViewInner({
  connectionId, defaultDb, readOnly, allowWrite, initialDb, tabs,
}: BrowserViewProps & { tabs: ReturnType<typeof useQueryTabs<PgTabState>> }) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const tree = useSplit({ varName: '--pg-tree', min: 160, max: 520, gap: 12 });

  const activeId = tabs.activeId;
  const st = tabs.active!.state;
  const { openDb, selected, tab, sql } = st;
  const patch = tabs.update;

  // ── Tree (DÙNG CHUNG mọi tab: cùng một server thì cùng một cây) ─────────────
  const [dbs, setDbs] = useState<PgDatabaseInfo[]>([]);
  const [dbsLoading, setDbsLoading] = useState(false);
  /** Bảng của database đang bung. Cache theo tên db để đổi tab qua lại (cùng db)
   *  không phải nạp lại danh sách bảng mỗi lần. */
  const [tablesByDb, setTablesByDb] = useState<Record<string, PgTableInfo[]>>({});
  const [tablesLoading, setTablesLoading] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  const tables = tablesByDb[openDb] ?? [];

  // ── Kết quả: MỘT bộ cho mỗi tab, giữ trong RAM ─────────────────────────────
  const [runtime, setRuntime] = useState<Record<string, PgTabRuntime>>({});
  const rt = runtime[activeId] ?? EMPTY_RUNTIME;
  const { result, columns, indexes, error, busy } = rt;

  const setRt = useCallback((id: string, p: Partial<PgTabRuntime>) => {
    setRuntime((cur) => ({ ...cur, [id]: { ...(cur[id] ?? EMPTY_RUNTIME), ...p } }));
  }, []);

  // Tab bị đóng thì bỏ luôn kết quả của nó — không thì một phiên làm việc dài
  // cứ tích dần các trang 500 dòng của những tab không còn tồn tại.
  const liveIds = tabs.tabs.map((t) => t.id).join(',');
  useEffect(() => {
    const alive = new Set(liveIds.split(','));
    setRuntime((cur) => {
      const keys = Object.keys(cur).filter((k) => !alive.has(k));
      if (keys.length === 0) return cur;
      const next = { ...cur };
      for (const k of keys) delete next[k];
      return next;
    });
  }, [liveIds]);

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
    setDbsLoading(true);
    try { setDbs(await listPgDatabases(connectionId)); }
    catch (e) { setRt(activeId, { error: (e as Error).message }); }
    finally { setDbsLoading(false); }
  }, [connectionId, activeId, setRt]);

  useEffect(() => { void loadDbs(); }, [loadDbs]);

  /** Bung một database ở cây cho TAB ĐANG XEM (mỗi tab nhớ db riêng của nó). */
  const expandDb = useCallback(async (db: string) => {
    patch({ openDb: db });
    if (tablesByDb[db]) return; // đã nạp rồi — khỏi gọi lại
    setTablesLoading(true);
    try {
      const list = await listPgTables(connectionId, db);
      setTablesByDb((cur) => ({ ...cur, [db]: list }));
    }
    catch (e) { setRt(activeId, { error: (e as Error).message }); }
    finally { setTablesLoading(false); }
  }, [connectionId, patch, tablesByDb, activeId, setRt]);

  // Bung lại db của tab vừa chuyển sang / vừa khôi phục, và mở db mặc định cho
  // tab còn trống.
  //
  // `initialDb` (người dùng vừa bấm "mở db" ở Tổng quan) thắng phiên cũ — đó là
  // thao tác CHỦ ĐỘNG vừa xảy ra. Nó chỉ được tiêu thụ MỘT lần, không thì mỗi
  // lần đổi tab lại bị kéo về db ấy.
  const jumpConsumed = useRef(false);
  useEffect(() => {
    if (initialDb && !jumpConsumed.current) {
      jumpConsumed.current = true;
      if (initialDb !== openDb || !tablesByDb[initialDb]) void expandDb(initialDb);
      return;
    }
    const target = openDb || defaultDb;
    if (target && !tablesByDb[target]) void expandDb(target);
    else if (target && !openDb) patch({ openDb: target });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDb, defaultDb, activeId, openDb]);

  const runQuery = useCallback(async (sqlOverride?: string, tabId = activeId) => {
    const target = tabs.tabs.find((t) => t.id === tabId)?.state;
    if (!target?.selected) return;
    const eff = sqlOverride ?? target.sql;
    if (!eff.trim()) return;
    setRt(tabId, { busy: true, error: null });
    try {
      const r = await queryPg(connectionId, target.selected.db, eff);
      setRt(tabId, { result: r, busy: false });
    }
    catch (e) { setRt(tabId, { error: (e as Error).message, busy: false }); }
  }, [connectionId, activeId, tabs.tabs, setRt]);

  const loadColumns = useCallback(async (tabId = activeId) => {
    const sel = tabs.tabs.find((t) => t.id === tabId)?.state.selected;
    if (!sel) return;
    try { setRt(tabId, { columns: await listPgColumns(connectionId, sel.db, sel.schema, sel.table) }); }
    catch (e) { setRt(tabId, { error: (e as Error).message }); }
  }, [connectionId, activeId, tabs.tabs, setRt]);

  const loadIndexes = useCallback(async (tabId = activeId) => {
    const sel = tabs.tabs.find((t) => t.id === tabId)?.state.selected;
    if (!sel) return;
    try { setRt(tabId, { indexes: await listPgIndexes(connectionId, sel.db, sel.schema, sel.table) }); }
    catch (e) { setRt(tabId, { error: (e as Error).message }); }
  }, [connectionId, activeId, tabs.tabs, setRt]);

  /** Select a table → prefill the SQL editor and auto-run the first page. */
  const selectTable = useCallback((db: string, schema: string, table: string) => {
    patch({
      selected: { db, schema, table },
      tab: 'rows',
      sql: `SELECT * FROM "${schema}"."${table}" LIMIT 50`,
    });
    setRt(activeId, { result: null, columns: [], indexes: [], error: null });
  }, [patch, activeId, setRt]);

  /**
   * Mở bảng đang chọn sang MỘT TAB MỚI — đường ngắn nhất để "query nhiều bảng":
   * đang xem bảng A, bấm chuột giữa (hoặc ⇧ mở tab) ở bảng B là có ngay hai tab
   * cạnh nhau, câu SQL của A còn nguyên.
   */
  const openInNewTab = useCallback((db: string, schema: string, table: string) => {
    tabs.open({
      openDb: db,
      selected: { db, schema, table },
      tab: 'rows',
      sql: `SELECT * FROM "${schema}"."${table}" LIMIT 50`,
    });
  }, [tabs]);

  // Auto-run khi lựa chọn của một tab vừa ổn định (chọn bảng mới, hoặc lần đầu
  // chuyển sang một tab khôi phục từ phiên trước).
  //
  // Tab KHÔI PHỤC chạy lại chính CÂU SQL đã lưu, không phải `SELECT *` dựng sẵn
  // — nếu không, mở app lên là câu query vừa viết dở bị thay bằng câu mặc định,
  // đúng thứ ta đang cố giữ.
  //
  // Chỉ chạy cho tab ĐANG XEM: mở app với 5 tab mà bắn 5 query cùng lúc vào
  // production là việc người dùng không hề yêu cầu. Tab khác chạy khi bấm sang.
  const autoRan = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!selected) return;
    const key = `${connectionId}/${selected.db}/${selected.schema}/${selected.table}`;
    if (autoRan.current[activeId] === key) return;
    autoRan.current[activeId] = key;
    void runQuery(sql.trim() ? sql : `SELECT * FROM "${selected.schema}"."${selected.table}" LIMIT 50`, activeId);
    void loadColumns(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, selected?.db, selected?.schema, selected?.table, connectionId]);

  // Nhãn tab đi theo bảng đang chọn, cho tới khi người dùng tự đặt tên.
  const autoTitle = tabs.autoTitle;
  useEffect(() => { autoTitle(pgTabTitle(st)); }, [autoTitle, st]);

  /**
   * Cột đổ vào gợi ý SQL. Dùng lại `columns` — đã được nạp sẵn khi chọn bảng
   * (xem effect auto-run), nên gợi ý không tốn thêm request nào.
   *
   * Chưa chọn bảng thì rỗng: gợi ý vẫn chạy với TỪ KHOÁ và TÊN BẢNG, chỉ thiếu
   * phần cột — đúng bằng những gì tool thực sự biết lúc đó, không đoán bừa.
   */
  const suggestColumns = useMemo(
    () => columns.map((c) => ({ name: c.name, dataType: c.dataType })),
    [columns],
  );

  /** Quên MỌI tab của connection này + dọn màn hình về trạng thái vừa mở. */
  const resetTabs = tabs.reset;
  const resetSession = useCallback(() => {
    if (tabs.tabs.length > 1
      && !window.confirm(`Đóng cả ${tabs.tabs.length} tab query và bắt đầu lại từ trạng thái trống?`)) return;
    autoRan.current = {};
    setRuntime({});
    setSelectedRow(null);
    resetTabs();
  }, [resetTabs, tabs.tabs.length]);

  const filteredDbs = dbs.filter((d) => !treeFilter || d.name.includes(treeFilter));
  const filteredTables = tables.filter((t) => !treeFilter || `${t.schema}.${t.name}`.includes(treeFilter));
  const writeArmed = allowWrite && !readOnly;
  const parsedRows = useMemo(
    () => (result ? result.rows.map((r) => { try { return JSON.parse(r.json) as Record<string, unknown>; } catch { return null; } }) : []),
    [result],
  );

  return (
    <div className="pg-browser" ref={tree.ref} style={tree.style}>
      {/* ── Tree: databases → tables ──────────────────────────────────── */}
      <div className="pg-tree">
        <div className="status-line" style={{ justifyContent: 'space-between' }}>
          <strong>Databases</strong>
          <span style={{ display: 'flex', gap: 4 }}>
            {/* Các tab được nhớ lại tự động, nên phải có đường VỀ TRẠNG THÁI
                SẠCH — không thì mở app lên lúc nào cũng dính nguyên bộ tab cũ
                và phải tự đóng từng cái. */}
            <button className="chip-btn" onClick={resetSession}
              title="Đóng hết tab query đang nhớ và bắt đầu lại từ trạng thái trống">
              ⟲ Phiên mới
            </button>
            <button className="chip-btn" onClick={loadDbs} disabled={dbsLoading}>↻</button>
          </span>
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
                onClick={() => (openDb === d.name ? patch({ openDb: '' }) : void expandDb(d.name))}
                title={fmtBytes(d.sizeBytes)}
              >
                <span className="pg-tree-caret">{openDb === d.name ? '▾' : '▸'}</span>
                <span className="pg-db-name">{d.name}</span>
              </button>
              {openDb === d.name && (
                <ul className="pg-coll-list">
                  {tablesLoading && tables.length === 0 && <li className="empty" style={{ padding: '4px 8px' }}><span className="spinner" /></li>}
                  {filteredTables.map((t) => (
                    <li key={`${t.schema}.${t.name}`}>
                      <div className="pg-coll-row">
                        <button
                          className={`pg-coll-item${selected?.db === d.name && selected?.schema === t.schema && selected?.table === t.name ? ' active' : ''}`}
                          onClick={() => selectTable(d.name, t.schema, t.name)}
                          onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); openInNewTab(d.name, t.schema, t.name); } }}
                          title={`~${fmtCount(t.estRows)} rows · ${fmtBytes(t.sizeBytes)}\n\nChuột giữa (hoặc nút ⧉) để mở sang tab mới`}
                        >
                          {t.schema === 'public' ? t.name : `${t.schema}.${t.name}`}
                        </button>
                        <button
                          className="pg-coll-newtab"
                          title="Mở bảng này sang tab query mới"
                          onClick={() => openInNewTab(d.name, t.schema, t.name)}
                        >⧉</button>
                      </div>
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
        <QueryTabBar
          tabs={tabs.tabs}
          activeId={activeId}
          onSelect={tabs.select}
          onOpen={() => tabs.open({ openDb })}
          onClose={tabs.close}
          onRename={tabs.rename}
        />
        {!selected ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn một table ở cây bên trái để truy vấn.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <strong className="pg-ns">{selected.db} › {selected.schema}.{selected.table}</strong>
              <div className="pg-subnav">
                <button className={tab === 'rows' ? 'on' : ''} onClick={() => patch({ tab: 'rows' })}>Rows</button>
                <button className={tab === 'columns' ? 'on' : ''} onClick={() => { patch({ tab: 'columns' }); if (columns.length === 0) void loadColumns(); }}>
                  Columns{columns.length > 0 ? ` (${columns.length})` : ''}
                </button>
                <button className={tab === 'indexes' ? 'on' : ''} onClick={() => { patch({ tab: 'indexes' }); void loadIndexes(); }}>Indexes</button>
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {tab === 'rows' && (
              <>
                <div className="pg-querybar">
                  {/* <div> chứ KHÔNG phải <label> như các ô khác: label chuyển
                      mọi cú bấm bên trong nó sang control của nó, nên bấm chuột
                      vào một dòng gợi ý sẽ bị lái thành "focus lại textarea" và
                      gợi ý không bao giờ nhận được bằng chuột. */}
                  <div className="pg-field">
                    <span>SQL (chạy trong transaction READ ONLY · timeout 15s · trần 500 dòng — Ctrl+Enter để chạy · Ctrl+Space gợi ý)</span>
                    {/* Gợi ý lấy CỘT của bảng đang chọn + BẢNG của database đang
                        mở — đều là dữ liệu đã nạp sẵn cho cây bên trái và tab
                        Columns, nên không tốn thêm một request nào. */}
                    <SqlEditor
                      /* key theo tab: trình soạn giữ state nội bộ (con trỏ, gợi
                         ý đang mở) — đổi tab mà tái dùng cùng một instance thì
                         con trỏ của tab cũ nhảy vào câu SQL của tab mới. */
                      key={activeId}
                      value={sql}
                      onChange={(v) => patch({ sql: v })}
                      onRun={() => void runQuery()}
                      columns={suggestColumns}
                      tables={tables}
                    />
                  </div>
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
      <Splitter {...tree.grip} />
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
