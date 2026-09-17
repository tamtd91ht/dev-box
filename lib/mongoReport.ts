// Styled .xlsx report builder for the Mongo quick-find results. Browser-only —
// ExcelJS is loaded via dynamic import so the ~1 MB library never enters the
// main bundle and is only fetched the first time someone actually exports.
//
// Column values are auto-typed: numbers stay numbers, epoch timestamps (seconds
// or millis — detected by magnitude) become REAL Excel date cells (sortable,
// filterable) rendered as either `dd/MM/yyyy` or `HH:mm:ss dd/MM/yyyy`, and
// everything else is text. A column's `format: 'auto'` applies the detection
// per value; explicit formats force the interpretation.

export type ColumnFormat = 'auto' | 'text' | 'number' | 'date' | 'datetime';

export const COLUMN_FORMATS: { value: ColumnFormat; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Số' },
  { value: 'date', label: 'Ngày (dd/MM/yyyy)' },
  { value: 'datetime', label: 'Ngày giờ (HH:mm:ss dd/MM/yyyy)' },
];

export interface ReportColumn {
  /** Header shown in the sheet, e.g. "Tên miền". */
  header: string;
  /** Mongo field path (dotted for nested), e.g. "domain" / "profile.phone".
   *  Đi xuyên được list object: "deviceInfos.deviceId" gom deviceId của mọi
   *  phần tử — xem collectByPath. */
  path: string;
  format: ColumnFormat;
  /** Ký tự nối khi path trỏ vào list object và thu được nhiều giá trị.
   *  Rỗng/undefined = DEFAULT_SEP. */
  sep?: string;
}

/** Phân cách mặc định khi cột không khai riêng. */
export const DEFAULT_SEP = ', ';

/**
 * Trần số dòng cho MỘT lần xuất — chốt chặn cuối để trình duyệt không chết khi
 * dựng workbook. Khai ở đây để cả ba tab (Mongo/ES/PG) dùng chung một con số.
 *
 * Trước là 5.000 vì phân trang skip/from sâu quá là chậm; giờ ES đi bằng
 * search_after và Mongo đi bằng cursor _id nên nâng lên được. Hộp thoại xác
 * nhận báo TRƯỚC khi chạy nếu tập kết quả vượt trần này.
 */
export const MAX_EXPORT_ROWS = 100_000;

/** Pseudo field path: sequential row number (1..n) instead of a document value. */
export const NO_COLUMN_PATH = '__no';

export interface ReportMeta {
  title: string;
  /** e.g. "app_data_prod.tenants". */
  target: string;
  rowCount: number;
  /** Optional extra note appended to the subtitle (e.g. "đã cắt tại 5.000 dòng"). */
  note?: string;
}

// ── Value extraction ──────────────────────────────────────────────────────────

/** Unwrap common relaxed-EJSON wrappers into plain JS values. */
function unwrapEjson(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(unwrapEjson);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    switch (keys[0]) {
      case '$oid': return String(o.$oid);
      case '$date': {
        const d = o.$date;
        if (typeof d === 'string') return new Date(d).getTime();
        if (typeof d === 'number') return d;
        if (d && typeof d === 'object' && '$numberLong' in (d as object)) {
          return Number((d as Record<string, unknown>).$numberLong);
        }
        return d;
      }
      case '$numberLong':
      case '$numberInt':
      case '$numberDouble':
      case '$numberDecimal':
        return Number(o[keys[0]]);
    }
  }
  return v;
}

/**
 * Đi theo dotted path, TRẢI QUA MẢNG trên đường đi.
 *
 * Trước đây gặp mảng ở giữa đường là trả undefined, nên `deviceInfos.deviceId`
 * trên một list object không lấy được gì — người dùng buộc phải xuất cả field
 * cha dạng JSON thô. Giờ gặp mảng thì áp phần path CÒN LẠI lên từng phần tử rồi
 * gom kết quả:
 *
 *   {profile: {phone: '09'}}                      · profile.phone → '09'
 *   {deviceInfos: [{deviceId: 'a'}, {deviceId: 'b'}]} · deviceInfos.deviceId → ['a','b']
 *
 * Quy ước trả về — CỐ Ý không phải lúc nào cũng là mảng:
 *   · không qua mảng nào  → giá trị đơn (giữ nguyên hành vi cũ)
 *   · mảng rỗng / không khớp → undefined (ô Excel trống, không phải chuỗi "[]")
 *   · mảng đúng 1 phần tử  → mở về giá trị đơn
 * Hai ca cuối quan trọng: typeCell chỉ dựng được date-cell / number-cell thật
 * từ giá trị ĐƠN, bọc thành mảng là cột ngày tháng tụt xuống text.
 */
export function collectByPath(doc: unknown, path: string): unknown {
  const parts = path.split('.');

  // `spread` = đã TRẢI QUA ít nhất một mảng trên đường đi. Phân biệt hai ca mà
  // nhìn kết quả thì giống nhau:
  //   · deviceInfos          → giá trị CUỐI vốn là mảng → trả nguyên mảng
  //   · deviceInfos.deviceId → mảng do trải ra → gom, và 1 phần tử thì mở gộp
  // Không phân biệt thì cột trỏ vào chính field mảng có đúng 1 phần tử sẽ bị mở
  // ra thành object đơn — khác hẳn khi nó có 2 phần tử.
  let spread = false;

  const walk = (cur: unknown, i: number): unknown[] => {
    if (cur === null || cur === undefined) return [];
    if (i >= parts.length) return [cur]; // hết path — nhận nguyên giá trị, kể cả mảng
    // Mảng ở GIỮA đường: trải phần path còn lại lên từng phần tử. Mảng lồng mảng
    // cũng xong vì mỗi phần tử lại đi qua đúng nhánh này.
    if (Array.isArray(cur)) { spread = true; return cur.flatMap((el) => walk(el, i)); }
    if (typeof cur !== 'object') return [];
    return walk((cur as Record<string, unknown>)[parts[i]], i + 1);
  };

  const hits = walk(doc, 0).map(unwrapEjson).filter((v) => v !== undefined && v !== null);
  if (hits.length === 0) return undefined;
  // Path dừng đúng tại một mảng (không trải) → trả y nguyên giá trị đó.
  if (!spread) return hits[0];
  return hits.length === 1 ? hits[0] : hits;
}

/** Resolve a dotted path ("profile.phone") against a parsed document. */
export function getByPath(doc: unknown, path: string): unknown {
  return collectByPath(doc, path);
}

// ── Epoch detection ───────────────────────────────────────────────────────────

/** Epoch seconds: 2001-09..2096 · epoch millis: 2001..2096. */
function epochToMs(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  if (n >= 1_000_000_000 && n < 4_000_000_000) return n * 1000; // seconds
  if (n >= 1_000_000_000_000 && n < 4_000_000_000_000) return n; // millis
  return null;
}

/**
 * Excel serials are timezone-less; ExcelJS converts a JS Date using UTC. Shift
 * by the local offset so the sheet shows the operator's local wall-clock time.
 */
function msToExcelDate(ms: number): Date {
  return new Date(ms - new Date().getTimezoneOffset() * 60_000);
}

/** ISO-8601 date/datetime string (what JSON.stringify makes of a JS Date — PG rows). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Parse a value into epoch ms when it looks like a time (epoch or ISO). */
function anyToMs(v: unknown): number | null {
  if (typeof v === 'number') return epochToMs(v);
  if (typeof v === 'string') {
    if (/^\d{10}$/.test(v) || /^\d{13}$/.test(v)) return epochToMs(Number(v));
    if (ISO_RE.test(v)) {
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    }
  }
  return null;
}

/** Detect the natural format of one raw value (used by 'auto' columns). */
export function detectFormat(v: unknown): Exclude<ColumnFormat, 'auto'> {
  if (typeof v === 'number') return epochToMs(v) !== null ? 'datetime' : 'number';
  if (typeof v === 'string' && anyToMs(v) !== null && !/^\d{4}$/.test(v)) return 'datetime';
  return 'text';
}

// ── Cell typing ───────────────────────────────────────────────────────────────

const NUMFMT_DATE = 'dd/mm/yyyy';
const NUMFMT_DATETIME = 'hh:mm:ss dd/mm/yyyy';

interface TypedCell {
  value: string | number | Date | null;
  numFmt?: string;
  align: 'left' | 'right' | 'center';
}

/**
 * Date → chuỗi, cho các phần tử NẰM TRONG một ô nhiều giá trị.
 *
 * Ô gộp là text nên không có numFmt của Excel để dựa vào — phải tự in ra đúng
 * quy ước nhà: `dd/MM/yyyy` và `HH:mm:ss dd/MM/yyyy`. Date ở đây đã qua
 * msToExcelDate (đã dịch theo offset local) nên đọc bằng getUTC* mới ra đúng
 * giờ người dùng thấy ở các ô date thật.
 */
function fmtDateText(d: Date, numFmt?: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  if (numFmt === NUMFMT_DATE) return day;
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${day}`;
}

/** Export để test được trực tiếp — không dùng ngoài file này + test. */
export function typeCell(raw: unknown, format: ColumnFormat, sep?: string): TypedCell {
  if (raw === undefined || raw === null) return { value: null, align: 'left' };

  // NHIỀU GIÁ TRỊ (field con của list object) → luôn là TEXT nối bằng `sep`.
  // Một ô Excel chỉ giữ được MỘT giá trị có kiểu, nên kể cả cột khai number/date
  // thì tập giá trị vẫn phải hạ xuống text — có định dạng từng phần tử trước khi
  // nối để "ngày giờ" vẫn ra chuỗi ngày đọc được, không phải epoch trần.
  if (Array.isArray(raw)) {
    const glue = sep === undefined || sep === '' ? DEFAULT_SEP : sep;
    const parts = raw.map((v) => {
      const cell = typeCell(v, format); // không truyền sep — phần tử không lồng thêm
      if (cell.value === null) return '';
      if (cell.value instanceof Date) return fmtDateText(cell.value, cell.numFmt);
      return String(cell.value);
    });
    return { value: parts.join(glue), align: 'left' };
  }

  const eff = format === 'auto' ? detectFormat(raw) : format;
  switch (eff) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(n)
        ? { value: n, align: 'right' }
        : { value: asText(raw), align: 'left' };
    }
    case 'date':
    case 'datetime': {
      // Accept epoch (s/ms, number or numeric string) AND ISO strings (PG rows).
      const ms = anyToMs(raw) ?? (typeof raw === 'string' ? epochToMs(Number(raw)) : null);
      if (ms === null) return { value: asText(raw), align: 'left' }; // not a time — degrade to text
      return {
        value: msToExcelDate(ms),
        numFmt: eff === 'date' ? NUMFMT_DATE : NUMFMT_DATETIME,
        align: 'center',
      };
    }
    default:
      return { value: asText(raw), align: 'left' };
  }
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ── Workbook builder ──────────────────────────────────────────────────────────

/** Report palette — deep teal header, soft banding, subtle borders. */
const C_HEADER_FILL = 'FF1F4E5F';
const C_HEADER_FONT = 'FFFFFFFF';
const C_TITLE_FONT = 'FF1F4E5F';
const C_SUB_FONT = 'FF6B7A80';
const C_BAND_FILL = 'FFF0F6F7';
const C_BORDER = 'FFD5DEE2';

/** Build the styled workbook and return it as a Blob ready for download. */
export async function buildReportXlsx(
  meta: ReportMeta,
  columns: ReportColumn[],
  docs: Record<string, unknown>[],
): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OMI DevBox';
  wb.created = new Date();
  const ws = wb.addWorksheet('Report', { views: [{ state: 'frozen', ySplit: 3 }] });

  const nCols = Math.max(columns.length, 1);
  const border = {
    top: { style: 'thin' as const, color: { argb: C_BORDER } },
    left: { style: 'thin' as const, color: { argb: C_BORDER } },
    bottom: { style: 'thin' as const, color: { argb: C_BORDER } },
    right: { style: 'thin' as const, color: { argb: C_BORDER } },
  };

  // Row 1 — title (merged across all columns).
  ws.mergeCells(1, 1, 1, nCols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = meta.title;
  titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: C_TITLE_FONT } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 26;

  // Row 2 — subtitle (target · count · exported-at — no query internals).
  ws.mergeCells(2, 1, 2, nCols);
  const now = new Date();
  const two = (x: number) => String(x).padStart(2, '0');
  const stamp = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())} ${two(now.getDate())}/${two(now.getMonth() + 1)}/${now.getFullYear()}`;
  const subCell = ws.getCell(2, 1);
  subCell.value = `${meta.target}   ·   ${meta.rowCount} dòng   ·   xuất lúc ${stamp}${meta.note ? `   ·   ${meta.note}` : ''}`;
  subCell.font = { name: 'Calibri', size: 10, italic: true, color: { argb: C_SUB_FONT } };
  subCell.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(2).height = 16;

  // Row 3 — column headers.
  const headerRow = ws.getRow(3);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header || c.path;
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C_HEADER_FONT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER_FILL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = border;
  });
  headerRow.height = 20;

  // Data rows — typed cells + zebra banding.
  const widths = columns.map((c) =>
    c.path === NO_COLUMN_PATH ? Math.max(6, (c.header || 'STT').length + 2) : Math.max(10, (c.header || c.path).length + 4),
  );
  docs.forEach((doc, r) => {
    const row = ws.getRow(4 + r);
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      const typed: TypedCell = c.path === NO_COLUMN_PATH
        ? { value: r + 1, align: 'right' } // sequential row number, not a doc value
        : typeCell(collectByPath(doc, c.path), c.format, c.sep);
      cell.value = typed.value;
      if (typed.numFmt) cell.numFmt = typed.numFmt;
      cell.font = { name: 'Calibri', size: 10.5 };
      cell.alignment = { vertical: 'middle', horizontal: typed.align };
      cell.border = border;
      if (r % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_BAND_FILL } };
      // Track a readable column width from the rendered length (capped).
      const len = typed.value instanceof Date
        ? (typed.numFmt === NUMFMT_DATE ? 12 : 21)
        : String(typed.value ?? '').length;
      widths[i] = Math.min(50, Math.max(widths[i], len + 2));
    });
  });

  // A4 floor: a 2–3 column report must SPREAD to roughly a printable A4 width,
  // not shrink into a narrow strip. ~90 Excel width units ≈ A4 portrait line.
  const A4_MIN_TOTAL_WIDTH = 90;
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  if (totalWidth < A4_MIN_TOTAL_WIDTH && columns.length > 0) {
    const deficit = A4_MIN_TOTAL_WIDTH - totalWidth;
    // Distribute proportionally — wide (content-heavy) columns grow more; the
    // STT column keeps its small share.
    columns.forEach((_, i) => { widths[i] += (widths[i] / totalWidth) * deficit; });
  }
  columns.forEach((_, i) => { ws.getColumn(i + 1).width = Math.round(widths[i] * 10) / 10; });

  // Print setup: A4, fit-to-width — the sheet prints as one page wide.
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: columns.length > 6 ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  };

  // Auto-filter over the header + data block — reviewers expect to slice.
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + docs.length, column: nCols } };

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Trigger a browser download for the built blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Safe filename from the report title: `bao-cao-tenant-20260731-1530.xlsx`. */
export function reportFilename(title: string): string {
  const slug = title.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip Vietnamese diacritics
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
  const n = new Date();
  const two = (x: number) => String(x).padStart(2, '0');
  return `${slug}-${n.getFullYear()}${two(n.getMonth() + 1)}${two(n.getDate())}-${two(n.getHours())}${two(n.getMinutes())}.xlsx`;
}
