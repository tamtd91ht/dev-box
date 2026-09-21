'use client';

// Data browser — the Robo3T-style core: a database → collection tree on the
// left, a query bar + results on the right. Self-contained state; the shell
// remounts it per connection (key={activeId}) so nothing leaks across clusters.
//
// NHIỀU TAB QUERY: mỗi tab là một ĐIỂM LÀM VIỆC đầy đủ — db + collection đang
// chọn, tab con (Documents/Indexes/Stats), chế độ Find/Aggregate cùng toàn bộ
// filter · sort · projection · pipeline, và kết quả của riêng nó. Nhờ vậy mở
// song song vài collection để đối chiếu mà không phải xoá câu đang viết dở. Bộ
// tab được nhớ theo từng connection (xem lib/queryTabs); riêng KẾT QUẢ chỉ sống
// trong RAM, không ghi xuống localStorage.
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
  smartEnter,
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
import ExportModal from './ExportModal';
import JsonView, { countHits } from './JsonView';
import FieldSuggest from './FieldSuggest';
import { expandSnippet, FILTER_SNIPPETS, PIPELINE_SNIPPETS, type Snippet } from '@/lib/mongoSnippets';
import ResultFindBar from './ResultFindBar';
import { useSplit } from '@/lib/useSplit';
import Splitter from '../Splitter';

import SessionHistory from '../SessionHistory';
import { recordSession, short, type MongoSession } from '@/lib/sessionHistory';
import QueryTabBar from '../QueryTabBar';
import { useQueryTabs } from '@/lib/queryTabs';

export interface BrowserViewProps {
  connectionId: string;
  readOnly: boolean;
  allowWrite: boolean;
  /** Database pre-selected from the Overview jump (optional). */
  initialDb?: string;
}

type CollTab = 'docs' | 'indexes' | 'stats';
type QueryMode = 'find' | 'aggregate';

/**
 * Trạng thái của MỘT tab query, tự nhớ lại khi mở app — xem lib/queryTabs.
 *
 * KHÁC với "⏱ Phiên gần đây" (SessionHistory) ngay bên dưới, dù cùng chữ
 * "phiên": danh sách kia là NHẬT KÝ các lần ĐÃ CHẠY, phải bấm một dòng mới nạp
 * lại. Cái này là chỗ ngồi hiện tại — gõ dở nửa câu filter rồi liếc sang tab
 * khác, quay lại vẫn còn nguyên, không phải bấm gì cả.
 *
 * Cũng chỉ lưu Ý ĐỊNH, không lưu document trả về — cùng ba lý do đã ghi ở đầu
 * lib/sessionHistory.ts (dữ liệu cũ tưởng là mới, dữ liệu nhạy cảm nằm lại
 * trên đĩa, và hạn ngạch localStorage).
 */
interface MongoDraft {
  openDb: string;
  selected: { db: string; coll: string } | null;
  collTab: CollTab;
  queryMode: QueryMode;
  filter: string;
  projection: string;
  sort: string;
  limit: number;
  skip: number;
  pipeline: string;
}

const COLL_TABS: CollTab[] = ['docs', 'indexes', 'stats'];
const QUERY_MODES: QueryMode[] = ['find', 'aggregate'];

/** Hợp các khoá cấp 1 của vài document đầu → gợi ý cột cho modal xuất Excel. */
function deriveDocFields(docs: { json: string }[]): string[] {
  const keys = new Set<string>();
  for (const d of docs.slice(0, 25)) {
    try {
      for (const k of Object.keys(JSON.parse(d.json) as Record<string, unknown>)) keys.add(k);
    } catch { /* document bị cắt cụt — bỏ qua */ }
  }
  keys.delete('_id'); // _id luôn được thêm riêng ở đầu danh sách
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function isMongoDraft(v: unknown): v is MongoDraft {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  const strs = ['openDb', 'filter', 'projection', 'sort', 'pipeline'];
  if (strs.some((k) => typeof x[k] !== 'string')) return false;
  if (typeof x.limit !== 'number' || typeof x.skip !== 'number') return false;
  if (!COLL_TABS.includes(x.collTab as CollTab)) return false;
  if (!QUERY_MODES.includes(x.queryMode as QueryMode)) return false;
  if (x.selected !== null && x.selected !== undefined) {
    const sel = x.selected as Record<string, unknown>;
    if (typeof sel.db !== 'string' || typeof sel.coll !== 'string') return false;
  }
  return true;
}

const DEFAULT_LIMIT = 50;

function blankMongoTab(): MongoDraft {
  return {
    openDb: '', selected: null, collTab: 'docs', queryMode: 'find',
    filter: '', projection: '', sort: '', limit: DEFAULT_LIMIT, skip: 0, pipeline: '',
  };
}

/** Nhãn mặc định của tab: collection đang mở, hoặc "Tab mới" khi chưa chọn gì. */
function mongoTabTitle(s: MongoDraft): string {
  return s.selected ? s.selected.coll : 'Tab mới';
}

/** Kết quả + metadata của một tab, sống trong RAM (xem ghi chú ở MongoDraft). */
interface MongoTabRuntime {
  result: FindResult | null;
  aggResult: AggregateResult | null;
  countInfo: string | null;
  stats: CollStatsResult | null;
  indexes: IndexInfo[];
  fields: FieldInfo[];
  error: string | null;
  busy: boolean;
  /** Tăng sau MỖI lần chạy query — dùng làm key để thẻ kết quả dựng lại từ đầu. */
  runSeq: number;
}

const EMPTY_RUNTIME: MongoTabRuntime = {
  result: null, aggResult: null, countInfo: null, stats: null,
  indexes: [], fields: [], error: null, busy: false, runSeq: 0,
};

/**
 * Vỏ ngoài: ĐỌC XONG bộ tab đã lưu rồi mới dựng khung làm việc.
 *
 * Tách hai component vì mọi thứ bên trong đọc thẳng từ tab đang mở. Đọc
 * localStorage ngay trong render đầu thì lệch hydrate giữa server và client;
 * nhồi lại bằng effect thì các ô loé lên rỗng một nhịp rồi mới có chữ.
 */
export default function BrowserView(props: BrowserViewProps) {
  const tabs = useQueryTabs<MongoDraft>('mongo', props.connectionId, blankMongoTab, isMongoDraft, mongoTabTitle);
  if (!tabs.ready || !tabs.active) {
    return <p className="empty" style={{ margin: 'auto' }}><span className="spinner" /> Đang mở lại phiên trước…</p>;
  }
  return <BrowserViewInner {...props} tabs={tabs} />;
}

function BrowserViewInner({
  connectionId, readOnly, allowWrite, initialDb, tabs,
}: BrowserViewProps & { tabs: ReturnType<typeof useQueryTabs<MongoDraft>> }) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const tree = useSplit({ varName: '--mongo-tree', min: 160, max: 520, gap: 12 });

  const activeId = tabs.activeId;
  const st = tabs.active!.state;
  const { openDb, selected, collTab, queryMode, filter, projection, sort, limit, skip, pipeline } = st;
  const patch = tabs.update;
  const patchTab = tabs.patchTab;
  const tabsRef = tabs.tabsRef;

  // Setter cho từng ô, ghi vào tab ĐANG XEM. Giữ nguyên hình dạng `setX(v)` của
  // useState để phần render (ô filter, pipeline, các phím tắt…) không phải đổi
  // gì khi chuyển từ "một phiên" sang "nhiều tab".
  const setFilter = useCallback((v: string) => patch({ filter: v }), [patch]);
  const setProjection = useCallback((v: string) => patch({ projection: v }), [patch]);
  const setSort = useCallback((v: string) => patch({ sort: v }), [patch]);
  const setPipeline = useCallback((v: string) => patch({ pipeline: v }), [patch]);
  const setLimit = useCallback((v: number) => patch({ limit: v }), [patch]);
  const setSkip = useCallback((v: number) => patch({ skip: v }), [patch]);
  const setQueryMode = useCallback((v: QueryMode) => patch({ queryMode: v }), [patch]);
  const setCollTab = useCallback((v: CollTab) => patch({ collTab: v }), [patch]);

  // ── Tree state (DÙNG CHUNG mọi tab: cùng một cluster thì cùng một cây) ──────
  const [dbs, setDbs] = useState<DatabaseInfo[]>([]);
  const [dbsLoading, setDbsLoading] = useState(false);
  /** Collection của database đang bung, cache theo tên db — đổi tab qua lại
   *  (cùng db) khỏi phải nạp lại danh sách mỗi lần. */
  const [collsByDb, setCollsByDb] = useState<Record<string, CollectionInfo[]>>({});
  const [collsLoading, setCollsLoading] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  const collections = collsByDb[openDb] ?? [];

  // ── Kết quả: MỘT bộ cho mỗi tab, giữ trong RAM ─────────────────────────────
  const [runtime, setRuntime] = useState<Record<string, MongoTabRuntime>>({});
  const rt = runtime[activeId] ?? EMPTY_RUNTIME;
  const { result, aggResult, countInfo, stats, indexes, fields, error, busy, runSeq } = rt;

  const setRt = useCallback((id: string, p: Partial<MongoTabRuntime>) => {
    setRuntime((cur) => ({ ...cur, [id]: { ...(cur[id] ?? EMPTY_RUNTIME), ...p } }));
  }, []);

  // Tab bị đóng thì bỏ luôn kết quả của nó — không thì một phiên làm việc dài
  // cứ tích dần các trang 200 document của những tab không còn tồn tại.
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

  // ── Query editing aids (format + field autocomplete) ────────────────────────
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

  // ── Kết quả ────────────────────────────────────────────────────────────────
  /** Hộp thoại xuất Excel cho màn query (chỉ chế độ Find — xem nút bên dưới). */
  const [exportOpen, setExportOpen] = useState(false);
  /** Tăng lên mỗi lần ghi một phiên — buộc SessionHistory đọc lại danh sách. */
  const [sessBump, setSessBump] = useState(0);
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
    setDbsLoading(true);
    try { setDbs(await listMongoDatabases(connectionId)); }
    catch (e) { setRt(activeId, { error: (e as Error).message }); }
    finally { setDbsLoading(false); }
  }, [connectionId, activeId, setRt]);

  useEffect(() => { void loadDbs(); }, [loadDbs]);

  /** Bung một database ở cây cho TAB ĐANG XEM (mỗi tab nhớ db riêng của nó). */
  const expandDb = useCallback(async (db: string) => {
    patch({ openDb: db });
    if (collsByDb[db]) return; // đã nạp rồi — khỏi gọi lại
    setCollsLoading(true);
    try {
      const list = await listMongoCollections(connectionId, db);
      setCollsByDb((cur) => ({ ...cur, [db]: list }));
    }
    catch (e) { setRt(activeId, { error: (e as Error).message }); }
    finally { setCollsLoading(false); }
  }, [connectionId, patch, collsByDb, activeId, setRt]);

  // Bung lại db của tab vừa chuyển sang / vừa khôi phục — nếu không, đổi tab là
  // thấy cây đóng kín và phải tự lần lại đúng db/collection đang làm dở (state
  // `selected` có sẵn nhưng cây thì không tự mở theo).
  //
  // `initialDb` (vừa bấm "mở db" ở Tổng quan) thắng phiên cũ: đó là thao tác
  // CHỦ ĐỘNG vừa xảy ra. Nó chỉ được tiêu thụ MỘT lần, không thì mỗi lần đổi
  // tab lại bị kéo về db ấy.
  const jumpConsumed = useRef(false);
  useEffect(() => {
    if (initialDb && !jumpConsumed.current) {
      jumpConsumed.current = true;
      if (initialDb !== openDb || !collsByDb[initialDb]) void expandDb(initialDb);
      return;
    }
    if (openDb && !collsByDb[openDb]) void expandDb(openDb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDb, activeId, openDb]);

  // Nhãn tab đi theo collection đang chọn, cho tới khi người dùng tự đặt tên.
  const autoTitle = tabs.autoTitle;
  useEffect(() => { autoTitle(mongoTabTitle(st)); }, [autoTitle, st]);

  // ── Phiên làm việc ──────────────────────────────────────────────────────────
  /**
   * Ghi một phiên sau khi CHẠY query. Chỉ lưu ý định (db/collection + filter/
   * sort/projection), không lưu document trả về — xem lib/sessionHistory.
   */
  const noteSession = useCallback((mode: QueryMode, q: string, tabId: string) => {
    const t = tabsRef.current.find((x) => x.id === tabId)?.state;
    if (!t?.selected) return;
    const state: MongoSession = {
      subView: mode,
      database: t.selected.db,
      collection: t.selected.coll,
      filter: mode === 'find' ? t.filter : q,
      sort: mode === 'find' ? t.sort : '',
      projection: mode === 'find' ? t.projection : '',
    };
    const trimmed = q.trim();
    recordSession('mongo', {
      label: `${t.selected.db}.${t.selected.coll}${trimmed ? ` · ${short(trimmed)}` : ''}${mode === 'aggregate' ? ' (agg)' : ''}`,
      connectionId,
      state: state as unknown as Record<string, unknown>,
    });
    setSessBump((n) => n + 1);
  }, [connectionId, tabsRef]);

  /**
   * Khôi phục: mở một TAB MỚI với db/collection và query của phiên đó, ĐIỀN SẴN
   * chứ KHÔNG tự chạy — người dùng bấm ▶ Find khi đã nhìn thấy mình sắp chạy gì.
   *
   * Mở tab mới chứ không đạp lên tab đang xem: tra lại một phiên cũ là việc
   * phụ, không có lý do gì để nó xoá mất câu query đang viết dở.
   */
  const restoreSession = useCallback((raw: Record<string, unknown>) => {
    const sess = raw as Partial<MongoSession>;
    const db = typeof sess.database === 'string' ? sess.database : '';
    const coll = typeof sess.collection === 'string' ? sess.collection : '';
    if (!db || !coll) return;
    const agg = sess.subView === 'aggregate';
    tabs.open({
      openDb: db,
      selected: { db, coll },
      collTab: 'docs',
      queryMode: agg ? 'aggregate' : 'find',
      pipeline: agg && typeof sess.filter === 'string' ? sess.filter : '',
      filter: !agg && typeof sess.filter === 'string' ? sess.filter : '',
      sort: !agg && typeof sess.sort === 'string' ? sess.sort : '',
      projection: !agg && typeof sess.projection === 'string' ? sess.projection : '',
      skip: 0,
    });
    void expandDb(db);
    flash('Đã mở phiên vào tab mới — bấm ▶ để chạy.');
  }, [expandDb, flash, tabs]);

  // ── Query runners ───────────────────────────────────────────────────────────
  //
  // Mọi runner nhận `tabId` để kết quả rơi đúng tab đã bấm chạy: query nặng ở
  // tab A trong lúc người dùng bấm sang tab B thì kết quả của A phải ở lại A,
  // không được đè lên màn hình B.
  const runFind = useCallback(async (over?: { skip?: number }, tabId = activeId) => {
    const target = tabsRef.current.find((t) => t.id === tabId)?.state;
    if (!target?.selected) return;
    const eff = {
      filter: target.filter, projection: target.projection, sort: target.sort,
      limit: target.limit, skip: over?.skip ?? target.skip,
    };
    setRt(tabId, { busy: true, error: null, aggResult: null, countInfo: null });
    try {
      const r = await findMongo(connectionId, target.selected.db, target.selected.coll, eff);
      setRuntime((cur) => {
        const prev = cur[tabId] ?? EMPTY_RUNTIME;
        return { ...cur, [tabId]: { ...prev, result: r, busy: false, runSeq: prev.runSeq + 1 } };
      });
      patchTab(tabId, { skip: r.skip });
      noteSession('find', target.filter, tabId);
    } catch (e) { setRt(tabId, { error: (e as Error).message, busy: false }); }
  }, [connectionId, activeId, patchTab, setRt, noteSession]);

  const runCount = useCallback(async (tabId = activeId) => {
    const target = tabsRef.current.find((t) => t.id === tabId)?.state;
    if (!target?.selected) return;
    setRt(tabId, { busy: true, error: null });
    try {
      const r = await countMongo(connectionId, target.selected.db, target.selected.coll, target.filter);
      setRt(tabId, {
        countInfo: `${fmtCount(r.count)} document${r.count === 1 ? '' : 's'}${r.estimated ? ' (ước lượng metadata)' : ''} · ${r.tookMs}ms`,
        busy: false,
      });
    } catch (e) { setRt(tabId, { error: (e as Error).message, busy: false }); }
  }, [connectionId, activeId, setRt]);

  const runAggregate = useCallback(async (tabId = activeId) => {
    const target = tabsRef.current.find((t) => t.id === tabId)?.state;
    if (!target?.selected) return;
    setRt(tabId, { busy: true, error: null, result: null, countInfo: null });
    try {
      const r = await aggregateMongo(connectionId, target.selected.db, target.selected.coll, target.pipeline);
      setRuntime((cur) => {
        const prev = cur[tabId] ?? EMPTY_RUNTIME;
        return { ...cur, [tabId]: { ...prev, aggResult: r, busy: false, runSeq: prev.runSeq + 1 } };
      });
      noteSession('aggregate', target.pipeline, tabId);
    }
    catch (e) { setRt(tabId, { error: (e as Error).message, busy: false }); }
  }, [connectionId, activeId, setRt, noteSession]);

  const loadStats = useCallback(async (tabId = activeId) => {
    const sel = tabsRef.current.find((t) => t.id === tabId)?.state.selected;
    if (!sel) return;
    try { setRt(tabId, { stats: await mongoCollectionStats(connectionId, sel.db, sel.coll) }); }
    catch { setRt(tabId, { stats: null }); }
  }, [connectionId, activeId, setRt]);

  const loadIndexes = useCallback(async (tabId = activeId) => {
    const sel = tabsRef.current.find((t) => t.id === tabId)?.state.selected;
    if (!sel) return;
    try { setRt(tabId, { indexes: await listMongoIndexes(connectionId, sel.db, sel.coll) }); }
    catch (e) { setRt(tabId, { error: (e as Error).message }); }
  }, [connectionId, activeId, setRt]);

  /** Sample the collection's field paths for the query-bar autocomplete. */
  const loadFields = useCallback(async (tabId = activeId) => {
    const sel = tabsRef.current.find((t) => t.id === tabId)?.state.selected;
    if (!sel) return;
    // suggestions are a nicety — never block the query bar
    try { setRt(tabId, { fields: await sampleMongoFields(connectionId, sel.db, sel.coll) }); }
    catch { setRt(tabId, { fields: [] }); }
  }, [connectionId, activeId, setRt]);

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
    r: { from: number; to: number; text: string; caretOffset?: number; selectLen?: number },
  ) => {
    const ref = box === 'filter' ? filterRef : pipelineRef;
    const current = box === 'filter' ? filter : pipeline;
    const next = current.slice(0, r.from) + r.text + current.slice(r.to);
    (box === 'filter' ? setFilter : setPipeline)(next);
    const at = r.from + (r.caretOffset ?? r.text.length);
    setCaret(at);
    requestAnimationFrame(() => {
      ref.current?.focus();
      // Khuôn value là literal (`0`, `true`) thì bôi đen sẵn để gõ là thay —
      // không thì gõ `30` vào trước số 0 ra `300`.
      ref.current?.setSelectionRange(at, at + (r.selectLen ?? 0));
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
    const snip = expandSnippet(s.src);

    const blank = current.trim() === '';
    const from = blank ? 0 : (ref.current?.selectionStart ?? current.length);
    const to = blank ? current.length : (ref.current?.selectionEnd ?? from);
    const next = current.slice(0, from) + snip.text + current.slice(to);

    setter(next);
    setJsonError(null);
    const at = from + snip.caret;
    setCaret(at);
    requestAnimationFrame(() => {
      ref.current?.focus();
      // Bôi đen chỗ giữ chỗ (vd `field` trong `"field"`) để gõ là thay ngay.
      ref.current?.setSelectionRange(at, at + snip.selectLen);
    });
  }, [filter, pipeline]);

  /**
   * Enter trong ô query: đóng ngoặc còn hở, format, xuống dòng đúng cấp thụt
   * lề (xem smartEnter). Trả về true nếu đã xử lý — lúc đó chặn Enter mặc định.
   * Shift+Enter vẫn là xuống dòng trần, để còn tự bày bố cục khi cần.
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

    const r = smartEnter(box === 'filter' ? filter : pipeline, el.selectionStart);
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
    patch({
      selected: { db, coll }, collTab: 'docs', queryMode: 'find',
      filter: '', projection: '', sort: '', limit: DEFAULT_LIMIT, skip: 0, pipeline: '',
    });
    setRt(activeId, { ...EMPTY_RUNTIME, runSeq: rt.runSeq });
    setJsonError(null);
    setFindOpen(false); setFindQuery(''); setFindIndex(0);
  }, [patch, activeId, setRt, rt.runSeq]);

  /**
   * Mở collection sang MỘT TAB MỚI — đường ngắn nhất để "query nhiều bảng":
   * đang dở câu filter ở collection A, bấm chuột giữa ở B là có ngay hai tab
   * cạnh nhau, câu của A còn nguyên.
   */
  const openInNewTab = useCallback((db: string, coll: string) => {
    tabs.open({ openDb: db, selected: { db, coll }, collTab: 'docs', queryMode: 'find' });
  }, [tabs]);

  // Tự chạy trang đầu khi lựa chọn của một tab vừa ổn định — chọn collection
  // mới, hoặc lần ĐẦU bấm sang một tab khôi phục từ phiên trước.
  //
  // Tab khôi phục giữ nguyên `skip` đã lưu: đang xem trang 5 mà quay lại bị kéo
  // về trang 1 thì phần "nhớ phiên" mất một nửa ý nghĩa. Chọn collection mới
  // (bấm ở cây) vẫn về trang đầu như cũ, vì selectColl đã đặt skip = 0 rồi.
  //
  // Chỉ chạy cho tab ĐANG XEM: mở app với 5 tab mà bắn 5 query cùng lúc vào
  // cụm production là việc người dùng không hề yêu cầu. Tab khác chạy khi bấm
  // sang — `autoRan` nhớ riêng từng tab nên mỗi tab chỉ tự chạy một lần.
  const autoRan = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!selected) return;
    const key = `${connectionId}/${selected.db}/${selected.coll}`;
    if (autoRan.current[activeId] === key) return;
    autoRan.current[activeId] = key;
    // Tab đang ở chế độ aggregate thì KHÔNG tự chạy gì cả: pipeline chưa bao
    // giờ được chạy tự động (nó có thể rất nặng — xem nút ▶ Aggregate), và chạy
    // một `find` thay thế thì vừa tốn request vừa hiện kết quả không khớp với
    // pipeline đang nằm trên màn hình.
    if (queryMode !== 'aggregate') void runFind({ skip }, activeId);
    void loadStats(activeId);
    void loadIndexes(activeId);
    void loadFields(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, selected?.db, selected?.coll, connectionId]);

  /** Quên MỌI tab của connection này + dọn màn hình về trạng thái vừa mở. */
  const resetTabs = tabs.reset;
  const resetSession = useCallback(() => {
    if (tabs.tabs.length > 1
      && !window.confirm(`Đóng cả ${tabs.tabs.length} tab query và bắt đầu lại từ trạng thái trống?`)) return;
    autoRan.current = {};
    setRuntime({});
    setJsonError(null);
    setFindOpen(false); setFindQuery(''); setFindIndex(0);
    resetTabs();
  }, [resetTabs, tabs.tabs.length]);

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
                onClick={() => (openDb === d.name ? patch({ openDb: '' }) : void expandDb(d.name))}
                title={fmtBytes(d.sizeOnDisk)}
              >
                <span className="mongo-tree-caret">{openDb === d.name ? '▾' : '▸'}</span>
                <span className="mongo-db-name">{d.name}</span>
              </button>
              {openDb === d.name && (
                <ul className="mongo-coll-list">
                  {collsLoading && collections.length === 0 && <li className="empty" style={{ padding: '4px 8px' }}><span className="spinner" /></li>}
                  {filteredColls.map((c) => (
                    <li key={c.name}>
                      <div className="mongo-coll-row">
                        <button
                          className={`mongo-coll-item${selected?.db === d.name && selected?.coll === c.name ? ' active' : ''}`}
                          onClick={() => selectColl(d.name, c.name)}
                          onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); openInNewTab(d.name, c.name); } }}
                          title={`${d.name}.${c.name}\n\nChuột giữa (hoặc nút ⧉) để mở sang tab mới`}
                        >
                          {c.name}
                          {c.type !== 'collection' && <span className="badge" style={{ marginLeft: 6 }}>{c.type}</span>}
                        </button>
                        <button
                          className="mongo-coll-newtab"
                          title="Mở collection này sang tab query mới"
                          onClick={() => openInNewTab(d.name, c.name)}
                        >⧉</button>
                      </div>
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
        <QueryTabBar
          tabs={tabs.tabs}
          activeId={activeId}
          onSelect={tabs.select}
          onOpen={() => tabs.open({ openDb })}
          onClose={tabs.close}
          onRename={tabs.rename}
        />
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
                        {/* Xuất Excel — CHỈ ở chế độ Find. Aggregate không có vì
                            pipeline đổi hẳn hình dạng kết quả (group/project…),
                            không dùng chung đường phân trang filter+sort được. */}
                        <button
                          className="ghost sm"
                          disabled={busy || !result || result.docs.length === 0}
                          title={result && result.docs.length > 0
                            ? 'Xuất toàn bộ kết quả khớp filter hiện tại ra .xlsx'
                            : 'Chạy Find có kết quả trước đã'}
                          onClick={() => setExportOpen(true)}
                        >⬇ Xuất Excel</button>
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

      {exportOpen && selected && result && (
        <ExportModal
          connectionId={connectionId}
          db={selected.db}
          coll={selected.coll}
          filter={filter}
          // Sort người dùng đang gõ ở ô Sort — file xuất theo đúng thứ tự đó.
          sort={sort}
          sortSummary={sort.trim()}
          querySummary={filter.trim() ? short(filter.trim()) : 'toàn bộ collection'}
          fieldSuggestions={[...new Set(['_id', ...deriveDocFields(result.docs)])]}
          defaultTitle={`${selected.db}.${selected.coll}`}
          onClose={() => setExportOpen(false)}
          onDone={(rows, filename) => {
            setExportOpen(false);
            flash(`Đã xuất ${rows.toLocaleString('en-US')} dòng → ${filename}`);
          }}
        />
      )}

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
          title={`${s.title}\n\n${expandSnippet(s.src).text}`}
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
