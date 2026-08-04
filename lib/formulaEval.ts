// Client-side formula engine cho Sheet workspace — tính kết quả các ô công
// thức NGAY TRONG GRID (SUM/IF/VLOOKUP/…, ~280 hàm Excel của
// fast-formula-parser), để gõ =SUM(A1:B2) là thấy số liền như Excel thật.
//
// Nguyên tắc: đây chỉ là DERIVATION cho hiển thị — working copy + op log giữ
// công thức gốc, file .xlsx lưu formula thật (server ghi {formula} +
// fullCalcOnLoad nên Excel mở lên tự tính lại bằng engine của chính nó).
// Chuỗi phụ thuộc (formula tham chiếu formula) giải bằng fixed-point tối đa
// 5 vòng — đủ cho bảng tính tay; vòng lặp tuần hoàn dừng ở giá trị ổn định
// gần nhất thay vì treo.

import FormulaParser from 'fast-formula-parser';
import type { WireCell } from './sheet';
import { formatNumFmt } from './numFmt';

const SHEET = 'S';
const MAX_PASSES = 5;
const MAX_FORMULAS = 2000;   // trần an toàn — file nhiều công thức hơn thì phần dư hiện theo giá trị cache
const MAX_RANGE_CELLS = 50_000;

/** Giá trị "native" của một ô cho engine: số → number, rỗng → null, còn lại text. */
function nativeValue(v: string): unknown {
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isNaN(n) && /^\s*-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(v)) return n;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

/** Kết quả engine → text hiển thị trong ô. */
function formatResult(res: unknown): string {
  if (res === null || res === undefined) return '';
  if (typeof res === 'number') {
    if (!Number.isFinite(res)) return '#NUM!';
    // Cắt noise float (0.30000000000000004 → 0.3).
    const rounded = Math.round(res * 1e10) / 1e10;
    return String(rounded);
  }
  if (typeof res === 'boolean') return res ? 'TRUE' : 'FALSE';
  if (typeof res === 'object') {
    // FormulaError của fast-formula-parser: toString() → "#DIV/0!"…
    const s = String(res);
    return s.startsWith('#') ? s : '#ERROR!';
  }
  return String(res);
}

/**
 * Trả về grid MỚI trong đó mọi ô công thức (t==='f') có v = kết quả tính được.
 * Grid không có công thức nào → trả lại chính tham chiếu cũ (useMemo rẻ).
 *
 * `nfOf(r,c)` (1-based, optional): numFmt của ô — engine ĐỌC giá trị thô qua
 * cell.raw (ô số đã format "1,234,568" vẫn tính đúng) và format LẠI kết quả
 * công thức theo numFmt của chính ô đó (SUM tiền ra "2,079,568" chứ không
 * phải "2079567.5").
 */
export function evaluateGrid(
  grid: WireCell[][],
  nfOf?: (r: number, c: number) => string | undefined,
): WireCell[][] {
  const formulas: { r: number; c: number; f: string }[] = [];
  for (let r = 0; r < grid.length && formulas.length < MAX_FORMULAS; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length && formulas.length < MAX_FORMULAS; c++) {
      const cell = row[c];
      if (cell.t === 'f' && cell.f) formulas.push({ r: r + 1, c: c + 1, f: cell.f });
    }
  }
  if (formulas.length === 0) return grid;

  /** Giá trị hiện hành: 'r:c' → native. Ô công thức seed bằng cache từ file. */
  const values = new Map<string, unknown>();
  const key = (r: number, c: number) => `${r}:${c}`;
  const rawAt = (r: number, c: number): unknown => {
    const k = key(r, c);
    if (values.has(k)) return values.get(k);
    const cell = grid[r - 1]?.[c - 1];
    // Ô số/ngày đã format hiển thị → tính bằng giá trị THÔ (cell.raw).
    return nativeValue(cell?.raw ?? cell?.v ?? '');
  };

  const parser = new FormulaParser({
    onCell: ({ row, col }) => rawAt(row, col),
    onRange: ({ from, to }) => {
      const r1 = Math.max(1, from.row);
      const c1 = Math.max(1, from.col);
      // Range hở (A:C, 1:5) trả max row/col khổng lồ — kẹp theo dữ liệu thật.
      const r2 = Math.min(to.row, Math.max(grid.length, 1));
      const c2 = Math.min(to.col, Math.max(...grid.map((row) => row.length), 1));
      if ((r2 - r1 + 1) * (c2 - c1 + 1) > MAX_RANGE_CELLS) return [[null]];
      const out: unknown[][] = [];
      for (let r = r1; r <= r2; r++) {
        const row: unknown[] = [];
        for (let c = c1; c <= c2; c++) row.push(rawAt(r, c));
        out.push(row);
      }
      return out;
    },
  });

  // Fixed-point: lặp tới khi không còn kết quả nào đổi (chuỗi phụ thuộc sâu
  // dần hội tụ; tham chiếu vòng dừng ở MAX_PASSES).
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (const { r, c, f } of formulas) {
      let res: unknown;
      try {
        res = parser.parse(f, { sheet: SHEET, row: r, col: c });
      } catch {
        res = '#ERROR!';
      }
      const norm = formatResult(res);
      const native = nativeValue(norm);
      const k = key(r, c);
      const seedCell = grid[r - 1]?.[c - 1];
      const prev = values.has(k) ? values.get(k) : nativeValue(seedCell?.raw ?? seedCell?.v ?? '');
      if (prev !== native) {
        values.set(k, native);
        changed = true;
      } else {
        values.set(k, native);
      }
    }
    if (!changed) break;
  }

  return grid.map((row, ri) =>
    row.some((cell) => cell.t === 'f' && cell.f)
      ? row.map((cell, ci) => {
          if (cell.t !== 'f' || !cell.f) return cell;
          const k = key(ri + 1, ci + 1);
          if (!values.has(k)) return cell; // vượt trần MAX_FORMULAS → giữ cache
          const v = values.get(k);
          let text = v === null || v === undefined
            ? ''
            : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
          // Kết quả số → format theo numFmt của Ô CÔNG THỨC (SUM tiền ra "2,079,568").
          const nf = nfOf?.(ri + 1, ci + 1);
          if (nf && typeof v === 'number') text = formatNumFmt(v, nf).text;
          return text === cell.v ? cell : { ...cell, v: text };
        })
      : row,
  );
}
