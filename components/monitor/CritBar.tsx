'use client';

// Cảnh báo critical toàn cục — ở góc trái footer: nút giống hệt chuông thông
// báo (khác icon: tam giác chấm than) + số kết nối đỏ, kế bên là tên loại. Chỉ hiện khi có loại hạ tầng
// đang đỏ (crit hoặc mất kết nối). Footer có mặt ở mọi tab, mọi vị trí menu
// (kể cả menu ẩn) nên cảnh báo cũng vậy.
//
// Mỗi giây một nhịp (quầng sáng như chuông), mỗi nhịp hiện tên một loại đang đỏ, xen kẽ nhau
// (Kafka → Rabbit → …). Bấm là về tab Monitor.
//
// Không làm lớp nổi đè: <webview> vẽ ở tầng native, che mọi HTML bất kể z-index
// — nên cảnh báo phải nằm trong khung app (footer), không chồng lên trang.

import { useEffect, useRef, useState } from 'react';
import type { InfraStack } from '@/lib/automation/types';
import { STACK_META } from '@/lib/monitor/status';

export interface CritStack { stack: InfraStack; n: number }

const TICK_MS = 1000;

/** Cầu ra hệ điều hành (electron/preload.cjs) — không có khi chạy trên trình duyệt. */
interface DesktopAlert {
  critical: (title: string, body: string) => void;
  onOpen: (cb: () => void) => () => void;
}
const desktopAlert = (): DesktopAlert | undefined =>
  typeof window !== 'undefined' ? (window as unknown as { desktopAlert?: DesktopAlert }).desktopAlert : undefined;

const label = (s: InfraStack): string => STACK_META[s].label;

/**
 * Báo ra ngoài app khi một loại VỪA đỏ (hoặc thêm kết nối đỏ): main chỉ nháy
 * taskbar + bắn toast khi cửa sổ không ở trước mặt. Bấm toast → `onOpen`.
 * Gọi một lần ở gốc app, tách khỏi badge để việc vẽ lại badge không báo trùng.
 */
export function useCritAlerts(stacks: CritStack[], onOpen: () => void): void {
  const prev = useRef<Partial<Record<InfraStack, number>>>({});
  useEffect(() => {
    const fresh = stacks.filter((s) => s.n > (prev.current[s.stack] ?? 0));
    prev.current = Object.fromEntries(stacks.map((s) => [s.stack, s.n]));
    if (!fresh.length) return;
    desktopAlert()?.critical(
      `Critical: ${fresh.map((s) => label(s.stack)).join(', ')}`,
      `${fresh.map((s) => `${label(s.stack)} ${s.n} kết nối`).join(' · ')} — bấm để mở Monitor`,
    );
  }, [stacks]);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => desktopAlert()?.onOpen(() => onOpenRef.current()), []);
}

/** Tam giác cảnh báo có dấu chấm than — SVG để không phụ thuộc font emoji. */
function WarnIcon() {
  return (
    <svg className="crit-ico" viewBox="0 0 24 24" aria-hidden>
      <path d="M10.3 3.4a2 2 0 0 1 3.4 0l8.4 14.6A2 2 0 0 1 20.4 21H3.6a2 2 0 0 1-1.7-3l8.4-14.6Z" fill="currentColor" />
      <path d="M12 8.6v5.6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="12" cy="17.4" r="1.35" fill="#fff" />
    </svg>
  );
}

interface Props {
  stacks: CritStack[];
  onOpen: () => void;
}

export default function CritBadge({ stacks, onOpen }: Props) {
  const [tick, setTick] = useState(0);
  const active = stacks.length > 0;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [active]);

  if (!active) return null;
  const cur = stacks[tick % stacks.length];
  const total = stacks.reduce((a, s) => a + s.n, 0);
  const all = stacks.map((s) => `${label(s.stack)} ${s.n}`).join(' · ');

  return (
    <span className="crit">
      {/* Cùng nút với chuông thông báo (ntc-bell + ms-unread), chỉ khác icon. */}
      <button
        type="button"
        className="ntc-bell has-unread crit-bell"
        onClick={onOpen}
        title={`Nghiêm trọng: ${all} kết nối — bấm để mở Monitor`}
        aria-label={`Cảnh báo nghiêm trọng: ${all}. Mở Monitor`}
      >
        <WarnIcon />
        <span className="ms-unread">{total > 99 ? '99+' : total}</span>
      </button>
      {/* Mỗi nhịp hiện nhẹ tên một loại đang đỏ, xen kẽ (key đổi → mờ vào lại). */}
      <span key={tick} className="crit-name" aria-hidden>{STACK_META[cur.stack].short}</span>
    </span>
  );
}
