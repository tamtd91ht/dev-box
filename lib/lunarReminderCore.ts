// Ghi chú / lời nhắc theo ÂM LỊCH — phần THUẦN (client + server dùng chung):
// kiểu dữ liệu, luật "ngày dương D có rơi vào lời nhắc không", và thời điểm bắn
// thông báo. Kho lưu ở lib/lunarReminders (server-only).
//
// Lặp lại:
//   · 'none'    — đúng MỘT ngày âm (ngày + tháng + năm + cờ nhuận).
//   · 'monthly' — ngày X âm của MỌI tháng, kể cả tháng nhuận.
//   · 'yearly'  — ngày X tháng Y âm mỗi năm, chỉ tháng THƯỜNG (tháng nhuận là
//                 tháng "thêm", giỗ/sinh nhật âm vẫn làm ở tháng chính).
// Ngày 30 mà tháng đó chỉ có 29 ngày → rơi vào ngày 29 (ngày cuối tháng), để
// lời nhắc không bị "mất" ở các tháng thiếu.

import { lunarOf, solarToLunar } from './lunar';

export type LunarRepeat = 'none' | 'monthly' | 'yearly';
export const LUNAR_REPEATS: LunarRepeat[] = ['none', 'monthly', 'yearly'];

export interface LunarReminderAlert {
  /** Nhắc trước bao nhiêu ngày (0 = đúng ngày). */
  daysBefore: number;
  /** Giờ nhắc 'HH:mm'. */
  time: string;
}

export interface LunarReminder {
  id: string;
  title: string;
  note: string;
  /** Ngày âm gốc (lúc tạo) — 'none' dùng đủ cả bốn, lặp lại dùng phần cần. */
  lDay: number;
  lMonth: number;
  lYear: number;
  leap: boolean;
  /** Ngày dương lúc tạo 'YYYY-MM-DD' (chỉ để tham chiếu/hiển thị). */
  anchorDate: string;
  repeat: LunarRepeat;
  alert: LunarReminderAlert | null;
  /** Ngày dương của lần xuất hiện ĐÃ nhắc gần nhất — chống nhắc trùng. */
  lastNotifiedFor: string | null;
  createdAt: number;
  updatedAt: number;
}

const p2 = (n: number) => String(n).padStart(2, '0');
const dstr = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const dparse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = dparse(s); d.setDate(d.getDate() + n); return dstr(d); };

/** Ngày dương s có phải ngày cuối của tháng âm không. */
function lastOfLunarMonth(s: string): boolean {
  const n = dparse(addDays(s, 1));
  return solarToLunar(n.getDate(), n.getMonth() + 1, n.getFullYear()).day === 1;
}

/** Ngày âm của s có khớp "ngày X" của lời nhắc không (xử lý tháng thiếu). */
function dayHits(want: number, s: string, have: number): boolean {
  if (have === want) return true;
  return want === 30 && have === 29 && lastOfLunarMonth(s);
}

/** Lời nhắc r có xuất hiện vào ngày dương s ('YYYY-MM-DD') không. */
export function occursOn(r: Pick<LunarReminder, 'lDay' | 'lMonth' | 'lYear' | 'leap' | 'repeat'>, s: string): boolean {
  const l = lunarOf(s);
  switch (r.repeat) {
    case 'none':
      return l.day === r.lDay && l.month === r.lMonth && l.year === r.lYear && l.leap === r.leap;
    case 'monthly':
      return dayHits(r.lDay, s, l.day);
    case 'yearly':
      return !l.leap && l.month === r.lMonth && dayHits(r.lDay, s, l.day);
  }
}

/** Epoch ms phải bắn nhắc cho lần xuất hiện vào ngày dương s. */
export function fireAtMs(alert: LunarReminderAlert, s: string): number {
  const [h, m] = alert.time.split(':').map(Number);
  const d = dparse(s);
  d.setDate(d.getDate() - alert.daysBefore);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

export function repeatText(r: Pick<LunarReminder, 'lDay' | 'lMonth' | 'lYear' | 'leap' | 'repeat'>): string {
  switch (r.repeat) {
    case 'none': return `Một lần — ${r.lDay}/${r.lMonth}${r.leap ? ' nhuận' : ''} năm ${r.lYear} (AL)`;
    case 'monthly': return `Hằng tháng — ngày ${r.lDay} âm lịch`;
    case 'yearly': return `Hằng năm — ${r.lDay}/${r.lMonth} âm lịch`;
  }
}

export function alertText(a: LunarReminderAlert | null): string {
  if (!a) return 'Không nhắc';
  return a.daysBefore === 0 ? `Nhắc lúc ${a.time} đúng ngày` : `Nhắc trước ${a.daysBefore} ngày, lúc ${a.time}`;
}
