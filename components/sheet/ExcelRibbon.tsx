'use client';

// Khung kiểu Microsoft Excel cho "Giao diện Excel mới" (Univer): thanh tiêu đề
// xanh, dải tab File · Home · Insert · Draw · Page Layout · Formulas · Data ·
// Review · View · Help, và ribbon Home với các nhóm Clipboard / Font / Alignment /
// Number / Styles / Cells / Editing — nhãn tiếng Anh y như Excel.
//
// Ribbon gốc của Univer bị tắt (toolbar:false ở UniverSheet); lưới, thanh công
// thức và tab sheet vẫn là của Univer. Mọi nút ở đây chỉ GỌI LỆNH Univer
// (executeCommand / Facade API) — không giữ dữ liệu bảng tính, nên undo/redo,
// lưu, so sánh thay đổi vẫn đi đúng đường cũ.
//
// Tính năng Excel nào Univer chưa có (Draw, Format as Table, indent…) thì nút
// vẫn hiện cho đúng bố cục nhưng mờ đi, tooltip nói rõ là chưa hỗ trợ.

import { Children, Fragment, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { createUniver } from '@univerjs/presets';
import { ColorPicker } from '../SheetFormatBar';

type Api = ReturnType<typeof createUniver>['univerAPI'];

const FONTS = ['Calibri', 'Arial', 'Times New Roman', 'Segoe UI', 'Tahoma', 'Verdana', 'Courier New', 'Consolas', 'Cambria', 'Roboto'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const NUM_FORMATS: { label: string; pattern: string; sample: string }[] = [
  { label: 'General', pattern: '', sample: 'No specific format' },
  { label: 'Number', pattern: '0.00', sample: '1234.57' },
  { label: 'Currency', pattern: '"$"#,##0.00', sample: '$1,234.57' },
  { label: 'Accounting', pattern: '_("$"* #,##0.00_)', sample: '$  1,234.57' },
  { label: 'Short Date', pattern: 'm/d/yyyy', sample: '9/30/2026' },
  { label: 'Long Date', pattern: 'dddd, mmmm d, yyyy', sample: 'Wednesday, September 30, 2026' },
  { label: 'Time', pattern: 'h:mm:ss AM/PM', sample: '5:00:00 PM' },
  { label: 'Percentage', pattern: '0.00%', sample: '12.34%' },
  { label: 'Fraction', pattern: '# ?/?', sample: '1234 1/2' },
  { label: 'Scientific', pattern: '0.00E+00', sample: '1.23E+03' },
  { label: 'Text', pattern: '@', sample: 'Text as typed' },
];
/** Kiểu ô nhanh như gallery Styles của Excel (màu đúng của Office). */
const CELL_STYLES = [
  { label: 'Normal', bg: null, fc: null },
  { label: 'Bad', bg: '#ffc7ce', fc: '#9c0006' },
  { label: 'Good', bg: '#c6efce', fc: '#006100' },
  { label: 'Neutral', bg: '#ffeb9c', fc: '#9c5700' },
] as const;
/** Một kiểu ô trong gallery Cell Styles đầy đủ của Excel. Màu/viền đúng bộ theme Office. */
interface StyleDef {
  label: string; bg?: string; fc?: string; bold?: boolean; italic?: boolean; fs?: number; ff?: string;
  border?: { type: 'top' | 'bottom' | 'all'; style: number; color: string }[];
  /** Kiểu "Number Format" (Comma, Currency, Percent…): chỉ đổi định dạng số, giữ font/màu. */
  numfmt?: string;
}
const ACCENTS = [
  ['#4472c4', '#d9e1f2', '#b4c6e7', '#8ea9db'], ['#ed7d31', '#fce4d6', '#f8cbad', '#f4b084'],
  ['#a5a5a5', '#ededed', '#dbdbdb', '#c9c9c9'], ['#ffc000', '#fff2cc', '#ffe699', '#ffd966'],
  ['#5b9bd5', '#ddebf7', '#bdd7ee', '#9bc2e6'], ['#70ad47', '#e2efda', '#c6e0b4', '#a9d08e'],
];
const STYLE_GALLERY: { section: string; items: StyleDef[] }[] = [
  { section: 'Good, Bad and Neutral', items: CELL_STYLES.map((s) => ({ label: s.label, bg: s.bg ?? undefined, fc: s.fc ?? undefined })) },
  { section: 'Data and Model', items: [
    { label: 'Calculation', bg: '#f2f2f2', fc: '#fa7d00', bold: true, border: [{ type: 'all', style: 1, color: '#7f7f7f' }] },
    { label: 'Check Cell', bg: '#a5a5a5', fc: '#ffffff', bold: true, border: [{ type: 'all', style: 7, color: '#3f3f3f' }] },
    { label: 'Explanatory Text', fc: '#7f7f7f', italic: true },
    { label: 'Input', bg: '#ffcc99', fc: '#3f3f76', border: [{ type: 'all', style: 1, color: '#7f7f7f' }] },
    { label: 'Linked Cell', fc: '#fa7d00', border: [{ type: 'bottom', style: 7, color: '#ff8001' }] },
    { label: 'Note', bg: '#ffffcc', border: [{ type: 'all', style: 1, color: '#b2b2b2' }] },
    { label: 'Output', bg: '#f2f2f2', fc: '#3f3f3f', bold: true, border: [{ type: 'all', style: 1, color: '#3f3f3f' }] },
    { label: 'Warning Text', fc: '#ff0000' },
  ] },
  { section: 'Titles and Headings', items: [
    { label: 'Heading 1', fc: '#1f4e79', bold: true, fs: 15, border: [{ type: 'bottom', style: 13, color: '#4472c4' }] },
    { label: 'Heading 2', fc: '#1f4e79', bold: true, fs: 13, border: [{ type: 'bottom', style: 13, color: '#a1b8e1' }] },
    { label: 'Heading 3', fc: '#1f4e79', bold: true, border: [{ type: 'bottom', style: 8, color: '#8eaadb' }] },
    { label: 'Heading 4', fc: '#1f4e79', bold: true },
    { label: 'Title', fc: '#1f4e79', bold: true, fs: 18, ff: 'Calibri Light' },
    { label: 'Total', bold: true, border: [{ type: 'top', style: 1, color: '#4472c4' }, { type: 'bottom', style: 7, color: '#4472c4' }] },
  ] },
  { section: 'Themed Cell Styles', items: [
    ...[1, 2, 3].flatMap((tint) => ACCENTS.map((a, i) => ({ label: `${tint * 20}% - Accent${i + 1}`, bg: a[tint] }))),
    ...ACCENTS.map((a, i) => ({ label: `Accent${i + 1}`, bg: a[0], fc: '#ffffff' })),
  ] },
  { section: 'Number Format', items: [
    { label: 'Comma', numfmt: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)' },
    { label: 'Comma [0]', numfmt: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)' },
    { label: 'Currency', numfmt: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)' },
    { label: 'Currency [0]', numfmt: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)' },
    { label: 'Percent', numfmt: '0%' },
  ] },
];
const TABS = ['File', 'Home', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Data', 'Review', 'View', 'Help'] as const;
type Tab = typeof TABS[number];
const COLLAPSE_KEY = 'sheet.xl.ribbonCollapsed';
const NA = 'Not available in this editor yet';

// Enum của Univer (số) — khai tay để không kéo cả @univerjs/core vào bundle chính.
const H_ALIGN = { left: 1, center: 2, right: 3 } as const;
const V_ALIGN = { top: 1, middle: 2, bottom: 3 } as const;
const WRAP = 3;
const BORDER_THIN = 1;
const BORDER_THICK = 13;

/** Trạng thái ô đang chọn — để nút nào đang bật thì sáng, ô font/cỡ hiện đúng. */
interface CellState {
  ff?: string; fs?: number; bl?: boolean; it?: boolean; ul?: boolean; st?: boolean;
  ht?: number; vt?: number; wrap?: boolean; fc?: string; bg?: string; pattern?: string;
  merged?: boolean; label: string;
}

const colName = (c: number) => {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const a1 = (r: number, c: number) => `${colName(c)}${r + 1}`;

// Hình dữ liệu Univer dùng ở đây (khai tay thay vì import @univerjs/core — xem ghi chú enum trên).
interface Rect { startRow: number; startColumn: number; endRow: number; endColumn: number }
interface UCell { v?: unknown; f?: string | null; si?: string | null; p?: { body?: { dataStream?: string } } | null; s?: unknown }
const rectLabel = (r: Rect) => (r.startRow === r.endRow && r.startColumn === r.endColumn
  ? a1(r.startRow, r.startColumn) : `${a1(r.startRow, r.startColumn)}:${a1(r.endRow, r.endColumn)}`);
const isBlankCell = (c: UCell | null | undefined) => !c || ((c.v == null || c.v === '') && !c.f && !c.si && !c.p);
/** Giới hạn số ô quét một lần cho Go To Special / Remove Duplicates (bảng lớn thì bắt chọn vùng nhỏ hơn). */
const MAX_SCAN_CELLS = 400_000;
const MAX_SELECT_RANGES = 2_000;

type DialogKind = 'goto' | 'special' | 'dedupe';
const SPECIALS = [
  { id: 'constants', label: 'Constants', hint: 'Cells with values but no formula' },
  { id: 'formulas', label: 'Formulas', hint: 'Cells containing a formula' },
  { id: 'blanks', label: 'Blanks', hint: 'Empty cells' },
  { id: 'region', label: 'Current region', hint: 'The block of data around the active cell' },
  { id: 'last', label: 'Last cell', hint: 'The last used cell on the sheet' },
] as const;
type SpecialKind = typeof SPECIALS[number]['id'];

/* ── Icon (vẽ tay, currentColor + vài điểm nhấn màu như Office) ─────────── */
const I = {
  save: <svg viewBox="0 0 16 16"><path d="M2 2h9l3 3v9H2z" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4.5 2v3.5h6V2M4.5 14V9.5h7V14" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>,
  undo: <svg viewBox="0 0 16 16"><path d="M5 4 2 7l3 3" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2.5 7H10a3.5 3.5 0 0 1 0 7H7" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>,
  redo: <svg viewBox="0 0 16 16"><path d="m11 4 3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M13.5 7H6a3.5 3.5 0 0 0 0 7h3" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>,
  paste: <svg viewBox="0 0 32 32"><rect x="5" y="5" width="18" height="23" rx="2" fill="#c8a165" /><rect x="10" y="3" width="8" height="5" rx="1.5" fill="#7a7a7a" /><rect x="13" y="12" width="15" height="17" fill="#fff" stroke="#7a7a7a" /><path d="M16 17h9M16 20.5h9M16 24h6" stroke="#9a9a9a" /></svg>,
  cut: <svg viewBox="0 0 16 16"><circle cx="4.5" cy="12" r="2.2" fill="none" stroke="currentColor" /><circle cx="11.5" cy="12" r="2.2" fill="none" stroke="currentColor" /><path d="M6 10.3 12 2M10 10.3 4 2" stroke="currentColor" strokeWidth="1.2" /></svg>,
  copy: <svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="9" fill="none" stroke="currentColor" /><path d="M3 11V2.5h7.5" fill="none" stroke="currentColor" /></svg>,
  painter: <svg viewBox="0 0 16 16"><rect x="2" y="2" width="10" height="4" rx="1" fill="#f0b24a" stroke="currentColor" strokeWidth=".8" /><path d="M12 4h2v4H7.5v2" fill="none" stroke="currentColor" /><rect x="6" y="10" width="3" height="5" rx=".8" fill="currentColor" /></svg>,
  grow: <svg viewBox="0 0 16 16"><text x="1" y="13" fontSize="12" fontWeight="600" fill="currentColor">A</text><path d="m11 5 2.5-3L16 5" fill="none" stroke="currentColor" /></svg>,
  shrink: <svg viewBox="0 0 16 16"><text x="1" y="13" fontSize="10" fontWeight="600" fill="currentColor">A</text><path d="m10 2 2.5 3L15 2" fill="none" stroke="currentColor" /></svg>,
  border: <svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" strokeDasharray="1.5 1.5" /><path d="M2 14h12" stroke="currentColor" strokeWidth="1.6" /></svg>,
  aTop: <svg viewBox="0 0 16 16"><path d="M2 2.5h12M4 5.5h8M2 8.5h12" stroke="currentColor" /></svg>,
  aMid: <svg viewBox="0 0 16 16"><path d="M2 5h12M4 8h8M2 11h12" stroke="currentColor" /></svg>,
  aBot: <svg viewBox="0 0 16 16"><path d="M2 7.5h12M4 10.5h8M2 13.5h12" stroke="currentColor" /></svg>,
  aLeft: <svg viewBox="0 0 16 16"><path d="M2 3h12M2 6.3h8M2 9.6h12M2 13h8" stroke="currentColor" /></svg>,
  aCenter: <svg viewBox="0 0 16 16"><path d="M2 3h12M4 6.3h8M2 9.6h12M4 13h8" stroke="currentColor" /></svg>,
  aRight: <svg viewBox="0 0 16 16"><path d="M2 3h12M6 6.3h8M2 9.6h12M6 13h8" stroke="currentColor" /></svg>,
  orient: <svg viewBox="0 0 16 16"><text x="1" y="12" fontSize="8" fill="currentColor" transform="rotate(-35 6 9)">ab</text><path d="m10 13 4-4m0 0v3m0-3h-3" fill="none" stroke="currentColor" /></svg>,
  wrap: <svg viewBox="0 0 16 16"><path d="M2 3h12M2 7h10a2 2 0 0 1 0 4H8" fill="none" stroke="currentColor" /><path d="m9.5 9.5-1.5 1.5 1.5 1.5" fill="none" stroke="currentColor" /><path d="M2 11h3" stroke="currentColor" /></svg>,
  indL: <svg viewBox="0 0 16 16"><path d="M7 3h7M7 6.3h7M7 9.6h7M2 13h12M5 5 2 7.5 5 10" fill="none" stroke="currentColor" /></svg>,
  indR: <svg viewBox="0 0 16 16"><path d="M7 3h7M7 6.3h7M7 9.6h7M2 13h12M2 5l3 2.5L2 10" fill="none" stroke="currentColor" /></svg>,
  merge: <svg viewBox="0 0 16 16"><rect x="1.5" y="3.5" width="13" height="9" fill="none" stroke="currentColor" /><path d="m4 8 2-1.5v3zm8 0-2-1.5v3z" fill="currentColor" /><path d="M6 8h4" stroke="currentColor" /></svg>,
  cond: <svg viewBox="0 0 32 32"><rect x="4" y="4" width="20" height="22" fill="#fff" stroke="#8a8a8a" /><rect x="6" y="7" width="7" height="4" fill="#e74c3c" /><rect x="6" y="13" width="11" height="4" fill="#3b82c4" /><rect x="6" y="19" width="5" height="4" fill="#e74c3c" /><path d="M18 18h10v10H18z" fill="#fff" stroke="#8a8a8a" /><path d="m20 23 2.5 2.5L27 20" fill="none" stroke="#217346" strokeWidth="1.6" /></svg>,
  table: <svg viewBox="0 0 32 32"><rect x="4" y="6" width="24" height="20" fill="#fff" stroke="#8a8a8a" /><rect x="4" y="6" width="24" height="5" fill="#4472c4" /><path d="M4 16h24M4 21h24M12 11v15M20 11v15" stroke="#8a8a8a" /></svg>,
  insert: <svg viewBox="0 0 32 32"><rect x="6" y="6" width="20" height="20" fill="#fff" stroke="#8a8a8a" /><path d="M6 13h20M6 19h20M13 6v20M19 6v20" stroke="#bdbdbd" /><path d="M2 16h8m-3-3 3 3-3 3" fill="none" stroke="#2b7bd6" strokeWidth="1.8" /></svg>,
  del: <svg viewBox="0 0 32 32"><rect x="6" y="6" width="20" height="20" fill="#fff" stroke="#8a8a8a" /><path d="M6 13h20M6 19h20M13 6v20M19 6v20" stroke="#bdbdbd" /><path d="m19 19 9 9m0-9-9 9" stroke="#d13438" strokeWidth="2" /></svg>,
  format: <svg viewBox="0 0 32 32"><rect x="6" y="6" width="20" height="20" fill="#fff" stroke="#8a8a8a" /><path d="M6 13h20M6 19h20M13 6v20M19 6v20" stroke="#bdbdbd" /><path d="M9 3v4M23 3v4M3 9h4M3 23h4" stroke="#2b7bd6" strokeWidth="1.6" /></svg>,
  sigma: <svg viewBox="0 0 16 16"><path d="M13 3H3.5l5 5-5 5H13" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>,
  fill: <svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" /><path d="M8 4v7m-3-3 3 3 3-3" fill="none" stroke="#2b7bd6" strokeWidth="1.5" /></svg>,
  eraser: <svg viewBox="0 0 16 16"><path d="m2 10 6-6 5 5-4 4H5z" fill="#f4a6b7" stroke="currentColor" strokeWidth=".8" /><path d="M5 13h9" stroke="currentColor" /></svg>,
  sort: <svg viewBox="0 0 32 32"><text x="3" y="13" fontSize="11" fontWeight="700" fill="#2b7bd6">A</text><text x="3" y="27" fontSize="11" fontWeight="700" fill="#c00">Z</text><path d="M14 5v20m-3-3 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M19 6h10l-4 6v8l-2 2v-10z" fill="#fff" stroke="currentColor" /></svg>,
  find: <svg viewBox="0 0 32 32"><circle cx="18" cy="12" r="7" fill="none" stroke="#2b7bd6" strokeWidth="2.4" /><path d="m13 17-8 9" stroke="#2b7bd6" strokeWidth="3" /></svg>,
  fx: <svg viewBox="0 0 32 32"><text x="5" y="23" fontSize="18" fontStyle="italic" fontFamily="Cambria, serif" fill="currentColor">fx</text></svg>,
  link: <svg viewBox="0 0 32 32"><path d="M13 19 19 13M11 15l-3 3a4 4 0 0 0 6 6l3-3M21 17l3-3a4 4 0 0 0-6-6l-3 3" fill="none" stroke="#2b7bd6" strokeWidth="2" /></svg>,
  note: <svg viewBox="0 0 32 32"><path d="M5 5h22v16H14l-6 6v-6H5z" fill="#fff4b3" stroke="#8a8a8a" /></svg>,
  freeze: <svg viewBox="0 0 32 32"><rect x="4" y="4" width="24" height="24" fill="#fff" stroke="#8a8a8a" /><rect x="4" y="4" width="24" height="7" fill="#c9daf8" /><rect x="4" y="4" width="8" height="24" fill="#c9daf8" /><path d="M4 11h24M12 4v24" stroke="#2b7bd6" strokeWidth="1.6" /></svg>,
  zoom: <svg viewBox="0 0 32 32"><circle cx="14" cy="14" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m20 20 7 7" stroke="currentColor" strokeWidth="3" /></svg>,
  grid: <svg viewBox="0 0 16 16"><path d="M1 5.5h14M1 10.5h14M5.5 1v14M10.5 1v14" stroke="currentColor" /></svg>,
  full: <svg viewBox="0 0 32 32"><path d="M5 12V5h7M27 12V5h-7M5 20v7h7M27 20v7h-7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>,
  keys: <svg viewBox="0 0 32 32"><rect x="3" y="8" width="26" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M7 13h2M12 13h2M17 13h2M22 13h3M8 19h16" stroke="currentColor" strokeWidth="1.6" /></svg>,
  text2col: <svg viewBox="0 0 32 32"><rect x="4" y="7" width="10" height="18" fill="#fff" stroke="#8a8a8a" /><rect x="18" y="7" width="10" height="18" fill="#fff" stroke="#8a8a8a" /><path d="M7 12h4M7 16h4M21 12h4M21 16h4" stroke="#2b7bd6" strokeWidth="1.5" /></svg>,
  valid: <svg viewBox="0 0 32 32"><rect x="4" y="6" width="24" height="20" fill="#fff" stroke="#8a8a8a" /><path d="m9 16 4 4 9-9" fill="none" stroke="#217346" strokeWidth="2.4" /></svg>,
  name: <svg viewBox="0 0 32 32"><rect x="3" y="9" width="26" height="14" rx="2" fill="#fff" stroke="#8a8a8a" /><text x="7" y="20" fontSize="9" fill="currentColor">abc</text></svg>,
  rows: <svg viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="22" fill="#fff" stroke="#8a8a8a" /><rect x="5" y="13" width="22" height="6" fill="#c9daf8" /><path d="M16 14v4m-2-2h4" stroke="#2b7bd6" strokeWidth="1.6" /></svg>,
  cols: <svg viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="22" fill="#fff" stroke="#8a8a8a" /><rect x="13" y="5" width="6" height="22" fill="#c9daf8" /><path d="M16 14v4m-2-2h4" stroke="#2b7bd6" strokeWidth="1.6" /></svg>,
  sheet: <svg viewBox="0 0 32 32"><path d="M7 4h13l6 6v18H7z" fill="#fff" stroke="#8a8a8a" /><path d="M11 14h11M11 18h11M11 22h11" stroke="#217346" /></svg>,
  dedupe: <svg viewBox="0 0 32 32"><rect x="4" y="5" width="24" height="22" fill="#fff" stroke="#8a8a8a" /><path d="M4 11h24M4 16.5h24M4 22h24" stroke="#bdbdbd" /><rect x="5" y="12" width="22" height="4" fill="#c9daf8" /><rect x="5" y="17.5" width="22" height="4" fill="#c9daf8" /><path d="m19 14 7 7m0-7-7 7" stroke="#d13438" strokeWidth="2" /></svg>,
  checkbox: <svg viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="22" rx="3" fill="#fff" stroke="#8a8a8a" strokeWidth="1.5" /><path d="m10 16 5 5 8-10" fill="none" stroke="#217346" strokeWidth="3" /></svg>,
  dropdown: <svg viewBox="0 0 32 32"><rect x="3" y="8" width="26" height="12" rx="2" fill="#fff" stroke="#8a8a8a" /><path d="M7 14h10" stroke="#8a8a8a" strokeWidth="2" /><path d="m21 12 3 3 3-3" fill="none" stroke="#2b7bd6" strokeWidth="2" /><path d="M7 24h18M7 28h12" stroke="#bdbdbd" strokeWidth="2" /></svg>,
  lock: <svg viewBox="0 0 32 32"><rect x="7" y="14" width="18" height="14" rx="2" fill="#f0b24a" stroke="#8a6d2b" /><path d="M11 14V9a5 5 0 0 1 10 0v5" fill="none" stroke="#6b6b6b" strokeWidth="2.4" /><circle cx="16" cy="21" r="2" fill="#6b4f10" /></svg>,
};

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open, close]);
  return ref;
}

/** Giữ focus ở lưới/ô đang sửa khi bấm nút ribbon — như Excel. */
const keep = (e: React.MouseEvent) => e.preventDefault();

interface MenuItem { label: string; icon?: ReactNode; run?: () => void; disabled?: boolean; title?: string; sep?: boolean }

/** Nút có menu thả xuống (Insert ▾, Borders ▾, Sort & Filter ▾…). */
function Drop({ big, icon, label, items, disabled, title, split }: {
  big?: boolean; icon?: ReactNode; label?: string; items: MenuItem[]; disabled?: boolean; title?: string;
  /** Nút tách đôi: phần chính chạy lệnh này, ▾ mở menu (như Borders, AutoSum của Excel). */
  split?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutside(open, close);
  const main = (
    <button type="button" className={`xl-btn${big ? ' big' : ''}${open && !split ? ' on' : ''}`} disabled={disabled}
      onMouseDown={keep} onClick={() => (split ? split() : setOpen((o) => !o))} title={title ?? label}>
      {icon && <span className="xl-ico">{icon}</span>}
      {label && <span className="xl-lbl">{label}{!split && <span className="xl-caret">⌄</span>}</span>}
      {!label && !split && <span className="xl-caret">⌄</span>}
    </button>
  );
  return (
    <div className={`xl-drop${split ? ' split' : ''}`} ref={ref}>
      {main}
      {split && (
        <button type="button" className={`xl-btn xl-dd${open ? ' on' : ''}`} disabled={disabled} onMouseDown={keep}
          onClick={() => setOpen((o) => !o)} title={`${title ?? label ?? ''} options`}>⌄</button>
      )}
      {open && (
        <div className="xl-menu" role="menu">
          {items.map((it, i) => (it.sep
            ? <div key={i} className="xl-menu-sep" />
            : (
              <button key={i} type="button" role="menuitem" disabled={it.disabled || !it.run} title={it.title}
                onMouseDown={keep} onClick={() => { setOpen(false); it.run?.(); }}>
                <span className="xl-menu-ico">{it.icon}</span>{it.label}
              </button>
            )))}
        </div>
      )}
    </div>
  );
}

function Btn({ icon, label, big, on, disabled, title, run }: {
  icon?: ReactNode; label?: string; big?: boolean; on?: boolean; disabled?: boolean; title?: string; run?: () => void;
}) {
  return (
    <button type="button" className={`xl-btn${big ? ' big' : ''}${on ? ' on' : ''}`} disabled={disabled || !run}
      onMouseDown={keep} onClick={run} title={title ?? label} aria-pressed={on}>
      {icon && <span className="xl-ico">{icon}</span>}
      {label && <span className="xl-lbl">{label}</span>}
    </button>
  );
}

/** Hộp thoại nhỏ kiểu Excel (Go To, Remove Duplicates…) neo dưới ribbon — in-app, không dùng prompt/confirm native. */
function Dialog({ title, onClose, children, foot, width }: {
  title: string; onClose: () => void; children: ReactNode; foot: ReactNode; width?: number;
}) {
  const ref = useOutside(true, onClose);
  return (
    <div className="xl-dialog" ref={ref} role="dialog" aria-label={title} style={width ? { width } : undefined}>
      <div className="xl-dialog-title">{title}<button type="button" onClick={onClose} title="Close (Esc)">✕</button></div>
      <div className="xl-dialog-body">{children}</div>
      <div className="xl-dialog-foot">{foot}</div>
    </div>
  );
}

/** Nút kiểu ô trong gallery Styles — xem trước đúng màu/viền của kiểu. */
function StyleBtn({ s, onPick, disabled }: { s: StyleDef; onPick: (s: StyleDef) => void; disabled?: boolean }) {
  const bottom = s.border?.find((b) => b.type === 'bottom' || b.type === 'all');
  const top = s.border?.find((b) => b.type === 'top' || b.type === 'all');
  const side = s.border?.find((b) => b.type === 'all');
  const line = (b?: NonNullable<StyleDef['border']>[number]) =>
    b ? `${b.style === 7 ? '3px double' : b.style === 13 ? '3px solid' : b.style === 8 ? '2px solid' : '1px solid'} ${b.color}` : undefined;
  return (
    <button type="button" className="xl-style" disabled={disabled} onMouseDown={keep} onClick={() => onPick(s)}
      title={s.label === 'Normal' ? 'Normal — clear formatting' : `${s.label} cell style`}
      style={{
        background: s.bg ?? '#fff', color: s.fc ?? '#000', fontWeight: s.bold ? 700 : 400, fontStyle: s.italic ? 'italic' : undefined,
        fontSize: s.fs ? Math.min(14, s.fs) : undefined, fontFamily: s.ff,
        borderBottom: line(bottom), borderTop: line(top), borderLeft: line(side), borderRight: line(side),
      }}>{s.label}</button>
  );
}

/** Tách fragment `<>…</>` của một tab thành danh sách nhóm (key tự sinh theo thứ tự, ổn định vì bố cục mỗi tab cố định). */
const toItems = (node: ReactNode): ReactNode[] =>
  Children.toArray(isValidElement(node) && node.type === Fragment ? (node.props as { children?: ReactNode }).children : node);

const MORE_W = 40;      // nút "…"
const COLLAPSE_W = 30;  // nút ⌃ thu ribbon

/** Ribbon MỘT dòng như Excel: đo chiều rộng thật của từng nhóm, nhóm nào không
 *  đủ chỗ thì giấu vào nút "…" ở cuối (bấm ra menu xếp dọc các nhóm đó). Chiều
 *  rộng từng nhóm nhớ theo tab; nhóm chưa đo thì hiện hết một lượt để đo rồi cắt
 *  (chạy trong layout effect nên không nháy). */
function Ribbon({ label, items, onCollapse }: { label: string; items: ReactNode[]; onCollapse: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cache = useRef<Record<string, number[]>>({});
  const [cut, setCut] = useState(items.length);
  const [, bump] = useState(0);
  const [more, setMore] = useState(false);
  const closeMore = useCallback(() => setMore(false), []);
  const moreRef = useOutside(more, closeMore);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bump((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const widths = (cache.current[label] ??= []);
    itemRefs.current.forEach((n, i) => { if (n) widths[i] = n.offsetWidth; });
    const fit = (avail: number) => {
      let total = 0;
      for (let i = 0; i < items.length; i++) {
        if (widths[i] == null) return items.length; // chưa đo → hiện hết để đo
        total += widths[i];
        if (total > avail) return i;
      }
      return items.length;
    };
    const avail = el.clientWidth - COLLAPSE_W;
    let next = fit(avail);
    if (next < items.length) next = fit(avail - MORE_W);
    if (next !== cut) setCut(next);
  });

  itemRefs.current = [];
  return (
    <div className="xl-ribbon" role="toolbar" aria-label={`${label} ribbon`} ref={ref}>
      {items.slice(0, cut).map((it, i) => (
        <div key={i} className="xl-item" ref={(n) => { itemRefs.current[i] = n; }}>{it}</div>
      ))}
      {cut < items.length && (
        <div className="xl-drop xl-more-wrap" ref={moreRef}>
          <button type="button" className={`xl-btn xl-more${more ? ' on' : ''}`} onMouseDown={keep} onClick={() => setMore((o) => !o)}
            title="More commands">…</button>
          {more && <div className="xl-menu xl-more-menu" role="menu">{items.slice(cut)}</div>}
        </div>
      )}
      <span style={{ flex: 1 }} />
      <button type="button" className="xl-collapse" onClick={onCollapse} title="Collapse the Ribbon (Ctrl+F1)">⌃</button>
    </div>
  );
}

function Group({ label, children, launcher }: { label: string; children: ReactNode; launcher?: () => void }) {
  return (
    <div className="xl-group">
      <div className="xl-group-body">{children}</div>
      <div className="xl-group-label">
        {label}
        {launcher && <button type="button" className="xl-launch" onMouseDown={keep} onClick={launcher} title={`${label} settings`}>↘</button>}
      </div>
    </div>
  );
}

export default function ExcelRibbon({
  api, fileName, kind, dirty, saving, canSave, saveTitle, info,
  onSave, onExit, onOpenExternal, onOpenFile, onReload,
}: {
  api: Api | null;
  fileName: string;
  kind: 'xlsx' | 'csv';
  dirty: number;
  saving: boolean;
  canSave: boolean;
  saveTitle: string;
  /** Ghi chú hiện trong trang File (lưu được gì, dung lượng…). */
  info: ReactNode;
  onSave: () => void;
  onExit: () => void;
  onOpenExternal: () => void;
  onOpenFile: () => void;
  onReload: () => void;
}) {
  const [tab, setTab] = useState<Tab>('Home');
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1'); } catch { /* bỏ qua */ } }, []);
  const toggleCollapsed = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* bỏ qua */ }
    return !c;
  });

  // Ctrl+S = Save như Excel (bắt ở capture để Univer/trình duyệt không nuốt mất).
  // Chỉ khi tab Excel đang HIỆN: các tab khác của app vẫn mount ngầm, Ctrl+S ở đó không được lưu sheet.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const saveRef = useRef({ onSave, canSave });
  saveRef.current = { onSave, canSave };
  // Các phím tắt khác của Excel (gán ở dưới, sau khi có hàm): Ctrl+F1 thu ribbon,
  // Alt+= AutoSum, Shift+F3 Insert Function, Ctrl+G Go To.
  const keysRef = useRef<Record<string, () => void>>({});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shellRef.current || shellRef.current.offsetParent === null) return;
      const ctrl = e.ctrlKey || e.metaKey;
      let act: string | null = null;
      if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') act = 'save';
      else if (ctrl && !e.shiftKey && !e.altKey && e.key === 'F1') act = 'collapse';
      else if (e.altKey && !ctrl && !e.shiftKey && e.key === '=') act = 'autosum';
      else if (e.shiftKey && !ctrl && !e.altKey && e.key === 'F3') act = 'fx';
      else if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') act = 'goto';
      if (!act) return;
      // Đang gõ trong ô nhập của chính ribbon/hộp thoại (không phải lưới) thì để yên.
      const t = e.target as HTMLElement | null;
      if (act !== 'save' && t?.closest?.('.xl-shell') && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      e.preventDefault();
      e.stopPropagation();
      if (act === 'save') { if (saveRef.current.canSave) saveRef.current.onSave(); return; }
      keysRef.current[act]?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /* ── Trạng thái ô đang chọn ── */
  const [cell, setCell] = useState<CellState>({ label: 'A1' });
  useEffect(() => {
    const wb = api?.getActiveWorkbook();
    if (!api || !wb) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const r = wb.getActiveRange();
      if (!r) return;
      const s = (r.getCellStyleData() ?? {}) as {
        ff?: string; fs?: number; bl?: number; it?: number; ul?: { s?: number }; st?: { s?: number };
        ht?: number; vt?: number; tb?: number; cl?: { rgb?: string }; bg?: { rgb?: string }; n?: { pattern?: string };
      };
      const h = r.getHeight(); const w = r.getWidth();
      setCell({
        ff: s.ff, fs: s.fs, bl: s.bl === 1, it: s.it === 1, ul: s.ul?.s === 1, st: s.st?.s === 1,
        ht: s.ht, vt: s.vt, wrap: s.tb === WRAP, fc: s.cl?.rgb ?? undefined, bg: s.bg?.rgb ?? undefined,
        pattern: s.n?.pattern ?? '', merged: r.isMerged(),
        label: h === 1 && w === 1 ? a1(r.getRow(), r.getColumn()) : `${a1(r.getRow(), r.getColumn())}:${a1(r.getRow() + h - 1, r.getColumn() + w - 1)}`,
      });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(read); };
    read();
    const d1 = wb.onSelectionChange(schedule);
    const d2 = wb.onCommandExecuted(schedule);
    return () => { d1.dispose(); d2.dispose(); if (raf) cancelAnimationFrame(raf); };
  }, [api]);

  /* ── Gọi lệnh ── */
  const run = useCallback((id: string, params?: object) => { void api?.executeCommand(id, params); }, [api]);
  const range = useCallback(() => api?.getActiveWorkbook()?.getActiveRange() ?? null, [api]);
  const sheet = useCallback(() => api?.getActiveWorkbook()?.getActiveSheet() ?? null, [api]);
  const off = !api;

  // Kéo trong bộ chọn điểm màu bắn liên tục — gộp lại, mỗi lần ngơi tay một lệnh.
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickColor = (id: string, c: string, live?: boolean) => {
    if (colorTimer.current) clearTimeout(colorTimer.current);
    if (!live) { run(id, { value: c }); return; }
    colorTimer.current = setTimeout(() => run(id, { value: c }), 150);
  };

  const setNumFmt = (pattern: string) => { range()?.setNumberFormat(pattern); };
  const applyCellStyle = (s: typeof CELL_STYLES[number]) => {
    const r = range();
    if (!r) return;
    if (!s.bg) { run('sheet.command.clear-selection-format'); return; }
    r.setBackgroundColor(s.bg);
    r.setFontColor(s.fc);
  };
  const border = (type: string, style = BORDER_THIN, color = '#000000') => run('sheet.command.set-border-basic', { value: { type, style, color } });

  /** AutoSum như Excel: chọn vùng → công thức ngay dưới mỗi cột; một ô → gộp
   *  dãy số liền phía trên (không có thì bên trái) vào công thức tại ô đó. */
  const autoSum = (fn: string) => {
    const r = range(); const ws = sheet();
    if (!r || !ws) return;
    const row = r.getRow(), col = r.getColumn(), h = r.getHeight(), w = r.getWidth();
    const isNum = (rr: number, cc: number) => typeof ws.getRange(rr, cc).getValue() === 'number';
    if (h > 1 || w > 1) {
      for (let c = col; c < col + w; c++) ws.getRange(row + h, c).setFormula(`=${fn}(${a1(row, c)}:${a1(row + h - 1, c)})`);
      return;
    }
    let top = row - 1;
    while (top >= 0 && isNum(top, col)) top--;
    if (top < row - 1) { r.setFormula(`=${fn}(${a1(top + 1, col)}:${a1(row - 1, col)})`); return; }
    let left = col - 1;
    while (left >= 0 && isNum(row, left)) left--;
    r.setFormula(left < col - 1 ? `=${fn}(${a1(row, left + 1)}:${a1(row, col - 1)})` : `=${fn}()`);
  };

  const zoomBy = (d: number) => {
    const ws = sheet() as unknown as { getZoom?: () => number; zoom?: (z: number) => void } | null;
    if (!ws?.zoom) return;
    const z = d === 0 ? 1 : Math.min(4, Math.max(0.1, Math.round(((ws.getZoom?.() ?? 1) + d) * 10) / 10));
    ws.zoom(z);
  };

  /** Gallery Cell Styles: Normal = xoá định dạng; kiểu Number Format chỉ đổi định dạng số; còn lại thay cả bộ. */
  const applyStyleDef = (d: StyleDef) => {
    const r = range();
    if (!r) return;
    if (d.numfmt) { r.setNumberFormat(d.numfmt); return; }
    run('sheet.command.clear-selection-format');
    if (d.bg) r.setBackgroundColor(d.bg);
    if (d.fc) r.setFontColor(d.fc);
    if (d.bold) r.setFontWeight('bold');
    if (d.italic) r.setFontStyle('italic');
    if (d.fs) r.setFontSize(d.fs);
    if (d.ff) r.setFontFamily(d.ff);
    d.border?.forEach((b) => border(b.type, b.style, b.color));
  };
  const [galOpen, setGalOpen] = useState(false);
  const closeGal = useCallback(() => setGalOpen(false), []);
  const galRef = useOutside(galOpen, closeGal);

  /* ── Hộp thoại Go To / Go To Special / Remove Duplicates ── */
  const [dlg, setDlg] = useState<DialogKind | null>(null);
  const [dlgMsg, setDlgMsg] = useState('');
  const [gotoRef, setGotoRef] = useState('');
  const [gotoHist, setGotoHist] = useState<string[]>([]);
  const [special, setSpecial] = useState<SpecialKind>('constants');
  const [ddRect, setDdRect] = useState<Rect | null>(null);
  const [ddHeader, setDdHeader] = useState(true);
  const [ddCols, setDdCols] = useState<boolean[]>([]);
  const [ddNames, setDdNames] = useState<string[]>([]);
  const [ddDone, setDdDone] = useState(false);
  const closeDlg = useCallback(() => { setDlg(null); setDlgMsg(''); }, []);

  /** Ô quanh ô (row, col) không bị ngăn bởi dòng/cột trống — "current region" của Excel (Ctrl+A / Ctrl+*). */
  const currentRegion = (row: number, col: number): Rect => {
    const ws = sheet();
    const one = { startRow: row, startColumn: col, endRow: row, endColumn: col };
    if (!ws) return one;
    const dr = ws.getDataRange().getRange() as Rect;
    if (row < dr.startRow || row > dr.endRow || col < dr.startColumn || col > dr.endColumn) return one;
    if ((dr.endRow - dr.startRow + 1) * (dr.endColumn - dr.startColumn + 1) > MAX_SCAN_CELLS) return one;
    const cells = ws.getRange(dr).getCellDatas() as (UCell | null)[][];
    const blank = (r: number, c: number) => isBlankCell(cells[r - dr.startRow]?.[c - dr.startColumn]);
    const rowHas = (r: number, c0: number, c1: number) => { for (let c = Math.max(c0, dr.startColumn); c <= Math.min(c1, dr.endColumn); c++) if (!blank(r, c)) return true; return false; };
    const colHas = (c: number, r0: number, r1: number) => { for (let r = Math.max(r0, dr.startRow); r <= Math.min(r1, dr.endRow); r++) if (!blank(r, c)) return true; return false; };
    let top = row, bottom = row, left = col, right = col;
    for (;;) {
      let grew = false;
      if (top > dr.startRow && rowHas(top - 1, left - 1, right + 1)) { top--; grew = true; }
      if (bottom < dr.endRow && rowHas(bottom + 1, left - 1, right + 1)) { bottom++; grew = true; }
      if (left > dr.startColumn && colHas(left - 1, top - 1, bottom + 1)) { left--; grew = true; }
      if (right < dr.endColumn && colHas(right + 1, top - 1, bottom + 1)) { right++; grew = true; }
      if (!grew) break;
    }
    return { startRow: top, startColumn: left, endRow: bottom, endColumn: right };
  };

  /** Chọn nhiều vùng một lúc (kết quả Go To Special) rồi cuộn tới vùng đầu. */
  const selectRects = (rects: Rect[]) => {
    const wb = api?.getActiveWorkbook(); const ws = sheet();
    if (!wb || !ws || !rects.length) return;
    const p = rects[0];
    run('sheet.operation.set-selections', {
      unitId: wb.getId(), subUnitId: ws.getSheetId(),
      selections: rects.map((r, i) => ({
        range: { ...r, rangeType: 0 },
        primary: i === 0 ? { ...p, endRow: p.startRow, endColumn: p.startColumn, actualRow: p.startRow, actualColumn: p.startColumn, isMerged: false, isMergedMainCell: false } : null,
        style: null,
      })),
    });
    run('sheet.command.scroll-to-cell', { range: { ...p, rangeType: 0 } });
  };

  /** Go To: A1, B2:D9, A:A, 3:3, Sheet2!C4 — trả về thông báo lỗi nếu không hiểu. */
  const goTo = (text: string): string | null => {
    const wb = api?.getActiveWorkbook();
    if (!wb) return null;
    let ws = wb.getActiveSheet();
    let ref = text.trim().replace(/\$/g, '');
    const bang = ref.lastIndexOf('!');
    if (bang > 0) {
      const name = ref.slice(0, bang).replace(/^'(.*)'$/, '$1');
      const s = wb.getSheetByName(name);
      if (!s) return `Sheet "${name}" was not found.`;
      ws = s; ref = ref.slice(bang + 1);
    }
    ref = ref.toUpperCase();
    if (!/^([A-Z]{1,3}\d{1,7}(:[A-Z]{1,3}\d{1,7})?|[A-Z]{1,3}:[A-Z]{1,3}|\d{1,7}:\d{1,7})$/.test(ref)) return 'Reference is not valid.';
    try {
      ws.activate();
      const r = ws.getRange(ref);
      r.activate();
      run('sheet.command.scroll-to-cell', { range: r.getRange() });
    } catch { return 'Reference is not valid.'; }
    setGotoHist((h) => [text.trim(), ...h.filter((x) => x !== text.trim())].slice(0, 8));
    return null;
  };

  const goToSpecial = (kind: SpecialKind): string | null => {
    const ws = sheet(); const r = range();
    if (!ws || !r) return null;
    if (kind === 'last') { const dr = ws.getDataRange().getRange(); ws.getRange(dr.endRow, dr.endColumn).activate(); run('sheet.command.scroll-to-cell', { range: { startRow: dr.endRow, endRow: dr.endRow, startColumn: dr.endColumn, endColumn: dr.endColumn } }); return null; }
    if (kind === 'region') { selectRects([currentRegion(r.getRow(), r.getColumn())]); return null; }
    // Phạm vi quét: vùng đang chọn (nếu >1 ô), không thì cả phần có dữ liệu của sheet.
    const rect: Rect = r.getHeight() * r.getWidth() > 1 ? (r.getRange() as Rect) : (ws.getDataRange().getRange() as Rect);
    const h = rect.endRow - rect.startRow + 1, w = rect.endColumn - rect.startColumn + 1;
    if (h * w > MAX_SCAN_CELLS) return `The area is too large (${(h * w).toLocaleString('en')} cells). Select a smaller range first.`;
    const cells = ws.getRange(rect).getCellDatas() as (UCell | null)[][];
    const match = (c: UCell | null | undefined) => {
      const blank = isBlankCell(c);
      if (kind === 'blanks') return blank;
      const formula = !!(c?.f || c?.si);
      return kind === 'formulas' ? formula : !blank && !formula;
    };
    const rects: Rect[] = []; let count = 0;
    for (let c = 0; c < w; c++) {
      let runStart = -1;
      for (let rr = 0; rr <= h; rr++) {
        const ok = rr < h && match(cells[rr]?.[c]);
        if (ok) { count++; if (runStart < 0) runStart = rr; }
        else if (runStart >= 0) {
          rects.push({ startRow: rect.startRow + runStart, endRow: rect.startRow + rr - 1, startColumn: rect.startColumn + c, endColumn: rect.startColumn + c });
          runStart = -1;
          if (rects.length > MAX_SELECT_RANGES) return 'Too many matching cells to select at once. Select a smaller range first.';
        }
      }
    }
    if (!count) return 'No cells were found.';
    selectRects(rects);
    return null;
  };

  const openDialog = (k: DialogKind) => {
    setDlgMsg('');
    if (k === 'dedupe') {
      const r = range(); const ws = sheet();
      if (!r || !ws) return;
      const rect = r.getHeight() * r.getWidth() > 1 ? (r.getRange() as Rect) : currentRegion(r.getRow(), r.getColumn());
      const w = rect.endColumn - rect.startColumn + 1;
      const head = ws.getRange(rect.startRow, rect.startColumn, 1, w).getValues() as unknown[][];
      const hasHeader = (head[0] ?? []).every((v) => typeof v === 'string' && v !== '');
      setDdRect(rect); setDdHeader(hasHeader); setDdCols(Array(w).fill(true));
      setDdNames((head[0] ?? []).map((v) => (v == null || v === '' ? '' : String(v))));
      setDdDone(false);
    }
    setDlg(k);
  };
  const ddLabel = (i: number) => (ddHeader && ddNames[i] ? ddNames[i] : `Column ${colName((ddRect?.startColumn ?? 0) + i)}`);

  /** Remove Duplicates như Excel: so các cột đã tick (không phân biệt hoa/thường), bỏ dòng trùng, dồn lên. */
  const removeDuplicates = () => {
    const ws = sheet();
    if (!ws || !ddRect) return;
    const { startRow: r0, startColumn: c0 } = ddRect;
    const h = ddRect.endRow - r0 + 1, w = ddRect.endColumn - c0 + 1;
    if (h * w > MAX_SCAN_CELLS) { setDlgMsg(`The range is too large (${(h * w).toLocaleString('en')} cells). Select a smaller range first.`); return; }
    const cols = ddCols.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    if (!cols.length) { setDlgMsg('Select at least one column.'); return; }
    const rng = ws.getRange(r0, c0, h, w);
    const data = rng.getCellDatas() as (UCell | null)[][];
    const key = (c: UCell | null | undefined) => {
      if (!c) return '';
      const v = c.p?.body?.dataStream ?? c.v;
      return v == null ? '' : String(v).replace(/\r\n$/, '').trim().toLowerCase();
    };
    const seen = new Set<string>(); const keep: (UCell | null)[][] = []; let removed = 0;
    for (let i = ddHeader ? 1 : 0; i < h; i++) {
      const row = data[i] ?? [];
      const k = cols.map((c) => key(row[c])).join('\u0001');
      if (seen.has(k)) removed++; else { seen.add(k); keep.push(row); }
    }
    if (!removed) { setDlgMsg('No duplicate values found.'); setDdDone(true); return; }
    const out = (ddHeader ? [data[0] ?? []] : []).concat(keep)
      .map((row) => Array.from({ length: w }, (_, c) => row[c] ?? null));
    rng.clear();
    ws.getRange(r0, c0, out.length, w).setValues(out as never);
    setDlgMsg(`${removed} duplicate value${removed > 1 ? 's' : ''} found and removed; ${keep.length} unique value${keep.length > 1 ? 's' : ''} remain.`);
    setDdDone(true);
  };

  keysRef.current = {
    collapse: toggleCollapsed,
    autosum: () => autoSum('SUM'),
    fx: () => run('formula-ui.operation.more-functions'),
    goto: () => openDialog('goto'),
  };

  const fmtLabel = NUM_FORMATS.find((f) => f.pattern === (cell.pattern ?? ''))?.label ?? (cell.pattern ? 'Custom' : 'General');

  /* ── Các nhóm dùng lại giữa các tab ── */
  const sortItems: MenuItem[] = [
    { label: 'Sort A to Z', icon: '↑', run: () => run('sheet.command.sort-range-asc') },
    { label: 'Sort Z to A', icon: '↓', run: () => run('sheet.command.sort-range-desc') },
    { label: 'Custom Sort…', run: () => run('sheet.command.sort-range-custom') },
    { sep: true, label: '' },
    { label: 'Filter', icon: '⏷', run: () => run('sheet.command.smart-toggle-filter') },
    { label: 'Clear', run: () => run('sheet.command.clear-filter-criteria') },
    { label: 'Reapply', run: () => run('sheet.command.re-calc-filter') },
  ];
  const autoSumItems: MenuItem[] = ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].map((fn) => ({
    label: fn === 'SUM' ? 'Sum' : fn === 'AVERAGE' ? 'Average' : fn === 'COUNT' ? 'Count Numbers' : fn === 'MAX' ? 'Max' : 'Min',
    run: () => autoSum(fn),
  })).concat([{ label: 'More Functions…', run: () => run('formula-ui.operation.more-functions') }]);
  const freezeItems: MenuItem[] = [
    { label: 'Freeze Panes', title: 'Keep rows above and columns left of the selection visible', run: () => run('sheet.command.set-selection-frozen') },
    { label: 'Freeze Top Row', run: () => run('sheet.command.set-first-row-frozen') },
    { label: 'Freeze First Column', run: () => run('sheet.command.set-first-column-frozen') },
    { label: 'Unfreeze Panes', run: () => run('sheet.command.cancel-frozen') },
  ];

  /* ── "Tell me what you want to do" — tìm lệnh theo tên ── */
  const [q, setQ] = useState('');
  const [qOpen, setQOpen] = useState(false);
  const closeQ = useCallback(() => setQOpen(false), []);
  const qRef = useOutside(qOpen, closeQ);
  const commands = useMemo<MenuItem[]>(() => [
    { label: 'Save', run: onSave },
    { label: 'Undo', run: () => run('univer.command.undo') },
    { label: 'Redo', run: () => run('univer.command.redo') },
    { label: 'Bold', run: () => run('sheet.command.set-range-bold') },
    { label: 'Italic', run: () => run('sheet.command.set-range-italic') },
    { label: 'Underline', run: () => run('sheet.command.set-range-underline') },
    { label: 'Wrap Text', run: () => run('sheet.command.set-text-wrap', { value: WRAP }) },
    { label: 'Merge & Center', run: () => { run('sheet.command.add-worksheet-merge-all'); run('sheet.command.set-horizontal-text-align', { value: H_ALIGN.center }); } },
    { label: 'Unmerge Cells', run: () => run('sheet.command.remove-worksheet-merge') },
    { label: 'Insert Sheet Rows', run: () => run('sheet.command.insert-row-before') },
    { label: 'Insert Sheet Columns', run: () => run('sheet.command.insert-col-before') },
    { label: 'Delete Sheet Rows', run: () => run('sheet.command.remove-row-confirm') },
    { label: 'Delete Sheet Columns', run: () => run('sheet.command.remove-col-confirm') },
    { label: 'Insert Sheet', run: () => run('sheet.command.insert-sheet') },
    { label: 'Clear All', run: () => run('sheet.command.clear-selection-all') },
    { label: 'Clear Formats', run: () => run('sheet.command.clear-selection-format') },
    { label: 'Clear Contents', run: () => run('sheet.command.clear-selection-content') },
    { label: 'Find', run: () => run('ui.operation.open-find-dialog') },
    { label: 'Replace', run: () => run('ui.operation.open-replace-dialog') },
    { label: 'Conditional Formatting', run: () => run('sheet.operation.open.conditional.formatting.panel') },
    { label: 'Data Validation', run: () => run('data-validation.operation.open-validation-panel') },
    { label: 'Insert Function', run: () => run('formula-ui.operation.more-functions') },
    { label: 'Insert Link', run: () => run('sheet.operation.insert-hyper-link-toolbar') },
    { label: 'New Note', run: () => run('sheet.operation.add-note-popup') },
    { label: 'Text to Columns', run: () => run('sheet.command.split-text-to-columns') },
    { label: 'Gridlines', run: () => run('sheet.command.toggle-gridlines') },
    { label: 'Full Screen', run: () => run('base-ui.operation.toggle-fullscreen') },
    { label: 'Keyboard Shortcuts', run: () => run('base-ui.operation.toggle-shortcut-panel') },
    { label: 'Go To', run: () => openDialog('goto') },
    { label: 'Go To Special', run: () => openDialog('special') },
    { label: 'Remove Duplicates', run: () => openDialog('dedupe') },
    { label: 'Checkbox', run: () => run('data-validation.command.insert-quick-rule', { rule: { type: 'checkbox' } }) },
    { label: 'Dropdown List', run: () => run('data-validation.command.addRuleAndOpen', { rule: { type: 'list', formula1: 'Option 1,Option 2,Option 3' } }) },
    { label: 'Protect Range', run: () => run('sheet.command.add-range-protection-from-toolbar') },
    ...STYLE_GALLERY.flatMap((s) => s.items).map((s) => ({ label: `Cell Style: ${s.label}`, run: () => applyStyleDef(s) })),
    ...sortItems.filter((x) => !x.sep),
    ...autoSumItems.map((x) => ({ ...x, label: `AutoSum: ${x.label}` })),
    ...freezeItems,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [run, onSave, api]);
  const hits = q.trim() ? commands.filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];

  /* ── Nội dung từng tab ── */
  const home = (
    <>
      <Group label="Clipboard">
        <Drop big icon={I.paste} label="Paste" disabled={off} split={() => run('univer.command.paste')} title="Paste (Ctrl+V)"
          items={[
            { label: 'Paste', run: () => run('univer.command.paste') },
            { label: 'Paste Values', run: () => run('sheet.command.paste-value') },
            { label: 'Paste Formatting', run: () => run('sheet.command.paste-format') },
            { label: 'Paste Formulas', run: () => run('sheet.command.paste-formula') },
            { label: 'Keep Column Widths', run: () => run('sheet.command.paste-col-width') },
          ]} />
        <div className="xl-col">
          <Btn icon={I.cut} label="Cut" disabled={off} run={() => run('univer.command.cut')} title="Cut (Ctrl+X)" />
          <Btn icon={I.copy} label="Copy" disabled={off} run={() => run('univer.command.copy')} title="Copy (Ctrl+C)" />
          <Btn icon={I.painter} label="Format Painter" disabled={off} run={() => run('sheet.command.set-once-format-painter')}
            title="Format Painter — copy formatting from the selection to the next cells you click" />
        </div>
      </Group>

      <Group label="Font">
        <div className="xl-rows">
          <div className="xl-row">
            <select className="xl-select font" disabled={off} value={cell.ff ?? 'Arial'} title="Font"
              onChange={(e) => run('sheet.command.set-range-font-family', { value: e.target.value })}>
              {[...new Set([cell.ff ?? 'Arial', ...FONTS])].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select className="xl-select size" disabled={off} value={String(cell.fs ?? 11)} title="Font Size"
              onChange={(e) => run('sheet.command.set-range-fontsize', { value: Number(e.target.value) })}>
              {[...new Set([cell.fs ?? 11, ...SIZES])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <Btn icon={I.grow} disabled={off} title="Increase Font Size" run={() => run('sheet.command.set-range-font-increase')} />
            <Btn icon={I.shrink} disabled={off} title="Decrease Font Size" run={() => run('sheet.command.set-range-font-decrease')} />
          </div>
          <div className="xl-row">
            <Btn label="B" on={cell.bl} disabled={off} title="Bold (Ctrl+B)" run={() => run('sheet.command.set-range-bold')} />
            <Btn label="I" on={cell.it} disabled={off} title="Italic (Ctrl+I)" run={() => run('sheet.command.set-range-italic')} />
            <Btn label="U" on={cell.ul} disabled={off} title="Underline (Ctrl+U)" run={() => run('sheet.command.set-range-underline')} />
            <Btn label="S" on={cell.st} disabled={off} title="Strikethrough" run={() => run('sheet.command.set-range-stroke')} />
            <span className="xl-vsep" />
            <Drop icon={I.border} disabled={off} title="Borders" split={() => border('bottom')}
              items={[
                { label: 'Bottom Border', run: () => border('bottom') },
                { label: 'Top Border', run: () => border('top') },
                { label: 'Left Border', run: () => border('left') },
                { label: 'Right Border', run: () => border('right') },
                { sep: true, label: '' },
                { label: 'No Border', run: () => border('none') },
                { label: 'All Borders', run: () => border('all') },
                { label: 'Outside Borders', run: () => border('outside') },
                { label: 'Inside Borders', run: () => border('inside') },
                { label: 'Thick Outside Borders', run: () => border('outside', BORDER_THICK) },
              ]} />
            <ColorPicker kind="bg" current={cell.bg} disabled={off} rangeLabel={cell.label}
              onPick={(c, live) => pickColor('sheet.command.set-background-color', c, live)}
              onClear={() => run('sheet.command.reset-background-color')} />
            <ColorPicker kind="fc" current={cell.fc} disabled={off} rangeLabel={cell.label}
              onPick={(c, live) => pickColor('sheet.command.set-range-text-color', c, live)}
              onClear={() => run('sheet.command.reset-range-text-color')} />
          </div>
        </div>
      </Group>

      <Group label="Alignment">
        <div className="xl-rows">
          <div className="xl-row">
            <Btn icon={I.aTop} on={cell.vt === V_ALIGN.top} disabled={off} title="Top Align" run={() => run('sheet.command.set-vertical-text-align', { value: V_ALIGN.top })} />
            <Btn icon={I.aMid} on={cell.vt === V_ALIGN.middle} disabled={off} title="Middle Align" run={() => run('sheet.command.set-vertical-text-align', { value: V_ALIGN.middle })} />
            <Btn icon={I.aBot} on={cell.vt === V_ALIGN.bottom} disabled={off} title="Bottom Align" run={() => run('sheet.command.set-vertical-text-align', { value: V_ALIGN.bottom })} />
            <Drop icon={I.orient} disabled={off} title="Orientation"
              items={[
                { label: 'Angle Counterclockwise', run: () => run('sheet.command.set-text-rotation', { value: 45 }) },
                { label: 'Angle Clockwise', run: () => run('sheet.command.set-text-rotation', { value: -45 }) },
                { label: 'Vertical Text', run: () => run('sheet.command.set-text-rotation', { value: 'v' }) },
                { label: 'Rotate Text Up', run: () => run('sheet.command.set-text-rotation', { value: 90 }) },
                { label: 'Rotate Text Down', run: () => run('sheet.command.set-text-rotation', { value: -90 }) },
                { label: 'Reset Orientation', run: () => run('sheet.command.set-text-rotation', { value: 0 }) },
              ]} />
            <Btn icon={I.wrap} label="Wrap Text" on={cell.wrap} disabled={off} title="Wrap Text"
              run={() => run('sheet.command.set-text-wrap', { value: cell.wrap ? 1 : WRAP })} />
          </div>
          <div className="xl-row">
            <Btn icon={I.aLeft} on={cell.ht === H_ALIGN.left} disabled={off} title="Align Left" run={() => run('sheet.command.set-horizontal-text-align', { value: H_ALIGN.left })} />
            <Btn icon={I.aCenter} on={cell.ht === H_ALIGN.center} disabled={off} title="Center" run={() => run('sheet.command.set-horizontal-text-align', { value: H_ALIGN.center })} />
            <Btn icon={I.aRight} on={cell.ht === H_ALIGN.right} disabled={off} title="Align Right" run={() => run('sheet.command.set-horizontal-text-align', { value: H_ALIGN.right })} />
            <Btn icon={I.indL} disabled title={`Decrease Indent — ${NA}`} />
            <Btn icon={I.indR} disabled title={`Increase Indent — ${NA}`} />
            <Drop icon={I.merge} label="Merge & Center" disabled={off} title="Merge & Center"
              split={() => {
                if (cell.merged) { run('sheet.command.remove-worksheet-merge'); return; }
                run('sheet.command.add-worksheet-merge-all');
                run('sheet.command.set-horizontal-text-align', { value: H_ALIGN.center });
              }}
              items={[
                { label: 'Merge & Center', run: () => { run('sheet.command.add-worksheet-merge-all'); run('sheet.command.set-horizontal-text-align', { value: H_ALIGN.center }); } },
                { label: 'Merge Across', run: () => run('sheet.command.add-worksheet-merge-horizontal') },
                { label: 'Merge Cells', run: () => run('sheet.command.add-worksheet-merge-all') },
                { label: 'Unmerge Cells', run: () => run('sheet.command.remove-worksheet-merge') },
              ]} />
          </div>
        </div>
      </Group>

      <Group label="Number" launcher={off ? undefined : () => run('sheet.operation.open.numfmt.panel')}>
        <div className="xl-rows">
          <div className="xl-row">
            <Drop label={fmtLabel} disabled={off} title="Number Format"
              items={NUM_FORMATS.map((f) => ({ label: `${f.label}  —  ${f.sample}`, run: () => setNumFmt(f.pattern) }))
                .concat([{ label: 'More Number Formats…', run: () => run('sheet.operation.open.numfmt.panel') }])} />
          </div>
          <div className="xl-row">
            <Btn label="$" disabled={off} title="Accounting Number Format" run={() => run('sheet.command.numfmt.set.currency')} />
            <Btn label="%" disabled={off} title="Percent Style" run={() => run('sheet.command.numfmt.set.percent')} />
            <Btn label="," disabled={off} title="Comma Style" run={() => setNumFmt('#,##0.00')} />
            <span className="xl-vsep" />
            <Btn label=".0→.00" disabled={off} title="Increase Decimal" run={() => run('sheet.command.numfmt.add.decimal.command')} />
            <Btn label=".00→.0" disabled={off} title="Decrease Decimal" run={() => run('sheet.command.numfmt.subtract.decimal.command')} />
          </div>
        </div>
      </Group>

      <Group label="Styles">
        <Btn big icon={I.cond} label="Conditional Formatting" disabled={off}
          run={() => run('sheet.operation.open.conditional.formatting.panel')} />
        <Btn big icon={I.table} label="Format as Table" disabled title={`Format as Table — ${NA}`} />
        <div className="xl-styles-wrap" ref={galRef}>
          <div className="xl-styles" role="listbox" aria-label="Cell Styles">
            {CELL_STYLES.map((s) => (
              <button key={s.label} type="button" className={`xl-style ${s.label.toLowerCase()}`} disabled={off}
                onMouseDown={keep} onClick={() => applyCellStyle(s)}
                title={s.label === 'Normal' ? 'Normal — clear formatting' : `${s.label} cell style`}
                style={s.bg ? { background: s.bg, color: s.fc } : undefined}>{s.label}</button>
            ))}
          </div>
          <button type="button" className={`xl-btn xl-gal-more${galOpen ? ' on' : ''}`} disabled={off} onMouseDown={keep}
            onClick={() => setGalOpen((o) => !o)} title="Cell Styles — all styles">⌄</button>
          {galOpen && (
            <div className="xl-gallery" role="listbox" aria-label="All cell styles">
              {STYLE_GALLERY.map((sec) => (
                <div key={sec.section}>
                  <h5>{sec.section}</h5>
                  <div className="xl-gallery-grid">
                    {sec.items.map((s) => <StyleBtn key={s.label} s={s} onPick={(d) => { setGalOpen(false); applyStyleDef(d); }} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Group>

      <Group label="Cells">
        <Drop big icon={I.insert} label="Insert" disabled={off}
          items={[
            { label: 'Insert Cells… (shift down)', run: () => run('sheet.command.insert-range-move-down-confirm') },
            { label: 'Insert Cells… (shift right)', run: () => run('sheet.command.insert-range-move-right-confirm') },
            { label: 'Insert Sheet Rows', icon: I.rows, run: () => run('sheet.command.insert-row-before') },
            { label: 'Insert Sheet Columns', icon: I.cols, run: () => run('sheet.command.insert-col-before') },
            { label: 'Insert Sheet', icon: I.sheet, run: () => run('sheet.command.insert-sheet') },
          ]} />
        <Drop big icon={I.del} label="Delete" disabled={off}
          items={[
            { label: 'Delete Cells… (shift up)', run: () => run('sheet.command.delete-range-move-up-confirm') },
            { label: 'Delete Cells… (shift left)', run: () => run('sheet.command.delete-range-move-left-confirm') },
            { label: 'Delete Sheet Rows', run: () => run('sheet.command.remove-row-confirm') },
            { label: 'Delete Sheet Columns', run: () => run('sheet.command.remove-col-confirm') },
            { label: 'Delete Sheet', run: () => run('sheet.command.remove-sheet-confirm') },
          ]} />
        <Drop big icon={I.format} label="Format" disabled={off}
          items={[
            { label: 'AutoFit Row Height', run: () => run('sheet.command.set-row-is-auto-height') },
            { label: 'AutoFit Column Width', run: () => run('sheet.command.set-col-auto-width') },
            { sep: true, label: '' },
            { label: 'Hide Rows', run: () => run('sheet.command.hide-row-confirm') },
            { label: 'Hide Columns', run: () => run('sheet.command.hide-col-confirm') },
            { label: 'Unhide Rows', run: () => run('sheet.command.set-selected-rows-visible') },
            { label: 'Unhide Columns', run: () => run('sheet.command.set-selected-cols-visible') },
            { sep: true, label: '' },
            { label: 'Rename Sheet', run: () => run('sheet.operation.rename-sheet') },
            { label: 'Format Cells…', run: () => run('sheet.operation.open.numfmt.panel') },
          ]} />
      </Group>

      <Group label="Editing">
        <div className="xl-col">
          <Drop icon={I.sigma} label="AutoSum" disabled={off} split={() => autoSum('SUM')} title="AutoSum (Alt+=)" items={autoSumItems} />
          <Drop icon={I.fill} label="Fill" disabled={off}
            items={[
              { label: 'Down', run: () => run('sheet.command.copy-down') },
              { label: 'Right', run: () => run('sheet.command.copy-right') },
            ]} />
          <Drop icon={I.eraser} label="Clear" disabled={off}
            items={[
              { label: 'Clear All', run: () => run('sheet.command.clear-selection-all') },
              { label: 'Clear Formats', run: () => run('sheet.command.clear-selection-format') },
              { label: 'Clear Contents', run: () => run('sheet.command.clear-selection-content') },
            ]} />
        </div>
        <Drop big icon={I.sort} label="Sort & Filter" disabled={off} items={sortItems} />
        <Drop big icon={I.find} label="Find & Select" disabled={off}
          items={[
            { label: 'Find…', run: () => run('ui.operation.open-find-dialog') },
            { label: 'Replace…', run: () => run('ui.operation.open-replace-dialog') },
            { label: 'Go To…', title: 'Ctrl+G', run: () => openDialog('goto') },
            { label: 'Go To Special…', run: () => openDialog('special') },
            { sep: true, label: '' },
            { label: 'Formulas', run: () => { const m = goToSpecial('formulas'); if (m) { setSpecial('formulas'); setDlgMsg(m); setDlg('special'); } } },
            { label: 'Constants', run: () => { const m = goToSpecial('constants'); if (m) { setSpecial('constants'); setDlgMsg(m); setDlg('special'); } } },
            { label: 'Blanks', run: () => { const m = goToSpecial('blanks'); if (m) { setSpecial('blanks'); setDlgMsg(m); setDlg('special'); } } },
            { sep: true, label: '' },
            { label: 'Select All', run: () => run('sheet.command.select-all') },
          ]} />
      </Group>
    </>
  );

  const placeholder = (what: string) => (
    <div className="xl-empty">{what} — {NA}. Use the <b>Home</b> tab for formatting.</div>
  );

  const body: Record<Exclude<Tab, 'File'>, ReactNode> = {
    Home: home,
    Insert: (
      <>
        <Group label="Tables">
          <Btn big icon={I.table} label="Table" disabled title={`Table — ${NA}`} />
        </Group>
        <Group label="Cells">
          <Btn big icon={I.rows} label="Rows" disabled={off} title="Insert Sheet Rows" run={() => run('sheet.command.insert-row-before')} />
          <Btn big icon={I.cols} label="Columns" disabled={off} title="Insert Sheet Columns" run={() => run('sheet.command.insert-col-before')} />
          <Btn big icon={I.sheet} label="Sheet" disabled={off} title="Insert Sheet" run={() => run('sheet.command.insert-sheet')} />
        </Group>
        <Group label="Links">
          <Btn big icon={I.link} label="Link" disabled={off} title="Insert Link (Ctrl+K)" run={() => run('sheet.operation.insert-hyper-link-toolbar')} />
        </Group>
        <Group label="Comments">
          <Btn big icon={I.note} label="Note" disabled={off} title="New Note" run={() => run('sheet.operation.add-note-popup')} />
        </Group>
        <Group label="Controls">
          <Btn big icon={I.checkbox} label="Checkbox" disabled={off} title="Insert a checkbox in each selected cell"
            run={() => run('data-validation.command.insert-quick-rule', { rule: { type: 'checkbox' } })} />
          <Btn big icon={I.dropdown} label="Dropdown" disabled={off} title="Insert a dropdown list in the selected cells"
            run={() => run('data-validation.command.addRuleAndOpen', { rule: { type: 'list', formula1: 'Option 1,Option 2,Option 3' } })} />
        </Group>
        <Group label="Functions">
          <Btn big icon={I.fx} label="Function" disabled={off} title="Insert Function (Shift+F3)" run={() => run('formula-ui.operation.more-functions')} />
        </Group>
      </>
    ),
    Draw: placeholder('Drawing tools'),
    'Page Layout': (
      <>
        <Group label="Sheet Options">
          <Btn big icon={I.grid} label="Gridlines" disabled={off} title="Show / hide gridlines" run={() => run('sheet.command.toggle-gridlines')} />
        </Group>
        <div className="xl-empty">Page setup and printing — {NA}.</div>
      </>
    ),
    Formulas: (
      <>
        <Group label="Function Library">
          <Btn big icon={I.fx} label="Insert Function" disabled={off} run={() => run('formula-ui.operation.more-functions')} />
          <Drop big icon={I.sigma} label="AutoSum" disabled={off} items={autoSumItems} />
          <Btn big icon={I.fx} label="More Functions" disabled={off} run={() => run('formula-ui.operation.more-functions')} />
        </Group>
        <Group label="Defined Names">
          <Btn big icon={I.name} label="Name Manager" disabled={off} run={() => run('sidebar.operation.defined-name')} />
        </Group>
      </>
    ),
    Data: (
      <>
        <Group label="Sort & Filter">
          <Btn big icon={I.sort} label="Sort A to Z" disabled={off} run={() => run('sheet.command.sort-range-asc')} />
          <Btn big icon={I.sort} label="Sort Z to A" disabled={off} run={() => run('sheet.command.sort-range-desc')} />
          <Btn big icon={I.sort} label="Sort…" disabled={off} run={() => run('sheet.command.sort-range-custom')} />
          <div className="xl-col">
            <Btn label="⏷ Filter" disabled={off} run={() => run('sheet.command.smart-toggle-filter')} />
            <Btn label="Clear" disabled={off} run={() => run('sheet.command.clear-filter-criteria')} />
            <Btn label="Reapply" disabled={off} run={() => run('sheet.command.re-calc-filter')} />
          </div>
        </Group>
        <Group label="Data Tools">
          <Btn big icon={I.text2col} label="Text to Columns" disabled={off} run={() => run('sheet.command.split-text-to-columns')} />
          <Btn big icon={I.dedupe} label="Remove Duplicates" disabled={off} title="Delete duplicate rows from the selected range"
            run={() => openDialog('dedupe')} />
          <Btn big icon={I.valid} label="Data Validation" disabled={off} run={() => run('data-validation.operation.open-validation-panel')} />
        </Group>
      </>
    ),
    Review: (
      <>
        <Group label="Notes">
          <Btn big icon={I.note} label="New Note" disabled={off} run={() => run('sheet.operation.add-note-popup')} />
        </Group>
        <Group label="Find">
          <Btn big icon={I.find} label="Find" disabled={off} run={() => run('ui.operation.open-find-dialog')} />
          <Btn big icon={I.find} label="Replace" disabled={off} run={() => run('ui.operation.open-replace-dialog')} />
        </Group>
        <Group label="Protect">
          <Btn big icon={I.lock} label="Protect Range" disabled={off} title="Protect the selected range from editing"
            run={() => run('sheet.command.add-range-protection-from-toolbar')} />
          <Btn big icon={I.lock} label="Permissions" disabled={off} title="View protected ranges and sheets"
            run={() => run('sheet.command.view-sheet-permission-from-context-menu')} />
        </Group>
      </>
    ),
    View: (
      <>
        <Group label="Show">
          <Btn big icon={I.grid} label="Gridlines" disabled={off} run={() => run('sheet.command.toggle-gridlines')} />
        </Group>
        <Group label="Zoom">
          <Btn big icon={I.zoom} label="Zoom In" disabled={off} run={() => zoomBy(0.1)} />
          <Btn big icon={I.zoom} label="Zoom Out" disabled={off} run={() => zoomBy(-0.1)} />
          <Btn big icon={I.zoom} label="100%" disabled={off} run={() => zoomBy(0)} />
        </Group>
        <Group label="Window">
          <Drop big icon={I.freeze} label="Freeze Panes" disabled={off} items={freezeItems} />
          <Btn big icon={I.full} label="Full Screen" disabled={off} run={() => run('base-ui.operation.toggle-fullscreen')} />
        </Group>
      </>
    ),
    Help: (
      <>
        <Group label="Help">
          <Btn big icon={I.keys} label="Keyboard Shortcuts" disabled={off} run={() => run('base-ui.operation.toggle-shortcut-panel')} />
        </Group>
        <div className="xl-empty">Spreadsheet engine: Univer (open source). Formatting, formulas, merges, sizes and freeze panes are saved to the file.</div>
      </>
    ),
  };

  return (
    <div className="xl-shell" ref={shellRef}>
      {/* ── Thanh tiêu đề xanh: Quick Access + tên file ── */}
      <div className="xl-title">
        <div className="xl-qat">
          <button type="button" className="xl-qbtn" onMouseDown={keep} onClick={onSave} disabled={!canSave}
            title={saveTitle}>{saving ? <span className="spinner" aria-hidden /> : I.save}</button>
          <button type="button" className="xl-qbtn" onMouseDown={keep} disabled={off} onClick={() => run('univer.command.undo')} title="Undo (Ctrl+Z)">{I.undo}</button>
          <button type="button" className="xl-qbtn" onMouseDown={keep} disabled={off} onClick={() => run('univer.command.redo')} title="Redo (Ctrl+Y)">{I.redo}</button>
        </div>
        <div className="xl-title-name" title={fileName}>{fileName}{dirty > 0 ? ' •' : ''} - Excel</div>
        <div className="xl-title-right">
          {dirty > 0 && <span className="xl-dirty" title="Unsaved changes">{dirty} unsaved</span>}
          <button type="button" className="xl-title-btn" onClick={onExit} title="Back to the classic grid">Classic grid</button>
        </div>
      </div>

      {/* ── Dải tab ── */}
      <div className="xl-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab}
            className={`xl-tab${t === tab ? ' on' : ''}${t === 'File' ? ' file' : ''}`}
            onClick={() => { setTab(t); if (collapsed && t !== 'File') toggleCollapsed(); }}>{t}</button>
        ))}
        <div className="xl-tell" ref={qRef}>
          <span aria-hidden>💡</span>
          <input value={q} placeholder="Tell me what you want to do" onFocus={() => setQOpen(true)}
            onChange={(e) => { setQ(e.target.value); setQOpen(true); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && hits[0]) { hits[0].run?.(); setQ(''); setQOpen(false); }
              if (e.key === 'Escape') { setQ(''); setQOpen(false); }
            }} />
          {qOpen && hits.length > 0 && (
            <div className="xl-menu" role="listbox">
              {hits.map((h) => (
                <button key={h.label} type="button" onMouseDown={keep}
                  onClick={() => { h.run?.(); setQ(''); setQOpen(false); }}>{h.label}</button>
              ))}
            </div>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className="xl-save" onClick={onSave} disabled={!canSave} title={saveTitle}>
          {saving ? <span className="spinner" aria-hidden /> : I.save} Save
        </button>
      </div>

      {/* ── Ribbon / trang File ── */}
      {tab === 'File' ? (
        <div className="xl-backstage">
          <div className="xl-bs-menu">
            <button type="button" onClick={() => setTab('Home')}>← Back</button>
            <button type="button" onClick={onSave} disabled={!canSave} title={saveTitle}>Save</button>
            <button type="button" onClick={onReload}>Reload from disk</button>
            <button type="button" onClick={onOpenFile}>Open…</button>
            <button type="button" onClick={onOpenExternal}>Open in desktop Excel</button>
            <button type="button" onClick={onExit}>Classic grid</button>
          </div>
          <div className="xl-bs-info">
            <h3>Info</h3>
            <div className="xl-bs-file">{fileName} <span className="xl-bs-kind">{kind.toUpperCase()}</span></div>
            {info}
          </div>
        </div>
      ) : !collapsed && (
        <Ribbon label={tab} items={toItems(body[tab])} onCollapse={toggleCollapsed} />
      )}
      {collapsed && tab !== 'File' && (
        <button type="button" className="xl-expand" onClick={toggleCollapsed} title="Show the Ribbon">⌄ Show ribbon</button>
      )}

      {/* ── Hộp thoại kiểu Excel ── */}
      {dlg === 'goto' && (
        <Dialog title="Go To" onClose={closeDlg} width={340}
          foot={<>
            <span className="msg">{dlgMsg}</span>
            <button type="button" onClick={() => { setDlg('special'); setDlgMsg(''); }}>Special…</button>
            <button type="button" className="primary" onClick={() => { const m = goTo(gotoRef); if (m) setDlgMsg(m); else closeDlg(); }}>OK</button>
            <button type="button" onClick={closeDlg}>Cancel</button>
          </>}>
          <div>Go to:</div>
          <div className="xl-dialog-list" style={{ minHeight: 60 }}>
            {gotoHist.length === 0 && <div className="xl-dialog-hint">Recent references appear here.</div>}
            {gotoHist.map((h) => <button key={h} type="button" onClick={() => setGotoRef(h)} onDoubleClick={() => { if (!goTo(h)) closeDlg(); }}>{h}</button>)}
          </div>
          <label>Reference:
            <input type="text" value={gotoRef} autoFocus spellCheck={false} placeholder="e.g. B12, A1:C5, Sheet2!D4"
              onFocus={(e) => e.target.select()}
              onChange={(e) => { setGotoRef(e.target.value); setDlgMsg(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { const m = goTo(gotoRef); if (m) setDlgMsg(m); else closeDlg(); } }} />
          </label>
        </Dialog>
      )}
      {dlg === 'special' && (
        <Dialog title="Go To Special" onClose={closeDlg} width={340}
          foot={<>
            <span className="msg">{dlgMsg}</span>
            <button type="button" className="primary" onClick={() => { const m = goToSpecial(special); if (m) setDlgMsg(m); else closeDlg(); }}>OK</button>
            <button type="button" onClick={closeDlg}>Cancel</button>
          </>}>
          <div>Select:</div>
          <div className="xl-dialog-list">
            {SPECIALS.map((s) => (
              <label key={s.id} title={s.hint}>
                <input type="radio" name="xl-special" checked={special === s.id} onChange={() => { setSpecial(s.id); setDlgMsg(''); }} />
                {s.label}<span className="xl-dialog-hint">{s.hint}</span>
              </label>
            ))}
          </div>
          <div className="xl-dialog-hint">Searches the selection, or the whole sheet when only one cell is selected.</div>
        </Dialog>
      )}
      {dlg === 'dedupe' && ddRect && (
        <Dialog title="Remove Duplicates" onClose={closeDlg} width={380}
          foot={<>
            <span className="msg">{dlgMsg}</span>
            {ddDone
              ? <button type="button" className="primary" onClick={closeDlg}>Close</button>
              : <>
                <button type="button" className="primary" onClick={removeDuplicates}>OK</button>
                <button type="button" onClick={closeDlg}>Cancel</button>
              </>}
          </>}>
          <div>To delete duplicate values, select one or more columns that contain duplicates.</div>
          <div className="xl-dialog-hint">Range: <b>{rectLabel(ddRect)}</b></div>
          <div className="xl-dialog-row">
            <button type="button" disabled={ddDone} onClick={() => setDdCols(ddCols.map(() => true))}>Select All</button>
            <button type="button" disabled={ddDone} onClick={() => setDdCols(ddCols.map(() => false))}>Unselect All</button>
            <span style={{ flex: 1 }} />
            <label><input type="checkbox" checked={ddHeader} disabled={ddDone} onChange={(e) => setDdHeader(e.target.checked)} />My data has headers</label>
          </div>
          <div className="xl-dialog-list">
            {ddCols.map((on, i) => (
              <label key={i}>
                <input type="checkbox" checked={on} disabled={ddDone} onChange={(e) => setDdCols(ddCols.map((v, j) => (j === i ? e.target.checked : v)))} />
                {ddLabel(i)}
              </label>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
