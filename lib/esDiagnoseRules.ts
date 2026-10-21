// Phân tích sức khoẻ cụm Elasticsearch (heap, shard, CPU, đĩa, thread pool,
// pending task) — phần LUẬT thuần.
//
// Số liệu do lib/esDiagnose.ts gom (toàn lệnh GET, không đổi gì trên cụm):
// _nodes/stats hai lần cách vài giây (GC, rejected), _cat/shards,
// _cluster/allocation/explain, watermark thật của cụm, hot_threads khi CPU
// cao… File này biến chúng thành kết luận có bằng chứng + lệnh mẫu (Dev Tools).
// Thuần để kiểm bằng script (check:es-diagnose) và để client import kiểu.
//
// Câu hỏi phải trả lời được: heap đầy VÌ CÁI GÌ (fielddata, quá nhiều shard,
// GC không kịp), shard chưa gán VÌ SAO (đúng decider ES nói), CPU bận VÌ VIỆC
// GÌ (search / ghi / merge / GC) — chứ không chỉ nhắc lại con số đã thấy.

import { buildPlan, fmtBytes, fmtN, sortFindings, type Finding, type PlanStep } from '@/lib/diagnose';

export interface EsHotThread {
  pct: number;
  /** search / write / merge / gc / refresh / flush / management / … */
  kind: string;
  thread: string;
}

export interface EsNodeFacts {
  name: string;
  roles: string;
  heapPct: number | null;
  heapMax: number | null;
  ramTotal: number | null;
  cpu: number | null;
  /** Δ trong cửa sổ đo. */
  oldGcCount: number;
  oldGcMs: number;
  rejected: { search: number; write: number };
  queue: { search: number; write: number };
  breakers: { name: string; estimated: number; limit: number; tripped: number }[];
  fielddata: number | null;
  segmentsMem: number | null;
  diskTotal: number | null;
  diskAvail: number | null;
  shards: number;
  hotThreads: EsHotThread[];
}

export interface EsUnassigned { index: string; shard: number; primary: boolean; reason: string | null }

export interface EsExplain {
  index: string;
  shard: number;
  primary: boolean;
  /** unassigned_info.reason: NODE_LEFT, ALLOCATION_FAILED, INDEX_CREATED, … */
  reason: string | null;
  details: string | null;
  /** can_allocate: no / throttled / awaiting_info / no_valid_shard_copy / yes */
  decision: string | null;
  explanation: string | null;
  /** decider → explanation, gom từ mọi node (trùng thì gộp). */
  deciders: { decider: string; explanation: string; nodes: number }[];
}

export interface EsFacts {
  version: string;
  status: string;
  dataNodes: number;
  activeShards: number;
  unassigned: number;
  initializing: number;
  relocating: number;
  delayedUnassigned: number;
  windowSec: number;
  nodes: EsNodeFacts[];
  unassignedList: EsUnassigned[];
  explain: EsExplain | null;
  /** Kích thước shard primary + replica đang chạy. */
  shardSizes: { index: string; shard: number; bytes: number }[];
  /** Index có số replica ≥ số node data (replica không bao giờ có chỗ). */
  overReplicated: { index: string; replicas: number }[];
  watermarks: { low: string; high: string; flood: string };
  allocationEnable: string | null;
  maxShardsPerNode: number | null;
  readOnlyIndices: string[];
  pending: { source: string; count: number }[];
}

export interface EsNodeRow {
  name: string;
  roles: string;
  heapPct: number | null;
  gcOldPct: number;
  cpu: number | null;
  diskPct: number | null;
  shards: number;
  rejected: number;
  top: string | null;
}

export interface EsDiagnosis {
  at: number;
  status: string;
  headline: string;
  findings: Finding[];
  plan: PlanStep[];
  nodes: EsNodeRow[];
  windowSec: number;
}

// ── Ngưỡng ───────────────────────────────────────────────────────────────

const HEAP_WARN = 85;
const HEAP_CRIT = 95;
/** % thời gian của cửa sổ đo nằm trong GC old gen. */
const GC_WARN = 5;
const GC_CRIT = 15;
const CPU_HOT = 85;
const FIELDDATA_SHARE = 0.2;
/** Khuyến nghị cũ của Elastic: ≤ 20 shard mỗi GB heap (trước 8.3). */
const SHARDS_PER_GB_HEAP = 20;
const DEFAULT_MAX_SHARDS = 1000;
const SMALL_SHARD = 1024 ** 3;
const HUGE_SHARD = 50 * 1024 ** 3;
const COMPRESSED_OOPS = 31 * 1024 ** 3;
const BREAKER_NEAR = 0.9;

const GB = 1024 ** 3;
const pct = (n: number): string => `${Math.round(n)}%`;

/** Đổi watermark ("85%", "0.85", "50gb", "500mb") thành % đĩa ĐÃ DÙNG tương ứng trên node có `total` byte. */
export function watermarkUsedPct(v: string, total: number | null): number | null {
  const s = v.trim().toLowerCase();
  if (s.endsWith('%')) return Number(s.slice(0, -1)) || null;
  const ratio = Number(s);
  if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1) return ratio * 100;
  const m = /^([\d.]+)\s*(b|kb|mb|gb|tb|pb)$/.exec(s);
  if (!m || !total) return null;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: GB, tb: 1024 ** 4, pb: 1024 ** 5 }[m[2] as 'b'];
  // Watermark dạng tuyệt đối = dung lượng CÒN TRỐNG tối thiểu.
  return Math.max(0, 100 - ((Number(m[1]) * mult) / total) * 100);
}

/** Tên luồng của hot_threads → loại việc. */
export function threadKind(thread: string): string {
  // Merge trước: tên index có thể chứa "gc" (gcp-logs) — chỉ nhận luồng GC theo tên thật của JVM.
  if (/Lucene Merge Thread|\[merge\]/i.test(thread)) return 'merge';
  if (/^(VM Thread|GC Thread|Gang worker|ParGC|G1 (Young|Old|Conc|Main|Refine|Service)|ZGC|Shenandoah)/.test(thread)) return 'gc';
  const m = /\]\[([a-z_]+)\]\[/.exec(thread);
  return m ? m[1] : 'khác';
}

const KIND_TEXT: Record<string, string> = {
  search: 'truy vấn (search)',
  write: 'ghi / bulk (write)',
  bulk: 'ghi / bulk',
  index: 'ghi (index)',
  merge: 'gộp segment (merge)',
  gc: 'dọn rác JVM (GC)',
  refresh: 'refresh',
  flush: 'flush',
  management: 'quản trị (management)',
  generic: 'generic (recovery / snapshot)',
  snapshot: 'snapshot',
  force_merge: 'force merge',
};

// ── Phân tích ────────────────────────────────────────────────────────────

export function analyzeEs(f: EsFacts, at = Date.now()): EsDiagnosis {
  const out: Finding[] = [];
  const winMs = Math.max(1, f.windowSec) * 1000;
  // roles từ _nodes/stats: "data", "data_hot", "data_content"… (rỗng = bản cũ không báo → coi là data).
  const dataNodes = f.nodes.filter((n) => n.roles === '' || /data/.test(n.roles));

  // ── Đĩa: kiểm trước vì nó gây ra cả shard chưa gán lẫn index read-only ──
  const flooded: string[] = [];
  for (const n of f.nodes) {
    if (n.diskTotal === null || n.diskAvail === null) continue;
    const used = 100 - (n.diskAvail / n.diskTotal) * 100;
    const low = watermarkUsedPct(f.watermarks.low, n.diskTotal) ?? 85;
    const high = watermarkUsedPct(f.watermarks.high, n.diskTotal) ?? 90;
    const flood = watermarkUsedPct(f.watermarks.flood, n.diskTotal) ?? 95;
    if (used < low) continue;
    const stage = used >= flood ? 'flood' : used >= high ? 'high' : 'low';
    if (stage === 'flood') flooded.push(n.name);
    out.push({
      id: `disk:${n.name}`,
      level: stage === 'low' ? 'warn' : 'crit',
      title: `Node ${n.name} đĩa ${pct(used)} — vượt watermark ${stage === 'flood' ? 'flood-stage (index bị khoá ghi)' : stage === 'high' ? 'high (ES đang dời shard đi)' : 'low (không nhận shard mới)'}`,
      evidence: [
        `Còn trống ${fmtBytes(n.diskAvail)} / ${fmtBytes(n.diskTotal)}`,
        `Watermark của cụm: low ${f.watermarks.low} · high ${f.watermarks.high} · flood ${f.watermarks.flood}`,
      ],
      fix: 'Giải phóng đĩa: xoá index cũ không dùng (hoặc để ILM delete), giảm replica của index ít quan trọng, thêm node/đĩa. Đừng nâng watermark để "chữa" — đĩa đầy hẳn thì node chết.',
      sql: 'GET _cat/indices?v&s=store.size:desc&h=index,pri,rep,store.size,creation.date.string\nGET _cat/allocation?v',
      step: { phase: 'now', text: `Giải phóng đĩa node ${n.name} (${pct(used)}, vượt watermark ${stage})` },
    });
  }
  if (f.readOnlyIndices.length) {
    out.push({
      id: 'readonly',
      level: 'crit',
      title: `${f.readOnlyIndices.length} index đang bị khoá ghi (read_only_allow_delete)`,
      evidence: [f.readOnlyIndices.slice(0, 8).join(', ') + (f.readOnlyIndices.length > 8 ? ` … +${f.readOnlyIndices.length - 8}` : ''),
        flooded.length ? `Do node ${flooded.join(', ')} vượt flood-stage` : 'Khoá do từng chạm flood-stage (ES ≥ 7.4 tự mở khi đĩa xuống dưới high; bản cũ phải mở tay)'],
      fix: 'Ứng dụng ghi vào các index này đang nhận lỗi 403 FORBIDDEN/12. Giải phóng đĩa TRƯỚC, sau đó mở khoá.',
      sql: 'PUT _all/_settings\n{ "index.blocks.read_only_allow_delete": null }',
      step: { phase: 'now', text: 'Sau khi giải phóng đĩa: mở khoá ghi các index read_only_allow_delete' },
    });
  }

  // ── Shard chưa gán: dùng đúng lời giải thích của ES ──
  if (f.unassigned > 0) {
    const pri = f.unassignedList.filter((u) => u.primary).length;
    const e = f.explain;
    const deciders = e?.deciders ?? [];
    const has = (d: string) => deciders.some((x) => x.decider === d);
    let cause = 'Xem lời giải thích của ES bên dưới';
    let fix = 'Đọc phần explanation của allocation explain; sửa đúng decider đang chặn.';
    let sql = 'GET _cluster/allocation/explain';
    let phase: 'now' | 'long' = 'now';
    if (f.allocationEnable && f.allocationEnable !== 'all') {
      cause = `cluster.routing.allocation.enable = "${f.allocationEnable}" — phân bổ shard đang bị tắt (thường do quên bật lại sau rolling restart)`;
      fix = 'Bật lại phân bổ shard.';
      sql = 'PUT _cluster/settings\n{ "persistent": { "cluster.routing.allocation.enable": null } }';
    } else if (e?.decision === 'no_valid_shard_copy') {
      cause = 'Không còn bản sao hợp lệ nào của primary — node giữ dữ liệu đã mất';
      fix = 'Đưa node cũ (còn dữ liệu) quay lại cụm là cách duy nhất không mất dữ liệu. Chỉ khi chấp nhận mất: allocate_stale_primary (mất dữ liệu mới) hoặc allocate_empty_primary (mất toàn bộ shard) — hoặc khôi phục từ snapshot.';
      sql = `GET _cluster/allocation/explain\n{ "index": "${e.index}", "shard": ${e.shard}, "primary": true }\n# CHẤP NHẬN MẤT DỮ LIỆU:\nPOST _cluster/reroute\n{ "commands": [ { "allocate_stale_primary": { "index": "${e.index}", "shard": ${e.shard}, "node": "<node>", "accept_data_loss": true } } ] }`;
    } else if (has('disk_threshold')) {
      cause = 'Node đều vượt watermark đĩa — không node nào nhận shard';
      fix = 'Giải phóng đĩa (xem mục đĩa). Shard tự được gán khi node xuống dưới watermark low.';
    } else if (has('max_retry') || e?.reason === 'ALLOCATION_FAILED') {
      cause = `Gán thất bại nhiều lần và ES đã ngừng thử${e?.details ? `: ${e.details}` : ''}`;
      fix = 'Sửa nguyên nhân lỗi trong details (thường là đĩa / mapping / file hỏng), rồi bảo ES thử lại.';
      sql = 'POST _cluster/reroute?retry_failed=true';
    } else if (has('same_shard') || f.overReplicated.length) {
      cause = `Số replica ≥ số node data (${f.dataNodes}) — replica không bao giờ có chỗ (không được nằm cùng node với primary)`;
      fix = 'Giảm number_of_replicas cho các index này về ≤ số node data − 1, hoặc thêm node.';
      sql = `PUT ${f.overReplicated[0]?.index ?? '<index>'}/_settings\n{ "index.number_of_replicas": ${Math.max(0, f.dataNodes - 1)} }`;
    } else if (has('filter') || has('awareness')) {
      cause = 'Luật lọc / awareness (index.routing.allocation.* / cluster awareness) loại hết node phù hợp';
      fix = 'Kiểm tra index.routing.allocation.require/include/exclude của index và thuộc tính node (node.attr.*).';
      sql = `GET ${e?.index ?? '<index>'}/_settings?filter_path=**.routing\nGET _cat/nodeattrs?v`;
    } else if (e?.decision === 'throttled' || f.initializing > 0 || f.relocating > 0) {
      cause = 'Đang khôi phục / dời shard — ES giới hạn số shard khôi phục cùng lúc';
      fix = 'Thường tự xong; chờ và theo dõi _cat/recovery. Cần nhanh hơn thì tăng cluster.routing.allocation.node_concurrent_recoveries (tạm thời).';
      sql = 'GET _cat/recovery?v&active_only=true';
      phase = 'long';
    } else if (e?.reason === 'NODE_LEFT' && f.delayedUnassigned > 0) {
      cause = 'Node vừa rời cụm — ES đang chờ (delayed allocation) xem node có quay lại không';
      fix = 'Nếu node sẽ quay lại: chờ (mặc định 1 phút). Nếu không: shard sẽ được gán sang node khác khi hết thời gian chờ.';
      phase = 'long';
    }
    out.push({
      id: 'unassigned',
      level: pri > 0 ? 'crit' : 'warn',
      title: `${fmtN(f.unassigned)} shard chưa gán${pri ? ` — trong đó ${pri} PRIMARY (dữ liệu không truy cập được)` : ' (chỉ replica — dữ liệu vẫn đọc được, mất dự phòng)'}`,
      evidence: [
        `Nguyên nhân: ${cause}`,
        e ? `Ví dụ ${e.index}[${e.shard}] ${e.primary ? 'primary' : 'replica'} · lý do ${e.reason ?? '?'}${e.decision ? ` · ${e.decision}` : ''}` : '',
        ...deciders.slice(0, 3).map((d) => `${d.decider} (${d.nodes} node): ${d.explanation}`),
        f.unassignedList.length ? `Index: ${[...new Set(f.unassignedList.map((u) => u.index))].slice(0, 6).join(', ')}` : '',
      ].filter(Boolean),
      fix,
      sql,
      step: { phase, text: `Shard chưa gán: ${cause.split(' — ')[0]}` },
    });
  }

  // ── Heap ──
  for (const n of f.nodes) {
    const gcPct = (n.oldGcMs / winMs) * 100;
    const hot = (n.heapPct ?? 0) >= HEAP_WARN || gcPct >= GC_WARN;
    if (!hot) continue;
    const ev: string[] = [
      `Heap ${n.heapPct ?? '?'}% / ${fmtBytes(n.heapMax)}`,
      `GC old gen: ${n.oldGcCount} lần, ${fmtN(n.oldGcMs)} ms trong ${f.windowSec}s (${pct(gcPct)} thời gian)`,
    ];
    const causes: string[] = [];
    let sql = 'GET _nodes/stats/jvm,breaker?human';
    if (n.fielddata && n.heapMax && n.fielddata / n.heapMax >= FIELDDATA_SHARE) {
      causes.push(`fielddata chiếm ${fmtBytes(n.fielddata)} (${pct((n.fielddata / n.heapMax) * 100)} heap) — sort/aggregation trên field text`);
      sql = 'GET _cat/fielddata?v&s=size:desc\n# giải phóng tạm (sẽ nạp lại nếu query vẫn dùng):\nPOST _cache/clear?fielddata=true';
    }
    if (n.heapMax && n.shards > (n.heapMax / GB) * SHARDS_PER_GB_HEAP) {
      causes.push(`${n.shards} shard trên ${fmtBytes(n.heapMax)} heap (nên ≤ ${Math.round((n.heapMax / GB) * SHARDS_PER_GB_HEAP)}) — mỗi shard tốn heap cố định`);
    }
    if (n.segmentsMem && n.heapMax && n.segmentsMem / n.heapMax >= 0.15) {
      causes.push(`segments chiếm ${fmtBytes(n.segmentsMem)} heap — quá nhiều segment / shard`);
    }
    const tripped = n.breakers.filter((b) => b.tripped > 0);
    if (tripped.length) causes.push(`circuit breaker đã ngắt: ${tripped.map((b) => `${b.name} ×${b.tripped}`).join(', ')}`);
    out.push({
      id: `heap:${n.name}`,
      level: (n.heapPct ?? 0) >= HEAP_CRIT || gcPct >= GC_CRIT ? 'crit' : 'warn',
      title: gcPct >= GC_WARN
        ? `Node ${n.name}: GC old gen chiếm ${pct(gcPct)} thời gian — heap không đủ`
        : `Node ${n.name}: heap ${n.heapPct}%`,
      evidence: [...ev, ...(causes.length ? [`Nguyên nhân: ${causes.join(' · ')}`] : ['Không thấy fielddata / số shard bất thường — thường do aggregation / query trả nhiều dữ liệu, hoặc bulk quá lớn'])],
      fix: causes.some((c) => c.startsWith('fielddata'))
        ? 'Đổi sort/aggregation sang field keyword (không bật fielddata trên text); giới hạn indices.breaker.fielddata.limit.'
        : causes.some((c) => c.includes('shard trên'))
          ? 'Giảm số shard: gộp index nhỏ, rollover theo dung lượng (ILM max_primary_shard_size ~30–50GB), shrink index cũ, xoá index hết hạn.'
          : 'Giảm kích thước kết quả (size, số bucket của aggregation, bulk nhỏ hơn); nếu tải thật sự cần thì tăng heap (≤ 50% RAM và ≤ 31GB) hoặc thêm node.',
      sql,
      step: { phase: 'now', text: `Giảm áp lực heap node ${n.name}${causes.length ? `: ${causes[0].split(' — ')[0]}` : ''}` },
    });
  }
  for (const n of f.nodes) {
    if (n.heapMax && n.heapMax > COMPRESSED_OOPS) {
      out.push({
        id: `oops:${n.name}`,
        level: 'warn',
        title: `Node ${n.name}: heap ${fmtBytes(n.heapMax)} > 31GB — mất compressed oops`,
        evidence: ['Trên ~31GB JVM bỏ con trỏ nén: heap lớn hơn nhưng chứa được ÍT hơn, GC lâu hơn'],
        fix: 'Đặt -Xms/-Xmx ≤ 31g (vd 30g). Cần thêm bộ nhớ thì thêm node.',
        sql: '# jvm.options.d/heap.options\n-Xms30g\n-Xmx30g',
        step: { phase: 'restart', text: `Hạ heap node ${n.name} về ≤ 31GB (đang ${fmtBytes(n.heapMax)})` },
      });
    } else if (n.heapMax && n.ramTotal && n.heapMax > n.ramTotal * 0.6) {
      out.push({
        id: `heapram:${n.name}`,
        level: 'info',
        title: `Node ${n.name}: heap ${fmtBytes(n.heapMax)} = ${pct((n.heapMax / n.ramTotal) * 100)} RAM`,
        evidence: ['Lucene cần phần RAM còn lại làm filesystem cache — heap > 50% RAM làm search đọc đĩa nhiều hơn'],
        fix: 'Heap ≈ 50% RAM là hợp lý.',
      });
    }
    const near = n.breakers.filter((b) => b.limit > 0 && b.estimated / b.limit >= BREAKER_NEAR);
    if (near.length) {
      out.push({
        id: `breaker:${n.name}`,
        level: 'warn',
        title: `Node ${n.name}: circuit breaker sắp ngắt (${near.map((b) => b.name).join(', ')})`,
        evidence: near.map((b) => `${b.name}: ${fmtBytes(b.estimated)} / ${fmtBytes(b.limit)} (${pct((b.estimated / b.limit) * 100)})`),
        fix: 'Request kế tiếp có thể bị từ chối với CircuitBreakingException. Xem query/aggregation nặng đang chạy.',
        sql: 'GET _tasks?actions=*search*&detailed=true',
      });
    }
  }

  // ── CPU: việc gì đang ăn CPU ──
  for (const n of f.nodes) {
    if ((n.cpu ?? 0) < CPU_HOT) continue;
    const byKind = new Map<string, number>();
    for (const t of n.hotThreads) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + t.pct);
    const top = [...byKind.entries()].sort((a, b) => b[1] - a[1])[0];
    const kind = top?.[0];
    const fixes: Record<string, string> = {
      search: 'Tìm query nặng: bật slow log, xem _tasks đang chạy. Hay gặp: wildcard/regex đầu chuỗi, aggregation nhiều bucket, script, deep pagination (from lớn). Thêm replica + node để chia tải đọc.',
      write: 'Tải ghi cao: tăng refresh_interval (vd 30s) cho index ghi nhiều, bulk vừa phải (5–15MB/lô), tắt replica trong lúc nạp hàng loạt.',
      bulk: 'Tải ghi cao: tăng refresh_interval, bulk vừa phải, tắt replica khi nạp hàng loạt.',
      merge: 'Merge segment liên tục: thường do refresh quá dày (nhiều segment nhỏ) → tăng refresh_interval; tránh force_merge index đang ghi.',
      gc: 'CPU bị GC ăn — là triệu chứng của heap (xem mục heap của node này).',
    };
    out.push({
      id: `cpu:${n.name}`,
      level: (n.cpu ?? 0) >= 95 ? 'crit' : 'warn',
      title: `Node ${n.name}: CPU ${n.cpu}%${kind ? ` — chủ yếu do ${KIND_TEXT[kind] ?? kind}` : ''}`,
      evidence: [
        n.hotThreads.length
          ? `Luồng nóng nhất: ${n.hotThreads.slice(0, 3).map((t) => `${t.pct}% ${t.thread}`).join(' · ')}`
          : 'Không đọc được hot_threads',
        n.queue.search || n.queue.write ? `Hàng đợi: search ${n.queue.search} · write ${n.queue.write}` : '',
      ].filter(Boolean),
      fix: (kind && fixes[kind]) || 'Xem hot_threads chi tiết để biết luồng nào bận.',
      sql: kind === 'search'
        ? 'GET _tasks?actions=*search*&detailed=true\nPUT <index>/_settings\n{ "index.search.slowlog.threshold.query.warn": "2s" }'
        : kind === 'write' || kind === 'bulk' || kind === 'merge'
          ? 'PUT <index>/_settings\n{ "index.refresh_interval": "30s" }'
          : `GET _nodes/${n.name}/hot_threads?threads=5`,
      step: { phase: 'now', text: `CPU node ${n.name}: xử lý ${kind ? KIND_TEXT[kind] ?? kind : 'luồng nóng'}` },
    });
  }

  // ── Thread pool bị từ chối ──
  const rej = f.nodes.filter((n) => n.rejected.search + n.rejected.write > 0);
  if (rej.length) {
    const s = rej.reduce((a, n) => a + n.rejected.search, 0);
    const w = rej.reduce((a, n) => a + n.rejected.write, 0);
    out.push({
      id: 'rejected',
      level: 'crit',
      title: `Request bị từ chối trong ${f.windowSec}s: ${fmtN(s)} search · ${fmtN(w)} write`,
      evidence: rej.map((n) => `${n.name}: search ${n.rejected.search} · write ${n.rejected.write} (hàng đợi ${n.queue.search}/${n.queue.write})`),
      fix: w > s
        ? 'Ứng dụng nhận lỗi 429 khi ghi: giảm số luồng bulk song song / kích thước lô, retry có backoff; tải ghi vượt sức cụm thì thêm node.'
        : 'Ứng dụng nhận lỗi 429 khi tìm: giảm query đồng thời / query nặng; thêm replica + node để chia tải đọc. Đừng tăng queue_size — chỉ dời lỗi sang timeout.',
      sql: 'GET _cat/thread_pool/search,write?v&h=node_name,name,active,queue,rejected,completed',
      step: { phase: 'now', text: `Giảm tải ${w > s ? 'ghi' : 'tìm kiếm'} — cụm đang từ chối request (429)` },
    });
  }

  // ── Shard: số lượng, kích thước, cân bằng ──
  const totalShards = f.shardSizes.length || f.activeShards;
  const maxPerNode = f.maxShardsPerNode ?? DEFAULT_MAX_SHARDS;
  const perNode = dataNodes.length ? totalShards / dataNodes.length : 0;
  if (dataNodes.length && perNode >= maxPerNode * 0.8) {
    out.push({
      id: 'shard-limit',
      level: perNode >= maxPerNode * 0.95 ? 'crit' : 'warn',
      title: `${fmtN(totalShards)} shard / ${dataNodes.length} node data — ${pct((perNode / maxPerNode) * 100)} giới hạn max_shards_per_node`,
      evidence: [`cluster.max_shards_per_node = ${maxPerNode}; chạm giới hạn thì KHÔNG tạo được index mới (rollover hỏng theo)`],
      fix: 'Giảm số shard (gộp/xoá index nhỏ, rollover theo dung lượng). Nâng max_shards_per_node chỉ là hoãn — mỗi shard tốn heap.',
      sql: 'GET _cat/indices?v&s=pri:desc&h=index,pri,rep,docs.count,store.size',
      step: { phase: 'now', text: 'Giảm số shard — sắp chạm max_shards_per_node (không tạo được index mới)' },
    });
  }
  const small = f.shardSizes.filter((s) => s.bytes < SMALL_SHARD).length;
  if (totalShards >= 100 && small / totalShards >= 0.5) {
    out.push({
      id: 'small-shards',
      level: 'info',
      title: `${pct((small / totalShards) * 100)} shard nhỏ hơn 1GB (${fmtN(small)}/${fmtN(totalShards)}) — quá nhiều shard nhỏ`,
      evidence: ['Mỗi shard tốn heap + cluster state cố định bất kể nhỏ hay lớn; shard nên 10–50GB'],
      fix: 'Index theo ngày mà dữ liệu ít → chuyển theo tháng hoặc rollover theo dung lượng; giảm number_of_shards của template (1 shard là đủ cho index < 30GB); shrink index cũ.',
      sql: 'PUT _index_template/<template>\n{ "index_patterns": ["<pattern>-*"], "template": { "settings": { "number_of_shards": 1 } } }',
      step: { phase: 'long', text: 'Giảm số shard nhỏ: index theo tháng / rollover theo dung lượng, 1 shard cho index nhỏ' },
    });
  }
  const huge = f.shardSizes.filter((s) => s.bytes > HUGE_SHARD).sort((a, b) => b.bytes - a.bytes);
  if (huge.length) {
    out.push({
      id: 'huge-shards',
      level: 'info',
      title: `${huge.length} shard lớn hơn 50GB`,
      evidence: huge.slice(0, 5).map((s) => `${s.index}[${s.shard}] ${fmtBytes(s.bytes)}`),
      fix: 'Shard quá lớn làm khôi phục/dời shard rất lâu (node chết là cụm yellow hàng giờ). Rollover theo max_primary_shard_size ~50GB, hoặc split index.',
      step: { phase: 'long', text: 'Rollover / split các index có shard > 50GB' },
    });
  }
  if (dataNodes.length >= 2) {
    const counts = dataNodes.map((n) => n.shards);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    if (min > 0 && max / min >= 1.5 && max - min >= 20) {
      out.push({
        id: 'imbalance',
        level: 'info',
        title: `Shard lệch giữa các node: ${max} vs ${min}`,
        evidence: dataNodes.map((n) => `${n.name}: ${n.shards}`),
        fix: 'Thường do luật allocation (filter / awareness / total_shards_per_node) hoặc node vừa thêm. Kiểm tra _cat/allocation.',
        sql: 'GET _cat/allocation?v',
      });
    }
  }

  // ── Pending task ──
  if (f.pending.length) {
    const total = f.pending.reduce((a, p) => a + p.count, 0);
    const top = f.pending[0];
    out.push({
      id: 'pending',
      level: total >= 100 ? 'crit' : total >= 20 ? 'warn' : 'info',
      title: `${fmtN(total)} cluster task đang chờ master — nhiều nhất: ${top.source} (${top.count})`,
      evidence: f.pending.slice(0, 5).map((p) => `${p.source}: ${p.count}`),
      fix: /put-mapping|mapping/.test(top.source)
        ? 'Mapping bị cập nhật liên tục — dynamic mapping đang nở field mới (mapping explosion). Đặt "dynamic": "strict" hoặc false cho phần dữ liệu tự do, dùng flattened field.'
        : /shard-started|shard-failed|reroute/.test(top.source)
          ? 'Master bận khôi phục / dời shard hàng loạt — thường đi kèm node vừa rời/vào cụm. Chờ, hoặc giảm số shard.'
          : /create-index|delete-index/.test(top.source)
            ? 'Tạo/xoá index quá dày (index theo giờ? test tạo index?) — gộp index.'
            : 'Master không xử lý kịp thay đổi cluster state — kiểm tra node master (CPU/heap) và số shard.',
      sql: 'GET _cluster/pending_tasks',
    });
  }

  const findings = sortFindings(out);
  const nodes: EsNodeRow[] = f.nodes.map((n) => {
    const kinds = new Map<string, number>();
    for (const t of n.hotThreads) kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + t.pct);
    const top = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      name: n.name,
      roles: n.roles,
      heapPct: n.heapPct,
      gcOldPct: Math.round((n.oldGcMs / winMs) * 1000) / 10,
      cpu: n.cpu,
      diskPct: n.diskTotal && n.diskAvail !== null ? Math.round(100 - (n.diskAvail / n.diskTotal) * 100) : null,
      shards: n.shards,
      rejected: n.rejected.search + n.rejected.write,
      top: top ? KIND_TEXT[top[0]] ?? top[0] : null,
    };
  });
  return {
    at,
    status: f.status,
    headline: headline(f, findings),
    findings,
    plan: buildPlan(findings, 'Phân tích lại sau khi xử lý — cụm phải về green, heap < 85%, không còn request bị từ chối'),
    nodes,
    windowSec: f.windowSec,
  };
}

function headline(f: EsFacts, findings: Finding[]): string {
  const cause = findings.find((x) => x.level === 'crit' || x.level === 'warn');
  const st = `Cụm ${f.status}`;
  if (!cause) return `${st} — không thấy vấn đề về heap, shard, CPU, đĩa trong ${f.windowSec}s đo.`;
  return `${st} — vấn đề chính: ${cause.title.charAt(0).toLowerCase()}${cause.title.slice(1)}.`;
}
