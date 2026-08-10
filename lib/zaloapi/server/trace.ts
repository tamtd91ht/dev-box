// Zalo API — nhật ký chẩn đoán ra FILE (configs/zaloapi-trace.json).
//
// Console tab chỉ giữ ít dòng và người sửa (tôi) không thấy được máy người dùng.
// Ghi ra file JSON để đọc lại chính xác: listener có chạy không, socket nối
// được không, có khung nào về không, parse tới đâu, route được gọi gì.
//
// Vòng đệm giới hạn (không phình vô hạn), ghi throttle để không spam I/O. TẮT
// khi nhánh Zalo API tắt (không cần trace nếu không dùng).

import { promises as fs } from 'fs';
import { configPath } from '../../configDir';

interface TraceEntry {
  t: number;
  /** iso stamp cho dễ đọc khi mở file. */
  at: string;
  tag: string;
  msg: string;
  data?: unknown;
}

const FILE = configPath('zaloapi-trace.json');
const MAX = 500;

const g = globalThis as typeof globalThis & { __zaloApiTrace?: TraceEntry[]; __zaloApiTraceTimer?: NodeJS.Timeout | null };
const buf: TraceEntry[] = g.__zaloApiTrace ?? (g.__zaloApiTrace = []);

let dirty = false;

async function flush(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  try {
    await fs.writeFile(FILE, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: buf }, null, 2) + '\n', 'utf8');
  } catch {
    /* ghi trace không được làm hỏng luồng chính */
  }
}

/**
 * Ghi một dòng trace. Gộp ghi đĩa (throttle ~1s) để nhiều khung liên tiếp không
 * đập đĩa. data nên nhỏ + đã che khoá nhạy cảm trước khi truyền vào.
 */
export function trace(tag: string, msg: string, data?: unknown): void {
  const now = Date.now();
  buf.push({ t: now, at: new Date(now).toISOString(), tag, msg, data });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  dirty = true;
  if (!g.__zaloApiTraceTimer) {
    g.__zaloApiTraceTimer = setTimeout(() => {
      g.__zaloApiTraceTimer = null;
      void flush();
    }, 1000);
  }
}
