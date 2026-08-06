// Server-only: the XML parts of a newly created .docx, plus the report
// templates offered in the "＋ File mới" dialog.
//
// A blank Word document needs surprisingly little: content types, the package
// relationship, the document body, and — so headings and titles actually look
// like headings — a styles part. We ship a small Vietnamese-office-friendly
// style set (Times New Roman 13pt body, numbered headings) that Word and
// LibreOffice both honour.

import type { WordTemplate } from './word';

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS_URI = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Escape text destined for an XML text node / attribute value. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── styles.xml ───────────────────────────────────────────────────────────────

/** One `w:style` entry. Sizes are in points; converted to half-points here. */
function style(id: string, name: string, opts: {
  basedOn?: string; next?: string; heading?: number;
  size?: number; bold?: boolean; italic?: boolean; color?: string; font?: string;
  before?: number; after?: number; line?: number; jc?: string; keepNext?: boolean;
  isDefault?: boolean; type?: 'paragraph' | 'character';
}): string {
  // Thứ tự các phần tử trong <w:pPr> phải đúng schema CT_PPr, nếu không Word
  // báo file hỏng: keepNext → spacing → jc → outlineLvl.
  const pPr: string[] = [];
  if (opts.keepNext) pPr.push('<w:keepNext/><w:keepLines/>');
  if (opts.before !== undefined || opts.after !== undefined || opts.line !== undefined) {
    const parts = [
      opts.before !== undefined ? `w:before="${Math.round(opts.before * 20)}"` : '',
      opts.after !== undefined ? `w:after="${Math.round(opts.after * 20)}"` : '',
      opts.line !== undefined ? `w:line="${Math.round(opts.line * 240)}" w:lineRule="auto"` : '',
    ].filter(Boolean).join(' ');
    pPr.push(`<w:spacing ${parts}/>`);
  }
  if (opts.jc) pPr.push(`<w:jc w:val="${opts.jc}"/>`);
  if (opts.heading !== undefined) pPr.push(`<w:outlineLvl w:val="${opts.heading - 1}"/>`);

  const rPr: string[] = [];
  if (opts.font) rPr.push(`<w:rFonts w:ascii="${opts.font}" w:hAnsi="${opts.font}" w:cs="${opts.font}"/>`);
  if (opts.bold) rPr.push('<w:b/>');
  if (opts.italic) rPr.push('<w:i/>');
  if (opts.color) rPr.push(`<w:color w:val="${opts.color}"/>`);
  if (opts.size !== undefined) {
    const hp = Math.round(opts.size * 2);
    rPr.push(`<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`);
  }

  return [
    `<w:style w:type="${opts.type ?? 'paragraph'}"${opts.isDefault ? ' w:default="1"' : ''} w:styleId="${id}">`,
    `<w:name w:val="${name}"/>`,
    opts.basedOn ? `<w:basedOn w:val="${opts.basedOn}"/>` : '',
    opts.next ? `<w:next w:val="${opts.next}"/>` : '',
    pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '',
    rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '',
    '</w:style>',
  ].join('');
}

/** Body font for new documents — the Vietnamese office standard. */
const BODY_FONT = 'Times New Roman';
const BODY_SIZE = 13;

const STYLES_XML = `${XML_DECL}<w:styles xmlns:w="${W_NS}">`
  + '<w:docDefaults><w:rPrDefault><w:rPr>'
  + `<w:rFonts w:ascii="${BODY_FONT}" w:hAnsi="${BODY_FONT}" w:cs="${BODY_FONT}"/>`
  + `<w:sz w:val="${BODY_SIZE * 2}"/><w:szCs w:val="${BODY_SIZE * 2}"/>`
  + '<w:lang w:val="vi-VN"/>'
  + '</w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
  + '</w:docDefaults>'
  + style('Normal', 'Normal', { isDefault: true })
  + style('Title', 'Title', { basedOn: 'Normal', next: 'Normal', size: 20, bold: true, jc: 'center', after: 12, keepNext: true })
  + style('Subtitle', 'Subtitle', { basedOn: 'Normal', next: 'Normal', size: 13, italic: true, jc: 'center', after: 18, color: '444444' })
  + style('Heading1', 'heading 1', { basedOn: 'Normal', next: 'Normal', heading: 1, size: 16, bold: true, before: 14, after: 8, keepNext: true })
  + style('Heading2', 'heading 2', { basedOn: 'Normal', next: 'Normal', heading: 2, size: 14, bold: true, before: 12, after: 6, keepNext: true })
  + style('Heading3', 'heading 3', { basedOn: 'Normal', next: 'Normal', heading: 3, size: 13, bold: true, italic: true, before: 10, after: 6, keepNext: true })
  + style('Heading4', 'heading 4', { basedOn: 'Normal', next: 'Normal', heading: 4, size: 13, italic: true, before: 8, after: 4, keepNext: true })
  + style('Quote', 'Quote', { basedOn: 'Normal', next: 'Normal', italic: true, color: '444444' })
  + style('Caption', 'caption', { basedOn: 'Normal', next: 'Normal', size: 11, italic: true, jc: 'center', color: '444444' })
  + style('ListParagraph', 'List Paragraph', { basedOn: 'Normal' })
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>'
  + '<w:tblPr><w:tblBorders>'
  + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>`).join('')
  + '</w:tblBorders></w:tblPr></w:style>'
  + '</w:styles>';

// ── Body builders ────────────────────────────────────────────────────────────

interface ParaOpts {
  style?: string;
  jc?: 'left' | 'center' | 'right' | 'both';
  bold?: boolean; italic?: boolean; size?: number;
  before?: number; after?: number;
}

/** One `<w:p>` with plain text. */
function para(text: string, o: ParaOpts = {}): string {
  const pPr: string[] = [];
  if (o.style) pPr.push(`<w:pStyle w:val="${o.style}"/>`);
  if (o.before !== undefined || o.after !== undefined) {
    const parts = [
      o.before !== undefined ? `w:before="${Math.round(o.before * 20)}"` : '',
      o.after !== undefined ? `w:after="${Math.round(o.after * 20)}"` : '',
    ].filter(Boolean).join(' ');
    pPr.push(`<w:spacing ${parts}/>`);
  }
  if (o.jc) pPr.push(`<w:jc w:val="${o.jc}"/>`);

  const rPr: string[] = [];
  if (o.bold) rPr.push('<w:b/>');
  if (o.italic) rPr.push('<w:i/>');
  if (o.size !== undefined) rPr.push(`<w:sz w:val="${o.size * 2}"/><w:szCs w:val="${o.size * 2}"/>`);
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';

  const run = text === '' ? '' : `<w:r>${rPrXml}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${run}</w:p>`;
}

/** A table from a header row + body rows, sized to the text width. */
function table(header: string[], rows: string[][]): string {
  const total = 9360;
  const w = Math.floor(total / header.length);
  const cell = (text: string, isHead: boolean) => {
    const shd = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EDF3"/><w:vAlign w:val="center"/>' : '';
    const rPr = isHead ? '<w:rPr><w:b/></w:rPr>' : '';
    const jc = isHead ? '<w:jc w:val="center"/>' : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${shd}</w:tcPr>`
      + `<w:p><w:pPr>${jc}${rPr}</w:pPr>`
      + (text === '' ? '' : `<w:r>${isHead ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`)
      + '</w:p></w:tc>';
  };
  const grid = header.map(() => `<w:gridCol w:w="${w}"/>`).join('');
  const headRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${header.map((h) => cell(h, true)).join('')}</w:tr>`;
  const bodyRows = rows.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join('')}</w:tr>`).join('');
  return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>'
    + '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>`).join('')
    + '</w:tblBorders></w:tblPr>'
    + `<w:tblGrid>${grid}</w:tblGrid>${headRow}${bodyRows}</w:tbl>`;
}

/** A4 portrait, 2cm margins — and the footer reference when one is present. */
function sectPr(withFooter: boolean): string {
  return '<w:sectPr>'
    + (withFooter ? `<w:footerReference xmlns:r="${R_NS_URI}" w:type="default" r:id="rIdFooter"/>` : '')
    + '<w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/>'
    + '</w:sectPr>';
}

// ── Templates ────────────────────────────────────────────────────────────────

/** The Vietnamese national-emblem header block every official document opens
 *  with: agency name on the left, the motto on the right. Rendered as a
 *  borderless two-column table so the two blocks sit side by side. */
function nationalHeader(): string {
  const cell = (lines: { text: string; bold?: boolean; underline?: boolean }[], w: number) => {
    const paras = lines.map((l) => {
      const rPr = `<w:rPr>${l.bold ? '<w:b/>' : ''}${l.underline ? '<w:u w:val="single"/>' : ''}</w:rPr>`;
      return `<w:p><w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/>${rPr}</w:pPr>`
        + `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(l.text)}</w:t></w:r></w:p>`;
    }).join('');
    return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${paras}</w:tc>`;
  };
  const noBorders = '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`).join('')
    + '</w:tblBorders>';
  return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' + noBorders + '</w:tblPr>'
    + '<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="5360"/></w:tblGrid><w:tr>'
    + cell([
      { text: 'CÔNG TY ………………', bold: true },
      { text: 'PHÒNG ………………', bold: true },
      { text: '———————', bold: false },
    ], 4000)
    + cell([
      { text: 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', bold: true },
      { text: 'Độc lập - Tự do - Hạnh phúc', bold: true, underline: true },
      { text: '———————', bold: false },
    ], 5360)
    + '</w:tr></w:tbl>';
}

function bodyFor(template: WordTemplate): string {
  switch (template) {
    case 'report':
      return [
        nationalHeader(),
        para(''),
        para('BÁO CÁO CÔNG VIỆC', { style: 'Title' }),
        para('(Tuần …/… — từ ngày …/…/…… đến ngày …/…/……)', { style: 'Subtitle' }),
        para('Kính gửi: Ban Giám đốc', { bold: true }),
        para('Người báo cáo: ………………………    Bộ phận: ………………………'),
        para('I. TỔNG QUAN', { style: 'Heading1' }),
        para('Nêu ngắn gọn tình hình chung trong kỳ báo cáo.'),
        para('II. KẾT QUẢ CÔNG VIỆC', { style: 'Heading1' }),
        table(
          ['TT', 'Nội dung công việc', 'Kết quả', 'Tiến độ', 'Ghi chú'],
          [['1', '', '', '', ''], ['2', '', '', '', ''], ['3', '', '', '', '']],
        ),
        para(''),
        para('III. KHÓ KHĂN, VƯỚNG MẮC', { style: 'Heading1' }),
        para('…'),
        para('IV. KẾ HOẠCH KỲ TỚI', { style: 'Heading1' }),
        para('…'),
        para('V. ĐỀ XUẤT, KIẾN NGHỊ', { style: 'Heading1' }),
        para('…'),
        para(''),
        signatureBlock('NGƯỜI BÁO CÁO'),
      ].join('');

    case 'minutes':
      return [
        nationalHeader(),
        para(''),
        para('BIÊN BẢN CUỘC HỌP', { style: 'Title' }),
        para('Số: ……/BB-……', { style: 'Subtitle' }),
        para('Thời gian: … giờ … phút, ngày …/…/……'),
        para('Địa điểm: ………………………………………'),
        para('Chủ trì: ………………………    Thư ký: ………………………'),
        para('I. THÀNH PHẦN THAM DỰ', { style: 'Heading1' }),
        table(['TT', 'Họ và tên', 'Chức vụ', 'Đơn vị'], [['1', '', '', ''], ['2', '', '', '']]),
        para(''),
        para('II. NỘI DUNG CUỘC HỌP', { style: 'Heading1' }),
        para('…'),
        para('III. Ý KIẾN THẢO LUẬN', { style: 'Heading1' }),
        para('…'),
        para('IV. KẾT LUẬN', { style: 'Heading1' }),
        para('…'),
        para('V. PHÂN CÔNG THỰC HIỆN', { style: 'Heading1' }),
        table(
          ['TT', 'Công việc', 'Người phụ trách', 'Thời hạn'],
          [['1', '', '', ''], ['2', '', '', '']],
        ),
        para(''),
        para('Cuộc họp kết thúc lúc … giờ … phút cùng ngày. Biên bản đã được đọc lại cho các thành viên cùng nghe và nhất trí thông qua.'),
        para(''),
        twoSignatures('THƯ KÝ', 'CHỦ TRÌ CUỘC HỌP'),
      ].join('');

    case 'proposal':
      return [
        nationalHeader(),
        para(''),
        para('TỜ TRÌNH', { style: 'Title' }),
        para('V/v ………………………………………', { style: 'Subtitle' }),
        para('Kính gửi: Ban Giám đốc', { bold: true }),
        para('I. CĂN CỨ ĐỀ XUẤT', { style: 'Heading1' }),
        para('…'),
        para('II. NỘI DUNG ĐỀ XUẤT', { style: 'Heading1' }),
        para('…'),
        para('III. DỰ TOÁN KINH PHÍ', { style: 'Heading1' }),
        table(
          ['TT', 'Khoản mục', 'Số lượng', 'Đơn giá', 'Thành tiền'],
          [['1', '', '', '', ''], ['2', '', '', '', ''], ['', 'TỔNG CỘNG', '', '', '']],
        ),
        para(''),
        para('IV. KIẾN NGHỊ', { style: 'Heading1' }),
        para('Kính trình Ban Giám đốc xem xét, phê duyệt.'),
        para(''),
        twoSignatures('NGƯỜI ĐỀ XUẤT', 'PHÊ DUYỆT'),
      ].join('');

    default:
      return '<w:p/>';
  }
}

/** Date line + a right-aligned signature column. */
function signatureBlock(role: string): string {
  return para('………, ngày … tháng … năm ……', { jc: 'right', italic: true })
    + para(role, { jc: 'right', bold: true })
    + para('(Ký, ghi rõ họ tên)', { jc: 'right', italic: true, size: 11 })
    + para('') + para('') + para('');
}

/** Two signature columns side by side, as a borderless table. */
function twoSignatures(left: string, right: string): string {
  const col = (title: string) => {
    const p = (t: string, bold?: boolean, italic?: boolean) =>
      `<w:p><w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/></w:pPr>`
      + (t === '' ? '' : `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}</w:rPr>`
        + `<w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r>`) + '</w:p>';
    return '<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>'
      + p(title, true) + p('(Ký, ghi rõ họ tên)', false, true) + p('') + p('') + p('')
      + '</w:tc>';
  };
  const noBorders = '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`).join('')
    + '</w:tblBorders>';
  return para('………, ngày … tháng … năm ……', { jc: 'right', italic: true })
    + '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' + noBorders + '</w:tblPr>'
    + '<w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid>'
    + `<w:tr>${col(left)}${col(right)}</w:tr></w:tbl>`;
}

// ── Footer with automatic page numbers ───────────────────────────────────────

/** Centred "PAGE" field — Word renders the live page number. */
const FOOTER_XML = `${XML_DECL}<w:ftr xmlns:w="${W_NS}">`
  + '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
  + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
  + '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
  + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
  + '<w:r><w:t>1</w:t></w:r>'
  + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  + '</w:p></w:ftr>';

// ── Package assembly ─────────────────────────────────────────────────────────

/** Every part of a new .docx for the chosen template, as name → XML. */
export function newDocxParts(template: WordTemplate): Record<string, string> {
  // Only the report templates get a page-numbered footer; a blank document
  // stays as bare as Word's own "Blank document".
  const withFooter = template !== 'blank';

  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + (withFooter ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '')
    + '</Types>';

  const docRels = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + (withFooter ? '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : '')
    + '</Relationships>';

  const parts: Record<string, string> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>',
    'word/_rels/document.xml.rels': docRels,
    'word/styles.xml': STYLES_XML,
    'word/document.xml': `${XML_DECL}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS_URI}"><w:body>`
      + bodyFor(template) + sectPr(withFooter) + '</w:body></w:document>',
  };
  if (withFooter) parts['word/footer1.xml'] = FOOTER_XML;
  return parts;
}

/** Empty numbering.xml skeleton, added the first time a list is applied. */
export const EMPTY_NUMBERING_XML = `${XML_DECL}<w:numbering xmlns:w="${W_NS}"></w:numbering>`;

/** Header/footer part skeleton for hfSet when the file has none. */
export function emptyHeaderFooterXml(part: 'header' | 'footer'): string {
  const tag = part === 'header' ? 'hdr' : 'ftr';
  return `${XML_DECL}<w:${tag} xmlns:w="${W_NS}"><w:p/></w:${tag}>`;
}

export const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const HEADER_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
export const FOOTER_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';
export const HEADER_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
export const FOOTER_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
