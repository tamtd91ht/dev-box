// Server-side xlsx → HTML cho API-preview của tab Google: file Excel (upload
// .xlsx hoặc Google Sheets export ra xlsx) render thành bảng đọc-được ngay
// trong app — KHÔNG cần phiên đăng nhập Google trong webview. Chỉ để XEM;
// sửa mở editor thật. Dùng exceljs (đã là dependency của tab Office).
//
// Trả về MỖI SHEET MỘT TRANG HTML riêng — panel preview render thanh tab để
// chuyển sheet (iframe sandboxed không chạy được script nên tab phải nằm ở
// phía React, không nhét JS vào HTML này).
//
// Giữ format ở mức "nhìn quen mắt": merge ô (colspan/rowspan), độ rộng cột,
// bold/italic/underline, cỡ chữ, màu chữ, màu nền, căn lề, wrap text, số căn
// phải. Không theo đuổi pixel-perfect (border style từng cạnh, theme colors…).

import ExcelJS from 'exceljs';

export interface SheetHtml {
  name: string;
  html: string;
}

const MAX_SHEETS = 20;
const MAX_ROWS = 2000;
const MAX_COLS = 80;

// LƯU Ý: cell.text của exceljs KHÔNG phải lúc nào cũng là string — ô richText/
// hyperlink/formula-error có thể trả object ("s.replace is not a function").
// Ép String() ở đây để một ô "lạ" không đánh sập preview cả file.
const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ARGB ("FF37761D") → CSS #rrggbb; bỏ qua theme/indexed color (undefined). */
function argbCss(argb?: string): string | null {
  if (!argb || argb.length < 6) return null;
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex.toLowerCase()}`;
}

/** "A1:C3" → {r1,c1,r2,c2} (1-based). */
function parseRange(ref: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  const col = (s: string) => s.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  return { c1: col(m[1]), r1: Number(m[2]), c2: col(m[3]), r2: Number(m[4]) };
}

function cellStyle(cell: ExcelJS.Cell): string {
  const css: string[] = [];
  const font = cell.font;
  if (font?.bold) css.push('font-weight:600');
  if (font?.italic) css.push('font-style:italic');
  if (font?.underline) css.push('text-decoration:underline');
  if (font?.strike) css.push('text-decoration:line-through');
  if (font?.size && font.size !== 11) css.push(`font-size:${font.size}pt`);
  const fc = argbCss(typeof font?.color === 'object' ? font.color.argb : undefined);
  if (fc) css.push(`color:${fc}`);

  const fill = cell.fill;
  if (fill && fill.type === 'pattern' && fill.pattern !== 'none') {
    const bg = argbCss(fill.fgColor?.argb);
    if (bg && bg !== '#ffffff') css.push(`background:${bg}`);
  }

  const al = cell.alignment;
  if (al?.horizontal && al.horizontal !== 'left') css.push(`text-align:${al.horizontal}`);
  else if (typeof cell.value === 'number' || (cell.value && typeof cell.value === 'object' && 'result' in cell.value && typeof cell.value.result === 'number')) {
    css.push('text-align:right'); // số không căn lề tường minh → căn phải như Sheets
  }
  if (al?.wrapText) css.push('white-space:pre-wrap;word-break:break-word');
  if (al?.vertical === 'top') css.push('vertical-align:top');

  return css.join(';');
}

function sheetToHtml(ws: ExcelJS.Worksheet): string {
  const rowCount = Math.min(ws.rowCount, MAX_ROWS);
  const colCount = Math.min(ws.columnCount || 0, MAX_COLS);
  if (!rowCount || !colCount) return '<p class="cap">(sheet trống)</p>';

  // Merge map: ô chủ → span; ô bị phủ → bỏ qua khi render.
  const spans = new Map<string, { cs: number; rs: number }>();
  const covered = new Set<string>();
  const merges = (ws.model as unknown as { merges?: string[] }).merges ?? [];
  for (const ref of merges) {
    const g = parseRange(ref);
    if (!g) continue;
    spans.set(`${g.r1}:${g.c1}`, { cs: g.c2 - g.c1 + 1, rs: g.r2 - g.r1 + 1 });
    for (let r = g.r1; r <= g.r2; r++) {
      for (let c = g.c1; c <= g.c2; c++) {
        if (r !== g.r1 || c !== g.c1) covered.add(`${r}:${c}`);
      }
    }
  }

  // Độ rộng cột thật (đơn vị ký tự Excel ≈ 7px) — thiếu thì để trình duyệt lo.
  const cols: string[] = ['<col style="width:44px">'];
  for (let c = 1; c <= colCount; c++) {
    const w = ws.getColumn(c).width;
    cols.push(w ? `<col style="width:${Math.round(w * 7 + 5)}px">` : '<col>');
  }

  const rows: string[] = [];
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [`<td class="rn">${r}</td>`];
    for (let c = 1; c <= colCount; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = row.getCell(c);
      let text: unknown = '';
      try {
        text = cell.text ?? '';
        // Hyperlink/richText: .text có thể là object {text, hyperlink} / {richText}.
        if (typeof text === 'object' && text !== null) {
          const t = text as { text?: unknown; richText?: { text?: unknown }[] };
          if (Array.isArray(t.richText)) text = t.richText.map((x) => x?.text ?? '').join('');
          else if ('text' in t) text = t.text ?? '';
        }
      } catch { /* cell lỗi format — bỏ trống */ }
      const span = spans.get(`${r}:${c}`);
      const spanAttr = span ? `${span.cs > 1 ? ` colspan="${span.cs}"` : ''}${span.rs > 1 ? ` rowspan="${span.rs}"` : ''}` : '';
      const style = cellStyle(cell);
      cells.push(`<td${spanAttr}${style ? ` style="${style}"` : ''}>${esc(text)}</td>`);
    }
    rows.push(`<tr>${cells.join('')}</tr>`);
  }

  const capNote = ws.rowCount > MAX_ROWS
    ? `<p class="cap">… còn ${ws.rowCount - MAX_ROWS} hàng nữa — mở editor để xem đủ.</p>` : '';
  return `<div class="tw"><table><colgroup>${cols.join('')}</colgroup>${rows.join('')}</table></div>${capNote}`;
}

const PAGE_STYLE = `<style>
  html,body{margin:0;background:#fff}
  body{font:12.5px/1.4 system-ui,'Segoe UI',sans-serif;color:#202124;padding:10px}
  .tw{overflow:auto;max-width:100%}
  table{border-collapse:collapse;table-layout:fixed}
  td{border:1px solid #e0e3e7;padding:2px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;height:20px}
  td.rn{background:#f8f9fa;border-color:#e0e3e7;color:#80868b;text-align:center;font-size:10px;position:sticky;left:0;z-index:1}
  .cap{color:#80868b;font-size:12px;padding:8px 2px}
</style>`;

/** Mỗi sheet một trang HTML hoàn chỉnh (panel preview render tab chuyển sheet). */
export async function xlsxToSheets(buf: Buffer): Promise<SheetHtml[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const out: SheetHtml[] = [];
  for (const ws of wb.worksheets.slice(0, MAX_SHEETS)) {
    out.push({ name: ws.name, html: `${PAGE_STYLE}${sheetToHtml(ws)}` });
  }
  if (wb.worksheets.length > MAX_SHEETS) {
    out.push({
      name: `+${wb.worksheets.length - MAX_SHEETS} sheet`,
      html: `${PAGE_STYLE}<p class="cap">Còn ${wb.worksheets.length - MAX_SHEETS} sheet nữa — mở editor để xem đủ.</p>`,
    });
  }
  return out;
}
