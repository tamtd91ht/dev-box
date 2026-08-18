'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchRedisConnections,
  mutateRedisConnection,
  testRedisConnection,
  pingRedis,
  scanRedis,
  getRedisValue,
  lookupRedisKey,
  setRedisTtl,
  setRedisValue,
  deleteRedisKey,
  humanizeTtl,
  MAX_TTL_SECONDS,
  type PublicRedisConnection,
  type ScannedKey,
  type ValueResult,
  type RedisKeyType,
  type RedisMode,
  type RedisNode,
  type SetKeyInput,
} from '@/lib/redis';
import ConnTransferButton from './ConnTransferButton';
import MonitorStrip from './redis/MonitorStrip';
import QuickFindPanel from './redis/QuickFindPanel';
import SessionHistory from './SessionHistory';
import { recordSession, short, type RedisSession } from '@/lib/sessionHistory';

/** localStorage key remembering the last-selected connection. */
import { readLocal, writeLocal } from '@/lib/localKeys';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

const LAST_CONN_KEY = 'redis.lastConn';
/** Keys fetched per SCAN round. */
const SCAN_COUNT = 300;
/**
 * Trần THỜI GIAN cho một lượt tìm tự động, không phải trần số vòng.
 *
 * Đếm vòng là sai cách: mỗi vòng chỉ soi ~SCAN_COUNT slot, nên bất kỳ con số
 * cố định nào cũng quy ra một mốc keyspace cứng — DB lớn hơn mốc đó thì key
 * nằm sau nó VĨNH VIỄN không tìm ra, và đó chính là lỗi được báo (guard 100
 * vòng = 30k slot, DB 1 triệu key thì hụt 97%). Chặn theo thời gian thì giới
 * hạn là "người dùng chờ bao lâu" — đúng thứ ta thật sự muốn giới hạn — và DB
 * to cỡ nào cũng quét được xa nhất trong khoảng đó.
 *
 * Vẫn cần một trần vì vòng lặp này chạy trên UI thread; hết thời gian thì
 * cuộn xuống (hoặc bấm "tải thêm") là tiếp tục từ đúng cursor đang dừng.
 */
const AUTO_SCAN_BUDGET_MS = 15_000;
/**
 * Soft cap on auto-loaded keys. Infinite scroll keeps SCANning until the cursor is
 * exhausted OR this many keys are loaded — then it pauses and offers a manual
 * "load more" so a million-key DB can't hang the browser. Raised on demand.
 */
const SOFT_LIMIT = 5000;
/** Pixels-from-bottom threshold that triggers the next auto-scan round. */
const SCROLL_THRESHOLD_PX = 200;
/** Debounce (ms) between typing a pattern and re-scanning. */
const SEARCH_DEBOUNCE_MS = 350;
/** Logical DB indexes selectable at browse time (single-node Redis: 0–15). */
const DB_INDEXES = Array.from({ length: 16 }, (_, i) => i);

/** Escape a literal string so Redis SCAN MATCH treats glob metachars as plain text. */
function escapeGlob(s: string): string {
  return s.replace(/[\\*?[\]]/g, (ch) => '\\' + ch);
}

/**
 * Chuỗi này có chứa wildcard glob THẬT SỰ không (`*` `?` `[`)?
 *
 * Dùng để quyết định một mẫu Tìm nhanh là MỘT key cụ thể (tra thẳng) hay một
 * DẢI key (phải scan). Ký tự đứng sau `\` là literal — `a\*b` là tên key có
 * dấu sao, không phải mẫu khớp nhiều key — nên phải bỏ qua đúng như Redis
 * hiểu, chứ không thể tìm `*` bằng includes().
 */
function hasGlobWildcard(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; } // ký tự kế tiếp là literal
    if (ch === '*' || ch === '?' || ch === '[') return true;
  }
  return false;
}

/** Cách dịch ô tìm kiếm thành SCAN MATCH. */
type MatchMode =
  /** exact OFF — bọc `*` hai đầu: gõ `profile` là tìm `*profile*`. */
  | 'contains'
  /** exact ON — khớp đúng tên key, glob metachar bị escape. */
  | 'exact'
  /**
   * Mẫu glob THÔ, không escape gì. Dùng cho Tìm nhanh: mẫu key của preset có
   * thể chứa `*` cố ý (`callbot_listen:{{domain}}:*`) nên không được escape,
   * mà cũng không được bọc thêm `*` hai đầu như chế độ contains.
   */
  | 'pattern';

/**
 * Build the SCAN MATCH pattern from the search box, RedisInsight-style:
 *   • exact ON  → match the key verbatim (glob metachars escaped).
 *   • exact OFF → wildcard both sides: `*keyword*` (no need to type `*`).
 *   • pattern   → dùng nguyên văn (Tìm nhanh).
 *   • empty box → `*` (browse everything).
 */
function buildMatch(query: string, mode: MatchMode): string {
  const q = query.trim();
  if (!q) return '*';
  if (mode === 'pattern') return q;
  return mode === 'exact' ? escapeGlob(q) : `*${escapeGlob(q)}*`;
}

/** Small glyph per Redis type, shown in the key table. */
function typeIcon(t: RedisKeyType): string {
  switch (t) {
    case 'string':
      return 'ab';
    case 'list':
      return '≡';
    case 'set':
      return '{}';
    case 'zset':
      return 'z↕';
    case 'hash':
      return '#';
    case 'stream':
      return '~';
    default:
      return '·';
  }
}

/**
 * RedisInsight-style key browser — local dev only (server gates on REDIS_TOOL_ENABLED).
 * Configure multiple Redis connections grouped by project — single-node (host·port) or
 * cluster (seed nodes). Pick the logical DB at browse time (single-node; cluster is DB 0),
 * browse keys with SCAN (never KEYS; cluster scans every master node), inspect
 * value/type/TTL, add a key (string/list/set/hash + optional TTL), set a bounded TTL
 * (≤30 days), and delete one key at a time with a typed confirm + lock-key guardrail.
 * The browser never talks to Redis directly — every op goes through /api/redis.
 */
export default function RedisWorkspace() {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--redis-rail', min: 180, max: 560, gap: 18 });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<PublicRedisConnection[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  /** When set, a compact edit modal is open for this connection. */
  const [editConn, setEditConn] = useState<PublicRedisConnection | null>(null);
  /** id of the row whose ⋯ action menu is open (null = none). */
  const [menuId, setMenuId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false); // "add key" modal

  // Ping latency (ms) or 'err' per connection id — shown as a live badge.
  const [pings, setPings] = useState<Record<string, number | 'err'>>({});

  // ── Key browsing ──────────────────────────────────────────────────────────
  const [db, setDb] = useState(0); // logical DB index (0–15), chosen at browse time
  const [query, setQuery] = useState(''); // raw search box text (NOT a glob — see buildMatch)
  const [exact, setExact] = useState(false); // ON = match the key verbatim; OFF = *query* both sides
  /**
   * Bật khi key đến từ Tìm nhanh: mẫu dùng nguyên văn (giữ `*` cố ý trong
   * preset). Tự tắt ngay khi người dùng gõ lại vào ô tìm, để ô tìm luôn hoạt
   * động y như cũ.
   */
  const [rawPattern, setRawPattern] = useState(false);
  // The actual SCAN MATCH pattern fed to Redis — derived so downstream code is unchanged.
  const match = useMemo(
    () => buildMatch(query, rawPattern ? 'pattern' : exact ? 'exact' : 'contains'),
    [query, exact, rawPattern],
  );
  const [keys, setKeys] = useState<ScannedKey[]>([]);
  const [cursor, setCursor] = useState('0');
  const [scanning, setScanning] = useState(false);
  const [scanStarted, setScanStarted] = useState(false);
  /** Current auto-load ceiling — starts at SOFT_LIMIT, bumped by "load more". */
  const [softLimit, setSoftLimit] = useState(SOFT_LIMIT);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [value, setValue] = useState<ValueResult | null>(null);
  const [valueLoading, setValueLoading] = useState(false);

  const [ttlInput, setTtlInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Delete confirmation modal state (typed-confirm).
  const [delKey, setDelKey] = useState<string | null>(null);

  /** Tăng lên mỗi lần ghi một phiên — buộc SessionHistory đọc lại danh sách. */
  const [sessBump, setSessBump] = useState(0);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const dbRef = useRef(db);
  dbRef.current = db;
  // Live mirrors so the auto-scan loop / scroll handler never reads a stale closure.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const scanningRef = useRef(scanning);
  scanningRef.current = scanning;
  const keyCountRef = useRef(0);
  keyCountRef.current = keys.length;
  const softLimitRef = useRef(softLimit);
  softLimitRef.current = softLimit;
  const matchRef = useRef(match);
  matchRef.current = match;
  // "Đúng key" đổi hẳn CÁCH tra (lookup thay vì scan) nên runScan phải đọc được
  // cả cờ này và nguyên văn ô tìm — qua ref, cùng lý do với matchRef: handler
  // cuộn và vòng auto-continue gọi runScan ngoài closure hiện tại.
  const exactRef = useRef(exact);
  exactRef.current = exact;
  const queryRef = useRef(query);
  queryRef.current = query;
  const rawPatternRef = useRef(rawPattern);
  rawPatternRef.current = rawPattern;
  /** The key list scroll container — watched for infinite-scroll. */
  const listRef = useRef<HTMLDivElement | null>(null);
  /**
   * openKey qua ref: runScan cần mở value ngay khi tra chính xác ra đúng 1 key,
   * nhưng openKey khai báo phía dưới. Ref tránh phải xáo thứ tự khai báo hoặc
   * đưa openKey vào deps của runScan (deps rỗng là chủ ý — xem ghi chú ở đó).
   */
  const openKeyRef = useRef<((key: string) => Promise<void>) | null>(null);

  const activeConn = connections.find((c) => c.id === activeId) ?? null;
  const isClusterActive = activeConn?.mode === 'cluster';

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 3500);
  }, []);

  /**
   * Khôi phục một phiên cũ: ĐIỀN LẠI ô tìm + DB + chế độ khớp, KHÔNG tự quét.
   * Người dùng thấy rõ sắp tra gì rồi mới bấm ↻ Làm mới — xem lib/sessionHistory.
   *
   * Đọc phòng thủ từng field: object đến từ localStorage, có thể do bản app cũ ghi.
   */
  const restoreSession = useCallback((raw: Record<string, unknown>) => {
    const s = raw as Partial<RedisSession>;
    const n = Number(s.db);
    setDb(Number.isInteger(n) && n >= 0 && n <= 15 ? n : 0);
    setQuery(typeof s.query === 'string' ? s.query : '');
    setExact(s.exact === true);
    setRawPattern(s.rawPattern === true);
    setSelectedKey(null);
    setKeys([]);
    setScanStarted(false);
    setCursor('0');
    flash('Đã điền lại phiên — bấm ↻ Làm mới để quét.');
  }, [flash]);

  // ── Load / refresh the connection list ──────────────────────────────────────
  const loadConnections = useCallback(async (preferId?: string) => {
    const res = await fetchRedisConnections();
    setEnabled(res.enabled);
    setConnections(res.connections);
    if (!res.enabled) return res;
    let remembered = '';
    try {
      remembered = readLocal(LAST_CONN_KEY) ?? '';
    } catch {
      /* ignore */
    }
    setActiveId((cur) => {
      const candidates = [preferId, cur, remembered].filter(Boolean) as string[];
      const pick = candidates.find((id) => res.connections.some((c) => c.id === id));
      return pick ?? res.connections[0]?.id ?? '';
    });
    return res;
  }, []);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  /** Apply a mutated connection list, keeping (or preferring) a sensible active id. */
  const applyChanged = useCallback((next: PublicRedisConnection[], preferId?: string) => {
    setConnections(next);
    setActiveId((cur) =>
      preferId && next.some((c) => c.id === preferId)
        ? preferId
        : next.some((c) => c.id === cur)
          ? cur
          : next[0]?.id ?? '',
    );
  }, []);

  // ── Inline row actions (⋯ menu) ──────────────────────────────────────────────
  /** Open a compact edit modal for a specific connection (no list, no manage panel). */
  const openEdit = useCallback((c: PublicRedisConnection) => {
    setMenuId(null);
    setEditConn(c);
  }, []);

  /** Delete a connection straight from the list (confirm → DELETE → refresh). */
  const deleteConnection = useCallback(
    async (c: PublicRedisConnection) => {
      setMenuId(null);
      if (!window.confirm(`Xoá kết nối "${c.name}" khỏi danh sách? (không tác động tới Redis)`)) return;
      try {
        const next = await mutateRedisConnection('DELETE', { id: c.id });
        setConnections(next);
        setActiveId((cur) => (next.some((x) => x.id === cur) ? cur : next[0]?.id ?? ''));
        flash(`Đã xoá kết nối "${c.name}"`);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [flash],
  );

  // Close the ⋯ menu on any outside click / Escape.
  useEffect(() => {
    if (!menuId) return;
    const close = () => setMenuId(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuId(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuId]);

  // Reset the browsing panel whenever the active connection changes.
  useEffect(() => {
    if (!activeId) return;
    try {
      writeLocal(LAST_CONN_KEY, activeId);
    } catch {
      /* ignore */
    }
    setDb(0);
    // The DB reset below (db → 0) also clears the browsing panel, so nothing else here.
  }, [activeId]);

  // ── Ping a connection (on the currently-selected DB) ─────────────────────────
  const doPing = useCallback(
    async (id: string) => {
      try {
        const r = await pingRedis(id, dbRef.current);
        setPings((p) => ({ ...p, [id]: r.latencyMs }));
      } catch {
        setPings((p) => ({ ...p, [id]: 'err' }));
      }
    },
    [],
  );

  /** Clear the browsing panel back to an empty, un-scanned state (no I/O). */
  const resetBrowse = useCallback(() => {
    setKeys([]);
    setCursor('0');
    setScanStarted(false);
    setSoftLimit(SOFT_LIMIT);
    setSelectedKey(null);
    setValue(null);
    setError(null);
  }, []);

  // ── SCAN one round (cursor-based, never KEYS). ───────────────────────────────
  // `fresh` restarts from cursor 0 for a new pattern/DB; otherwise it continues
  // from the live cursor ref. Reads all volatile inputs from refs so the scroll
  // handler and the auto-continue loop can call it without stale closures. Returns
  // { cursor, total } where cursor='0' means exhausted and total is the running
  // key count after this round (null when the round was aborted/failed).
  const runScan = useCallback(
    async (fresh: boolean): Promise<{ cursor: string; total: number } | null> => {
      const connId = activeIdRef.current;
      const dbAtStart = dbRef.current;
      if (!connId || scanningRef.current) return null;
      scanningRef.current = true;
      setScanning(true);
      setError(null);
      const from = fresh ? '0' : cursorRef.current;
      try {
        // "Đúng key" → TRA THẲNG bằng TYPE/TTL, không quét. SCAN phải đi hết
        // keyspace mới kết luận được "không có", nên trên DB lớn một key nằm
        // cuối keyspace sẽ không bao giờ tìm ra dù nó tồn tại. Áp cho cả single
        // lẫn cluster (ioredis Cluster tự route theo hash slot của key).
        //
        // Ô tìm RỖNG thì vẫn scan: "đúng key" của chuỗi rỗng là vô nghĩa, còn
        // hành vi mong đợi lúc đó là duyệt tất cả như bình thường.
        const exactKey = exactRef.current ? queryRef.current.trim() : '';
        const r = exactKey
          ? await lookupRedisKey(connId, dbAtStart, exactKey)
          : await scanRedis(connId, dbAtStart, matchRef.current.trim() || '*', from, SCAN_COUNT);
        // Discard the result if the operator switched connection/DB mid-scan.
        if (activeIdRef.current !== connId || dbRef.current !== dbAtStart) return null;
        let total = 0;
        setKeys((prev) => {
          const nextKeys = fresh ? r.keys : [...prev, ...r.keys];
          total = nextKeys.length;
          return nextKeys;
        });
        keyCountRef.current = total; // keep the mirror in sync within the loop
        setCursor(r.cursor);
        cursorRef.current = r.cursor;
        setScanStarted(true);
        // Ghi PHIÊN — chỉ ở lượt `fresh` (một ý định tra mới). Các lượt nối
        // tiếp của infinite-scroll là cùng một phiên, ghi lại sẽ đẻ ra hàng
        // loạt dòng trùng nhau.
        if (fresh) {
          const state: RedisSession = {
            db: dbAtStart,
            query: queryRef.current,
            exact: exactRef.current,
            rawPattern: rawPatternRef.current,
            selectedKey: null,
          };
          const q = queryRef.current.trim();
          recordSession('redis', {
            label: `DB${dbAtStart} · ${q ? short(q) : 'tất cả key'}${exactRef.current && q ? ' (đúng key)' : ''}`,
            connectionId: connId,
            state: state as unknown as Record<string, unknown>,
          });
          setSessBump((n) => n + 1);
        }
        // Tra CHÍNH XÁC chỉ có thể ra 0 hoặc 1 key — không có gì để chọn giữa,
        // nên mở luôn value thay vì bắt bấm thêm một cái nữa vào đúng dòng duy
        // nhất vừa hiện ra.
        if (exactKey && r.keys.length === 1) void openKeyRef.current?.(r.keys[0].key);
        return { cursor: r.cursor, total };
      } catch (e) {
        setError((e as Error).message);
        return null;
      } finally {
        scanningRef.current = false;
        setScanning(false);
      }
    },
    [],
  );

  /**
   * Auto-continue: after a round completes, if the list still doesn't overflow its
   * container (nothing to scroll) and there's more under the soft cap, keep scanning
   * so the first screen fills even when a round returns few keys (sparse matches).
   * Infinite-scroll takes over once the list overflows. The running total comes from
   * runScan's return value — not a React-state mirror — so the soft cap is exact.
   *
   * Giới hạn là THỜI GIAN, không phải số vòng — xem AUTO_SCAN_BUDGET_MS. Trần
   * đếm vòng cũ (100) quy ra ~30k slot, nên trên DB triệu key mà từ khoá chỉ
   * khớp ở cuối thì UI dừng giữa đường và hiện "không có kết quả" trong khi key
   * vẫn tồn tại — đúng lỗi được báo.
   */
  const maybeFillViewport = useCallback(
    async (startTotal: number) => {
      let total = startTotal;
      const deadline = Date.now() + AUTO_SCAN_BUDGET_MS;
      // Đang TÌM (có từ khoá) thì không dừng ở chỗ lấp đầy màn hình: người dùng
      // cần biết CÓ BAO NHIÊU key khớp, mà kết quả khớp rải khắp keyspace. Chỉ
      // chế độ duyệt-tất-cả mới dừng sớm, vì lúc đó cuộn xuống là tải thêm và
      // quét tiếp cả DB ngay từ đầu là vô ích.
      const searching = queryRef.current.trim() !== '';
      while (total < softLimitRef.current && Date.now() < deadline) {
        // Let React paint the appended rows before measuring overflow.
        await new Promise((res) => setTimeout(res, 0));
        const el = listRef.current;
        if (!searching && el && el.scrollHeight > el.clientHeight + 4) break; // now scrollable
        const r = await runScan(false);
        if (r === null || r.cursor === '0') break;
        total = r.total;
      }
    },
    [runScan],
  );

  /** Start a brand-new scan for the current connection/DB/pattern. */
  const startFresh = useCallback(async () => {
    resetBrowse();
    const r = await runScan(true);
    if (r && r.cursor !== '0') void maybeFillViewport(r.total);
  }, [resetBrowse, runScan, maybeFillViewport]);

  // Single auto-scan trigger: connection, DB, or pattern change → debounced fresh
  // scan. One effect (not three) means opening the tab / switching DB / typing a
  // pattern can never fire two overlapping fresh scans. The short debounce also
  // collapses the connection-switch + db→0 reset into one scan.
  useEffect(() => {
    if (!activeId) {
      resetBrowse();
      return;
    }
    const t = setTimeout(() => {
      void startFresh();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // `exact` nằm trong deps vì nó đổi hẳn CÁCH tra (lookup vs scan), mà không
    // luôn đổi `match`: ô tìm rỗng thì match='*' ở cả hai chế độ, thiếu nó thì
    // bật/tắt "Đúng key" lúc đó sẽ không chạy lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, db, match, exact]);

  // Infinite scroll: near the bottom → auto-load the next round (under the soft cap).
  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || scanningRef.current) return;
    if (cursorRef.current === '0') return; // exhausted
    if (keyCountRef.current >= softLimitRef.current) return; // paused at soft cap
    if (el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD_PX) {
      void runScan(false).then((r) => {
        if (r && r.cursor !== '0') void maybeFillViewport(r.total);
      });
    }
  }, [runScan, maybeFillViewport]);

  /** "Load more" past the soft cap — raise the ceiling and continue. */
  const loadMorePastCap = useCallback(() => {
    setSoftLimit((s) => s + SOFT_LIMIT);
    softLimitRef.current += SOFT_LIMIT;
    void runScan(false).then((r) => {
      if (r && r.cursor !== '0') void maybeFillViewport(r.total);
    });
  }, [runScan, maybeFillViewport]);

  // ── Open a key: load its value + type + ttl ─────────────────────────────────
  const openKey = useCallback(async (key: string) => {
    setSelectedKey(key);
    setValue(null);
    setValueLoading(true);
    setError(null);
    setTtlInput('');
    try {
      const v = await getRedisValue(activeIdRef.current, dbRef.current, key);
      setValue(v);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setValueLoading(false);
    }
  }, []);
  openKeyRef.current = openKey;

  // ── Set TTL (bounded ≤ 30 days; enforced again server-side) ─────────────────
  async function applyTtl() {
    if (!selectedKey || busy) return;
    const secs = Number(ttlInput);
    if (!Number.isInteger(secs) || secs < 1) {
      setError('TTL phải là số nguyên giây ≥ 1');
      return;
    }
    if (secs > MAX_TTL_SECONDS) {
      setError(`TTL tối đa 30 ngày (${MAX_TTL_SECONDS}s) — không cho phép key vĩnh viễn`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await setRedisTtl(activeIdRef.current, dbRef.current, selectedKey, secs);
      if (!r.applied) {
        flash('Key không tồn tại (TTL không đặt được)');
      } else {
        flash(`Đã đặt TTL ${humanizeTtl(secs)}`);
        await openKey(selectedKey); // refresh value+ttl
      }
      setTtlInput('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ── Delete a key (confirmed in the modal) ───────────────────────────────────
  async function confirmDelete() {
    const key = delKey;
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await deleteRedisKey(activeIdRef.current, dbRef.current, key);
      setDelKey(null);
      if (r.deleted > 0) {
        flash(r.lockKeyWarning ? `Đã xoá key (⚠ đây là lock key)` : 'Đã xoá key');
        // Drop it from the list + clear the value panel if it was open.
        setKeys((prev) => prev.filter((k) => k.key !== key));
        if (selectedKey === key) {
          setSelectedKey(null);
          setValue(null);
        }
      } else {
        flash('Key không tồn tại (không có gì để xoá)');
      }
    } catch (e) {
      setError((e as Error).message);
      setDelKey(null);
    } finally {
      setBusy(false);
    }
  }

  // ── Add a key (from the modal) ──────────────────────────────────────────────
  async function handleAddKey(input: SetKeyInput): Promise<void> {
    // Throws on failure so the modal can surface the error inline (and stay open).
    await setRedisValue(activeIdRef.current, dbRef.current, input);
    setAddOpen(false);
    flash(`Đã thêm key "${input.key}"`);
    // Re-scan so the new key appears if it matches the current filter.
    void startFresh();
  }

  /**
   * Ghi value đã sửa tay trong panel (đã qua modal xác nhận).
   *
   * GIỮ NGUYÊN TTL: setValue phía server DEL key cũ rồi ghi lại để đổi kiểu
   * không còn phần tử rác — nghĩa là TTL cũ mất theo. Sửa một key đang có hạn mà
   * biến nó thành vĩnh viễn thì vừa sai ý người dùng, vừa phạm luật "không có key
   * vĩnh viễn" của tab này. Nên đọc ttl hiện tại rồi truyền lại. ttl = -1 (không
   * hạn) thì để nguyên là không hạn.
   */
  async function handleEditSave(input: { type: SetKeyInput['type']; value: unknown }): Promise<void> {
    const key = value?.key;
    if (!key) return;
    const keepTtl = value && value.ttl > 0 ? value.ttl : undefined;
    // Throws on failure → modal xác nhận tự hiện lỗi và ở lại.
    await setRedisValue(activeIdRef.current, dbRef.current, {
      key,
      type: input.type,
      value: input.value,
      ttl: keepTtl,
      overwrite: true, // sửa key đang có thì đương nhiên là ghi đè
    });
    flash(`Đã lưu value của "${key}"`);
    await openKey(key); // đọc lại từ Redis: thấy đúng thứ vừa ghi, không phải tin bản nháp
  }

  // Connections grouped by project for the left rail.
  const grouped = useMemo(() => {
    const m = new Map<string, PublicRedisConnection[]>();
    for (const c of connections) {
      const g = m.get(c.project) ?? [];
      g.push(c);
      m.set(c.project, g);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [connections]);

  const scanExhausted = cursor === '0' && scanStarted;
  const atSoftCap = !scanExhausted && keys.length >= softLimit; // paused, "load more" offered

  // ── Disabled / loading states ───────────────────────────────────────────────
  if (enabled === null) {
    return <div className="empty"><div className="empty-ico">◆</div><p>Đang kiểm tra Redis…</p></div>;
  }
  if (!enabled) {
    return (
      <div className="empty">
        <div className="empty-ico">◆</div>
        <p>
          Redis tool đang tắt. Đây là tính năng <b>chỉ dùng khi chạy local</b>. Bật bằng cách đặt
          <code className="small"> REDIS_TOOL_ENABLED=true</code> trong <code className="small">.env.local</code> rồi
          khởi động lại api-tester.
        </p>
      </div>
    );
  }

  return (
    <div className="redis-layout" ref={railSplit.ref} style={railSplit.style}>
      {/* ── Left: connections grouped by project ─────────────────────────────── */}
      <div className="panel redis-conn-rail">
        <div className="status-line">
          <h3 style={{ margin: 0, flex: 1 }}>Redis</h3>
          <ConnTransferButton
            kind="redis"
            connections={connections}
            onImported={(summary) => { void loadConnections(); flash(summary); }}
            onError={setError}
          />
          <button
            className={manageOpen ? 'sm' : 'ghost sm'}
            onClick={() => setManageOpen((o) => !o)}
            title="Thêm kết nối mới"
          >
            {manageOpen ? '✕ Đóng' : '+ Thêm'}
          </button>
        </div>

        {connections.length === 0 && !manageOpen && (
          <div className="empty" style={{ padding: '20px 8px' }}>
            <div className="empty-ico">◆</div>
            <p className="small">
              Chưa có kết nối nào. Bấm <b>+ Thêm</b> để tạo một Redis (single hoặc cluster).
            </p>
          </div>
        )}

        {grouped.map(([project, conns]) => (
          <div key={project} className="redis-conn-group">
            <div className="group-title">{project}</div>
            {conns.map((c) => {
              const p = pings[c.id];
              return (
                <div
                  key={c.id}
                  className={`redis-conn-row ${c.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(c.id)}
                  title={c.mode === 'cluster' ? `cluster · ${(c.nodes ?? []).length} nodes` : `${c.host}:${c.port}`}
                >
                  <div className="redis-conn-main">
                    <code className="redis-conn-name">
                      {c.mode === 'cluster' && <span className="redis-badge-cluster">cluster</span>}
                      {c.name}
                    </code>
                    <code className="small redis-conn-host">
                      {c.mode === 'cluster' ? `${(c.nodes ?? []).length} nodes · ${c.host}:${c.port}…` : `${c.host}:${c.port}`}
                    </code>
                  </div>
                  {p !== undefined && (
                    <span
                      className="small"
                      style={{ color: p === 'err' ? 'var(--err)' : 'var(--ok)', whiteSpace: 'nowrap' }}
                      title="ping mới nhất"
                    >
                      {p === 'err' ? 'lỗi' : `${p}ms`}
                    </span>
                  )}
                  <button
                    className="ghost sm"
                    onClick={(e) => { e.stopPropagation(); doPing(c.id); }}
                    title="PING — đo độ trễ"
                  >
                    ⚡
                  </button>
                  {/* ⋯ per-row action menu: Sửa / Xoá right here in the list. */}
                  <div className="redis-conn-menu" style={{ position: 'relative' }}>
                    <button
                      className="ghost sm"
                      onClick={(e) => { e.stopPropagation(); setMenuId((m) => (m === c.id ? null : c.id)); }}
                      title="Sửa / Xoá kết nối"
                      aria-haspopup="menu"
                      aria-expanded={menuId === c.id}
                    >
                      ⋯
                    </button>
                    {menuId === c.id && (
                      <div className="redis-menu-pop" role="menu" onClick={(e) => e.stopPropagation()}>
                        <button className="redis-menu-item" role="menuitem" onClick={() => openEdit(c)}>
                          ✎ Sửa
                        </button>
                        <button className="redis-menu-item danger" role="menuitem" onClick={() => deleteConnection(c)}>
                          🗑 Xoá
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        {manageOpen && (
          <ConnectionManager
            connections={connections}
            onChanged={applyChanged}
            onDone={() => setManageOpen(false)}
          />
        )}
      </div>

      {/* ── Right: key browser ───────────────────────────────────────────────── */}
      <div className="panel redis-browser">
        {!activeConn ? (
          <div className="empty">
            <div className="empty-ico">◆</div>
            <p>Chọn một kết nối Redis bên trái để duyệt key.</p>
          </div>
        ) : (
          <>
            <div className="status-line">
              <h3 style={{ margin: 0 }}>{activeConn.name}</h3>
              <code className="small" style={{ color: 'var(--muted)', flex: 1 }}>
                {isClusterActive
                  ? `cluster · ${(activeConn.nodes ?? []).length} nodes`
                  : `${activeConn.host}:${activeConn.port}/${db}`}
              </code>
              <button className="ghost sm" onClick={() => doPing(activeConn.id)} title="PING">⚡ Ping</button>
            </div>

            {/* Live monitor (INFO 30s) — collapsed by default, per-node when cluster. */}
            <MonitorStrip connectionId={activeConn.id} />

            {/* Search bar — pattern + DB; SCAN runs automatically (debounced), no button. */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
              {isClusterActive ? (
                <span className="redis-badge-cluster" title="Redis Cluster — quét gộp mọi master node, chỉ DB 0">cluster · DB 0</span>
              ) : (
                <label className="small" style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  DB
                  <select
                    value={db}
                    onChange={(e) => setDb(Number(e.target.value))}
                    title="Logical DB index (0–15) — chọn DB để duyệt"
                    style={{ padding: '6px 8px', fontSize: 12 }}
                  >
                    {DB_INDEXES.map((i) => (
                      <option key={i} value={i}>{i}</option>
                    ))}
                  </select>
                </label>
              )}
              <input
                type="text"
                value={query}
                // Gõ tay → thoát chế độ mẫu thô của Tìm nhanh, ô tìm về hành vi thường.
                onChange={(e) => { setQuery(e.target.value); setRawPattern(false); }}
                placeholder={exact ? 'nhập đúng tên key' : 'nhập từ khoá (khớp mọi vị trí) — vd: profile'}
                title={exact ? 'Khớp đúng tên key' : 'Khớp chứa từ khoá ở bất kỳ vị trí nào (không cần gõ *)'}
                style={{ flex: '1 1 220px', minWidth: 180, fontFamily: 'var(--mono)', fontSize: 12 }}
              />
              <label
                className="small"
                style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', whiteSpace: 'nowrap', cursor: 'pointer' }}
                title="Bật: khớp đúng tên key · Tắt: khớp chứa từ khoá (*từ khoá*)"
              >
                <input
                  type="checkbox"
                  checked={exact}
                  onChange={(e) => { setExact(e.target.checked); setRawPattern(false); }}
                />
                Đúng key
              </label>
              {/* Tìm nhanh: chỉ hiện khi đã có kết nối, vì preset nào cũng phải
                  trỏ vào một cụm Redis + DB cụ thể. */}
              {connections.length > 0 && (
                <QuickFindPanel
                  connections={connections}
                  currentConnectionId={activeId}
                  currentDb={db}
                  onNotice={flash}
                  onRun={({ connectionId, db: presetDb, key, presetName }) => {
                    if (connectionId !== activeId) setActiveId(connectionId);
                    if (presetDb !== db) setDb(presetDb);
                    // Preset đã điền xong biến thì thường ra một tên key ĐẦY ĐỦ
                    // — lúc đó tra thẳng (TYPE+TTL), không quét: nhanh tức thì
                    // và không bao giờ bỏ sót dù DB lớn cỡ nào.
                    // Chỉ khi mẫu CÒN wildcard (`callbot_listen:vhs.vn:*`) mới
                    // phải scan, vì lúc đó nó là một dải key chứ không phải một
                    // key cụ thể.
                    const wild = hasGlobWildcard(key);
                    setExact(!wild);
                    setRawPattern(wild);
                    setQuery(key);
                    setSelectedKey(null);
                    flash(`Tìm nhanh: ${presetName}`);
                  }}
                />
              )}
              <SessionHistory
                scope="redis"
                connectionId={activeId}
                reloadKey={sessBump}
                onRestore={restoreSession}
              />
              <button className="ghost sm" onClick={() => void startFresh()} disabled={scanning} title="Quét lại từ đầu">
                {scanning ? <span className="spinner" aria-hidden /> : '↻'} Làm mới
              </button>
              <button className="sm" onClick={() => setAddOpen(true)} title="Thêm key mới vào DB đang duyệt">
                + Thêm key
              </button>
            </div>
            <div className="small" style={{ color: 'var(--muted)', marginTop: 6 }}>
              {exact && query.trim() ? (
                <>
                  Đang tra <b>trực tiếp</b> đúng tên key (TYPE + TTL) — không quét keyspace,
                  nên DB lớn cỡ nào cũng tức thì và không bỏ sót.
                </>
              ) : (
                <>
                  Dùng <b>SCAN</b> cursor-based (không block instance) — tự tải thêm khi cuộn xuống.
                  {' '}Bỏ trống ô tìm để duyệt tất cả key.
                  {isClusterActive && ' Cluster: quét gộp toàn bộ master node.'}
                </>
              )}
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', marginTop: 10, marginBottom: 0 }}>{error}</pre>}
            {notice && <div className="small" style={{ color: 'var(--ok)', marginTop: 10 }}>{notice}</div>}

            {/* Key table + value panel */}
            <div className="redis-split">
              <div className="redis-keys">
                <div className="small" style={{ color: 'var(--muted)', margin: '10px 0 6px' }}>
                  {!scanStarted ? 'Đang tải…' : (
                    <>
                      {keys.length} key
                      {scanExhausted ? ' (đã hết)' : atSoftCap ? ' (tạm dừng)' : '…'}
                      {/* Không tìm thấy gì mà CHƯA quét hết keyspace là ca dễ
                          hiểu sai nhất: "0 key" trông như không tồn tại. Nói rõ
                          ra và chỉ đường sang cách tra chắc chắn. */}
                      {keys.length === 0 && scanExhausted && !exact && query.trim() && (
                        <span style={{ color: 'var(--warn)' }}>
                          {' '}— không có key nào chứa “{query.trim()}”. Biết chính xác tên key
                          thì bật <b>Đúng key</b> để tra trực tiếp.
                        </span>
                      )}
                      {keys.length === 0 && exact && query.trim() && scanExhausted && (
                        <span style={{ color: 'var(--warn)' }}>
                          {' '}— key “{query.trim()}” không tồn tại ở DB {db}
                          {isClusterActive ? ' (cluster)' : ''}.
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="endpoint-list" ref={listRef} onScroll={onListScroll}>
                  {keys.map((k) => (
                    <div
                      key={k.key}
                      className={`ep-item ${selectedKey === k.key ? 'active' : ''}`}
                      onClick={() => openKey(k.key)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <span className="redis-type" title={k.type}>{typeIcon(k.type)}</span>
                      <code className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {k.key}
                      </code>
                      <span
                        className="small"
                        style={{ color: k.ttl === -1 ? 'var(--muted)' : 'var(--accent)', whiteSpace: 'nowrap' }}
                        title={k.ttl === -1 ? 'không có TTL' : 'TTL còn lại'}
                      >
                        {humanizeTtl(k.ttl)}
                      </span>
                    </div>
                  ))}

                  {/* In-list auto-load spinner (infinite scroll fetching next round). */}
                  {scanning && keys.length > 0 && (
                    <div className="small" style={{ textAlign: 'center', color: 'var(--muted)', padding: '8px 0' }}>
                      <span className="spinner" aria-hidden /> đang tải thêm…
                    </div>
                  )}
                </div>

                {/* Tạm dừng — hoặc vì chạm trần số key (soft cap), hoặc vì hết
                    thời gian quét tự động. Cả hai đều phải có đường đi tiếp:
                    trước đây chỉ soft cap mới hiện nút, nên khi dừng vì hết
                    thời gian mà chưa đủ key là người dùng kẹt, không biết còn
                    keyspace chưa quét. */}
                {scanStarted && !scanning && !scanExhausted && (
                  <button
                    className="ghost sm"
                    style={{ marginTop: 8, width: '100%' }}
                    onClick={loadMorePastCap}
                    title={atSoftCap
                      ? `Đã tải ${keys.length} key — tải thêm ${SOFT_LIMIT} nữa`
                      : 'Còn keyspace chưa quét — quét tiếp từ chỗ đang dừng'}
                  >
                    ↓ Quét tiếp {atSoftCap ? `(đã dừng ở ${keys.length})` : '(chưa quét hết keyspace)'}
                  </button>
                )}

                {scanStarted && !scanning && keys.length === 0 && (
                  <div className="empty" style={{ padding: '20px 8px' }}>
                    {/* Nói ĐÚNG cái đã biết: "không có key nào khớp" chỉ đúng
                        khi đã quét hết. Chưa hết mà nói vậy là sai — và đó là
                        cách người dùng bị dẫn tới kết luận "key không tồn tại"
                        trong khi nó vẫn nằm đâu đó phía sau. */}
                    {exact && query.trim() ? (
                      <p className="small">
                        Key <code>{query.trim()}</code> không tồn tại ở DB {db}
                        {isClusterActive ? ' (cluster)' : ''}.
                      </p>
                    ) : scanExhausted ? (
                      <p className="small">Không có key nào khớp pattern.</p>
                    ) : (
                      <p className="small">
                        Chưa thấy key nào khớp — <b>và chưa quét hết keyspace</b>.
                        Bấm “Quét tiếp” ở trên, hoặc bật <b>Đúng key</b> nếu biết chính xác tên.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Value panel */}
              <div className="redis-value">
                {!selectedKey ? (
                  <div className="empty" style={{ padding: '24px 8px' }}>
                    <div className="empty-ico">◆</div>
                    <p className="small">Chọn một key để xem value, type, TTL.</p>
                  </div>
                ) : valueLoading ? (
                  <div className="empty" style={{ padding: '24px 8px' }}>
                    <span className="spinner" aria-hidden /> <p className="small">Đang tải value…</p>
                  </div>
                ) : value ? (
                  <ValuePanel
                    key={value.key}
                    value={value}
                    ttlInput={ttlInput}
                    onTtlInput={setTtlInput}
                    onApplyTtl={applyTtl}
                    onDelete={() => setDelKey(value.key)}
                    onSaveValue={handleEditSave}
                    busy={busy}
                  />
                ) : (
                  <div className="empty" style={{ padding: '24px 8px' }}>
                    <p className="small">Không đọc được value.</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Delete confirmation modal (typed-confirm) ────────────────────────── */}
      {delKey && activeConn && (
        <DeleteModal
          keyName={delKey}
          onCancel={() => setDelKey(null)}
          onConfirm={confirmDelete}
          busy={busy}
        />
      )}

      {/* ── Add-key modal ─────────────────────────────────────────────────────── */}
      {addOpen && activeConn && (
        <AddKeyModal
          dbLabel={isClusterActive ? 'cluster · DB 0' : `DB ${db}`}
          onCancel={() => setAddOpen(false)}
          onSubmit={handleAddKey}
        />
      )}

      {/* ── Edit-connection modal (from a row's ⋯ → Sửa) ──────────────────────── */}
      {editConn && (
        <EditConnectionModal
          conn={editConn}
          connections={connections}
          onCancel={() => setEditConn(null)}
          onSaved={(next) => { applyChanged(next, editConn.id); setEditConn(null); }}
        />
      )}
      <Splitter {...railSplit.grip} />
    </div>
  );
}

// ── Value panel ────────────────────────────────────────────────────────────────

interface ValuePanelProps {
  value: ValueResult;
  ttlInput: string;
  onTtlInput: (v: string) => void;
  onApplyTtl: () => void;
  onDelete: () => void;
  /** Ghi value đã sửa tay. Throw để modal xác nhận hiện lỗi và ở lại. */
  onSaveValue: (input: { type: EditableType; value: unknown }) => Promise<void>;
  busy: boolean;
}

/** Kiểu sửa được tại chỗ — đúng bằng những kiểu setValue() phía server nhận. */
type EditableType = 'string' | 'list' | 'set' | 'hash';

/**
 * Key này sửa tay được không?
 *
 * zset cần cả score cho từng member và stream là append-only — setValue() không
 * nhận hai kiểu đó, nên KHÔNG hiện nút Sửa thay vì để người dùng gõ xong rồi ăn
 * lỗi "unsupported type" từ server. `truncated` cũng chặn: value đang bị cắt bớt
 * cho vừa panel, lưu bản đang xem sẽ XOÁ những phần tử không được hiển thị.
 */
function editableTypeOf(v: ValueResult): EditableType | null {
  if (v.truncated) return null;
  return v.type === 'string' || v.type === 'list' || v.type === 'set' || v.type === 'hash'
    ? v.type
    : null;
}

/** Renders a key's value (type-aware), TTL, and the Set-TTL + Delete actions. */
function ValuePanel({ value, ttlInput, onTtlInput, onApplyTtl, onDelete, onSaveValue, busy }: ValuePanelProps) {
  const { key, type, ttl, truncated, size } = value;
  const isLock = /:lock:/i.test(key);
  const editable = editableTypeOf(value);
  /** Bản nháp đang sửa — null = đang ở chế độ chỉ đọc. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Đã bấm Lưu → modal xác nhận. Không ghi gì trước khi xác nhận. */
  const [confirming, setConfirming] = useState(false);

  return (
    <div>
      <div className="status-line">
        <span className="redis-type" title={type}>{typeIcon(type)}</span>
        <code className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={key}>
          {key}
        </code>
        <span className="badge info" title="kiểu Redis">{type}</span>
      </div>

      {type === 'none' && (
        <div className="badge warn" style={{ marginTop: 10 }}>Key không tồn tại (có thể vừa hết hạn / bị xoá).</div>
      )}
      {isLock && (
        <div className="badge warn" style={{ marginTop: 10 }}>
          🔒 Đây là <b>lock key</b> — xoá có thể nhả lock của pod khác. Cân nhắc kỹ.
        </div>
      )}

      <div className="small" style={{ color: 'var(--muted)', margin: '10px 0 4px' }}>
        TTL: <b style={{ color: ttl === -1 ? 'var(--muted)' : 'var(--accent)' }}>{humanizeTtl(ttl)}</b>
        {size !== undefined && <> · {size} phần tử{truncated ? ` (hiển thị tối đa)` : ''}</>}
      </div>

      {/* Sửa tay ngay trong ô kết quả. Chỉ hiện nút khi kiểu này ghi lại được,
          và LUÔN phải qua modal xác nhận trước khi ghi (nút Lưu chỉ mở modal). */}
      {draft === null ? (
        <>
          {editable && (
            <div className="redis-val-tools">
              <button className="chip-btn" onClick={() => setDraft(valueToText(value))}
                title="Sửa value ngay tại đây rồi lưu lại (có bước xác nhận)">
                ✏️ Sửa
              </button>
            </div>
          )}
          <ValueBody value={value} />
          {/* Nói rõ VÌ SAO không sửa được, thay vì chỉ im lặng thiếu cái nút. */}
          {!editable && type !== 'none' && (
            <p className="small" style={{ color: 'var(--muted)', margin: '6px 0 0' }}>
              {truncated
                ? 'Value đang bị cắt bớt để hiển thị nên không cho sửa tay — lưu bản đang xem sẽ làm mất những phần tử không hiện ra.'
                : `Kiểu ${type} không sửa tay được ở đây (chỉ string, list, set, hash).`}
            </p>
          )}
        </>
      ) : (
        <ValueEditor
          type={editable ?? 'string'}
          draft={draft}
          onDraft={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => setConfirming(true)}
          busy={busy}
        />
      )}

      {/* Xác nhận trước khi ghi — bày rõ ghi vào key nào, kiểu gì, TTL ra sao. */}
      {confirming && draft !== null && (
        <SaveValueModal
          keyName={key}
          type={editable ?? 'string'}
          ttl={ttl}
          draft={draft}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await onSaveValue({ type: editable ?? 'string', value: textToValue(editable ?? 'string', draft) });
            // Chỉ tới đây khi ghi THÀNH CÔNG (lỗi thì throw, modal ở lại).
            setConfirming(false);
            setDraft(null);
          }}
        />
      )}

      {/* Set TTL — capped at 30 days; no PERSIST offered. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <label className="small" style={{ color: 'var(--muted)' }}>Set TTL (giây)</label>
        <input
          type="number"
          min={1}
          max={MAX_TTL_SECONDS}
          value={ttlInput}
          onChange={(e) => onTtlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onApplyTtl()}
          placeholder={`1 – ${MAX_TTL_SECONDS}`}
          style={{ width: 140, fontFamily: 'var(--mono)', fontSize: 12 }}
          disabled={busy || type === 'none'}
        />
        <button className="sm" onClick={onApplyTtl} disabled={busy || !ttlInput || type === 'none'} title="EXPIRE (tối đa 30 ngày)">
          Đặt TTL
        </button>
        <span className="small" style={{ color: 'var(--muted)' }}>tối đa 30 ngày · không có PERSIST</span>
      </div>

      <div style={{ marginTop: 12, borderTop: '1px solid var(--border, rgba(127,127,127,.2))', paddingTop: 12 }}>
        <button
          className="sm"
          onClick={onDelete}
          disabled={busy || type === 'none'}
          style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
          title="Xoá 1 key (DEL) — có xác nhận"
        >
          🗑 Xoá key
        </button>
      </div>
    </div>
  );
}

/**
 * Value hiện theo ĐÚNG KIỂU của key, thay vì đổ tất cả vào một khối JSON:
 *  · string — nguyên văn; nếu nội dung LÀ json thì có nút Format bật/tắt.
 *  · hash   — bảng field → value như RedisInsight, có ô lọc field.
 *  · list/set/zset — bảng có số thứ tự (zset kèm score).
 * Kiểu lạ thì vẫn rơi về JSON như cũ, không chặn đường đọc.
 */
function ValueBody({ value }: { value: ValueResult }) {
  const { type } = value;
  if (type === 'none') return <pre className="code redis-val">(không tồn tại)</pre>;
  if (type === 'string') return <StringValue raw={value.value === null ? '(null)' : String(value.value)} />;
  if (type === 'hash' && value.value && typeof value.value === 'object' && !Array.isArray(value.value)) {
    return <HashValue map={value.value as Record<string, string>} />;
  }
  if (type === 'zset' && Array.isArray(value.value)) {
    return <ZsetValue items={value.value as { member: string; score: string }[]} />;
  }
  if ((type === 'list' || type === 'set') && Array.isArray(value.value)) {
    return <ListValue items={(value.value as unknown[]).map(String)} ordered={type === 'list'} />;
  }
  return <pre className="code redis-val">{safeJson(value.value)}</pre>;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// ── Sửa value tại chỗ: value ⇄ text ──────────────────────────────────────────
//
// Dùng ĐÚNG định dạng text của hộp "Thêm key" (string = nguyên văn, list/set =
// mỗi dòng một phần tử, hash = `field=value` mỗi dòng). Hai chỗ nhập cùng một
// kiểu dữ liệu mà bắt người dùng học hai cú pháp thì vô lý.

/** Value đọc từ Redis → text để sửa. */
function valueToText(v: ValueResult): string {
  if (v.type === 'string') return v.value === null ? '' : String(v.value);
  if (v.type === 'hash' && v.value && typeof v.value === 'object' && !Array.isArray(v.value)) {
    return Object.entries(v.value as Record<string, string>)
      .map(([f, val]) => `${f}=${val}`)
      .join('\n');
  }
  if (Array.isArray(v.value)) return (v.value as unknown[]).map(String).join('\n');
  return safeJson(v.value);
}

/** Text đã sửa → payload cho setValue(). Cùng luật với AddKeyModal.buildValue. */
function textToValue(type: EditableType, text: string): unknown {
  if (type === 'string') return text;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (type === 'hash') {
    return lines.map((line) => {
      const idx = line.indexOf('=');
      if (idx === -1) return { field: line, value: '' };
      return { field: line.slice(0, idx).trim(), value: line.slice(idx + 1) };
    });
  }
  return lines; // list / set → string[]
}

/** Đếm phần tử sắp ghi — modal xác nhận hiện con số này. */
function countOf(type: EditableType, text: string): number {
  if (type === 'string') return 1;
  const v = textToValue(type, text);
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Bản nháp có phần tử sẽ BỊ ĐỔI khi lưu không?
 *
 * Cú pháp "mỗi dòng một phần tử" trim hai đầu và bỏ dòng trống — điều đó có nghĩa
 * một phần tử vốn là "  abc  " sẽ được ghi lại thành "abc", và phần tử rỗng thì
 * mất hẳn. Lúc THÊM key mới thì không ai để ý, nhưng lúc SỬA key đang có thì đó
 * là âm thầm làm sai dữ liệu — nên phải nói trước ở modal xác nhận.
 * (Không tự ý bỏ trim: nó là cú pháp dùng chung với hộp Thêm key, và giữ khoảng
 * trắng vô tình ở rìa còn hay gây lỗi hơn.)
 */
function lossyLines(type: EditableType, text: string): string[] {
  if (type === 'string') return [];
  const raw = text.split('\n');
  const out: string[] = [];
  for (const line of raw) {
    if (line.trim() === '') {
      if (line.length > 0) out.push('(dòng chỉ có khoảng trắng — sẽ bị bỏ)');
      continue;
    }
    if (line !== line.trim()) out.push(line);
  }
  return out;
}

/** Ô sửa value: textarea + gợi ý cú pháp đúng theo kiểu, Lưu / Huỷ. */
function ValueEditor({ type, draft, onDraft, onCancel, onSave, busy }: {
  type: EditableType;
  draft: string;
  onDraft: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const hint =
    type === 'string' ? 'Sửa nguyên văn giá trị string.'
    : type === 'hash' ? 'Mỗi dòng một field: field=value'
    : `Mỗi dòng một phần tử (${type}).`;
  const empty = type !== 'string' && countOf(type, draft) === 0;
  return (
    <div className="redis-edit">
      <div className="redis-val-tools">
        <span className="badge warn">✏️ Đang sửa</span>
        <span className="small" style={{ color: 'var(--muted)', flex: 1 }}>{hint}</span>
      </div>
      <textarea
        className="input"
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        spellCheck={false}
        rows={12}
        style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        {/* Nút này KHÔNG ghi gì — nó mở modal xác nhận. */}
        <button className="sm" onClick={onSave} disabled={busy || empty}
          title="Xem lại rồi xác nhận trước khi ghi vào Redis">
          💾 Lưu…
        </button>
        <button className="ghost sm" onClick={onCancel} disabled={busy}>Huỷ</button>
        {empty && (
          <span className="small" style={{ color: 'var(--warn)' }}>
            Cần ít nhất một phần tử — {type} rỗng thì Redis không có key để giữ.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Xác nhận ghi value.
 *
 * Đây là bước bắt buộc trước mọi lần ghi: ghi đè value của một key đang chạy
 * thật là việc không hoàn tác được, nên phải bày ra ĐỦ thứ người dùng cần đối
 * chiếu — key nào, kiểu gì, bao nhiêu phần tử, TTL sau khi lưu — rồi mới cho bấm.
 */
function SaveValueModal({ keyName, type, ttl, draft, onCancel, onConfirm }: {
  keyName: string;
  type: EditableType;
  ttl: number;
  draft: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isLock = /:lock:/i.test(keyName);
  const n = countOf(type, draft);
  const lossy = lossyLines(type, draft);

  const go = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onConfirm();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Ghi value mới?</h3>
          {!busy && <button className="ghost sm" onClick={onCancel}>✕</button>}
        </div>

        <p className="small" style={{ margin: '0 0 8px' }}>
          Ghi đè value của <code>{keyName}</code> (<b>{type}</b>
          {type !== 'string' && <> · {n} phần tử</>}). Việc này <b>không hoàn tác được</b>.
        </p>

        {isLock && (
          <div className="badge warn" style={{ marginBottom: 8 }}>
            🔒 Đây là <b>lock key</b> — sửa value có thể làm rối lock của pod khác.
          </div>
        )}

        <div className="badge info" style={{ marginBottom: 8 }}>
          TTL: {ttl > 0
            ? <>giữ nguyên <b>{humanizeTtl(ttl)}</b></>
            : <>key không có hạn — vẫn để không hạn</>}
        </div>

        {/* Cú pháp "mỗi dòng một phần tử" trim hai đầu + bỏ dòng trống. Nói TRƯỚC
            khi ghi, vì đây là lúc duy nhất còn quay lại được. */}
        {lossy.length > 0 && (
          <div className="badge warn" style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>
            ⚠️ {lossy.length} dòng sẽ bị cắt khoảng trắng ở hai đầu (hoặc bỏ hẳn nếu chỉ có
            khoảng trắng). Muốn giữ nguyên khoảng trắng thì đổi key này sang <b>string</b> và
            tự quản lý định dạng.
          </div>
        )}

        {/* Xem lại đúng thứ sắp ghi. Cắt bớt phần hiển thị cho khỏi tràn màn
            hình, nhưng ghi thì vẫn ghi trọn bản nháp. */}
        <pre className="code redis-val" style={{ maxHeight: 220 }}>
          {draft.length > 4000 ? `${draft.slice(0, 4000)}\n… (còn ${draft.length - 4000} ký tự nữa)` : draft}
        </pre>

        {err && <div className="badge err" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="sm" onClick={() => void go()} disabled={busy}
            style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>
            {busy ? <span className="spinner" aria-hidden /> : '💾'} Xác nhận ghi
          </button>
          <button className="ghost sm" onClick={onCancel} disabled={busy}>Huỷ</button>
        </div>
      </div>
    </div>
  );
}

/** Thử parse JSON — trả về bản đã format, hoặc null nếu không phải JSON. */
function tryFormatJson(raw: string): string | null {
  const t = raw.trim();
  // Chỉ thử khi trông đã giống JSON: tránh JSON.parse nuốt "123"/"true" thành
  // số/boolean rồi "format" một chuỗi vốn không phải JSON.
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/**
 * Value kiểu string. Rất nhiều key Redis chứa JSON — nhận ra thì bật sẵn bản
 * format cho dễ đọc, kèm nút chuyển qua lại vì đôi khi cần đúng chuỗi thô
 * (so sánh byte, copy nguyên văn).
 */
function StringValue({ raw }: { raw: string }) {
  const pretty = useMemo(() => tryFormatJson(raw), [raw]);
  const [formatted, setFormatted] = useState(true);
  const show = pretty && formatted ? pretty : raw;
  return (
    <>
      {pretty && (
        <div className="redis-val-tools">
          <button
            className={'chip-btn' + (formatted ? ' on' : '')}
            onClick={() => setFormatted((v) => !v)}
            title={formatted ? 'Xem chuỗi gốc' : 'Format JSON cho dễ đọc'}
          >{'{ }'} {formatted ? 'JSON đã format' : 'Chuỗi gốc'}</button>
          <button className="chip-btn" title="Copy nội dung"
            onClick={() => void navigator.clipboard?.writeText(show)}>⧉ Copy</button>
        </div>
      )}
      <pre className="code redis-val">{show}</pre>
    </>
  );
}

/** Hash → bảng field/value như RedisInsight, kèm ô lọc khi hash to. */
function HashValue({ map }: { map: Record<string, string> }) {
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => {
    const all = Object.entries(map);
    const f = filter.trim().toLowerCase();
    if (!f) return all;
    return all.filter(([k, v]) => k.toLowerCase().includes(f) || String(v).toLowerCase().includes(f));
  }, [map, filter]);
  const total = Object.keys(map).length;
  return (
    <>
      <div className="redis-val-tools">
        <input
          className="input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="lọc field / value…"
          style={{ flex: 1, minWidth: 120, fontFamily: 'var(--mono)', fontSize: 12 }}
        />
        <span className="small" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          {filter.trim() ? `${rows.length}/${total}` : `${total}`} field
        </span>
      </div>
      <div className="redis-kv">
        {rows.map(([k, v]) => (
          <div className="redis-kv-row" key={k}>
            <code className="redis-kv-k" title={k}>{k}</code>
            <FieldValue raw={String(v)} />
          </div>
        ))}
        {rows.length === 0 && <p className="empty" style={{ padding: '12px 8px' }}>Không có field nào khớp.</p>}
      </div>
    </>
  );
}

/** Một value trong bảng — tự format khi nó là JSON lồng (rất hay gặp trong hash). */
function FieldValue({ raw }: { raw: string }) {
  const pretty = useMemo(() => tryFormatJson(raw), [raw]);
  const [open, setOpen] = useState(false);
  if (!pretty) return <code className="redis-kv-v" title={raw}>{raw}</code>;
  return (
    <code className="redis-kv-v redis-kv-json">
      <button className="redis-kv-fmt" onClick={() => setOpen((v) => !v)}
        title={open ? 'Thu gọn' : 'Format JSON'}>{open ? '▾' : '▸'} {'{ }'}</button>
      {open ? <pre className="code redis-val" style={{ marginTop: 4 }}>{pretty}</pre> : <span title={raw}>{raw}</span>}
    </code>
  );
}

/** list/set → bảng có số thứ tự (list giữ thứ tự, set thì chỉ để đếm). */
function ListValue({ items, ordered }: { items: string[]; ordered: boolean }) {
  return (
    <div className="redis-kv">
      {items.map((v, i) => (
        <div className="redis-kv-row" key={`${i}-${v}`}>
          <code className="redis-kv-k redis-kv-idx" title={ordered ? `index ${i}` : undefined}>{i}</code>
          <FieldValue raw={v} />
        </div>
      ))}
      {items.length === 0 && <p className="empty" style={{ padding: '12px 8px' }}>(rỗng)</p>}
    </div>
  );
}

/** zset → member kèm score. */
function ZsetValue({ items }: { items: { member: string; score: string }[] }) {
  return (
    <div className="redis-kv">
      {items.map((it, i) => (
        <div className="redis-kv-row" key={`${i}-${it.member}`}>
          <code className="redis-kv-k redis-kv-score" title="score">{it.score}</code>
          <FieldValue raw={it.member} />
        </div>
      ))}
      {items.length === 0 && <p className="empty" style={{ padding: '12px 8px' }}>(rỗng)</p>}
    </div>
  );
}

// ── Delete confirmation modal (typed-confirm) ────────────────────────────────────

interface DeleteModalProps {
  keyName: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}

// ── Add-key modal ──────────────────────────────────────────────────────────────

interface AddKeyModalProps {
  dbLabel: string;
  onCancel: () => void;
  onSubmit: (input: SetKeyInput) => Promise<void>;
}

type AddKeyType = 'string' | 'list' | 'set' | 'hash';

/**
 * Create a new key of a chosen type. String → one value; list/set → one member
 * per line; hash → `field=value` per line. Optional TTL (≤30 days) and an
 * overwrite toggle. Errors from the server are shown inline (modal stays open).
 */
function AddKeyModal({ dbLabel, onCancel, onSubmit }: AddKeyModalProps) {
  const [key, setKey] = useState('');
  const [type, setType] = useState<AddKeyType>('string');
  const [text, setText] = useState(''); // string value OR multi-line members/pairs
  const [ttl, setTtl] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Turn the textarea into the shape the server expects for the chosen type.
  const buildValue = (): unknown => {
    if (type === 'string') return text;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (type === 'hash') {
      return lines.map((line) => {
        const idx = line.indexOf('=');
        if (idx === -1) return { field: line, value: '' };
        return { field: line.slice(0, idx).trim(), value: line.slice(idx + 1) };
      });
    }
    return lines; // list / set → string[]
  };

  const submit = async () => {
    setErr(null);
    const k = key.trim();
    if (!k) { setErr('Tên key là bắt buộc'); return; }
    const ttlNum = ttl.trim() ? Number(ttl) : undefined;
    if (ttlNum != null && (!Number.isInteger(ttlNum) || ttlNum < 1)) { setErr('TTL phải là số giây ≥ 1'); return; }
    setBusy(true);
    try {
      await onSubmit({ key: k, type, value: buildValue(), ttl: ttlNum, overwrite });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const placeholder =
    type === 'string' ? 'Giá trị (string)'
    : type === 'hash' ? 'Mỗi dòng: field=value\nvd:\nname=An\nage=30'
    : `Mỗi dòng 1 phần tử (${type})\nvd:\nitem-1\nitem-2`;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Thêm key <span className="small" style={{ color: 'var(--muted)' }}>· {dbLabel}</span></h3>
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Tên key (vd: crm:cache:user:1)"
            autoFocus
            style={{ flex: '1 1 260px', minWidth: 180, fontFamily: 'var(--mono)', fontSize: 12 }}
          />
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)' }}>
            Kiểu
            <select value={type} onChange={(e) => { setType(e.target.value as AddKeyType); setText(''); }} style={{ padding: '6px 8px', fontSize: 12 }}>
              <option value="string">string</option>
              <option value="list">list</option>
              <option value="set">set</option>
              <option value="hash">hash</option>
            </select>
          </label>
        </div>

        {type === 'string' ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            rows={4}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical', marginBottom: 8 }}
          />
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            rows={5}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical', marginBottom: 8 }}
          />
        )}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)' }}>
            TTL (giây)
            <input
              type="number"
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              placeholder="trống = không hết hạn"
              style={{ width: 160, fontSize: 12 }}
            />
          </label>
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', cursor: 'pointer' }} title="Cho phép ghi đè nếu key đã tồn tại">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            Ghi đè nếu đã tồn tại
          </label>
        </div>

        {err && <pre className="code" style={{ color: 'var(--err)', marginTop: 0, marginBottom: 10 }}>{err}</pre>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="ghost sm" onClick={onCancel} disabled={busy}>Hủy</button>
          <button className="sm" onClick={submit} disabled={busy || !key.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : '+'} Thêm key
          </button>
        </div>
      </div>
    </div>
  );
}

/** Requires the operator to retype the key name; extra red banner for lock keys. */
function DeleteModal({ keyName, onCancel, onConfirm, busy }: DeleteModalProps) {
  const [typed, setTyped] = useState('');
  const isLock = /:lock:/i.test(keyName);
  const canDelete = typed === keyName && !busy;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(480px, 92vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Xoá key?</h3>
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>

        {isLock && (
          <div
            className="badge"
            style={{ marginBottom: 10, color: 'var(--err)', border: '1px solid var(--err)', display: 'block', padding: '8px 10px' }}
          >
            ⚠ <b>Đây là lock key — xoá có thể nhả lock của pod khác. </b>
            Thao tác không khôi phục được.
          </div>
        )}

        <div className="small" style={{ color: 'var(--muted)', marginBottom: 8 }}>
          Gõ lại đúng tên key để xác nhận xoá:
        </div>
        <code className="small" style={{ display: 'block', marginBottom: 8, wordBreak: 'break-all' }}>{keyName}</code>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canDelete && onConfirm()}
          placeholder="gõ lại tên key"
          autoFocus
          style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="ghost sm" onClick={onCancel} disabled={busy}>Hủy</button>
          <button
            className="sm"
            onClick={onConfirm}
            disabled={!canDelete}
            style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
            title={canDelete ? 'DEL key' : 'Gõ đúng tên key để bật nút xoá'}
          >
            {busy ? <span className="spinner" aria-hidden /> : '🗑'} Xoá vĩnh viễn
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Connection form (shared by the add panel + the edit modal) ─────────────────────

const EMPTY_FORM = {
  name: '',
  project: '',
  mode: 'single' as RedisMode,
  host: '',
  port: '6379',
  /** Cluster seed nodes as free text — one `host:port` per line. */
  nodesText: '',
  password: '',
};

type ConnForm = typeof EMPTY_FORM;

/** Build a form state from an existing connection (password never prefilled). */
function formOf(c: PublicRedisConnection): ConnForm {
  return {
    name: c.name,
    project: c.project,
    mode: c.mode ?? 'single',
    host: c.host,
    port: String(c.port),
    nodesText: (c.nodes ?? []).map((n) => `${n.host}:${n.port}`).join('\n'),
    password: '',
  };
}

/** Parse a "host:port" per line textarea into RedisNode[] (skips blank lines). */
function parseNodesText(text: string): RedisNode[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.lastIndexOf(':');
      const host = (idx === -1 ? line : line.slice(0, idx)).trim();
      const port = idx === -1 ? 6379 : Number(line.slice(idx + 1));
      return { host, port };
    })
    .filter((n) => n.host && Number.isInteger(n.port) && n.port >= 1 && n.port <= 65535);
}

/** Result of the "Test connection" probe (against the values currently in the form). */
type TestState = { status: 'ok'; latencyMs: number } | { status: 'err'; message: string } | null;

interface ConnectionFormProps {
  /** Initial values (edit) or undefined (add-new). */
  initial?: PublicRedisConnection;
  /** Editing id when known — enables PUT + "keep password" hint. */
  editingId?: string;
  busy: boolean;
  onBusy: (b: boolean) => void;
  /** Persist: returns the new list; the parent decides prefer-id + close. */
  onSaved: (next: PublicRedisConnection[], savedId?: string) => void;
}

/**
 * The Redis-connection form body: name/project/mode + single(host,port) or
 * cluster(seed nodes) + password, with an inline "Test connection" probe.
 * Reused by both the add panel and the compact edit modal.
 */
function ConnectionForm({ initial, editingId, busy, onBusy, onSaved }: ConnectionFormProps) {
  const [form, setForm] = useState<ConnForm>(() => (initial ? formOf(initial) : { ...EMPTY_FORM }));
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestState>(null);
  const [err, setErr] = useState<string | null>(null);

  // Any form edit invalidates a prior test result.
  const set = <K extends keyof ConnForm>(k: K, v: ConnForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setTest(null);
  };

  const runTest = useCallback(async () => {
    setTesting(true);
    setTest(null);
    setErr(null);
    try {
      const r = await testRedisConnection(
        form.mode === 'cluster'
          ? { mode: 'cluster', nodes: parseNodesText(form.nodesText), password: form.password || undefined }
          : { mode: 'single', host: form.host.trim(), port: Number(form.port), password: form.password || undefined },
      );
      setTest({ status: 'ok', latencyMs: r.latencyMs });
    } catch (e) {
      setTest({ status: 'err', message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }, [form]);

  const submit = useCallback(async () => {
    onBusy(true);
    setErr(null);
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      project: form.project.trim() || 'default',
      mode: form.mode,
    };
    if (form.mode === 'cluster') body.nodes = parseNodesText(form.nodesText);
    else { body.host = form.host.trim(); body.port = Number(form.port); }
    // Only send password when typed (edit keeps the stored secret).
    if (form.password) body.password = form.password;
    try {
      if (editingId) {
        const next = await mutateRedisConnection('PUT', { id: editingId, ...body });
        onSaved(next, editingId);
      } else {
        const next = await mutateRedisConnection('POST', body);
        onSaved(next); // parent picks the newly-added id
        setForm({ ...EMPTY_FORM });
        setTest(null);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      onBusy(false);
    }
  }, [form, editingId, onBusy, onSaved]);

  const hasEndpoint =
    form.mode === 'cluster' ? parseNodesText(form.nodesText).length > 0 : !!form.host.trim();
  const canSubmit = !busy && !!form.name.trim() && hasEndpoint;
  const canTest = !testing && !busy && hasEndpoint;

  return (
    <>
      <div className="redis-form">
        <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Tên (vd: crm-cache)" disabled={busy} style={fInput} />
        <input value={form.project} onChange={(e) => set('project', e.target.value)} placeholder="Dự án (vd: vn / core)" disabled={busy} style={fInput} />
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)' }}>
          Loại
          <select value={form.mode} onChange={(e) => set('mode', e.target.value as RedisMode)} disabled={busy} style={{ padding: '6px 8px', fontSize: 12 }}>
            <option value="single">Single</option>
            <option value="cluster">Cluster</option>
          </select>
        </label>
        {form.mode === 'single' ? (
          <>
            <input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="IP / Host (vd: 127.0.0.1)" disabled={busy} style={{ ...fInput, fontFamily: 'var(--mono)' }} />
            <input type="number" value={form.port} onChange={(e) => set('port', e.target.value)} placeholder="Port" disabled={busy} style={{ ...fInput, maxWidth: 100 }} />
          </>
        ) : (
          <textarea
            value={form.nodesText}
            onChange={(e) => set('nodesText', e.target.value)}
            placeholder={'Seed nodes — mỗi dòng 1 host:port\nvd:\n10.0.0.1:6379\n10.0.0.2:6379\n10.0.0.3:6379'}
            disabled={busy}
            rows={3}
            style={{ flex: '1 1 100%', minWidth: 200, fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical' }}
          />
        )}
        <input
          type="password"
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
          placeholder={editingId ? 'Password (để trống = giữ nguyên)' : 'Password (tuỳ chọn)'}
          disabled={busy}
          style={fInput}
        />
      </div>

      {test?.status === 'ok' && (
        <div className="small" style={{ color: 'var(--ok)', marginTop: 8 }}>✓ Kết nối OK ({test.latencyMs}ms)</div>
      )}
      {test?.status === 'err' && (
        <pre className="code" style={{ color: 'var(--err)', marginTop: 8, marginBottom: 0 }}>✕ {test.message}</pre>
      )}
      {err && <pre className="code" style={{ color: 'var(--err)', marginTop: 8, marginBottom: 0 }}>{err}</pre>}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="ghost sm" onClick={runTest} disabled={!canTest} title="Thử kết nối với thông tin đang nhập">
          {testing ? <span className="spinner" aria-hidden /> : '⚡'} Test
        </button>
        <button className="sm" onClick={submit} disabled={!canSubmit}>
          {busy ? '…' : editingId ? 'Lưu' : '+ Lưu'}
        </button>
      </div>
    </>
  );
}

// ── Add-connection panel (left rail "+ Thêm") ──────────────────────────────────────

interface ConnectionManagerProps {
  connections: PublicRedisConnection[];
  onChanged: (next: PublicRedisConnection[], preferId?: string) => void;
  onDone: () => void;
}

/** Compact add-new panel — just the form (edit/delete now live on each row's ⋯ menu). */
function ConnectionManager({ connections, onChanged, onDone }: ConnectionManagerProps) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--border, rgba(127,127,127,.2))', paddingTop: 12 }}>
      <div className="small" style={{ color: 'var(--muted)', margin: '0 0 8px' }}>
        Thêm kết nối Redis — lưu ở{' '}
        <code className="small">.redisconnections.json</code> (đã gitignore, chỉ trên máy này).
      </div>
      <ConnectionForm
        busy={busy}
        onBusy={setBusy}
        onSaved={(next) => {
          const added = next.find((c) => !connections.some((q) => q.id === c.id));
          onChanged(next, added?.id);
          onDone();
        }}
      />
    </div>
  );
}

// ── Edit-connection modal (from a row's ⋯ → Sửa) ───────────────────────────────────

interface EditConnectionModalProps {
  conn: PublicRedisConnection;
  connections: PublicRedisConnection[];
  onCancel: () => void;
  onSaved: (next: PublicRedisConnection[]) => void;
}

/** Small centered modal to edit ONE connection — no list, no other clutter. */
function EditConnectionModal({ conn, onCancel, onSaved }: EditConnectionModalProps) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(460px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>
            Sửa kết nối <span className="small" style={{ color: 'var(--muted)' }}>· {conn.name}</span>
          </h3>
          <button className="ghost sm" onClick={onCancel} disabled={busy}>✕</button>
        </div>
        <ConnectionForm
          initial={conn}
          editingId={conn.id}
          busy={busy}
          onBusy={setBusy}
          onSaved={(next) => onSaved(next)}
        />
      </div>
    </div>
  );
}

const fInput: React.CSSProperties = { flex: '1 1 150px', minWidth: 120, fontSize: 12 };
