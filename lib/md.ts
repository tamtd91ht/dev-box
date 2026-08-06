// Markdown → HTML cho tab Tools (nút 👁 Preview ở kind='md').
//
// Một bộ CommonMark rút gọn, KHÔNG phụ thuộc thư viện ngoài: heading ATX,
// code fence + code thụt lề, blockquote, danh sách (lồng nhau, task list),
// bảng, đường kẻ ngang, và các span inline (code, đậm, nghiêng, gạch ngang,
// link, ảnh, autolink).
//
// AN TOÀN: toàn bộ nguồn được escape TRƯỚC, sau đó chỉ sinh ra thẻ của chính
// nó — nên HTML thô trong file hiện ra dạng chữ và không bao giờ chạy được;
// href/src chỉ nhận scheme vô hại (chặn javascript: / data:). Browser-safe.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Only allow href/src schemes that can't run script. */
function safeUrl(raw: string): string | null {
  const u = raw.trim();
  if (u === '') return null;
  if (/^(https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i.test(u)) return u;
  // Bare relative path (no scheme) is fine; anything with a scheme is not.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return null;
}

/** Inline spans. Input MUST already be HTML-escaped. */
function inline(src: string): string {
  let s = src;

  // Code spans first — their contents are literal, so stash them out of reach
  // of every other rule and restore at the end.
  const codes: string[] = [];
  s = s.replace(/(`+)([\s\S]*?)\1/g, (_m, _t, body: string) => {
    codes.push(`<code>${body.replace(/^ | $/g, '')}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // Images before links — ![alt](src "title")
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, alt: string, src: string) => {
    const u = safeUrl(src);
    return u ? `<img src="${u}" alt="${alt}" />` : m;
  });
  // Links — [text](href "title")
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, text: string, href: string) => {
    const u = safeUrl(href);
    return u ? `<a href="${u}" target="_blank" rel="noreferrer noopener">${text}</a>` : m;
  });
  // Autolinks — <https://…> (angle brackets arrive escaped)
  s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (m, href: string) => {
    const u = safeUrl(href);
    return u ? `<a href="${u}" target="_blank" rel="noreferrer noopener">${href}</a>` : m;
  });

  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/ {2,}$/gm, '<br />'); // hard line break

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

/** Split a table row into cells, honouring escaped pipes. */
function cells(row: string): string[] {
  return row.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const ALIGN = (spec: string): string => {
  const l = spec.startsWith(':');
  const r = spec.endsWith(':');
  if (l && r) return ' style="text-align:center"';
  if (r) return ' style="text-align:right"';
  if (l) return ' style="text-align:left"';
  return '';
};

/**
 * Render Markdown to a safe HTML string. Block-level parse over the escaped
 * source; list nesting is driven by indent width.
 */
export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  /** Open list stack: indent column + tag, so nesting closes in order. */
  const lists: { indent: number; tag: 'ul' | 'ol' }[] = [];
  let para: string[] = [];
  let quote: string[] | null = null;

  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) {
      out.push(`</${lists.pop()!.tag}>`);
    }
  };
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const flushQuote = () => {
    if (quote) { out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`); quote = null; }
  };
  const flushAll = () => { flushPara(); flushQuote(); closeLists(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code — ```lang … ``` (or ~~~). Contents stay literal.
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      flushAll();
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      const lang = fence[2] ? ` class="language-${fence[2]}"` : '';
      out.push(`<pre><code${lang}>${buf.join('\n')}</code></pre>`);
      continue;
    }

    if (line.trim() === '') { flushPara(); flushQuote(); continue; }

    // Thematic break — ***, ---, ___ (before setext/list, after empty check)
    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr />'); continue; }

    // ATX heading — # … ######
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    // Blockquote — buffer the whole run, then render it recursively.
    const bq = /^ {0,3}&gt;\s?(.*)$/.exec(line);
    if (bq) { flushPara(); closeLists(); (quote ??= []).push(bq[1]); continue; }
    flushQuote();

    // Table — header row + delimiter row (| --- | :--: |)
    if (line.includes('|') && i + 1 < lines.length
        && /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushAll();
      const head = cells(line.trim());
      const spec = cells(lines[i + 1].trim()).map(ALIGN);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(cells(lines[i].trim()));
        i++;
      }
      i--; // the loop's i++ consumes the terminator
      const th = head.map((c, ci) => `<th${spec[ci] ?? ''}>${inline(c)}</th>`).join('');
      const tb = rows
        .map((r) => `<tr>${head.map((_, ci) => `<td${spec[ci] ?? ''}>${inline(r[ci] ?? '')}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // List item — bullet (-, *, +) or ordered (1. / 1))
    const li = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const indent = li[1].replace(/\t/g, '    ').length;
      const tag: 'ul' | 'ol' = li[2] ? 'ul' : 'ol';
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (!top || top.indent < indent) {
        const start = tag === 'ol' && li[3] !== '1' ? ` start="${Number(li[3])}"` : '';
        out.push(`<${tag}${start}>`);
        lists.push({ indent, tag });
      } else if (top.tag !== tag) {
        out.push(`</${top.tag}>`);
        lists[lists.length - 1] = { indent, tag };
        out.push(`<${tag}>`);
      }
      // GitHub task list — [ ] / [x]
      const task = /^\[([ xX])\]\s+(.*)$/.exec(li[4]);
      if (task) {
        const on = task[1] !== ' ' ? ' checked' : '';
        out.push(`<li class="md-task"><input type="checkbox" disabled${on} />${inline(task[2])}</li>`);
      } else {
        out.push(`<li>${inline(li[4])}</li>`);
      }
      continue;
    }

    // Lazy continuation of the current list item, else a paragraph line.
    if (lists.length && /^\s+\S/.test(line) && out[out.length - 1]?.startsWith('<li')) {
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '') + ' ' + inline(line.trim()) + '</li>';
      continue;
    }
    closeLists();
    para.push(line.trim());
  }

  flushAll();
  return out.join('\n');
}
