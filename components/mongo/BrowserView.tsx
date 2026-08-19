'use client';

// Data browser — the Robo3T-style core: a database → collection tree on the
// left, a query bar + results on the right. Self-contained state; the shell
// remounts it per connection (key={activeId}) so nothing leaks across clusters.
//
// Reads are unrestricted (find / count / aggregate / indexes / stats — all
// server-bounded by maxTimeMS + page caps). The ONLY write is "Update…", which
// opens UpdateModal and is triple-gated (env flag + per-connection readOnly +
// typed confirm), with the mandatory-filter rule enforced server-side.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listMongoDatabases,
  listMongoCollections,
  mongoCollectionStats,
  listMongoIndexes,
  findMongo,
  countMongo,
  aggregateMongo,
  sampleMongoFields,
  prettyDoc,
  formatJsonInput,
  minifyJsonInput,
  closeAndFormatOnEnter,
  fmtBytes,
  fmtCount,
  type DatabaseInfo,
  type CollectionInfo,
  type CollStatsResult,
  type IndexInfo,
  type FieldInfo,
  type FindResult,
  type AggregateResult,
} from '@/lib/mongo';
import UpdateModal from './UpdateModal';
import JsonView, { countHits } from './JsonView';
import FieldSuggest from './FieldSuggest';
import ResultFindBar from './ResultFindBar';
import { useSplit } from '@/lib/useSplit';
import Splitter from '../Splitter';

import SessionHistory from '../SessionHistory';
import { recordSession, short, type MongoSession } from '@/lib/sessionHistory';

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

/**
 * Khung JSON dựng sẵn cho ô query. `caretOffset` là vị trí con trỏ TRONG `text`
 * sau khi chèn — luôn trỏ vào chỗ cần gõ tiếp (trong nháy, sau dấu hai chấm),
 * để bấm xong là gõ được ngay chứ không phải rê chuột tìm chỗ.
 *
 * Chỉ để mồi cấu trúc — tên field cụ thể do autocomplete (FieldSuggest) lo,
 * nên ở đây dùng `field` làm chỗ giữ chỗ và bôi đen sẵn để gõ đè.
 */
interface Snippet {
  label: string;
  title: string;
  text: string;
  caretOffset: number;
  /** Số ký tự được BÔI ĐEN từ caretOffset — gõ là thay luôn. */
  selectLen?: number;
}

const FILTER_SNIPPETS: Snippet[] = [
  { label: '{ }', title: 'Khung filter rỗng — gõ tên field để gợi ý hiện lên', text: '{\n  \n}', caretOffset: 4 },
  { label: 'field = value', title: 'So khớp bằng', text: '{\n  "field": ""\n}', caretOffset: 4, selectLen: 7 },
  { label: '$and', title: 'Nhiều điều kiện cùng đúng', text: '{\n  "$and": [\n    {  },\n    {  }\n  ]\n}', caretOffset: 17 },
  { label: '$or', title: 'Một trong các điều kiện', text: '{\n  "$or": [\n    {  },\n    {  }\n  ]\n}', caretOffset: 16 },
  { label: '$in', title: 'Thuộc danh sách giá trị', text: '{\n  "field": { "$in": [] }\n}', caretOffset: 4, selectLen: 7 },
  { label: '$regex', title: 'Khớp chuỗi (i = không phân biệt hoa thường)', text: '{\n  "field": { "$regex": "", "$options": "i" }\n}', caretOffset: 4, selectLen: 7 },
  { label: 'khoảng số', title: 'Lớn hơn / nhỏ hơn', text: '{\n  "field": { "$gte": 0, "$lte": 0 }\n}', caretOffset: 4, selectLen: 7 },
  { label: 'khoảng ngày', title: 'Lọc theo mốc thời gian (EJSON $date)', text: '{\n  "createdAt": { "$gte": { "$date": "2026-01-01T00:00:00Z" } }\n}', caretOffset: 4, selectLen: 11 },
  { label: '_id', title: 'Tìm theo ObjectId', text: '{\n  "_id": { "$oid": "" }\n}', caretOffset: 21 },
  { label: '$exists', title: 'Field có / không tồn tại', text: '{\n  "field": { "$exists": true }\n}', caretOffset: 4, selectLen: 7 },
];

const PIPELINE_SNIPPETS: Snippet[] = [
  { label: '[ ]', title: 'Khung pipeline rỗng', text: '[\n  \n]', caretOffset: 4 },
  { label: '$match', title: 'Lọc trước khi gom', text: '[\n  { "$match": {  } }\n]', caretOffset: 17 },
  { label: '$group', title: 'Gom nhóm + đếm', text: '[\n  { "$group": { "_id": "$field", "n": { "$sum": 1 } } }\n]', caretOffset: 26, selectLen: 8 },
  { label: '$sort + $limit', title: 'Sắp xếp rồi cắt', text: '[\n  { "$sort": { "field": -1 } },\n  { "$limit": 20 }\n]', caretOffset: 16, selectLen: 7 },
  { label: '$project', title: 'Chọn cột trả về', text: '[\n  { "$project": { "_id": 0, "field": 1 } }\n]', caretOffset: 32, selectLen: 7 },
  { label: '$unwind', title: 'Bung mảng thành nhiều dòng', text: '[\n  { "$unwind": "$field" }\n]', caretOffset: 17, selectLen: 6 },
  { label: '$lookup', title: 'Join sang collection khác', text: '[\n  {\n    "$lookup": {\n      "from": "",\n      "localField": "",\n      "foreignField": "_id",\n      "as": "joined"\n    }\n  }\n]', caretOffset: 39 },
  { label: 'đếm theo nhóm', title: 'Mẫu hay dùng: match → group → sort', text: '[\n  { "$match": {  } },\n  { "$group": { "_id": "$field", "n": { "$sum": 1 } } },\n  { "$sort": { "n": -1 } }\n]', caretOffset: 17 },
];

export default function BrowserView({ connectionId, readOnly, allowWrite, initialDb }: BrowserViewProps) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const tree = useSplit({ varName: '--mongo-tree', min: 160, max: 520, gap: 12 });
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

  // ── Query editing aids (format + field autocomplete) ────────────────────────
  const [fields, setFields] = useState<FieldInfo[]>([]);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const filterRef = useRef<HTMLTextAreaElement>(null);
  const pipelineRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  /** Which box the caret sits in — only that one gets suggestions. */
  const [focusBox, setFocusBox] = useState<'filter' | 'pipeline' | null>(null);

  // ── Result view: JSON tree vs raw text, plus the Ctrl+F bar ────────────────
  const [treeView, setTreeView] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);

  // ── Results ────────────────────────────────────────────────────────────────
  const [collTab, setCollTab] = useState<CollTab>('docs');
  const [result, setResult] = useState<FindResult | null>(null);
  const [aggResult, setAggResult] = useState<AggregateResult | null>(null);
  const [countInfo, setCountInfo] = useState<string | null>(null);
  const [stats, setStats] = useState<CollStatsResult | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [busy, setBusy] = useState(false);
  /** Tăng sau MỖI lần chạy query — dùng làm key để thẻ kết quả dựng lại từ đầu. */
  const [runSeq, setRunSeq] = useState(0);
  /** Tăng lên mỗi lần ghi một phiên — buộc SessionHistory đọc lại danh sách. */
  const [sessBump, setSessBump] = useState(0);
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

  // ── Phiên làm việc ──────────────────────────────────────────────────────────
  /**
   * Ghi một phiên sau khi CHẠY query. Chỉ lưu ý định (db/collection + filter/
   * sort/projection), không lưu document trả về — xem lib/sessionHistory.
   */
  const noteSession = useCallback((mode: QueryMode, q: string) => {
    if (!selected) return;
    const state: MongoSession = {
      subView: mode,
      database: selected.db,
      collection: selected.coll,
      filter: mode === 'find' ? filter : q,
      sort: mode === 'find' ? sort : '',
      projection: mode === 'find' ? projection : '',
    };
    const trimmed = q.trim();
    recordSession('mongo', {
      label: `${selected.db}.${selected.coll}${trimmed ? ` · ${short(trimmed)}` : ''}${mode === 'aggregate' ? ' (agg)' : ''}`,
      connectionId,
      state: state as unknown as Record<string, unknown>,
    });
    setSessBump((n) => n + 1);
  }, [connectionId, selected, filter, sort, projection]);

  /**
   * Khôi phục: mở lại db/collection và ĐIỀN LẠI query — KHÔNG tự chạy. Người
   * dùng bấm ▶ Find khi đã nhìn thấy mình sắp chạy gì.
   */
  const restoreSession = useCallback((raw: Record<string, unknown>) => {
    const st = raw as Partial<MongoSession>;
    const db = typeof st.database === 'string' ? st.database : '';
    const coll = typeof st.collection === 'string' ? st.collection : '';
    if (!db || !coll) return;
    setQueryMode(st.subView === 'aggregate' ? 'aggregate' : 'find');
    if (st.subView === 'aggregate') setPipeline(typeof st.filter === 'string' ? st.filter : '');
    else {
      setFilter(typeof st.filter === 'string' ? st.filter : '');
      setSort(typeof st.sort === 'string' ? st.sort : '');
      setProjection(typeof st.projection === 'string' ? st.projection : '');
    }
    setSelected({ db, coll });
    setSkip(0);
    setResult(null); setAggResult(null); setCountInfo(null);
    void expandDb(db);
    flash('Đã điền lại phiên — bấm ▶ để chạy.');
  }, [expandDb, flash]);

  // ── Query runners ───────────────────────────────────────────────────────────
  const runFind = useCallback(async (over?: { skip?: number }) => {
    if (!selected) return;
    const eff = { filter, projection, sort, limit, skip: over?.skip ?? skip };
    setBusy(true); setError(null); setAggResult(null); setCountInfo(null);
    try {
      const r = await findMongo(connectionId, selected.db, selected.coll, eff);
      setResult(r);
      setSkip(r.skip);
      setRunSeq((n) => n + 1);
      noteSession('find', filter);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, filter, projection, sort, limit, skip, noteSession]);

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
    try {
      setAggResult(await aggregateMongo(connectionId, selected.db, selected.coll, pipeline));
      setRunSeq((n) => n + 1);
      noteSession('aggregate', pipeline);
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, pipeline, noteSession]);

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

  /** Sample the collection's field paths for the query-bar autocomplete. */
  const loadFields = useCallback(async () => {
    if (!selected) return;
    try { setFields(await sampleMongoFields(connectionId, selected.db, selected.coll)); }
    catch { setFields([]); } // suggestions are a nicety — never block the query bar
  }, [connectionId, selected]);

  /** Pretty-print (or collapse) whichever query box is in play. */
  const formatQuery = useCallback((collapse = false) => {
    const run = collapse ? minifyJsonInput : formatJsonInput;
    if (queryMode === 'aggregate') {
      const r = run(pipeline);
      setPipeline(r.text);
      setJsonError(r.error && `Pipeline không parse được: ${r.error}`);
      return;
    }
    const f = run(filter);
    setFilter(f.text);
    // Projection and sort are one-liners; only tidy them when they are valid.
    const p = run(projection); if (!p.error) setProjection(p.text);
    const s = run(sort); if (!s.error) setSort(s.text);
    setJsonError(f.error && `Filter không parse được: ${f.error}`);
  }, [queryMode, pipeline, filter, projection, sort]);

  /**
   * Insert an autocomplete pick into the focused box, then restore the caret.
   * `caretOffset` cho phép gợi ý đặt con trỏ vào GIỮA đoạn vừa chèn — chèn
   * `"email": ""` thì con trỏ nằm sẵn trong hai dấu nháy, gõ tiếp là xong.
   */
  const applyPick = useCallback((
    box: 'filter' | 'pipeline',
    r: { from: number; to: number; text: string; caretOffset?: number },
  ) => {
    const ref = box === 'filter' ? filterRef : pipelineRef;
    const current = box === 'filter' ? filter : pipeline;
    const next = current.slice(0, r.from) + r.text + current.slice(r.to);
    (box === 'filter' ? setFilter : setPipeline)(next);
    const at = r.from + (r.caretOffset ?? r.text.length);
    setCaret(at);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  }, [filter, pipeline]);

  /**
   * Chèn một khung JSON dựng sẵn vào ô query.
   *
   * Ô đang RỖNG (hoặc chỉ có khoảng trắng) → thay luôn, vì đó là lúc người dùng
   * cần cái khung nhất. Ô đã có nội dung → chèn tại con trỏ, không đạp lên câu
   * query đang gõ dở.
   */
  const insertSnippet = useCallback((box: 'filter' | 'pipeline', s: Snippet) => {
    const ref = box === 'filter' ? filterRef : pipelineRef;
    const current = box === 'filter' ? filter : pipeline;
    const setter = box === 'filter' ? setFilter : setPipeline;

    const blank = current.trim() === '';
    const from = blank ? 0 : (ref.current?.selectionStart ?? current.length);
    const to = blank ? current.length : (ref.current?.selectionEnd ?? from);
    const next = current.slice(0, from) + s.text + current.slice(to);

    setter(next);
    setJsonError(null);
    const at = from + s.caretOffset;
    setCaret(at);
    requestAnimationFrame(() => {
      ref.current?.focus();
      // Bôi đen chỗ giữ chỗ (vd `"field"`) để gõ là thay ngay.
      ref.current?.setSelectionRange(at, at + (s.selectLen ?? 0));
    });
  }, [filter, pipeline]);

  /**
   * Enter trong ô query: đóng ngoặc còn hở + format (xem closeAndFormatOnEnter).
   * Trả về true nếu đã xử lý — lúc đó chặn Enter mặc định.
   *
   * FieldSuggest cũng bắt Enter, nhưng nó nghe ở capture phase và chỉ khi đang
   * có gợi ý hiện; lúc đó nó preventDefault nên handler này không chạy tới.
   */
  const handleEnter = useCallback((box: 'filter' | 'pipeline'): boolean => {
    const ref = box === 'filter' ? filterRef : pipelineRef;
    const el = ref.current;
    if (!el) return false;
    // Có vùng chọn thì Enter là thay thế vùng chọn, không phải "đóng khối".
    if (el.selectionStart !== el.selectionEnd) return false;

    const r = closeAndFormatOnEnter(box === 'filter' ? filter : pipeline, el.selectionStart);
    if (!r) return false;

    (box === 'filter' ? setFilter : setPipeline)(r.text);
    setJsonError(null);
    setCaret(r.caret);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
    return true;
  }, [filter, pipeline]);

  /** Select a collection → reset the query panel and auto-run the first page. */
  const selectColl = useCallback((db: string, coll: string) => {
    setSelected({ db, coll });
    setCollTab('docs');
    setFilter(''); setProjection(''); setSort(''); setLimit(DEFAULT_LIMIT); setSkip(0);
    setPipeline(''); setQueryMode('find');
    setResult(null); setAggResult(null); setCountInfo(null); setStats(null); setIndexes([]);
    setError(null); setJsonError(null); setFields([]);
    setFindOpen(false); setFindQuery(''); setFindIndex(0);
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
    void loadFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, connectionId]);

  const docs = queryMode === 'aggregate' ? aggResult?.docs ?? null : result?.docs ?? null;

  // ── Ctrl+F over the result pane ────────────────────────────────────────────
  // Only hijacked when there are documents to search; otherwise the browser's
  // own find keeps working as usual.
  useEffect(() => {
    if (!docs || docs.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setTreeView(true); // highlighting only exists in the tree renderer
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docs]);

  // Hit counts per document — also gives each card its offset in the global
  // ordering so "3/17" and the scroll target agree.
  // Highlighting lives in the tree renderer, so Raw mode has no hits to count.
  const needle = findOpen && treeView ? findQuery.trim().toLowerCase() : '';
  const hitOffsets: number[] = [];
  let totalHits = 0;
  if (needle && docs) {
    for (const d of docs) {
      hitOffsets.push(totalHits);
      totalHits += countHits(d.json, needle);
    }
  }
  // A shrinking result set must not strand the cursor past the end.
  const activeHit = totalHits === 0 ? -1 : Math.min(findIndex, totalHits - 1);
  const filteredDbs = dbs.filter((d) => !treeFilter || d.name.includes(treeFilter));
  const filteredColls = collections.filter((c) => !treeFilter || c.name.includes(treeFilter));
  const writeArmed = allowWrite && !readOnly;

  return (
    <div className="mongo-browser" ref={tree.ref} style={tree.style}>
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
        <SessionHistory
          scope="mongo"
          connectionId={connectionId}
          reloadKey={sessBump}
          onRestore={restoreSession}
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
                      <label className="mongo-field">
                        <span className="mongo-field-head">
                          <span>Filter (JSON/EJSON — hỗ trợ {'{"$oid"}, {"$date"}'})</span>
                          <span className="mongo-field-tools">
                            <button className="chip-btn" title="Format JSON (Ctrl+Shift+F)" onClick={(e) => { e.preventDefault(); formatQuery(); }}>⤸ Format</button>
                            <button className="chip-btn" title="Gộp về một dòng" onClick={(e) => { e.preventDefault(); formatQuery(true); }}>⤹ Minify</button>
                          </span>
                        </span>
                        <SnippetBar
                          snippets={FILTER_SNIPPETS}
                          onInsert={(s) => insertSnippet('filter', s)}
                        />
                        <textarea
                          ref={filterRef}
                          className="input mono mongo-json-input"
                          rows={4}
                          value={filter}
                          onChange={(e) => { setFilter(e.target.value); setCaret(e.target.selectionStart); setJsonError(null); }}
                          onFocus={(e) => { setFocusBox('filter'); setCaret(e.target.selectionStart); }}
                          onBlur={() => setFocusBox((b) => (b === 'filter' ? null : b))}
                          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { setSkip(0); void runFind({ skip: 0 }); }
                            else if (e.key === 'F' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); formatQuery(); }
                            // Enter trần: đóng ngoặc hở + format. Shift+Enter luôn
                            // xuống dòng, để còn soạn tay khi cần.
                            // `defaultPrevented` là điều kiện BẮT BUỘC: FieldSuggest
                            // nghe ở capture phase nên khi nó vừa chèn một field bằng
                            // Enter, handler này VẪN chạy tiếp — không chặn lại thì
                            // cùng một phím Enter vừa chèn field vừa format chồng lên.
                            else if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented && handleEnter('filter')) e.preventDefault();
                          }}
                          placeholder='{"tenantId": "t_123", "status": "ACTIVE"}'
                        />
                        {focusBox === 'filter' && (
                          <FieldSuggest
                            fields={fields}
                            value={filter}
                            caret={caret}
                            onPick={(r) => applyPick('filter', r)}
                          />
                        )}
                      </label>
                      {jsonError && <span className="mongo-json-err">{jsonError}</span>}
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
                      <label className="mongo-field">
                        <span className="mongo-field-head">
                          <span>Pipeline (JSON array — $out/$merge bị chặn, tự thêm $limit 500)</span>
                          <span className="mongo-field-tools">
                            <button className="chip-btn" title="Format JSON (Ctrl+Shift+F)" onClick={(e) => { e.preventDefault(); formatQuery(); }}>⤸ Format</button>
                            <button className="chip-btn" title="Gộp về một dòng" onClick={(e) => { e.preventDefault(); formatQuery(true); }}>⤹ Minify</button>
                          </span>
                        </span>
                        <SnippetBar
                          snippets={PIPELINE_SNIPPETS}
                          onInsert={(s) => insertSnippet('pipeline', s)}
                        />
                        <textarea
                          ref={pipelineRef}
                          className="input mono mongo-json-input"
                          rows={8}
                          value={pipeline}
                          onChange={(e) => { setPipeline(e.target.value); setCaret(e.target.selectionStart); setJsonError(null); }}
                          onFocus={(e) => { setFocusBox('pipeline'); setCaret(e.target.selectionStart); }}
                          onBlur={() => setFocusBox((b) => (b === 'pipeline' ? null : b))}
                          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void runAggregate();
                            else if (e.key === 'F' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); formatQuery(); }
                            else if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented && handleEnter('pipeline')) e.preventDefault();
                          }}
                          placeholder='[{"$match": {"tenantId": "t_123"}}, {"$group": {"_id": "$status", "n": {"$sum": 1}}}]'
                        />
                        {focusBox === 'pipeline' && (
                          <FieldSuggest
                            fields={fields}
                            value={pipeline}
                            caret={caret}
                            onPick={(r) => applyPick('pipeline', r)}
                          />
                        )}
                      </label>
                      {jsonError && <span className="mongo-json-err">{jsonError}</span>}
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
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <div className="mongo-subnav">
                          <button className={treeView ? 'on' : ''} onClick={() => setTreeView(true)}>Tree</button>
                          <button className={!treeView ? 'on' : ''} onClick={() => setTreeView(false)}>Raw</button>
                        </div>
                        <button
                          className="chip-btn"
                          title="Tìm trong kết quả (Ctrl+F)"
                          onClick={() => { setTreeView(true); setFindOpen(true); }}
                        >🔍</button>
                        {queryMode === 'find' && result && (
                          <>
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
                          </>
                        )}
                      </div>
                    </div>
                    {findOpen && (
                      <ResultFindBar
                        query={findQuery}
                        onQuery={setFindQuery}
                        total={totalHits}
                        index={activeHit < 0 ? 0 : activeHit}
                        onIndex={setFindIndex}
                        onClose={() => { setFindOpen(false); setFindQuery(''); setFindIndex(0); }}
                      />
                    )}
                    <div className="mongo-results">
                      {docs.length === 0 && <p className="empty">Không có document nào khớp.</p>}
                      {docs.map((d, i) => (
                        <DocCard
                          /* runSeq nằm trong key để mỗi lần chạy query mới là
                             thẻ dựng lại từ đầu (đóng). Chỉ dùng skip là không
                             đủ: aggregate luôn skip=0 nên React reuse thẻ cũ và
                             giữ nguyên trạng thái đang mở của kết quả trước. */
                          key={`${runSeq}-${result?.skip ?? 0}-${i}`}
                          json={d.json}
                          truncated={d.truncated}
                          index={(queryMode === 'find' ? (result?.skip ?? 0) : 0) + i}
                          tree={treeView}
                          highlight={needle}
                          activeHit={activeHit}
                          hitOffset={hitOffsets[i] ?? 0}
                          /* A search must open every card — a hit hidden behind a
                             collapsed header would never be found. */
                          forceOpen={!!needle && (hitOffsets[i + 1] ?? totalHits) > (hitOffsets[i] ?? 0)}
                        />
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
      <Splitter {...tree.grip} />
    </div>
  );
}

/**
 * Dãy chip khung JSON dựng sẵn, đặt ngay trên ô query. Đây là phần "gợi ý cấu
 * trúc": không ai nhớ chính xác cú pháp `$lookup` hay `{"$date": …}`, bấm một
 * cái là có khung đúng rồi điền tên field vào.
 */
function SnippetBar({ snippets, onInsert }: { snippets: Snippet[]; onInsert: (s: Snippet) => void }) {
  return (
    <div className="mongo-snips">
      {snippets.map((s) => (
        <button
          key={s.label}
          type="button"
          className="chip-btn mongo-snip"
          title={`${s.title}\n\n${s.text}`}
          // Mouse-down để textarea không mất focus trước khi ta đặt lại con trỏ.
          onMouseDown={(e) => { e.preventDefault(); onInsert(s); }}
        >{s.label}</button>
      ))}
    </div>
  );
}

interface DocCardProps {
  json: string;
  truncated: boolean;
  index: number;
  /** Structured tree (default) vs the plain pretty-printed text. */
  tree: boolean;
  highlight: string;
  activeHit: number;
  hitOffset: number;
  forceOpen: boolean;
}

/** One document: collapsible, rendered either as a JSON tree or as raw text. */
function DocCard({ json, truncated, index, tree, highlight, activeHit, hitOffset, forceOpen }: DocCardProps) {
  const [open, setOpen] = useState(false);
  const shown = open || forceOpen;
  // Chỉ pretty-print khi THẬT SỰ cần (bấm copy, hoặc đang mở ở chế độ Raw).
  // Trước đây gọi thẳng trong thân component nên mỗi lần re-render là
  // parse + stringify cho CẢ TRANG 200 document, kể cả các thẻ đang đóng.
  const pretty = useMemo(() => (shown && !tree ? prettyDoc(json) : ''), [shown, tree, json]);
  const firstLine = useMemo(() => summarize(json), [json]);
  // Dòng preview vừa CUỘN NGANG vừa BẤM ĐƯỢC để mở thẻ. Trước đây nó chặn hẳn
  // sự kiện click (stopPropagation) nên bấm vào phần chữ — tức gần như toàn bộ
  // bề ngang của dòng — chẳng mở gì cả, chỉ mỗi mũi tên bé xíu bên trái ăn
  // click. Giờ nhớ vị trí lúc nhấn chuột: nhả ra gần chỗ cũ (và không kéo trôi
  // thanh cuộn) thì tính là click → mở thẻ; kéo để đọc ngang thì không.
  const drag = useRef<{ x: number; y: number; scroll: number } | null>(null);

  return (
    <div className="mongo-doc">
      {/* Dòng tóm tắt ở LẠI khi thẻ mở — cuộn ngang để đọc nhanh mà vẫn thấy
          mình đang mở document nào. */}
      <div className="mongo-doc-head" onClick={() => setOpen((v) => !v)}>
        <span className="mongo-tree-caret">{shown ? '▾' : '▸'}</span>
        <span className="mongo-doc-idx">#{index + 1}</span>
        <code
          className="mongo-doc-preview"
          title="Bấm để xem JSON đầy đủ"
          onMouseDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY, scroll: e.currentTarget.scrollLeft };
          }}
          onClick={(e) => {
            const d = drag.current;
            drag.current = null;
            const moved =
              !d ||
              Math.abs(e.clientX - d.x) > 4 ||
              Math.abs(e.clientY - d.y) > 4 ||
              e.currentTarget.scrollLeft !== d.scroll;
            // Kéo ngang để đọc → giữ nguyên trạng thái thẻ; bấm dứt khoát → mở.
            if (moved) e.stopPropagation();
          }}
        >{firstLine}</code>
        {truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
        <button
          className="chip-btn"
          title="Copy JSON"
          onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(prettyDoc(json)); }}
        >⧉</button>
      </div>
      {shown && (
        tree ? (
          <div className="mongo-doc-body">
            <JsonView json={json} highlight={highlight} activeHit={activeHit} hitOffset={hitOffset} />
          </div>
        ) : (
          <pre className="code mongo-doc-body">{pretty}</pre>
        )
      )}
    </div>
  );
}

/**
 * Dòng tóm tắt một document. KHÔNG cắt bằng `…` nữa — hàng preview giờ cuộn
 * ngang (xem .mongo-doc-preview), nên cắt ở 160 ký tự sẽ giấu mất phần đuôi mà
 * người dùng vốn kéo tới để đọc. Chỉ dựng lại về một dòng.
 */
function summarize(json: string): string {
  return json.replace(/\s+/g, ' ').trim();
}
