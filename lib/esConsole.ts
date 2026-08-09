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
export const CONSOLE_METHODS = ['GET', 'POST', 'HEAD', 'PUT', 'DELETE'] as const;

const METHOD_LINE = /^\s*(GET|POST|HEAD|PUT|DELETE|PATCH)\s+(\S+)\s*$/i;

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
  const same = (e: EsConsoleHistoryEntry) =>
    e.method === entry.method && e.path === entry.path && e.body === entry.body;
  const kept = list.filter((e) => !same(e));
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return save([{ ...entry, id, at: Date.now() }, ...kept]);
}

export function removeEsConsoleHistory(id: string): EsConsoleHistoryEntry[] {
  return save(loadEsConsoleHistory().filter((e) => e.id !== id));
}

export function clearEsConsoleHistory(): EsConsoleHistoryEntry[] {
  removeLocal(HISTORY_KEY);
  return [];
}

/** Dựng lại text editor từ một mục lịch sử. */
export function historyToText(e: EsConsoleHistoryEntry): string {
  return e.body ? `${e.method} ${e.path}\n${e.body}\n` : `${e.method} ${e.path}\n`;
}

// ── Nội dung editor (nhớ giữa các lần mở tab) ────────────────────────────────

export const CONSOLE_DEFAULT_DRAFT = `# Console — gõ lệnh REST như Kibana Dev Tools.
# Ctrl+Enter (hoặc ▶) chạy lệnh đang đặt con trỏ.

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

export function loadEsConsoleDraft(): string {
  return readLocal(DRAFT_KEY) ?? CONSOLE_DEFAULT_DRAFT;
}

export function saveEsConsoleDraft(text: string): void {
  writeLocal(DRAFT_KEY, text);
}
