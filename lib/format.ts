// Client-side formatters cho tab Tools: JSON / XML / HTML pretty-print.
// Browser-safe (Monaco render + highlight, đây chỉ lo phần indent/normalize).
//
// - JSON: JSON.parse → stringify 2 space (báo lỗi vị trí nếu parse fail).
// - XML/HTML: pretty-print bằng bộ indent tự viết theo token < > — không dựng
//   cây DOM (tránh @xmldom nuốt lỗi + đổi ngữ nghĩa HTML), giữ nguyên text,
//   chỉ xuống dòng + thụt lề giữa các tag. Đủ đẹp để đọc; không phải chuẩn hoá.

export type FormatKind = 'json' | 'xml' | 'html' | 'text';

export interface FormatResult {
  ok: boolean;
  text: string;
  /** Lỗi parse (JSON) — kèm dòng/cột nếu suy ra được. */
  error?: string;
}

function formatJson(src: string): FormatResult {
  const s = src.trim();
  if (!s) return { ok: true, text: '' };
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(s), null, 2) };
  } catch (e) {
    const msg = (e as Error).message;
    // "... at position 123" → suy ra dòng/cột cho dễ tìm.
    const m = /position (\d+)/.exec(msg);
    if (m) {
      const pos = Number(m[1]);
      const before = s.slice(0, pos);
      const line = before.split('\n').length;
      const col = pos - before.lastIndexOf('\n');
      return { ok: false, text: src, error: `JSON không hợp lệ (dòng ${line}, cột ${col}): ${msg}` };
    }
    return { ok: false, text: src, error: `JSON không hợp lệ: ${msg}` };
  }
}

// Thẻ HTML rỗng (void) — không có thẻ đóng nên không tăng indent.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
// Thẻ HTML giữ nguyên nội dung (không reindent bên trong).
const RAW_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

function formatMarkup(src: string, isHtml: boolean): FormatResult {
  const s = src.trim();
  if (!s) return { ok: true, text: '' };

  // Tách thành token: mỗi thẻ <...> là một token, text giữa các thẻ là một token.
  const tokens = s.replace(/>\s+</g, '><').match(/<[^>]+>|[^<]+/g);
  if (!tokens) return { ok: true, text: s };

  const INDENT = '  ';
  const out: string[] = [];
  let depth = 0;
  let rawTag: string | null = null; // đang trong <pre>/<script>… thì gom nguyên

  const pad = (n: number) => INDENT.repeat(Math.max(0, n));

  for (const tokRaw of tokens) {
    const tok = tokRaw.trim();
    if (!tok) continue;

    // Trong khối raw: append nguyên văn tới khi gặp thẻ đóng của nó.
    if (rawTag) {
      const closeRe = new RegExp(`^</${rawTag}\\b`, 'i');
      if (closeRe.test(tok)) {
        depth = Math.max(0, depth - 1);
        out.push(pad(depth) + tok);
        rawTag = null;
      } else {
        out.push(pad(depth + 1) + tok);
      }
      continue;
    }

    if (!tok.startsWith('<')) {
      out.push(pad(depth) + tok); // text node
      continue;
    }

    const isClose = /^<\//.test(tok);
    const isSelfClose = /\/>$/.test(tok) || /^<\?/.test(tok) || /^<!/.test(tok);
    const nameMatch = /^<\/?\s*([a-zA-Z0-9:-]+)/.exec(tok);
    const name = nameMatch ? nameMatch[1].toLowerCase() : '';
    const isVoid = isHtml && VOID_TAGS.has(name);

    if (isClose) {
      depth = Math.max(0, depth - 1);
      out.push(pad(depth) + tok);
    } else if (isSelfClose || isVoid) {
      out.push(pad(depth) + tok);
    } else {
      out.push(pad(depth) + tok);
      if (isHtml && RAW_TAGS.has(name)) rawTag = name;
      depth += 1;
    }
  }

  return { ok: true, text: out.join('\n') };
}

export function formatText(kind: FormatKind, src: string): FormatResult {
  if (kind === 'text') return { ok: true, text: src }; // plain text — không format
  if (kind === 'json') return formatJson(src);
  return formatMarkup(src, kind === 'html');
}

/** Đoán kind từ ĐUÔI FILE + NỘI DUNG (khi mở file local): json/xml/html rõ ràng
 *  thì render đúng tab, còn lại là full text. */
export function detectKind(filename: string, content: string): FormatKind {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'xml' || ext === 'svg') return 'xml';
  if (ext === 'html' || ext === 'htm') return 'html';
  const s = content.trimStart().slice(0, 4096);
  if (s.startsWith('{') || s.startsWith('[')) {
    try { JSON.parse(content); return 'json'; } catch { /* không phải JSON */ }
  }
  if (/^<!doctype html/i.test(s) || /^<html[\s>]/i.test(s)) return 'html';
  if (s.startsWith('<')) return 'xml';
  return 'text';
}

/** Rút gọn JSON về một dòng (minify) — tiện đối chiếu / copy. */
export function minifyJson(src: string): FormatResult {
  const s = src.trim();
  if (!s) return { ok: true, text: '' };
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(s)) };
  } catch (e) {
    return { ok: false, text: src, error: `JSON không hợp lệ: ${(e as Error).message}` };
  }
}

/** Ngôn ngữ Monaco theo kind (để highlight). */
export const monacoLangFor = (kind: FormatKind): string =>
  kind === 'json' ? 'json' : kind === 'html' ? 'html' : kind === 'text' ? 'plaintext' : 'xml';
