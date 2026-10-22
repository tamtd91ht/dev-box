// Server-only: bảo vệ cờ key-miss (notify-keyspace-events "m") mà phân tích hit rate bật tạm.
//
// Phân tích hit rate (lib/redisDiagnose) là chỗ DUY NHẤT của Monitor ghi vào cấu hình
// Redis production. Nó trả lại cờ cũ trong finally, nhưng vẫn có thể sót khi tiến trình
// chết / mất mạng giữa chừng — cờ bật mãi, mỗi lần miss Redis tốn thêm một chút CPU dù
// không ai nghe. File này lo ba việc:
//
//   • Đánh dấu: trước khi bật cờ, ghi {kết nối, node, giá trị cũ} vào PENDING_FILE; trả lại
//     xong mới xoá. Còn dấu = lần trước chưa trả lại được, và biết chính xác giá trị cũ.
//   • Kiểm tra (checkKeymiss / scanKeymiss): CONFIG GET notify-keyspace-events + PUBSUB
//     NUMSUB các kênh keymiss trên từng master — đều O(1), không đổi gì.
//   • Tắt (releaseKeymiss): CHỈ khi người dùng bấm. Có dấu thì trả về đúng giá trị cũ,
//     không có thì chỉ bỏ cờ m. Không bao giờ tự tắt — cờ có thể do người khác cố ý bật.
//
// Còn giữ danh sách phiên phân tích đang chạy trong tiến trình này (runningKeymiss): đang
// chạy thì cờ bật là đúng, quét không báo và nút tắt từ chối.

import fs from 'fs/promises';
import type Redis from 'ioredis';
import { configPath } from '@/lib/configDir';
import { getConnection, listConnections, type RedisConnection } from '@/lib/redisConnections';
import { isCluster, masters } from '@/lib/redisClient';
import { keymissOn, stripKeymiss } from '@/lib/redisDiagnoseRules';

const PENDING_FILE = configPath('redis-keymiss-pending.json');
const NODE_TIMEOUT_MS = 5_000;
const SCAN_CONCURRENCY = 3;

/** Phiên phân tích hit rate đang chạy trong tiến trình này (theo connectionId). */
export const runningKeymiss = new Set<string>();

export interface PendingFlag {
  connectionId: string;
  addr: string;
  /** Giá trị notify-keyspace-events trước khi bật. */
  orig: string;
  at: number;
}

export interface KeymissNodeState {
  addr: string;
  /** null = không đọc được (CONFIG bị chặn / node không trả lời). */
  flags: string | null;
  on: boolean;
  /** Số kết nối đang SUBSCRIBE kênh keymiss; null = không đọc được. */
  listeners: number | null;
  /** Tổng pattern subscription trên node (có thể đang nghe keymiss theo mẫu). */
  patterns: number | null;
  /** Dấu "chưa trả lại" từ lần phân tích trước. */
  pending: PendingFlag | null;
  error?: string;
}

export interface KeymissState {
  connectionId: string;
  name: string;
  /** Đang có phiên phân tích hit rate chạy trong app này → cờ bật là đúng. */
  runningHere: boolean;
  nodes: KeymissNodeState[];
}

export interface ReleaseResult { addr: string; from: string; to: string; ok: boolean; error?: string }

const addrOf = (n: Redis) => `${n.options.host}:${n.options.port}`;
const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([
  p,
  new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: quá ${NODE_TIMEOUT_MS / 1000}s không trả lời`)), NODE_TIMEOUT_MS)),
]);

// ── Dấu "đang bật" trên đĩa ──────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();
/** Đọc-sửa-ghi file dấu lần lượt, không để hai phiên ghi đè nhau. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function readPending(): Promise<PendingFlag[]> {
  try {
    const v = JSON.parse(await fs.readFile(PENDING_FILE, 'utf8'));
    return Array.isArray(v?.pending) ? v.pending : [];
  } catch {
    return [];
  }
}

const writePending = (list: PendingFlag[]) =>
  fs.writeFile(PENDING_FILE, JSON.stringify({ pending: list }, null, 2) + '\n', 'utf8');

export const markPending = (entries: PendingFlag[]) => locked(async () => {
  if (!entries.length) return;
  const keyOf = (p: PendingFlag) => `${p.connectionId}|${p.addr}`;
  const cur = (await readPending()).filter((p) => !entries.some((e) => keyOf(e) === keyOf(p)));
  await writePending([...cur, ...entries]);
});

export const clearPending = (connectionId: string, addrs: string[]) => locked(async () => {
  if (!addrs.length) return;
  const cur = await readPending();
  const next = cur.filter((p) => !(p.connectionId === connectionId && addrs.includes(p.addr)));
  if (next.length !== cur.length) await writePending(next);
});

// ── Kênh keymiss ─────────────────────────────────────────────────────────

/** Kênh keymiss của một node: cluster chỉ có db 0; single thì mọi db (CONFIG databases). */
export async function keymissChannels(conn: RedisConnection, node: Redis): Promise<string[]> {
  let dbs = 1;
  if (!isCluster(conn)) {
    dbs = 16;
    try {
      const r = (await withTimeout(node.config('GET', 'databases'), 'CONFIG GET databases')) as unknown as string[];
      dbs = Math.min(256, Math.max(1, Number(r?.[1]) || 16));
    } catch { /* CONFIG bị chặn — dùng mặc định 16 */ }
  }
  return Array.from({ length: dbs }, (_, i) => `__keyevent@${i}__:keymiss`);
}

/** Số subscriber NHIỀU NHẤT trên một kênh keymiss của node (PUBSUB NUMSUB, O(số kênh)). */
export async function keymissListeners(node: Redis, channels: string[]): Promise<number> {
  const r = (await withTimeout(node.call('PUBSUB', 'NUMSUB', ...channels), 'PUBSUB NUMSUB')) as unknown[];
  let max = 0;
  for (let i = 1; i < r.length; i += 2) max = Math.max(max, Number(r[i]) || 0);
  return max;
}

// ── Kiểm tra / tắt ───────────────────────────────────────────────────────

export async function checkKeymiss(conn: RedisConnection): Promise<KeymissState> {
  const nodes = await withTimeout(masters(conn), conn.name);
  const pending = (await readPending()).filter((p) => p.connectionId === conn.id);
  const states = await Promise.all(nodes.map(async (n): Promise<KeymissNodeState> => {
    const addr = addrOf(n);
    const mark = pending.find((p) => p.addr === addr) ?? null;
    try {
      const r = (await withTimeout(n.config('GET', 'notify-keyspace-events'), `${addr} CONFIG GET`)) as unknown as string[];
      const flags = String(r?.[1] ?? '');
      let listeners: number | null = null;
      let patterns: number | null = null;
      try {
        listeners = await keymissListeners(n, await keymissChannels(conn, n));
        patterns = Number(await withTimeout(n.call('PUBSUB', 'NUMPAT'), 'PUBSUB NUMPAT')) || 0;
      } catch { /* ACL chặn PUBSUB — vẫn báo được cờ */ }
      return { addr, flags, on: keymissOn(flags), listeners, patterns, pending: mark };
    } catch (e) {
      return { addr, flags: null, on: false, listeners: null, patterns: null, pending: mark, error: (e as Error).message };
    }
  }));
  return { connectionId: conn.id, name: conn.name, runningHere: runningKeymiss.has(conn.id), nodes: states };
}

/**
 * Tắt cờ keymiss — chỉ gọi khi người dùng bấm. `addr` = chỉ node đó; bỏ trống = mọi node
 * đang bật. Có dấu thì trả đúng giá trị cũ; không có thì chỉ bỏ cờ m (stripKeymiss).
 */
export async function releaseKeymiss(conn: RedisConnection, addr?: string): Promise<ReleaseResult[]> {
  if (runningKeymiss.has(conn.id)) {
    throw new Error('Đang có phiên phân tích hit rate chạy trên kết nối này — nó sẽ tự trả lại cờ khi xong.');
  }
  const nodes = (await withTimeout(masters(conn), conn.name)).filter((n) => !addr || addrOf(n) === addr);
  const pending = (await readPending()).filter((p) => p.connectionId === conn.id);
  const out: ReleaseResult[] = [];
  const cleared: string[] = [];
  for (const n of nodes) {
    const a = addrOf(n);
    const mark = pending.find((p) => p.addr === a);
    try {
      const r = (await withTimeout(n.config('GET', 'notify-keyspace-events'), `${a} CONFIG GET`)) as unknown as string[];
      const from = String(r?.[1] ?? '');
      if (!keymissOn(from)) { if (mark) cleared.push(a); continue; }
      // Giá trị cũ trong dấu mà chính nó cũng có keymiss (người dùng cố ý bật) → vẫn chỉ bỏ m.
      const to = mark && !keymissOn(mark.orig) ? mark.orig : stripKeymiss(from);
      await withTimeout(n.config('SET', 'notify-keyspace-events', to), `${a} CONFIG SET`);
      out.push({ addr: a, from, to, ok: true });
      cleared.push(a);
    } catch (e) {
      out.push({ addr: a, from: '?', to: '?', ok: false, error: (e as Error).message });
    }
  }
  await clearPending(conn.id, cleared);
  return out;
}

/**
 * Quét mọi kết nối Redis đã lưu: trả về những kết nối có node đang bật keymiss mà KHÔNG AI
 * NGHE và không do phiên đang chạy trong app này. Có người nghe = một phiên ở app / máy khác
 * đang chạy (nó tự trả lại) hoặc công cụ cố ý dùng — hỏi lúc đó dễ khiến tắt nhầm giữa chừng;
 * panel kiểm tra tay vẫn hiện đủ. Lỗi kết nối bỏ qua (lần quét sau thử lại).
 */
export async function scanKeymiss(): Promise<KeymissState[]> {
  const list = await listConnections();
  const found: KeymissState[] = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const c = list[i++];
      if (runningKeymiss.has(c.id)) continue;
      try {
        const conn = await getConnection(c.id);
        if (!conn) continue;
        const st = await checkKeymiss(conn);
        const idle = st.nodes.filter((n) => n.on && !n.listeners);
        if (idle.length) found.push({ ...st, nodes: idle });
      } catch { /* không kết nối được — bỏ qua */ }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return found;
}
