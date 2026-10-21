// Server-only: phân tích sức khoẻ cụm Elasticsearch — phần GOM SỐ LIỆU.
//
// Toàn lệnh GET (đúng mô hình chỉ đọc của /api/es), không đổi gì trên cụm:
//   • _cluster/health, _cat/shards, _cat/indices (replica), pending_tasks.
//   • _nodes/stats hai lần cách WINDOW_MS → GC old gen + request bị từ chối
//     TRONG cửa sổ (số cộng dồn từ lúc khởi động không nói gì về hiện tại).
//   • _cluster/allocation/explain khi có shard chưa gán — lời giải thích của ES.
//   • Watermark đĩa / allocation.enable / max_shards_per_node thật của cụm
//     (persistent > transient > mặc định).
//   • Index đang bị khoá read_only_allow_delete.
//   • hot_threads CHỈ khi có node CPU cao — để biết việc gì đang ăn CPU.
// Luật biến số liệu thành kết luận nằm ở lib/esDiagnoseRules (thuần, kiểm được).

import type { EsConnection } from '@/lib/esConnections';
import { esFetch } from '@/lib/esClient';
import {
  analyzeEs, threadKind,
  type EsDiagnosis, type EsExplain, type EsFacts, type EsHotThread, type EsNodeFacts,
} from '@/lib/esDiagnoseRules';

const WINDOW_MS = 5000;
const CPU_HOT = 85;
const UNASSIGNED_LIST_MAX = 50;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const NODE_STATS =
  '/_nodes/stats/jvm,os,thread_pool,breaker,indices,fs?filter_path=' + [
    'nodes.*.name', 'nodes.*.roles',
    'nodes.*.jvm.mem.heap_used_percent', 'nodes.*.jvm.mem.heap_max_in_bytes', 'nodes.*.jvm.gc.collectors.old',
    'nodes.*.os.cpu.percent', 'nodes.*.os.mem.total_in_bytes',
    'nodes.*.thread_pool.search', 'nodes.*.thread_pool.write',
    'nodes.*.breakers',
    'nodes.*.indices.fielddata.memory_size_in_bytes', 'nodes.*.indices.segments.memory_in_bytes',
    'nodes.*.fs.total',
  ].join(',');

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

export async function diagnoseEs(conn: EsConnection): Promise<EsDiagnosis> {
  const t0 = Date.now();
  const [root, health, s0, shards, indices, settings, readOnly, pending] = await Promise.all([
    esFetch<Json>(conn, '/'),
    esFetch<Json>(conn, '/_cluster/health'),
    esFetch<Json>(conn, NODE_STATS),
    soft(esFetch<Json[]>(conn, '/_cat/shards?format=json&bytes=b&h=index,shard,prirep,state,unassigned.reason,node,store')),
    soft(esFetch<Json[]>(conn, '/_cat/indices?format=json&h=index,rep')),
    soft(esFetch<Json>(conn, '/_cluster/settings?include_defaults=true&flat_settings=true&filter_path=*.cluster.routing.allocation.disk.watermark*,*.cluster.routing.allocation.enable,*.cluster.max_shards_per_node')),
    soft(esFetch<Json>(conn, '/_all/_settings/index.blocks.read_only_allow_delete?flat_settings=true')),
    soft(esFetch<Json>(conn, '/_cluster/pending_tasks')),
  ]);

  const unassigned = n(health.unassigned_shards);
  const explainRaw = unassigned > 0 ? await soft(esFetch<Json>(conn, '/_cluster/allocation/explain')) : null;

  await sleep(Math.max(0, t0 + WINDOW_MS - Date.now()));
  const s1 = await esFetch<Json>(conn, NODE_STATS);
  const windowSec = Math.max(1, Math.round((Date.now() - t0) / 1000));

  // hot_threads chỉ khi cần — nó tự lấy mẫu 500ms trên mọi node.
  const anyHot = Object.values<Json>(s1.nodes ?? {}).some((x) => n(x.os?.cpu?.percent) >= CPU_HOT);
  let hot = new Map<string, EsHotThread[]>();
  if (anyHot) {
    const r = await soft(esFetch<Json>(conn, '/_nodes/hot_threads?threads=3&interval=500ms&ignore_idle_threads=true'));
    const text = typeof r?.raw === 'string' ? r.raw : '';
    if (text) hot = parseHotThreads(text);
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

  const nodes: EsNodeFacts[] = Object.entries<Json>(s1.nodes ?? {}).map(([id, x]) => {
    const p = s0.nodes?.[id] ?? x;
    const old1 = x.jvm?.gc?.collectors?.old ?? {};
    const old0 = p.jvm?.gc?.collectors?.old ?? old1;
    const tp = (o: Json, k: string) => o.thread_pool?.[k] ?? {};
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
    };
  });

  const dataNodes = n(health.number_of_data_nodes) || nodes.length;
  const overReplicated = (indices ?? [])
    .map((r) => ({ index: String(r.index), replicas: n(r.rep) }))
    .filter((r) => r.replicas >= dataNodes && !r.index.startsWith('.'));

  let explain: EsExplain | null = null;
  if (explainRaw && explainRaw.index !== undefined) {
    const agg = new Map<string, { decider: string; explanation: string; nodes: number }>();
    for (const d of (explainRaw.node_allocation_decisions ?? []) as Json[]) {
      for (const dec of (d.deciders ?? []) as Json[]) {
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
  };
  return analyzeEs(facts);
}
