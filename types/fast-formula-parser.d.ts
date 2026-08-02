// Khai báo tối thiểu cho fast-formula-parser (package không ship types).
// Chỉ khai đúng phần lib/formulaEval.ts dùng.
declare module 'fast-formula-parser' {
  export interface FfpCellRef {
    sheet: string;
    row: number; // 1-based
    col: number; // 1-based
  }
  export interface FfpRangeRef {
    sheet: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }
  export interface FfpConfig {
    onCell?: (ref: FfpCellRef) => unknown;
    onRange?: (ref: FfpRangeRef) => unknown[][];
    functions?: Record<string, (...args: unknown[]) => unknown>;
    onVariable?: (name: string, sheet: string) => unknown;
  }
  export default class FormulaParser {
    constructor(config?: FfpConfig);
    /** Trả về giá trị, hoặc FormulaError-like object khi công thức lỗi. */
    parse(formula: string, position: FfpCellRef, allowReturnArray?: boolean): unknown;
  }
}
