// Server-only search/navigation engine cho Code Studio — "Search Everywhere"
// mức nhẹ cho repo Java/Kotlin/TS:
//
//   • SYMBOL INDEX: một lượt quét build index class/interface/enum/record +
//     method + hằng số (static final). Cache 60s trong globalThis; mọi mutation
//     (write/create/rename/remove) invalidate. Đây là nền cho: palette
//     Ctrl+Shift+N, Ctrl+Click definition, hover, autocomplete cross-file.
//   • USAGES: grep word-boundary trên file text (skip binary/generated/>1MB).
//   • DEFS: tra index theo tên chính xác trước (nhanh + đúng cho Java vì tên
//     class gần như unique), fallback heuristic khai báo.
//
// KHÔNG chạy language server — JDT LS quá nặng cho tab tool; heuristic này đủ
// cho điều hướng hằng ngày, refactor semantics thật vẫn là việc của IntelliJ.

import { promises as fs } from 'fs';
import path from 'path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'build', 'dist', 'out', '.next', '.idea',
  'bin', 'obj', 'coverage', '__pycache__', 'vendor', '.gradle', '.mvn',
  '.settings', '.vscode', 'logs',
]);

/** Extensions được index symbol. */
const CODE_EXT = new Set(['java', 'kt', 'kts', 'scala', 'groovy', 'ts', 'tsx', 'js', 'jsx', 'cs', 'py', 'go', 'php']);

/** Extensions text để grep usages (code + config phổ biến). */
const TEXT_EXT = new Set([
  ...CODE_EXT,
  'json', 'xml', 'yml', 'yaml', 'properties', 'sql', 'md', 'gradle', 'html', 'css', 'scss',
  'sh', 'bat', 'cmd', 'ps1', 'conf', 'ini', 'env', 'txt', 'proto', 'toml',
]);

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_FILES = 60000;
const WALK_TTL = 20_000;
const INDEX_TTL = 60_000;

interface FileMeta { rel: string; abs: string; ext: string; size: number }

export type SymbolKind =
  | 'class' | 'interface' | 'enum' | 'record' | 'object' | 'trait'
  | 'method' | 'constant';

export interface SymbolHit {
  name: string;
  kind: SymbolKind;
  rel: string;
  line: number; // 1-based
  /** Dòng khai báo (trim) — hover + palette hiển thị. */
  sig: string;
}

export interface TextHit {
  rel: string;
  line: number;
  col: number;
  preview: string;
}

interface WalkCache { ts: number; files: FileMeta[] }
interface IndexCache { ts: number; symbols: SymbolHit[]; byName: Map<string, SymbolHit[]> }

const g = globalThis as typeof globalThis & {
  __vhsWalkCache?: Map<string, WalkCache>;
  __vhsSymbolIndex?: Map<string, IndexCache>;
};
const walkCache = (g.__vhsWalkCache ??= new Map());
const symbolIndex = (g.__vhsSymbolIndex ??= new Map());

/** Mutation (write/create/rename/remove) gọi để index không bị cũ. */
export function invalidateSearchCache(root: string): void {
  walkCache.delete(root);
  symbolIndex.delete(root);
}

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

async function walk(root: string): Promise<FileMeta[]> {
  const hit = walkCache.get(root);
  if (hit && Date.now() - hit.ts < WALK_TTL) return hit.files;

  const files: FileMeta[] = [];
  const queue: string[] = [root];
  while (queue.length && files.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const abs = path.join(dir, e.name);
      let size = 0;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        continue;
      }
      files.push({ rel: path.relative(root, abs).split(path.sep).join('/'), abs, ext: extOf(e.name), size });
    }
  }
  walkCache.set(root, { ts: Date.now(), files });
  return files;
}

async function readText(f: FileMeta): Promise<string | null> {
  if (f.size > MAX_FILE_SIZE) return null;
  try {
    const buf = await fs.readFile(f.abs);
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

async function mapPool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    }),
  );
}

// ── Symbol extraction (per line, heuristic) ─────────────────────────────────

const TYPE_DECL = /\b(class|interface|enum|record|object|trait)\s+([A-Za-z_$][\w$]*)/g;

const JAVA_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'this',
  'throw', 'else', 'do', 'try', 'assert', 'synchronized', 'instanceof',
]);

// Java/Kotlin/JS method declaration trên MỘT dòng:
//   [annotations] [modifiers] [<T>] ReturnType name( …
// Yêu cầu có "type name(" (khoảng trắng trước name) để loại lời gọi `foo(x)`.
const METHOD_DECL =
  /^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|abstract|synchronized|default|native|strictfp|override|suspend)\s+)*(?:<[^>]+>\s*)?[\w$][\w$<>,\[\].?\s]*?\s+([a-z_$][\w$]*)\s*\(/;

// Kotlin/JS trực tiếp: fun name( / function name(
const FUN_DECL = /\b(?:fun|function)\s+([A-Za-z_$][\w$]*)\s*\(/;

// Hằng số: static final TYPE NAME = / const NAME =
const CONST_DECL = /\b(?:static\s+final|final\s+static|const)\s+[\w$<>\[\],.\s]*?([A-Z_$][A-Z0-9_$]*)\s*=/;

function extractSymbols(f: FileMeta, text: string, out: SymbolHit[]): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue; // minified/generated
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    TYPE_DECL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TYPE_DECL.exec(line)) !== null) {
      out.push({ name: m[2], kind: m[1] as SymbolKind, rel: f.rel, line: i + 1, sig: trimmed.slice(0, 200) });
    }

    const fun = FUN_DECL.exec(line);
    if (fun && !JAVA_KEYWORDS.has(fun[1])) {
      out.push({ name: fun[1], kind: 'method', rel: f.rel, line: i + 1, sig: trimmed.slice(0, 200) });
      continue;
    }

    // Method decl chỉ xét cho file "class-y" (đỡ noise ở JS utils).
    if (['java', 'kt', 'kts', 'scala', 'groovy', 'cs'].includes(f.ext)) {
      const md = METHOD_DECL.exec(line);
      if (md && !JAVA_KEYWORDS.has(md[1])) {
        const eq = line.indexOf('=');
        const namePos = line.indexOf(md[1]);
        // '=' đứng trước tên → là gán/lambda, không phải khai báo.
        if (eq === -1 || eq > namePos) {
          out.push({ name: md[1], kind: 'method', rel: f.rel, line: i + 1, sig: trimmed.slice(0, 200) });
        }
      }
    }

    const cn = CONST_DECL.exec(line);
    if (cn) out.push({ name: cn[1], kind: 'constant', rel: f.rel, line: i + 1, sig: trimmed.slice(0, 200) });
  }
}

async function buildIndex(root: string): Promise<IndexCache> {
  const hit = symbolIndex.get(root);
  if (hit && Date.now() - hit.ts < INDEX_TTL) return hit;

  const files = (await walk(root)).filter((f) => CODE_EXT.has(f.ext));
  const symbols: SymbolHit[] = [];
  await mapPool(files, 16, async (f) => {
    const text = await readText(f);
    if (text) extractSymbols(f, text, symbols);
  });
  const byName = new Map<string, SymbolHit[]>();
  for (const s of symbols) {
    const arr = byName.get(s.name);
    if (arr) arr.push(s);
    else byName.set(s.name, [s]);
  }
  const cache: IndexCache = { ts: Date.now(), symbols, byName };
  symbolIndex.set(root, cache);
  return cache;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** IntelliJ-style match: substring (CI) hoặc camel-hump ("OCS" ↦ OmiCallService). */
function nameMatches(name: string, q: string): boolean {
  if (name.toLowerCase().includes(q.toLowerCase())) return true;
  if (/^[A-Za-z]+$/.test(q)) {
    const humps = name.match(/[A-Z][a-z0-9]*|^[a-z][a-z0-9]*/g);
    if (humps) {
      let qi = 0;
      for (const h of humps) {
        if (qi >= q.length) break;
        if (h[0].toUpperCase() === q[qi].toUpperCase()) {
          let hj = 1;
          qi++;
          while (qi < q.length && hj < h.length && h[hj].toLowerCase() === q[qi].toLowerCase()) {
            hj++;
            qi++;
          }
        }
      }
      if (qi === q.length) return true;
    }
  }
  return false;
}

const CLASS_KINDS: SymbolKind[] = ['class', 'interface', 'enum', 'record', 'object', 'trait'];

export interface NavResult {
  classes: SymbolHit[];
  symbols: SymbolHit[];
  files: { name: string; rel: string }[];
}

/** Search Everywhere: class + symbol (method/const) + tên file, 1 round-trip. */
export async function searchNav(root: string, q: string): Promise<NavResult> {
  const query = q.trim();
  if (!query) return { classes: [], symbols: [], files: [] };
  const [index, files] = await Promise.all([buildIndex(root), walk(root)]);

  const ql = query.toLowerCase();
  const rank = (n: string) => (n.toLowerCase() === ql ? 0 : n.toLowerCase().startsWith(ql) ? 1 : 2);
  const sortHits = (a: SymbolHit, b: SymbolHit) =>
    rank(a.name) - rank(b.name) || a.name.length - b.name.length || a.name.localeCompare(b.name);

  const classes = index.symbols.filter((s) => CLASS_KINDS.includes(s.kind) && nameMatches(s.name, query))
    .sort(sortHits).slice(0, 80);
  const symbols = index.symbols.filter((s) => !CLASS_KINDS.includes(s.kind) && nameMatches(s.name, query))
    .sort(sortHits).slice(0, 80);
  const fileHits = files
    .filter((f) => nameMatches(f.rel.split('/').pop() ?? '', query))
    .sort((a, b) => a.rel.split('/').pop()!.length - b.rel.split('/').pop()!.length)
    .slice(0, 50)
    .map((f) => ({ name: f.rel.split('/').pop()!, rel: f.rel }));

  return { classes, symbols, files: fileHits };
}

/** Tên chính xác — nền cho Ctrl+Click definition / hover / Ctrl+B. */
export async function exactSymbols(root: string, word: string): Promise<SymbolHit[]> {
  if (!/^[\w$]+$/.test(word)) return [];
  const index = await buildIndex(root);
  const hits = index.byName.get(word) ?? [];
  // class trước method trước constant — đúng kỳ vọng Ctrl+Click vào tên class.
  const order = (k: SymbolKind) => (CLASS_KINDS.includes(k) ? 0 : k === 'method' ? 1 : 2);
  return [...hits].sort((a, b) => order(a.kind) - order(b.kind)).slice(0, 50);
}

/** Symbol toàn project cho autocomplete — tên unique, cap 3000. */
export async function completionSymbols(root: string): Promise<Array<{ name: string; kind: SymbolKind }>> {
  const index = await buildIndex(root);
  const seen = new Map<string, SymbolKind>();
  for (const s of index.symbols) {
    if (!seen.has(s.name)) seen.set(s.name, s.kind);
    if (seen.size >= 3000) break;
  }
  return [...seen].map(([name, kind]) => ({ name, kind }));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Find usages: grep word-boundary toàn project. */
export async function searchText(
  root: string,
  word: string,
  opts: { maxResults?: number; startRel?: string } = {},
): Promise<{ hits: TextHit[]; truncated: boolean; scanned: number }> {
  const q = word.trim();
  if (!q) return { hits: [], truncated: false, scanned: 0 };
  const max = opts.maxResults ?? 300;
  const re = new RegExp(/^[\w$]+$/.test(q) ? `\\b${escapeRe(q)}\\b` : escapeRe(q), 'g');

  const files = (await walk(root)).filter((f) => TEXT_EXT.has(f.ext));
  if (opts.startRel) {
    files.sort((a, b) => (a.rel === opts.startRel ? -1 : b.rel === opts.startRel ? 1 : 0));
  }

  const hits: TextHit[] = [];
  let truncated = false;
  let scanned = 0;
  await mapPool(files, 16, async (f) => {
    if (hits.length >= max) return;
    const text = await readText(f);
    if (text === null) return;
    scanned++;
    if (!text.includes(q)) return;
    const lines = text.split('\n');
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < 50; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      if (hits.length >= max) {
        truncated = true;
        return;
      }
      perFile++;
      hits.push({ rel: f.rel, line: i + 1, col: m.index + 1, preview: lines[i].trim().slice(0, 200) });
    }
  });
  return { hits, truncated, scanned };
}

// ── Call graph (callers / callees) ──────────────────────────────────────────
// Không language server: dùng index method sẵn có + heuristic một-cấp, lazy
// theo yêu cầu. Cân bằng hiệu năng/tiện dụng cho điều hướng hằng ngày; không
// phân giải overload/type như IntelliJ (tên trùng nhau ở 2 class sẽ gộp).

export interface CallSite {
  /** Hàm/khối chứa lời gọi (nơi gọi) — 'method' name hoặc '(top-level)'. */
  enclosing: string;
  /** Class/type bao ngoài enclosing, nếu suy ra được. */
  enclosingType?: string;
  rel: string;
  line: number;
  preview: string;
}

export interface CallGraph {
  /** Nơi GỌI tới hàm này. */
  callers: CallSite[];
  /** Các hàm mà thân hàm này GỌI (khớp được với index → có đích để nhảy). */
  callees: { name: string; rel: string; line: number; sig: string; callLine: number }[];
  truncated: boolean;
}

const CALL_KW = new Set([
  ...JAVA_KEYWORDS, 'function', 'fun', 'val', 'var', 'let', 'const', 'class',
  'interface', 'enum', 'record', 'import', 'package', 'public', 'private',
  'protected', 'static', 'void', 'get', 'set', 'and', 'or', 'in', 'is', 'as',
]);

/** Với mỗi file, danh sách (line, methodName, typeName) các khai báo method/type,
 *  để suy ra "lời gọi ở dòng X nằm trong hàm nào". */
function declMap(text: string, ext: string): { line: number; method?: string; type?: string }[] {
  const lines = text.split('\n');
  const decls: { line: number; method?: string; type?: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    TYPE_DECL.lastIndex = 0;
    const tm = TYPE_DECL.exec(line);
    if (tm) decls.push({ line: i + 1, type: tm[2] });
    const fun = FUN_DECL.exec(line);
    if (fun && !JAVA_KEYWORDS.has(fun[1])) { decls.push({ line: i + 1, method: fun[1] }); continue; }
    if (['java', 'kt', 'kts', 'scala', 'groovy', 'cs'].includes(ext)) {
      const md = METHOD_DECL.exec(line);
      if (md && !JAVA_KEYWORDS.has(md[1])) {
        const eq = line.indexOf('='); const namePos = line.indexOf(md[1]);
        if (eq === -1 || eq > namePos) decls.push({ line: i + 1, method: md[1] });
      }
    }
  }
  return decls;
}

/** Hàm bao gần nhất PHÍA TRÊN dòng `atLine` + type bao gần nhất trên nó. */
function enclosingOf(decls: { line: number; method?: string; type?: string }[], atLine: number) {
  let method: string | undefined; let type: string | undefined;
  for (const d of decls) {
    if (d.line > atLine) break;
    if (d.method) method = d.method;
    if (d.type) type = d.type;
  }
  return { method: method ?? '(top-level)', type };
}

/** Trích tên hàm được gọi trong một đoạn text: pattern `name(` không phải khai báo. */
function extractCalls(text: string): { name: string; line: number }[] {
  const lines = text.split('\n');
  const out: { name: string; line: number }[] = [];
  const CALL = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*')) continue;
    CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL.exec(line)) !== null) {
      const name = m[1];
      if (CALL_KW.has(name)) continue;
      out.push({ name, line: i + 1 });
    }
  }
  return out;
}

/** Cắt thân một hàm bắt đầu ở dòng declLine (1-based) theo cân bằng ngoặc {}. */
function sliceBody(text: string, declLine: number): string {
  const lines = text.split('\n');
  let depth = 0; let started = false; const body: string[] = [];
  for (let i = declLine - 1; i < lines.length; i++) {
    const line = lines[i];
    body.push(line);
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    if (started && depth <= 0) break;
    if (i - (declLine - 1) > 800) break; // guard hàm khổng lồ
  }
  return body.join('\n');
}

/** Callers + callees của một tên hàm. maxCallers giới hạn grep. */
export async function callGraph(root: string, word: string, maxCallers = 200): Promise<CallGraph> {
  const w = word.trim();
  const idx = await buildIndex(root);
  const empty: CallGraph = { callers: [], callees: [], truncated: false };
  if (!/^[\w$]+$/.test(w)) return empty;

  // ── Callers: grep `word(` trên toàn repo, quy về hàm bao ──
  const files = (await walk(root)).filter((f) => CODE_EXT.has(f.ext));
  const callRe = new RegExp(`(?:^|[^\\w$.])${escapeRe(w)}\\s*\\(`);
  const declLineSet = new Set(idx.symbols.filter((s) => s.name === w && s.kind === 'method').map((s) => `${s.rel}:${s.line}`));
  const callers: CallSite[] = [];
  let truncated = false;

  await mapPool(files, 16, async (f) => {
    if (callers.length >= maxCallers) return;
    const text = await readText(f);
    if (text === null || !text.includes(w)) return;
    const lines = text.split('\n');
    let decls: ReturnType<typeof declMap> | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (!callRe.test(lines[i])) continue;
      if (declLineSet.has(`${f.rel}:${i + 1}`)) continue; // chính dòng khai báo, không phải call
      // Loại dòng khai báo method trùng tên (đề phòng chưa vào index).
      const t = lines[i].trimStart();
      if (new RegExp(`\\b(fun|function)\\s+${escapeRe(w)}\\b`).test(t)) continue;
      if (callers.length >= maxCallers) { truncated = true; return; }
      decls ||= declMap(text, f.ext);
      const enc = enclosingOf(decls, i + 1);
      callers.push({
        enclosing: enc.method, enclosingType: enc.type,
        rel: f.rel, line: i + 1, preview: lines[i].trim().slice(0, 200),
      });
    }
  });

  // ── Callees: đọc thân hàm `word`, rút lời gọi, khớp index ──
  const calleeMap = new Map<string, { name: string; rel: string; line: number; sig: string; callLine: number }>();
  const defs = idx.symbols.filter((s) => s.name === w && s.kind === 'method');
  for (const def of defs.slice(0, 4)) {
    const f = files.find((x) => x.rel === def.rel);
    if (!f) continue;
    const text = await readText(f);
    if (!text) continue;
    const body = sliceBody(text, def.line);
    for (const call of extractCalls(body)) {
      if (call.name === w || calleeMap.has(call.name)) continue;
      const target = (idx.byName.get(call.name) ?? []).find((s) => s.kind === 'method');
      if (target) {
        calleeMap.set(call.name, {
          name: call.name, rel: target.rel, line: target.line, sig: target.sig,
          callLine: def.line + call.line - 1,
        });
      }
    }
  }

  callers.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  return { callers, callees: [...calleeMap.values()], truncated };
}

/** Go to declaration: index exact-name trước, fallback heuristic pattern. */
export async function findDefs(root: string, word: string): Promise<SymbolHit[]> {
  const exact = await exactSymbols(root, word);
  if (exact.length) return exact;
  // Fallback: biến local/param không nằm trong index — grep khai báo biến.
  if (!/^[\w$]+$/.test(word)) return [];
  const w = escapeRe(word);
  const re = new RegExp(`\\b(?:const|val|var|let|[\\w$<>\\[\\]]+)\\s+${w}\\s*[=;:)]`);
  const { hits } = await searchText(root, word, { maxResults: 200 });
  return hits
    .filter((h) => re.test(h.preview))
    .slice(0, 20)
    .map((h) => ({ name: word, kind: 'constant' as SymbolKind, rel: h.rel, line: h.line, sig: h.preview }));
}
