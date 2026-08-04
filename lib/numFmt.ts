// Bộ render number format (numFmt) của Excel — dùng chung server + client.
//
// Mục tiêu: ô số/ngày trong Sheet workspace hiển thị ĐÚNG như Excel đang hiển
// thị (#,##0 · 0.00% · "₫"#,##0 · dd/mm/yyyy · [Red] số âm …) thay vì số thô.
// Đây là subset thực dụng của spec numFmt (đủ cho file kế toán/báo cáo thường
// gặp); pattern không hiểu được → fallback General, không bao giờ throw.
//
// Hỗ trợ:
//   · 1-4 section "pos;neg;zero;text", chọn theo dấu của giá trị
//   · digit placeholders 0/#/?, dấu thập phân, dấu phẩy ngăn nghìn (#,##0)
//   · comma-scaling cuối pattern (#,##0,, → chia 1e6), phần trăm (×100 + %)
//   · literal trong "..."  · \x escape · _x (khoảng trắng) · *x (bỏ qua fill)
//   · [Red]/[Blue]/… → màu chữ; [$-…]/[$₫-42A] locale tag; điều kiện [>=100] bỏ qua
//   · ngày giờ: yyyy yy mmmm mmm mm m dd d hh h ss s AM/PM (mm phút theo ngữ cảnh)
//   · '@' → text giữ nguyên · 'General' → toString gọn

export interface FormattedValue {
  text: string;
  /** Màu từ tag [Red]… của section được chọn (CSS color). */
  color?: string;
}

const TAG_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#e5484d', green: '#2f9e44',
  blue: '#3b82f6', yellow: '#d9a406', magenta: '#d6409f', cyan: '#0db9d7',
};

/** Serial Excel (hệ 1900) → Date UTC. 25569 = số ngày 1899-12-30 → 1970-01-01. */
export function serialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

/** Pattern có phải định dạng NGÀY GIỜ không (có y/m/d/h/s ngoài "quote"). */
export function isDateFmt(fmt: string): boolean {
  const stripped = fmt
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[ymdhs]/i.test(stripped) && !/#|0/.test(stripped.replace(/(AM\/PM|A\/P)/gi, ''));
}

/** Tách sections theo ';' (bỏ qua ';' trong "quote"). */
function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') { inQ = !inQ; cur += ch; continue; }
    if (ch === '\\') { cur += ch + (fmt[i + 1] ?? ''); i++; continue; }
    if (ch === ';' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Rút tag [Red]… ra khỏi section; bỏ [$-…], [$₫-42A] (giữ ký hiệu tiền), [>=100]. */
function extractTags(section: string): { body: string; color?: string } {
  let color: string | undefined;
  const body = section.replace(/\[([^\]]*)\]/g, (_m, tag: string) => {
    const t = String(tag);
    const lower = t.toLowerCase();
    if (TAG_COLORS[lower]) { color = TAG_COLORS[lower]; return ''; }
    if (/^color\s*\d+$/i.test(t)) return '';
    // [$₫-42A] / [$USD-409]: giữ phần ký hiệu trước dấu '-'.
    if (t.startsWith('$')) return t.slice(1).split('-')[0] ?? '';
    return ''; // điều kiện [>=100], [h]… — bỏ qua (subset)
  });
  return { body, color };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Render section NGÀY GIỜ trên Date (UTC getters — khớp ExcelJS). */
function formatDateBody(body: string, d: Date): string {
  const H24 = d.getUTCHours();
  const usesAmPm = /AM\/PM|A\/P/i.test(body);
  const H = usesAmPm ? (H24 % 12 === 0 ? 12 : H24 % 12) : H24;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  let out = '';
  let i = 0;
  // mm = tháng hay phút? Quy tắc Excel: m đứng NGAY SAU h/hh hoặc NGAY TRƯỚC ss là phút.
  const lower = body.toLowerCase();
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') { const j = body.indexOf('"', i + 1); out += body.slice(i + 1, j < 0 ? body.length : j); i = j < 0 ? body.length : j + 1; continue; }
    if (ch === '\\') { out += body[i + 1] ?? ''; i += 2; continue; }
    if (/AM\/PM/i.test(body.slice(i, i + 5))) { out += H24 < 12 ? 'AM' : 'PM'; i += 5; continue; }
    if (/A\/P/i.test(body.slice(i, i + 3))) { out += H24 < 12 ? 'A' : 'P'; i += 3; continue; }
    const run = (c: string) => { let n = 0; while (lower[i + n] === c) n++; return n; };
    const c = lower[i];
    if (c === 'y') { const n = run('y'); out += n >= 4 ? String(d.getUTCFullYear()) : String(d.getUTCFullYear()).slice(-2); i += n; continue; }
    if (c === 'd') {
      const n = run('d');
      if (n >= 4) out += DAYS[d.getUTCDay()];
      else if (n === 3) out += DAYS[d.getUTCDay()].slice(0, 3);
      else out += n === 2 ? pad2(d.getUTCDate()) : String(d.getUTCDate());
      i += n; continue;
    }
    if (c === 'h') { const n = run('h'); out += n >= 2 ? pad2(H) : String(H); i += n; continue; }
    if (c === 's') { const n = run('s'); out += n >= 2 ? pad2(d.getUTCSeconds()) : String(d.getUTCSeconds()); i += n; continue; }
    if (c === 'm') {
      const n = run('m');
      // phút khi kề h phía trước hoặc s phía sau.
      const prev = lower.slice(0, i).replace(/[^a-z]/g, '').slice(-1);
      const rest = lower.slice(i + n).replace(/[^a-z]/g, '');
      const isMinute = prev === 'h' || rest.startsWith('s');
      if (isMinute) out += n >= 2 ? pad2(d.getUTCMinutes()) : String(d.getUTCMinutes());
      else if (n >= 4) out += MONTHS[d.getUTCMonth()];
      else if (n === 3) out += MONTHS[d.getUTCMonth()].slice(0, 3);
      else out += n === 2 ? pad2(d.getUTCMonth() + 1) : String(d.getUTCMonth() + 1);
      i += n; continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Chèn số vào khung digit placeholders (0/#/?) của một section số. */
function formatNumberBody(body: string, value: number): string {
  let v = value;

  // % → nhân 100. Scaling: dấu phẩy đứng CUỐI cụm digits (#,##0,,) → chia nghìn.
  const pct = /%/.test(body);
  if (pct) v *= 100;
  const scaleMatch = body.match(/[#0?](,+)(?=[^#0?,]|$)/);
  if (scaleMatch) v /= Math.pow(1000, scaleMatch[1].length);

  const thousands = /[#0?],[#0?]{3}/.test(body.replace(/"[^"]*"/g, ''));

  // Đếm digit sau dấu '.' trong pattern.
  const stripped = body.replace(/"[^"]*"/g, '').replace(/\\./g, '');
  const dot = stripped.indexOf('.');
  let decMin = 0; let decMax = 0;
  if (dot >= 0) {
    const frac = stripped.slice(dot + 1).match(/^[0#?]*/)?.[0] ?? '';
    decMax = frac.length;
    decMin = (frac.match(/^0*/)?.[0] ?? '').length;
  }
  // Số digit '0' tối thiểu phần nguyên (0000 → pad).
  const intPart = dot >= 0 ? stripped.slice(0, dot) : stripped;
  const intMin = (intPart.match(/0/g) ?? []).length;

  const neg = v < 0;
  const abs = Math.abs(v);
  let numText = abs.toFixed(decMax);
  if (decMax > decMin) numText = numText.replace(/0+$/, '').replace(/\.$/, '');
  let [ip, fp = ''] = numText.split('.');
  if (ip.length < intMin) ip = ip.padStart(intMin, '0');
  if (thousands) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rendered = fp ? `${ip}.${fp}` : ip;

  // Thay CỤM digit-placeholder đầu tiên bằng số đã render, giữ literal quanh nó.
  let out = '';
  let used = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') { const j = body.indexOf('"', i + 1); out += body.slice(i + 1, j < 0 ? body.length : j); i = j < 0 ? body.length : j + 1; continue; }
    if (ch === '\\') { out += body[i + 1] ?? ''; i += 2; continue; }
    if (ch === '_') { out += ' '; i += 2; continue; }
    if (ch === '*') { i += 2; continue; }
    if (ch === '%') { out += '%'; i++; continue; }
    if (/[#0?.,]/.test(ch)) {
      if (!used) { out += rendered; used = true; }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  if (!used) out += rendered;
  // Section âm tự vẽ dấu (vd (1.234) hay -#,##0) — chỉ thêm '-' khi pattern
  // không có ký hiệu âm nào (Excel: section neg đã ngầm là số âm).
  return neg && !/[()-]/.test(body) ? `-${out}` : out;
}

/** 'General' — toString gọn, cắt noise float. */
function generalText(v: number): string {
  const rounded = Math.round(v * 1e10) / 1e10;
  return String(rounded);
}

/**
 * Format một giá trị theo numFmt Excel. `value` là number (kể cả serial ngày),
 * Date, hay string (đi vào section text '@'). Trả text + màu (nếu section có).
 */
export function formatNumFmt(value: number | Date | string, fmt: string | undefined): FormattedValue {
  if (!fmt || /^general$/i.test(fmt.trim())) {
    if (value instanceof Date) return { text: value.toISOString() };
    return { text: typeof value === 'number' ? generalText(value) : String(value) };
  }
  try {
    const sections = splitSections(fmt);

    if (typeof value === 'string') {
      const textSection = sections[3] ?? '@';
      const { body, color } = extractTags(textSection);
      if (!/@/.test(body)) return { text: value, color };
      return { text: body.replace(/"([^"]*)"/g, '$1').replace(/@/g, value), color };
    }

    const num = value instanceof Date ? NaN : value;
    const pick = value instanceof Date
      ? sections[0]
      : num > 0 || sections.length === 1 ? sections[0]
      : num < 0 ? (sections[1] ?? sections[0])
      : (sections[2] ?? sections[0]);
    const { body, color } = extractTags(pick);

    if (value instanceof Date) return { text: formatDateBody(body, value), color };
    if (isDateFmt(body)) return { text: formatDateBody(body, serialToDate(num)), color };
    return { text: formatNumberBody(body, num), color };
  } catch {
    return { text: value instanceof Date ? value.toISOString() : String(value) };
  }
}
