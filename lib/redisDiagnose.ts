// Server-only: phân tích hit rate thấp của Redis — phần GOM SỐ LIỆU.
//
// Redis không ghi lại key nào bị miss, chỉ có tổng keyspace_misses. Cách bắt
// đúng tên key là sự kiện keymiss (Redis ≥ 6.0): bật TẠM cờ "Em" của
// notify-keyspace-events, PSUBSCRIBE __keyevent@*__:keymiss trong vài giây,
// rồi TRẢ LẠI cờ cũ trong finally — kể cả khi lỗi giữa chừng. Đây là thay đổi
// cấu hình server duy nhất; UI hỏi xác nhận trước khi chạy. Không đọc giá trị
// key nào, chỉ tên key bị miss.
//
// Sau cửa sổ bắt:
//   • EXISTS lại vài key vừa miss — có rồi = được nạp lại sau miss (cache-aside chạy).
//   • SCAN có giới hạn (SCAN_BUDGET key, không bao giờ KEYS) đếm key CÙNG DẠNG
//     đang có + lấy mẫu TTL — để phân biệt "không bao giờ được ghi" với "TTL ngắn".
//   • INFO trước/sau: hit rate hiện tại, evict, hết hạn trong cửa sổ.
// Luật biến số liệu thành kết luận nằm ở lib/redisDiagnoseRules (thuần, kiểm được).

import Redis, { Cluster } from 'ioredis';
import type { RedisConnection } from '@/lib/redisConnections';
import { getClient, isCluster, parseInfo } from '@/lib/redisClient';
import { analyzeRedisMisses, keyPattern, type MissPattern, type RedisMissDiagnosis, type RedisMissFacts } from '@/lib/redisDiagnoseRules';

const MIN_SEC = 5;
const MAX_SEC = 60;
/** Trần số key khác nhau theo dõi (toàn phiên) — chặn bộ nhớ khi miss rất đa dạng. */
const MAX_DISTINCT = 20_000;
/** Số dạng key được kiểm lại (EXISTS / SCAN / TTL). */
const TOP_PATTERNS = 10;
const RECHECK_PER_PATTERN = 20;
const TTL_SAMPLE_PER_PATTERN = 30;
/** Tổng số key SCAN được xét — đủ để ước lượng, không quét hết keyspace lớn. */
const SCAN_BUDGET = 200_000;
const SCAN_COUNT = 1000;
const CHANNEL = '__keyevent@*__:keymiss';

/** Một phiên một kết nối: hai phiên chồng nhau sẽ "trả lại" nhầm cờ của nhau. */
const running = new Set<string>();

interface Totals { hits: number; misses: number; evicted: number; expired: number; used: number; max: number; policy: string | null; version: string }

async function masters(conn: RedisConnection): Promise<Redis[]> {
  const base = getClient(conn, 0);
  if (isCluster(conn) && base instanceof Cluster) {
    if (base.status !== 'ready') await base.ping();
    return base.nodes('master');
  }
  if ((base as Redis).status !== 'ready') await (base as Redis).ping();
  return [base as Redis];
}

async function totals(nodes: Redis[]): Promise<Totals> {
  const infos = await Promise.all(nodes.map(async (n) => parseInfo(await n.info())));
  const sum = (k: string) => infos.reduce((a, i) => a + (Number(i[k]) || 0), 0);
  return {
    hits: sum('keyspace_hits'),
    misses: sum('keyspace_misses'),
    evicted: sum('evicted_keys'),
    expired: sum('expired_keys'),
    used: sum('used_memory'),
    max: sum('maxmemory'),
    policy: infos[0]?.maxmemory_policy ?? null,
    version: infos[0]?.redis_version ?? '?',
  };
}

/** Cờ cũ + E (keyevent) + m (key-miss), không trùng. */
const withMissFlags = (flags: string): string => {
  let out = flags;
  for (const c of ['E', 'm']) if (!out.includes(c)) out += c;
  return out;
};

interface Agg {
  db: number;
  pattern: string;
  glob: string;
  misses: number;
  keys: Map<string, number>;
  overflow: boolean;
}

export async function diagnoseMisses(conn: RedisConnection, seconds: number): Promise<RedisMissDiagnosis> {
  if (running.has(conn.id)) throw new Error('Đang có một phiên phân tích khác trên kết nối này — chờ nó xong (tự trả lại cấu hình) rồi chạy lại.');
  running.add(conn.id);
  try {
    return await run(conn, Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(Number(seconds) || 10))));
  } finally {
    running.delete(conn.id);
  }
}

async function run(conn: RedisConnection, durationSec: number): Promise<RedisMissDiagnosis> {
  const nodes = await masters(conn);
  const before = await totals(nodes);
  const t0 = Date.now();

  // ── Bắt sự kiện keymiss ──
  const aggs = new Map<string, Agg>();
  const patternOf = new Map<string, { pattern: string; glob: string }>();
  let captured = 0;
  let distinctCapped = false;
  const record = (channel: string, key: string) => {
    captured++;
    const db = Number(/@(\d+)__/.exec(channel)?.[1] ?? 0);
    let pg = patternOf.get(key);
    if (!pg) {
      pg = keyPattern(key);
      if (patternOf.size < MAX_DISTINCT) patternOf.set(key, pg);
      else distinctCapped = true;
    }
    const id = `${db}|${pg.pattern}`;
    let a = aggs.get(id);
    if (!a) { a = { db, pattern: pg.pattern, glob: pg.glob, misses: 0, keys: new Map(), overflow: false }; aggs.set(id, a); }
    a.misses++;
    if (a.keys.has(key) || a.keys.size < 2000) a.keys.set(key, (a.keys.get(key) ?? 0) + 1);
    else a.overflow = true;
  };

  const major = Number(before.version.split('.')[0]) || 0;
  let capture: RedisMissFacts['capture'] = { ok: true };
  let originalFlags: string | null = null;
  let restoreError: string | undefined;
  if (major < 6) {
    capture = { ok: false, reason: 'version' };
    await sleep(durationSec * 1000);
  } else {
    const changed: { node: Redis; orig: string }[] = [];
    const subs: Redis[] = [];
    let configErr: string | null = null;
    let subErr: string | null = null;
    try {
      for (const n of nodes) {
        try {
          const r = (await n.config('GET', 'notify-keyspace-events')) as unknown as string[];
          const orig = String(r?.[1] ?? '');
          originalFlags ??= orig;
          const next = withMissFlags(orig);
          if (next !== orig) {
            await n.config('SET', 'notify-keyspace-events', next);
            changed.push({ node: n, orig });
          }
        } catch (e) {
          // CONFIG bị khoá (Redis managed) — vẫn nghe thử: có thể cờ đã bật sẵn phía server.
          configErr = (e as Error).message;
        }
      }
      for (const n of nodes) {
        const sub = n.duplicate();
        sub.on('error', () => {});
        subs.push(sub);
        sub.on('pmessage', (_p: string, channel: string, key: string) => record(channel, key));
        // ACL có thể chặn PSUBSCRIBE — vẫn chạy hết cửa sổ để có số liệu INFO, báo lý do sau.
        await sub.psubscribe(CHANNEL).catch((e: Error) => { subErr = e.message; });
      }
      await sleep(Math.max(0, t0 + durationSec * 1000 - Date.now()));
    } finally {
      for (const s of subs) s.disconnect();
      for (const { node, orig } of changed) {
        try {
          await node.config('SET', 'notify-keyspace-events', orig);
        } catch (e) {
          restoreError = `${node.options.host}:${node.options.port} — ${(e as Error).message}`;
        }
      }
    }
    if (captured === 0 && configErr) capture = { ok: false, reason: 'config', detail: configErr };
    else if (captured === 0 && subErr) capture = { ok: false, reason: 'noEvents', detail: `PSUBSCRIBE lỗi: ${subErr}` };
  }

  const after = await totals(nodes);
  const window = after.hits >= before.hits && after.misses >= before.misses
    ? { hits: after.hits - before.hits, misses: after.misses - before.misses, sec: Math.round((Date.now() - t0) / 1000) }
    : null;
  if (capture.ok && captured === 0 && (window?.misses ?? 0) > 0) capture = { ok: false, reason: 'noEvents' };

  // ── Kiểm lại các dạng nặng nhất ──
  const top = [...aggs.values()].sort((a, b) => b.misses - a.misses).slice(0, TOP_PATTERNS);
  const refill = new Map<Agg, { refilled: number; checked: number }>();
  for (const a of top) {
    const keys = [...a.keys.entries()].sort((x, y) => y[1] - x[1]).slice(0, RECHECK_PER_PATTERN).map(([k]) => k);
    try {
      const client = getClient(conn, a.db);
      const res = await Promise.all(keys.map((k) => client.exists(k)));
      refill.set(a, { refilled: res.filter((x) => x > 0).length, checked: keys.length });
    } catch {
      refill.set(a, { refilled: 0, checked: 0 });
    }
  }

  // SCAN có giới hạn: đếm key cùng dạng đang có + mẫu TTL.
  const want = new Map<string, Agg>(top.map((a) => [`${a.db}|${a.pattern}`, a]));
  const existing = new Map<Agg, { count: number; ttlKeys: string[] }>(top.map((a) => [a, { count: 0, ttlKeys: [] }]));
  let scanned = 0;
  let dbsize = 0;
  let scanOk = top.length > 0;
  const dbs = [...new Set(top.map((a) => a.db))];
  try {
    for (const db of dbs) {
      const scanners: Redis[] = isCluster(conn) ? nodes : [getClient(conn, db) as Redis];
      for (const s of scanners) {
        dbsize += await s.dbsize();
        let cursor = '0';
        do {
          const [next, keys] = await s.scan(cursor, 'COUNT', SCAN_COUNT);
          cursor = next;
          scanned += keys.length;
          for (const k of keys) {
            const a = want.get(`${db}|${keyPattern(k).pattern}`);
            if (!a) continue;
            const e = existing.get(a)!;
            e.count++;
            if (e.ttlKeys.length < TTL_SAMPLE_PER_PATTERN) e.ttlKeys.push(k);
          }
        } while (cursor !== '0' && scanned < SCAN_BUDGET);
        if (scanned >= SCAN_BUDGET) break;
      }
    }
  } catch {
    scanOk = false;
  }

  const ttlOf = new Map<Agg, MissPattern['ttl']>();
  for (const a of top) {
    const keys = existing.get(a)!.ttlKeys;
    if (!scanOk || !keys.length) { ttlOf.set(a, null); continue; }
    try {
      const client = getClient(conn, a.db);
      const ttls = await Promise.all(keys.map((k) => client.ttl(k)));
      const pos = ttls.filter((t) => t >= 0).sort((x, y) => x - y);
      ttlOf.set(a, {
        withTtl: pos.length,
        noTtl: ttls.filter((t) => t === -1).length,
        medianSec: pos.length ? pos[Math.floor(pos.length / 2)] : null,
        minSec: pos.length ? pos[0] : null,
      });
    } catch {
      ttlOf.set(a, null);
    }
  }

  const patterns: MissPattern[] = top.map((a) => {
    const [topKey, topKeyMisses] = [...a.keys.entries()].sort((x, y) => y[1] - x[1])[0] ?? ['', 0];
    const r = refill.get(a) ?? { refilled: 0, checked: 0 };
    return {
      db: a.db,
      pattern: a.pattern,
      glob: a.glob,
      misses: a.misses,
      distinct: a.keys.size,
      topKey,
      topKeyMisses,
      samples: [...a.keys.keys()].slice(0, 5),
      refilled: r.refilled,
      checked: r.checked,
      existing: scanOk ? existing.get(a)!.count : null,
      ttl: ttlOf.get(a) ?? null,
    };
  });

  const facts: RedisMissFacts = {
    version: before.version,
    nodes: nodes.length,
    capture,
    originalFlags,
    durationSec,
    cumulative: { hits: before.hits, misses: before.misses },
    window,
    captured,
    distinctCapped: distinctCapped || top.some((a) => a.overflow),
    patterns,
    evicted: { total: after.evicted, window: Math.max(0, after.evicted - before.evicted) },
    expired: { total: after.expired, window: Math.max(0, after.expired - before.expired) },
    memory: { used: after.used, max: after.max, policy: after.policy },
    scan: scanOk ? { scanned, dbsize } : null,
    restoreError,
  };
  return analyzeRedisMisses(facts);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
