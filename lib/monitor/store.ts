'use client';

// Kênh chia sẻ số liệu Monitor cho các màn khác (Toàn cảnh) mà KHÔNG chạy vòng đo thứ hai.
//
// MonitorWorkspace luôn mount và là nơi DUY NHẤT gọi useMonitor (probe hạ tầng có giới hạn
// song song — đo hai lần là đói socket). Nó đẩy ảnh chụp mới nhất vào đây; màn khác đọc
// bằng useMonitorSnapshot() (useSyncExternalStore).

import { useSyncExternalStore } from 'react';
import type { Row } from './useMonitor';
import type { Counts, Overrides } from './status';
import type { InfraStack } from '@/lib/automation/types';

export interface MonitorSnapshot {
  rows: Row[];
  counts: Counts;
  loaded: boolean;
  roundBusy: boolean;
  lastRoundAt: number | null;
  overrides: Overrides;
  /** Thứ tự loại người dùng chọn ở Monitor (⋯ › Thứ tự các loại). */
  order: InfraStack[];
  refreshAll: () => void;
  refreshOne: (key: string) => void;
}

let snap: MonitorSnapshot | null = null;
const subs = new Set<() => void>();

export function publishMonitor(s: MonitorSnapshot): void {
  snap = s;
  for (const f of subs) f();
}

function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

export function useMonitorSnapshot(): MonitorSnapshot | null {
  return useSyncExternalStore(subscribe, () => snap, () => null);
}
