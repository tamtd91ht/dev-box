// Phân tích nguyên nhân CACHE HIT thấp của PostgreSQL — phần LUẬT thuần.
//
// Thuần dữ liệu + hàm thuần (không I/O, không React): lib/pgDiagnose.ts gom số
// liệu thật từ server (chỉ đọc) thành `CacheHitFacts`, file này biến chúng thành
// danh sách kết luận có BẰNG CHỨNG + cách khắc phục. Tách riêng để kiểm bằng
// script (check:pg-diagnose) và để client import được kiểu mà không kéo `pg`.
//
// Nguyên tắc: không đoán. Thiếu số liệu (chưa có pg_stat_statements, thiếu
// quyền, không khai node_exporter) thì nói rõ là không xác định được + cách bật,
// chứ không suy ra kết luận từ chỗ trống.

import {
  buildPlan, fmtBytes, fmtN, pct, share, sortFindings,
  type Finding, type PlanStep,
} from '@/lib/diagnose';

export type { Finding, FindingLevel, PlanPhase, PlanStep } from '@/lib/diagnose';
export { fmtBytes, pct } from '@/lib/diagnose';

export interface DiagDb {
  name: string;
  hit: number;
  read: number;
  /** ms đọc block cộng dồn — chỉ có khi track_io_timing = on. */
  readTimeMs: number | null;
  sizeBytes: number | null;
  statsReset: string | null;
}

export interface DiagTable {
  db: string;
  schema: string;
  table: string;
  heapRead: number;
  heapHit: number;
  idxRead: number;
  idxHit: number;
  toastRead: number;
  seqScan: number;
  seqTupRead: number;
  idxScan: number | null;
  liveTup: number;
  deadTup: number;
  sizeBytes: number | null;
  lastVacuum: string | null;
  /** Tên cột — để suy cột nên đánh index từ câu query. */
  columns?: string[];
  /** Index đang có trên bảng + số lần được dùng. */
  indexes?: DiagIndex[];
}

export interface DiagIndex {
  name: string;
  def: string;
  scans: number | null;
  sizeBytes: number | null;
}

/** Query đang chạy (pg_stat_activity) — nguồn thứ hai khi chưa có pg_stat_statements. */
export interface DiagActive {
  db: string | null;
  query: string;
  ageSec: number;
}

export interface DiagStatement {
  db: string | null;
  query: string;
  calls: number;
  sharedRead: number;
  sharedHit: number;
}

export type StatementsState = 'ok' | 'missing' | 'error';

export interface CacheHitFacts {
  versionNum: number;
  blockSize: number;
  user: string;
  /** superuser hoặc thuộc pg_read_all_stats / pg_monitor — thấy được số liệu của mọi user. */
  canReadAllStats: boolean | null;
  sharedBuffersBytes: number | null;
  effectiveCacheBytes: number | null;
  trackIoTiming: boolean | null;
  hostMemBytes: number | null;
  /** Cộng dồn từ lần reset thống kê. */
  cumulative: { hit: number; read: number };
  /** Hai lần đo cách nhau `sec` giây — tỉ lệ của HIỆN TẠI. */
  window: { hit: number; read: number; sec: number } | null;
  dbs: DiagDb[];
  tables: DiagTable[];
  analyzedDbs: string[];
  skippedDbs: { name: string; error: string }[];
  statements: DiagStatement[];
  statementsTotalRead: number;
  statementsState: StatementsState;
  activeQueries: DiagActive[];
}

export interface CacheHitDiagnosis {
  at: number;
  cumulativePct: number | null;
  currentPct: number | null;
  windowSec: number | null;
  headline: string;
  findings: Finding[];
  /** Kế hoạch xử lý theo thứ tự nên làm — gom từ `step` của các kết luận. */
  plan: PlanStep[];
  analyzedDbs: string[];
  skippedDbs: { name: string; error: string }[];
}

// ── Ngưỡng ────────────────────────────────────────────────────────────────

/** Ít hơn ngần này block trong cửa sổ đo thì tỉ lệ hiện tại không đáng tin. */
export const MIN_WINDOW_BLOCKS = 500;
const HEALTHY_PCT = 95;
const LOW_PCT = 90;
const CRIT_PCT = 80;
/** Bảng chiếm từ ngần này % block đọc ngoài trở lên thì đáng nêu tên. */
const TABLE_SHARE_MIN = 10;
const MAX_TABLE_FINDINGS = 3;
const MAX_STMT_FINDINGS = 3;
const DEFAULT_SB = 128 * 1024 * 1024;

// ── Định dạng ─────────────────────────────────────────────────────────────

const qname = (t: { schema: string; table: string }): string =>
  t.schema === 'public' ? t.table : `${t.schema}.${t.table}`;
const qualified = (t: { schema: string; table: string }): string => `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
const quoteIdent = (s: string): string => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const oneLine = (q: string, max = 160): string => {
  const s = q.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const tableRead = (t: DiagTable): number => t.heapRead + t.idxRead + t.toastRead;

/** Làm tròn xuống bội số đẹp (MB) cho gợi ý shared_buffers. */
function niceMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${Math.max(1, Math.round(mb / 1024))}GB`;
  return `${Math.max(128, Math.round(mb / 128) * 128)}MB`;
}

// ── Suy cột nên đánh index ────────────────────────────────────────────────

/** Câu query có nhắc tới bảng này (theo tên, có/không schema). */
export function mentionsTable(query: string, t: { schema: string; table: string }): boolean {
  const name = t.table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w"])("?${name}"?)([^\\w"]|$)`, 'i').test(query);
}

/**
 * Cột xuất hiện trong điều kiện lọc (WHERE / JOIN … ON) của các query đọc bảng
 * này, xếp theo số block mà các query đó đọc — cột đứng đầu là ứng viên index.
 * Chỉ nhận tên có thật trong bảng nên không bịa cột.
 */
export function guessIndexColumns(t: DiagTable, statements: DiagStatement[]): string[] {
  const cols = new Set((t.columns ?? []).map((c) => c.toLowerCase()));
  if (!cols.size) return [];
  const score = new Map<string, number>();
  for (const s of statements) {
    if (!mentionsTable(s.query, t)) continue;
    const lower = s.query.toLowerCase();
    // Chỉ xét phần sau WHERE / ON — cột trong SELECT list không giúp gì cho index.
    const parts = lower.split(/\bwhere\b|\bon\b/).slice(1).join(' ');
    if (!parts) continue;
    const re = /(?:"?\w+"?\.)?"?(\w+)"?\s*(?:=|<>|!=|<=|>=|<|>|\bin\b|\blike\b|\bilike\b|\bbetween\b|\bis\b|=\s*any)/g;
    const seen = new Set<string>();
    for (let m = re.exec(parts); m; m = re.exec(parts)) {
      const c = m[1];
      if (!cols.has(c) || seen.has(c)) continue;
      seen.add(c);
      score.set(c, (score.get(c) ?? 0) + Math.max(1, s.sharedRead));
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
}

// ── Lệnh EXPLAIN chạy được ngay ───────────────────────────────────────────

const PARAM_RE = /\$\d+/;
const WRITE_RE = /^\s*(with\b[\s\S]*?\)\s*)?(insert|update|delete|merge)\b/i;

/**
 * EXPLAIN cho một câu query THẬT. pg_stat_statements chuẩn hoá giá trị thành
 * $1, $2… — EXPLAIN ANALYZE với tham số trống sẽ lỗi, nên: PG16+ dùng
 * GENERIC_PLAN (xem kế hoạch không cần giá trị), bản cũ hơn thì nhắc thay giá
 * trị. Query ghi (UPDATE/DELETE…) bọc trong BEGIN … ROLLBACK vì ANALYZE chạy thật.
 */
export function explainFor(query: string, versionNum: number, db: string | null): string {
  const q = query.trim().replace(/;\s*$/, '');
  const head = db ? `-- trong database ${db}\n` : '';
  const write = WRITE_RE.test(q);
  const analyze = (body: string) => (write
    ? `BEGIN;  -- ANALYZE chạy THẬT câu lệnh ghi — ROLLBACK để không đổi dữ liệu\nEXPLAIN (ANALYZE, BUFFERS)\n${body};\nROLLBACK;`
    : `EXPLAIN (ANALYZE, BUFFERS)\n${body};`);
  if (!PARAM_RE.test(q)) return head + analyze(q);
  if (versionNum >= 160000) {
    const commented = analyze(q).split('\n').map((l) => `-- ${l}`).join('\n');
    return `${head}-- Query có tham số ($1, $2…): PG16+ xem được kế hoạch chung không cần giá trị\nEXPLAIN (GENERIC_PLAN)\n${q};\n\n-- Đo thật (số block, thời gian): thay $1, $2… bằng giá trị thật, bỏ dấu -- rồi chạy\n${commented}`;
  }
  return `${head}-- Thay $1, $2… bằng giá trị thật rồi chạy\n${analyze(q)}`;
}

const sqlStr = (v: string): string => v.replace(/'/g, "''");

/** Kịch bản điều tra khi chưa biết query nào quét bảng — đã điền sẵn tên bảng. */
function investigateScript(t: DiagTable): string {
  const like = sqlStr(t.table).replace(/[%_]/g, '\\$&');
  return [
    `-- trong database ${t.db}`,
    '-- 1. Query đang chạy có đọc bảng này (chạy vài lần lúc tải cao)',
    'SELECT pid, now() - query_start AS dang_chay, left(query, 500) AS query',
    '  FROM pg_stat_activity',
    ` WHERE state = 'active' AND pid <> pg_backend_pid() AND query ILIKE '%${like}%';`,
    '',
    '-- 2. Cột nào lọc tốt (càng nhiều giá trị khác nhau càng hợp làm index;',
    '--    n_distinct âm = tỉ lệ so với số dòng, -1 = mọi dòng khác nhau)',
    'SELECT attname, n_distinct, null_frac',
    `  FROM pg_stats WHERE schemaname = '${sqlStr(t.schema)}' AND tablename = '${sqlStr(t.table)}'`,
    ' ORDER BY CASE WHEN n_distinct < 0 THEN -n_distinct * 1e9 ELSE n_distinct END DESC;',
    '',
    '-- 3. Ghi log mọi query chậm hơn 500ms để bắt đúng query quét bảng (superuser)',
    "ALTER SYSTEM SET log_min_duration_statement = '500ms';",
    'SELECT pg_reload_conf();',
    '',
    `-- 4. Có query rồi: "Seq Scan on ${t.table}" + "Rows Removed by Filter" lớn`,
    '--    = cột trong dòng Filter cần index',
    'EXPLAIN (ANALYZE, BUFFERS)',
    `SELECT * FROM ${qualified(t)} WHERE <điều kiện của query vừa tìm được>;`,
  ].join('\n');
}

/** "CREATE UNIQUE INDEX x ON public.t USING btree (a, b)" → "a, b". */
const indexCols = (def: string): string => def.match(/\(([^)]*)\)\s*(WHERE.*)?$/i)?.[1] ?? def;

// ── Phân tích ─────────────────────────────────────────────────────────────

export function analyzeCacheHit(f: CacheHitFacts, at = Date.now()): CacheHitDiagnosis {
  const out: Finding[] = [];
  const cumulativePct = pct(f.cumulative.hit, f.cumulative.read);
  const enoughWindow = !!f.window && f.window.hit + f.window.read >= MIN_WINDOW_BLOCKS;
  const currentPct = enoughWindow && f.window ? pct(f.window.hit, f.window.read) : null;
  const oldestReset = f.dbs.map((d) => d.statsReset).filter((x): x is string => !!x).sort()[0] ?? null;
  const since = oldestReset ? `từ ${new Date(oldestReset).toLocaleString('vi-VN')}` : 'từ lúc server khởi động / reset thống kê';

  // 1. Hiện tại hay chuyện cũ? — câu hỏi đầu tiên, quyết định có cần làm gì không.
  if (f.window && !enoughWindow) {
    out.push({
      id: 'window-low',
      level: 'info',
      title: `Tải lúc đo quá thấp — chưa đo được tỉ lệ hiện tại`,
      evidence: [
        `${fmtN(f.window.hit + f.window.read)} block trong ${f.window.sec}s (cần ≥ ${MIN_WINDOW_BLOCKS})`,
        `Các kết luận dưới đây dựa trên số cộng dồn ${since}`,
      ],
    });
  } else if (currentPct !== null && f.window) {
    if (currentPct >= HEALTHY_PCT && (cumulativePct ?? 100) < LOW_PCT) {
      out.push({
        id: 'stale',
        level: 'info',
        step: { phase: 'observe', text: 'Không cần xử lý gấp — theo dõi tiếp; muốn số đo sạch thì reset thống kê (pg_stat_reset)' },
        title: `Hiện tại đã ổn (${currentPct}%) — con số thấp là cộng dồn từ trước`,
        evidence: [
          `${f.window.sec}s vừa đo: ${currentPct}% trên ${fmtN(f.window.hit + f.window.read)} block`,
          `Cộng dồn ${since}: ${cumulativePct}%`,
          'Một đợt quét lớn trong quá khứ (backup logic, báo cáo, migrate…) hoặc lúc mới khởi động có thể kéo số cộng dồn xuống rất lâu.',
        ],
        fix: 'Không cần xử lý gấp. Muốn số đo sạch để theo dõi tiếp thì reset thống kê của database (ảnh hưởng mọi công cụ giám sát đọc số này).',
        sql: 'SELECT pg_stat_reset();  -- chạy trong từng database cần reset',
      });
    } else if (currentPct < LOW_PCT) {
      out.push({
        id: 'current-low',
        level: currentPct < CRIT_PCT ? 'crit' : 'warn',
        title: `Đang xảy ra ngay lúc này: cache hit ${currentPct}%`,
        evidence: [
          `${f.window.sec}s vừa đo: ${fmtN(f.window.read)} block đọc ngoài / ${fmtN(f.window.hit + f.window.read)} block`,
          `Cộng dồn ${since}: ${cumulativePct ?? '?'}%`,
        ],
      });
    }
  }

  // 2. Đọc ngoài có thật sự xuống đĩa không (track_io_timing).
  const ioRead = f.dbs.reduce((a, d) => a + d.read, 0);
  const ioMs = f.dbs.reduce((a, d) => a + (d.readTimeMs ?? 0), 0);
  if (f.trackIoTiming && ioRead > 0) {
    const avgMs = ioMs / ioRead;
    if (avgMs < 0.05) {
      out.push({
        id: 'io-pagecache',
        level: 'info',
        title: 'Đọc ngoài chủ yếu trúng page cache của hệ điều hành — không phải đĩa',
        evidence: [`Trung bình ${(avgMs * 1000).toFixed(1)} µs/block (đĩa thật thường ≥ 100 µs)`],
        fix: 'Mức độ nhẹ hơn tên cảnh báo: dữ liệu vẫn nằm trong RAM của máy, chỉ là ngoài shared_buffers. Tăng shared_buffers (xem bên dưới) sẽ cải thiện, nhưng không gấp.',
      });
    } else if (avgMs >= 0.5) {
      out.push({
        id: 'io-disk',
        level: 'warn',
        title: `Đang đọc từ đĩa thật — trung bình ${avgMs.toFixed(2)} ms/block`,
        evidence: [`${fmtN(ioRead)} block đọc ngoài, tổng ${Math.round(ioMs / 1000)}s chờ I/O ${since}`],
        fix: 'Dữ liệu cần đọc không còn trong RAM của máy — query chậm thật. Ưu tiên các nguyên nhân bảng/query bên dưới; sau đó mới tới bộ nhớ.',
      });
    }
  } else if (f.trackIoTiming === false) {
    out.push({
      id: 'io-unknown',
      level: 'info',
      step: { phase: 'observe', text: 'Bật track_io_timing để lần sau biết đọc ngoài có xuống đĩa thật không' },
      title: 'Chưa phân biệt được đọc đĩa thật hay page cache của OS',
      evidence: ['track_io_timing = off'],
      fix: 'Bật track_io_timing (tốn rất ít) để lần phân tích sau biết block đọc ngoài có xuống đĩa không.',
      sql: "ALTER SYSTEM SET track_io_timing = on;\nSELECT pg_reload_conf();",
    });
  }

  // 3. Database nào gây ra.
  const clusterRead = f.dbs.reduce((a, d) => a + d.read, 0);
  const named = f.dbs.filter((d) => d.read > 0).sort((a, b) => b.read - a.read);
  if (named.length > 1 && share(named[0].read, clusterRead) >= 50) {
    out.push({
      id: 'db-hot',
      level: 'info',
      title: `Phần lớn đọc ngoài đến từ database ${named[0].name}`,
      evidence: named.slice(0, 3).map((d) => `${d.name}: ${share(d.read, clusterRead)}% block đọc ngoài · cache hit ${pct(d.hit, d.read) ?? '?'}% · ${fmtBytes(d.sizeBytes)}`),
    });
  }

  // 4. Bảng nào bị đọc ngoài nhiều nhất, và vì sao.
  const tablesRead = f.tables.reduce((a, t) => a + tableRead(t), 0);
  const denom = Math.max(clusterRead, tablesRead);
  const hot = [...f.tables].sort((a, b) => tableRead(b) - tableRead(a))
    .filter((t) => tableRead(t) > 0 && share(tableRead(t), denom) >= TABLE_SHARE_MIN)
    .slice(0, MAX_TABLE_FINDINGS);
  for (const t of hot) {
    const sh = share(tableRead(t), denom);
    const avgRows = t.seqScan > 0 ? t.seqTupRead / t.seqScan : 0;
    const seqHeavy = t.liveTup >= 10_000 && t.seqScan >= 50 && avgRows >= 0.3 * t.liveTup;
    const where = `${t.db} › ${qname(t)}`;
    const base = [
      `${fmtN(tableRead(t))} block đọc ngoài = ${sh}% toàn server (heap ${fmtN(t.heapRead)} · index ${fmtN(t.idxRead)}${t.toastRead ? ` · toast ${fmtN(t.toastRead)}` : ''})`,
      `${fmtN(t.liveTup)} dòng · ${fmtBytes(t.sizeBytes)}`,
    ];
    if (seqHeavy) {
      // Query thật có đọc bảng: pg_stat_statements (nặng nhất trước) + đang chạy.
      const related: DiagStatement[] = [
        ...f.statements.filter((s) => mentionsTable(s.query, t)).sort((a, b) => b.sharedRead - a.sharedRead),
        ...f.activeQueries.filter((a) => (a.db === null || a.db === t.db) && mentionsTable(a.query, t))
          .map((a) => ({ db: a.db, query: a.query, calls: 0, sharedRead: 1, sharedHit: 0 })),
      ];
      const cols = guessIndexColumns(t, related);
      const top = related[0];
      const idx = t.indexes ?? [];
      const idxLine = !t.indexes
        ? ''
        : idx.length
          ? `Index hiện có: ${idx.map((i) => `${i.name} (${indexCols(i.def)}) · dùng ${i.scans === null ? '?' : fmtN(i.scans)} lần`).join(' · ')}`
          : 'Bảng chưa có index nào (kể cả khoá chính)';
      const create = cols.length ? `CREATE INDEX CONCURRENTLY ON ${qualified(t)} (${cols.map(quoteIdent).join(', ')});` : '';
      out.push({
        id: `seq:${t.db}.${t.schema}.${t.table}`,
        level: sh >= 30 ? 'crit' : 'warn',
        step: {
          phase: 'now',
          text: cols.length
            ? `Tạo index (${cols.join(', ')}) cho ${where} — CONCURRENTLY, nên chạy giờ thấp điểm`
            : top
              ? `Chạy EXPLAIN query đọc ${where}, đánh index cho cột trong dòng Filter`
              : `Bắt query quét ${where} bằng kịch bản điều tra, rồi đánh index cho cột lọc`,
        },
        title: `Bảng ${where} bị quét toàn bộ ${fmtN(t.seqScan)} lần — thiếu index`,
        evidence: [
          ...base,
          `seq_scan ${fmtN(t.seqScan)} (trung bình ${fmtN(avgRows)} dòng/lần ≈ ${Math.round((avgRows / Math.max(1, t.liveTup)) * 100)}% bảng) · idx_scan ${t.idxScan === null ? '?' : fmtN(t.idxScan)}`,
          idxLine,
          top
            ? `Query ${top.calls ? `đọc bảng nặng nhất (${fmtN(top.calls)} lần chạy)` : 'đang chạy có đọc bảng'}: ${oneLine(top.query)}`
            : f.statementsState === 'ok'
              ? 'pg_stat_statements không ghi nhận query nào nhắc tới bảng này (có thể đã bị đẩy khỏi danh sách top)'
              : 'Chưa có pg_stat_statements và lúc đo không có query nào đang chạy trên bảng — chưa biết query nào quét',
          cols.length
            ? `Cột lọc nhiều nhất trong các query đọc bảng này: ${cols.join(', ')}`
            : top ? 'Không suy được cột lọc từ câu query — xem dòng Filter trong kế hoạch thực thi' : '',
        ].filter(Boolean),
        fix: cols.length
          ? 'Tạo index cho cột lọc (CONCURRENTLY để không khoá ghi), rồi chạy lại EXPLAIN query nặng để xác nhận đã chuyển từ Seq Scan sang Index Scan.'
          : top
            ? 'Chạy EXPLAIN query dưới đây: dòng "Seq Scan on …" kèm "Filter: …" và "Rows Removed by Filter" lớn — cột trong Filter là cột cần index.'
            : 'Chạy kịch bản dưới đây (đã điền sẵn tên bảng) để bắt query quét bảng, rồi đánh index cho cột trong Filter của kế hoạch thực thi.',
        sql: cols.length
          ? `-- trong database ${t.db}\n${create}${top ? `\n\n-- Xác nhận sau khi tạo index:\n${explainFor(top.query, f.versionNum, null)}` : ''}`
          : top ? explainFor(top.query, f.versionNum, t.db) : investigateScript(t),
      });
    } else {
      out.push({
        id: `big:${t.db}.${t.schema}.${t.table}`,
        level: sh >= 30 ? 'warn' : 'info',
        step: { phase: 'long', text: `Giảm dữ liệu nóng của ${where}: archive / partition phần cũ, bỏ index thừa` },
        title: `Bảng ${where} lớn hơn phần bộ nhớ dành cho nó`,
        evidence: [
          ...base,
          `Đọc chủ yếu qua index (idx_scan ${t.idxScan === null ? '?' : fmtN(t.idxScan)}, seq_scan ${fmtN(t.seqScan)}) — query đã dùng index nhưng truy cập trải rộng trên bảng lớn`,
        ],
        fix: 'Giảm lượng dữ liệu nóng: archive / partition theo thời gian phần ít dùng, bỏ cột/index thừa, kiểm tra bloat; nếu toàn bộ đều nóng thật thì cần thêm bộ nhớ.',
      });
    }
  }

  // 5. Bloat: cùng dữ liệu nhưng chiếm nhiều block hơn.
  const bloated = f.tables
    .filter((t) => t.deadTup >= 10_000 && t.deadTup / Math.max(1, t.liveTup + t.deadTup) >= 0.2)
    .sort((a, b) => b.deadTup - a.deadTup)
    .slice(0, 3);
  for (const t of bloated) {
    const ratio = Math.round((t.deadTup / (t.liveTup + t.deadTup)) * 100);
    out.push({
      id: `bloat:${t.db}.${t.schema}.${t.table}`,
      level: ratio >= 50 ? 'warn' : 'info',
      step: { phase: 'now', text: `Vacuum ${t.db} › ${qname(t)}${ratio >= 50 ? ' rồi pg_repack để thu gọn' : ''}, chỉnh autovacuum cho bảng` },
      title: `Bảng ${t.db} › ${qname(t)} có ${ratio}% dòng chết (bloat)`,
      evidence: [
        `${fmtN(t.deadTup)} dòng chết / ${fmtN(t.liveTup)} dòng sống · ${fmtBytes(t.sizeBytes)}`,
        t.lastVacuum ? `Vacuum gần nhất: ${new Date(t.lastVacuum).toLocaleString('vi-VN')}` : 'Chưa từng được vacuum (theo thống kê hiện có)',
      ],
      fix: ratio >= 50
        ? 'Vacuum ngay; bảng đã phình nhiều thì VACUUM không trả lại dung lượng — dùng pg_repack (không khoá) để thu gọn. Sau đó hạ autovacuum_vacuum_scale_factor cho bảng này.'
        : 'Vacuum bảng và cho autovacuum chạy thường hơn trên bảng này.',
      sql: `VACUUM (ANALYZE, VERBOSE) ${qualified(t)};\nALTER TABLE ${qualified(t)} SET (autovacuum_vacuum_scale_factor = 0.05);`,
    });
  }

  // 6. Query nào đọc nhiều nhất.
  if (f.statementsState === 'ok' && f.statements.length) {
    const total = Math.max(f.statementsTotalRead, f.statements.reduce((a, s) => a + s.sharedRead, 0));
    const top = [...f.statements].sort((a, b) => b.sharedRead - a.sharedRead)
      .filter((s) => s.sharedRead > 0 && share(s.sharedRead, total) >= 10)
      .slice(0, MAX_STMT_FINDINGS);
    top.forEach((s, i) => {
      const sh = share(s.sharedRead, total);
      out.push({
        id: `stmt:${i}`,
        level: sh >= 40 ? 'warn' : 'info',
        step: { phase: 'now', text: `Tối ưu query chiếm ${sh}% đọc ngoài (${oneLine(s.query, 70)}) — xem EXPLAIN` },
        title: `Query đọc ngoài nhiều ${i === 0 ? 'nhất' : `thứ ${i + 1}`} (${sh}% tổng)${s.db ? ` — ${s.db}` : ''}`,
        evidence: [
          oneLine(s.query),
          `${fmtN(s.calls)} lần chạy · ${fmtN(s.sharedRead)} block đọc ngoài (≈ ${fmtBytes(s.sharedRead * f.blockSize)}) · ${fmtN(s.sharedRead / Math.max(1, s.calls))} block/lần`,
        ],
        fix: 'Xem kế hoạch thực thi để biết vì sao đọc nhiều: Seq Scan trên bảng lớn → index; Index Scan đọc nhiều dòng → thu hẹp điều kiện / phân trang theo khoá thay vì OFFSET lớn; SELECT * trên bảng rộng → chỉ lấy cột cần.',
        sql: explainFor(s.query, f.versionNum, s.db),
      });
    });
  } else if (f.statementsState === 'missing') {
    out.push({
      id: 'stmt-missing',
      level: 'info',
      step: { phase: 'observe', text: 'Bật pg_stat_statements (cần restart) để lần phân tích sau chỉ ra đúng câu query' },
      title: 'Chưa có pg_stat_statements — chưa xác định được query nào gây ra',
      evidence: ['Extension pg_stat_statements chưa được cài trong các database đã xét'],
      fix: 'Thêm vào shared_preload_libraries (cần restart), rồi tạo extension. Sau một thời gian chạy, phân tích lại sẽ chỉ ra đúng câu query.',
      sql: "ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';  -- giữ các thư viện đang có\n-- restart PostgreSQL, rồi:\nCREATE EXTENSION pg_stat_statements;",
    });
  }

  // 7. Bộ nhớ.
  const sb = f.sharedBuffersBytes;
  if (sb !== null) {
    if (f.hostMemBytes) {
      const ratio = sb / f.hostMemBytes;
      if (ratio < 0.15) {
        out.push({
          id: 'sb-small',
          level: 'warn',
          step: { phase: 'restart', text: `Tăng shared_buffers lên ${niceMb(f.hostMemBytes * 0.25)} (effective_cache_size ${niceMb(f.hostMemBytes * 0.65)}) — cần restart, lên lịch bảo trì` },
          title: `shared_buffers chỉ ${fmtBytes(sb)} = ${Math.round(ratio * 1000) / 10}% RAM máy`,
          evidence: [`RAM máy ${fmtBytes(f.hostMemBytes)} (node_exporter) · khuyến nghị ~25%`],
          fix: 'Tăng shared_buffers lên khoảng 25% RAM. Cần restart PostgreSQL. Đặt effective_cache_size ~ 50–75% RAM để planner ưu tiên index.',
          sql: `ALTER SYSTEM SET shared_buffers = '${niceMb(f.hostMemBytes * 0.25)}';\nALTER SYSTEM SET effective_cache_size = '${niceMb(f.hostMemBytes * 0.65)}';\n-- restart PostgreSQL để shared_buffers có hiệu lực`,
        });
      }
      const dataBytes = f.dbs.reduce((a, d) => a + (d.sizeBytes ?? 0), 0);
      if (dataBytes > f.hostMemBytes) {
        out.push({
          id: 'data-gt-ram',
          level: 'info',
          step: { phase: 'long', text: 'Nếu sau các bước trên tỉ lệ vẫn thấp: tăng RAM hoặc giảm dữ liệu nóng' },
          title: `Dữ liệu (${fmtBytes(dataBytes)}) lớn hơn RAM máy (${fmtBytes(f.hostMemBytes)})`,
          evidence: ['Không sao nếu phần hay dùng nhỏ; nếu các bảng nóng ở trên đã cộng lại xấp xỉ RAM thì chỉ còn cách tăng RAM hoặc giảm dữ liệu nóng.'],
        });
      }
    } else if (sb <= DEFAULT_SB) {
      out.push({
        id: 'sb-default',
        level: 'warn',
        step: { phase: 'restart', text: 'Đặt shared_buffers ≈ 25% RAM máy — cần restart, lên lịch bảo trì' },
        title: `shared_buffers đang là mặc định ${fmtBytes(sb)}`,
        evidence: ['Giá trị mặc định chỉ hợp với máy thử; server thật nên ~25% RAM', 'Không biết RAM máy (connection chưa khai node_exporter) nên chưa tính được con số cụ thể'],
        fix: 'Đặt shared_buffers ≈ 25% RAM máy, effective_cache_size ≈ 50–75% RAM; restart PostgreSQL.',
        sql: "ALTER SYSTEM SET shared_buffers = '<25% RAM, vd 4GB>';\n-- restart PostgreSQL",
      });
    }
  }

  // 8. Giới hạn của chính lần phân tích.
  if (f.canReadAllStats === false) {
    out.push({
      id: 'priv',
      level: 'info',
      step: { phase: 'observe', text: `GRANT pg_monitor TO ${quoteIdent(f.user)} để phân tích thấy đủ số liệu` },
      title: `User ${f.user} không thấy số liệu của user khác`,
      evidence: ['Thiếu role pg_read_all_stats / pg_monitor — query của user khác hiện là <insufficient privilege>'],
      fix: 'Cấp quyền giám sát (chỉ đọc thống kê) rồi phân tích lại.',
      sql: `GRANT pg_monitor TO ${quoteIdent(f.user)};`,
    });
  }

  const findings = sortFindings(out);
  return {
    at,
    cumulativePct,
    currentPct,
    windowSec: f.window?.sec ?? null,
    headline: headline(findings, currentPct, cumulativePct),
    findings,
    plan: buildPlan(findings, 'Phân tích lại sau khi xử lý — mục tiêu cache hit hiện tại ≥ 95%'),
    analyzedDbs: f.analyzedDbs,
    skippedDbs: f.skippedDbs,
  };
}

function headline(findings: Finding[], current: number | null, cumulative: number | null): string {
  if (findings.some((x) => x.id === 'stale')) return `Không có sự cố hiện tại — ${current}% lúc này, ${cumulative}% là số cộng dồn cũ.`;
  // "Đang xảy ra" / "đọc đĩa thật" là triệu chứng, không phải nguyên nhân.
  const cause = findings.find((x) => (x.level === 'crit' || x.level === 'warn') && x.id !== 'current-low' && x.id !== 'io-disk');
  const now = current !== null ? `${current}% lúc này` : `${cumulative ?? '?'}% cộng dồn`;
  if (!cause) return `Cache hit ${now} — không tìm thấy nguyên nhân rõ ràng từ số liệu hiện có.`;
  return `Cache hit ${now} — nguyên nhân chính: ${cause.title.charAt(0).toLowerCase()}${cause.title.slice(1)}.`;
}
