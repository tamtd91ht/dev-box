// Tab Console (Dev Tools) của workspace Elasticsearch — phần chạy ở BROWSER:
// tách text trong editor thành các lệnh, và nhớ lịch sử lệnh đã chạy.
//
// Cú pháp giống Kibana Dev Tools: một dòng `METHOD path` mở đầu một lệnh, các
// dòng sau tới lệnh kế tiếp là body JSON. Nhiều lệnh sống chung một editor,
// bấm ▶ thì chạy lệnh đang đặt con trỏ.
//
//   GET _cat/indices?v
//
//   POST my_index/_search
//   {
//     "query": { "match_all": {} }
//   }
//
// Lịch sử + nội dung editor lưu ở localStorage (module chỉ dùng phía browser).

import { readLocal, writeLocal, removeLocal } from './localKeys';

const HISTORY_KEY = 'es.console.history';
const DRAFT_KEY = 'es.console.draft';
const HISTORY_MAX = 60;

/** Method người dùng gõ được — server còn chặn tiếp, đây chỉ để tách lệnh. */
export const CONSOLE_METHODS = ['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'PATCH'] as const;

const METHOD_LINE = /^\s*(GET|POST|HEAD|PUT|DELETE|PATCH)\s+(\S+)\s*$/i;

// ── Phân loại mức nguy hiểm ──────────────────────────────────────────────────
//
// Sống ở đây (module không phụ thuộc `server-only`) vì CẢ HAI phía cần nó: UI
// hiện badge ngay khi gõ, server chấm lại để bắt cờ `confirmed`. Một bảng duy
// nhất — sửa một chỗ là cả hai khớp nhau.

/** Endpoint đọc được phép gọi bằng POST — POST tới đây KHÔNG tính là ghi. */
const POST_READ = new Set([
  '_search', '_count', '_msearch', '_mget', '_explain', '_validate', '_field_caps',
  '_analyze', '_termvectors', '_mtermvectors', '_rank_eval', '_search_shards',
  '_resolve', '_knn_search', '_async_search', '_pit',
]);

/** Endpoint xoá/ghi đè hàng loạt — luôn xếp 'destructive' dù method là gì. */
const BULK_WRITE = new Set([
  '_delete_by_query', '_update_by_query', '_reindex', '_bulk', '_close', '_open',
  '_shrink', '_split', '_clone', '_freeze', '_unfreeze', '_forcemerge', '_rollover',
  '_upgrade',
]);

/** Mức nguy hiểm của một lệnh console — UI dùng để quyết định hỏi xác nhận. */
export type EsConsoleRisk = 'read' | 'write' | 'destructive';

/**
 * Xếp mức nguy hiểm của một lệnh.
 *
 * 'destructive' = mất dữ liệu hoặc đổi trạng thái index không lùi lại được: mọi
 * DELETE, và nhóm _delete_by_query/_reindex/_bulk/_close… ở bất kỳ method.
 * 'write'       = tạo/sửa (PUT/PATCH, POST ghi document, POST endpoint không đọc).
 * 'read'        = GET/HEAD, và POST tới endpoint tìm kiếm.
 */
export function classifyConsoleCommand(method: string, path: string): EsConsoleRisk {
  const [pathname] = path.split('?', 1);
  const underscores = pathname.split('/').filter((s) => s.startsWith('_'));
  if (underscores.some((s) => BULK_WRITE.has(s))) return 'destructive';
  const m = method.toUpperCase();
  if (m === 'DELETE') return 'destructive';
  if (m === 'GET' || m === 'HEAD') return 'read';
  if (m === 'POST') {
    const last = underscores[underscores.length - 1];
    return last && POST_READ.has(last) ? 'read' : 'write';
  }
  return 'write'; // PUT / PATCH
}

/** Thứ lệnh nhắm vào — tên index, hoặc endpoint nếu lệnh ở cấp cụm. */
export function consoleTarget(path: string): string {
  const [pathname] = path.split('?', 1);
  const first = pathname.split('/').filter(Boolean)[0] ?? '';
  return first.startsWith('_') ? pathname.replace(/^\//, '') : first;
}

export interface EsConsoleRequest {
  method: string;
  path: string;
  /** Body JSON dạng text (đã bỏ dòng trắng thừa hai đầu) — '' nếu không có. */
  body: string;
  /** Dòng chứa `METHOD path`, đánh số từ 1 (khớp với monaco). */
  startLine: number;
  /** Dòng cuối của lệnh (gồm cả body). */
  endLine: number;
}

/** Thay đổi độ sâu ngoặc của một dòng, bỏ qua ngoặc nằm trong chuỗi. */
function depthDelta(line: string): number {
  let d = 0;
  let inStr = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') d += 1;
    else if (c === '}' || c === ']') d -= 1;
  }
  return d;
}

/**
 * Tách toàn bộ nội dung editor thành danh sách lệnh.
 *
 * Body kết thúc khi ngoặc đóng hết — nhờ vậy dòng trắng phía dưới một lệnh
 * KHÔNG bị tính là còn trong lệnh đó (quan trọng cho autocomplete: đứng ở dòng
 * trắng thì gợi ý method, đứng trong body thì gợi ý JSON).
 *
 * Lưu ý: body NDJSON (`_msearch`) cân ngoặc sau mỗi dòng nên chỉ dòng đầu được
 * nhận — gõ `_msearch` thì để mỗi lệnh một editor riêng.
 */
export function parseConsoleRequests(text: string): EsConsoleRequest[] {
  const lines = text.split('\n');
  const out: EsConsoleRequest[] = [];
  interface Cur { method: string; path: string; start: number; body: string[]; depth: number; opened: boolean; end: number }
  let cur: Cur | null = null;

  const flush = () => {
    if (!cur) return;
    out.push({
      method: cur.method,
      path: cur.path,
      body: cur.body.join('\n').trim(),
      startLine: cur.start,
      endLine: cur.end,
    });
    cur = null;
  };

  lines.forEach((line, i) => {
    const m = METHOD_LINE.exec(line);
    if (m) {
      flush();
      cur = { method: m[1].toUpperCase(), path: m[2], start: i + 1, body: [], depth: 0, opened: false, end: i + 1 };
      return;
    }
    if (!cur) return;
    // Dòng comment kiểu Kibana (`#`, `//`) bị bỏ khỏi body — người dùng ghi chú
    // ngay trong console mà body vẫn là JSON hợp lệ khi gửi đi.
    const isComment = /^\s*(#|\/\/)/.test(line);
    if (!isComment) cur.body.push(line);
    if (line.trim()) {
      cur.end = i + 1;
      if (!isComment) {
        cur.depth += depthDelta(line);
        if (cur.depth > 0) cur.opened = true;
        if (cur.opened && cur.depth <= 0) flush(); // body đã đóng hết ngoặc
      }
    }
  });
  flush();
  return out;
}

/** Lệnh đang đặt con trỏ (dòng 1-based); không trúng lệnh nào thì lấy lệnh gần nhất phía trên. */
export function requestAtLine(requests: EsConsoleRequest[], line: number): EsConsoleRequest | null {
  if (requests.length === 0) return null;
  const hit = requests.find((r) => line >= r.startLine && line <= r.endLine);
  if (hit) return hit;
  const above = [...requests].reverse().find((r) => r.startLine <= line);
  return above ?? requests[0];
}

// ── Format MỘT lệnh ──────────────────────────────────────────────────────────

/**
 * Dòng BẮT ĐẦU một lệnh — lỏng hơn METHOD_LINE: cho phép body JSON dính ngay
 * sau path trên cùng dòng (paste từ log/Kibana hay bị vậy). Path dừng trước
 * khoảng trắng hoặc `{`/`[`, phần dư là body.
 */
const METHOD_START = /^\s*(GET|POST|HEAD|PUT|DELETE|PATCH)\s+([^\s{[]+)\s*(.*)$/i;

export type FormatCommandResult =
  | { ok: true; text: string; caretLine: number }
  | { ok: false; error: string };

/**
 * Format ĐÚNG MỘT lệnh — lệnh chứa con trỏ (hoặc gần nhất phía trên): tách
 * `METHOD path` lên dòng riêng, body JSON pretty-print 2 space. Các lệnh khác
 * trong editor giữ nguyên từng ký tự.
 *
 * Nhận cả lệnh paste bị DÍNH body vào dòng lệnh (parser thường không nhận ra
 * dạng đó). Dòng comment `#`/`//` trong body bị bỏ khi parse (như lúc chạy).
 * Body không phải JSON hợp lệ (NDJSON của _bulk/_msearch, JSON gõ dở) → báo
 * lỗi, không đụng gì.
 */
export function formatConsoleCommand(text: string, cursorLine: number): FormatCommandResult {
  const lines = text.split('\n');

  // Dòng lệnh gần nhất từ con trỏ trở lên.
  let start = -1;
  let m: RegExpExecArray | null = null;
  for (let i = Math.min(Math.max(cursorLine, 1), lines.length) - 1; i >= 0; i--) {
    const mm = METHOD_START.exec(lines[i]);
    if (mm) { start = i; m = mm; break; }
  }
  if (start < 0 || !m) return { ok: false, error: 'Không thấy lệnh nào ở chỗ con trỏ — đặt con trỏ vào lệnh cần format.' };

  // Gom body: từ phần dư trên dòng lệnh + các dòng dưới, dừng khi ngoặc cân
  // (không nuốt comment/ghi chú đứng sau lệnh) hoặc gặp lệnh kế tiếp.
  let depth = 0;
  let opened = false;
  const feed = (s: string) => {
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') { depth++; opened = true; }
      else if (c === '}' || c === ']') depth--;
    }
  };

  const bodyLines: string[] = [];
  const comments: string[] = []; // comment giữa khối — dời lên ngay dưới dòng lệnh, không xoá
  if (m[3].trim()) { bodyLines.push(m[3]); feed(m[3]); }
  let end = start;
  for (let i = start + 1; i < lines.length && !(opened && depth <= 0); i++) {
    const ln = lines[i];
    if (METHOD_START.test(ln)) break;
    if (!opened && !ln.trim()) break;          // lệnh không có body
    if (/^\s*(#|\/\/)/.test(ln)) { comments.push(ln.trim()); end = i; continue; } // comment không vào body
    bodyLines.push(ln);
    feed(ln);
    end = i;
  }

  const head = `${m[1].toUpperCase()} ${m[2]}`;
  const bodyRaw = bodyLines.join('\n').trim();
  let pretty = '';
  if (bodyRaw) {
    try {
      pretty = JSON.stringify(JSON.parse(bodyRaw), null, 2);
    } catch (e) {
      return { ok: false, error: `Body không parse được JSON nên chưa format: ${(e as Error).message}` };
    }
  }
  const block = [head, ...comments, ...(pretty ? [pretty] : [])].join('\n');

  const next = [...lines.slice(0, start), block, ...lines.slice(end + 1)].join('\n');
  return { ok: true, text: next, caretLine: start + 1 };
}

// ── Lịch sử ──────────────────────────────────────────────────────────────────

export interface EsConsoleHistoryEntry {
  id: string;
  method: string;
  path: string;
  body: string;
  connectionId: string;
  connectionName: string;
  /** Epoch ms lúc chạy. */
  at: number;
  status: number;
  ok: boolean;
  tookMs: number;
}

function isEntry(v: unknown): v is EsConsoleHistoryEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.method === 'string' && typeof e.path === 'string';
}

export function loadEsConsoleHistory(): EsConsoleHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = readLocal(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

/**
 * Lịch sử CỦA RIÊNG một cluster.
 *
 * Lưu vẫn là một danh sách chung (đổi cluster qua lại không mất lịch sử), nhưng
 * cột "Lệnh gần đây" chỉ được hiện phần thuộc cluster đang chọn — trước đây hiện
 * tất cả nên rất dễ bấm lại một lệnh của cụm khác rồi chạy nhầm cluster.
 */
export function loadEsConsoleHistoryFor(connectionId: string): EsConsoleHistoryEntry[] {
  return loadEsConsoleHistory().filter((e) => e.connectionId === connectionId);
}

function save(list: EsConsoleHistoryEntry[]): EsConsoleHistoryEntry[] {
  const capped = list.slice(0, HISTORY_MAX);
  writeLocal(HISTORY_KEY, JSON.stringify(capped));
  return capped;
}

/**
 * Ghi nhận một lần chạy. Lệnh trùng hệt (method + path + body) không nhân bản —
 * chỉ được đẩy lên đầu và cập nhật kết quả mới nhất, để lịch sử không bị lụt
 * khi bấm chạy lại nhiều lần.
 */
export function pushEsConsoleHistory(
  entry: Omit<EsConsoleHistoryEntry, 'id' | 'at'>,
): EsConsoleHistoryEntry[] {
  const list = loadEsConsoleHistory();
  // Trùng chỉ tính TRONG CÙNG cluster — cùng một lệnh chạy ở hai cụm là hai mục
  // riêng, vì mỗi cột lịch sử chỉ hiện phần của cluster mình.
  const same = (e: EsConsoleHistoryEntry) =>
    e.connectionId === entry.connectionId
    && e.method === entry.method && e.path === entry.path && e.body === entry.body;
  const kept = list.filter((e) => !same(e));
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return save([{ ...entry, id, at: Date.now() }, ...kept])
    .filter((e) => e.connectionId === entry.connectionId);
}

export function removeEsConsoleHistory(id: string, connectionId: string): EsConsoleHistoryEntry[] {
  return save(loadEsConsoleHistory().filter((e) => e.id !== id))
    .filter((e) => e.connectionId === connectionId);
}

/** Xoá lịch sử của RIÊNG một cluster — lệnh của cụm khác giữ nguyên. */
export function clearEsConsoleHistory(connectionId: string): EsConsoleHistoryEntry[] {
  const rest = loadEsConsoleHistory().filter((e) => e.connectionId !== connectionId);
  if (rest.length === 0) removeLocal(HISTORY_KEY);
  else save(rest);
  return [];
}

/** Dựng lại text editor từ một mục lịch sử. */
export function historyToText(e: EsConsoleHistoryEntry): string {
  return e.body ? `${e.method} ${e.path}\n${e.body}\n` : `${e.method} ${e.path}\n`;
}

// ── Nội dung editor (nhớ giữa các lần mở tab) ────────────────────────────────

export const CONSOLE_DEFAULT_DRAFT = `# Console — gõ lệnh REST như Kibana Dev Tools.
# Ctrl+Enter (hoặc ▶) chạy lệnh đang đặt con trỏ.
# GHI ĐƯỢC: PUT/DELETE chạy thật. Lệnh ghi hỏi lại, lệnh xoá phải gõ lại tên index.

GET _cat/indices?v&s=store.size:desc

GET _cluster/health

POST my_index/_search
{
  "size": 5,
  "query": {
    "bool": {
      "filter": [
        { "term": { "field": "value" } }
      ]
    }
  }
}
`;

/**
 * Nội dung editor nhớ theo TỪNG cluster — mỗi cụm một scratchpad, đổi cluster
 * không bị mang nguyên lệnh của cụm cũ sang. `es.console.draft` (không hậu tố)
 * là bản chung của phiên bản cũ: còn dùng làm giá trị khởi tạo cho cluster nào
 * chưa có draft riêng, để lần đầu mở sau khi cập nhật không mất bài đang gõ.
 */
function draftKey(connectionId: string): string {
  return `${DRAFT_KEY}.${connectionId}`;
}

export function loadEsConsoleDraft(connectionId: string): string {
  return readLocal(draftKey(connectionId)) ?? readLocal(DRAFT_KEY) ?? CONSOLE_DEFAULT_DRAFT;
}

export function saveEsConsoleDraft(connectionId: string, text: string): void {
  writeLocal(draftKey(connectionId), text);
}
