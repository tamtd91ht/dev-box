// Server-only: LINK ẨN trong ô Google Sheets cho trợ lý AI (lib/aiScreen.ts → /api/ai action 'links.xlsx').
//
// Ô Sheets có link thường chỉ hiện chữ (tên repo, "Tài liệu"…), đường dẫn thật nằm ẩn: CSV xuất ra không có,
// lưới vẽ bằng canvas nên DOM cũng không có <a>. main.cjs tải bản .xlsx bằng phiên đăng nhập của tab, ở đây
// đọc link từng ô bằng ExcelJS: link gắn vào ô (hyperlink) và công thức =HYPERLINK("url"; "chữ").
// Chỉ ĐỌC — không ghi gì xuống đĩa.

import ExcelJS from 'exceljs';

export interface SheetLink {
  /** "Handover!I5" */
  cell: string;
  sheet: string;
  text: string;
  url: string;
}

const MAX_LINKS = 600;
const MAX_BYTES = 15 * 1024 * 1024;

const HYPERLINK_RE = /HYPERLINK\(\s*"([^"]+)"/i;

/** Link trong các ô của workbook (base64 .xlsx). `prefer` = tên sheet đang mở → đứng đầu danh sách. */
export async function xlsxLinks(data: unknown, prefer?: unknown): Promise<{ links: SheetLink[]; sheets: string[]; truncated: boolean }> {
  if (typeof data !== 'string' || !data) throw new Error('Thiếu dữ liệu bảng tính.');
  const buf = Buffer.from(data, 'base64');
  if (buf.length > MAX_BYTES) throw new Error(`Bảng tính lớn hơn ${MAX_BYTES / 1024 / 1024} MB.`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);

  const want = typeof prefer === 'string' ? prefer.trim() : '';
  const sheets = wb.worksheets.map((w) => w.name);
  const order = [...wb.worksheets].sort((a, b) => Number(b.name === want) - Number(a.name === want));
  const links: SheetLink[] = [];
  let truncated = false;
  for (const ws of order) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (links.length >= MAX_LINKS) { truncated = true; return; }
        let url = '';
        if (cell.hyperlink) url = cell.hyperlink;
        else if (cell.formula) url = HYPERLINK_RE.exec(cell.formula)?.[1] ?? '';
        url = url.trim();
        if (!/^https?:\/\//i.test(url)) return;
        links.push({ cell: `${ws.name}!${cell.address}`, sheet: ws.name, text: cell.text.replace(/\s+/g, ' ').trim().slice(0, 120), url });
      });
    });
  }
  return { links, sheets, truncated };
}
