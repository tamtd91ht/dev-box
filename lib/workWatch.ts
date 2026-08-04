// Server-only scheduler cho cảnh báo Công việc — quét mỗi phút (lib/workTasks
// .runAlertSweep), giữ feed sự kiện in-memory để client poll và hiện toast +
// hòm thông báo. Cùng khuôn gitAutoPull/mailWatch: singleton trên globalThis,
// khởi động từ instrumentation hoặc lazily bởi request đầu tiên.
//
// Cờ "đã nhắc" nằm TRONG document trên Mongo (global) — feed ở đây chỉ là kênh
// đưa sự kiện tới UI của máy này; server khác chạy song song không nhắc trùng
// nhờ updateOne có điều kiện trong runAlertSweep.

import { runAlertSweep, type WorkAlertEvent } from './workTasks';

const INTERVAL_MS = 60_000;
const FEED_CAP = 50;

export interface WorkWatchState {
  running: boolean;
  runSeq: number;
  lastRunAt: number | null;
  /** Tăng mỗi khi có sự kiện mới — client so với lần đọc trước. */
  alertSeq: number;
  /** Sự kiện gần nhất, mới trước; mỗi cái kèm seq để client lọc phần chưa xem. */
  alerts: (WorkAlertEvent & { seq: number })[];
}

interface Store {
  timer: ReturnType<typeof setInterval> | null;
  state: WorkWatchState;
}

const g = globalThis as typeof globalThis & { __workWatch?: Store };

function store(): Store {
  if (!g.__workWatch) {
    g.__workWatch = {
      timer: null,
      state: { running: false, runSeq: 0, lastRunAt: null, alertSeq: 0, alerts: [] },
    };
  }
  return g.__workWatch;
}

async function cycle(): Promise<void> {
  const s = store();
  if (s.state.running) return;
  s.state.running = true;
  try {
    const events = await runAlertSweep();
    for (const ev of events) {
      s.state.alertSeq += 1;
      s.state.alerts = [{ ...ev, seq: s.state.alertSeq }, ...s.state.alerts].slice(0, FEED_CAP);
    }
  } catch {
    // Mongo tạm mất kết nối — cờ đã-nhắc chưa set nên tick sau nhắc bù.
  } finally {
    s.state.running = false;
    s.state.lastRunAt = Date.now();
    s.state.runSeq += 1;
  }
}

/** Khởi động scheduler 1 phút/lần (idempotent). */
export function ensureWorkWatch(): void {
  const s = store();
  if (s.timer) return;
  s.timer = setInterval(() => void cycle(), INTERVAL_MS);
  (s.timer as { unref?: () => void }).unref?.();
  void cycle();
}

export function getWorkWatchState(): WorkWatchState {
  return store().state;
}

/** Quét ngay (sau khi thêm/sửa task) rồi trả state mới. */
export async function runWorkWatchNow(): Promise<WorkWatchState> {
  await cycle();
  return store().state;
}
