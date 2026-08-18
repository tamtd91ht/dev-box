// Server-only Kafka operations for the local Kafka-inspector workspace.
//
// SECURITY / SAFETY MODEL — this connects to real Kafka clusters (possibly
// production) from the machine hosting the Next.js server, so it is deliberately
// constrained and gated off in any deploy:
//   1. Gated by KAFKA_TOOL_ENABLED — the API route 403s unless it is truthy. A
//      k8s/production deployment never sets it, so the feature is off there.
//   2. READ-ONLY inspection + one WRITE (produce a test message). NO topic
//      create/delete, no config edit, no offset reset — the destructive surface
//      simply isn't implemented.
//   3. Only PLAINTEXT brokers (no SASL/SSL yet) — see lib/kafkaConnections.
//
// PERFORMANCE — the whole point of this tool over KafkaHQ is to never scan blindly:
//   • Topic list fetches only names + partition counts + replication factor. It
//     never counts messages or lag across ALL topics — that is computed lazily
//     per-topic (describeTopic) / per-group (describeGroup) on selection.
//   • Message SEARCH REQUIRES a time window: `fetchTopicOffsetsByTimestamp`
//     translates from/to timestamps into per-partition offset ranges, so we
//     consume only that slice instead of the whole topic. Peek reads just the
//     last N offsets per partition. Every read is bounded by MAX_SCAN / MAX_MATCHES
//     / a timeout, and reads use RAW leader fetches — no consumer groups, nothing
//     is ever committed.

import { createConnection } from 'net';
import { Kafka, logLevel, type Admin } from 'kafkajs';
import type { KafkaConnection } from '@/lib/kafkaConnections';

export const KAFKA_ENABLED = /^(1|true|yes|on)$/i.test(process.env.KAFKA_TOOL_ENABLED ?? '');

// ── Bounds (keep every read cheap and interactive) ──────────────────────────────
/** Max messages examined by a peek before flagging truncation. */
const MAX_SCAN = 20_000;
/** Total messages examined by one search. */
const SEARCH_MAX_SCAN_TOTAL = 200_000;
/** Max matches returned from a search. */
const MAX_MATCHES = 200;
/** Hard cap for a peek's `limit`. */
const PEEK_MAX = 200;
/** Offsets walked per partition per chunk. Search walks each partition's window
 *  slice BACKWARD in chunks of this size (newest first, Kafka-HQ style) so recent
 *  matches surface immediately and the scan can stop without draining the window. */
const SEARCH_CHUNK_PER_PARTITION = 2_000;
/** Total wall-clock budget for one search. Overridable via
 *  KAFKA_SEARCH_DEADLINE_MS — raise it when scanning heavy topics over a slow
 *  link; the chunked newest-first walk keeps every extra second productive. */
const SEARCH_DEADLINE_MS = Math.max(10_000, Number(process.env.KAFKA_SEARCH_DEADLINE_MS) || 120_000);
/** Wall-clock budget for a peek consume loop. */
const PEEK_TIMEOUT_MS = 10_000;
/** Bytes of a message value materialized for keyword matching AND returned to the
 *  UI. Sized to hold a full Kafka message (broker default message.max.bytes ≈ 1 MB)
 *  so the viewer shows the complete value — only a value larger than this hard cap
 *  (which would risk OOM / a huge response) is truncated, and flagged. */
const MAX_VALUE_BYTES = 1_048_576;
/** Drop cached clients unused for longer than this. */
const IDLE_EVICT_MS = 10 * 60 * 1000;
/**
 * Client nằm im quá mốc này thì phải kiểm tra còn sống trước khi dùng lại (xem
 * getAdmin). Ngắn hơn hẳn chu kỳ watch nhỏ nhất (60s) để watch nào cũng được
 * kiểm tra, nhưng đủ dài để một tràng thao tác trong UI không phải trả phí.
 */
const STALE_CHECK_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

// ── Types returned to the route/UI ──────────────────────────────────────────────

export interface TopicSummary {
  name: string;
  partitions: number;
  replicationFactor: number;
  /** Kafka internal topic (name starts with `__`, e.g. __consumer_offsets). */
  internal: boolean;
}

export interface PartitionDetail {
  partition: number;
  leader: number;
  replicas: number[];
  isr: number[];
  low: number;
  high: number;
  /** high - low (approximate message count; ignores compaction/retention gaps). */
  count: number;
}

export interface TopicDetail {
  name: string;
  partitions: PartitionDetail[];
  totalMessages: number;
}

export interface GroupSummary {
  groupId: string;
  protocolType: string;
  state: string;
  members: number;
}

export interface GroupPartitionLag {
  partition: number;
  /** Committed offset, or null when the group has no commit for this partition. */
  committed: number | null;
  logEnd: number;
  /** logEnd - committed, or null when there is no commit. */
  lag: number | null;
}

export interface GroupTopicLag {
  topic: string;
  partitions: GroupPartitionLag[];
  totalLag: number;
}

export interface GroupDetail {
  groupId: string;
  state: string;
  members: { memberId: string; clientId: string; clientHost: string }[];
  topics: GroupTopicLag[];
  totalLag: number;
}

export interface TopicConsumerGroup {
  groupId: string;
  state: string;
  members: number;
  totalLag: number;
  partitions: GroupPartitionLag[];
}

export interface PreviewMessage {
  partition: number;
  offset: string;
  timestamp: number;
  key: string | null;
  value: string | null;
  valueTruncated: boolean;
}

export interface MessagePage {
  messages: PreviewMessage[];
  /** Messages examined (not matched). */
  scanned: number;
  /** True when a bound (MAX_SCAN / MAX_MATCHES / timeout) stopped the read early. */
  truncated: boolean;
  /** Optional human note (e.g. the time window mapped to an empty offset range). */
  note?: string;
}

// ── Client cache (one Kafka instance + admin per connection) ─────────────────────

interface Cached {
  kafka: Kafka;
  admin: Admin;
  adminConnected: boolean;
  /** broker list signature — recreate when the connection profile changes. */
  sig: string;
  lastUsed: number;
  /** Lần cuối client này được XÁC NHẬN còn nói chuyện được với cụm. */
  lastOkAt: number;
}
const clients = new Map<string, Cached>();

function signature(c: KafkaConnection): string {
  return c.brokers.join(',');
}

function evictIdle(now: number): void {
  for (const [id, entry] of clients) {
    if (now - entry.lastUsed > IDLE_EVICT_MS) {
      if (entry.adminConnected) entry.admin.disconnect().catch(() => {});
      clients.delete(id);
    }
  }
}

function newKafka(brokers: string[]): Kafka {
  return new Kafka({
    clientId: 'devbox-inspector',
    brokers,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // Fail fast — interactive tool, not a resilient worker.
    retry: { retries: 1, initialRetryTime: 200 },
    logLevel: logLevel.NOTHING,
  });
}

function getEntry(conn: KafkaConnection): Cached {
  const now = Date.now();
  evictIdle(now);
  const sig = signature(conn);
  const existing = clients.get(conn.id);
  if (existing && existing.sig === sig) {
    existing.lastUsed = now;
    return existing;
  }
  if (existing && existing.adminConnected) existing.admin.disconnect().catch(() => {});
  const kafka = newKafka(conn.brokers);
  const entry: Cached = { kafka, admin: kafka.admin(), adminConnected: false, sig, lastUsed: now, lastOkAt: 0 };
  clients.set(conn.id, entry);
  return entry;
}

/**
 * Vứt admin client đang cache của một kết nối, để lượt sau dựng lại từ đầu.
 *
 * Cần thiết vì `adminConnected` chỉ ghi lại rằng connect() TỪNG thành công, chứ
 * không phải socket còn sống: broker restart, TCP nửa mở, hay VPN/firewall cắt
 * kết nối đều để lại một client hỏng mà cờ vẫn `true`. Client đó sẽ hỏng mãi
 * (mọi lượt sau tái dùng nó) — với watch chạy nền thì thành "cụm down" kéo dài
 * trong khi cụm hoàn toàn khỏe.
 */
export function dropCachedClient(connectionId: string): void {
  const entry = clients.get(connectionId);
  if (!entry) return;
  if (entry.adminConnected) entry.admin.disconnect().catch(() => {});
  clients.delete(connectionId);
}

/**
 * Admin client dùng lại từ cache, kết nối ở lần dùng đầu.
 *
 * KIỂM TRA CÒN SỐNG trước khi giao ra: `adminConnected` chỉ nói connect() TỪNG
 * thành công, không nói socket còn dùng được. Broker restart, TCP nửa mở, hay
 * VPN/firewall cắt kết nối đều để lại client hỏng mà cờ vẫn `true` — và vì
 * evict-idle là 10 phút trong khi watch chạy mỗi 5 phút, client hỏng đó KHÔNG
 * BAO GIỜ bị dọn: một lần đứt thoáng qua thành "cụm down" kéo dài trong khi cụm
 * đã khỏe trở lại.
 *
 * Phép kiểm tra chỉ chạy khi client đã NẰM IM quá STALE_CHECK_MS. Đo trên cụm
 * thật, describeCluster mất ~180ms — quá đắt để bắt mọi thao tác tương tác (mở
 * topic, peek message) phải trả thêm, nhưng không đáng kể với một client vừa
 * ngồi không vài phút. Thao tác liên tiếp (người dùng đang bấm trong UI) không
 * phải trả gì: socket vừa dùng xong thì đang sống là chắc chắn.
 *
 * Đây đúng là ca của watch: chạy mỗi 300s nên LẦN NÀO client cũng đã nằm im,
 * lần nào cũng được kiểm tra.
 */
async function getAdmin(conn: KafkaConnection): Promise<Admin> {
  const entry = getEntry(conn);
  if (entry.adminConnected) {
    if (Date.now() - entry.lastOkAt < STALE_CHECK_MS) return entry.admin;
    try {
      await entry.admin.describeCluster();
      entry.lastOkAt = Date.now();
      return entry.admin;
    } catch {
      // Client cache đã chết — bỏ đi rồi dựng lại từ đầu ngay bên dưới.
      dropCachedClient(conn.id);
    }
  }
  const fresh = getEntry(conn);
  if (!fresh.adminConnected) {
    try {
      await fresh.admin.connect();
    } catch (e) {
      // connect() hỏng để lại entry chưa kết nối trong cache — bỏ hẳn để lượt
      // sau dựng client mới thay vì tái dùng cái vừa hỏng.
      dropCachedClient(conn.id);
      throw e;
    }
    fresh.adminConnected = true;
    fresh.lastOkAt = Date.now();
  }
  return fresh.admin;
}

function getKafka(conn: KafkaConnection): Kafka {
  return getEntry(conn).kafka;
}

// ── Operations ──────────────────────────────────────────────────────────────────

/** Probe an (unsaved) cluster: connect a throwaway admin and describe the cluster. */
export async function testConnection(input: { brokers?: string[] }): Promise<{ latencyMs: number; brokers: number }> {
  const brokers = (Array.isArray(input.brokers) ? input.brokers : [])
    .map((b) => String(b ?? '').trim())
    .filter(Boolean);
  if (brokers.length === 0) throw new Error('at least one broker (host:port) is required');
  const admin = newKafka(brokers).admin();
  const t0 = Date.now();
  try {
    await admin.connect();
    const cluster = await admin.describeCluster();
    return { latencyMs: Date.now() - t0, brokers: cluster.brokers.length };
  } finally {
    admin.disconnect().catch(() => {});
  }
}

/** List topics with partition count + replication factor. Cheap — no message counts. */
// ── Cluster health (brokers / URP / offline — 60s monitor) ───────────────────
// The Kafka wire protocol exposes NO host metrics (CPU/RAM/disk need JMX or a
// metrics exporter), so this monitor surfaces what the protocol DOES tell us —
// and what actually pages a Kafka operator: brokers gone missing,
// under-replicated partitions (ISR < replicas), and offline partitions
// (no leader). Metadata for every topic is one round-trip; fine at 60s.

export interface KafkaBrokerInfo {
  nodeId: number;
  addr: string;
  isController: boolean;
  /** Partitions this broker currently leads (rough load-balance signal). */
  leaderPartitions: number;
}

export interface KafkaClusterHealth {
  brokers: KafkaBrokerInfo[];
  controllerId: number | null;
  topicCount: number;
  partitionCount: number;
  /** Partitions with ISR smaller than the replica set — replication is behind. */
  underReplicated: number;
  /** Partitions with no leader — producers/consumers are FAILING on these. */
  offline: number;
  /** Names of affected topics (capped) for quick triage. */
  affectedTopics: string[];
}

export async function clusterHealth(conn: KafkaConnection): Promise<KafkaClusterHealth> {
  const admin = await getAdmin(conn);
  const cluster = await admin.describeCluster();
  const names = (await admin.listTopics()).filter((n) => !n.startsWith('__'));
  const meta = names.length ? await admin.fetchTopicMetadata({ topics: names }) : { topics: [] };

  let partitionCount = 0;
  let underReplicated = 0;
  let offline = 0;
  const leaderCounts = new Map<number, number>();
  const affected = new Set<string>();
  for (const t of meta.topics) {
    for (const p of t.partitions) {
      partitionCount += 1;
      if (p.leader === -1) { offline += 1; affected.add(t.name); }
      else leaderCounts.set(p.leader, (leaderCounts.get(p.leader) ?? 0) + 1);
      if ((p.isr?.length ?? 0) < (p.replicas?.length ?? 0)) { underReplicated += 1; affected.add(t.name); }
    }
  }

  return {
    brokers: cluster.brokers
      .map((b) => ({
        nodeId: b.nodeId,
        addr: `${b.host}:${b.port}`,
        isController: b.nodeId === cluster.controller,
        leaderPartitions: leaderCounts.get(b.nodeId) ?? 0,
      }))
      .sort((a, b) => a.nodeId - b.nodeId),
    controllerId: cluster.controller ?? null,
    topicCount: names.length,
    partitionCount,
    underReplicated,
    offline,
    affectedTopics: [...affected].sort().slice(0, 20),
  };
}

// ── Host metrics via node_exporter (RAM / disk / CPU / load) ─────────────────
// The Kafka protocol has no host metrics, but ops boxes usually run
// node_exporter (or jmx_exporter). When a connection declares metricsUrls,
// this fetches + parses the Prometheus text format for the handful of gauges
// an operator actually watches. CPU% needs a rate — cumulative counters are
// returned raw and the CLIENT diffs consecutive polls.

export interface KafkaDiskMount {
  mount: string;
  sizeBytes: number;
  availBytes: number;
}

export interface KafkaHostMetrics {
  url: string;
  /** Hostname taken from the URL (display label). */
  host: string;
  error?: string;
  load1?: number;
  load5?: number;
  load15?: number;
  memTotalBytes?: number;
  memAvailableBytes?: number;
  /** Largest real filesystems (tmpfs/overlay excluded), max 3. */
  disks?: KafkaDiskMount[];
  /** Cumulative CPU seconds — client diffs polls into busy %. */
  cpuIdleSec?: number;
  cpuTotalSec?: number;
  /** Số core (đếm nhãn `cpu` của node_cpu_seconds_total) — để quy load1 về mỗi core. */
  cpuCores?: number;
  at: number;
}

/** Parse Prometheus text: returns [{name, labels, value}] for the metrics we need. */
function parseProm(text: string, wanted: Set<string>): { name: string; labels: Record<string, string>; value: number }[] {
  const out: { name: string; labels: Record<string, string>; value: number }[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const brace = line.indexOf('{');
    const name = brace === -1 ? line.slice(0, line.indexOf(' ')) : line.slice(0, brace);
    if (!wanted.has(name)) continue;
    const labels: Record<string, string> = {};
    let rest: string;
    if (brace === -1) {
      rest = line.slice(name.length).trim();
    } else {
      const close = line.indexOf('}');
      if (close === -1) continue;
      for (const pair of line.slice(brace + 1, close).split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) labels[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim().replace(/^"|"$/g, '');
      }
      rest = line.slice(close + 1).trim();
    }
    const value = Number(rest.split(' ')[0]);
    if (Number.isFinite(value)) out.push({ name, labels, value });
  }
  return out;
}

const PROM_WANTED = new Set([
  'node_load1', 'node_load5', 'node_load15',
  'node_memory_MemTotal_bytes', 'node_memory_MemAvailable_bytes',
  'node_filesystem_size_bytes', 'node_filesystem_avail_bytes',
  'node_cpu_seconds_total',
]);

const SKIP_FSTYPES = new Set(['tmpfs', 'overlay', 'squashfs', 'ramfs', 'devtmpfs', 'iso9660']);

async function fetchOneHostMetrics(url: string): Promise<KafkaHostMetrics> {
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return { url, host, error: `HTTP ${res.status}`, at: Date.now() };
    const rows = parseProm(await res.text(), PROM_WANTED);
    const one = (n: string) => rows.find((r) => r.name === n)?.value;

    // Filesystems: pair size+avail by (device,mountpoint), skip pseudo fs, top 3 by size.
    const fsMap = new Map<string, { mount: string; size?: number; avail?: number }>();
    for (const r of rows) {
      if (r.name !== 'node_filesystem_size_bytes' && r.name !== 'node_filesystem_avail_bytes') continue;
      if (SKIP_FSTYPES.has(r.labels.fstype ?? '')) continue;
      const key = `${r.labels.device}|${r.labels.mountpoint}`;
      const e = fsMap.get(key) ?? { mount: r.labels.mountpoint ?? '?' };
      if (r.name === 'node_filesystem_size_bytes') e.size = r.value; else e.avail = r.value;
      fsMap.set(key, e);
    }
    const disks: KafkaDiskMount[] = [...fsMap.values()]
      .filter((e) => (e.size ?? 0) > 0 && e.avail !== undefined)
      .map((e) => ({ mount: e.mount, sizeBytes: e.size ?? 0, availBytes: e.avail ?? 0 }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, 3);

    // CPU: cumulative seconds summed across all cpus; idle separately.
    // Số core đếm từ nhãn `cpu` (mỗi core một chuỗi per mode) — cần để quy
    // load1 về "mỗi core", vì load 8 trên máy 16 core là nhàn còn trên máy
    // 2 core là ngộp; không có nó thì một ngưỡng load không dùng chung được
    // cho các broker khác cấu hình.
    let cpuIdleSec = 0;
    let cpuTotalSec = 0;
    const cores = new Set<string>();
    for (const r of rows) {
      if (r.name !== 'node_cpu_seconds_total') continue;
      cpuTotalSec += r.value;
      if (r.labels.cpu) cores.add(r.labels.cpu);
      if (r.labels.mode === 'idle') cpuIdleSec += r.value;
    }

    return {
      url,
      host,
      load1: one('node_load1'),
      load5: one('node_load5'),
      load15: one('node_load15'),
      memTotalBytes: one('node_memory_MemTotal_bytes'),
      memAvailableBytes: one('node_memory_MemAvailable_bytes'),
      disks,
      cpuIdleSec: cpuTotalSec > 0 ? cpuIdleSec : undefined,
      cpuTotalSec: cpuTotalSec > 0 ? cpuTotalSec : undefined,
      cpuCores: cores.size > 0 ? cores.size : undefined,
      at: Date.now(),
    };
  } catch (e) {
    return {
      url, host, at: Date.now(),
      error: (e as Error).name === 'AbortError' ? 'timeout 5s' : (e as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** All configured metrics endpoints, fetched in parallel (per-URL errors inline). */
export async function hostMetrics(conn: KafkaConnection): Promise<KafkaHostMetrics[]> {
  const urls = conn.metricsUrls ?? [];
  return Promise.all(urls.map(fetchOneHostMetrics));
}

// ── Chẩn đoán "mất kết nối" theo TỪNG broker ────────────────────────────────
//
// Khi cụm không trả lời, describeCluster chỉ ném MỘT lỗi cho cả cụm: cảnh báo
// ra "Kết nối được 0/1" mà không nói được node nào chết. Người trực vẫn phải
// tự ssh từng máy — đúng thứ cảnh báo lẽ ra phải trả lời sẵn.
//
// Nên khi cụm down, ta bắt tay TCP tới TỪNG seed broker: phân biệt được
//   · cả 3 node cùng chết  → nhiều khả năng đứt mạng/VPN phía mình
//   · 1 node chết           → sự cố máy đó
//   · TCP mở nhưng cụm vẫn lỗi → tiến trình Kafka còn sống mà không phục vụ
//     được (đang khởi động, mất ZK/KRaft quorum, sai cấu hình listener)
//
// Chỉ TCP connect, KHÔNG nói giao thức Kafka: rẻ, không phụ thuộc kafkajs đang
// ở trạng thái nào, và trả lời đúng câu hỏi "cổng này có ai nghe không".

/** Kết quả bắt tay TCP tới một broker. */
export interface KafkaBrokerReach {
  /** Nguyên văn 'host:port' như trong cấu hình. */
  addr: string;
  host: string;
  port: number;
  /** TCP bắt tay được hay không. */
  reachable: boolean;
  /** Thời gian bắt tay (ms) khi thành công. */
  latencyMs?: number;
  /** Lý do hỏng, đã rút gọn: 'timeout 3s' · 'ECONNREFUSED' · 'EHOSTUNREACH'… */
  error?: string;
}

const BROKER_TCP_TIMEOUT_MS = 3000;

/** Bắt tay TCP một broker. KHÔNG BAO GIỜ ném — hỏng cũng là một kết quả đo. */
function probeBrokerTcp(addr: string): Promise<KafkaBrokerReach> {
  // 'host:port' — host IPv6 dạng [::1]:9092 cũng tách đúng nhờ lastIndexOf.
  const cut = addr.lastIndexOf(':');
  const host = cut > 0 ? addr.slice(0, cut) : addr;
  const port = cut > 0 ? Number(addr.slice(cut + 1)) : 9092;
  const base = { addr, host, port: Number.isFinite(port) ? port : 9092 };

  return new Promise<KafkaBrokerReach>((resolve) => {
    const t0 = Date.now();
    let done = false;
    // Mọi nhánh kết thúc đều đi qua đây: đảm bảo socket luôn được huỷ và
    // promise chỉ resolve một lần (timeout và error có thể cùng bắn).
    const finish = (r: Omit<KafkaBrokerReach, 'addr' | 'host' | 'port'>) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ...base, ...r });
    };
    const sock = createConnection({ host: base.host, port: base.port });
    sock.setTimeout(BROKER_TCP_TIMEOUT_MS);
    sock.on('connect', () => finish({ reachable: true, latencyMs: Date.now() - t0 }));
    sock.on('timeout', () => finish({ reachable: false, error: `timeout ${BROKER_TCP_TIMEOUT_MS / 1000}s` }));
    sock.on('error', (e) => finish({
      reachable: false,
      // `code` (ECONNREFUSED/EHOSTUNREACH/ENOTFOUND) nói đúng bản chất hơn hẳn
      // câu message dài của Node, và là thứ người trực tra được ngay.
      error: (e as NodeJS.ErrnoException).code || e.message,
    }));
  });
}

/**
 * Hỏi cụm một câu Kafka THẬT (describeCluster) bằng client dùng-một-lần, để
 * phân biệt hai ca mà TCP không phân biệt nổi:
 *
 *   · cổng mở NHƯNG không nói được giao thức Kafka → tiến trình chưa sẵn sàng,
 *     mất quorum, hoặc thứ đang nghe cổng đó không phải Kafka
 *   · nói được → cụm sống, và ta ĐỌC ĐƯỢC advertised.listeners nó trả về. Đây
 *     là nguyên nhân kinh điển của "kết nối được mà vẫn hỏng": client bắt tay
 *     seed broker xong, mọi thao tác sau phải đi tới địa chỉ ĐƯỢC QUẢNG BÁ, mà
 *     địa chỉ đó có thể là hostname nội bộ DevBox không phân giải/không tới
 *     được.
 *
 * Client RIÊNG, không đụng cache: đang chẩn đoán chính cái cache có thể đã hỏng.
 */
async function probeKafkaProtocol(brokers: string[]): Promise<KafkaProtocolProbe> {
  const admin = newKafka(brokers).admin();
  const t0 = Date.now();
  try {
    const cluster = await admin.describeCluster();
    return {
      spoke: true,
      latencyMs: Date.now() - t0,
      controllerId: cluster.controller ?? null,
      clusterId: cluster.clusterId ?? '',
      advertised: cluster.brokers.map((b) => `${b.host}:${b.port}`),
    };
  } catch (e) {
    return { spoke: false, error: (e as Error).message || 'không rõ' };
  } finally {
    admin.disconnect().catch(() => {});
  }
}

/** Kết quả hỏi cụm bằng giao thức Kafka (không phải chỉ TCP). */
export interface KafkaProtocolProbe {
  /** Cụm có trả lời được câu hỏi Kafka hay không. */
  spoke: boolean;
  latencyMs?: number;
  /** Có controller hay không — null là dấu hiệu mất quorum. */
  controllerId?: number | null;
  clusterId?: string;
  /** advertised.listeners cụm trả về, dạng 'host:port'. */
  advertised?: string[];
  error?: string;
}

/**
 * Chẩn đoán MỘT cụm không trả lời: bắt tay TCP từng seed broker, và (nếu có
 * broker nào mở cổng) hỏi thêm một câu Kafka thật để biết cụm có nói được giao
 * thức không, kèm advertised.listeners.
 */
export async function brokerReachability(conn: KafkaConnection): Promise<KafkaReachReport> {
  const list = (conn.brokers ?? []).map((b) => String(b ?? '').trim()).filter(Boolean);
  const brokers = await Promise.all(list.map(probeBrokerTcp));
  const open = brokers.filter((b) => b.reachable).map((b) => b.addr);
  // Không cổng nào mở thì hỏi giao thức chỉ tổ chờ thêm một nhịp timeout vô ích.
  const protocol = open.length ? await probeKafkaProtocol(open) : undefined;
  return { brokers, protocol };
}

export interface KafkaReachReport {
  brokers: KafkaBrokerReach[];
  /** Vắng mặt khi không seed broker nào mở cổng (không có gì để hỏi). */
  protocol?: KafkaProtocolProbe;
}

export async function listTopics(conn: KafkaConnection): Promise<TopicSummary[]> {
  const admin = await getAdmin(conn);
  const names = await admin.listTopics();
  if (names.length === 0) return [];
  const meta = await admin.fetchTopicMetadata({ topics: names });
  return meta.topics
    .map((t) => ({
      name: t.name,
      partitions: t.partitions.length,
      replicationFactor: t.partitions[0]?.replicas?.length ?? 0,
      internal: t.name.startsWith('__'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Per-topic detail: partitions with leader/replicas/isr + low/high offsets + counts. */
export async function describeTopic(conn: KafkaConnection, topic: string): Promise<TopicDetail> {
  if (!topic) throw new Error('topic is required');
  const admin = await getAdmin(conn);
  const [meta, offsets] = await Promise.all([
    admin.fetchTopicMetadata({ topics: [topic] }),
    admin.fetchTopicOffsets(topic),
  ]);
  const t = meta.topics[0];
  if (!t) throw new Error(`topic not found: ${topic}`);
  const partitions: PartitionDetail[] = t.partitions
    .map((p) => {
      const o = offsets.find((x) => x.partition === p.partitionId);
      const low = Number(o?.low ?? 0);
      const high = Number(o?.high ?? o?.offset ?? 0);
      return {
        partition: p.partitionId,
        leader: p.leader,
        replicas: p.replicas,
        isr: p.isr,
        low,
        high,
        count: Math.max(0, high - low),
      };
    })
    .sort((a, b) => a.partition - b.partition);
  const totalMessages = partitions.reduce((s, p) => s + p.count, 0);
  return { name: topic, partitions, totalMessages };
}

/** List consumer groups with state + member count (one describeGroups round-trip). */
export async function listGroups(conn: KafkaConnection): Promise<GroupSummary[]> {
  const admin = await getAdmin(conn);
  const { groups } = await admin.listGroups();
  if (groups.length === 0) return [];
  const ids = groups.map((g) => g.groupId);
  let described: Awaited<ReturnType<Admin['describeGroups']>>['groups'] = [];
  try {
    described = (await admin.describeGroups(ids)).groups;
  } catch {
    // describeGroups can fail for a group mid-rebalance — fall back to list-only.
  }
  return groups
    .map((g) => {
      const d = described.find((x) => x.groupId === g.groupId);
      return {
        groupId: g.groupId,
        protocolType: g.protocolType,
        state: d?.state ?? 'Unknown',
        members: d?.members?.length ?? 0,
      };
    })
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
}

// ── Cluster-wide consumer lag (the monitor / automation path) ────────────────
//
// `describeGroup` is the INTERACTIVE per-group view: it walks that one group's
// topics and calls fetchTopicOffsets per topic, sequentially. Calling it for
// every group on a 60s poll is what this function exists to avoid:
//
//   • fetchTopicOffsets is memoized PER TOPIC for the duration of one call, so a
//     cluster where 30 groups read the same 5 topics costs 5 high-watermark
//     round-trips instead of 150.
//   • per-group fetchOffsets runs in parallel (bounded by LAG_GROUP_CONCURRENCY).
//   • a group that throws (mid-rebalance is routine) is reported with
//     `error` instead of failing the whole probe — a monitor must degrade, not
//     go blind.
//
// STALL DETECTION lives here rather than in the caller because it needs the
// previous committed offsets, and the renderer-side watcher is stateless across
// reloads. `stalledSec` answers the question a lag number cannot: "is this group
// still moving?". A group with 2M lag that is catching up is healthy; a group
// with 40k lag whose offsets have not moved in 10 minutes is dead.

/** Groups whose offsets are fetched concurrently. Keeps the admin API sane. */
const LAG_GROUP_CONCURRENCY = 8;
/** Groups examined by one lag sweep — a runaway cluster must not stall the poll. */
const LAG_MAX_GROUPS = 200;
/**
 * How long offsets must sit unchanged before the group counts as stalled.
 *
 * Not "unchanged since the previous sweep": a batch consumer that commits every
 * five minutes looks frozen on nearly every sweep, and would alert as a dead
 * consumer on each one. Two minutes is longer than any reasonable commit
 * interval for a streaming consumer and shorter than a batch cycle.
 * Override with KAFKA_STALL_MIN_SEC.
 */
const STALL_MIN_MS =
  Math.max(30, Number(process.env.KAFKA_STALL_MIN_SEC) || 120) * 1000;

export interface GroupLagSummary {
  groupId: string;
  state: string;
  members: number;
  /**
   * False when describeGroups failed for this sweep, so `members`/`state` are
   * UNKNOWN rather than measured. Without this, a routine mid-rebalance failure
   * makes every group look like it has 0 members — and "group không còn
   * consumer" fires for the whole cluster.
   */
  described: boolean;
  /** Sum of per-partition lag across every topic the group committed on. */
  totalLag: number;
  /** Topic carrying the most lag, for the alert text. */
  worstTopic: string | null;
  worstTopicLag: number;
  /** Partitions with a committed offset (nulls excluded). */
  partitions: number;
  /**
   * Seconds since ANY committed offset of this group last moved, or null when
   * this is the first sighting (no baseline yet) or the group is progressing.
   * Non-null + lag > 0 = the consumer is stuck, not merely behind.
   */
  stalledSec: number | null;
  /** Set when this group alone failed; its lag is unknown, not zero. */
  error?: string;
}

export interface KafkaConsumerLag {
  at: number;
  groups: GroupLagSummary[];
  /** Groups the sweep skipped because of LAG_MAX_GROUPS. */
  skippedGroups: number;
}

/** Per-connection stall baseline: `groupId` → {offset fingerprint, since when}. */
interface StallEntry {
  /**
   * Fingerprint of every committed offset. NOT a sum: two partitions moving by
   * the same amount in opposite directions (an operator resetting offsets) would
   * leave a sum unchanged and be misreported as stalled. Positional digest keeps
   * each partition's contribution distinct.
   */
  fingerprint: string;
  /** When the fingerprint was last observed to CHANGE. */
  movedAt: number;
}
const stallState = new Map<string, Map<string, StallEntry>>();

function stallMapFor(connectionId: string): Map<string, StallEntry> {
  let m = stallState.get(connectionId);
  if (!m) {
    m = new Map();
    stallState.set(connectionId, m);
  }
  return m;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Lag for EVERY consumer group in the cluster, plus how long each group has been
 * stuck. One sweep = 1 listGroups + 1 describeGroups + 1 fetchOffsets per group
 * + 1 fetchTopicOffsets per DISTINCT topic.
 */
export async function consumerLag(conn: KafkaConnection): Promise<KafkaConsumerLag> {
  const admin = await getAdmin(conn);
  const at = Date.now();
  const { groups: listed } = await admin.listGroups();

  const take = listed.slice(0, LAG_MAX_GROUPS);
  const skippedGroups = listed.length - take.length;

  // Forget groups that no longer exist. This runs BEFORE the early return so an
  // empty cluster still clears its baselines: a group deleted and later recreated
  // must start with no stall history, or it is reported frozen the instant it
  // reappears. It also bounds the map for a cluster with churning group ids.
  //
  // Keyed off `listed`, NOT `take`: on a cluster past LAG_MAX_GROUPS the groups
  // beyond the cap still exist, and listGroups order is not guaranteed stable —
  // evicting them would restart the stall clock of any group drifting in and out
  // of the cap, so it could never accumulate stalledSec.
  const stalls = stallMapFor(conn.id);
  const alive = new Set(listed.map((g) => g.groupId));
  for (const id of [...stalls.keys()]) if (!alive.has(id)) stalls.delete(id);

  if (listed.length === 0) return { at, groups: [], skippedGroups };

  let described: Awaited<ReturnType<Admin['describeGroups']>>['groups'] = [];
  try {
    described = (await admin.describeGroups(take.map((g) => g.groupId))).groups;
  } catch {
    // Routine when a group is rebalancing — state/member counts degrade to Unknown.
  }

  // High-watermark cache, shared across every group in THIS sweep.
  const highs = new Map<string, Promise<Map<number, number>>>();
  const topicHighs = (topic: string): Promise<Map<number, number>> => {
    let p = highs.get(topic);
    if (!p) {
      p = admin.fetchTopicOffsets(topic).then((offsets) => {
        const m = new Map<number, number>();
        for (const o of offsets) m.set(o.partition, Number(o.high ?? o.offset ?? 0));
        return m;
      });
      highs.set(topic, p);
    }
    return p;
  };

  const groups = await mapPool(take, LAG_GROUP_CONCURRENCY, async (g): Promise<GroupLagSummary> => {
    const d = described.find((x) => x.groupId === g.groupId);
    const base: GroupLagSummary = {
      groupId: g.groupId,
      state: d?.state ?? 'Unknown',
      members: d?.members?.length ?? 0,
      described: !!d,
      totalLag: 0,
      worstTopic: null,
      worstTopicLag: 0,
      partitions: 0,
      stalledSec: null,
    };

    let committed: Awaited<ReturnType<Admin['fetchOffsets']>>;
    try {
      committed = await admin.fetchOffsets({ groupId: g.groupId });
    } catch (e) {
      return { ...base, error: (e as Error).message || 'fetchOffsets thất bại' };
    }

    const marks: string[] = [];
    let partitions = 0;
    let totalLag = 0;
    let worstTopic: string | null = null;
    let worstTopicLag = 0;

    const dropped: string[] = [];
    for (const t of committed) {
      let high: Map<number, number>;
      try {
        high = await topicHighs(t.topic);
      } catch {
        // Topic deleted mid-sweep, or metadata unavailable. Its lag is UNKNOWN,
        // not zero — silently skipping would report a confidently low total for
        // every group reading that topic.
        dropped.push(t.topic);
        continue;
      }
      let topicLag = 0;
      for (const p of t.partitions) {
        const cur = Number(p.offset);
        if (!Number.isFinite(cur) || cur < 0) continue; // never committed
        partitions += 1;
        marks.push(`${t.topic}:${p.partition}:${cur}`);
        topicLag += Math.max(0, (high.get(p.partition) ?? 0) - cur);
      }
      totalLag += topicLag;
      if (topicLag > worstTopicLag) {
        worstTopicLag = topicLag;
        worstTopic = t.topic;
      }
    }

    // Stall: the offset fingerprint has not changed since a previous sweep.
    // marks is built in fetchOffsets order, which kafkajs returns consistently
    // per group; sorting keeps the digest stable even if that ever changes.
    const fingerprint = marks.sort().join('|');
    let stalledSec: number | null = null;
    const prev = stalls.get(g.groupId);
    if (!prev || prev.fingerprint !== fingerprint) {
      stalls.set(g.groupId, { fingerprint, movedAt: at });
    } else {
      // Only call it stalled once it has held long enough — see STALL_MIN_MS.
      const heldMs = at - prev.movedAt;
      if (heldMs >= STALL_MIN_MS) stalledSec = Math.round(heldMs / 1000);
    }

    return {
      ...base,
      totalLag,
      worstTopic,
      worstTopicLag,
      partitions,
      stalledSec,
      ...(dropped.length
        ? { error: `không đọc được high-watermark của: ${dropped.slice(0, 5).join(', ')}` }
        : {}),
    };
  });

  groups.sort((a, b) => b.totalLag - a.totalLag);
  return { at, groups, skippedGroups };
}

/** Per-group lag: committed offset vs log-end per topic/partition. */
export async function describeGroup(conn: KafkaConnection, groupId: string): Promise<GroupDetail> {
  if (!groupId) throw new Error('groupId is required');
  const admin = await getAdmin(conn);
  const described = (await admin.describeGroups([groupId])).groups[0];
  const committed = await admin.fetchOffsets({ groupId });

  const topics: GroupTopicLag[] = [];
  for (const t of committed) {
    const topicOffsets = await admin.fetchTopicOffsets(t.topic);
    const partitions: GroupPartitionLag[] = t.partitions
      .map((p) => {
        const hwEntry = topicOffsets.find((x) => x.partition === p.partition);
        const logEnd = Number(hwEntry?.high ?? hwEntry?.offset ?? 0);
        const cur = Number(p.offset);
        const committedOffset = cur < 0 ? null : cur;
        const lag = committedOffset == null ? null : Math.max(0, logEnd - committedOffset);
        return { partition: p.partition, committed: committedOffset, logEnd, lag };
      })
      .sort((a, b) => a.partition - b.partition);
    const totalLag = partitions.reduce((s, p) => s + (p.lag ?? 0), 0);
    topics.push({ topic: t.topic, partitions, totalLag });
  }
  topics.sort((a, b) => a.topic.localeCompare(b.topic));

  return {
    groupId,
    state: described?.state ?? 'Unknown',
    members: (described?.members ?? []).map((m) => ({
      memberId: m.memberId,
      clientId: m.clientId,
      clientHost: m.clientHost,
    })),
    topics,
    totalLag: topics.reduce((s, t) => s + t.totalLag, 0),
  };
}

/**
 * Consumer groups that consume THIS topic — i.e. have committed offsets on it —
 * with per-partition lag (log-end - committed) and total lag. Mirrors the AKHQ
 * "Consumer groups" tab on a topic. One fetchTopicOffsets + one fetchOffsets per
 * group (parallel) + one describeGroups for state/member counts.
 */
export async function listTopicGroups(conn: KafkaConnection, topic: string): Promise<TopicConsumerGroup[]> {
  if (!topic) throw new Error('topic is required');
  const admin = await getAdmin(conn);

  const [{ groups }, topicOffsets] = await Promise.all([
    admin.listGroups(),
    admin.fetchTopicOffsets(topic),
  ]);
  if (groups.length === 0) return [];

  const highByPartition = new Map<number, number>();
  for (const o of topicOffsets) highByPartition.set(o.partition, Number(o.high ?? o.offset ?? 0));

  // Committed offsets for each group, scoped to this topic. A group is "on" the
  // topic only if it has at least one partition with a real (>=0) committed offset.
  const perGroup = await Promise.all(
    groups.map(async (g) => {
      try {
        const committed = await admin.fetchOffsets({ groupId: g.groupId, topics: [topic] });
        const entry = committed.find((c) => c.topic === topic);
        if (!entry) return null;
        const partitions: GroupPartitionLag[] = entry.partitions
          .map((p) => {
            const cur = Number(p.offset);
            const committedOffset = cur < 0 ? null : cur;
            const logEnd = highByPartition.get(p.partition) ?? 0;
            const lag = committedOffset == null ? null : Math.max(0, logEnd - committedOffset);
            return { partition: p.partition, committed: committedOffset, logEnd, lag };
          })
          .sort((a, b) => a.partition - b.partition);
        if (!partitions.some((p) => p.committed != null)) return null;
        const totalLag = partitions.reduce((s, p) => s + (p.lag ?? 0), 0);
        return { groupId: g.groupId, partitions, totalLag };
      } catch {
        return null; // group mid-rebalance / offsets unavailable — skip it
      }
    }),
  );

  const active = perGroup.filter((x): x is NonNullable<typeof x> => x !== null);
  if (active.length === 0) return [];

  // One describeGroups round-trip for state + member counts.
  let described: Awaited<ReturnType<Admin['describeGroups']>>['groups'] = [];
  try {
    described = (await admin.describeGroups(active.map((a) => a.groupId))).groups;
  } catch {
    // best-effort — leave state Unknown / members 0
  }

  return active
    .map((a) => {
      const d = described.find((x) => x.groupId === a.groupId);
      return {
        groupId: a.groupId,
        state: d?.state ?? 'Unknown',
        members: d?.members?.length ?? 0,
        totalLag: a.totalLag,
        partitions: a.partitions,
      };
    })
    .sort((x, y) => y.totalLag - x.totalLag || x.groupId.localeCompare(y.groupId));
}

/** Peek the most recent `limit` messages across all partitions (no keyword). */
export async function peekMessages(conn: KafkaConnection, topic: string, limit: number): Promise<MessagePage> {
  if (!topic) throw new Error('topic is required');
  const n = Math.min(Math.max(Number(limit) || 20, 1), PEEK_MAX);
  const admin = await getAdmin(conn);
  const offsets = await admin.fetchTopicOffsets(topic);
  const numP = Math.max(1, offsets.length);
  const perP = Math.max(1, Math.ceil(n / numP));
  const ranges = offsets.map((o) => {
    const low = Number(o.low);
    const high = Number(o.high ?? o.offset);
    return { partition: o.partition, start: Math.max(low, high - perP), end: high };
  });
  const page = await consumeRange(conn, topic, ranges, {
    filter: null,
    maxMatches: Math.min(1000, perP * numP + numP),
    maxScan: MAX_SCAN,
    timeoutMs: PEEK_TIMEOUT_MS,
  });
  // Newest first, then trim to the requested count.
  page.messages.sort((a, b) => b.timestamp - a.timestamp || Number(b.offset) - Number(a.offset));
  return { messages: page.messages.slice(0, n), scanned: page.scanned, truncated: page.truncated };
}

/**
 * Search messages by keyword WITHIN a time window. The time window is REQUIRED —
 * it is translated to per-partition offset ranges via fetchTopicOffsetsByTimestamp
 * so only that slice is consumed (never the whole topic). Bounded by MAX_SCAN /
 * MAX_MATCHES / timeout.
 */
export async function searchMessages(
  conn: KafkaConnection,
  input: { topic: string; fromMs: number; toMs: number; keyword: string },
): Promise<MessagePage> {
  const topic = input.topic;
  if (!topic) throw new Error('topic is required');
  const fromMs = Number(input.fromMs);
  const toMs = Number(input.toMs);
  const keyword = String(input.keyword ?? '');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('from/to timestamps are required');
  if (toMs <= fromMs) throw new Error('"to" must be after "from"');
  if (!keyword.trim()) throw new Error('keyword is required');

  const admin = await getAdmin(conn);
  const [startByTs, endByTs, highOffsets] = await Promise.all([
    admin.fetchTopicOffsetsByTimestamp(topic, fromMs),
    admin.fetchTopicOffsetsByTimestamp(topic, toMs),
    admin.fetchTopicOffsets(topic),
  ]);

  const ranges = highOffsets.map((o) => {
    const low = Number(o.low);
    const high = Number(o.high ?? o.offset);
    const s = startByTs.find((x) => x.partition === o.partition);
    const e = endByTs.find((x) => x.partition === o.partition);
    // start: earliest offset with ts >= from. -1 → nothing at/after `from` → empty slice.
    let start = s ? Number(s.offset) : low;
    if (start < 0) start = high;
    // end (exclusive): earliest offset with ts >= to. -1 → all in-window → read to high.
    let end = e ? Number(e.offset) : high;
    if (end < 0) end = high;
    start = Math.max(low, start);
    end = Math.min(high, Math.max(start, end));
    return { partition: o.partition, start, end };
  });

  // No offset in [from,to) on any partition → the window is empty. Say so plainly
  // instead of returning a silent blank (the #1 "search finds nothing" cause: the
  // topic simply had no traffic in the chosen window).
  if (!ranges.some((r) => r.end > r.start)) {
    return {
      messages: [],
      scanned: 0,
      truncated: false,
      note: 'Không có message nào trong khoảng thời gian đã chọn — thử nới rộng khoảng thời gian, hoặc bấm "Xem" để lấy message mới nhất của topic.',
    };
  }

  // Byte-level fast path: exact bytes of the keyword (IDs/UUIDs pasted verbatim —
  // the dominant case) via native Buffer.includes, no decode. Only when the keyword
  // is case-variant (has letters) and the byte path missed do we decode and run a
  // case-insensitive regex — correctness kept, allocations reserved for rare paths.
  const kwBuf = Buffer.from(keyword);
  const caseVariant = keyword.toLowerCase() !== keyword.toUpperCase();
  const re = caseVariant ? new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const filter = (k: Buffer | null, v: Buffer | null): boolean => {
    if ((v != null && v.includes(kwBuf)) || (k != null && k.includes(kwBuf))) return true;
    if (!re) return false;
    return (v != null && re.test(v.toString('utf8'))) || (k != null && re.test(k.toString('utf8')));
  };

  // The engine walks each partition's window slice BACKWARD in chunks (newest
  // first, Kafka-HQ style): recent matches surface immediately and the scan stops
  // as soon as it has enough — instead of draining the window oldest-first and
  // running out of budget before reaching the recent messages the user is almost
  // always looking for.
  const page = await consumeRange(conn, topic, ranges, {
    filter,
    maxMatches: MAX_MATCHES,
    maxScan: SEARCH_MAX_SCAN_TOTAL,
    timeoutMs: SEARCH_DEADLINE_MS,
    chunk: SEARCH_CHUNK_PER_PARTITION,
  });

  page.messages.sort((a, b) => b.timestamp - a.timestamp || Number(b.offset) - Number(a.offset));
  const note = page.truncated && page.messages.length === 0
    ? `Đã quét ${page.scanned.toLocaleString('vi-VN')} message (ưu tiên phần MỚI nhất của cửa sổ) mà chưa gặp keyword — cửa sổ chưa được phủ hết. Thu hẹp khoảng thời gian để quét trọn vùng nghi ngờ.`
    : undefined;
  return { messages: page.messages, scanned: page.scanned, truncated: page.truncated, ...(note ? { note } : {}) };
}

/** Produce ONE message to a topic (the only write op). Audit-logged. */
export async function produce(
  conn: KafkaConnection,
  input: { topic: string; key?: string; value: string; partition?: number },
): Promise<{ partition: number; offset: string }> {
  const topic = String(input.topic ?? '').trim();
  if (!topic) throw new Error('topic is required');
  const value = typeof input.value === 'string' ? input.value : String(input.value ?? '');
  const message: { value: string; key?: string; partition?: number } = { value };
  if (input.key != null && String(input.key).length) message.key = String(input.key);
  if (input.partition != null && Number.isInteger(Number(input.partition))) message.partition = Number(input.partition);

  const producer = getKafka(conn).producer({ allowAutoTopicCreation: false });
  await producer.connect();
  try {
    const res = await producer.send({ topic, messages: [message], acks: -1 });
    const meta = res[0];
    // eslint-disable-next-line no-console
    console.log(
      `KAFKA_AUDIT operation=PRODUCE connection=${conn.name} brokers=${conn.brokers.join(',')} topic=${sanitize(topic)} partition=${meta?.partition} keyed=${message.key != null} ts=${new Date().toISOString()}`,
    );
    return { partition: meta?.partition ?? -1, offset: String(meta?.baseOffset ?? '-1') };
  } finally {
    producer.disconnect().catch(() => {});
  }
}

// ── Raw-fetch scan engine (no consumer groups) ──────────────────────────────────
//
// kafkajs's public consumer API only reads through a consumer GROUP, and its
// join/seek/pause/resume machinery proved unfit for interactive scanning: 3-5s
// initial-rebalance per group, fetch state corrupted by rapid seek cycling
// (duplicate deliveries, partitions silently starving to zero), members kicked
// when a big decode burst starved heartbeats. Inspectors like Kafka-HQ read the
// way the protocol intends for this job: DIRECT Fetch requests to each
// partition's leader at explicit offsets. kafkajs ships everything needed in its
// CommonJS internals — Cluster + Broker.fetch — so the scan is built on those:
// no groups, no joins, no seeks, per-broker parallel loops, full offset control.
// kafkajs is pinned (^2.2.4, upstream dormant), so the require paths are stable.

/* eslint-disable @typescript-eslint/no-var-requires */
const KafkaCluster = require('kafkajs/src/cluster');
const { createLogger: createKafkaLogger, LEVELS: KAFKA_LOG_LEVELS } = require('kafkajs/src/loggers');
const kafkaLoggerConsole = require('kafkajs/src/loggers/console');
const createKafkaSocketFactory = require('kafkajs/src/network/socketFactory');
const KAFKA_ISOLATION = require('kafkajs/src/protocol/isolationLevel');
/* eslint-enable @typescript-eslint/no-var-requires */

interface Range {
  partition: number;
  start: number;
  /** exclusive end offset. */
  end: number;
}

interface ConsumeOpts {
  /** Byte-level match on the RAW buffers — decode happens only for matches, so a
   *  scan over tens of thousands of large values never allocates their strings. */
  filter: ((key: Buffer | null, value: Buffer | null) => boolean) | null;
  maxMatches: number;
  maxScan: number;
  timeoutMs: number;
  /** When set, each partition's range is walked BACKWARD in chunks of this many
   *  offsets (newest chunk first) — recent matches surface first and the scan can
   *  stop early. Unset (peek): the whole range is read forward in one go. */
  chunk?: number;
}

/** consumeRange's result: a page + which partitions were fully covered. */
type ScanResult = MessagePage & { donePartitions: number[] };

/** Shared tallies across the per-broker loops of one scan. */
interface ScanState {
  matches: PreviewMessage[];
  scanned: number;
  done: Set<number>;
}

// Fetch sizing: modest per-request cap keeps each decode burst short (the event
// loop also serves the UI); per-broker loops run in parallel so aggregate
// throughput is (brokers × cap) per round-trip.
const FETCH_MAX_WAIT_MS = 150;
const FETCH_MAX_BYTES = 12_582_912; // 12 MB per fetch response
const FETCH_MAX_BYTES_PER_PARTITION = 4_194_304; // 4 MB

// One raw Cluster per connection (metadata + broker sockets), idle-evicted.
interface RawClusterEntry {
  // kafkajs internal Cluster — no public typings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cluster: any;
  sig: string;
  lastUsed: number;
}
const rawClusters = new Map<string, RawClusterEntry>();

function evictIdleRawClusters(now: number): void {
  for (const [id, e] of rawClusters) {
    if (now - e.lastUsed > IDLE_EVICT_MS) {
      rawClusters.delete(id);
      e.cluster.disconnect().catch(() => {});
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getRawCluster(conn: KafkaConnection): Promise<any> {
  const now = Date.now();
  evictIdleRawClusters(now);
  const sig = signature(conn);
  const existing = rawClusters.get(conn.id);
  if (existing && existing.sig === sig) {
    existing.lastUsed = now;
    return existing.cluster;
  }
  if (existing) {
    rawClusters.delete(conn.id);
    existing.cluster.disconnect().catch(() => {});
  }
  const cluster = new KafkaCluster({
    logger: createKafkaLogger({ level: KAFKA_LOG_LEVELS.NOTHING, logCreator: kafkaLoggerConsole }),
    retry: { retries: 1, initialRetryTime: 200 },
    socketFactory: createKafkaSocketFactory(),
    brokers: [...conn.brokers],
    ssl: undefined,
    sasl: undefined,
    clientId: 'devbox-inspector-raw',
    connectionTimeout: CONNECT_TIMEOUT_MS,
    authenticationTimeout: CONNECT_TIMEOUT_MS,
    reauthenticationThreshold: 10_000,
    requestTimeout: REQUEST_TIMEOUT_MS,
    enforceRequestTimeout: true,
    metadataMaxAge: 5 * 60 * 1000,
    allowAutoTopicCreation: false,
    maxInFlightRequests: null,
    isolationLevel: KAFKA_ISOLATION.READ_COMMITTED,
  });
  await cluster.connect();
  rawClusters.set(conn.id, { cluster, sig, lastUsed: now });
  return cluster;
}

/**
 * Read the given per-partition offset ranges via DIRECT Fetch requests to each
 * partition's leader, collecting matches until a bound trips or every range is
 * covered. Per-broker loops run in parallel; with `opts.chunk` each partition is
 * walked backward chunk by chunk (newest data first).
 */
async function consumeRange(conn: KafkaConnection, topic: string, ranges: Range[], opts: ConsumeOpts): Promise<ScanResult> {
  const wanted = ranges.filter((r) => r.end > r.start);
  if (wanted.length === 0) return { messages: [], scanned: 0, truncated: false, donePartitions: [] };

  const cluster = await getRawCluster(conn);
  await cluster.addTargetTopic(topic); // registers + refreshes metadata when new
  let meta = cluster.findTopicPartitionMetadata(topic) as Array<{ partitionId: number; leader: number }>;
  if (!meta || meta.length === 0) {
    await cluster.refreshMetadata();
    meta = cluster.findTopicPartitionMetadata(topic) ?? [];
  }
  const leaderByP = new Map(meta.map((m) => [m.partitionId, m.leader]));

  // Group the wanted ranges by their partition's leader broker.
  const byNode = new Map<number, Range[]>();
  for (const r of wanted) {
    const node = leaderByP.get(r.partition);
    if (node == null) continue; // unknown partition → left un-done, flagged by truncated
    const arr = byNode.get(node) ?? [];
    arr.push(r);
    byNode.set(node, arr);
  }

  const deadline = Date.now() + opts.timeoutMs;
  const state: ScanState = { matches: [], scanned: 0, done: new Set() };

  await Promise.all(
    [...byNode.entries()].map(([nodeId, parts]) =>
      nodeScanLoop(cluster, nodeId, topic, parts, opts, state, deadline).catch((e) => {
        if (process.env.KAFKA_SEARCH_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`KAFKA_SEARCH_DEBUG node ${nodeId} loop failed: ${(e as Error).message}`);
        }
      }),
    ),
  );

  if (process.env.KAFKA_SEARCH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(
      `KAFKA_SEARCH_DEBUG scan: partitions=${wanted.length} done=${state.done.size} scanned=${state.scanned} matches=${state.matches.length}`,
    );
  }

  return {
    messages: state.matches,
    scanned: state.scanned,
    truncated:
      state.matches.length >= opts.maxMatches ||
      state.scanned >= opts.maxScan ||
      state.done.size < wanted.length,
    donePartitions: [...state.done],
  };
}

/**
 * Drain one broker's share of the scan: repeatedly Fetch all its partitions at
 * explicit offsets, walking each partition's range (backward in chunks when
 * opts.chunk is set) until covered, a bound trips, or the deadline passes.
 */
async function nodeScanLoop(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cluster: any,
  nodeId: number,
  topic: string,
  parts: Range[],
  opts: ConsumeOpts,
  state: ScanState,
  deadline: number,
): Promise<void> {
  // Per-partition walk: [base, hi) is the current chunk, `next` the fetch cursor
  // inside it, `floor` the range start. Chunks step from the range end downward.
  interface Walk { floor: number; hi: number; base: number; next: number }
  const walks = new Map<number, Walk>();
  for (const r of parts) {
    const chunk = opts.chunk && opts.chunk > 0 ? opts.chunk : r.end - r.start;
    const base = Math.max(r.start, r.end - chunk);
    walks.set(r.partition, { floor: r.start, hi: r.end, base, next: base });
  }
  const broker = await cluster.findBroker({ nodeId });
  const capped = () => state.matches.length >= opts.maxMatches || state.scanned >= opts.maxScan;

  while (walks.size > 0 && !capped() && Date.now() < deadline) {
    const resp = await broker.fetch({
      isolationLevel: KAFKA_ISOLATION.READ_COMMITTED,
      maxWaitTime: FETCH_MAX_WAIT_MS,
      minBytes: 1,
      maxBytes: FETCH_MAX_BYTES,
      topics: [
        {
          topic,
          partitions: [...walks.entries()].map(([partition, w]) => ({
            partition,
            fetchOffset: String(w.next),
            maxBytes: FETCH_MAX_BYTES_PER_PARTITION,
          })),
        },
      ],
    });
    for (const tr of resp?.responses ?? []) {
      if (tr.topicName !== topic) continue;
      for (const pr of tr.partitions ?? []) {
        const p = pr.partition as number;
        const w = walks.get(p);
        if (!w) continue;
        if ((pr.errorCode ?? 0) !== 0) {
          // OFFSET_OUT_OF_RANGE (retention passed us) / NOT_LEADER (moved mid-
          // scan): give this partition up — `truncated` reports partial coverage.
          walks.delete(p);
          continue;
        }
        const hw = Number(pr.highWatermark);
        // READ_COMMITTED: the broker serves data only up to the last stable
        // offset — use it (when valid) as the "nothing more to read" bound.
        const lso = Number(pr.lastStableOffset);
        const served = Number.isFinite(lso) && lso >= 0 ? lso : hw;
        for (const m of pr.messages ?? []) {
          if (capped()) break;
          const off = Number(m.offset);
          if (off < w.next) continue;
          if (off >= w.hi) { w.next = w.hi; break; }
          w.next = off + 1;
          if (m.isControlRecord) continue; // transaction markers carry no payload
          state.scanned += 1;
          const key: Buffer | null = m.key ?? null;
          const val: Buffer | null = m.value ?? null;
          // Filter on the RAW buffers (Buffer.includes = native byte search) —
          // decode to string only for actual matches.
          if (!opts.filter || opts.filter(key, val)) {
            state.matches.push({
              partition: p,
              offset: String(m.offset),
              timestamp: Number(m.timestamp),
              key: key ? key.subarray(0, 1024).toString('utf8') : null,
              value: val ? val.subarray(0, MAX_VALUE_BYTES).toString('utf8') : null,
              valueTruncated: val != null && val.length > MAX_VALUE_BYTES,
            });
          }
        }
        // Broker has nothing at/above the cursor → the chunk is drained (tail
        // windows end at the log-end offset, where no message ever materializes).
        if (Number.isFinite(served) && served <= w.next) w.next = w.hi;
        if (w.next >= w.hi) {
          if (w.base <= w.floor) {
            state.done.add(p);
            walks.delete(p);
          } else {
            // Step down to the next (older) chunk.
            w.hi = w.base;
            w.base = Math.max(w.floor, w.hi - (opts.chunk && opts.chunk > 0 ? opts.chunk : w.hi - w.floor));
            w.next = w.base;
          }
        }
      }
    }
  }
}

/** Strip control chars + cap length so a crafted topic can't inject into the audit line. */
function sanitize(s: string): string {
  let out = '';
  for (const ch of s.slice(0, 200)) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? '?' : ch;
  }
  return out;
}
