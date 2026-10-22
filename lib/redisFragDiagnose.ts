// Server-only: phân tích phân mảnh bộ nhớ Redis — phần GOM SỐ LIỆU.
//
// Mọi Redis ở đây là production đang chạy, nên luồng này CHỈ ĐỌC và chỉ dùng lệnh O(1):
//   • INFO theo từng section (server / memory / stats / persistence) — không INFO all,
//     không commandstats / keyspace.
//   • CONFIG GET đúng tên từng tham số activedefrag (không glob).
//   • INFO stats đọc hai lần cách SAMPLE_SEC giây để biết activedefrag có đang dời
//     object không (active_defrag_hits tăng bao nhiêu).
// KHÔNG SCAN, không MEMORY USAGE / MEMORY MALLOC-STATS / MEMORY DOCTOR, không đổi
// cấu hình, không chạy MEMORY PURGE — lệnh sửa chỉ được đề xuất để người dùng tự chạy.
// Mỗi node có timeout riêng: node treo / chậm thì bỏ qua và báo, không kéo cả lần
// phân tích, cũng không xếp thêm lệnh lên node đó.
// Luật biến số liệu thành kết luận nằm ở lib/redisFragRules (thuần, kiểm được).

import type Redis from 'ioredis';
import type { RedisConnection } from '@/lib/redisConnections';
import { parseInfo } from '@/lib/redisClient';
import { masters } from '@/lib/redisDiagnose';
import { analyzeRedisFrag, type FragNode, type RedisFragDiagnosis } from '@/lib/redisFragRules';

const SAMPLE_SEC = 3;
const NODE_TIMEOUT_MS = 5_000;
const DEFRAG_PARAMS = ['activedefrag', 'active-defrag-ignore-bytes', 'active-defrag-threshold-lower', 'active-defrag-cycle-max'];

const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([
  p,
  new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: quá ${NODE_TIMEOUT_MS / 1000}s không trả lời`)), NODE_TIMEOUT_MS)),
]);

const num = (v: string | undefined): number | null => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

async function sections(n: Redis, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // Từng section một: Redis < 7 không nhận nhiều section trong một lệnh INFO.
  for (const s of names) Object.assign(out, parseInfo(await n.info(s)));
  return out;
}

async function defragConfig(n: Redis): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of DEFRAG_PARAMS) {
    const r = (await n.config('GET', p)) as unknown as string[];
    if (r?.length >= 2) out[r[0]] = String(r[1]);
  }
  return out;
}

const addrOf = (n: Redis) => `${n.options.host}:${n.options.port}`;

export async function diagnoseFragmentation(conn: RedisConnection): Promise<RedisFragDiagnosis> {
  const nodes = await masters(conn);
  const skipped: { addr: string; error: string }[] = [];
  let configError: string | undefined;

  // Lần đọc 1: đủ các section cần cho phân tích.
  const first = await Promise.all(nodes.map(async (n) => {
    try {
      const info = await withTimeout(sections(n, ['server', 'memory', 'stats', 'persistence']), addrOf(n));
      let cfg: Record<string, string> | null = null;
      try {
        cfg = await withTimeout(defragConfig(n), `${addrOf(n)} CONFIG GET`);
      } catch (e) {
        configError ??= (e as Error).message;
      }
      return { n, info, cfg, at: Date.now() };
    } catch (e) {
      skipped.push({ addr: addrOf(n), error: (e as Error).message });
      return null;
    }
  }));
  const ok = first.filter((x): x is NonNullable<typeof x> => x !== null);
  if (!ok.length) throw new Error(`Không node nào trả lời: ${skipped.map((s) => s.error).join('; ')}`);

  // Lần đọc 2 (chỉ INFO stats): activedefrag có đang dời object không.
  await new Promise((r) => setTimeout(r, SAMPLE_SEC * 1000));
  const hitsRate = new Map<Redis, number | null>();
  await Promise.all(ok.map(async (x) => {
    try {
      const s = parseInfo(await withTimeout(x.n.info('stats'), addrOf(x.n)));
      const a = num(x.info.active_defrag_hits);
      const b = num(s.active_defrag_hits);
      hitsRate.set(x.n, a !== null && b !== null && b >= a ? (b - a) / Math.max(0.001, (Date.now() - x.at) / 1000) : null);
    } catch {
      hitsRate.set(x.n, null);
    }
  }));

  const facts: FragNode[] = ok.map(({ n, info: i, cfg }) => {
    const used = num(i.used_memory) ?? 0;
    const rss = num(i.used_memory_rss) ?? 0;
    const cow = [num(i.rdb_last_cow_size), num(i.aof_last_cow_size)].filter((x): x is number => x !== null);
    return {
      addr: addrOf(n),
      version: i.redis_version ?? '?',
      allocator: i.mem_allocator ?? '?',
      used,
      rss,
      peak: num(i.used_memory_peak) ?? used,
      maxmemory: num(i.maxmemory) ?? 0,
      system: num(i.total_system_memory) ?? 0,
      ratio: num(i.mem_fragmentation_ratio),
      fragBytes: num(i.mem_fragmentation_bytes),
      allocFragRatio: num(i.allocator_frag_ratio),
      allocFragBytes: num(i.allocator_frag_bytes),
      allocRssRatio: num(i.allocator_rss_ratio),
      allocRssBytes: num(i.allocator_rss_bytes),
      rssOverheadRatio: num(i.rss_overhead_ratio),
      rssOverheadBytes: num(i.rss_overhead_bytes),
      lazyfreePending: num(i.lazyfree_pending_objects) ?? 0,
      forking: i.rdb_bgsave_in_progress === '1' || i.aof_rewrite_in_progress === '1',
      lastCowBytes: cow.length ? Math.max(...cow) : null,
      defrag: {
        enabled: cfg?.activedefrag !== undefined ? cfg.activedefrag === 'yes' : null,
        running: (num(i.active_defrag_running) ?? 0) > 0,
        hitsPerSec: hitsRate.get(n) ?? null,
        ignoreBytes: num(cfg?.['active-defrag-ignore-bytes']),
        thresholdLowerPct: num(cfg?.['active-defrag-threshold-lower']),
        cycleMax: num(cfg?.['active-defrag-cycle-max']),
      },
    };
  });

  return analyzeRedisFrag({ nodes: facts, configError, sampleSec: SAMPLE_SEC, skipped });
}
