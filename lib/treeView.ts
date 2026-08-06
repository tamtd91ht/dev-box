// Cây dữ liệu cho ô XEM (bên phải) của tab Tools: JSON và XML.
//
// Cả hai định dạng đều quy về CÙNG một kiểu TreeNode để component chỉ phải
// render một thứ. Parser XML tự viết theo token (không dùng @xmldom) cho đồng
// bộ với lib/format.ts và để lỗi cú pháp báo được vị trí thay vì nuốt mất.
//
// Browser-safe: chỉ dựng dữ liệu, không sinh HTML — component tự render bằng
// JSX nên không có đường nào chèn được script.

/** Một nút trong cây xem. `children` rỗng = nút lá. */
export interface TreeNode {
  /** Khoá (JSON) hoặc tên thẻ (XML). Rỗng ở nút gốc. */
  key: string;
  /** Giá trị dạng chữ của nút lá — undefined nếu là nhánh. */
  value?: string;
  /** Kiểu giá trị, dùng để tô màu. */
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'element' | 'text';
  children?: TreeNode[];
  /** Thuộc tính XML (hiện cạnh tên thẻ). */
  attrs?: { name: string; value: string }[];
  /** Số phần tử con — hiện dạng "{3}" / "[5]" khi thu gọn. */
  count?: number;
}

export interface TreeResult {
  ok: boolean;
  root?: TreeNode;
  error?: string;
}

// ── JSON ────────────────────────────────────────────────────────────────────

function nodeOfJson(key: string, v: unknown): TreeNode {
  if (v === null) return { key, value: 'null', type: 'null' };
  if (Array.isArray(v)) {
    return {
      key,
      type: 'array',
      count: v.length,
      children: v.map((item, i) => nodeOfJson(String(i), item)),
    };
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return {
      key,
      type: 'object',
      count: entries.length,
      children: entries.map(([k, item]) => nodeOfJson(k, item)),
    };
  }
  if (typeof v === 'number') return { key, value: String(v), type: 'number' };
  if (typeof v === 'boolean') return { key, value: String(v), type: 'boolean' };
  return { key, value: String(v), type: 'string' };
}

export function jsonTree(src: string): TreeResult {
  const s = src.trim();
  if (!s) return { ok: true, root: { key: '', type: 'object', children: [], count: 0 } };
  try {
    return { ok: true, root: nodeOfJson('', JSON.parse(s)) };
  } catch (e) {
    const msg = (e as Error).message;
    const m = /position (\d+)/.exec(msg);
    if (m) {
      const pos = Number(m[1]);
      const before = s.slice(0, pos);
      const line = before.split('\n').length;
      const col = pos - before.lastIndexOf('\n');
      return { ok: false, error: `JSON không hợp lệ (dòng ${line}, cột ${col}): ${msg}` };
    }
    return { ok: false, error: `JSON không hợp lệ: ${msg}` };
  }
}

// ── XML ─────────────────────────────────────────────────────────────────────

/** Tách thuộc tính trong thẻ mở: name="value" | name='value' | name=value. */
function parseAttrs(tag: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    out.push({ name: m[1], value: m[3] ?? m[4] ?? m[5] ?? '' });
  }
  return out;
}

const XML_ENT: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/** Giải mã entity XML cơ bản + &#nn; / &#xnn;. */
function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? Number.parseInt(e.slice(2), 16)
        : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENT[e] ?? m;
  });
}

/**
 * Dựng cây từ XML/HTML. Bỏ qua khai báo <?xml?>, <!DOCTYPE> và comment.
 * Thẻ đóng không khớp thì báo lỗi kèm số dòng.
 */
export function xmlTree(src: string, html = false): TreeResult {
  const s = src.trim();
  if (!s) return { ok: true, root: { key: '', type: 'element', children: [] } };

  // Thẻ HTML rỗng — không có thẻ đóng nên không đẩy vào stack.
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr']);

  const root: TreeNode = { key: '', type: 'element', children: [] };
  const stack: TreeNode[] = [root];
  const lineAt = (idx: number) => s.slice(0, idx).split('\n').length;

  const tokens = s.matchAll(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g);
  for (const tk of tokens) {
    const tok = tk[0];
    const at = tk.index ?? 0;

    if (tok.startsWith('<!--')) continue;                 // comment
    if (/^<\?/.test(tok) || /^<!/.test(tok)) continue;    // <?xml?> / <!DOCTYPE>

    if (!tok.startsWith('<')) {
      const text = decodeXml(tok).trim();
      if (text === '') continue;
      const parent = stack[stack.length - 1];
      (parent.children ??= []).push({ key: '#text', value: text, type: 'text' });
      continue;
    }

    const close = /^<\/\s*([^\s>]+)/.exec(tok);
    if (close) {
      const name = html ? close[1].toLowerCase() : close[1];
      const top = stack[stack.length - 1];
      if (top !== root && top.key === name) { stack.pop(); continue; }
      // Không khớp thẻ trong cùng. XML phải lồng đúng → báo lỗi; HTML thực tế
      // hay thiếu thẻ đóng nên cho phép đóng bù các thẻ còn treo bên trong.
      if (!html) {
        return top === root
          ? { ok: false, error: `Thẻ đóng </${close[1]}> không có thẻ mở (dòng ${lineAt(at)}).` }
          : { ok: false, error: `Thẻ đóng </${close[1]}> không khớp <${top.key}> đang mở (dòng ${lineAt(at)}).` };
      }
      const hit = [...stack].reverse().findIndex((n) => n.key === name);
      if (hit === -1) continue; // thẻ đóng thừa — bỏ qua
      stack.length = stack.length - hit - 1;
      continue;
    }

    const nameMatch = /^<\s*([^\s/>]+)/.exec(tok);
    if (!nameMatch) continue;
    const name = html ? nameMatch[1].toLowerCase() : nameMatch[1];
    const selfClose = /\/>\s*$/.test(tok) || (html && VOID.has(name));
    const attrs = parseAttrs(tok.slice(nameMatch[0].length));

    const node: TreeNode = { key: name, type: 'element', children: [] };
    if (attrs.length) node.attrs = attrs;
    (stack[stack.length - 1].children ??= []).push(node);
    if (!selfClose) stack.push(node);
  }

  if (!html && stack.length > 1) {
    return { ok: false, error: `Thiếu thẻ đóng cho <${stack[stack.length - 1].key}>.` };
  }

  // Gọn hoá: thẻ chỉ chứa một text node → hiện như nút lá "tên: giá trị".
  const collapse = (n: TreeNode): TreeNode => {
    const kids = n.children ?? [];
    if (kids.length === 1 && kids[0].type === 'text') {
      return { ...n, value: kids[0].value, children: [] };
    }
    return { ...n, children: kids.map(collapse), count: kids.length || undefined };
  };
  return { ok: true, root: collapse(root) };
}

/** Cây theo kind — dùng chung cho ô xem bên phải. */
export function treeFor(kind: 'json' | 'xml' | 'html', src: string): TreeResult {
  return kind === 'json' ? jsonTree(src) : xmlTree(src, kind === 'html');
}
