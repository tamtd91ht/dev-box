// Trợ lý AI của Dev Box — kiểu + hằng số dùng chung client/server, và store
// nhỏ cho trạng thái "bảng chat đang mở / rộng bao nhiêu".
//
// Bảng chat là một CỘT NEO bên phải cửa sổ: khung app (.shell) co lại nhường
// chỗ chứ bảng không phủ lên nội dung. Lý do: <webview> (Zalo, Browser…) vẽ ở
// tầng native, HTML không nổi lên trên được — drawer phủ kiểu Radar sẽ bị
// webview che. Neo cạnh thì mọi tab đều dùng song song với chat được.
// app/page.tsx đọc store này để đệm lề phải cho .shell.

export interface AiTurn { role: 'user' | 'assistant'; content: string }

export type AiAttachment =
  | { kind: 'image'; name: string; mediaType: string; /** base64 */ data: string }
  | { kind: 'pdf'; name: string; /** base64 */ data: string }
  | { kind: 'text'; name: string; /** nội dung chữ */ data: string };

export interface AiPoll {
  /** Phần chữ mới kể từ offset đã gửi. */
  text: string;
  /** Offset cho lần poll kế. */
  next: number;
  done: boolean;
  error: string | null;
  model: string | null;
  durationMs: number;
  /** Tiêu đề các tài liệu trong kho tri thức đã gửi kèm câu hỏi này. */
  sources: string[];
  /** Tên các kỹ năng đã kích hoạt cho câu hỏi này (lib/aiSkills.ts). */
  skills: string[];
}

// ── Kho tri thức (lib/aiKnowledge.ts) ────────────────────────────────────────

export interface KbDoc {
  id: string;
  title: string;
  content: string;
  /** Tắt = giữ trong kho nhưng không gửi cho trợ lý. */
  enabled: boolean;
  updatedAt: string;
}
/** Dòng trong danh sách — không kèm nội dung cho nhẹ. */
export type KbMeta = Omit<KbDoc, 'content'> & { chars: number };

/** Số ký tự tri thức tối đa gửi kèm MỘT câu hỏi. Tổng tài liệu bật nằm trong
 *  mức này thì gửi hết; vượt thì chỉ gửi các đoạn liên quan nhất. */
export const KB_BUDGET = 60_000;
export const KB_LIMITS = { maxDocs: 200, maxTitle: 120, maxDocChars: 500_000 };

// ── Kỹ năng (lib/aiSkills.ts) ────────────────────────────────────────────────
// Kỹ năng = một QUY TRÌNH người dùng tự soạn cho một loại việc (vd "phân tích nhóm Zalo").
// Khác kho tri thức (luôn gửi kèm): kỹ năng chỉ được nạp khi câu hỏi / màn hình khớp, hoặc
// khi trợ lý tự xin nạp sau khi đọc danh mục (tên + "dùng khi").

export interface AiSkill {
  id: string;
  name: string;
  /** "Dùng khi…" — trợ lý đọc dòng này trong danh mục để tự quyết có cần nạp không. */
  description: string;
  /** Câu hỏi chứa một trong các từ / cụm từ này (không phân biệt dấu) → tự kích hoạt. */
  keywords: string[];
  /** Đang mở màn hình có tên chứa một trong các tên này (vd "Zalo") → tự kích hoạt. */
  screens: string[];
  /** Hướng dẫn chi tiết (Markdown) — chỉ gửi cho trợ lý khi kỹ năng được kích hoạt. */
  instructions: string;
  enabled: boolean;
  updatedAt: string;
}
export type AiSkillMeta = Omit<AiSkill, 'instructions'> & { chars: number };

export const SKILL_LIMITS = {
  maxSkills: 100,
  maxName: 80,
  maxDesc: 500,
  maxKeywords: 30,
  maxScreens: 10,
  maxInstructions: 40_000,
  /** Số kỹ năng tối đa kích hoạt cho MỘT câu hỏi, và tổng ký tự hướng dẫn gửi kèm. */
  maxActive: 3,
  activeBudget: 60_000,
  /** Trợ lý được xin nạp thêm tối đa chừng này lần cho một câu hỏi. */
  maxRequests: 2,
};

export const AI_LIMITS = {
  maxQuestion: 8000,
  maxFiles: 6,
  /** Tổng dung lượng đính kèm một câu hỏi. */
  maxTotalBytes: 12 * 1024 * 1024,
  /** File chữ dài hơn mức này bị cắt bớt phần đuôi. */
  maxTextChars: 400_000,
  /** Dán đoạn chữ dài hơn mức này → thành một file đính kèm thay vì đổ vào ô nhập. */
  pasteAsFileChars: 4000,
};

/** Alias model của Claude Code CLI — luôn trỏ bản mới nhất của dòng đó. */
export const AI_MODELS: { id: string; label: string; hint: string }[] = [
  { id: 'fable', label: 'Fable', hint: 'Dòng mới nhất, mạnh nhất — chậm và tốn hạn mức nhất' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Cân bằng tốc độ và độ sâu' },
  { id: 'opus', label: 'Opus', hint: 'Phân tích sâu hơn, chậm và tốn hạn mức hơn' },
  { id: 'haiku', label: 'Haiku', hint: 'Nhanh, trả lời gọn' },
];
export const AI_DEFAULT_MODEL = 'sonnet';

// ── Store trạng thái bảng chat (useSyncExternalStore) ────────────────────────

export interface AiDock { open: boolean; width: number }

const KEY = 'ai.dock';
export const AI_MIN_W = 320;
export const AI_MAX_W = 760;
const SERVER: AiDock = { open: false, width: 420 };

let state: AiDock = SERVER;
let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<AiDock> | null;
    if (v) {
      const w = Number(v.width);
      state = {
        open: v.open === true,
        width: Number.isFinite(w) ? Math.min(AI_MAX_W, Math.max(AI_MIN_W, w)) : SERVER.width,
      };
    }
  } catch { /* nicety */ }
}

function set(next: AiDock): void {
  state = next;
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* nicety */ }
  listeners.forEach((fn) => fn());
}

export const aiDock = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  getSnapshot(): AiDock { load(); return state; },
  getServerSnapshot(): AiDock { return SERVER; },
  toggle(): void { load(); set({ ...state, open: !state.open }); },
  setOpen(open: boolean): void { load(); if (state.open !== open) set({ ...state, open }); },
  setWidth(width: number): void {
    load();
    set({ ...state, width: Math.round(Math.min(AI_MAX_W, Math.max(AI_MIN_W, width))) });
  },
};
