// Âm lịch Việt Nam (múi giờ +7) — thuật toán thiên văn của Hồ Ngọc Đức
// (https://www.informatik.uni-leipzig.de/~duc/amlich/): tính điểm sóc (trăng
// mới) và kinh độ mặt trời để suy ra mùng 1, tháng nhuận, tiết khí. Không gọi
// mạng, không bảng tra theo năm — đúng cho mọi năm trong khoảng 1800–2199.
//
// Thuần client/server đều dùng được. Đầu vào là 'YYYY-MM-DD' theo lịch dương.

const TZ = 7;
const PI = Math.PI;
const INT = Math.floor;

export const CAN = ['Giáp', 'Ất', 'Bính', 'Đinh', 'Mậu', 'Kỷ', 'Canh', 'Tân', 'Nhâm', 'Quý'];
export const CHI = ['Tý', 'Sửu', 'Dần', 'Mão', 'Thìn', 'Tỵ', 'Ngọ', 'Mùi', 'Thân', 'Dậu', 'Tuất', 'Hợi'];
const CON_GIAP = ['Chuột', 'Trâu', 'Hổ', 'Mèo', 'Rồng', 'Rắn', 'Ngựa', 'Dê', 'Khỉ', 'Gà', 'Chó', 'Lợn'];
/** 24 tiết khí, mốc 0 = kinh độ mặt trời 0° (Xuân phân), mỗi tiết 15°. */
const TIET_KHI = [
  'Xuân phân', 'Thanh minh', 'Cốc vũ', 'Lập hạ', 'Tiểu mãn', 'Mang chủng',
  'Hạ chí', 'Tiểu thử', 'Đại thử', 'Lập thu', 'Xử thử', 'Bạch lộ',
  'Thu phân', 'Hàn lộ', 'Sương giáng', 'Lập đông', 'Tiểu tuyết', 'Đại tuyết',
  'Đông chí', 'Tiểu hàn', 'Đại hàn', 'Lập xuân', 'Vũ thủy', 'Kinh trập',
];
/** Giờ hoàng đạo theo chi của ngày (chi % 6) — bit i = giờ CHI[i]. */
const GIO_HD = ['110100101100', '001101001011', '110011010010', '101100110100', '001011001101', '010010110011'];
/** 12 thần trực ngày: true = hoàng đạo. Thanh Long khởi theo tháng âm. */
const THAN: [string, boolean][] = [
  ['Thanh Long', true], ['Minh Đường', true], ['Thiên Hình', false], ['Chu Tước', false],
  ['Kim Quỹ', true], ['Kim Đường', true], ['Bạch Hổ', false], ['Ngọc Đường', true],
  ['Thiên Lao', false], ['Huyền Vũ', false], ['Tư Mệnh', true], ['Câu Trần', false],
];
/** Ngày lễ/tết theo âm lịch: key `ngày/tháng` (không tính tháng nhuận). */
const LE_AM: Record<string, string> = {
  '1/1': 'Tết Nguyên Đán', '2/1': 'Mùng 2 Tết', '3/1': 'Mùng 3 Tết',
  '15/1': 'Rằm tháng Giêng (Tết Nguyên Tiêu)', '3/3': 'Tết Hàn thực',
  '10/3': 'Giỗ Tổ Hùng Vương', '15/4': 'Lễ Phật đản', '5/5': 'Tết Đoan ngọ',
  '15/7': 'Lễ Vu Lan', '15/8': 'Tết Trung thu', '9/9': 'Tết Trùng cửu',
  '10/10': 'Tết Thường tân', '15/10': 'Tết Hạ nguyên', '23/12': 'Ông Công Ông Táo',
};
const TAM_NUONG = new Set([3, 7, 13, 18, 22, 27]);
const NGUYET_KY = new Set([5, 14, 23]);

// ── Thiên văn ───────────────────────────────────────────────────────────────

function jdFromDate(dd: number, mm: number, yy: number): number {
  const a = INT((14 - mm) / 12);
  const y = yy + 4800 - a;
  const m = mm + 12 * a - 3;
  let jd = dd + INT((153 * m + 2) / 5) + 365 * y + INT(y / 4) - INT(y / 100) + INT(y / 400) - 32045;
  if (jd < 2299161) jd = dd + INT((153 * m + 2) / 5) + 365 * y + INT(y / 4) - 32083;
  return jd;
}

function newMoon(k: number): number {
  const T = k / 1236.85, T2 = T * T, T3 = T2 * T, dr = PI / 180;
  let jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
  jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
  const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
  const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
  const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
  let C1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M);
  C1 = C1 - 0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(dr * 2 * Mpr);
  C1 = C1 - 0.0004 * Math.sin(dr * 3 * Mpr);
  C1 = C1 + 0.0104 * Math.sin(dr * 2 * F) - 0.0051 * Math.sin(dr * (M + Mpr));
  C1 = C1 - 0.0074 * Math.sin(dr * (M - Mpr)) + 0.0004 * Math.sin(dr * (2 * F + M));
  C1 = C1 - 0.0004 * Math.sin(dr * (2 * F - M)) - 0.0006 * Math.sin(dr * (2 * F + Mpr));
  C1 = C1 + 0.0010 * Math.sin(dr * (2 * F - Mpr)) + 0.0005 * Math.sin(dr * (2 * Mpr + M));
  const deltat = T < -11
    ? 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3
    : -0.000278 + 0.000265 * T + 0.000262 * T2;
  return jd1 + C1 - deltat;
}

/** Kinh độ mặt trời (radian, 0..2π) tại thời điểm Julian jdn. */
function sunLongitude(jdn: number): number {
  const T = (jdn - 2451545.0) / 36525, T2 = T * T, dr = PI / 180;
  const M = 357.52910 + 35999.05030 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
  const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
  let DL = (1.914600 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
  DL += (0.019993 - 0.000101 * T) * Math.sin(dr * 2 * M) + 0.000290 * Math.sin(dr * 3 * M);
  let L = (L0 + DL) * dr;
  L -= PI * 2 * INT(L / (PI * 2));
  return L;
}

const newMoonDay = (k: number) => INT(newMoon(k) + 0.5 + TZ / 24);
/** Cung hoàng đạo 30° (0..11) lúc 00:00 giờ VN của ngày jd. */
const sunSector12 = (jd: number) => INT(sunLongitude(jd - 0.5 - TZ / 24) / PI * 6);
/** Tiết khí 15° (0..23) lúc 00:00 giờ VN của ngày jd. */
const sunSector24 = (jd: number) => INT(sunLongitude(jd - 0.5 - TZ / 24) / PI * 12);

function lunarMonth11(yy: number): number {
  const off = jdFromDate(31, 12, yy) - 2415021;
  const k = INT(off / 29.530588853);
  const nm = newMoonDay(k);
  return sunSector12(nm) >= 9 ? newMoonDay(k - 1) : nm;
}

function leapMonthOffset(a11: number): number {
  const k = INT((a11 - 2415021.076998695) / 29.530588853 + 0.5);
  let last = 0, i = 1;
  let arc = sunSector12(newMoonDay(k + i));
  do {
    last = arc; i++;
    arc = sunSector12(newMoonDay(k + i));
  } while (arc !== last && i < 14);
  return i - 1;
}

// ── API ─────────────────────────────────────────────────────────────────────

export interface LunarDate {
  day: number;
  month: number;
  year: number;
  leap: boolean;
  /** Số ngày Julian của ngày dương — dùng tính can chi. */
  jd: number;
}

export function solarToLunar(dd: number, mm: number, yy: number): LunarDate {
  const jd = jdFromDate(dd, mm, yy);
  const k = INT((jd - 2415021.076998695) / 29.530588853);
  let monthStart = newMoonDay(k + 1);
  if (monthStart > jd) monthStart = newMoonDay(k);
  let a11 = lunarMonth11(yy);
  let b11 = a11;
  let year: number;
  if (a11 >= monthStart) {
    year = yy;
    a11 = lunarMonth11(yy - 1);
  } else {
    year = yy + 1;
    b11 = lunarMonth11(yy + 1);
  }
  const day = jd - monthStart + 1;
  const diff = INT((monthStart - a11) / 29);
  let leap = false;
  let month = diff + 11;
  if (b11 - a11 > 365) {
    const leapDiff = leapMonthOffset(a11);
    if (diff >= leapDiff) {
      month = diff + 10;
      if (diff === leapDiff) leap = true;
    }
  }
  if (month > 12) month -= 12;
  if (month >= 11 && diff < 4) year -= 1;
  return { day, month, year, leap, jd };
}

const cache = new Map<string, LunarDate>();
/** 'YYYY-MM-DD' → âm lịch (có cache — lịch tháng gọi lại mỗi lần render). */
export function lunarOf(date: string): LunarDate {
  let v = cache.get(date);
  if (!v) {
    const [y, m, d] = date.split('-').map(Number);
    v = solarToLunar(d, m, y);
    if (cache.size > 2000) cache.clear();
    cache.set(date, v);
  }
  return v;
}

export const canChiYear = (y: number) => `${CAN[(y + 6) % 10]} ${CHI[(y + 8) % 12]}`;
export const canChiMonth = (l: LunarDate) => `${CAN[(l.year * 12 + l.month + 3) % 10]} ${CHI[(l.month + 1) % 12]}`;
export const canChiDay = (jd: number) => `${CAN[(jd + 9) % 10]} ${CHI[(jd + 1) % 12]}`;

/** Nhãn ngắn trong ô lịch: mùng 1 ghi 'ngày/tháng' (vd '1/9', thêm 'N' nếu nhuận), còn lại chỉ số ngày. */
export function lunarShort(l: LunarDate): string {
  return l.day === 1 ? `${l.day}/${l.month}${l.leap ? 'N' : ''}` : String(l.day);
}

/** Lễ âm lịch của ngày (null nếu không có). Tính cả Giao thừa (ngày cuối tháng Chạp). */
export function lunarHoliday(date: string): string | null {
  const l = lunarOf(date);
  if (l.leap) return null;
  const hit = LE_AM[`${l.day}/${l.month}`];
  if (hit) return hit;
  if (l.month === 12 && l.day >= 29) {
    const [y, m, d] = date.split('-').map(Number);
    const next = new Date(y, m - 1, d + 1);
    if (solarToLunar(next.getDate(), next.getMonth() + 1, next.getFullYear()).day === 1) return 'Giao thừa (Tất niên)';
  }
  return null;
}

export interface LunarInfo {
  lunar: LunarDate;
  /** '9 tháng 9 năm Bính Ngọ' */
  label: string;
  yearCanChi: string;
  conGiap: string;
  monthCanChi: string;
  dayCanChi: string;
  /** Hoàng đạo / hắc đạo theo 12 thần trực. */
  than: { name: string; good: boolean };
  /** Giờ hoàng đạo: 'Tý (23-1)'. */
  gioHoangDao: string[];
  /** Tiết khí đang chứa ngày này; starts = ngày bắt đầu tiết. */
  tietKhi: { name: string; starts: boolean };
  /** Chi xung với ngày (tuổi kỵ). */
  xung: string;
  holiday: string | null;
  /** Cảnh báo dân gian: Tam nương, Nguyệt kỵ. */
  warnings: string[];
  moon: string;
}

function moonIcon(day: number): string {
  if (day <= 2 || day >= 29) return '🌑';
  if (day <= 6) return '🌒';
  if (day <= 9) return '🌓';
  if (day <= 13) return '🌔';
  if (day <= 16) return '🌕';
  if (day <= 20) return '🌖';
  if (day <= 23) return '🌗';
  return '🌘';
}

export function lunarInfo(date: string): LunarInfo {
  const l = lunarOf(date);
  const dayChi = (l.jd + 1) % 12;
  const thanStart = ((l.month - 1) % 6) * 2;
  const [thanName, good] = THAN[(dayChi - thanStart + 12) % 12];
  const hd = GIO_HD[dayChi % 6];
  const gio: string[] = [];
  for (let i = 0; i < 12; i++) {
    if (hd[i] === '1') gio.push(`${CHI[i]} (${(i * 2 + 23) % 24}-${(i * 2 + 1) % 24}h)`);
  }
  // Lấy mốc CUỐI ngày (00:00 hôm sau): ngày nào chứa thời điểm giao tiết thì
  // ngày đó là ngày bắt đầu tiết — đúng cách lịch treo tường ghi.
  const tk = sunSector24(l.jd + 1);
  const warnings: string[] = [];
  if (TAM_NUONG.has(l.day)) warnings.push('Ngày Tam nương');
  if (NGUYET_KY.has(l.day)) warnings.push('Ngày Nguyệt kỵ');
  return {
    lunar: l,
    label: `${l.day} tháng ${l.month}${l.leap ? ' nhuận' : ''} năm ${canChiYear(l.year)}`,
    yearCanChi: canChiYear(l.year),
    conGiap: CON_GIAP[(l.year + 8) % 12],
    monthCanChi: canChiMonth(l) + (l.leap ? ' (nhuận)' : ''),
    dayCanChi: canChiDay(l.jd),
    than: { name: thanName, good },
    gioHoangDao: gio,
    tietKhi: { name: TIET_KHI[tk], starts: sunSector24(l.jd) !== tk },
    xung: CHI[(dayChi + 6) % 12],
    holiday: lunarHoliday(date),
    warnings,
    moon: moonIcon(l.day),
  };
}
