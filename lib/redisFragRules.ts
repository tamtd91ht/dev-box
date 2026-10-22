// Phân tích phân mảnh bộ nhớ Redis — phần LUẬT thuần: phân mảnh nằm ở đâu, vì sao, làm gì.
//
// Số liệu do lib/redisFragDiagnose.ts gom (INFO hai lần cách vài giây + CONFIG GET,
// chỉ đọc). File này tách RSS thừa ra từng phần mà INFO memory đã báo sẵn:
//
//   RSS ─┬─ rss_overhead       ngoài allocator: copy-on-write khi fork (BGSAVE/AOF
//        │                     rewrite), Transparent Huge Pages, Lua, module…
//        └─ allocator_resident ─┬─ allocator_rss   trang jemalloc giữ lại, chưa trả OS
//                               └─ allocator_active ─┬─ allocator_frag  lỗ giữa các object
//                                                    └─ allocator_allocated ≈ used_memory
//
// rồi biết phần nào lớn nhất để đề xuất đúng cách: lỗ giữa object → activedefrag;
// trang chưa trả OS → MEMORY PURGE; ngoài allocator → fork / THP; tỉ lệ < 1 → swap.
// Thuần để kiểm bằng script (check:redis-frag) và để client import kiểu.
//
// Nguyên tắc: tỉ lệ cao trên dữ liệu nhỏ không phải sự cố (RSS có phần cố định vài
// chục MB) — xét theo BYTE thừa, không chỉ tỉ lệ. App không tự chạy lệnh sửa nào;
// lệnh đề xuất nào chạy trên luồng chính (MEMORY PURGE, activedefrag) đều ghi rõ
// chạy lúc thấp điểm / trần CPU thấp, vì mọi Redis ở đây là production đang chạy.

import { buildPlan, fmtBytes, fmtN, sortFindings, type Finding, type PlanStep } from '@/lib/diagnose';

export interface FragNode {
  addr: string;
  version: string;
  /** jemalloc-x.y.z / libc / tcmalloc. */
  allocator: string;
  used: number;
  rss: number;
  peak: number;
  /** 0 = không đặt maxmemory. */
  maxmemory: number;
  /** 0 = không biết (Redis managed thường giấu). */
  system: number;
  ratio: number | null;
  /** RSS − used_memory. null = Redis cũ không báo. */
  fragBytes: number | null;
  /** Các phần tách sẵn của INFO memory (Redis ≥ 5 + jemalloc); null = không có. */
  allocFragRatio: number | null;
  allocFragBytes: number | null;
  allocRssRatio: number | null;
  allocRssBytes: number | null;
  rssOverheadRatio: number | null;
  rssOverheadBytes: number | null;
  lazyfreePending: number;
  /** Đang BGSAVE / AOF rewrite (fork). */
  forking: boolean;
  /** Copy-on-write lần fork gần nhất (byte), lớn nhất giữa RDB/AOF. */
  lastCowBytes: number | null;
  defrag: {
    /** CONFIG activedefrag — null = CONFIG GET bị chặn. */
    enabled: boolean | null;
    running: boolean;
    /** Lượt dời object thành công / giây trong cửa sổ đo. */
    hitsPerSec: number | null;
    ignoreBytes: number | null;
    thresholdLowerPct: number | null;
    cycleMax: number | null;
  };
}

export interface RedisFragFacts {
  nodes: FragNode[];
  /** Lỗi CONFIG GET (Redis managed) — vẫn phân tích được từ INFO. */
  configError?: string;
  sampleSec: number;
  /** Node không trả lời trong hạn — bỏ qua, không kéo cả lần phân tích. */
  skipped: { addr: string; error: string }[];
}

export type FragKind = 'swap' | 'small' | 'allocFrag' | 'allocRss' | 'rssOverhead' | 'unsplit' | 'ok';

export interface FragNodeRow {
  addr: string;
  ratio: number | null;
  fragBytes: number | null;
  used: number;
  rss: number;
  peak: number;
  /** Phần lớn nhất của RSS thừa. */
  kind: FragKind;
  verdict: string;
  defrag: string;
}

export interface RedisFragDiagnosis {
  at: number;
  headline: string;
  findings: Finding[];
  plan: PlanStep[];
  /** Nặng nhất trước. */
  nodes: FragNodeRow[];
  sampleSec: number;
  skipped: { addr: string; error: string }[];
}

// ── Ngưỡng ───────────────────────────────────────────────────────────────

/** Khớp luật Monitor (lib/monitor/status.ts): cảnh báo từ 1.8, đỏ từ 3. */
export const WARN_RATIO = 1.8;
const CRIT_RATIO = 3;
/** Dưới ngần này dữ liệu, tỉ lệ cao chỉ là phần cố định của tiến trình. */
const SMALL_USED = 256 * 1024 * 1024;
/** RSS thừa dưới ngần này byte thì không đáng xử lý dù tỉ lệ cao. */
const SMALL_FRAG = 100 * 1024 * 1024;
/** Một phần chỉ được coi là thủ phạm khi ≥ ngần này byte và tỉ lệ riêng ≥ PART_RATIO. */
const PART_BYTES = 50 * 1024 * 1024;
const PART_RATIO = 1.1;
/** RSS < used × ngần này = một phần bộ nhớ đã bị đẩy ra swap. */
const SWAP_RATIO = 0.9;
const PEAK_FACTOR = 1.5;

const VERDICT: Record<FragKind, string> = {
  swap: 'Đang bị swap',
  small: 'Dữ liệu nhỏ — không đáng kể',
  allocFrag: 'Lỗ giữa các object',
  allocRss: 'Trang chưa trả về OS',
  rssOverhead: 'Ngoài allocator (fork / THP)',
  unsplit: 'Không tách được (Redis cũ / không jemalloc)',
  ok: 'Ổn',
};

const isJemalloc = (n: FragNode) => /jemalloc/i.test(n.allocator);
const r2 = (x: number | null) => (x === null ? '?' : String(Math.round(x * 100) / 100));
const big = (bytes: number | null, ratio: number | null) => (bytes ?? 0) >= PART_BYTES && (ratio ?? 0) >= PART_RATIO;

/** Phần nào của RSS thừa đang lớn nhất ở một node. */
export function classifyNode(n: FragNode): FragKind {
  if (n.ratio !== null && n.ratio < SWAP_RATIO && n.used >= 64 * 1024 * 1024) return 'swap';
  if (n.ratio === null || n.ratio < WARN_RATIO) return 'ok';
  const extra = n.fragBytes ?? n.rss - n.used;
  if (n.used < SMALL_USED || extra < SMALL_FRAG) return 'small';
  const parts: [FragKind, number][] = [];
  if (big(n.allocFragBytes, n.allocFragRatio)) parts.push(['allocFrag', n.allocFragBytes!]);
  if (big(n.allocRssBytes, n.allocRssRatio)) parts.push(['allocRss', n.allocRssBytes!]);
  if (big(n.rssOverheadBytes, n.rssOverheadRatio)) parts.push(['rssOverhead', n.rssOverheadBytes!]);
  if (!parts.length) return 'unsplit';
  return parts.sort((a, b) => b[1] - a[1])[0][0];
}

function defragText(n: FragNode): string {
  if (!isJemalloc(n)) return `không hỗ trợ (${n.allocator})`;
  const d = n.defrag;
  if (d.enabled === null) return '? (CONFIG bị chặn)';
  if (!d.enabled) return 'tắt';
  if (d.running) return `đang chạy${d.hitsPerSec !== null ? ` · ${fmtN(d.hitsPerSec)} object/s` : ''}`;
  return 'bật, đang nghỉ';
}

/** Nhiều node cùng một kết luận: liệt kê tối đa 4 node, nặng nhất trước. */
const perNode = (ns: FragNode[], line: (n: FragNode) => string, multi: boolean): string[] => {
  const out = ns.slice(0, 4).map((n) => (multi ? `${n.addr}: ${line(n)}` : line(n)));
  if (ns.length > 4) out.push(`… và ${ns.length - 4} node khác`);
  return out;
};

// ── Phân tích ────────────────────────────────────────────────────────────

export function analyzeRedisFrag(f: RedisFragFacts, at = Date.now()): RedisFragDiagnosis {
  const nodes = [...f.nodes].sort((a, b) => (b.fragBytes ?? b.rss - b.used) - (a.fragBytes ?? a.rss - a.used));
  const kinds = new Map(nodes.map((n) => [n, classifyNode(n)]));
  const of = (k: FragKind) => nodes.filter((n) => kinds.get(n) === k);
  const multi = nodes.length > 1;
  const out: Finding[] = [];
  const peakLine = (n: FragNode) => (n.peak >= n.used * PEAK_FACTOR
    ? `Đỉnh từng dùng ${fmtBytes(n.peak)}, giờ còn ${fmtBytes(n.used)} — dữ liệu đã bị xoá / hết hạn hàng loạt, allocator giữ lại chỗ trống`
    : '');

  // 1. Swap — nặng nhất: lệnh chạm trang trong swap chậm cỡ mili-giây.
  const swap = of('swap');
  if (swap.length) {
    out.push({
      id: 'swap',
      level: 'crit',
      title: `RSS nhỏ hơn dữ liệu (tỉ lệ ${r2(swap[0].ratio)}) — một phần bộ nhớ Redis đang nằm trong swap`,
      evidence: perNode(swap, (n) => `RSS ${fmtBytes(n.rss)} < dữ liệu ${fmtBytes(n.used)} (tỉ lệ ${r2(n.ratio)})`, multi),
      fix: 'Máy chủ thiếu RAM nên OS đẩy trang của Redis ra swap — lệnh chạm trang đó chậm hàng nghìn lần. Tăng RAM / giảm maxmemory cho vừa máy, không chạy chung tiến trình ăn RAM khác, đặt vm.swappiness thấp (1). Đây không phải phân mảnh: tỉ lệ < 1 là ngược lại.',
      sql: 'INFO memory\n# trên máy chủ Redis:\nfree -m\ncat /proc/$(pidof redis-server)/status | grep VmSwap\nsysctl vm.swappiness=1',
      step: { phase: 'now', text: 'Giải phóng RAM máy chủ / giảm maxmemory — Redis đang bị swap' },
    });
  }

  // 2. Lỗ giữa các object — phân mảnh thật, xử lý bằng activedefrag.
  const frag = of('allocFrag');
  if (frag.length) {
    const n0 = frag[0];
    const d = n0.defrag;
    const jem = frag.every(isJemalloc);
    const fragPct = n0.allocFragRatio !== null ? (n0.allocFragRatio - 1) * 100 : null;
    let fix: string;
    let sql: string | undefined;
    let step: Finding['step'];
    let level: Finding['level'] = (n0.ratio ?? 0) >= CRIT_RATIO ? 'crit' : 'warn';
    if (!jem) {
      fix = `Allocator ${n0.allocator} không hỗ trợ chống phân mảnh chủ động. Cách thu hồi: failover sang replica (replica nạp lại từ RDB nên bộ nhớ gọn) hoặc restart ngoài giờ; dài hạn dùng bản Redis build với jemalloc (mặc định trên Linux).`;
      step = { phase: 'restart', text: 'Failover sang replica / restart ngoài giờ để thu hồi bộ nhớ phân mảnh' };
    } else if (d.enabled === null) {
      fix = 'Không đọc được CONFIG (Redis managed). Bật activedefrag qua cấu hình của nhà cung cấp (parameter group / redis.conf) — Redis tự dời object để lấp lỗ, chạy nền, tốn 1–25% CPU tuỳ mức phân mảnh.';
      sql = 'activedefrag yes   # trong parameter group / redis.conf';
      step = { phase: 'now', text: 'Bật activedefrag qua cấu hình nhà cung cấp' };
    } else if (!d.enabled) {
      fix = 'Bật activedefrag: Redis tự dời object sang vùng liền để lấp lỗ, tự dừng khi phân mảnh xuống dưới ngưỡng. Nó chạy theo từng lát trên LUỒNG CHÍNH — trần CPU càng cao thì mỗi lát càng dài, lệnh khác phải chờ lâu hơn. Production đang live: bắt đầu với trần 10%, theo dõi latency (LATENCY / slowlog phía ứng dụng) rồi mới nâng lúc thấp điểm; thấy latency tăng thì CONFIG SET activedefrag no là dừng ngay. Muốn giữ sau restart thì CONFIG REWRITE hoặc sửa redis.conf.';
      sql = 'CONFIG SET active-defrag-cycle-min 1\nCONFIG SET active-defrag-cycle-max 10\nCONFIG SET activedefrag yes\n# theo dõi: INFO memory (allocator_frag_ratio) · INFO stats (active_defrag_hits)\n# latency tăng → dừng ngay:\nCONFIG SET activedefrag no\nCONFIG REWRITE   # tuỳ chọn: giữ sau restart';
      step = { phase: 'now', text: 'Bật activedefrag với trần CPU 10% — đang tắt; theo dõi latency' };
    } else if (d.running) {
      level = 'info';
      fix = `activedefrag đang chạy${d.hitsPerSec !== null ? ` (${fmtN(d.hitsPerSec)} object/s)` : ''}${d.cycleMax !== null ? `, trần CPU ${d.cycleMax}%` : ''} — chờ nó lấp dần; tỉ lệ giảm trong vài phút tới vài giờ tuỳ lượng dữ liệu. Muốn nhanh hơn thì nâng active-defrag-cycle-max CHỈ lúc thấp điểm (mỗi lát trên luồng chính dài hơn → latency tăng), hạ lại trước giờ cao điểm.`;
      sql = 'INFO memory   # allocator_frag_ratio giảm dần\nCONFIG SET active-defrag-cycle-max 25   # chỉ lúc thấp điểm\nCONFIG SET active-defrag-cycle-max 10   # trước giờ cao điểm';
      step = { phase: 'observe', text: 'activedefrag đang chạy — theo dõi allocator_frag_ratio giảm dần' };
    } else {
      const below = [
        d.ignoreBytes !== null && (n0.allocFragBytes ?? 0) < d.ignoreBytes
          ? `phần lỗ ${fmtBytes(n0.allocFragBytes)} < active-defrag-ignore-bytes ${fmtBytes(d.ignoreBytes)}` : '',
        d.thresholdLowerPct !== null && fragPct !== null && fragPct < d.thresholdLowerPct
          ? `phân mảnh trong allocator ${Math.round(fragPct)}% < active-defrag-threshold-lower ${d.thresholdLowerPct}%` : '',
      ].filter(Boolean);
      fix = below.length
        ? `activedefrag đã bật nhưng không chạy vì ${below.join(' và ')}. Phần lớn RSS thừa nằm ở chỗ khác hoặc ngưỡng đặt quá cao — hạ ngưỡng nếu muốn thu hồi phần này.`
        : 'activedefrag đã bật mà không chạy dù vượt ngưỡng — kiểm tra log Redis (bản build không hỗ trợ defrag sẽ báo lỗi khi bật) và INFO stats active_defrag_*.';
      sql = below.length ? 'CONFIG SET active-defrag-ignore-bytes 50mb\nCONFIG SET active-defrag-threshold-lower 5' : 'INFO stats   # active_defrag_running / hits / misses';
      step = { phase: 'now', text: below.length ? 'Hạ ngưỡng activedefrag để nó chạy' : 'Kiểm tra vì sao activedefrag bật mà không chạy' };
    }
    out.push({
      id: 'alloc-frag',
      level,
      title: `Lỗ giữa các object trong allocator — ${fmtBytes(n0.allocFragBytes)} bị phí${multi ? ` (${n0.addr})` : ''}`,
      evidence: [
        ...perNode(frag, (n) => `allocator_frag_ratio ${r2(n.allocFragRatio)} = ${fmtBytes(n.allocFragBytes)} lỗ · tỉ lệ tổng ${r2(n.ratio)} · activedefrag: ${defragText(n)}`, multi),
        peakLine(n0),
      ].filter(Boolean),
      fix,
      sql,
      step,
    });
    if (jem && step?.phase !== 'restart') {
      out.push({
        id: 'frag-restart',
        level: 'info',
        title: 'Cách thu hồi tức thì: failover sang replica',
        evidence: ['Replica đồng bộ lại từ RDB nên bộ nhớ liền mạch, không lỗ', 'Dùng khi activedefrag quá chậm hoặc cần lấy lại RAM ngay'],
        fix: 'Chuyển vai master sang replica (Sentinel / Cluster failover), rồi restart node cũ ngoài giờ.',
        sql: 'CLUSTER FAILOVER   # chạy trên replica (Cluster)\nSENTINEL FAILOVER <master-name>   # Sentinel',
        step: { phase: 'restart', text: 'Nếu cần RAM ngay: failover sang replica rồi restart node cũ ngoài giờ' },
      });
    }
    out.push({
      id: 'frag-workload',
      level: 'info',
      title: 'Vì sao bị lỗ: kích thước value thay đổi + xoá / hết hạn hàng loạt',
      evidence: [
        'jemalloc xếp object theo lớp kích thước; xoá lẻ tẻ để lại lỗ mà object kích thước khác không dùng được',
        peakLine(n0) || 'Hay gặp: key hết hạn cùng lúc, value lớn dần (APPEND, list / hash nở ra), ghi đè value khác kích thước',
      ],
      fix: 'Rải TTL (thêm jitter) để key không hết hạn cùng lúc; tách dữ liệu lớn / nhỏ ra instance khác nhau nếu chênh lệch quá nhiều; tránh xoá hàng loạt bằng DEL — dùng UNLINK / lazyfree; đặt maxmemory chừa 30–50% RAM máy cho phân mảnh.',
      step: { phase: 'long', text: 'Giảm tạo lỗ: TTL có jitter, UNLINK thay DEL, chừa RAM cho phân mảnh' },
    });
  }

  // 3. Trang jemalloc giữ lại, chưa trả OS.
  const rssK = of('allocRss');
  if (rssK.length) {
    const n0 = rssK[0];
    out.push({
      id: 'alloc-rss',
      level: (n0.ratio ?? 0) >= CRIT_RATIO ? 'crit' : 'warn',
      title: `Allocator giữ ${fmtBytes(n0.allocRssBytes)} trang trống chưa trả về OS${multi ? ` (${n0.addr})` : ''}`,
      evidence: [
        ...perNode(rssK, (n) => `allocator_rss_ratio ${r2(n.allocRssRatio)} = ${fmtBytes(n.allocRssBytes)} · tỉ lệ tổng ${r2(n.ratio)}`, multi),
        peakLine(n0),
      ].filter(Boolean),
      fix: isJemalloc(n0)
        ? 'Sau khi xoá nhiều dữ liệu, jemalloc giữ trang trống để dùng lại. MEMORY PURGE bảo nó trả ngay về OS — nhanh, không đổi dữ liệu, nhưng chạy trên luồng chính (heap lớn có thể dừng vài chục ms) nên chạy lúc thấp điểm. Nếu dữ liệu sẽ lớn lại sớm thì cứ để, trang sẽ được dùng lại.'
        : `Allocator ${n0.allocator} không có MEMORY PURGE — restart ngoài giờ để trả RAM.`,
      sql: isJemalloc(n0) ? 'MEMORY PURGE   # lúc thấp điểm, chạy trên từng node\nINFO memory    # allocator_rss_ratio về gần 1' : undefined,
      step: isJemalloc(n0)
        ? { phase: 'now', text: 'MEMORY PURGE lúc thấp điểm — trả trang trống về OS' }
        : { phase: 'restart', text: 'Restart ngoài giờ để trả RAM' },
    });
  }

  // 4. Ngoài allocator: fork copy-on-write, THP, Lua, module.
  const ovh = of('rssOverhead');
  if (ovh.length) {
    const n0 = ovh[0];
    const forking = ovh.some((n) => n.forking);
    out.push({
      id: 'rss-overhead',
      level: forking ? 'info' : 'warn',
      title: forking
        ? `RSS thừa ${fmtBytes(n0.rssOverheadBytes)} ngoài allocator — đang BGSAVE / AOF rewrite (tạm thời)`
        : `RSS thừa ${fmtBytes(n0.rssOverheadBytes)} nằm ngoài allocator${multi ? ` (${n0.addr})` : ''}`,
      evidence: [
        ...perNode(ovh, (n) => `rss_overhead_ratio ${r2(n.rssOverheadRatio)} = ${fmtBytes(n.rssOverheadBytes)}${n.forking ? ' · đang fork' : ''}${n.lastCowBytes ? ` · copy-on-write lần fork trước ${fmtBytes(n.lastCowBytes)}` : ''}`, multi),
      ],
      fix: forking
        ? 'Khi fork để ghi RDB / AOF, trang bị ghi trong lúc đó được nhân đôi (copy-on-write). Sẽ tự hết khi fork xong. Nếu lặp lại thường xuyên lúc cao điểm: dời BGSAVE sang replica hoặc giờ thấp điểm, và tắt Transparent Huge Pages (THP làm mỗi lần copy-on-write nhân đôi 2MB thay vì 4KB).'
        : 'Phần này không do dữ liệu: hay gặp nhất là Transparent Huge Pages đang bật (Redis cảnh báo trong log lúc khởi động), dư âm copy-on-write của lần fork trước, script Lua / module giữ bộ nhớ. Tắt THP trên máy chủ rồi restart Redis.',
      sql: 'cat /sys/kernel/mm/transparent_hugepage/enabled   # [never] là đúng\necho never > /sys/kernel/mm/transparent_hugepage/enabled\nINFO persistence   # rdb_bgsave_in_progress · rdb_last_cow_size',
      step: forking
        ? { phase: 'observe', text: 'Đo lại sau khi BGSAVE / AOF rewrite xong; lặp lại thì dời sang replica' }
        : { phase: 'restart', text: 'Tắt Transparent Huge Pages trên máy chủ rồi restart Redis' },
    });
  }

  // 5. Không tách được (Redis < 5, allocator khác).
  const unsplit = of('unsplit');
  if (unsplit.length) {
    const n0 = unsplit[0];
    out.push({
      id: 'unsplit',
      level: (n0.ratio ?? 0) >= CRIT_RATIO ? 'crit' : 'warn',
      title: `Phân mảnh ${r2(n0.ratio)} (${fmtBytes(n0.fragBytes ?? n0.rss - n0.used)} thừa) — Redis ${n0.version} / ${n0.allocator} không cho biết nằm ở đâu`,
      evidence: [...perNode(unsplit, (n) => `RSS ${fmtBytes(n.rss)} / dữ liệu ${fmtBytes(n.used)}`, multi), peakLine(n0)].filter(Boolean),
      fix: isJemalloc(n0)
        ? 'Thử theo thứ tự rẻ → đắt, đều lúc thấp điểm: MEMORY PURGE (trả trang trống), bật activedefrag với trần CPU 10% (lấp lỗ), cuối cùng failover / restart ngoài giờ.'
        : 'Không jemalloc thì không có activedefrag / MEMORY PURGE — failover sang replica hoặc restart ngoài giờ.',
      sql: isJemalloc(n0) ? 'MEMORY PURGE   # lúc thấp điểm\nCONFIG SET active-defrag-cycle-max 10\nCONFIG SET activedefrag yes' : undefined,
      step: { phase: isJemalloc(n0) ? 'now' : 'restart', text: isJemalloc(n0) ? 'MEMORY PURGE rồi bật activedefrag' : 'Failover / restart ngoài giờ' },
    });
  }

  // 6. Tỉ lệ cao nhưng dữ liệu nhỏ — báo động giả của luật tỉ lệ.
  const small = of('small');
  if (small.length) {
    out.push({
      id: 'small',
      level: 'ok',
      title: `Tỉ lệ ${r2(small[0].ratio)} nhưng chỉ thừa ${fmtBytes(small[0].fragBytes ?? small[0].rss - small[0].used)} — không đáng xử lý`,
      evidence: perNode(small, (n) => `dữ liệu ${fmtBytes(n.used)}, RSS ${fmtBytes(n.rss)}`, multi),
      fix: `Tiến trình Redis luôn có phần RSS cố định vài chục MB; khi dữ liệu nhỏ, tỉ lệ RSS / dữ liệu nhìn rất cao dù không có gì phí. Chỉ đáng xử lý khi phần thừa ≥ ${fmtBytes(SMALL_FRAG)}.`,
    });
  }

  // 7. Bối cảnh RAM: phân mảnh có đang đe doạ máy chủ không.
  const tight = nodes.filter((n) => n.system > 0 && n.rss / n.system >= 0.7);
  if (tight.length && !swap.length) {
    const n0 = tight[0];
    const p = Math.round((n0.rss / n0.system) * 100);
    out.push({
      id: 'ram',
      level: p >= 85 ? 'crit' : 'warn',
      title: `RSS đã chiếm ${p}% RAM máy chủ — phân mảnh thêm nữa là OOM killer / swap`,
      evidence: perNode(tight, (n) => `RSS ${fmtBytes(n.rss)} / RAM ${fmtBytes(n.system)}${n.maxmemory ? ` · maxmemory ${fmtBytes(n.maxmemory)}` : ' · không đặt maxmemory'}`, multi),
      fix: 'Xử lý phân mảnh ở các mục trên trước; đồng thời đặt maxmemory sao cho RSS × tỉ lệ phân mảnh vẫn dưới ~80% RAM.',
      step: { phase: 'now', text: `Thu hồi RAM trước khi chạm OOM (RSS ${p}% RAM máy)` },
    });
  }
  const over = nodes.filter((n) => n.maxmemory > 0 && n.rss > n.maxmemory * 1.3 && classifyNode(n) !== 'small');
  if (over.length) {
    out.push({
      id: 'maxmemory',
      level: 'info',
      title: 'RAM thật vượt xa maxmemory — maxmemory không tính phân mảnh',
      evidence: perNode(over, (n) => `RSS ${fmtBytes(n.rss)} > maxmemory ${fmtBytes(n.maxmemory)}`, multi),
      fix: 'maxmemory chỉ giới hạn dữ liệu (used_memory), không giới hạn RSS. Khi tính RAM cho máy chủ, cộng thêm phần phân mảnh + bộ đệm fork.',
    });
  }

  const pending = nodes.filter((n) => n.lazyfreePending > 0);
  if (pending.length) {
    out.push({
      id: 'lazyfree',
      level: 'info',
      title: 'Đang giải phóng nền một lượng object lớn — tỉ lệ sẽ còn thay đổi',
      evidence: perNode(pending, (n) => `lazyfree_pending_objects ${fmtN(n.lazyfreePending)}`, multi),
      fix: 'Có UNLINK / FLUSHALL ASYNC vừa chạy. Đo lại sau vài phút trước khi kết luận.',
      step: { phase: 'observe', text: 'Đo lại sau khi lazyfree xong' },
    });
  }

  if (f.configError) {
    out.push({
      id: 'config',
      level: 'info',
      title: 'Không đọc được CONFIG — chưa biết activedefrag đang bật hay tắt',
      evidence: [`CONFIG GET lỗi: ${f.configError}`],
    });
  }

  const findings = sortFindings(out);
  const rows: FragNodeRow[] = nodes.map((n) => {
    const k = kinds.get(n)!;
    return {
      addr: n.addr, ratio: n.ratio, fragBytes: n.fragBytes ?? n.rss - n.used, used: n.used, rss: n.rss, peak: n.peak,
      kind: k, verdict: VERDICT[k], defrag: defragText(n),
    };
  });
  return {
    at,
    headline: headline(rows, findings),
    findings,
    plan: buildPlan(findings, 'Phân tích lại sau khi xử lý — mục tiêu tỉ lệ phân mảnh < 1.5'),
    nodes: rows,
    sampleSec: f.sampleSec,
    skipped: f.skipped,
  };
}

function headline(rows: FragNodeRow[], findings: Finding[]): string {
  const worst = rows[0];
  if (!worst) return 'Không đọc được số liệu bộ nhớ.';
  const where = rows.length > 1 ? ` ở ${worst.addr}` : '';
  const ratio = `Phân mảnh ${r2(worst.ratio)}${where}`;
  if (findings.some((x) => x.id === 'swap')) return `${ratio} — Redis đang bị swap vì máy chủ thiếu RAM, không phải phân mảnh.`;
  const bad = rows.filter((r) => r.kind !== 'ok' && r.kind !== 'small');
  if (!bad.length) {
    return rows.some((r) => r.kind === 'small')
      ? `${ratio} nhưng chỉ thừa ${fmtBytes(worst.fragBytes)} — dữ liệu nhỏ nên tỉ lệ nhìn cao, không cần xử lý.`
      : `${ratio} — trong ngưỡng, không cần xử lý.`;
  }
  const b = bad[0];
  const cause: Record<FragKind, string> = {
    allocFrag: 'lỗ giữa các object (xử lý bằng activedefrag)',
    allocRss: 'allocator giữ trang trống chưa trả OS (MEMORY PURGE)',
    rssOverhead: 'bộ nhớ ngoài allocator — fork / Transparent Huge Pages',
    unsplit: 'không tách được nguyên nhân trên bản Redis này',
    swap: '', small: '', ok: '',
  };
  return `${ratio} — ${fmtBytes(b.fragBytes)} thừa, chủ yếu do ${cause[b.kind]}.`;
}
