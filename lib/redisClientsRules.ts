// Phân tích số client kết nối Redis — phần LUẬT thuần: còn bao xa tới trần thật
// (maxclients), kết nối đến từ đâu, có rò / mở-đóng liên tục không, và nên làm gì.
//
// Số liệu do lib/redisClientsDiagnose.ts gom. Hai mức:
//   • Cơ bản (luôn chạy, chỉ lệnh O(1)): INFO clients / stats đọc hai lần cách vài giây
//     (kết nối mới mỗi giây, bị từ chối) + CONFIG GET maxclients / timeout / tcp-keepalive.
//   • Danh sách client (người dùng bấm): CLIENT LIST — O(số client) trên luồng chính,
//     nên chỉ chạy khi ít client và CPU còn dư; gom theo máy nguồn / tên client / thời
//     gian rảnh / tuổi kết nối, không giữ từng dòng.
// Thuần để kiểm bằng script (check:redis-clients) và để client import kiểu.
//
// Nguyên tắc: cảnh báo của Monitor dùng ngưỡng cố định (RULES.redis 'clients'), còn trần
// thật là maxclients — so với trần thật trước khi kết luận. App không tự chạy lệnh sửa;
// lệnh đề xuất có thể ngắt kết nối (timeout, CLIENT KILL) đều kèm điều kiện an toàn.

import { buildPlan, fmtN, fmtSec, share, sortFindings, type Finding, type PlanStep } from '@/lib/diagnose';
import { RULES } from '@/lib/monitor/status';

export interface ClientsNode {
  addr: string;
  version: string;
  clients: number;
  /** null = không đọc được (CONFIG bị chặn, Redis cũ không có trong INFO). */
  maxclients: number | null;
  blocked: number;
  pubsub: number | null;
  newPerSec: number | null;
  rejectedTotal: number;
  /** Bị từ chối trong cửa sổ đo; null = không đo được. */
  rejectedWindow: number | null;
  /** CONFIG timeout (giây, 0 = không bao giờ ngắt client rảnh). */
  timeout: number | null;
  keepalive: number | null;
}

export interface ClientGroup {
  key: string;
  count: number;
  /** Rảnh ≥ IDLE_LONG_SEC. */
  idle: number;
  /** Tuổi < YOUNG_SEC — vừa mở. */
  young: number;
  pubsub: number;
  blocked: number;
  /** Lệnh cuối hay gặp nhất. */
  topCmd: string;
}

export interface ClientList {
  total: number;
  bySource: ClientGroup[];
  byName: ClientGroup[];
  idle: { lt60: number; lt600: number; lt3600: number; ge3600: number };
  young: number;
  pubsub: number;
  blocked: number;
  /** Thời gian CLIENT LIST (tính cả truyền mạng) lâu nhất giữa các node. */
  durationMs: number;
}

export interface RedisClientsFacts {
  nodes: ClientsNode[];
  list: ClientList | null;
  listRefused?: string;
  configError?: string;
  skipped: { addr: string; error: string }[];
  sampleSec: number;
}

export interface RedisClientsDiagnosis {
  at: number;
  headline: string;
  findings: Finding[];
  plan: PlanStep[];
  clients: number;
  maxclients: number | null;
  usedPct: number | null;
  newPerSec: number | null;
  list: ClientList | null;
  listRefused?: string;
  skipped: { addr: string; error: string }[];
}

// ── Ngưỡng ───────────────────────────────────────────────────────────────

export const IDLE_LONG_SEC = 600;
export const YOUNG_SEC = 10;
/** Ước lượng thời gian CLIENT LIST chiếm luồng chính: ~1–2 ms mỗi 1.000 client. */
export const LIST_MS_PER_1K = 2;
const CHURN_WARN = 50;
const CHURN_CRIT = 500;
const DOMINANT_PCT = 40;

const rule = RULES.redis.find((r) => r.metric === 'clients');
const RULE_WARN = rule?.warn ?? 5000;
const RULE_CRIT = rule?.crit ?? 9000;
const r0 = (x: number) => Math.round(x);
const pctOf = (n: ClientsNode) => (n.maxclients ? (n.clients / n.maxclients) * 100 : null);

// ── Phân tích ────────────────────────────────────────────────────────────

export function analyzeRedisClients(f: RedisClientsFacts, at = Date.now()): RedisClientsDiagnosis {
  // Node gần trần nhất quyết định; không biết trần thì node nhiều client nhất.
  const nodes = [...f.nodes].sort((a, b) => (pctOf(b) ?? -1) - (pctOf(a) ?? -1) || b.clients - a.clients);
  const n = nodes[0];
  const multi = nodes.length > 1;
  const at_ = multi && n ? ` (${n.addr})` : '';
  const total = nodes.reduce((a, x) => a + x.clients, 0);
  const out: Finding[] = [];
  const L = f.list;

  if (!n) {
    return { at, headline: 'Không node nào trả lời — chưa phân tích được.', findings: [], plan: [], clients: 0, maxclients: null, usedPct: null, newPerSec: null, list: null, skipped: f.skipped };
  }
  const usedPct = pctOf(n);
  const churn = nodes.reduce((a, x) => a + (x.newPerSec ?? 0), 0);
  const churnKnown = nodes.some((x) => x.newPerSec !== null);

  // 1. Đang / đã từ chối kết nối — chạm maxclients thật.
  const rejNow = nodes.filter((x) => (x.rejectedWindow ?? 0) > 0);
  const rejOld = nodes.filter((x) => x.rejectedTotal > 0);
  if (rejNow.length || rejOld.length) {
    const now = rejNow.length > 0;
    out.push({
      id: 'rejected',
      level: now ? 'crit' : 'warn',
      title: now
        ? `Đang TỪ CHỐI kết nối mới — ${fmtN(rejNow.reduce((a, x) => a + (x.rejectedWindow ?? 0), 0))} lần trong ${f.sampleSec}s đo`
        : `Đã từng từ chối ${fmtN(rejOld.reduce((a, x) => a + x.rejectedTotal, 0))} kết nối vì chạm maxclients (cộng dồn)`,
      evidence: [
        ...(now ? rejNow : rejOld).slice(0, 4).map((x) => `${multi ? `${x.addr}: ` : ''}${fmtN(x.clients)} / ${x.maxclients !== null ? fmtN(x.maxclients) : '?'} client · rejected_connections ${fmtN(x.rejectedTotal)}`),
        now ? 'Ứng dụng đang nhận lỗi "max number of clients reached"' : 'Số cộng dồn từ lúc khởi động / CONFIG RESETSTAT — không chắc đang xảy ra',
      ],
      fix: 'Giảm số kết nối trước (xem các mục nguồn / rảnh / mở-đóng liên tục bên dưới); cần gấp thì nâng maxclients — có hiệu lực ngay, nhưng bị giới hạn bởi ulimit -n của tiến trình Redis và mỗi kết nối tốn thêm RAM.',
      sql: 'CONFIG SET maxclients <lớn hơn>   # ≤ ulimit -n − 32\nINFO clients\nINFO stats   # rejected_connections',
      step: { phase: 'now', text: now ? 'Đang từ chối kết nối: giảm kết nối / nâng maxclients ngay' : 'Đã từng chạm maxclients: rà nguồn kết nối trước khi lặp lại' },
    });
  }

  // 2. So với trần thật.
  if (usedPct !== null && n.maxclients) {
    if (usedPct >= 80 && !rejNow.length) {
      out.push({
        id: 'near-max',
        level: usedPct >= 95 ? 'crit' : 'warn',
        title: `${r0(usedPct)}% maxclients${at_} — còn ${fmtN(n.maxclients - n.clients)} kết nối là bắt đầu từ chối`,
        evidence: [`${fmtN(n.clients)} / ${fmtN(n.maxclients)} client`],
        fix: 'Tìm nguồn đang giữ nhiều kết nối (bấm "Xem client theo nguồn") và giảm pool size của ứng dụng đó; nâng maxclients chỉ là tạm.',
        sql: 'CONFIG SET maxclients <lớn hơn>   # tạm thời, ≤ ulimit -n − 32',
        step: { phase: 'now', text: `Gần trần maxclients (${r0(usedPct)}%): giảm kết nối của nguồn lớn nhất` },
      });
    } else if (usedPct < 50 && n.clients >= RULE_WARN) {
      out.push({
        id: 'threshold',
        level: 'info',
        title: `Mới ${r0(usedPct)}% maxclients — ngưỡng cảnh báo Monitor (${fmtN(RULE_WARN)} / ${fmtN(RULE_CRIT)}) là số cố định`,
        evidence: [`${fmtN(n.clients)} client / maxclients ${fmtN(n.maxclients)}${at_}`],
        fix: `Nếu ${fmtN(n.clients)} kết nối là bình thường với hệ thống này, chỉnh ngưỡng chỉ số "Client đang kết nối" trong bảng ngưỡng của Monitor theo maxclients (vd vàng ${fmtN(r0(n.maxclients * 0.8))}, đỏ ${fmtN(r0(n.maxclients * 0.95))}). Vẫn nên xem các mục bên dưới — số kết nối lớn bất thường thường là pool quá to hoặc rò kết nối.`,
        step: { phase: 'observe', text: 'Chỉnh ngưỡng Monitor theo maxclients thật' },
      });
    }
  }

  // 3. Mở / đóng kết nối liên tục.
  if (churnKnown && churn >= CHURN_WARN) {
    const youngSrc = L?.bySource.filter((g) => g.young > 0).sort((a, b) => b.young - a.young).slice(0, 3) ?? [];
    out.push({
      id: 'churn',
      level: churn >= CHURN_CRIT ? 'crit' : 'warn',
      title: `${fmtN(churn)} kết nối MỚI mỗi giây — ứng dụng mở / đóng kết nối liên tục thay vì dùng lại`,
      evidence: [
        `total_connections_received tăng ${fmtN(churn)}/s trong ${f.sampleSec}s đo`,
        ...youngSrc.map((g) => `${g.key}: ${fmtN(g.young)} kết nối tuổi < ${YOUNG_SEC}s`),
        'Mỗi kết nối mới tốn accept + (TLS) handshake + AUTH trên luồng chính',
      ],
      fix: 'Dùng connection pool / client dùng chung (một client Redis cho cả tiến trình, không tạo mới mỗi request). Hay gặp ở: serverless / cron mỗi lần chạy một kết nối, client tạo trong handler, pool có max-idle quá nhỏ nên đóng rồi mở lại.',
      step: { phase: 'now', text: 'Sửa ứng dụng mở / đóng kết nối liên tục: dùng pool / client dùng chung' },
    });
  }

  // 4. Từ danh sách client: nguồn trội, kết nối rảnh, pub/sub, blocked.
  if (L) {
    const top = L.bySource[0];
    if (top && L.total >= 500 && share(top.count, L.total) >= DOMINANT_PCT) {
      out.push({
        id: 'source',
        level: share(top.count, L.total) >= 60 && (usedPct ?? 0) >= 80 ? 'crit' : 'warn',
        title: `Máy ${top.key} giữ ${fmtN(top.count)} kết nối (${share(top.count, L.total)}%)`,
        evidence: [
          ...L.bySource.slice(0, 5).map((g) => `${g.key}: ${fmtN(g.count)} kết nối · ${fmtN(g.idle)} rảnh ≥ ${fmtSec(IDLE_LONG_SEC)} · lệnh cuối hay gặp ${g.topCmd}`),
        ],
        fix: 'Số kết nối của một máy ≈ số tiến trình × pool size mỗi tiến trình. Giảm pool size (thường 5–20 là đủ vì Redis xử lý mỗi lệnh rất nhanh), hoặc kiểm tra rò kết nối (client tạo ra mà không đóng). Nhiều container sau một IP NAT thì số này là tổng của chúng.',
        step: { phase: 'now', text: `${top.key}: giảm pool size / tìm rò kết nối` },
      });
    }
    const idleLong = L.idle.lt3600 + L.idle.ge3600;
    if (L.total >= 200 && idleLong >= 100 && share(idleLong, L.total) >= 30) {
      const timeoutOff = nodes.some((x) => x.timeout === 0);
      out.push({
        id: 'idle',
        level: 'warn',
        title: `${fmtN(idleLong)} kết nối (${share(idleLong, L.total)}%) rảnh ≥ ${fmtSec(IDLE_LONG_SEC)}${timeoutOff ? ' — timeout = 0 nên không bao giờ bị ngắt' : ''}`,
        evidence: [
          `Rảnh 10 phút–1 giờ: ${fmtN(L.idle.lt3600)} · ≥ 1 giờ: ${fmtN(L.idle.ge3600)}`,
          ...L.bySource.filter((g) => g.idle > 0).sort((a, b) => b.idle - a.idle).slice(0, 3).map((g) => `${g.key}: ${fmtN(g.idle)} kết nối rảnh`),
        ],
        fix: 'Kết nối rảnh lâu thường là pool giữ quá nhiều kết nối nhàn rỗi hoặc rò (tạo mà không đóng). Sửa phía ứng dụng trước. Đặt timeout để Redis tự ngắt kết nối rảnh — KHÔNG ảnh hưởng client pub/sub và client đang chờ BLPOP, nhưng client bị ngắt phải tự kết nối lại (đa số thư viện làm được); thử trên staging, đặt rộng (vd 600s) trước.',
        sql: 'CONFIG SET timeout 600   # giây; ngắt kết nối rảnh quá 10 phút\nCONFIG REWRITE',
        step: { phase: 'now', text: timeoutOff ? 'Đặt timeout (vd 600s) để ngắt kết nối rảnh + sửa pool phía ứng dụng' : 'Giảm kết nối rảnh của pool phía ứng dụng' },
      });
    }
    if (L.pubsub >= 1000) {
      out.push({
        id: 'pubsub',
        level: 'info',
        title: `${fmtN(L.pubsub)} kết nối đang SUBSCRIBE — mỗi subscriber giữ một kết nối riêng`,
        evidence: [`${share(L.pubsub, L.total)}% số kết nối`],
        fix: 'Một tiến trình chỉ cần một kết nối subscriber cho mọi kênh (dùng chung, phân phối trong ứng dụng), không mở một kết nối cho mỗi kênh / mỗi người dùng.',
        step: { phase: 'long', text: 'Dùng chung một kết nối subscriber mỗi tiến trình' },
      });
    }
    if (L.blocked >= 500) {
      out.push({
        id: 'blocked',
        level: 'info',
        title: `${fmtN(L.blocked)} kết nối đang chờ lệnh chặn (BLPOP / XREAD BLOCK…)`,
        evidence: ['Mỗi worker chờ hàng đợi giữ một kết nối suốt thời gian chờ'],
        fix: 'Bình thường với worker hàng đợi; nếu quá nhiều, giảm số worker chờ đồng thời hoặc gom nhiều hàng đợi vào một lệnh BLPOP (nhận nhiều key).',
      });
    }
  }

  // 5. tcp-keepalive tắt — kết nối chết không được phát hiện.
  if (nodes.some((x) => x.keepalive === 0)) {
    out.push({
      id: 'keepalive',
      level: 'warn',
      title: 'tcp-keepalive = 0 — kết nối của client đã chết (mất mạng, máy tắt) vẫn bị giữ',
      evidence: ['Không có keepalive, Redis chỉ biết kết nối chết khi cố ghi vào nó'],
      fix: 'Bật lại keepalive (mặc định 300s từ Redis 3.2.1) — không ảnh hưởng kết nối đang sống.',
      sql: 'CONFIG SET tcp-keepalive 300\nCONFIG REWRITE',
      step: { phase: 'now', text: 'Bật tcp-keepalive 300' },
    });
  }

  // 6. Chưa có danh sách.
  if (!L) {
    out.push({
      id: 'no-list',
      level: 'info',
      title: f.listRefused ? `Chưa xem danh sách client: ${f.listRefused}` : 'Chưa biết kết nối đến từ đâu — bấm "Xem client theo nguồn"',
      evidence: [`CLIENT LIST chạy trên luồng chính, tốn ~${r0((n.clients / 1000) * LIST_MS_PER_1K) || 1} ms với ${fmtN(n.clients)} client — nên để bạn chủ động`],
      fix: f.listRefused ? 'Tự chạy lúc thấp điểm, ưu tiên lọc: CLIENT LIST TYPE pubsub / CLIENT LIST ID <id…>.' : undefined,
      sql: f.listRefused ? 'CLIENT LIST   # lúc thấp điểm\nredis-cli CLIENT LIST | awk \'{print $2}\' | cut -d= -f2 | cut -d: -f1 | sort | uniq -c | sort -rn | head' : undefined,
    });
  }

  if (f.configError) {
    out.push({ id: 'config', level: 'info', title: 'Không đọc được CONFIG — chưa biết maxclients / timeout / tcp-keepalive', evidence: [`CONFIG GET lỗi: ${f.configError}`] });
  }

  const findings = sortFindings(out);
  return {
    at,
    headline: headline(n, total, usedPct, churn, findings, L),
    findings,
    plan: buildPlan(findings, 'Phân tích lại sau khi xử lý — theo dõi số client trên Monitor'),
    clients: n.clients,
    maxclients: n.maxclients,
    usedPct: usedPct === null ? null : Math.round(usedPct * 10) / 10,
    newPerSec: churnKnown ? Math.round(churn * 10) / 10 : null,
    list: L,
    listRefused: f.listRefused,
    skipped: f.skipped,
  };
}

function headline(n: ClientsNode, total: number, usedPct: number | null, churn: number, findings: Finding[], L: ClientList | null): string {
  const head = `${fmtN(n.clients)} client${usedPct !== null ? ` = ${r0(usedPct)}% maxclients` : ''}`;
  const lead = findings.find((x) => x.level === 'crit') ?? findings.find((x) => x.level === 'warn');
  if (lead) return `${head} — ${lead.title.charAt(0).toLowerCase()}${lead.title.slice(1)}.`;
  if (findings.some((x) => x.id === 'threshold')) return `${head} — còn xa trần thật, cảnh báo do ngưỡng cố định của Monitor.`;
  if (L?.bySource[0]) return `${head} — nhiều nhất từ ${L.bySource[0].key} (${fmtN(L.bySource[0].count)}).`;
  return `${head}${total !== n.clients ? ` (cả cụm ${fmtN(total)})` : ''}${churn ? ` · ${fmtN(churn)} kết nối mới/s` : ''}.`;
}
