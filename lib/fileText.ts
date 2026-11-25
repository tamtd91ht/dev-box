// Server-only: đọc CHỮ từ một file người dùng import (menu 🤖 OpenAI — đính file vào prompt).
//
// Hỗ trợ: .txt .csv (giữ nguyên), .docx (mammoth), .doc Word 97-2003 (word-extractor),
// .pdf (unpdf — pdf.js gói sẵn cho Node), .xlsx (ExcelJS — mỗi sheet thành bảng TSV).
// Chỉ lấy chữ: ảnh, định dạng, công thức bị bỏ; PDF scan (chỉ có ảnh) không có chữ
// thì báo rõ. Không ghi gì xuống đĩa — đọc thẳng từ buffer.

import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import WordExtractor from 'word-extractor';

export const FILE_TEXT_EXTS = ['.txt', '.csv', '.doc', '.docx', '.pdf', '.xlsx'] as const;
/** File vào tối đa (byte). */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
/** Chữ ra tối đa mỗi file (ký tự) — phần sau bị cắt và có ghi chú. */
export const FILE_MAX_CHARS = 200_000;
/** Sheet Excel: tối đa chừng này dòng mỗi sheet. */
const XLSX_MAX_ROWS = 5_000;

export interface FileText {
  name: string;
  kind: string;
  text: string;
  chars: number;
  truncated: boolean;
  /** Ghi chú cho người dùng (vd số trang, số sheet, dòng bị bỏ). */
  note: string;
}

const extOf = (name: string) => (/\.[^.]+$/.exec(name.toLowerCase())?.[0] ?? '');

/** Chữ UTF-8; không hợp lệ thì thử Windows-1258 (file CSV xuất từ Excel tiếng Việt cũ). */
function decodeText(buf: Buffer): string {
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bom);
  } catch {
    try { return new TextDecoder('windows-1258').decode(bom); } catch { return bom.toString('latin1'); }
  }
}

async function pdfText(buf: Buffer): Promise<{ text: string; note: string }> {
  // unpdf là ESM: nạp động để route vẫn chạy được khi Next đóng gói server dạng CJS.
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  const joined = pages.map((t, i) => `[Trang ${i + 1}]\n${t.trim()}`).join('\n\n');
  if (!pages.some((t) => t.trim())) {
    throw new Error('PDF không có lớp chữ (có thể là bản scan / ảnh) — không đọc được chữ.');
  }
  return { text: joined, note: `${totalPages} trang` };
}

async function xlsxText(buf: Buffer): Promise<{ text: string; note: string }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const parts: string[] = [];
  let cut = 0;
  wb.eachSheet((ws) => {
    const rows: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n > XLSX_MAX_ROWS) { cut += 1; return; }
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) {
        // .text = giá trị đã định dạng như Excel hiển thị (kể cả kết quả công thức).
        cells.push(row.getCell(c).text.replace(/[\t\r\n]+/g, ' ').trim());
      }
      rows.push(cells.join('\t').replace(/\t+$/, ''));
    });
    parts.push(`### Sheet: ${ws.name}\n${rows.join('\n')}`);
  });
  const note = `${parts.length} sheet${cut ? ` · bỏ ${cut} dòng sau dòng ${XLSX_MAX_ROWS}` : ''}`;
  return { text: parts.join('\n\n'), note };
}

/** Đọc chữ của một file (base64). Ném lỗi rõ ràng khi không hỗ trợ / không đọc được. */
export async function fileToText(name: unknown, data: unknown): Promise<FileText> {
  const fname = typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : 'file';
  if (typeof data !== 'string' || !data) throw new Error(`${fname}: không có dữ liệu.`);
  const ext = extOf(fname);
  if (!(FILE_TEXT_EXTS as readonly string[]).includes(ext)) {
    throw new Error(`${fname}: chỉ hỗ trợ ${FILE_TEXT_EXTS.join(', ')}.`);
  }
  const buf = Buffer.from(data, 'base64');
  if (buf.length > FILE_MAX_BYTES) throw new Error(`${fname}: lớn hơn ${FILE_MAX_BYTES / 1024 / 1024} MB.`);

  let text = '';
  let note = '';
  try {
    if (ext === '.txt' || ext === '.csv') {
      text = decodeText(buf);
    } else if (ext === '.docx') {
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (ext === '.doc') {
      text = (await new WordExtractor().extract(buf)).getBody();
    } else if (ext === '.pdf') {
      ({ text, note } = await pdfText(buf));
    } else {
      ({ text, note } = await xlsxText(buf));
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    throw new Error(msg.startsWith(fname) ? msg : `${fname}: không đọc được (${msg}).`);
  }
  text = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!text) throw new Error(`${fname}: không có chữ nào để đưa vào prompt.`);
  const truncated = text.length > FILE_MAX_CHARS;
  if (truncated) text = text.slice(0, FILE_MAX_CHARS);
  return { name: fname, kind: ext.slice(1).toUpperCase(), text, chars: text.length, truncated, note };
}
