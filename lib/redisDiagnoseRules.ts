// Phân tích hit rate thấp của Redis — phần LUẬT thuần: dạng key nào đang miss, và vì sao.
//
// Số liệu do lib/redisDiagnose.ts gom (bắt sự kiện keymiss trong vài giây, quét
// SCAN có giới hạn, INFO trước/sau); file này chuẩn hoá tên key thành DẠNG
// (`user:12345:profile` → `user:{n}:profile`) và biến số liệu thành kết luận có
// bằng chứng + cách xử lý. Thuần để kiểm bằng script (check:redis-diagnose) và
// để client import được kiểu mà không kéo ioredis.
//
// Nguyên tắc: không đoán. Không bắt được sự kiện miss (Redis < 6, CONFIG bị
// khoá) thì nói rõ là chưa xác định được dạng key + cách bật, vẫn đưa các kết
// luận toàn cục (evict, hết hạn) từ INFO.

import { buildPlan, fmtBytes, fmtN, fmtSec, pct, share, sortFindings, type Finding, type PlanStep } from '@/lib/diagnose';

// ── Chuẩn hoá tên key thành dạng ─────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NUM_RE = /^[+-]?\d+(\.\d+)?$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2}([T _].*)?|\d{8}|\d{4}-\d{2})$/;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const TOKEN_RE = /^[A-Za-z0-9_\-+=]{20,}$/;

/** Ký tự đặc biệt của glob SCAN MATCH phải thoát khi nằm trong phần chữ cố định. */
const globEscape = (s: string): string => s.replace(/([*?[\]\\])/g, '\\$1');

function segment(seg: string): { pattern: string; glob: string } {
  if (!seg) return { pattern: '', glob: '' };
  const ph = (name: string) => ({ pattern: `{${name}}`, glob: '*' });
  if (DATE_RE.test(seg)) return ph('date');
  if (NUM_RE.test(seg)) return ph('n');
  if (UUID_RE.test(seg)) return ph('uuid');
  if (EMAIL_RE.test(seg)) return ph('email');
  if (HEX_RE.test(seg)) return ph('hex');
  if (TOKEN_RE.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return ph('token');
  // Chữ lẫn số dài (user123456, order_98765) → giữ phần chữ, thay dãy số.
  if (/\d{3,}/.test(seg)) {
    const parts = seg.split(/(\d{3,})/);
    return {
      pattern: parts.map((p, i) => (i % 2 ? '{n}' : p)).join(''),
      glob: parts.map((p, i) => (i % 2 ? '*' : globEscape(p))).join(''),
    };
  }
  return { pattern: seg, glob: globEscape(seg) };
}

/**
 * Dạng của một key: tách theo dấu phân cách hay dùng (: / | #), thay phần biến
 * thiên (số, UUID, email, hex, ngày, token) bằng {placeholder}. `glob` dùng được
 * cho SCAN MATCH để tìm các key cùng dạng đang có trong Redis.
 */
export function keyPattern(key: string): { pattern: string; glob: string } {
  const parts = key.split(/([:/|#])/);
  let pattern = '';
  let glob = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) { pattern += parts[i]; glob += parts[i]; continue; }
    const s = segment(parts[i]);
    pattern += s.pattern;
    glob += s.glob;
  }
  return { pattern, glob };
}

// ── Số liệu ──────────────────────────────────────────────────────────────

export interface MissPattern {
  db: number;
  pattern: string;
  glob: string;
  /** Số lần miss bắt được trong cửa sổ. */
  misses: number;
  /** Số key khác nhau bị miss (có thể là cận dưới nếu vượt trần theo dõi). */
  distinct: number;
  /** Key bị miss nhiều nhất và số lần. */
  topKey: string;
  topKeyMisses: number;
  samples: string[];
  /** Trong các key bị miss đã kiểm lại sau cửa sổ: bao nhiêu key giờ ĐÃ CÓ (được nạp lại sau miss). */
  refilled: number;
  checked: number;
  /** Key cùng dạng tìm thấy bằng SCAN (null = không quét được). */
  existing: number | null;
  ttl: { withTtl: number; noTtl: number; medianSec: number | null; minSec: number | null } | null;
}

export interface RedisMissFacts {
  version: string;
  nodes: number;
  /** Có bắt được sự kiện keymiss không — lý do nếu không. */
  capture: { ok: true } | { ok: false; reason: 'version' | 'config' | 'noEvents' | 'busy' | 'load'; detail?: string };
  /** Cờ notify-keyspace-events trước khi phân tích (đã trả lại). null = không đọc được. */
  originalFlags: string | null;
  durationSec: number;
  cumulative: { hits: number; misses: number };
  window: { hits: number; misses: number; sec: number } | null;
  captured: number;
  /** Số key khác nhau vượt trần theo dõi → `distinct` là cận dưới. */
  distinctCapped: boolean;
  patterns: MissPattern[];
  evicted: { total: number; window: number };
  expired: { total: number; window: number };
  memory: { used: number; max: number; policy: string | null };
  scan: { scanned: number; dbsize: number } | null;
  /** Trả lại cờ notify-keyspace-events thất bại — người dùng phải tự chạy lệnh. */
  restoreError?: string;
}

export interface RedisMissDiagnosis {
  at: number;
  cumulativePct: number | null;
  currentPct: number | null;
  windowSec: number | null;
  headline: string;
  findings: Finding[];
  plan: PlanStep[];
  /** Bảng dạng key bị miss — nặng nhất trước. */
  patterns: (MissPattern & { sharePct: number; verdict: string })[];
  captured: number;
  durationSec: number;
}

// ── Ngưỡng ───────────────────────────────────────────────────────────────

/** Ít hơn ngần này lượt tra trong cửa sổ thì tỉ lệ hiện tại không đáng tin. */
export const MIN_WINDOW_LOOKUPS = 200;
const HEALTHY_PCT = 80;
const LOW_PCT = 50;
const PATTERN_SHARE_MIN = 3;
const MAX_PATTERN_FINDINGS = 6;
/** Cùng một key miss ≥ ngần này lần trong cửa sổ = sau khi miss không ai nạp lại. */
const REPEAT_MISS = 3;
const SHORT_TTL_SEC = 300;

const cliQuote = (s: string): string => (/^[\w:./|#{}@+-]+$/.test(s) ? s : `"${s.replace(/(["\\])/g, '\\$1')}"`);

/** Phán quyết ngắn cho bảng dạng key. */
type Kind = 'never' | 'repeat' | 'shortTtl' | 'coldTail' | 'expired' | 'unknown';

function classify(p: MissPattern): Kind {
  const refilledRatio = p.checked ? p.refilled / p.checked : 0;
  if (p.existing === 0 && p.refilled === 0) return p.topKeyMisses >= REPEAT_MISS ? 'repeat' : 'never';
  if (p.topKeyMisses >= REPEAT_MISS && refilledRatio < 0.2) return 'repeat';
  if (p.ttl?.medianSec !== null && p.ttl?.medianSec !== undefined && p.ttl.medianSec < SHORT_TTL_SEC) return 'shortTtl';
  if (refilledRatio >= 0.5 && p.distinct >= p.misses * 0.8) return 'coldTail';
  if (p.existing && p.existing > 0) return 'expired';
  return 'unknown';
}

const VERDICT: Record<Kind, string> = {
  never: 'Không bao giờ được ghi',
  repeat: 'Miss lặp lại, không ai nạp lại',
  shortTtl: 'TTL quá ngắn',
  coldTail: 'Đọc lần đầu (dữ liệu dài đuôi)',
  expired: 'Hết hạn / bị xoá, nạp lại chậm',
  unknown: 'Chưa rõ',
};

// ── Phân tích ────────────────────────────────────────────────────────────

export function analyzeRedisMisses(f: RedisMissFacts, at = Date.now()): RedisMissDiagnosis {
  const out: Finding[] = [];
  const cumulativePct = pct(f.cumulative.hits, f.cumulative.misses);
  const lookups = f.window ? f.window.hits + f.window.misses : 0;
  const currentPct = f.window && lookups >= MIN_WINDOW_LOOKUPS ? pct(f.window.hits, f.window.misses) : null;

  // 1. Hiện tại hay chuyện cũ.
  if (f.window && lookups < MIN_WINDOW_LOOKUPS) {
    out.push({
      id: 'window-low',
      level: 'info',
      title: 'Tải lúc đo quá thấp — chưa đo được hit rate hiện tại',
      evidence: [`${fmtN(lookups)} lượt tra key trong ${f.window.sec}s (cần ≥ ${MIN_WINDOW_LOOKUPS})`, 'Chạy lại lúc tải cao, hoặc chọn thời gian bắt dài hơn'],
    });
  } else if (currentPct !== null && f.window) {
    if (currentPct >= HEALTHY_PCT && (cumulativePct ?? 100) < LOW_PCT) {
      out.push({
        id: 'stale',
        level: 'info',
        title: `Hiện tại đã ổn (${currentPct}%) — con số thấp là cộng dồn từ lúc khởi động`,
        evidence: [`${f.window.sec}s vừa đo: ${currentPct}% trên ${fmtN(lookups)} lượt tra`, `Cộng dồn: ${cumulativePct}%`],
        fix: 'Không cần xử lý gấp. Muốn số đo sạch thì reset thống kê (ảnh hưởng mọi công cụ giám sát đọc INFO).',
        sql: 'CONFIG RESETSTAT',
        step: { phase: 'observe', text: 'Không cần xử lý gấp — theo dõi tiếp; muốn số sạch thì CONFIG RESETSTAT' },
      });
    } else if (currentPct < LOW_PCT) {
      out.push({
        id: 'current-low',
        level: currentPct < 30 ? 'crit' : 'warn',
        title: `Đang xảy ra ngay lúc này: hit rate ${currentPct}%`,
        evidence: [
          `${f.window.sec}s vừa đo: ${fmtN(f.window.misses)} miss / ${fmtN(lookups)} lượt tra (${fmtN(f.window.misses / Math.max(1, f.window.sec))} miss/s)`,
          `Cộng dồn: ${cumulativePct ?? '?'}%`,
        ],
      });
    }
  }

  // 0. Không trả lại được cấu hình — việc của người dùng, phải lên đầu.
  if (f.restoreError) {
    out.push({
      id: 'restore',
      level: 'crit',
      title: 'Không trả lại được cấu hình notify-keyspace-events sau khi phân tích',
      evidence: [f.restoreError, `Giá trị cũ: "${f.originalFlags ?? ''}"`],
      fix: 'Chạy tay lệnh dưới đây trên node bị lỗi để trả lại cấu hình cũ.',
      sql: `CONFIG SET notify-keyspace-events "${f.originalFlags ?? ''}"`,
      step: { phase: 'now', text: 'Trả lại notify-keyspace-events về giá trị cũ (lệnh trong mục đỏ)' },
    });
  }

  // 2. Có bắt được dạng key không.
  if (!f.capture.ok) {
    const why = f.capture.reason;
    out.push({
      id: 'no-capture',
      level: 'warn',
      title: why === 'version'
        ? `Redis ${f.version} chưa hỗ trợ sự kiện key-miss — chưa xác định được dạng key nào miss`
        : why === 'load'
          ? `Không bật bắt key-miss: tốc độ miss quá cao (${f.capture.detail ?? '?'}) — để bảo vệ production`
          : why === 'busy'
          ? 'Đang có một phiên phân tích khác trên kết nối này'
          : why === 'config'
            ? 'Server chặn CONFIG — không bật tạm được sự kiện key-miss'
            : 'Không nhận được sự kiện key-miss nào dù có miss',
      evidence: [
        why === 'version' ? 'Sự kiện keymiss (cờ "m" của notify-keyspace-events) có từ Redis 6.0' : '',
        why === 'config' ? `CONFIG lỗi: ${f.capture.detail ?? '?'} (thường gặp ở Redis managed: ElastiCache, Azure Cache…)` : '',
        why === 'noEvents' ? `Cửa sổ ${f.durationSec}s có ${fmtN(f.window?.misses ?? 0)} miss theo INFO nhưng không nhận được sự kiện nào${f.capture.detail ? ` (${f.capture.detail})` : ''}` : '',
        why === 'busy' ? 'Chờ phiên kia xong (nó sẽ tự trả lại cấu hình) rồi phân tích lại' : '',
        why === 'load' ? 'Mỗi miss sẽ thành một lần publish trên luồng chính của Redis — ở tốc độ này sẽ làm chậm mọi lệnh khác' : '',
      ].filter(Boolean),
      fix: why === 'version' || why === 'load'
        ? `${why === 'load' ? 'Chạy lại lúc thấp điểm, hoặc ' : 'Nâng Redis lên ≥ 6.0; trong lúc chờ, '}ghi log / đếm key miss ở phía ứng dụng (chỗ GET trả về rỗng) theo dạng key để biết loại nào miss — không tốn gì phía Redis.`
        : why === 'config'
          ? 'Bật notify-keyspace-events có chứa "Em" qua cấu hình của nhà cung cấp (parameter group / redis.conf). Khi đã bật sẵn, app chỉ cần nghe — không phải CONFIG SET.'
          : why === 'busy' ? undefined : 'Kiểm tra user có quyền PSUBSCRIBE (ACL) và notify-keyspace-events chứa "Em".',
      sql: why === 'config' || why === 'noEvents'
        ? "CONFIG SET notify-keyspace-events Em   # hoặc khai trong redis.conf / parameter group\nPSUBSCRIBE __keyevent@*__:keymiss     # kiểm tra tay: mỗi miss in ra tên key"
        : undefined,
      step: why === 'busy' ? undefined : { phase: 'observe', text: why === 'version' ? 'Nâng Redis ≥ 6.0 (hoặc log key miss phía ứng dụng) để biết dạng key nào miss'
        : why === 'load' ? 'Đếm key miss theo dạng ở phía ứng dụng (hoặc phân tích lại lúc thấp điểm)'
          : 'Bật notify-keyspace-events "Em" phía server rồi phân tích lại' },
    });
  }

  // 3. Bị evict vì đầy bộ nhớ — nguyên nhân toàn cục, ảnh hưởng mọi dạng key.
  const memPct = f.memory.max > 0 ? Math.round((f.memory.used / f.memory.max) * 100) : null;
  if (f.evicted.window > 0) {
    out.push({
      id: 'evict',
      level: f.evicted.window / Math.max(1, f.durationSec) >= 10 ? 'crit' : 'warn',
      title: `Key đang bị evict vì đầy bộ nhớ — ${fmtN(f.evicted.window)} key trong ${f.durationSec}s`,
      evidence: [
        `Bộ nhớ ${fmtBytes(f.memory.used)} / maxmemory ${fmtBytes(f.memory.max)}${memPct !== null ? ` (${memPct}%)` : ''} · policy ${f.memory.policy ?? '?'}`,
        `Cộng dồn từ lúc khởi động: ${fmtN(f.evicted.total)} key bị evict`,
        'Key vừa ghi bị đẩy ra trước khi được đọc lại → lần đọc sau miss',
      ],
      fix: 'Tăng maxmemory (hoặc RAM / thêm shard), giảm dữ liệu: đặt TTL cho key không có TTL, bỏ cache các dạng ít được đọc lại (xem bảng dạng key). Policy allkeys-lru / allkeys-lfu hợp với cache hơn volatile-*.',
      sql: "INFO memory\nCONFIG GET maxmemory-policy\nCONFIG SET maxmemory <dung lượng mới>   # vd 4gb",
      step: { phase: 'now', text: `Giảm áp lực bộ nhớ: tăng maxmemory / giảm dữ liệu không TTL — đang evict ${fmtN(f.evicted.window)} key/${f.durationSec}s` },
    });
  } else if (f.evicted.total > 0 && memPct !== null && memPct >= 90) {
    out.push({
      id: 'evict-past',
      level: 'info',
      title: `Bộ nhớ ${memPct}% maxmemory — đã từng evict ${fmtN(f.evicted.total)} key`,
      evidence: ['Lúc đo không có evict mới, nhưng sát ngưỡng — tải tăng là evict lại'],
      step: { phase: 'long', text: 'Dự phòng bộ nhớ: tăng maxmemory hoặc giảm dữ liệu trước khi evict trở lại' },
    });
  }

  // 4. Từng dạng key.
  const totalCaptured = Math.max(1, f.captured);
  const ranked = [...f.patterns].sort((a, b) => b.misses - a.misses);
  const table = ranked.map((p) => ({ ...p, sharePct: share(p.misses, totalCaptured), verdict: VERDICT[classify(p)] }));
  const scanNote = f.scan
    ? `SCAN đã xét ${fmtN(f.scan.scanned)}/${fmtN(f.scan.dbsize)} key${f.scan.scanned < f.scan.dbsize ? ` (≈${Math.round((f.scan.scanned / Math.max(1, f.scan.dbsize)) * 100)}% — số tồn tại là ước lượng)` : ''}`
    : 'Không quét được keyspace';

  for (const p of table.filter((x) => x.sharePct >= PATTERN_SHARE_MIN).slice(0, MAX_PATTERN_FINDINGS)) {
    const kind = classify(p);
    const where = `${p.pattern}${f.nodes > 1 || p.db === 0 ? '' : ` (db ${p.db})`}`;
    const heavy = p.sharePct >= 30;
    const base = [
      `${fmtN(p.misses)} miss = ${p.sharePct}% số miss bắt được · ${fmtN(p.distinct)}${f.distinctCapped ? '+' : ''} key khác nhau`,
      `Ví dụ: ${p.samples.slice(0, 3).join(' · ')}`,
    ];
    const exist = p.existing === null ? '' : `Key cùng dạng đang có trong Redis: ${fmtN(p.existing)} (${scanNote})`;
    const ttlLine = p.ttl
      ? `TTL các key đang có: ${p.ttl.medianSec !== null ? `trung vị ${fmtSec(p.ttl.medianSec)}, ngắn nhất ${fmtSec(p.ttl.minSec ?? 0)}` : 'không key nào có TTL'}${p.ttl.noTtl ? ` · ${fmtN(p.ttl.noTtl)} key không TTL` : ''}`
      : '';
    const refill = p.checked ? `Kiểm lại ${p.checked} key vừa miss: ${p.refilled} key giờ đã có (được nạp lại sau miss)` : '';
    const verify = `SCAN 0 MATCH ${cliQuote(p.glob)} COUNT 1000\nEXISTS ${cliQuote(p.topKey)}\nTTL ${cliQuote(p.topKey)}`;
    const id = `pat:${p.db}:${p.pattern}`;

    if (kind === 'never' || kind === 'repeat') {
      out.push({
        id,
        level: heavy ? 'crit' : 'warn',
        title: kind === 'repeat'
          ? `${where}: cùng key bị miss lặp lại (tới ${fmtN(p.topKeyMisses)} lần) — sau khi miss không ai ghi lại`
          : `${where}: được đọc nhưng không bao giờ được ghi`,
        evidence: [...base, `Key miss nhiều nhất: ${p.topKey} (${fmtN(p.topKeyMisses)} lần trong ${f.durationSec}s)`, exist, refill].filter(Boolean),
        fix: 'Ba khả năng, theo thứ tự hay gặp: (1) chỗ GHI dùng tên key / prefix / db khác chỗ ĐỌC — so format key ở hai phía; (2) cache-aside bỏ qua SET khi kết quả rỗng hoặc lỗi → dữ liệu "không có" bị tra lại mãi: cache cả kết quả rỗng (negative cache) với TTL ngắn; (3) key bị xoá chủ động (invalidate) quá tay.',
        sql: `${verify}\n# negative cache — ví dụ khi DB không có bản ghi:\nSET ${cliQuote(p.topKey)} "__none__" EX 60`,
        step: { phase: 'now', text: kind === 'repeat'
          ? `${p.pattern}: cache cả kết quả rỗng (TTL ngắn) và kiểm tra chỗ SET sau khi miss`
          : `${p.pattern}: so tên key giữa chỗ đọc và chỗ ghi — đang đọc mà không ai ghi` },
      });
    } else if (kind === 'shortTtl') {
      out.push({
        id,
        level: heavy ? 'warn' : 'info',
        title: `${where}: TTL quá ngắn (trung vị ${fmtSec(p.ttl!.medianSec!)}) — key hết hạn trước khi được đọc lại`,
        evidence: [...base, ttlLine, refill, exist].filter(Boolean),
        fix: 'Tăng TTL cho dạng key này (dữ liệu chịu được cũ bao lâu thì đặt bấy lâu), thêm jitter ngẫu nhiên để key không hết hạn cùng lúc; dữ liệu hay đọc thì làm mới trước khi hết hạn (refresh-ahead).',
        sql: `${verify}\n# ví dụ: đặt TTL 1 giờ ± ngẫu nhiên ở phía ứng dụng khi SET\nSET <key> <value> EX 3600`,
        step: { phase: 'now', text: `${p.pattern}: tăng TTL (đang ~${fmtSec(p.ttl!.medianSec!)}) + jitter` },
      });
    } else if (kind === 'coldTail') {
      out.push({
        id,
        level: 'info',
        title: `${where}: mỗi key chỉ được đọc ~1 lần — miss là lần đọc đầu (dữ liệu dài đuôi)`,
        evidence: [...base, refill, ttlLine].filter(Boolean),
        fix: 'Miss ở đây là tự nhiên: key được nạp lại ngay sau miss nhưng ít khi được đọc lần hai. Tăng TTL không giúp; cân nhắc không cache dạng này (tiết kiệm bộ nhớ cho dạng hay đọc lại) hoặc nạp sẵn (warm-up) nếu đoán trước được key sẽ đọc.',
        step: { phase: 'long', text: `${p.pattern}: cân nhắc bỏ cache / warm-up — miss là lần đọc đầu, tăng TTL không giúp` },
      });
    } else {
      out.push({
        id,
        level: heavy ? 'warn' : 'info',
        title: `${where}: key hết hạn / bị xoá và chưa được nạp lại kịp`,
        evidence: [...base, exist, ttlLine, refill].filter(Boolean),
        fix: 'Kiểm tra chỗ nạp lại cache sau miss (có chạy không, có lỗi không) và các chỗ xoá key chủ động; nếu dữ liệu hay đọc, tăng TTL hoặc làm mới trước khi hết hạn.',
        sql: verify,
        step: { phase: 'now', text: `${p.pattern}: kiểm tra đường nạp lại sau miss và các chỗ xoá key` },
      });
    }
  }

  if (f.capture.ok && f.captured > 0 && f.window && f.window.misses > f.captured * 1.5) {
    out.push({
      id: 'partial',
      level: 'info',
      title: 'Chỉ bắt được một phần số miss',
      evidence: [`INFO ghi ${fmtN(f.window.misses)} miss, sự kiện bắt được ${fmtN(f.captured)} — tỉ lệ giữa các dạng vẫn dùng được`],
    });
  }

  const findings = sortFindings(out.filter((x) => x.evidence.length || x.fix));
  return {
    at,
    cumulativePct,
    currentPct,
    windowSec: f.window?.sec ?? null,
    headline: headline(findings, table, currentPct, cumulativePct, f),
    findings,
    plan: buildPlan(findings, 'Phân tích lại sau khi xử lý — mục tiêu hit rate hiện tại ≥ 80%'),
    patterns: table,
    captured: f.captured,
    durationSec: f.durationSec,
  };
}

function headline(
  findings: Finding[], table: { pattern: string; sharePct: number; verdict: string }[],
  current: number | null, cumulative: number | null, f: RedisMissFacts,
): string {
  if (findings.some((x) => x.id === 'stale')) return `Không có sự cố hiện tại — ${current}% lúc này, ${cumulative}% là số cộng dồn cũ.`;
  const now = current !== null ? `${current}% lúc này` : `${cumulative ?? '?'}% cộng dồn`;
  const top = table[0];
  if (findings.some((x) => x.id === 'evict' && x.level === 'crit')) return `Hit rate ${now} — nguyên nhân chính: key bị evict vì đầy bộ nhớ.`;
  if (top && top.sharePct >= 20) return `Hit rate ${now} — ${top.sharePct}% số miss rơi vào dạng ${top.pattern} (${top.verdict.toLowerCase()}).`;
  if (!f.capture.ok) return `Hit rate ${now} — chưa bắt được dạng key bị miss (xem lý do bên dưới).`;
  if (f.captured === 0) return `Hit rate ${now} — không có miss nào trong ${f.durationSec}s đo.`;
  return `Hit rate ${now} — miss rải đều trên nhiều dạng key, không dạng nào trội hẳn.`;
}
