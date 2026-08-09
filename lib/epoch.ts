// Đổi thời gian hai chiều cho tab Tools: epoch (số) ⇄ ngày giờ đọc được, ở
// MÚI GIỜ TÙY CHỌN (UTC, giờ máy, hoặc bất kỳ IANA zone nào).
//
// Không dùng thư viện ngoài — mọi phép đổi múi giờ đi qua Intl.DateTimeFormat
// với `timeZone`, nên tự động đúng cả DST (giờ mùa hè) theo dữ liệu ICU của
// trình duyệt/Node. Toàn bộ hàm ở đây là hàm thuần (trừ nowMs) để test được.
//
// Quy ước: mốc thời gian trong app luôn là MILLIS (number). Đơn vị s/µs/ns chỉ
// là cách hiển thị và cách đọc chuỗi người dùng gõ vào.

/** Đơn vị của số epoch người dùng nhập / muốn xuất ra. */
export type EpochUnit = 's' | 'ms' | 'us' | 'ns';

export const UNIT_LABEL: Record<EpochUnit, string> = {
  s: 'giây',
  ms: 'mili giây',
  us: 'micro giây',
  ns: 'nano giây',
};

/** Hệ số quy về millis (dùng số thực để µs/ns không mất phần lẻ khi chia). */
const UNIT_TO_MS: Record<EpochUnit, number> = {
  s: 1000,
  ms: 1,
  us: 1 / 1000,
  ns: 1 / 1e6,
};

/** Giá trị hợp lệ cho Date — ngoài khoảng này new Date() trả Invalid Date. */
const MAX_MS = 8.64e15;

export const nowMs = (): number => Date.now();

/**
 * Đoán đơn vị theo SỐ CHỮ SỐ — đúng như thói quen ở trang epoch converter:
 * 10 chữ số là giây, 13 là millis, 16 là micro, 19 là nano. Các mốc chọn rộng
 * ra hai bên để mốc thời gian cũ (1970) hay xa (2100) vẫn rơi đúng nhóm.
 */
export function detectUnit(digits: string): EpochUnit {
  const n = digits.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').length;
  if (n <= 11) return 's';
  if (n <= 14) return 'ms';
  if (n <= 17) return 'us';
  return 'ns';
}

/** Số epoch (theo đơn vị) → millis. NaN nếu chuỗi không phải số. */
export function toMillis(value: string, unit: EpochUnit): number {
  const s = value.trim().replace(/[_\s,]/g, '');
  if (!s || !/^[+-]?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s) * UNIT_TO_MS[unit];
}

/** Millis → chuỗi epoch theo đơn vị. Cắt xuống (floor) như `date +%s` chứ
 *  không làm tròn: 10.9s vẫn là giây thứ 10. */
export function fromMillis(ms: number, unit: EpochUnit): string {
  if (!Number.isFinite(ms)) return '';
  // Nano vượt Number.MAX_SAFE_INTEGER (1.7e18 > 9e15) nên số đuôi sẽ sai nếu
  // nhân bằng số thực → nhân bằng BigInt từ mốc micro cho ra đủ 19 chữ số.
  if (unit === 'ns') return `${BigInt(Math.floor(ms * 1000)) * 1000n}`;
  return String(Math.floor(ms / UNIT_TO_MS[unit]));
}

/** Mốc thời gian nằm trong khoảng Date xử lý được. */
export const isValidMs = (ms: number): boolean => Number.isFinite(ms) && Math.abs(ms) <= MAX_MS;

// ── Múi giờ ────────────────────────────────────────────────────────────────

/** Múi giờ của máy đang chạy (vd 'Asia/Ho_Chi_Minh'). */
export function localZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Danh sách IANA zone cho ô chọn — máy nào không có Intl.supportedValuesOf
 *  thì rơi về danh sách rút gọn (vẫn đủ dùng, và luôn kèm zone của máy). */
export function zoneList(): string[] {
  const withLocal = (list: string[]) => {
    const l = localZone();
    return list.includes(l) ? list : [l, ...list].sort();
  };
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof sv === 'function') return withLocal(sv('timeZone'));
  } catch { /* rơi xuống danh sách rút gọn */ }
  return withLocal([
    'UTC', 'Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo',
    'Asia/Seoul', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai', 'Europe/London',
    'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'America/New_York',
    'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
    'Australia/Sydney', 'Pacific/Auckland',
  ]);
}

export interface ZonedParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number; ms: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(zone: string): Intl.DateTimeFormat {
  let f = partsCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      era: 'short',
    });
    partsCache.set(zone, f);
  }
  return f;
}

/** Mốc millis → các thành phần ngày/giờ NHÌN THẤY ở múi giờ đó. */
export function partsInZone(ms: number, zone: string): ZonedParts {
  const p = partsFormatter(zone).formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? '0');
  const bc = p.find((x) => x.type === 'era')?.value === 'BC';
  const year = get('year');
  return {
    // Intl trả năm dương lịch (1 BC = năm 1 "BC") — quy về năm thiên văn để
    // Date.UTC dựng lại đúng mốc, nếu không mốc trước Công nguyên lệch hẳn.
    year: bc ? 1 - year : year,
    month: get('month'), day: get('day'),
    hour: get('hour'), minute: get('minute'), second: get('second'),
    ms: ((ms % 1000) + 1000) % 1000,
  };
}

/** Chênh lệch của múi giờ so với UTC tại mốc đó, tính bằng phút (VN = +420). */
export function zoneOffsetMinutes(ms: number, zone: string): number {
  const p = partsInZone(ms, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // So ở mức giây: phần millis giống nhau ở cả hai vế nên triệt tiêu.
  const floorSec = Math.floor(ms / 1000) * 1000;
  return Math.round((asUtc - floorSec) / 60000);
}

/** Chênh lệch dạng chữ: '+07:00', 'UTC' → '+00:00'. */
export function offsetLabel(ms: number, zone: string): string {
  const off = zoneOffsetMinutes(ms, zone);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Tên viết tắt của múi giờ tại mốc đó (ICT, GMT+7, PDT…) — để người dùng biết
 *  đang xem giờ mùa hè hay giờ chuẩn. */
export function zoneAbbr(ms: number, zone: string): string {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(ms));
    return p.find((x) => x.type === 'timeZoneName')?.value ?? '';
  } catch { return ''; }
}

/**
 * Chiều ngược: ngày giờ ĐỌC Ở múi giờ `zone` → mốc millis.
 *
 * Dựng mốc như thể các con số là giờ UTC rồi trừ offset — nhưng offset lại phụ
 * thuộc chính mốc cần tìm, nên quanh ngày đổi giờ (DST) một phép lặp đơn giản
 * lệch hẳn một tiếng. Cách chắc ăn: thử CẢ HAI offset có thể có (lấy ở mốc
 * trước/sau một ngày), rồi giữ ứng viên nào tự kiểm lại đúng:
 *   · cả hai đúng → giờ LẶP LẠI lúc lùi giờ, lấy lần xuất hiện ĐẦU (sớm hơn)
 *   · không cái nào đúng → giờ KHÔNG TỒN TẠI lúc tiến giờ (vd 02:30 ở New York
 *     ngày nhảy), đẩy về mốc NGAY SAU cú nhảy
 * Đây đúng là cách Temporal xử lý mặc định, nên số ra khớp với các công cụ khác.
 */
export function zonedPartsToMillis(p: ZonedParts, zone: string): number {
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms);
  if (!Number.isFinite(asUtc)) return NaN;
  const DAY = 86400000;
  const offBefore = zoneOffsetMinutes(asUtc - DAY, zone);
  const offAfter = zoneOffsetMinutes(asUtc + DAY, zone);
  const tsBefore = asUtc - offBefore * 60000;
  const tsAfter = asUtc - offAfter * 60000;
  const okBefore = zoneOffsetMinutes(tsBefore, zone) === offBefore;
  const okAfter = zoneOffsetMinutes(tsAfter, zone) === offAfter;
  if (okBefore && okAfter) return Math.min(tsBefore, tsAfter);
  if (okBefore) return tsBefore;
  if (okAfter) return tsAfter;
  return Math.max(tsBefore, tsAfter);
}

// ── Đọc chuỗi ngày giờ người dùng gõ ───────────────────────────────────────

export interface ParsedInput {
  parts: ZonedParts;
  /** Chuỗi đã tự mang offset (…Z hoặc +07:00) → bỏ qua ô chọn múi giờ. */
  absoluteMs?: number;
}

/**
 * Nhận các dạng gõ tay quen thuộc:
 *   2026-08-09, 2026-08-09 14:30, 2026-08-09T14:30:05.123
 *   09/08/2026 14:30:05  (ngày/tháng/năm — kiểu VN)
 *   2026-08-09T14:30:05Z, …+07:00  → mốc tuyệt đối, không theo ô múi giờ
 * Trả null nếu không đọc được.
 */
export function parseDateInput(raw: string): ParsedInput | null {
  const s = raw.trim();
  if (!s) return null;

  // Có sẵn offset/Z → mốc tuyệt đối, để Date tự lo.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s.replace(/^[+-]/, ''))) {
    const t = Date.parse(s.replace(' ', 'T'));
    if (Number.isFinite(t)) return { parts: partsInZone(t, 'UTC'), absoluteMs: t };
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?$/.exec(s);
  const vn = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[T ,]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?$/.exec(s);
  const m = iso ?? vn;
  if (!m) return null;

  const [year, month, day] = iso
    ? [Number(m[1]), Number(m[2]), Number(m[3])]
    : [Number(m[3]), Number(m[2]), Number(m[1])];
  const parts: ZonedParts = {
    year, month, day,
    hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0), second: Number(m[6] ?? 0),
    ms: Number((m[7] ?? '0').padEnd(3, '0')),
  };
  // Chặn 2026-13-45: Date.UTC tự "tràn" sang tháng sau, người gõ lại tưởng đúng.
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return null;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { parts };
}

// ── Hiển thị ───────────────────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0');
const p3 = (n: number) => String(n).padStart(3, '0');

/** '2026-08-09 14:30:05.123' theo múi giờ đã chọn. */
export function fmtPlain(ms: number, zone: string, withMs = true): string {
  const p = partsInZone(ms, zone);
  const base = `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}:${p2(p.second)}`;
  return withMs ? `${base}.${p3(p.ms)}` : base;
}

/** ISO 8601 kèm offset của múi giờ: '2026-08-09T14:30:05.123+07:00'. */
export function fmtIso(ms: number, zone: string): string {
  const p = partsInZone(ms, zone);
  const off = zone === 'UTC' ? 'Z' : offsetLabel(ms, zone);
  return `${String(p.year).padStart(4, '0')}-${p2(p.month)}-${p2(p.day)}T${p2(p.hour)}:${p2(p.minute)}:${p2(p.second)}.${p3(p.ms)}${off}`;
}

/** Dạng đọc cho người: 'Chủ Nhật, 09/08/2026 14:30:05'. */
export function fmtHuman(ms: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: zone, hourCycle: 'h23', weekday: 'long',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(ms));
  } catch { return fmtPlain(ms, zone, false); }
}

/** Khoảng cách so với hiện tại: '3 giờ trước' / 'sau 2 ngày nữa'. */
export function fmtRelative(ms: number, ref = Date.now()): string {
  const diff = ms - ref;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [1000, 'giây'], [60000, 'phút'], [3600000, 'giờ'],
    [86400000, 'ngày'], [2629800000, 'tháng'], [31557600000, 'năm'],
  ];
  if (abs < 1000) return 'ngay lúc này';
  let pick = units[0];
  for (const u of units) if (abs >= u[0]) pick = u;
  const n = Math.floor(abs / pick[0]);
  return diff < 0 ? `${n} ${pick[1]} trước` : `sau ${n} ${pick[1]} nữa`;
}

/** Thứ tự ngày trong năm + số tuần ISO — hay cần khi soi log. */
export function dayOfYear(ms: number, zone: string): number {
  const p = partsInZone(ms, zone);
  const start = Date.UTC(p.year, 0, 1);
  const cur = Date.UTC(p.year, p.month - 1, p.day);
  return Math.round((cur - start) / 86400000) + 1;
}

export function isoWeek(ms: number, zone: string): number {
  const p = partsInZone(ms, zone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  // Chuẩn ISO-8601: tuần chứa thứ Năm quyết định tuần số mấy.
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDow = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDow + 3);
  return Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000)) + 1;
}

/** Năm nhuận — hiện kèm cho vui, cũng là mẹo kiểm tra nhanh khi debug lịch. */
export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
