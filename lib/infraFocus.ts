// Monitor → tab công cụ (Redis, Kafka, RabbitMQ…): mở ĐÚNG CỤM đang báo và
// đúng chỗ liên quan tới cảnh báo, không phải chỉ nhảy sang menu.
//
// Cùng cách làm với lib/openTarget.ts: tab đích chỉ MOUNT sau lần ghé đầu tiên
// và còn phải tự nạp danh sách kết nối, nên yêu cầu được GIỮ LẠI ở đây cho tới
// khi tab đó đăng ký nghe — không đoán thời điểm bằng requestAnimationFrame.

import type { InfraStack } from './automation/types';

export interface InfraFocus {
  stack: InfraStack;
  /** id kết nối (cụm) cần chọn. */
  connId: string;
  /** Mục con của tab cần mở ('lag', 'groups', 'queues', 'overview'…). */
  view?: string;
  /** Kafka: consumer group cần mở sẵn. */
  group?: string;
}

const EVENT = 'devbox:infra-focus';
const pending = new Map<InfraStack, InfraFocus>();

/** Phát yêu cầu. Ghi vào chỗ chờ TRƯỚC — tab chưa mount sẽ nhận khi đăng ký. */
export function emitInfraFocus(f: InfraFocus): void {
  if (typeof window === 'undefined' || !f.connId) return;
  pending.set(f.stack, f);
  window.dispatchEvent(new CustomEvent<InfraFocus>(EVENT, { detail: f }));
}

/**
 * Nghe yêu cầu cho một stack. Gọi khi tab ĐÃ nạp xong danh sách kết nối (để
 * kiểm được connId có tồn tại) — yêu cầu đang chờ được xử lý ngay lúc đăng ký.
 */
export function onInfraFocus(stack: InfraStack, cb: (f: InfraFocus) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const take = (f: InfraFocus) => {
    if (pending.get(stack) === f) pending.delete(stack);
    cb(f);
  };
  const handler = (e: Event) => {
    const f = (e as CustomEvent<InfraFocus>).detail;
    if (f?.stack === stack) take(f);
  };
  window.addEventListener(EVENT, handler);
  const waiting = pending.get(stack);
  if (waiting) take(waiting);
  return () => window.removeEventListener(EVENT, handler);
}
