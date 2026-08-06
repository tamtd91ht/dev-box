// Tiện ích thuần tính toán cho Word workspace: mục lục, đếm chữ, tìm kiếm,
// và dựng bản in. Không đụng tới React hay DOM của trình duyệt (trừ hàm dựng
// HTML để in), nên dễ đọc và dễ kiểm chứng.

import type { HeaderFooter, PageSetup, RunSpan, WordBlock } from './word';
import { runsText } from './word';

// ── Mục lục ──────────────────────────────────────────────────────────────────

export interface OutlineEntry {
  /** Chỉ số block trong tài liệu. */
  i: number;
  /** 0 = Title, 1..4 = Heading1..4. */
  level: number;
  text: string;
}

/** Rút mục lục từ các đoạn mang style Title / Heading1-4. */
export function buildOutline(blocks: WordBlock[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  blocks.forEach((b, i) => {
    if (b.kind !== 'p') return;
    const style = (b.fmt?.style ?? '').toLowerCase();
    let level: number | null = null;
    if (style === 'title') level = 0;
    else if (style.startsWith('heading')) {
      const n = Number.parseInt(style.slice(7), 10);
      if (Number.isInteger(n) && n >= 1 && n <= 4) level = n;
    }
    if (level === null) return;
    const text = runsText(b.runs).trim();
    if (text === '') return;
    out.push({ i, level, text });
  });
  return out;
}

// ── Thống kê ─────────────────────────────────────────────────────────────────

export interface DocStats {
  words: number;
  chars: number;
  /** Số đoạn văn có nội dung (không tính đoạn trống). */
  paras: number;
  tables: number;
  /** Số trang ước tính — theo số dòng chứ không phải bố cục thật của Word. */
  pages: number;
}

/** Đếm từ theo khoảng trắng — đủ đúng cho cả tiếng Việt lẫn tiếng Anh. */
function countWords(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

export function docStats(blocks: WordBlock[], page: PageSetup): DocStats {
  let words = 0;
  let chars = 0;
  let paras = 0;
  let tables = 0;
  let lines = 0;
  let breaks = 0;

  /** Số dòng một đoạn chiếm, ước theo bề rộng vùng chữ. */
  const usableWidthPt = Math.max(120, page.w - page.ml - page.mr);
  const charsPerLine = Math.max(20, Math.round(usableWidthPt / 5.2));

  for (const b of blocks) {
    if (b.kind === 'br') { breaks++; continue; }
    if (b.kind === 'tbl') {
      tables++;
      for (const row of b.rows) {
        let rowChars = 0;
        for (const cell of row) {
          for (const p of cell.paras) {
            const t = runsText(p.runs);
            words += countWords(t);
            chars += t.length;
            rowChars = Math.max(rowChars, t.length);
          }
        }
        lines += Math.max(1, Math.ceil(rowChars / Math.max(10, charsPerLine / Math.max(1, row.length))));
      }
      lines += 1;
      continue;
    }
    const t = runsText(b.runs);
    if (t.trim() !== '') paras++;
    words += countWords(t);
    chars += t.length;
    lines += t.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  }

  const usableHeightPt = Math.max(200, page.h - page.mt - page.mb);
  const linesPerPage = Math.max(10, Math.floor(usableHeightPt / 16));
  const pages = Math.max(1, Math.ceil(lines / linesPerPage) + breaks);

  return { words, chars, paras, tables, pages };
}

// ── Tìm kiếm ─────────────────────────────────────────────────────────────────

export interface SearchOptions {
  matchCase: boolean;
  whole: boolean;
}

export interface SearchHit {
  /** Chỉ số block. */
  i: number;
  /** Offset trong plain text của block (đoạn) — bảng thì là ô đầu khớp. */
  from: number;
  to: number;
  /** Với bảng: vị trí ô khớp. */
  cell?: { r: number; c: number };
}

export function buildSearchRegex(find: string, opts: SearchOptions): RegExp | null {
  if (find === '') return null;
  const esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = opts.whole ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc;
  const flags = `g${opts.matchCase ? '' : 'i'}`;
  try {
    return new RegExp(body, `${flags}u`);
  } catch {
    // Trình duyệt quá cũ không có lookbehind — bỏ tùy chọn "nguyên từ".
    try { return new RegExp(esc, flags); } catch { return null; }
  }
}

/** Quét toàn tài liệu, trả về mọi vị trí khớp theo thứ tự đọc. */
export function findAll(blocks: WordBlock[], find: string, opts: SearchOptions): SearchHit[] {
  const re = buildSearchRegex(find, opts);
  if (!re) return [];
  const hits: SearchHit[] = [];

  const scan = (text: string, push: (from: number, to: number) => void) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      push(m.index, m.index + m[0].length);
    }
  };

  blocks.forEach((b, i) => {
    if (b.kind === 'p') {
      // Đoạn khóa (ảnh / link / field) server sẽ KHÔNG thay — bỏ qua luôn ở
      // đây để số đếm và bản xem trước khớp đúng những gì sẽ ghi vào file.
      if (b.locked) return;
      scan(runsText(b.runs), (from, to) => hits.push({ i, from, to }));
    } else if (b.kind === 'tbl') {
      b.rows.forEach((row, r) => {
        row.forEach((cell, c) => {
          if (cell.locked) return;
          const text = cell.paras.map((p) => runsText(p.runs)).join('\n');
          scan(text, (from, to) => hits.push({ i, from, to, cell: { r, c } }));
        });
      });
    }
  });
  return hits;
}

/** Thay thế trong plain text của một đoạn, giữ nguyên định dạng cụm đầu tiên
 *  của mỗi vùng khớp (giống cách server làm khi lưu). */
export function replaceInRuns(runs: RunSpan[], find: string, replace: string, opts: SearchOptions): RunSpan[] | null {
  const re = buildSearchRegex(find, opts);
  if (!re) return null;
  const text = runsText(runs);
  re.lastIndex = 0;
  if (!re.test(text)) return null;
  re.lastIndex = 0;

  const out: RunSpan[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;

  const pushSlice = (from: number, to: number) => {
    if (to <= from) return;
    let pos = 0;
    for (const r of runs) {
      const end = pos + r.t.length;
      if (end > from && pos < to) {
        const slice = r.t.slice(Math.max(0, from - pos), Math.min(r.t.length, to - pos));
        if (slice) out.push({ t: slice, ...(r.f ? { f: r.f } : {}) });
      }
      pos = end;
    }
  };
  const formatAt = (at: number): RunSpan['f'] => {
    let pos = 0;
    for (const r of runs) {
      const end = pos + r.t.length;
      if (at < end) return r.f;
      pos = end;
    }
    return runs[runs.length - 1]?.f;
  };

  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    pushSlice(cursor, m.index);
    if (replace !== '') {
      const f = formatAt(m.index);
      out.push({ t: replace, ...(f ? { f } : {}) });
    }
    cursor = m.index + m[0].length;
  }
  pushSlice(cursor, text.length);
  return out;
}

// ── Bản in / xuất PDF ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function runHtml(r: RunSpan): string {
  const f = r.f;
  const css: string[] = [];
  if (f?.b) css.push('font-weight:700');
  if (f?.i) css.push('font-style:italic');
  if (f?.u && f?.st) css.push('text-decoration:underline line-through');
  else if (f?.u) css.push('text-decoration:underline');
  else if (f?.st) css.push('text-decoration:line-through');
  if (f?.fc) css.push(`color:${f.fc}`);
  if (f?.hl) css.push(`background:${f.hl}`);
  else if (f?.bg) css.push(`background:${f.bg}`);
  if (f?.fs) css.push(`font-size:${f.fs}pt`);
  if (f?.ff) css.push(`font-family:'${f.ff}',serif`);
  if (f?.caps) css.push('text-transform:uppercase');
  if (f?.smallCaps) css.push('font-variant:small-caps');
  const text = escapeHtml(r.t).replace(/\n/g, '<br/>').replace(/\t/g, '&emsp;');
  return css.length ? `<span style="${css.join(';')}">${text}</span>` : text;
}

function paraCss(fmt: WordBlock extends { fmt?: infer F } ? F : never): string {
  const f = fmt as { jc?: string; ls?: number; sb?: number; sa?: number; il?: number; ifl?: number } | undefined;
  if (!f) return '';
  const css: string[] = [];
  const jc = { l: 'left', c: 'center', r: 'right', j: 'justify' }[f.jc ?? ''] ?? '';
  if (jc) css.push(`text-align:${jc}`);
  if (f.ls) css.push(`line-height:${f.ls}`);
  if (f.sb) css.push(`margin-top:${f.sb}pt`);
  if (f.sa) css.push(`margin-bottom:${f.sa}pt`);
  if (f.il) css.push(`margin-left:${f.il}pt`);
  if (f.ifl) css.push(`text-indent:${f.ifl}pt`);
  return css.join(';');
}

const HEADING_TAG: Record<string, string> = {
  title: 'h1', heading1: 'h2', heading2: 'h3', heading3: 'h4', heading4: 'h5',
};

/**
 * Dựng một trang HTML độc lập của tài liệu để in hoặc "Save as PDF".
 * Đây là bản dựng lại theo mô hình đang hiển thị — bố cục trang có thể lệch
 * đôi chút so với Word, nhưng nội dung và định dạng chữ thì đúng.
 */
export function buildPrintHtml(
  blocks: WordBlock[], page: PageSetup, headers: HeaderFooter[], footers: HeaderFooter[], title: string,
): string {
  const header = headers.find((h) => h.type === 'default');
  const footer = footers.find((f) => f.type === 'default');
  let ordinal = 0;

  const body = blocks.map((b) => {
    if (b.kind === 'br') { ordinal = 0; return '<div style="page-break-after:always"></div>'; }
    if (b.kind === 'tbl') {
      ordinal = 0;
      const rows = b.rows.map((row, ri) => {
        const cells = row.map((cell) => {
          if (cell.vMerged) return '';
          const css = [
            cell.bg ? `background:${cell.bg}` : '',
            cell.va ? `vertical-align:${{ t: 'top', m: 'middle', b: 'bottom' }[cell.va]}` : '',
          ].filter(Boolean).join(';');
          const inner = cell.paras
            .map((p) => `<p style="margin:0;${paraCss(p.fmt as never)}">${p.runs.map(runHtml).join('')}</p>`)
            .join('');
          const tag = b.headerRow && ri === 0 ? 'th' : 'td';
          return `<${tag}${cell.span ? ` colspan="${cell.span}"` : ''}${css ? ` style="${css}"` : ''}>${inner}</${tag}>`;
        }).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      return `<table class="${b.bordered === false ? 'plain' : ''}">${rows}</table>`;
    }

    const style = (b.fmt?.style ?? '').toLowerCase();
    const tag = HEADING_TAG[style] ?? 'p';
    const css = paraCss(b.fmt as never);
    const inner = b.runs.map(runHtml).join('') || '&nbsp;';

    if (b.fmt?.list) {
      const marker = b.fmt.list === 'bullet'
        ? ['•', 'o', '▪'][(b.fmt.lvl ?? 0) % 3]
        : `${++ordinal}.`;
      const indent = 18 * ((b.fmt.lvl ?? 0) + 1);
      return `<p class="li" style="${css};margin-left:${indent}pt">`
        + `<span class="mk">${marker}</span>${inner}</p>`;
    }
    ordinal = 0;
    return `<${tag}${css ? ` style="${css}"` : ''}>${inner}</${tag}>`;
  }).join('\n');

  const hfText = (hf: HeaderFooter | undefined) => {
    if (!hf) return '';
    const text = hf.paras.map((p) => runsText(p.runs)).join(' ').trim();
    return escapeHtml(text) + (hf.hasPageNum ? ' <span class="pnum"></span>' : '');
  };

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${page.w}pt ${page.h}pt; margin: ${page.mt}pt ${page.mr}pt ${page.mb}pt ${page.ml}pt; }
  body { font-family: 'Times New Roman', serif; font-size: 13pt; line-height: 1.45; color: #000; margin: 0; }
  .sheet { max-width: ${page.w - page.ml - page.mr}pt; margin: 0 auto; padding: 24pt 0; }
  h1 { font-size: 20pt; text-align: center; margin: 0 0 12pt; }
  h2 { font-size: 16pt; margin: 14pt 0 8pt; }
  h3 { font-size: 14pt; margin: 12pt 0 6pt; }
  h4, h5 { font-size: 13pt; margin: 10pt 0 6pt; }
  p { margin: 0 0 6pt; }
  p.li { position: relative; }
  p.li .mk { display: inline-block; min-width: 18pt; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; }
  th, td { border: 1px solid #9ca3af; padding: 4pt 6pt; font-size: 12.5pt; vertical-align: top; }
  th { background: #e8edf3; font-weight: 700; text-align: center; }
  table.plain th, table.plain td { border: none; }
  .hf { color: #444; font-size: 11pt; text-align: center; padding: 6pt 0; }
  .hf.top { border-bottom: 1px solid #ddd; margin-bottom: 12pt; }
  .hf.bot { border-top: 1px solid #ddd; margin-top: 12pt; }
  @media print { .hf { color: #000; } }
</style></head><body><div class="sheet">
${header ? `<div class="hf top">${hfText(header)}</div>` : ''}
${body}
${footer ? `<div class="hf bot">${hfText(footer)}</div>` : ''}
</div></body></html>`;
}
