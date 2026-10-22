// Server-only: phân tích RAM đã dùng của Redis — phần GOM SỐ LIỆU.
//
// Mọi Redis ở đây là production đang chạy, nên chia hai mức:
//
// CƠ BẢN (luôn chạy) — chỉ lệnh O(1) / O(số db):
//   • INFO từng section (server, memory, stats, persistence, keyspace, cpu, errorstats),
//     đọc stats + cpu lần hai sau SAMPLE_SEC giây để có evict / hết hạn mỗi giây và CPU.
//   • MEMORY STATS (cùng chi phí với INFO memory) — bảng băm key, bộ đệm client…
//   • CONFIG GET đúng tên: maxmemory-policy, save, appendonly.
//   • CLIENT LIST (O(số client)) CHỈ khi bộ đệm client ≥ 64 MB VÀ ≤ CLIENT_LIST_MAX client —
//     để chỉ ra client nào giữ bộ đệm; nhiều client hơn thì bỏ, đề xuất tự chạy lúc thấp điểm.
//
// LẤY MẪU KEY (người dùng bấm) — đo dạng key nào chiếm RAM:
//   • Bỏ qua nếu CPU luồng chính ≥ SAMPLE_MAX_CPU (đo ở trên).
//   • SCAN COUNT nhỏ, nghỉ giữa các lượt, tối đa SCAN_BUDGET key (không bao giờ KEYS).
//   • MEMORY USAGE … SAMPLES 5 + TTL trên tối đa MEASURE_MAX key rải đều, pipeline theo
//     lô BATCH, nghỉ giữa các lô; lô nào chậm hơn RTT + SLOW_BATCH_MS thì DỪNG ngay
//     (dấu hiệu Redis đang bận hoặc gặp key khổng lồ) và dùng phần đã có.
//   • Trần thời gian SAMPLE_TIME_MS cho toàn bộ phần lấy mẫu. Không đọc giá trị key nào.
// Mỗi node có hạn NODE_TIMEOUT_MS: node treo thì bỏ qua và báo.
// Luật biến số liệu thành kết luận nằm ở lib/redisMemRules (thuần, kiểm được).

import type Redis from 'ioredis';
import type { RedisConnection } from '@/lib/redisConnections';
import { getClient, isCluster, masters, parseInfo } from '@/lib/redisClient';
import { keyPattern } from '@/lib/redisDiagnoseRules';
import { analyzeRedisMem, type MemNode, type MemPattern, type MemSample, type MemTopClient, type RedisMemDiagnosis } from '@/lib/redisMemRules';

const SAMPLE_SEC = 3;
const NODE_TIMEOUT_MS = 5_000;
const CLIENT_LIST_MIN_BYTES = 64 * 1024 * 1024;
const CLIENT_LIST_MAX = 1_000;
const SAMPLE_MAX_CPU = 0.8;
const SCAN_BUDGET = 50_000;
const SCAN_COUNT = 200;
const SCAN_PAUSE_MS = 5;
const MEASURE_MAX = 2_000;
const BATCH = 50;
const BATCH_PAUSE_MS = 10;
const SLOW_BATCH_MS = 50;
const SAMPLE_TIME_MS = 20_000;
const TOP_KEYS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([
  p,
  new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: quá ${NODE_TIMEOUT_MS / 1000}s không trả lời`)), NODE_TIMEOUT_MS)),
]);
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const addrOf = (n: Redis) => `${n.options.host}:${n.options.port}`;

async function sections(n: Redis, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // Từng section một: Redis < 7 không nhận nhiều section trong một lệnh INFO.
  for (const s of names) Object.assign(out, parseInfo(await n.info(s)));
  return out;
}

/** MEMORY STATS trả mảng phẳng key/value lồng nhau (db.0 → [...]) → map phẳng 'db.0.overhead.hashtable.main'. */
function flatStats(arr: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i + 1 < arr.length; i += 2) {
    const k = `${prefix}${String(arr[i])}`;
    const v = arr[i + 1];
    if (Array.isArray(v)) flatStats(v, `${k}.`, out);
    else if (num(v) !== null) out[k] = Number(v);
  }
  return out;
}

const cpuOf = (i: Record<string, string>) => (i.used_cpu_user_main_thread !== undefined
  ? (num(i.used_cpu_user_main_thread) ?? 0) + (num(i.used_cpu_sys_main_thread) ?? 0)
  : (num(i.used_cpu_user) ?? 0) + (num(i.used_cpu_sys) ?? 0));

/** db → số key / key có TTL từ INFO keyspace (`db0:keys=1,expires=0,avg_ttl=0`). */
function keyspace(i: Record<string, string>): { db: number; keys: number; expires: number }[] {
  return Object.entries(i).flatMap(([k, v]) => {
    const m = /^db(\d+)$/.exec(k);
    if (!m) return [];
    const f = Object.fromEntries(v.split(',').map((x) => x.split('=') as [string, string]));
    return [{ db: Number(m[1]), keys: num(f.keys) ?? 0, expires: num(f.expires) ?? 0 }];
  });
}

function parseClients(raw: string): MemTopClient[] {
  return raw.split('\n').filter(Boolean).map((line) => {
    const f = Object.fromEntries(line.trim().split(' ').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }));
    const omem = num(f.omem) ?? 0;
    return {
      addr: f.addr ?? '?', name: f.name ?? '', cmd: f.cmd ?? '?', omem,
      bytes: num(f['tot-mem']) ?? omem + (num(f.qbuf) ?? 0),
    };
  }).sort((a, b) => b.bytes - a.bytes).slice(0, 5);
}

interface Read1 { n: Redis; i: Record<string, string>; ms: Record<string, number> | null; cfg: Record<string, string> | null; top: MemTopClient[] | null; at: number }

export async function diagnoseMemory(
  conn: RedisConnection,
  opts: { sample?: boolean; history?: { at: number; mb: number }[] } = {},
): Promise<RedisMemDiagnosis> {
  const nodes = await masters(conn);
  const skipped: { addr: string; error: string }[] = [];
  let configError: string | undefined;

  // ── Lần đọc 1 ──
  const first = (await Promise.all(nodes.map(async (n): Promise<Read1 | null> => {
    try {
      const i = await withTimeout(sections(n, ['server', 'memory', 'stats', 'persistence', 'keyspace', 'cpu', 'errorstats', 'clients']), addrOf(n));
      const ms = await withTimeout(n.call('MEMORY', 'STATS'), `${addrOf(n)} MEMORY STATS`).then((r) => flatStats(r)).catch(() => null);
      let cfg: Record<string, string> | null = null;
      try {
        cfg = {};
        for (const p of ['maxmemory-policy', 'save', 'appendonly']) {
          const r = (await withTimeout(n.config('GET', p), `${addrOf(n)} CONFIG GET`)) as unknown as string[];
          if (r?.length >= 2) cfg[r[0]] = String(r[1]);
        }
      } catch (e) {
        configError ??= (e as Error).message;
        cfg = null;
      }
      const clientsMem = ms?.['clients.normal'] ?? num(i.mem_clients_normal) ?? 0;
      const top = clientsMem >= CLIENT_LIST_MIN_BYTES && (num(i.connected_clients) ?? Infinity) <= CLIENT_LIST_MAX
        ? await withTimeout(n.client('LIST') as Promise<string>, `${addrOf(n)} CLIENT LIST`).then(parseClients).catch(() => null)
        : null;
      return { n, i, ms, cfg, top, at: Date.now() };
    } catch (e) {
      skipped.push({ addr: addrOf(n), error: (e as Error).message });
      return null;
    }
  }))).filter((x): x is Read1 => x !== null);
  if (!first.length) throw new Error(`Không node nào trả lời: ${skipped.map((s) => s.error).join('; ')}`);

  // ── Lần đọc 2: evict / hết hạn mỗi giây + CPU ──
  await sleep(SAMPLE_SEC * 1000);
  const second = new Map<Redis, Record<string, string> | null>();
  await Promise.all(first.map(async (x) => {
    second.set(x.n, await withTimeout(sections(x.n, ['stats', 'cpu']), addrOf(x.n)).catch(() => null));
  }));
  const rate = (x: Read1, k: string) => {
    const b = second.get(x.n);
    const a0 = num(x.i[k]);
    const b0 = num(b?.[k]);
    return a0 !== null && b0 !== null && b0 >= a0 ? (b0 - a0) / Math.max(0.001, (Date.now() - x.at) / 1000) : null;
  };
  const cpuMax = Math.max(0, ...first.map((x) => {
    const b = second.get(x.n);
    return b ? (cpuOf(b) - cpuOf(x.i)) / Math.max(0.001, (Date.now() - x.at) / 1000) : 0;
  }));

  const memNodes: MemNode[] = first.map((x) => {
    const { i, ms } = x;
    const ks = keyspace(i);
    const dbHash = ms ? Object.entries(ms).filter(([k]) => /^db\.\d+\.overhead\.hashtable\.(main|expires)$/.test(k)).reduce((a, [, v]) => a + v, 0) : null;
    const scripts = ms ? (ms['lua.caches'] ?? 0) + (ms['functions.caches'] ?? 0) : num(i.used_memory_scripts);
    const cow = [num(i.rdb_last_cow_size), num(i.aof_last_cow_size)].filter((v): v is number => v !== null);
    const oom = /count=(\d+)/.exec(i.errorstat_OOM ?? '')?.[1];
    return {
      addr: addrOf(x.n),
      version: i.redis_version ?? '?',
      role: i.role ?? '?',
      used: num(i.used_memory) ?? 0,
      maxmemory: num(i.maxmemory) ?? 0,
      system: num(i.total_system_memory) ?? 0,
      rss: num(i.used_memory_rss) ?? 0,
      peak: num(i.used_memory_peak) ?? 0,
      dataset: ms?.['dataset.bytes'] ?? num(i.used_memory_dataset),
      parts: {
        clientsNormal: ms?.['clients.normal'] ?? num(i.mem_clients_normal),
        clientsReplicas: ms?.['clients.slaves'] ?? num(i.mem_clients_slaves),
        replBacklog: ms?.['replication.backlog'] ?? num(i.mem_replication_backlog),
        aofBuffer: ms?.['aof.buffer'] ?? num(i.mem_aof_buffer),
        scripts,
        hashtables: dbHash,
      },
      keys: ks.reduce((a, d) => a + d.keys, 0),
      expires: ks.reduce((a, d) => a + d.expires, 0),
      bytesPerKey: ms?.['keys.bytes-per-key'] ?? null,
      clients: num(i.connected_clients) ?? 0,
      policy: x.cfg?.['maxmemory-policy'] ?? i.maxmemory_policy ?? null,
      save: x.cfg ? x.cfg.save ?? null : null,
      aof: x.cfg?.appendonly !== undefined ? x.cfg.appendonly === 'yes' : i.aof_enabled !== undefined ? i.aof_enabled === '1' : null,
      evictedPerSec: rate(x, 'evicted_keys'),
      expiredPerSec: rate(x, 'expired_keys'),
      expiredStalePct: num(i.expired_stale_perc),
      oomErrors: oom !== undefined ? Number(oom) : null,
      lastCowBytes: cow.length ? Math.max(...cow) : null,
      topClients: x.top,
    };
  });

  // ── Lấy mẫu key (tuỳ chọn) ──
  let sample: MemSample | null = null;
  let sampleRefused: string | undefined;
  if (opts.sample) {
    if (cpuMax >= SAMPLE_MAX_CPU) {
      sampleRefused = `CPU luồng chính ${Math.round(cpuMax * 100)}% — không thêm tải quét key lúc này`;
    } else {
      sample = await sampleKeys(conn, first);
    }
  }

  return analyzeRedisMem({
    nodes: memNodes, history: opts.history ?? [], sample, sampleRefused, configError, skipped, sampleSec: SAMPLE_SEC,
  });
}

async function sampleKeys(conn: RedisConnection, first: Read1[]): Promise<MemSample> {
  // Đích quét: cluster → từng master (db 0); single → từng db có key.
  const targets: { client: Redis; db: number; keys: number }[] = isCluster(conn)
    ? first.map((x) => ({ client: x.n, db: 0, keys: keyspace(x.i).reduce((a, d) => a + d.keys, 0) }))
    : keyspace(first[0].i).map((d) => ({ client: getClient(conn, d.db) as Redis, db: d.db, keys: d.keys }));
  const dbsize = targets.reduce((a, t) => a + t.keys, 0);
  const deadline = Date.now() + SAMPLE_TIME_MS;
  const aggs = new Map<string, MemPattern>();
  const measuredKeys: { db: number; key: string; bytes: number; client: Redis }[] = [];
  let scanned = 0;
  let bytes = 0;
  let stopped: string | undefined;

  outer: for (const t of targets) {
    if (!t.keys) continue;
    // Chia ngân sách theo số key của đích, rải đều số key được đo.
    const budget = Math.max(1_000, Math.round((SCAN_BUDGET * t.keys) / Math.max(1, dbsize)));
    const measureQuota = Math.max(50, Math.round((MEASURE_MAX * t.keys) / Math.max(1, dbsize)));
    const stride = Math.max(1, Math.round(Math.min(t.keys, budget) / measureQuota));
    const rtt = await pingMs(t.client);
    let cursor = '0';
    let seen = 0;
    let pending: string[] = [];
    const flush = async (): Promise<boolean> => {
      if (!pending.length) return true;
      const batch = pending;
      pending = [];
      const p = t.client.pipeline();
      for (const k of batch) { p.call('MEMORY', 'USAGE', k, 'SAMPLES', '5'); p.ttl(k); }
      const s = performance.now();
      const res = (await withTimeout(p.exec(), `${addrOf(t.client)} MEMORY USAGE`)) ?? [];
      const took = performance.now() - s;
      batch.forEach((k, j) => {
        const b = num(res[j * 2]?.[1]);
        const ttl = num(res[j * 2 + 1]?.[1]);
        if (b === null) return; // key vừa hết hạn / bị xoá
        bytes += b;
        const pg = keyPattern(k).pattern;
        const id = `${t.db}|${pg}`;
        let a = aggs.get(id);
        if (!a) { a = { db: t.db, pattern: pg, count: 0, bytes: 0, noTtl: 0, maxKey: k, maxBytes: 0 }; aggs.set(id, a); }
        a.count++;
        a.bytes += b;
        if (ttl === -1) a.noTtl++;
        if (b > a.maxBytes) { a.maxBytes = b; a.maxKey = k; }
        measuredKeys.push({ db: t.db, key: k, bytes: b, client: t.client });
      });
      if (took > rtt + SLOW_BATCH_MS) {
        stopped = `một lô ${batch.length} key mất ${Math.round(took)}ms — Redis đang bận hoặc có key rất lớn, dừng để không thêm tải`;
        return false;
      }
      await sleep(BATCH_PAUSE_MS);
      return true;
    };
    try {
      do {
        const [next, keys] = await withTimeout(t.client.scan(cursor, 'COUNT', SCAN_COUNT), `${addrOf(t.client)} SCAN`);
        cursor = next;
        scanned += keys.length;
        for (const k of keys) {
          if (seen++ % stride === 0) pending.push(k);
          if (pending.length >= BATCH && !(await flush())) break outer;
        }
        if (Date.now() > deadline) { stopped = `hết ${SAMPLE_TIME_MS / 1000}s dành cho lấy mẫu`; break; }
        await sleep(SCAN_PAUSE_MS);
      } while (cursor !== '0' && seen < budget);
      if (!(await flush())) break;
    } catch (e) {
      stopped = (e as Error).message;
      break;
    }
    if (stopped) break;
  }

  // Loại (TYPE, O(1)) cho các key lớn nhất trong mẫu.
  const top = measuredKeys.sort((a, b) => b.bytes - a.bytes).slice(0, TOP_KEYS);
  const topKeys = await Promise.all(top.map(async (k) => ({
    db: k.db, key: k.key, bytes: k.bytes,
    type: await withTimeout(k.client.type(k.key), 'TYPE').catch(() => '?'),
  })));

  return { scanned, dbsize, measured: measuredKeys.length, bytes, patterns: [...aggs.values()], topKeys, stopped };
}

async function pingMs(n: Redis): Promise<number> {
  const t: number[] = [];
  for (let i = 0; i < 3; i++) {
    const s = performance.now();
    await withTimeout(n.ping(), `${addrOf(n)} PING`);
    t.push(performance.now() - s);
  }
  return t.sort((a, b) => a - b)[1];
}
