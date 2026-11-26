// Server-only: dựng file .docx / .xlsx trợ lý AI muốn XUẤT (lib/aiExportClient.ts, /api/ai action 'export.build').
//
// Trợ lý vẫn KHÔNG có công cụ (lib/aiChatServer.ts): file chỉ là chữ nó viết trong câu trả lời, bọc trong khối
// <xuat_file name="…">…</xuat_file>. Người dùng bấm ĐỒNG Ý thì portal mới gửi nội dung tới đây để dựng file:
//   · .docx — nội dung Markdown (tiêu đề, đoạn, danh sách, bảng, khối code, **đậm**, *nghiêng*, `code`, link);
//   · .xlsx — nội dung CSV; nhiều sheet thì mỗi sheet mở đầu bằng dòng "### Sheet: Tên".
// Dựng hoàn toàn TRONG BỘ NHỚ và trả về base64 — không ghi gì xuống đĩa, không có file tạm để dọn.

import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph, Table, TableCell,
  TableRow, TextRun, WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';

export const EXPORT_MAX_CHARS = 2_000_000;

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

// ── .docx từ Markdown ─────────────────────────────────────────────────────────

type Inline = TextRun | ExternalHyperlink;

/** **đậm**, *nghiêng* / _nghiêng_, `code`, [chữ](http…) → các đoạn chữ của docx. */
function inlines(src: string, base: { bold?: boolean; font?: string } = {}): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) out.push(new TextRun({ text: src.slice(last, m.index), ...base }));
    if (m[2] || m[3]) out.push(new TextRun({ text: m[2] ?? m[3], ...base, bold: true }));
    else if (m[4] || m[5]) out.push(new TextRun({ text: m[4] ?? m[5], ...base, italics: true }));
    else if (m[6]) out.push(new TextRun({ text: m[6], ...base, font: 'Consolas' }));
    else if (m[7]) out.push(new ExternalHyperlink({ link: m[8], children: [new TextRun({ text: m[7], style: 'Hyperlink', ...base })] }));
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push(new TextRun({ text: src.slice(last), ...base }));
  return out.length ? out : [new TextRun({ text: '', ...base })];
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function table(rows: string[][]): Table {
  const width = Math.max(...rows.map((r) => r.length));
  const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((r, i) => new TableRow({
      tableHeader: i === 0,
      children: Array.from({ length: width }, (_, c) => new TableCell({
        borders: { top: border, bottom: border, left: border, right: border },
        children: [new Paragraph({ children: inlines(r[c] ?? '', i === 0 ? { bold: true } : {}) })],
      })),
    })),
  });
}

export async function markdownToDocx(md: string): Promise<Buffer> {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const body: (Paragraph | Table)[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```/.exec(line);
    if (fence) {
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(new Paragraph({ children: [new TextRun({ text: lines[i], font: 'Consolas', size: 19 })], spacing: { after: 0 } }));
        i++;
      }
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      body.push(table(rows), new Paragraph({ children: [] }));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { body.push(new Paragraph({ heading: HEADINGS[h[1].length - 1], children: inlines(h[2]) })); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      body.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } } }));
      i++;
      continue;
    }
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) { body.push(new Paragraph({ bullet: { level: Math.min(3, Math.floor(ul[1].length / 2)) }, children: inlines(ul[2]) })); i++; continue; }
    const ol = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (ol) { body.push(new Paragraph({ numbering: { reference: 'num', level: Math.min(3, Math.floor(ol[1].length / 2)) }, children: inlines(ol[2]) })); i++; continue; }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) { body.push(new Paragraph({ indent: { left: 480 }, children: inlines(q[1], {}) })); i++; continue; }
    if (!line.trim()) { i++; continue; }
    // Đoạn văn: gộp các dòng liền nhau.
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(\s*```|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    body.push(new Paragraph({ children: inlines(para.join(' ')), spacing: { after: 120 } }));
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [{
        reference: 'num',
        levels: [0, 1, 2, 3].map((level) => ({
          level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    },
    sections: [{ children: body.length ? body : [new Paragraph({ children: [] })] }],
  });
  return Packer.toBuffer(doc);
}

// ── .xlsx từ CSV ──────────────────────────────────────────────────────────────

const NUM = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

export async function csvToXlsx(content: string): Promise<Buffer> {
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  // "### Sheet: Tên" tách nhiều sheet; không có thì một sheet "Sheet1".
  const parts: { name: string; csv: string }[] = [];
  let cur: { name: string; lines: string[] } = { name: 'Sheet1', lines: [] };
  for (const line of text.split('\n')) {
    const m = /^#{2,3}\s*Sheet:\s*(.+?)\s*$/i.exec(line);
    if (m) {
      if (cur.lines.some((l) => l.trim())) parts.push({ name: cur.name, csv: cur.lines.join('\n') });
      cur = { name: m[1], lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.lines.some((l) => l.trim()) || !parts.length) parts.push({ name: cur.name, csv: cur.lines.join('\n') });

  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const p of parts) {
    let name = p.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet';
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    const rows = Papa.parse<string[]>(p.csv.trim(), { skipEmptyLines: true }).data;
    for (const r of rows) {
      ws.addRow(r.map((v) => {
        const t = String(v ?? '').trim();
        // Số có 0 ở đầu (số điện thoại, mã) giữ là chữ — đổi sang số sẽ mất số 0.
        return NUM.test(t) && !/^-?0\d/.test(t) && t.replace(/[,.-]/g, '').length <= 15 ? Number(t.replace(/,/g, '')) : v;
      }));
    }
    if (rows.length) {
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      const width = Math.max(...rows.map((r) => r.length));
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: width } };
      for (let c = 1; c <= width; c++) {
        const max = Math.max(...rows.slice(0, 500).map((r) => String(r[c - 1] ?? '').length));
        ws.getColumn(c).width = Math.min(60, Math.max(8, max + 2));
      }
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Dựng một file theo đuôi tên. Chỉ docx / xlsx — các loại khác portal tự dựng. */
export async function buildExport(name: unknown, content: unknown): Promise<{ data: string; mime: string }> {
  const n = typeof name === 'string' ? name.trim() : '';
  const ext = (/\.([a-z0-9]+)$/i.exec(n)?.[1] ?? '').toLowerCase();
  if (typeof content !== 'string') throw new Error('Thiếu nội dung file.');
  if (content.length > EXPORT_MAX_CHARS) throw new Error(`Nội dung dài quá ${EXPORT_MAX_CHARS.toLocaleString('vi-VN')} ký tự.`);
  if (ext === 'docx') return { data: (await markdownToDocx(content)).toString('base64'), mime: MIME.docx };
  if (ext === 'xlsx') return { data: (await csvToXlsx(content)).toString('base64'), mime: MIME.xlsx };
  throw new Error(`Server chỉ dựng .docx / .xlsx (nhận "${n}").`);
}
