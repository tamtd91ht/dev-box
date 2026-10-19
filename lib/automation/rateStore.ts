'use client';

// DevBox Automation — phía renderer của lịch sử rate watch.
//
// Chỉ là hai lời gọi fetch, nhưng tách ra vì cả hai đều phải KHÔNG BAO GIỜ NÉM:
// watcher gọi chúng trong vòng poll, và một lần lưu hỏng không được phép làm
// gãy phép đo. Mất một lần flush thì buffer trong RAM vẫn đúng, lần sau ghi lại.
//
// Xem lib/automation/rateHistoryStore.ts để biết vì sao phải persist.

import type { RateSample } from './rate';

export type RateHistoryMap = Record<string, RateSample[]>;

/** Nạp lịch sử đã lưu. Hỏng/không có → map rỗng (watch gom lại từ đầu, UI nói rõ). */
export async function loadHistory(): Promise<RateHistoryMap> {
  try {
    const r = await fetch('/api/automation/rate-history');
    if (!r.ok) return {};
    const j = (await r.json()) as { history?: RateHistoryMap };
    return j.history ?? {};
  } catch {
    return {};
  }
}

/** Ghi lại toàn bộ. Never throws — xem docstring đầu file. */
export async function saveHistory(history: RateHistoryMap): Promise<void> {
  try {
    await fetch('/api/automation/rate-history', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history }),
    });
  } catch {
    /* xem docstring đầu file */
  }
}
