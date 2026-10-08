// So sánh HAI bản chụp (snapshot) của Univer → "bản vá" nhỏ để ghi vào file xlsx/csv.
// Thuần (không DOM, không fs) nên chạy được ở cả client lẫn server và test được.
//
// VÌ SAO SO BẢN CHỤP thay vì bắt từng lệnh (set-range-values, insert-row…):
//   · Dán, fill, sắp xếp, undo/redo, xoá nhiều ô… đều sinh ra những lệnh khác nhau,
//     còn bản chụp thì luôn cho đúng KẾT QUẢ. Một chỗ so sánh bao hết.
//   · Chèn/xoá dòng-cột: Univer đã tự sửa công thức tham chiếu; ta ghi lại đúng
//     công thức đã sửa đó nên không lệch (cơ chế phát-lại-thao-tác cũ không làm được).
//
// MỐC SO SÁNH là bản chụp của CHÍNH Univer ngay sau khi nạp (không phải dữ liệu server
// gửi xuống): hai bên cùng một cách biểu diễn nên không sinh "thay đổi giả" do khác
// kiểu lưu (id style, kiểu số…).
//
// Cái KHÔNG ghi được (thành cảnh báo/chặn, không im lặng bỏ): thêm/xoá/đổi tên/đổi
// thứ tự sheet (chặn) · conditional formatting, data validation, hyperlink, ghi chú,
// bộ lọc, tên vùng (cảnh báo: bản chụp có đổi nhưng file sẽ không có).

import type { UStyle } from './sheetUniver';

// ── Kiểu bản chụp (rút gọn, đủ cho phần so sánh) ────────────────────────────

export interface SnapCell {
  v?: unknown;
  t?: number;
  f?: string | null;
  s?: string | UStyle | null;
  p?: { body?: { dataStream?: string } } | null;
}
export interface SnapSheet {
  id?: string;
  name: string;
  cellData?: Record<string, Record<string, SnapCell | null | undefined> | undefined>;
  mergeData?: { startRow: number; endRow: number; startColumn: number; endColumn: number }[];
  rowData?: Record<string, { h?: number; hd?: number } | undefined>;
  columnData?: Record<string, { w?: number; hd?: number } | undefined>;
  freeze?: { xSplit?: number; ySplit?: number } | null;
}
export interface Snapshot {
  styles?: Record<string, UStyle | null | undefined>;
  sheetOrder?: string[];
  sheets: Record<string, SnapSheet>;
  resources?: { name: string; data?: string }[];
}

// ── Bản vá ──────────────────────────────────────────────────────────────────

export interface CellPatch {
  r: number; // 0-based
  c: number;
  /** Có mặt = giá trị/công thức của ô đổi. null = xoá nội dung. */
  value?: { v: string | number | boolean | null; t?: number; f?: string };
  /** Có mặt = định dạng đổi. null = xoá định dạng. */
  style?: UStyle | null;
}
export interface Rect { startRow: number; endRow: number; startColumn: number; endColumn: number }
export interface SheetPatch {
  index: number;
  name: string;
  cells: CellPatch[];
  /** Có mặt = danh sách gộp ô ĐẦY ĐỦ mới (thay hẳn danh sách cũ). */
  merges?: Rect[];
  cols?: { c: number; w?: number | null; hd?: boolean }[];
  rows?: { r: number; h?: number | null; hd?: boolean }[];
  /** Có mặt = freeze đổi; null = bỏ freeze. */
  freeze?: { xSplit: number; ySplit: number } | null;
}
export interface UniverPatch { sheets: SheetPatch[] }

export interface DiffResult {
  patch: UniverPatch;
  /** Số ô đổi nội dung hoặc định dạng. */
  changed: number;
  /** Có thay đổi khác (gộp ô, kích thước, freeze) — để biết "có gì để lưu". */
  otherChanges: number;
  /** Thay đổi KHÔNG THỂ lưu — chặn nút Lưu. */
  blockers: string[];
  /** Thay đổi sẽ KHÔNG vào file nhưng không chặn. */
  warnings: string[];
}

// ── Chuẩn hoá ───────────────────────────────────────────────────────────────

/** Bỏ giá trị "không có gì" (0/null/{}) để hai cách biểu diễn cùng một style so bằng nhau. */
function cleanStyle(st: UStyle | null | undefined): UStyle | null {
  if (!st || typeof st !== 'object') return null;
  const out: UStyle = {};
  for (const [k, v] of Object.entries(st)) {
    if (v === null || v === undefined || v === 0 || v === '') continue;
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // ul/st/ol: {s:0} = tắt.
      if ('s' in o && Object.keys(o).length <= 2 && (o.s === 0 || o.s === undefined) && !('cl' in o && o.cl)) continue;
      const nested = cleanStyle(o as UStyle);
      if (!nested) continue;
      out[k] = nested;
    } else out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** JSON ổn định (khoá sắp xếp) để so sánh sâu. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

function styleOf(snap: Snapshot, cell: SnapCell | null | undefined): UStyle | null {
  if (!cell || cell.s === null || cell.s === undefined) return null;
  const raw = typeof cell.s === 'string' ? snap.styles?.[cell.s] : cell.s;
  return cleanStyle(raw);
}

type Val = string | number | boolean | null;

/** Giá trị hiển thị của ô (null = trống). Rich text lấy chữ phẳng. */
function valueOf(cell: SnapCell | null | undefined): Val {
  if (!cell) return null;
  const v = cell.v;
  if (v !== null && v !== undefined && v !== '') {
    return typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
  }
  const ds = cell.p?.body?.dataStream;
  if (typeof ds === 'string') {
    const text = ds.replace(/\r\n?$/, '').replace(/\r/g, '\n');
    return text === '' ? null : text;
  }
  return null;
}

const formulaOf = (cell: SnapCell | null | undefined): string => {
  const f = cell?.f;
  return typeof f === 'string' && f.trim() !== '' ? f : '';
};

function cellsOf(sheet: SnapSheet): Map<string, SnapCell> {
  const m = new Map<string, SnapCell>();
  for (const [r, row] of Object.entries(sheet.cellData ?? {})) {
    if (!row) continue;
    for (const [c, cell] of Object.entries(row)) if (cell) m.set(`${r},${c}`, cell);
  }
  return m;
}

const mergeKey = (m: Rect) => `${m.startRow},${m.startColumn},${m.endRow},${m.endColumn}`;

/** Tên thân thiện cho resource của Univer (cảnh báo "KHÔNG được lưu"). */
function resourceLabel(name: string): string {
  const n = name.toUpperCase();
  if (n.includes('CONDITIONAL')) return 'conditional formatting';
  if (n.includes('DATA_VALIDATION')) return 'data validation';
  if (n.includes('HYPER')) return 'hyperlink';
  if (n.includes('NOTE') || n.includes('COMMENT')) return 'ghi chú';
  if (n.includes('FILTER')) return 'bộ lọc';
  if (n.includes('DEFINED_NAME')) return 'tên vùng';
  return name;
}

// ── So sánh ─────────────────────────────────────────────────────────────────

export function diffSnapshots(base: Snapshot, cur: Snapshot): DiffResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const patch: UniverPatch = { sheets: [] };
  let changed = 0;
  let otherChanges = 0;

  const bOrder = base.sheetOrder ?? Object.keys(base.sheets);
  const cOrder = cur.sheetOrder ?? Object.keys(cur.sheets);
  const bNames = bOrder.map((id) => base.sheets[id]?.name);
  const cNames = cOrder.map((id) => cur.sheets[id]?.name);
  if (stable(bNames) !== stable(cNames)) {
    blockers.push('Thêm / xóa / đổi tên / đổi thứ tự sheet chưa lưu được vào file. Hãy hoàn tác thao tác đó, hoặc làm bằng Excel.');
    return { patch, changed, otherChanges, blockers, warnings };
  }

  bOrder.forEach((bid, index) => {
    const bs = base.sheets[bid];
    const cs = cur.sheets[cOrder[index]];
    if (!bs || !cs) return;
    const sp: SheetPatch = { index, name: bs.name, cells: [] };

    // Ô: so riêng phần nội dung và phần định dạng.
    const bc = cellsOf(bs);
    const cc = cellsOf(cs);
    const keys = new Set([...bc.keys(), ...cc.keys()]);
    for (const k of keys) {
      const b = bc.get(k);
      const c = cc.get(k);
      const [r, col] = k.split(',').map(Number);
      const bf = formulaOf(b); const cf = formulaOf(c);
      const bv = valueOf(b); const cv = valueOf(c);
      // Ô công thức: chỉ so công thức (giá trị tính ra thay đổi theo ô khác — không phải sửa của người dùng).
      const valueChanged = bf !== cf || (cf === '' && (bv !== cv || (bv !== null && b?.t !== c?.t && typeof bv !== typeof cv)));
      const bs2 = styleOf(base, b); const cs2 = styleOf(cur, c);
      const styleChanged = stable(bs2) !== stable(cs2);
      if (!valueChanged && !styleChanged) continue;
      const patchCell: CellPatch = { r, c: col };
      if (valueChanged) {
        patchCell.value = cf
          ? { v: cv, ...(c?.t !== undefined ? { t: c.t } : {}), f: cf }
          : { v: cv, ...(c?.t !== undefined && cv !== null ? { t: c.t } : {}) };
      }
      if (styleChanged) patchCell.style = cs2;
      sp.cells.push(patchCell);
      changed++;
    }

    // Gộp ô.
    const bm = (bs.mergeData ?? []).map(mergeKey).sort();
    const cm = (cs.mergeData ?? []).map(mergeKey).sort();
    if (stable(bm) !== stable(cm)) { sp.merges = [...(cs.mergeData ?? [])]; otherChanges++; }

    // Độ rộng cột / chiều cao dòng / ẩn.
    const colKeys = new Set([...Object.keys(bs.columnData ?? {}), ...Object.keys(cs.columnData ?? {})]);
    for (const k of colKeys) {
      const b = bs.columnData?.[k]; const c = cs.columnData?.[k];
      if ((b?.w ?? null) !== (c?.w ?? null) || !!b?.hd !== !!c?.hd) {
        (sp.cols ??= []).push({ c: Number(k), w: c?.w ?? null, hd: !!c?.hd });
        otherChanges++;
      }
    }
    const rowKeys = new Set([...Object.keys(bs.rowData ?? {}), ...Object.keys(cs.rowData ?? {})]);
    for (const k of rowKeys) {
      const b = bs.rowData?.[k]; const c = cs.rowData?.[k];
      if ((b?.h ?? null) !== (c?.h ?? null) || !!b?.hd !== !!c?.hd) {
        (sp.rows ??= []).push({ r: Number(k), h: c?.h ?? null, hd: !!c?.hd });
        otherChanges++;
      }
    }

    // Freeze.
    const bf = { x: bs.freeze?.xSplit ?? 0, y: bs.freeze?.ySplit ?? 0 };
    const cf = { x: cs.freeze?.xSplit ?? 0, y: cs.freeze?.ySplit ?? 0 };
    if (bf.x !== cf.x || bf.y !== cf.y) {
      sp.freeze = cf.x || cf.y ? { xSplit: cf.x, ySplit: cf.y } : null;
      otherChanges++;
    }

    if (sp.cells.length || sp.merges || sp.cols || sp.rows || sp.freeze !== undefined) patch.sheets.push(sp);
  });

  // Resource (CF, DV, hyperlink, ghi chú, bộ lọc…) đổi → file sẽ không có.
  const norm = (d: string | undefined) => (isEmptyResource(d) ? '' : d ?? '');
  const bRes = new Map((base.resources ?? []).map((r) => [r.name, norm(r.data)]));
  const cRes = new Map((cur.resources ?? []).map((r) => [r.name, norm(r.data)]));
  const lost = new Set<string>();
  for (const name of new Set([...bRes.keys(), ...cRes.keys()])) {
    if ((bRes.get(name) ?? '') !== (cRes.get(name) ?? '')) lost.add(resourceLabel(name));
  }
  if (lost.size) warnings.push(`Các thay đổi sau KHÔNG được ghi vào file (chỉ lưu giá trị, định dạng ô, gộp ô, kích thước, freeze): ${[...lost].join(', ')}.`);

  return { patch, changed, otherChanges, blockers, warnings };
}

/** Resource rỗng ("{}", "[]", "") coi như không có gì — Univer hay thêm sẵn mục rỗng sau khi nạp. */
function isEmptyResource(data: string | undefined): boolean {
  if (!data) return true;
  const t = data.replace(/\s+/g, '');
  return t === '{}' || t === '[]' || t === '""' || t === 'null' || /^\{("[^"]*":(\{\}|\[\]|""))*\}$/.test(t);
}

/** Lưới giá trị dạng chuỗi (cho CSV): công thức → giá trị tính ra, boolean → TRUE/FALSE. */
export function snapshotToGrid(snap: Snapshot, sheetIndex = 0): string[][] {
  const order = snap.sheetOrder ?? Object.keys(snap.sheets);
  const sheet = snap.sheets[order[sheetIndex]];
  if (!sheet) return [];
  const grid: string[][] = [];
  let maxR = -1;
  for (const [k, cell] of cellsOf(sheet)) {
    const v = valueOf(cell);
    if (v === null) continue;
    const [r, c] = k.split(',').map(Number);
    while (grid.length <= r) grid.push([]);
    const row = grid[r];
    while (row.length <= c) row.push('');
    row[c] = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
    maxR = Math.max(maxR, r);
  }
  return grid.slice(0, maxR + 1).map((row) => row.slice());
}
