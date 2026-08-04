// Server-only background mail watch — đếm mail đến chưa đọc (INBOX UNSEEN)
// trên MỌI tài khoản mail đã cấu hình, 10 phút/lần, giữ snapshot in-memory để
// client poll rẻ và vẽ badge số lượng lên tab Mail.
//
// Cùng khuôn với lib/gitAutoPull: singleton trên globalThis (sống qua hot-reload
// của next dev), khởi động từ instrumentation.ts khi server boot hoặc lazily
// bởi request /api/mail/watch đầu tiên.

import { listAccounts } from './mailAccounts';
import { inboxUnseen } from './mailServer';

/** Chu kỳ kiểm tra — 10 phút, đổi được qua env (phút) khi cần test. */
const INTERVAL_MS =
  Math.max(1, Number(process.env.MAIL_WATCH_MINUTES) || 10) * 60_000;

export interface MailWatchAccount {
  id: string;
  label: string;
  email: string;
  /** Số mail chưa đọc trong INBOX ở lần kiểm gần nhất. */
  unseen: number;
  /** Lỗi kết nối/đăng nhập của lần kiểm gần nhất (nếu có). */
  error?: string;
}

export interface MailWatchState {
  intervalMs: number;
  running: boolean;
  /** Tăng sau mỗi chu kỳ HOÀN TẤT — client dựa vào đây biết có lần kiểm mới. */
  runSeq: number;
  lastRunAt: number | null;
  accounts: MailWatchAccount[];
  /** Tổng chưa đọc của mọi tài khoản kiểm được (badge trên tab Mail). */
  totalUnseen: number;
}

interface Store {
  timer: ReturnType<typeof setInterval> | null;
  state: MailWatchState;
}

const g = globalThis as typeof globalThis & { __mailWatch?: Store };

function store(): Store {
  if (!g.__mailWatch) {
    g.__mailWatch = {
      timer: null,
      state: {
        intervalMs: INTERVAL_MS,
        running: false,
        runSeq: 0,
        lastRunAt: null,
        accounts: [],
        totalUnseen: 0,
      },
    };
  }
  return g.__mailWatch;
}

/** Một chu kỳ kiểm tra. Tuần tự từng tài khoản để không dội kết nối IMAP.
 *  Không bao giờ throw — tài khoản lỗi được ghi lại và đếm 0. */
async function cycle(): Promise<void> {
  const s = store();
  if (s.state.running) return; // chu kỳ chậm không được chồng lên tick sau
  s.state.running = true;
  try {
    const accounts = await listAccounts();
    const results: MailWatchAccount[] = [];
    for (const a of accounts) {
      try {
        const unseen = await inboxUnseen(a);
        results.push({ id: a.id, label: a.label, email: a.email, unseen });
      } catch (e) {
        results.push({
          id: a.id,
          label: a.label,
          email: a.email,
          unseen: 0,
          error: (e as Error).message || 'IMAP error',
        });
      }
    }
    s.state.accounts = results;
    s.state.totalUnseen = results.reduce((sum, r) => sum + r.unseen, 0);
  } catch {
    // listAccounts lỗi (file registry hỏng) — giữ snapshot cũ tới tick sau.
  } finally {
    s.state.running = false;
    s.state.lastRunAt = Date.now();
    s.state.runSeq += 1;
  }
}

/** Khởi động scheduler 10 phút (idempotent). */
export function ensureMailWatch(): void {
  const s = store();
  if (s.timer) return;
  s.timer = setInterval(() => void cycle(), INTERVAL_MS);
  // Không giữ process sống chỉ vì timer này.
  (s.timer as { unref?: () => void }).unref?.();
  void cycle(); // kiểm ngay khi app start
}

/** Snapshot mới nhất cho client poll. */
export function getMailWatchState(): MailWatchState {
  return store().state;
}

/** Kiểm ngay lập tức (nút "kiểm tra mail") rồi trả snapshot mới. */
export async function runMailWatchNow(): Promise<MailWatchState> {
  await cycle();
  return store().state;
}
