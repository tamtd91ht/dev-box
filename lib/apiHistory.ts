// Lịch sử các lần gửi của tab API — cất trong localStorage (per-máy, không lên
// server): chỉ để "gửi lại cái vừa nãy" chứ không phải dữ liệu cần giữ lâu.
//
// Cất DRAFT (method/url/headers/body/auth…) chứ không cất response — response có
// thể vài MB. Body quá lớn thì bỏ phần body đi: cắt cụt rồi gửi lại là gửi sai.

const KEY = 'devbox.api.history';
const MAX_ITEMS = 40;
const MAX_BODY = 50_000;

export interface HistoryItem {
  id: string;
  at: number;
  method: string;
  url: string;
  /** Mã trạng thái, hoặc undefined nếu không gọi được. */
  status?: number;
  timeMs?: number;
  error?: string;
  /** Draft của tab lúc gửi (JSON thuần, đã lược ruột file). */
  draft: Record<string, unknown>;
  /** Body quá lớn nên không lưu — gửi lại sẽ thiếu body. */
  bodyDropped?: boolean;
}

export function loadHistory(): HistoryItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? (raw as HistoryItem[]) : [];
  } catch { return []; }
}

export function pushHistory(item: Omit<HistoryItem, 'id' | 'at' | 'bodyDropped'>): HistoryItem[] {
  const draft = { ...item.draft };
  let bodyDropped = false;
  if (typeof draft.body === 'string' && draft.body.length > MAX_BODY) { draft.body = ''; bodyDropped = true; }
  const entry: HistoryItem = { ...item, draft, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), bodyDropped };
  const next = [entry, ...loadHistory()].slice(0, MAX_ITEMS);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* đầy thì thôi */ }
  return next;
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY); } catch { /* bỏ qua */ }
}
