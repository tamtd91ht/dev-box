// Server-only: phân tích số client kết nối Redis — phần GOM SỐ LIỆU.
//
// Mọi Redis ở đây là production đang chạy, nên chia hai mức:
//
// CƠ BẢN (luôn chạy) — chỉ lệnh O(1):
//   • INFO từng section (server, clients, stats, cpu), đọc lại clients + stats + cpu sau
//     SAMPLE_SEC giây → kết nối mới mỗi giây, số bị từ chối trong cửa sổ, CPU luồng chính.
//   • CONFIG GET đúng tên: maxclients, timeout, tcp-keepalive.
//
// DANH SÁCH CLIENT (người dùng bấm) — CLIENT LIST là O(số client) trên luồng chính:
//   • Chỉ chạy khi node ≤ LIST_MAX client VÀ CPU luồng chính < LIST_MAX_CPU; ngoài ra từ
//     chối và nói rõ lý do (đề xuất tự chạy lúc thấp điểm).
//   • Cụm: chạy LẦN LƯỢT từng node, nghỉ LIST_PAUSE_MS giữa các node.
//   • Gom ngay theo máy nguồn / tên client / thời gian rảnh / tuổi — không giữ từng dòng,
//     không trả địa chỉ từng kết nối về trình duyệt.
// Mỗi node có hạn NODE_TIMEOUT_MS: node treo thì bỏ qua và báo.
// Luật biến số liệu thành kết luận nằm ở lib/redisClientsRules (thuần, kiểm được).

import type Redis from 'ioredis';
import type { RedisConnection } from '@/lib/redisConnections';
import { masters, parseInfo } from '@/lib/redisClient';
import {
  IDLE_LONG_SEC, YOUNG_SEC, analyzeRedisClients,
  type ClientGroup, type ClientList, type ClientsNode, type RedisClientsDiagnosis,
} from '@/lib/redisClientsRules';

const SAMPLE_SEC = 3;
const NODE_TIMEOUT_MS = 5_000;
const LIST_MAX = 5_000;
const LIST_MAX_CPU = 0.8;
const LIST_PAUSE_MS = 200;
const TOP_GROUPS = 15;

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

const cpuOf = (i: Record<string, string>) => (i.used_cpu_user_main_thread !== undefined
  ? (num(i.used_cpu_user_main_thread) ?? 0) + (num(i.used_cpu_sys_main_thread) ?? 0)
  : (num(i.used_cpu_user) ?? 0) + (num(i.used_cpu_sys) ?? 0));

interface Read1 { n: Redis; i: Record<string, string>; cfg: Record<string, string> | null; at: number }

export async function diagnoseClients(conn: RedisConnection, opts: { list?: boolean } = {}): Promise<RedisClientsDiagnosis> {
  const nodes = await masters(conn);
  const skipped: { addr: string; error: string }[] = [];
  let configError: string | undefined;

  const first = (await Promise.all(nodes.map(async (n): Promise<Read1 | null> => {
    try {
      const i = await withTimeout(sections(n, ['server', 'clients', 'stats', 'cpu']), addrOf(n));
      let cfg: Record<string, string> | null = {};
      try {
        for (const p of ['maxclients', 'timeout', 'tcp-keepalive']) {
          const r = (await withTimeout(n.config('GET', p), `${addrOf(n)} CONFIG GET`)) as unknown as string[];
          if (r?.length >= 2) cfg[r[0]] = String(r[1]);
        }
      } catch (e) {
        configError ??= (e as Error).message;
        cfg = null;
      }
      return { n, i, cfg, at: Date.now() };
    } catch (e) {
      skipped.push({ addr: addrOf(n), error: (e as Error).message });
      return null;
    }
  }))).filter((x): x is Read1 => x !== null);
  if (!first.length) throw new Error(`Không node nào trả lời: ${skipped.map((s) => s.error).join('; ')}`);

  await sleep(SAMPLE_SEC * 1000);
  const second = new Map<Redis, Record<string, string> | null>();
  await Promise.all(first.map(async (x) => {
    second.set(x.n, await withTimeout(sections(x.n, ['clients', 'stats', 'cpu']), addrOf(x.n)).catch(() => null));
  }));
  const delta = (x: Read1, k: string) => {
    const a = num(x.i[k]);
    const b = num(second.get(x.n)?.[k]);
    return a !== null && b !== null && b >= a ? b - a : null;
  };
  const secOf = (x: Read1) => Math.max(0.001, (Date.now() - x.at) / 1000);

  const facts: ClientsNode[] = first.map((x) => {
    const i = second.get(x.n) ?? x.i;
    const conns = delta(x, 'total_connections_received');
    return {
      addr: addrOf(x.n),
      version: x.i.redis_version ?? '?',
      clients: num(i.connected_clients) ?? 0,
      maxclients: num(x.cfg?.maxclients) ?? num(x.i.maxclients),
      blocked: num(i.blocked_clients) ?? 0,
      pubsub: num(i.pubsub_clients),
      newPerSec: conns === null ? null : conns / secOf(x),
      rejectedTotal: num(i.rejected_connections) ?? 0,
      rejectedWindow: delta(x, 'rejected_connections'),
      timeout: num(x.cfg?.timeout),
      keepalive: num(x.cfg?.['tcp-keepalive']),
    };
  });

  let list: ClientList | null = null;
  let listRefused: string | undefined;
  if (opts.list) {
    const busy = first.map((x) => {
      const b = second.get(x.n);
      return { x, cpu: b ? (cpuOf(b) - cpuOf(x.i)) / secOf(x) : 0, clients: num((b ?? x.i).connected_clients) ?? 0 };
    });
    const tooMany = busy.find((b) => b.clients > LIST_MAX);
    const hot = busy.find((b) => b.cpu >= LIST_MAX_CPU);
    if (tooMany) listRefused = `${addrOf(tooMany.x.n)} có ${tooMany.clients.toLocaleString('vi-VN')} client (> ${LIST_MAX.toLocaleString('vi-VN')}) — CLIENT LIST sẽ chiếm luồng chính quá lâu`;
    else if (hot) listRefused = `CPU luồng chính ${addrOf(hot.x.n)} đang ${Math.round(hot.cpu * 100)}% — không thêm tải lúc này`;
    else list = await listClients(first.map((x) => x.n));
  }

  return analyzeRedisClients({ nodes: facts, list, listRefused, configError, skipped, sampleSec: SAMPLE_SEC });
}

interface Acc { count: number; idle: number; young: number; pubsub: number; blocked: number; cmds: Map<string, number> }

async function listClients(nodes: Redis[]): Promise<ClientList> {
  const bySource = new Map<string, Acc>();
  const byName = new Map<string, Acc>();
  const idle = { lt60: 0, lt600: 0, lt3600: 0, ge3600: 0 };
  let total = 0;
  let young = 0;
  let pubsub = 0;
  let blocked = 0;
  let durationMs = 0;
  const add = (m: Map<string, Acc>, key: string, c: { idle: number; age: number; ps: boolean; bl: boolean; cmd: string }) => {
    let a = m.get(key);
    if (!a) { a = { count: 0, idle: 0, young: 0, pubsub: 0, blocked: 0, cmds: new Map() }; m.set(key, a); }
    a.count++;
    if (c.idle >= IDLE_LONG_SEC) a.idle++;
    if (c.age < YOUNG_SEC) a.young++;
    if (c.ps) a.pubsub++;
    if (c.bl) a.blocked++;
    a.cmds.set(c.cmd, (a.cmds.get(c.cmd) ?? 0) + 1);
  };

  for (const [idx, n] of nodes.entries()) {
    if (idx > 0) await sleep(LIST_PAUSE_MS);
    const s = performance.now();
    const raw = String(await withTimeout(n.client('LIST') as Promise<unknown>, `${addrOf(n)} CLIENT LIST`));
    durationMs = Math.max(durationMs, performance.now() - s);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const f: Record<string, string> = {};
      for (const kv of line.trim().split(' ')) {
        const i = kv.indexOf('=');
        if (i > 0) f[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const flags = f.flags ?? '';
      if (/[SM]/.test(flags)) continue; // replica / master link — không phải client ứng dụng
      const c = {
        idle: num(f.idle) ?? 0,
        age: num(f.age) ?? 0,
        ps: flags.includes('P') || (num(f.sub) ?? 0) + (num(f.psub) ?? 0) + (num(f.ssub) ?? 0) > 0,
        bl: flags.includes('b'),
        cmd: f.cmd ?? '?',
      };
      total++;
      if (c.age < YOUNG_SEC) young++;
      if (c.ps) pubsub++;
      if (c.bl) blocked++;
      if (c.idle < 60) idle.lt60++;
      else if (c.idle < 600) idle.lt600++;
      else if (c.idle < 3600) idle.lt3600++;
      else idle.ge3600++;
      // Máy nguồn = IP (bỏ cổng); IPv6 dạng [::1]:port hoặc ::1:port.
      const addr = f.addr ?? '?';
      add(bySource, addr.replace(/:\d+$/, ''), c);
      add(byName, f.name || f['lib-name'] || '(không đặt tên)', c);
    }
  }

  const groups = (m: Map<string, Acc>): ClientGroup[] => [...m.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, TOP_GROUPS)
    .map(([key, a]) => ({
      key, count: a.count, idle: a.idle, young: a.young, pubsub: a.pubsub, blocked: a.blocked,
      topCmd: [...a.cmds.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '?',
    }));

  return { total, bySource: groups(bySource), byName: groups(byName), idle, young, pubsub, blocked, durationMs: Math.round(durationMs) };
}
