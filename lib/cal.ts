// Client-side helpers cho mục Lịch (tab Mail). Mọi call đi qua /api/cal —
// server giữ credentials CalDAV (dùng lại của hòm thư), browser không thấy.
// Browser-safe module.

export interface CalCollection {
  url: string;
  name: string;
  color?: string;
  writable: boolean;
}

export interface CalEvent {
  url: string;
  calendarUrl: string;
  uid: string;
  summary: string;
  location: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  organizer?: string;
  attendees: string[];
  rrule?: string;
  etag?: string;
}

export interface EventInput {
  summary: string;
  location?: string;
  description?: string;
  start: string;
  end: string;
  allDay?: boolean;
  attendees?: string[];
}

async function calAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/cal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

export const cCalendars = (accountId: string) =>
  calAction<{ calendars: CalCollection[]; root: string; custom: boolean }>('calendars', { accountId });
export const cEvents = (accountId: string, calendarUrl: string, from: string, to: string) =>
  calAction<CalEvent[]>('events', { accountId, calendarUrl, from, to });
export const cCreate = (accountId: string, calendarUrl: string, event: EventInput) =>
  calAction<CalEvent>('create', { accountId, calendarUrl, event });
export const cUpdate = (accountId: string, calendarUrl: string, url: string, event: EventInput) =>
  calAction<CalEvent>('update', { accountId, calendarUrl, url, event });
export const cDelete = (accountId: string, url: string) =>
  calAction<{ deleted: boolean }>('delete', { accountId, url });
export const cSetUrl = (accountId: string, url: string) =>
  calAction<{ calDavUrl: string | null }>('setUrl', { accountId, url });

// ── Ngày tháng ─────────────────────────────────────────────────────────────

const two = (n: number) => String(n).padStart(2, '0');

/** Date → "yyyy-MM-dd" theo giờ LOCAL (toISOString sẽ lệch ngày ở VN, +07). */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Date → "yyyy-MM-ddTHH:mm" cho <input type="datetime-local">. */
export function localInput(d: Date): string {
  return `${ymd(d)}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Lưới tháng: 6 tuần bắt đầu từ THỨ HAI của tuần chứa ngày 1. */
export function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  // getDay(): 0=CN → lùi 6 ngày; 1=T2 → lùi 0.
  const back = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - back);
  return Array.from({ length: 42 }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** Khoảng thời gian cần hỏi server cho một lưới tháng (bao trọn 6 tuần). */
export function gridRange(anchor: Date): { from: string; to: string } {
  const grid = monthGrid(anchor);
  const from = grid[0];
  const last = grid[grid.length - 1];
  return {
    from: new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString(),
    to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).toISOString(),
  };
}

const MONTHS = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];

export const monthLabel = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
export const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

export const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Giờ hiển thị "09:30"; sự kiện cả ngày trả chuỗi rỗng. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Sự kiện có phủ lên ngày này không. So sánh theo NGÀY local, và với sự kiện
 * cả ngày thì DTEND là mốc nửa mở (ngày kế tiếp) nên phải trừ ra, không thì
 * mỗi sự kiện cả ngày lại thừa một ngày ở cuối.
 */
export function coversDay(ev: CalEvent, day: Date): boolean {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = dayStart + 86_400_000;
  const s = new Date(ev.start).getTime();
  let e = new Date(ev.end).getTime();
  if (e <= s) e = s + 1;               // sự kiện 0 phút vẫn phải hiện ở ngày đó
  return s < dayEnd && e > dayStart;
}

/** Nhãn khoảng thời gian cho panel chi tiết. */
export function rangeLabel(ev: CalEvent): string {
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  const day = (d: Date) => d.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  if (ev.allDay) {
    // DTEND nửa mở: ngày cuối THẬT là hôm trước.
    const lastDay = new Date(e.getTime() - 86_400_000);
    return isSameDay(s, lastDay) ? `${day(s)} · cả ngày` : `${day(s)} → ${day(lastDay)} · cả ngày`;
  }
  if (isSameDay(s, e)) return `${day(s)} · ${hhmm(ev.start)} – ${hhmm(ev.end)}`;
  return `${day(s)} ${hhmm(ev.start)} → ${day(e)} ${hhmm(ev.end)}`;
}
