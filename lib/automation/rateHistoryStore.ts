// DevBox Automation — lưu lịch sử đo của rate watch (server-only).
//
// VÌ SAO PHẢI GHI XUỐNG ĐĨA, dù `breachSince` của watch thường thì không:
//
// Rate watch kết luận bằng một CỬA SỔ THỜI GIAN, không bằng một lần đo. Mất
// buffer = mất khả năng kết luận suốt trọn một cửa sổ. Với cửa sổ 12 giờ thì
// đó là mù nửa ngày — và nhìn từ UI thì watch vẫn xanh, vẫn "đang chạy". Đúng
// kiểu bỏ lọt tệ nhất: không ai biết mình đang không được canh.
//
// Buffer mất trong hai tình huống hoàn toàn bình thường, không phải sự cố:
//   · đóng/mở lại app
//   · ĐỔI LEADER — chỉ một cửa sổ giữ lease runner (xem /api/automation/runner),
//     nên chỉ cần người dùng đóng đúng cửa sổ đang làm leader là cửa sổ khác
//     tiếp quản với buffer RỖNG.
//
// Tình huống thứ hai mới là lý do chính: nó xảy ra thường xuyên và hoàn toàn
// vô hình. Ghi ra một file JSON cạnh config biến rate watch từ "best-effort"
// thành thứ đáng tin.
//
// KÍCH THƯỚC: 153 watch × cửa sổ 12h × poll 60s ≈ 110k mẫu ≈ vài MB. Ghi thưa
// (watcher flush mỗi ~60s, không phải mỗi poll) nên I/O không đáng kể.

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from '../configDir';

const HISTORY_FILE = process.env.AUTOMATION_RATE_HISTORY_PATH
  ? path.resolve(process.cwd(), process.env.AUTOMATION_RATE_HISTORY_PATH)
  : configPath('automation-rate-history.json', ['.automation-rate-history.json']);

/** Một mẫu đã lưu. Cố ý trùng khớp RateSample bên rate.ts. */
export interface StoredSample {
  at: number;
  value: number;
  left?: number;
  /** Mốc vừa đặt lại sau restart — phải giữ, nếu không cửa sổ non lại được coi là đủ. */
  fresh?: boolean;
}

export type HistoryMap = Record<string, StoredSample[]>;

/** Trần cứng, phòng file hỏng/khổng lồ làm nghẽn lúc khởi động. */
const MAX_WATCHES = 500;
const MAX_SAMPLES_PER_WATCH = 6000;
/**
 * Mẫu cũ hơn mức này thì vứt lúc đọc.
 *
 * Cửa sổ dài nhất cho phép là 24h; giữ thêm một quãng rộng để watch có cửa sổ
 * sát trần vẫn dùng lại được trọn vẹn sau khi mở app lại.
 */
const MAX_AGE_MS = 30 * 3600 * 1000;

const sane = (s: unknown): s is StoredSample => {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.at === 'number' && Number.isFinite(o.at) &&
    typeof o.value === 'number' && Number.isFinite(o.value) &&
    (o.left === undefined || (typeof o.left === 'number' && Number.isFinite(o.left))) &&
    (o.fresh === undefined || typeof o.fresh === 'boolean')
  );
};

/**
 * Đọc lịch sử đã lưu. File thiếu/hỏng → map rỗng, KHÔNG ném.
 *
 * Mất lịch sử chỉ làm watch phải gom lại từ đầu (và UI nói rõ điều đó); ném
 * lỗi ở đây thì chặn cả watcher khởi động — hỏng nặng hơn nhiều.
 */
export async function readRateHistory(): Promise<HistoryMap> {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const cutoff = Date.now() - MAX_AGE_MS;
    const out: HistoryMap = {};
    for (const [id, list] of Object.entries(parsed as Record<string, unknown>).slice(0, MAX_WATCHES)) {
      if (!Array.isArray(list)) continue;
      const kept = list
        .filter(sane)
        .filter((s) => s.at >= cutoff)
        .slice(-MAX_SAMPLES_PER_WATCH);
      if (kept.length) out[id] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** Ghi đè toàn bộ lịch sử. Never throws — mất một lần flush không đáng để hỏng poll. */
export async function writeRateHistory(raw: unknown): Promise<void> {
  try {
    if (!raw || typeof raw !== 'object') return;
    const cutoff = Date.now() - MAX_AGE_MS;
    const out: HistoryMap = {};
    for (const [id, list] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_WATCHES)) {
      if (!Array.isArray(list)) continue;
      const kept = list
        .filter(sane)
        .filter((s) => s.at >= cutoff)
        .slice(-MAX_SAMPLES_PER_WATCH);
      if (kept.length) out[id] = kept;
    }
    await fs.writeFile(HISTORY_FILE, JSON.stringify(out), 'utf8');
  } catch {
    /* ghi hỏng thì thôi — buffer trong RAM vẫn đúng, lần flush sau thử lại */
  }
}
