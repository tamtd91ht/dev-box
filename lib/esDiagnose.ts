// Server-only: phân tích sức khoẻ + hiệu năng truy vấn cụm Elasticsearch — phần GOM SỐ LIỆU.
//
// AN TOÀN CHO PRODUCTION — chỉ đọc thống kê ES giữ sẵn trong bộ nhớ, không
// lệnh nào chặn (block) cụm, không đổi gì:
//   • GET /, _cluster/health, _cluster/settings, _cluster/pending_tasks,
//     _cluster/allocation/explain — đọc cluster state trên master, rẻ.
//   • _nodes/stats (có filter_path) hai lần cách WINDOW_MS — đọc bộ đếm trong
//     bộ nhớ từng node: GC old gen, request bị từ chối, luồng đang chạy từng
//     thread pool, query/indexing/cache trong cửa sổ.
//   • _tasks (chỉ search, filter_path) — danh sách task đang chạy, trong bộ nhớ.
//   • _cat/shards, _stats/search theo index, index settings — CHỈ khi cụm
//     ≤ LARGE_CLUSTER_SHARDS shard; cụm lớn hơn dùng _cat/allocation thay
//     _cat/shards và bỏ phần theo index (ghi rõ trong kết quả).
//   • KHÔNG chạy hot_threads mặc định: nó lấy mẫu stack mọi luồng trên mọi node
//     (mỗi lần lấy mẫu là một safepoint JVM). Chỉ chạy khi người dùng bật hẳn.
//   • Mỗi kết nối một phiên phân tích tại một thời điểm; mọi request có timeout
//     15s (esFetch), lỗi một phần thì bỏ phần đó chứ không thử lại dồn dập.
// Luật biến số liệu thành kết luận nằm ở lib/esDiagnoseRules (thuần, kiểm được).

import type { EsConnection } from '@/lib/esConnections';
import { esFetch } from '@/lib/esClient';
import {
  analyzeEs, threadKind,
  type EsDiagnosis, type EsExplain, type EsFacts, type EsHotThread, type EsNodeFacts, type EsRunningSearch,
} from '@/lib/esDiagnoseRules';

const WINDOW_MS = 8000;
const UNASSIGNED_LIST_MAX = 50;
/** Trên ngần này shard thì bỏ các lệnh liệt kê theo shard / index (phản hồi lớn, tốn CPU node điều phối). */
const LARGE_CLUSTER_SHARDS = 10_000;
const RUNNING_MAX = 20;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const NODE_STATS =
  '/_nodes/stats/jvm,os,thread_pool,breaker,indices,fs?filter_path=' + [
    'nodes.*.name', 'nodes.*.roles',
    'nodes.*.jvm.mem.heap_used_percent', 'nodes.*.jvm.mem.heap_max_in_bytes', 'nodes.*.jvm.gc.collectors.old',
    'nodes.*.os.cpu.percent', 'nodes.*.os.mem.total_in_bytes',
    'nodes.*.thread_pool.*.active', 'nodes.*.thread_pool.*.queue', 'nodes.*.thread_pool.*.rejected',
    'nodes.*.breakers',
    'nodes.*.indices.fielddata.memory_size_in_bytes', 'nodes.*.indices.segments.memory_in_bytes', 'nodes.*.indices.segments.count',
    'nodes.*.indices.search.query_total', 'nodes.*.indices.search.query_time_in_millis',
    'nodes.*.indices.store.size_in_bytes', 'nodes.*.indices.indexing.index_total',
    'nodes.*.indices.query_cache.hit_count', 'nodes.*.indices.query_cache.miss_count', 'nodes.*.indices.query_cache.evictions',
    'nodes.*.fs.total',
  ].join(',');

const INDEX_SEARCH = '/_stats/search?level=indices&filter_path=indices.*.total.search.query_total,indices.*.total.search.query_time_in_millis';

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const nn = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lỗi một phần (thiếu quyền monitor, bản cũ thiếu endpoint) không làm hỏng cả lần phân tích. */
async function soft<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch { return null; }
}

/** Gộp cài đặt cụm theo thứ tự ưu tiên của ES: transient > persistent > mặc định. */
function setting(s: Json | null, key: string): string | null {
  for (const scope of ['transient', 'persistent', 'defaults']) {
    const v = s?.[scope]?.[key];
    if (v !== undefined && v !== null) return String(v);
  }
  return null;
}

/** hot_threads (text) → các luồng nóng theo node. */
export function parseHotThreads(text: string): Map<string, EsHotThread[]> {
  const out = new Map<string, EsHotThread[]>();
  let node: string | null = null;
  for (const line of text.split('\n')) {
    const h = /^:::\s*\{([^}]+)\}/.exec(line);
    if (h) { node = h[1]; out.set(node, []); continue; }
    const m = /^\s*([\d.]+)%\s.*?cpu usage by thread '([^']+)'/.exec(line);
    if (m && node) out.get(node)!.push({ pct: Math.round(Number(m[1]) * 10) / 10, kind: threadKind(m[2]), thread: m[2] });
  }
  return out;
}

const running = new Set<string>();

export async function diagnoseEs(conn: EsConnection, opts: { hotThreads?: boolean } = {}): Promise<EsDiagnosis> {
  if (running.has(conn.id)) throw new Error('Đang có một phiên phân tích khác trên cụm này — chờ nó xong rồi chạy lại.');
  running.add(conn.id);
  try {
    return await run(conn, !!opts.hotThreads);
  } finally {
    running.delete(conn.id);
  }
}

async function run(conn: EsConnection, wantHotThreads: boolean): Promise<EsDiagnosis> {
  const skipped: string[] = [];
  const [root, health] = await Promise.all([esFetch<Json>(conn, '/'), esFetch<Json>(conn, '/_cluster/health')]);
  const large = n(health.active_shards) + n(health.unassigned_shards) > LARGE_CLUSTER_SHARDS;
  if (large) skipped.push(`cụm > ${fmt(LARGE_CLUSTER_SHARDS)} shard: bỏ _cat/shards (dùng _cat/allocation), bỏ thống kê search theo index, slowlog`);

  const t0 = Date.now();
  const [s0, idx0, shards, alloc, indices, settings, readOnly, pending, slowlog] = await Promise.all([
    esFetch<Json>(conn, NODE_STATS),
    large ? null : soft(esFetch<Json>(conn, INDEX_SEARCH)),
    large ? null : soft(esFetch<Json[]>(conn, '/_cat/shards?format=json&bytes=b&h=index,shard,prirep,state,unassigned.reason,node,store')),
    large ? soft(esFetch<Json[]>(conn, '/_cat/allocation?format=json&h=node,shards')) : null,
    soft(esFetch<Json[]>(conn, '/_cat/indices?format=json&h=index,rep')),
    soft(esFetch<Json>(conn, '/_cluster/settings?include_defaults=true&flat_settings=true&filter_path=*.cluster.routing.allocation.disk.watermark*,*.cluster.routing.allocation.enable,*.cluster.max_shards_per_node')),
    soft(esFetch<Json>(conn, '/_all/_settings/index.blocks.read_only_allow_delete?flat_settings=true')),
    soft(esFetch<Json>(conn, '/_cluster/pending_tasks')),
    large ? null : soft(esFetch<Json>(conn, '/_all/_settings/index.search.slowlog.threshold.*?flat_settings=true')),
  ]);

  const unassigned = n(health.unassigned_shards);
  const explainRaw = unassigned > 0 ? await soft(esFetch<Json>(conn, '/_cluster/allocation/explain')) : null;

  await sleep(Math.max(0, t0 + WINDOW_MS - Date.now()));
  const [s1, idx1, tasks] = await Promise.all([
    esFetch<Json>(conn, NODE_STATS),
    idx0 ? soft(esFetch<Json>(conn, INDEX_SEARCH)) : null,
    soft(esFetch<Json>(conn, '/_tasks?actions=indices:data/read/search&detailed=true&filter_path=nodes.*.name,nodes.*.tasks.*.running_time_in_nanos,nodes.*.tasks.*.description')),
  ]);
  const windowSec = Math.max(1, Math.round((Date.now() - t0) / 1000));
  if (!tasks) skipped.push('không đọc được _tasks (thiếu quyền monitor?) — chưa biết query nào đang chạy lâu');

  // hot_threads: chỉ khi người dùng bật — xem ghi chú đầu file.
  let hot = new Map<string, EsHotThread[]>();
  if (wantHotThreads) {
    const r = await soft(esFetch<Json>(conn, '/_nodes/hot_threads?threads=3&interval=500ms&snapshots=5&ignore_idle_threads=true'));
    const text = typeof r?.raw === 'string' ? r.raw : '';
    if (text) hot = parseHotThreads(text);
  } else {
    skipped.push('hot_threads (tắt mặc định — lấy mẫu stack gây safepoint ngắn trên mọi node)');
  }

  // Số shard theo node + kích thước + danh sách chưa gán.
  const shardsPerNode = new Map<string, number>();
  const shardSizes: EsFacts['shardSizes'] = [];
  const unassignedList: EsFacts['unassignedList'] = [];
  for (const r of shards ?? []) {
    if (r.state === 'UNASSIGNED') {
      if (unassignedList.length < UNASSIGNED_LIST_MAX) {
        unassignedList.push({ index: String(r.index), shard: n(r.shard), primary: r.prirep === 'p', reason: r['unassigned.reason'] ?? null });
      }
      continue;
    }
    if (r.node) shardsPerNode.set(String(r.node), (shardsPerNode.get(String(r.node)) ?? 0) + 1);
    if (r.state === 'STARTED') shardSizes.push({ index: String(r.index), shard: n(r.shard), bytes: n(r.store) });
  }
  for (const r of alloc ?? []) if (r.node && r.node !== 'UNASSIGNED') shardsPerNode.set(String(r.node), n(r.shards));

  const nodes: EsNodeFacts[] = Object.entries<Json>(s1.nodes ?? {}).map(([id, x]) => {
    const p = s0.nodes?.[id] ?? x;
    const old1 = x.jvm?.gc?.collectors?.old ?? {};
    const old0 = p.jvm?.gc?.collectors?.old ?? old1;
    const tp = (o: Json, k: string) => o.thread_pool?.[k] ?? {};
    const d = (path: (o: Json) => unknown) => Math.max(0, n(path(x)) - n(path(p)));
    const name = String(x.name ?? id);
    return {
      name,
      roles: Array.isArray(x.roles) ? x.roles.join(',') : '',
      heapPct: nn(x.jvm?.mem?.heap_used_percent),
      heapMax: nn(x.jvm?.mem?.heap_max_in_bytes),
      ramTotal: nn(x.os?.mem?.total_in_bytes),
      cpu: nn(x.os?.cpu?.percent),
      oldGcCount: Math.max(0, n(old1.collection_count) - n(old0.collection_count)),
      oldGcMs: Math.max(0, n(old1.collection_time_in_millis) - n(old0.collection_time_in_millis)),
      rejected: {
        search: Math.max(0, n(tp(x, 'search').rejected) - n(tp(p, 'search').rejected)),
        write: Math.max(0, n(tp(x, 'write').rejected) - n(tp(p, 'write').rejected)),
      },
      queue: { search: n(tp(x, 'search').queue), write: n(tp(x, 'write').queue) },
      breakers: Object.entries<Json>(x.breakers ?? {}).map(([bn, b]) => ({
        name: bn, estimated: n(b.estimated_size_in_bytes), limit: n(b.limit_size_in_bytes), tripped: n(b.tripped),
      })),
      fielddata: nn(x.indices?.fielddata?.memory_size_in_bytes),
      segmentsMem: nn(x.indices?.segments?.memory_in_bytes),
      diskTotal: nn(x.fs?.total?.total_in_bytes),
      diskAvail: nn(x.fs?.total?.available_in_bytes),
      shards: shardsPerNode.get(name) ?? 0,
      hotThreads: (hot.get(name) ?? []).sort((a, b) => b.pct - a.pct),
      poolActive: Object.fromEntries(Object.entries<Json>(x.thread_pool ?? {}).map(([k, v]) => [k, n(v.active)])),
      search: {
        queries: d((o) => o.indices?.search?.query_total),
        queryMs: d((o) => o.indices?.search?.query_time_in_millis),
        storeBytes: nn(x.indices?.store?.size_in_bytes),
        segments: nn(x.indices?.segments?.count),
        indexing: d((o) => o.indices?.indexing?.index_total),
        qcHit: d((o) => o.indices?.query_cache?.hit_count),
        qcMiss: d((o) => o.indices?.query_cache?.miss_count),
        qcEvictions: d((o) => o.indices?.query_cache?.evictions),
      },
    };
  });

  const dataNodes = n(health.number_of_data_nodes) || nodes.length;
  const overReplicated = (indices ?? [])
    .map((r) => ({ index: String(r.index), replicas: n(r.rep) }))
    .filter((r) => r.replicas >= dataNodes && !r.index.startsWith('.'));

  let explain: EsExplain | null = null;
  if (explainRaw && explainRaw.index !== undefined) {
    const agg = new Map<string, { decider: string; explanation: string; nodes: number }>();
    for (const dn of (explainRaw.node_allocation_decisions ?? []) as Json[]) {
      for (const dec of (dn.deciders ?? []) as Json[]) {
        if (dec.decision !== 'NO' && dec.decision !== 'THROTTLE') continue;
        const k = `${dec.decider}|${dec.explanation}`;
        const cur = agg.get(k) ?? { decider: String(dec.decider), explanation: String(dec.explanation ?? ''), nodes: 0 };
        cur.nodes++;
        agg.set(k, cur);
      }
    }
    explain = {
      index: String(explainRaw.index),
      shard: n(explainRaw.shard),
      primary: !!explainRaw.primary,
      reason: explainRaw.unassigned_info?.reason ?? null,
      details: explainRaw.unassigned_info?.details ?? null,
      decision: explainRaw.can_allocate ?? null,
      explanation: explainRaw.allocate_explanation ?? null,
      deciders: [...agg.values()].sort((a, b) => b.nodes - a.nodes),
    };
  }

  const pendingBy = new Map<string, number>();
  for (const t of (pending?.tasks ?? []) as Json[]) {
    const src = String(t.source ?? '?').split(/[\s[({]/)[0] || '?';
    pendingBy.set(src, (pendingBy.get(src) ?? 0) + 1);
  }

  // Search đang chạy (task cha) — lâu nhất trước.
  const runningSearches: EsRunningSearch[] = [];
  for (const nd of Object.values<Json>(tasks?.nodes ?? {})) {
    for (const [taskId, t] of Object.entries<Json>(nd.tasks ?? {})) {
      runningSearches.push({ node: String(nd.name ?? '?'), taskId, ms: Math.round(n(t.running_time_in_nanos) / 1e6), description: String(t.description ?? '') });
    }
  }
  runningSearches.sort((a, b) => b.ms - a.ms);

  // Search theo index trong cửa sổ.
  const indexSearch = idx0 && idx1
    ? Object.entries<Json>(idx1.indices ?? {}).map(([index, v]) => {
      const a = idx0.indices?.[index]?.total?.search ?? {};
      const b = v.total?.search ?? {};
      return { index, queries: Math.max(0, n(b.query_total) - n(a.query_total)), queryMs: Math.max(0, n(b.query_time_in_millis) - n(a.query_time_in_millis)) };
    })
    : null;

  const facts: EsFacts = {
    version: String(root.version?.number ?? '?'),
    status: String(health.status ?? '?'),
    dataNodes,
    activeShards: n(health.active_shards),
    unassigned,
    initializing: n(health.initializing_shards),
    relocating: n(health.relocating_shards),
    delayedUnassigned: n(health.delayed_unassigned_shards),
    windowSec,
    nodes,
    unassignedList,
    explain,
    shardSizes,
    overReplicated,
    watermarks: {
      low: setting(settings, 'cluster.routing.allocation.disk.watermark.low') ?? '85%',
      high: setting(settings, 'cluster.routing.allocation.disk.watermark.high') ?? '90%',
      flood: setting(settings, 'cluster.routing.allocation.disk.watermark.flood_stage') ?? '95%',
    },
    allocationEnable: setting(settings, 'cluster.routing.allocation.enable'),
    maxShardsPerNode: nn(setting(settings, 'cluster.max_shards_per_node')),
    readOnlyIndices: Object.entries<Json>(readOnly ?? {})
      .filter(([, v]) => String(v?.settings?.['index.blocks.read_only_allow_delete']) === 'true')
      .map(([k]) => k),
    pending: [...pendingBy.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    running: tasks ? runningSearches.slice(0, RUNNING_MAX) : null,
    indexSearch,
    slowlogIndices: slowlog
      ? Object.entries<Json>(slowlog).filter(([, v]) => Object.values(v?.settings ?? {}).some((x) => String(x) !== '-1')).map(([k]) => k)
      : null,
    skipped,
  };
  return analyzeEs(facts);
}

const fmt = (x: number): string => x.toLocaleString('vi-VN');
