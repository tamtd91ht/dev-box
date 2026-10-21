// Khung chung cho các bộ "Phân tích nguyên nhân" của Monitor (PostgreSQL cache
// hit, Redis hit rate, …): kiểu kết luận, kế hoạch xử lý và vài hàm định dạng.
//
// Thuần (không I/O, không React) để luật của từng hạ tầng kiểm được bằng script
// và để client import kiểu mà không kéo thư viện server (pg / ioredis).

export type FindingLevel = 'crit' | 'warn' | 'info' | 'ok';

export interface Finding {
  id: string;
  level: FindingLevel;
  title: string;
  /** Số liệu thật dẫn tới kết luận. */
  evidence: string[];
  /** Việc nên làm, bằng lời. */
  fix?: string;
  /** Lệnh mẫu để sao chép — app KHÔNG tự chạy. */
  sql?: string;
  /** Bước tương ứng trong "Đề xuất hướng xử lý". */
  step?: { phase: PlanPhase; text: string };
}

/** now: làm được ngay, không downtime · restart: cần lịch bảo trì · long: dài hạn · observe: bật thêm số liệu / theo dõi. */
export type PlanPhase = 'now' | 'restart' | 'long' | 'observe';

export interface PlanStep {
  phase: PlanPhase;
  text: string;
  /** Kết luận sinh ra bước này — UI cuộn tới để xem bằng chứng + lệnh. */
  findingId: string;
}

const RANK: Record<FindingLevel, number> = { crit: 3, warn: 2, info: 1, ok: 0 };

/** Nặng → nhẹ, giữ thứ tự gốc trong cùng mức. */
export const sortFindings = (xs: Finding[]): Finding[] => [...xs].sort((a, b) => RANK[b.level] - RANK[a.level]);

const PHASE_ORDER: PlanPhase[] = ['now', 'restart', 'long', 'observe'];

/**
 * Kế hoạch: việc làm ngay (không downtime, hiệu quả nhất) → việc cần restart →
 * dài hạn → bật thêm số liệu. Trong cùng giai đoạn giữ thứ tự nặng → nhẹ của
 * kết luận. Có việc sửa thật thì thêm bước đo lại (`recheck`) để xác nhận.
 * Kết luận id 'stale' (hiện tại đã ổn, số thấp là cộng dồn cũ) → chỉ giữ bước theo dõi.
 */
export function buildPlan(findings: Finding[], recheck: string): PlanStep[] {
  const stale = findings.some((x) => x.id === 'stale');
  const steps = findings
    .filter((x) => x.step && (!stale || x.step.phase === 'observe'))
    .map((x) => ({ phase: x.step!.phase, text: x.step!.text, findingId: x.id }));
  const plan = PHASE_ORDER.flatMap((ph) => steps.filter((st) => st.phase === ph));
  if (plan.some((st) => st.phase === 'now' || st.phase === 'restart')) {
    plan.push({ phase: 'observe', text: recheck, findingId: '' });
  }
  return plan;
}

// ── Định dạng ─────────────────────────────────────────────────────────────

export const pct = (hit: number, miss: number): number | null =>
  hit + miss > 0 ? Math.round((hit / (hit + miss)) * 1000) / 10 : null;

export const share = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

export const fmtN = (n: number): string => Math.round(n).toLocaleString('vi-VN');

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${u[i]}`;
}

export function fmtSec(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)} phút`;
  if (s < 86400) return `${Math.round(s / 360) / 10} giờ`;
  return `${Math.round(s / 8640) / 10} ngày`;
}
