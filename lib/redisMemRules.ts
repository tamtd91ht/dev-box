// Phân tích RAM đã dùng của Redis — phần LUẬT thuần: RAM đang nằm ở đâu, khi đầy
// thì chuyện gì xảy ra, đang tăng nhanh cỡ nào, và nên làm gì.
//
// Số liệu do lib/redisMemDiagnose.ts gom. Hai mức:
//   • Cơ bản (luôn chạy, chỉ lệnh O(1)): INFO + MEMORY STATS + CONFIG GET → tách
//     used_memory thành dữ liệu / bộ đệm client / bộ đệm replica / backlog / Lua /
//     bảng băm key; chính sách khi đầy; evict + hết hạn trong cửa sổ đo; tỉ lệ key
//     không TTL; xu hướng tăng từ lịch sử Monitor.
//   • Lấy mẫu key (người dùng bấm): SCAN có giới hạn + MEMORY USAGE trên vài nghìn
//     key → dạng key nào chiếm RAM (ước lượng theo tỉ lệ mẫu), key lớn trong mẫu.
// Thuần để kiểm bằng script (check:redis-mem) và để client import kiểu.
//
// Nguyên tắc: không đoán. Số từ mẫu luôn ghi là ước lượng; không có mẫu thì không
// nêu dạng key. App không tự chạy lệnh sửa nào; lệnh đề xuất chạy trên luồng chính
// (DEL key lớn, SCRIPT FLUSH…) đều kèm cách an toàn — mọi Redis ở đây là production.

import { buildPlan, fmtBytes, fmtN, fmtSec, share, sortFindings, type Finding, type PlanStep } from '@/lib/diagnose';

export interface MemTopClient {
  addr: string;
  name: string;
  cmd: string;
  /** Bộ nhớ client chiếm (tot-mem nếu có, không thì omem + qbuf). */
  bytes: number;
  omem: number;
}

export interface MemNode {
  addr: string;
  version: string;
  role: string;
  used: number;
  /** 0 = không đặt maxmemory. */
  maxmemory: number;
  /** 0 = không biết. */
  system: number;
  rss: number;
  peak: number;
  dataset: number | null;
  /** Các phần overhead (byte); null = Redis không báo. */
  parts: {
    clientsNormal: number | null;
    clientsReplicas: number | null;
    replBacklog: number | null;
    aofBuffer: number | null;
    scripts: number | null;
    hashtables: number | null;
  };
  keys: number;
  /** Số key có TTL. */
  expires: number;
  bytesPerKey: number | null;
  clients: number;
  policy: string | null;
  /** CONFIG save (RDB) — '' = tắt; null = không đọc được. */
  save: string | null;
  aof: boolean | null;
  evictedPerSec: number | null;
  expiredPerSec: number | null;
  expiredStalePct: number | null;
  /** Lệnh bị từ chối vì OOM (errorstats, Redis ≥ 6.2) — cộng dồn. */
  oomErrors: number | null;
  lastCowBytes: number | null;
  /** CLIENT LIST chỉ chạy khi bộ đệm client lớn VÀ ít client; null = không chạy. */
  topClients: MemTopClient[] | null;
}

export interface MemPattern {
  db: number;
  pattern: string;
  /** Số key trong mẫu đã đo. */
  count: number;
  /** Tổng byte (MEMORY USAGE) của các key mẫu. */
  bytes: number;
  /** Key mẫu không có TTL. */
  noTtl: number;
  maxKey: string;
  maxBytes: number;
}

export interface MemSample {
  scanned: number;
  dbsize: number;
  measured: number;
  /** Tổng byte của các key đã đo. */
  bytes: number;
  patterns: MemPattern[];
  topKeys: { db: number; key: string; bytes: number; type: string }[];
  /** Lý do dừng sớm (chậm bất thường, hết thời gian) — vẫn dùng phần đã có. */
  stopped?: string;
}

/** Danh sách key không TTL (Phân tích RAM → "Liệt kê key không TTL", lib/redisMemDiagnose.listNoTtlKeys). */
export interface NoTtlKey {
  db: number;
  key: string;
  pattern: string;
  /** TYPE; '?' khi không đo kịp. */
  type: string;
  /** MEMORY USAGE … SAMPLES 5; null khi không đo kịp (dừng sớm). */
  bytes: number | null;
}

export interface NoTtlKeyList {
  at: number;
  /** N người dùng yêu cầu (đã kẹp vào giới hạn). */
  requested: number;
  keys: NoTtlKey[];
  /** Key đã quét (SCAN) / đã hỏi TTL. */
  scanned: number;
  /** Trong số đã quét, bao nhiêu key không TTL — để ra tỉ lệ thực tế của mẫu. */
  scannedNoTtl: number;
  /** Tổng keyspace và tổng key không TTL theo INFO keyspace (keys − expires). */
  dbsize: number;
  noTtlTotal: number;
  /** Lý do dừng sớm (chậm, hết thời gian, hết ngân sách quét) — vẫn trả phần đã có. */
  stopped?: string;
  /** Không chạy (CPU cao…) — lý do. */
  refused?: string;
  skipped: { addr: string; error: string }[];
}

export interface RedisMemFacts {
  nodes: MemNode[];
  /** memUsedMb theo thời gian từ Monitor (tổng các node). */
  history: { at: number; mb: number }[];
  sample: MemSample | null;
  /** Không lấy mẫu (CPU cao…) — lý do. */
  sampleRefused?: string;
  configError?: string;
  skipped: { addr: string; error: string }[];
  sampleSec: number;
}

export interface MemPatternRow extends MemPattern {
  sharePct: number;
  /** Ước lượng trên toàn bộ dữ liệu = tỉ lệ mẫu × dataset. */
  estBytes: number;
  noTtlPct: number;
}

export interface RedisMemDiagnosis {
  at: number;
  headline: string;
  findings: Finding[];
  plan: PlanStep[];
  /** Phân bổ RAM của node căng nhất. */
  breakdown: { label: string; bytes: number }[];
  usedPct: number | null;
  used: number;
  limit: number;
  limitKind: 'maxmemory' | 'system' | 'none';
  /** MB/giờ từ lịch sử Monitor; null = chưa đủ lịch sử. */
  growthMbPerHour: number | null;
  patterns: MemPatternRow[] | null;
  topKeys: MemSample['topKeys'];
  sample: { scanned: number; dbsize: number; measured: number; stopped?: string } | null;
  sampleRefused?: string;
  skipped: { addr: string; error: string }[];
}

// ── Ngưỡng ───────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
/** Khớp luật Monitor (memUsedPct): vàng 80, đỏ 90. */
const WARN_PCT = 80;
const CRIT_PCT = 90;
const CLIENT_BUF_MIN = 64 * MB;
const SCRIPTS_MIN = 64 * MB;
const BIG_KEY = 10 * MB;
const PATTERN_SHARE_MIN = 10;
/** Lịch sử ít hơn ngần này thì không tính xu hướng (dao động ngắn hạn). */
const TREND_MIN_SPAN_MS = 10 * 60 * 1000;
const TREND_MIN_POINTS = 5;

const isVolatile = (p: string | null) => !!p && p.startsWith('volatile-');
const limitOf = (n: MemNode) => n.maxmemory || n.system;
const pctOf = (n: MemNode) => (limitOf(n) ? (n.used / limitOf(n)) * 100 : null);
const r0 = (x: number) => Math.round(x);

/** Hệ số góc (MB/giờ) bằng bình phương tối thiểu — bền hơn hiệu đầu/cuối khi có nhiễu. */
export function growthPerHour(h: { at: number; mb: number }[]): number | null {
  const pts = h.filter((p) => Number.isFinite(p.mb));
  if (pts.length < TREND_MIN_POINTS || pts[pts.length - 1].at - pts[0].at < TREND_MIN_SPAN_MS) return null;
  const t0 = pts[0].at;
  const xs = pts.map((p) => (p.at - t0) / 3_600_000);
  const mx = xs.reduce((a, x) => a + x, 0) / xs.length;
  const my = pts.reduce((a, p) => a + p.mb, 0) / pts.length;
  let num = 0;
  let den = 0;
  pts.forEach((p, i) => { num += (xs[i] - mx) * (p.mb - my); den += (xs[i] - mx) ** 2; });
  return den > 0 ? num / den : null;
}

// ── Phân tích ────────────────────────────────────────────────────────────

export function analyzeRedisMem(f: RedisMemFacts, at = Date.now()): RedisMemDiagnosis {
  // Node căng nhất quyết định cảnh báo (Monitor lấy max memUsedPct).
  const nodes = [...f.nodes].sort((a, b) => (pctOf(b) ?? 0) - (pctOf(a) ?? 0));
  const n = nodes[0];
  const multi = nodes.length > 1;
  const at_ = multi && n ? ` (${n.addr})` : '';
  const out: Finding[] = [];
  const usedPct = n ? pctOf(n) : null;
  const limitKind: RedisMemDiagnosis['limitKind'] = !n ? 'none' : n.maxmemory ? 'maxmemory' : n.system ? 'system' : 'none';

  if (!n) {
    return {
      at, headline: 'Không node nào trả lời — chưa phân tích được.', findings: [], plan: [], breakdown: [], usedPct: null,
      used: 0, limit: 0, limitKind: 'none', growthMbPerHour: null, patterns: null, topKeys: [], sample: null, skipped: f.skipped,
    };
  }

  // Phân bổ RAM: dữ liệu + từng phần overhead; phần còn lại là overhead khởi động / khác.
  const p = n.parts;
  const named: [string, number | null][] = [
    ['Bộ đệm client', p.clientsNormal],
    ['Bộ đệm replica', p.clientsReplicas],
    ['Replication backlog', p.replBacklog],
    ['Bộ đệm AOF', p.aofBuffer],
    ['Script Lua / function', p.scripts],
    ['Bảng băm key (dict + expires)', p.hashtables],
  ];
  const known = named.filter((x): x is [string, number] => x[1] !== null && x[1] > 0);
  const dataset = n.dataset ?? Math.max(0, n.used - known.reduce((a, x) => a + x[1], 0));
  const other = Math.max(0, n.used - dataset - known.reduce((a, x) => a + x[1], 0));
  const breakdown = [
    { label: 'Dữ liệu (value + cấu trúc)', bytes: dataset },
    ...known.map(([label, bytes]) => ({ label, bytes })),
    ...(other > MB ? [{ label: 'Khác (khởi động, nội bộ)', bytes: other }] : []),
  ].sort((a, b) => b.bytes - a.bytes);

  // 1. Không đặt maxmemory — giới hạn thật là RAM máy, chạm là OOM killer.
  if (!n.maxmemory) {
    out.push({
      id: 'no-maxmemory',
      level: usedPct !== null && usedPct >= 60 ? 'crit' : 'warn',
      title: `Không đặt maxmemory${at_} — Redis lớn tới khi hết RAM máy rồi bị OOM killer giết`,
      evidence: [
        n.system ? `Đang dùng ${fmtBytes(n.used)} / RAM máy ${fmtBytes(n.system)} (${r0(usedPct ?? 0)}%)` : 'Không biết RAM máy chủ (Redis managed thường giấu)',
        'Chính sách evict chỉ có tác dụng khi có maxmemory',
      ],
      fix: 'Đặt maxmemory khoảng 60–75% RAM máy (chừa chỗ cho phân mảnh và copy-on-write khi BGSAVE) và chọn chính sách evict hợp với dữ liệu. CONFIG SET có hiệu lực ngay, không restart; nếu maxmemory mới thấp hơn dữ liệu hiện có, Redis sẽ evict ngay một loạt key (allkeys-*) hoặc từ chối ghi (noeviction) — đặt dần từ trên xuống.',
      sql: `CONFIG SET maxmemory ${n.system ? `${r0((n.system * 0.7) / MB)}mb   # ~70% RAM máy` : '<~70% RAM máy>'}\nCONFIG SET maxmemory-policy allkeys-lru   # cache thuần; dữ liệu không được mất thì giữ noeviction\nCONFIG REWRITE`,
      step: { phase: 'now', text: 'Đặt maxmemory ~70% RAM máy + chính sách evict' },
    });
  }

  // 2. Khi đầy thì chuyện gì xảy ra — theo chính sách.
  const ttlPct = n.keys ? (n.expires / n.keys) * 100 : 0;
  const hot = usedPct !== null && usedPct >= WARN_PCT;
  if (n.maxmemory && n.policy === 'noeviction') {
    const rejected = (n.oomErrors ?? 0) > 0;
    if (hot || rejected) {
      out.push({
        id: 'noeviction',
        level: rejected || (usedPct ?? 0) >= CRIT_PCT ? 'crit' : 'warn',
        title: rejected
          ? `Đã có ${fmtN(n.oomErrors!)} lệnh ghi bị từ chối vì hết bộ nhớ (noeviction)`
          : `noeviction ở ${r0(usedPct ?? 0)}% — chạm maxmemory là mọi lệnh ghi bị từ chối (OOM)`,
        evidence: [
          `maxmemory-policy noeviction · ${fmtBytes(n.used)} / ${fmtBytes(n.maxmemory)}`,
          rejected ? 'INFO errorstats: errorstat_OOM (cộng dồn từ lúc khởi động / CONFIG RESETSTAT)' : '',
        ].filter(Boolean),
        fix: 'noeviction đúng khi Redis là nơi lưu dữ liệu không được mất (queue, session quan trọng): khi đó phải tăng maxmemory / RAM hoặc giảm dữ liệu (TTL, dọn dạng key không dùng — xem mục lấy mẫu). Nếu đây là cache thuần, đổi sang allkeys-lru / allkeys-lfu để Redis tự bỏ key ít dùng.',
        sql: 'CONFIG SET maxmemory <lớn hơn>   # nếu máy còn RAM\nCONFIG SET maxmemory-policy allkeys-lru   # CHỈ khi là cache thuần',
        step: { phase: 'now', text: 'noeviction sắp đầy: tăng maxmemory hoặc giảm dữ liệu (cache thuần thì đổi allkeys-lru)' },
      });
    }
  } else if (n.maxmemory && isVolatile(n.policy) && n.keys >= 1000 && ttlPct < 20) {
    out.push({
      id: 'volatile-no-ttl',
      level: hot ? 'crit' : 'warn',
      title: `${n.policy} nhưng chỉ ${r0(ttlPct)}% key có TTL — khi đầy gần như không có gì để evict`,
      evidence: [`${fmtN(n.expires)} / ${fmtN(n.keys)} key có TTL`, 'volatile-* chỉ evict key CÓ TTL; hết key đó thì từ chối ghi như noeviction'],
      fix: 'Hoặc đặt TTL cho các dạng key cache (xem mục lấy mẫu để biết dạng nào thiếu TTL), hoặc đổi sang allkeys-lru / allkeys-lfu nếu toàn bộ là cache.',
      sql: 'CONFIG SET maxmemory-policy allkeys-lru   # nếu toàn bộ là cache',
      step: { phase: 'now', text: 'volatile-* mà ít key có TTL: thêm TTL hoặc đổi allkeys-lru' },
    });
  }

  // 3. Đang evict.
  const evicting = nodes.filter((x) => (x.evictedPerSec ?? 0) > 0);
  if (evicting.length) {
    const e = evicting[0];
    out.push({
      id: 'evicting',
      level: (e.evictedPerSec ?? 0) >= 100 ? 'crit' : 'warn',
      title: `Đang evict ${fmtN(e.evictedPerSec!)} key/giây${multi ? ` (${e.addr})` : ''} — Redis đã chạm maxmemory`,
      evidence: [`Đo trong ${f.sampleSec}s · chính sách ${e.policy ?? '?'}`, 'Key bị evict sẽ thành miss ở lần đọc sau → hit rate giảm, tải dồn về DB'],
      fix: 'Evict liên tục nghĩa là dữ liệu cần giữ lớn hơn maxmemory. Tăng maxmemory (máy còn RAM) hoặc giảm dữ liệu: TTL ngắn hơn cho dạng key ít đọc lại, bỏ cache dạng key chiếm nhiều mà ít dùng (xem mục lấy mẫu).',
      step: { phase: 'now', text: `Đang evict ${fmtN(e.evictedPerSec!)} key/s — tăng maxmemory hoặc giảm dữ liệu` },
    });
  }

  // 4. Xu hướng tăng từ lịch sử Monitor.
  const growth = growthPerHour(f.history);
  const limitAll = nodes.reduce((a, x) => a + limitOf(x), 0);
  const usedAll = nodes.reduce((a, x) => a + x.used, 0);
  if (growth !== null) {
    const span = (f.history[f.history.length - 1].at - f.history[0].at) / 1000;
    const growsMb = Math.abs(growth) >= 1;
    if (growth > 0 && growsMb && limitAll > usedAll) {
      const hours = (limitAll - usedAll) / MB / growth;
      out.push({
        id: 'trend',
        level: hours < 6 ? 'crit' : hours < 48 ? 'warn' : 'info',
        title: `RAM đang tăng ~${fmtN(growth)} MB/giờ — chạm giới hạn sau ~${fmtSec(hours * 3600)} nếu giữ tốc độ này`,
        evidence: [`Từ ${f.history.length} lần đo của Monitor trong ${fmtSec(span)} gần nhất`, `Còn trống ${fmtBytes(limitAll - usedAll)}`, 'Ngoại suy tuyến tính trên cửa sổ ngắn — đột biến tạm thời cũng làm số này lớn'],
        fix: 'Tăng đều thường là dữ liệu không TTL tích dần, hoặc TTL dài hơn tốc độ tạo key mới. Xem tỉ lệ key không TTL và mục lấy mẫu để biết dạng nào đang lớn.',
        step: hours < 48 ? { phase: 'now', text: `Xử lý trước khi đầy (~${fmtSec(hours * 3600)}): TTL cho dạng key tích dần / tăng maxmemory` } : undefined,
      });
    } else {
      out.push({
        id: 'trend',
        level: 'ok',
        title: growth > 0 && growsMb ? `RAM tăng ~${fmtN(growth)} MB/giờ` : `RAM ổn định trong ${fmtSec(span)} gần nhất`,
        evidence: [`Từ ${f.history.length} lần đo của Monitor`],
      });
    }
  }

  // 5. Key không TTL — dữ liệu chỉ có tăng.
  if (n.keys >= 10_000 && ttlPct < 50 && !out.some((x) => x.id === 'volatile-no-ttl')) {
    out.push({
      id: 'no-ttl',
      level: hot ? 'warn' : 'info',
      title: `${r0(100 - ttlPct)}% key không có TTL — chỉ mất đi khi bị xoá chủ động${n.policy?.startsWith('allkeys') ? ' hoặc evict' : ''}`,
      evidence: [`${fmtN(n.keys - n.expires)} / ${fmtN(n.keys)} key không TTL${at_}`],
      fix: 'Key cache nên có TTL (kể cả dài) để dữ liệu không dùng tự biến mất. Bấm "Lấy mẫu key" để biết dạng key nào không TTL và chiếm bao nhiêu; "Liệt kê key không TTL" (chọn N) để lấy danh sách key cụ thể.',
      step: { phase: 'long', text: 'Đặt TTL cho các dạng key cache đang không có TTL' },
    });
  }

  // 6. Hết hạn không kịp dọn.
  if ((n.expiredStalePct ?? 0) >= 25 && n.expires >= 10_000) {
    out.push({
      id: 'expire-lag',
      level: 'info',
      title: `~${r0(n.expiredStalePct!)}% key có TTL đã hết hạn mà chưa được dọn — RAM vẫn giữ`,
      evidence: [`expired_stale_perc ${r0(n.expiredStalePct!)}% · đang hết hạn ${fmtN(n.expiredPerSec ?? 0)} key/s`],
      fix: 'Chu trình dọn key hết hạn chạy theo lát trên luồng chính và đang không theo kịp. Có thể nâng active-expire-effort (Redis ≥ 6, 1–10, mặc định 1) lên 2–3 — đổi chút CPU lấy dọn nhanh hơn; nâng từng bước và theo dõi latency.',
      sql: 'CONFIG GET active-expire-effort\nCONFIG SET active-expire-effort 2',
      step: { phase: 'observe', text: 'Key hết hạn dọn không kịp — cân nhắc active-expire-effort 2' },
    });
  }

  // 7. Bộ đệm client (pub/sub chậm, MONITOR, reply lớn).
  const cb = p.clientsNormal ?? 0;
  if (cb >= CLIENT_BUF_MIN) {
    const top = n.topClients;
    out.push({
      id: 'client-buffers',
      level: cb >= n.used * 0.2 ? 'crit' : 'warn',
      title: `Bộ đệm của client chiếm ${fmtBytes(cb)} (${r0(share(cb, n.used))}% RAM)${at_}`,
      evidence: [
        `${fmtN(n.clients)} client đang kết nối`,
        ...(top?.length ? top.slice(0, 5).map((c) => `${c.addr}${c.name ? ` (${c.name})` : ''} · lệnh cuối ${c.cmd} · ${fmtBytes(c.bytes)}${c.omem ? ` (output ${fmtBytes(c.omem)})` : ''}`) : []),
        top === null ? 'Không chạy CLIENT LIST (quá nhiều client — tốn luồng chính); tự chạy lúc thấp điểm để biết client nào' : '',
      ].filter(Boolean),
      fix: 'Thường do: subscriber pub/sub đọc chậm (output buffer phình), client MONITOR đang mở, lệnh trả kết quả rất lớn (KEYS, HGETALL / LRANGE key lớn), pipeline quá dài. Sửa phía client đó; đặt client-output-buffer-limit cho pubsub để Redis tự ngắt client chậm thay vì phình RAM.',
      sql: 'CLIENT LIST   # lúc thấp điểm: xem cột omem / tot-mem / cmd\nCONFIG SET client-output-buffer-limit "pubsub 32mb 8mb 60"\nCLIENT KILL ID <id>   # client đang giữ buffer lớn, sau khi xác nhận',
      step: { phase: 'now', text: 'Tìm và sửa client giữ bộ đệm lớn (pub/sub chậm, MONITOR, reply lớn)' },
    });
  }
  if ((p.clientsReplicas ?? 0) >= CLIENT_BUF_MIN) {
    out.push({
      id: 'replica-buffers',
      level: 'warn',
      title: `Bộ đệm gửi replica chiếm ${fmtBytes(p.clientsReplicas)}${at_} — replica đọc không kịp hoặc đang đồng bộ lại`,
      evidence: ['Master giữ dữ liệu chờ gửi cho replica trong RAM'],
      fix: 'Kiểm tra mạng / tải của replica và INFO replication (lag, sync đang chạy). Đồng bộ lại liên tục thường do repl-backlog-size quá nhỏ so với lượng ghi.',
      sql: 'INFO replication',
      step: { phase: 'now', text: 'Kiểm tra replica chậm / đồng bộ lại liên tục' },
    });
  }
  if ((p.scripts ?? 0) >= SCRIPTS_MIN) {
    out.push({
      id: 'scripts',
      level: 'warn',
      title: `Cache script Lua chiếm ${fmtBytes(p.scripts)} — ứng dụng gửi script có giá trị nhúng sẵn`,
      evidence: ['Mỗi nội dung EVAL khác nhau được Redis cache lại mãi'],
      fix: 'Sửa ứng dụng truyền giá trị qua KEYS / ARGV thay vì ghép vào thân script, dùng EVALSHA. SCRIPT FLUSH xoá cache (chạy trên luồng chính; ASYNC từ Redis 6.2) — ứng dụng dùng EVALSHA sẽ gặp NOSCRIPT một lần rồi nạp lại.',
      sql: 'SCRIPT FLUSH ASYNC   # Redis ≥ 6.2, lúc thấp điểm',
      step: { phase: 'long', text: 'Sửa ứng dụng: tham số qua ARGV thay vì ghép vào script' },
    });
  }
  if ((p.replBacklog ?? 0) >= n.used * 0.15 && (p.replBacklog ?? 0) >= CLIENT_BUF_MIN) {
    out.push({
      id: 'backlog',
      level: 'info',
      title: `Replication backlog chiếm ${fmtBytes(p.replBacklog)} (${r0(share(p.replBacklog!, n.used))}% RAM)`,
      evidence: ['Kích thước cố định theo repl-backlog-size'],
      fix: 'Chỉ giảm nếu chắc replica không cần đồng bộ lại một phần sau khi rớt mạng lâu.',
    });
  }

  // 8. Nhiều key rất nhỏ — overhead mỗi key lớn hơn dữ liệu.
  if ((p.hashtables ?? 0) >= n.used * 0.25 && n.keys >= 100_000) {
    out.push({
      id: 'tiny-keys',
      level: 'info',
      title: `Bảng băm key chiếm ${r0(share(p.hashtables!, n.used))}% RAM — rất nhiều key nhỏ${n.bytesPerKey ? ` (~${fmtN(n.bytesPerKey)} byte/key)` : ''}`,
      evidence: [`${fmtN(n.keys)} key · bảng băm ${fmtBytes(p.hashtables)}`],
      fix: 'Mỗi key tốn thêm vài chục byte overhead. Gom các key nhỏ cùng nhóm vào một hash (vd user:123:a, user:123:b → HSET user:123 a … b …) — hash nhỏ được lưu dạng listpack rất gọn.',
      step: { phase: 'long', text: 'Gom key nhỏ cùng nhóm vào hash để giảm overhead mỗi key' },
    });
  }

  // 9. Fork khi lưu đĩa có thể nhân đôi RAM.
  const persists = (n.save !== null && n.save.trim() !== '') || n.aof === true;
  if (persists && n.system && n.used >= n.system * 0.45) {
    out.push({
      id: 'fork',
      level: n.used >= n.system * 0.6 ? 'warn' : 'info',
      title: `Dữ liệu ${r0(share(n.used, n.system))}% RAM máy mà vẫn ${n.aof ? 'AOF' : 'BGSAVE'} — fork có thể đẩy RAM vượt máy`,
      evidence: [
        `Lưu đĩa: ${[n.save ? `save "${n.save}"` : '', n.aof ? 'appendonly yes' : ''].filter(Boolean).join(' · ')}`,
        n.lastCowBytes ? `Copy-on-write lần fork gần nhất: ${fmtBytes(n.lastCowBytes)}` : '',
      ].filter(Boolean),
      fix: 'Khi fork, trang bị ghi trong lúc lưu được nhân đôi — ghi nhiều thì RAM có thể tăng gần gấp đôi phần dữ liệu đó. Giữ maxmemory ≤ ~50–60% RAM máy, tắt Transparent Huge Pages, hoặc chỉ lưu đĩa trên replica.',
      step: { phase: 'long', text: 'Chừa RAM cho fork (maxmemory ≤ ~60% RAM) hoặc lưu đĩa trên replica' },
    });
  }

  // 10. Mẫu key: dạng nào chiếm RAM.
  let patterns: MemPatternRow[] | null = null;
  if (f.sample && f.sample.measured > 0) {
    const s = f.sample;
    const total = Math.max(1, s.bytes);
    const dsAll = nodes.reduce((a, x) => a + (x.dataset ?? x.used), 0);
    patterns = [...s.patterns].sort((a, b) => b.bytes - a.bytes).map((x) => ({
      ...x, sharePct: share(x.bytes, total), estBytes: (x.bytes / total) * dsAll, noTtlPct: x.count ? r0((x.noTtl / x.count) * 100) : 0,
    }));
    const note = `Ước lượng từ ${fmtN(s.measured)} key đo trên ${fmtN(s.scanned)} key quét (keyspace ${fmtN(s.dbsize)})${s.stopped ? ` · dừng sớm: ${s.stopped}` : ''}`;
    for (const x of patterns.filter((y) => y.sharePct >= PATTERN_SHARE_MIN).slice(0, 5)) {
      const where = `${x.pattern}${x.db ? ` (db ${x.db})` : ''}`;
      out.push({
        id: `pat:${x.db}:${x.pattern}`,
        level: x.sharePct >= 40 && hot ? 'warn' : 'info',
        title: `${where} chiếm ~${x.sharePct}% dữ liệu (~${fmtBytes(x.estBytes)})${x.noTtlPct >= 50 ? ` — ${x.noTtlPct}% không TTL` : ''}`,
        evidence: [
          `${fmtN(x.count)} key trong mẫu · trung bình ${fmtBytes(x.bytes / Math.max(1, x.count))}/key · lớn nhất ${x.maxKey} (${fmtBytes(x.maxBytes)})`,
          note,
        ],
        fix: x.noTtlPct >= 50
          ? 'Dạng này phần lớn không TTL — nếu là cache, đặt TTL ở chỗ ghi; nếu là dữ liệu lâu dài, xác nhận còn dùng không và có cần nằm trong Redis không.'
          : 'Dạng chiếm RAM nhiều nhất — rút ngắn TTL nếu ít đọc lại, nén / bỏ bớt field không cần trong value, hoặc tách ra instance riêng.',
        sql: `SCAN 0 MATCH ${x.pattern.replace(/\{[a-z]+\}/g, '*')} COUNT 100\nMEMORY USAGE ${x.maxKey}\nTTL ${x.maxKey}`,
        step: { phase: 'long', text: `${x.pattern}: ${x.noTtlPct >= 50 ? 'đặt TTL / dọn dữ liệu không còn dùng' : 'giảm kích thước / TTL cho dạng chiếm nhiều RAM nhất'}` },
      });
    }
    const bigs = s.topKeys.filter((k) => k.bytes >= BIG_KEY);
    if (bigs.length) {
      out.push({
        id: 'big-keys',
        level: 'warn',
        title: `${bigs.length} key lớn ≥ ${fmtBytes(BIG_KEY)} trong mẫu — đọc / xoá chúng chặn luồng chính`,
        evidence: [...bigs.slice(0, 5).map((k) => `${k.key}${k.db ? ` (db ${k.db})` : ''} · ${k.type} · ${fmtBytes(k.bytes)}`), 'Chỉ là key lớn RƠI VÀO MẪU — keyspace có thể còn key lớn khác'],
        fix: 'Đừng DEL key lớn trên production — dùng UNLINK (giải phóng nền). Đọc từng phần (HSCAN / SSCAN / ZSCAN / LRANGE có giới hạn) thay vì HGETALL / SMEMBERS. Dài hạn: chia key lớn thành nhiều key nhỏ.',
        sql: bigs.slice(0, 3).map((k) => `UNLINK ${k.key}   # chỉ khi chắc chắn bỏ`).join('\n'),
        step: { phase: 'long', text: 'Chia nhỏ key lớn; xoá bằng UNLINK, không DEL' },
      });
    }
  } else if (!f.sample) {
    out.push({
      id: 'no-sample',
      level: 'info',
      title: f.sampleRefused ? `Chưa lấy mẫu key: ${f.sampleRefused}` : 'Chưa biết dạng key nào chiếm RAM — bấm "Lấy mẫu key"',
      evidence: ['INFO chỉ cho tổng số; muốn biết dạng key nào chiếm RAM phải đo từng key mẫu (SCAN + MEMORY USAGE)'],
    });
  }

  // 11. RAM thật (RSS) còn lớn hơn — phân mảnh.
  if (n.rss >= n.used * 1.5 && n.rss - n.used >= 256 * MB) {
    out.push({
      id: 'frag-hint',
      level: 'info',
      title: `RAM thật (RSS ${fmtBytes(n.rss)}) lớn hơn dữ liệu ${fmtBytes(n.used)} — còn phân mảnh`,
      evidence: ['used_memory (số Monitor dùng) không tính phân mảnh'],
      fix: 'Xem "Phân tích phân mảnh" để biết phần thừa nằm ở đâu và thu hồi thế nào.',
    });
  }

  if (f.configError) {
    out.push({ id: 'config', level: 'info', title: 'Không đọc được CONFIG — chưa biết chính sách evict / lưu đĩa', evidence: [`CONFIG GET lỗi: ${f.configError}`] });
  }

  const findings = sortFindings(out);
  return {
    at,
    headline: headline(n, usedPct, limitKind, breakdown, findings, patterns),
    findings,
    plan: buildPlan(findings, 'Phân tích lại sau khi xử lý — theo dõi RAM trên Monitor'),
    breakdown,
    usedPct: usedPct === null ? null : Math.round(usedPct * 10) / 10,
    used: n.used,
    limit: limitOf(n),
    limitKind,
    growthMbPerHour: growth === null ? null : Math.round(growth * 10) / 10,
    patterns,
    topKeys: f.sample?.topKeys ?? [],
    sample: f.sample ? { scanned: f.sample.scanned, dbsize: f.sample.dbsize, measured: f.sample.measured, stopped: f.sample.stopped } : null,
    sampleRefused: f.sampleRefused,
    skipped: f.skipped,
  };
}

function headline(
  n: MemNode, usedPct: number | null, kind: RedisMemDiagnosis['limitKind'],
  breakdown: { label: string; bytes: number }[], findings: Finding[], patterns: MemPatternRow[] | null,
): string {
  const of = kind === 'maxmemory' ? 'maxmemory' : kind === 'system' ? 'RAM máy (không đặt maxmemory)' : '?';
  const head = `RAM ${usedPct === null ? '?' : `${r0(usedPct)}%`} của ${of}`;
  const crit = findings.find((x) => x.level === 'crit');
  if (crit) return `${head} — ${crit.title.charAt(0).toLowerCase()}${crit.title.slice(1)}.`;
  const top = patterns?.[0];
  if (top && top.sharePct >= 30) return `${head} — ${top.sharePct}% dữ liệu là dạng ${top.pattern}.`;
  const b = breakdown[0];
  return b ? `${head} — phần lớn là ${b.label.toLowerCase()} (${fmtBytes(b.bytes)}).` : `${head}.`;
}
