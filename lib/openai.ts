// OpenAI (ChatGPT qua API) — kiểu dữ liệu + giới hạn dùng chung client / server.
//
// Menu 🤖 OpenAI (components/OpenAiWorkspace.tsx): người dùng cấu hình khoá API
// rồi gửi prompt; server (lib/openaiServer.ts, route /api/openai) gọi Chat
// Completions của OpenAI và trả kết quả theo "định hướng" (system prompt).
//
// KHOÁ API chỉ nằm ở server (configs/openai.json — thư mục configs/ không lên
// git). Trang chỉ nhận `keyHint` (vd "sk-…abcd") để biết đã có khoá hay chưa.
// Base URL đổi được để dùng dịch vụ TƯƠNG THÍCH OpenAI (Azure OpenAI qua proxy,
// OpenRouter, LM Studio, Ollama…): miễn có /models và /chat/completions.

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

export const OPENAI_LIMITS = {
  /** Ký tự tối đa của prompt và của định hướng (system). */
  promptChars: 200_000,
  systemChars: 50_000,
  /** Prompt mẫu lưu tối đa. */
  maxPresets: 60,
  /** Cấu hình (khoá / base URL) lưu tối đa. */
  maxProfiles: 20,
  /** File import vào một request (chữ đã đọc ra — lib/fileText.ts). */
  maxFiles: 5,
  fileChars: 200_000,
  filesTotalChars: 400_000,
  /** File đưa lên tối đa (byte) — cùng giới hạn đọc của server. */
  fileBytes: 20 * 1024 * 1024,
  /** Lịch sử request giữ trong trình duyệt (các request gần nhất). */
  maxHistory: 5,
  /** Tab request mở cùng lúc. */
  maxTabs: 20,
  maxTokens: 128_000,
} as const;

export type OpenAiFormat = 'text' | 'json';

/** Một CẤU HÌNH như trang thấy — KHÔNG có khoá. Lưu được nhiều cấu hình (vd khoá công ty /
 *  khoá cá nhân / OpenRouter); khi gửi request thì chọn cấu hình nào dùng. */
export interface OpenAiProfile {
  id: string;
  name: string;
  hasKey: boolean;
  /** Vài ký tự đầu / cuối của khoá đã lưu, vd "sk-p…3fQa"; '' khi chưa có khoá. */
  keyHint: string;
  baseUrl: string;
  organization: string;
  project: string;
  defaultModel: string;
}

export interface OpenAiProfiles {
  profiles: OpenAiProfile[];
  /** Cấu hình chọn sẵn khi gửi request. */
  defaultId: string;
}

/** Trang gửi lên khi lưu một cấu hình. Không có `id` = tạo mới. `apiKey` trống = giữ khoá cũ;
 *  `clearKey` = xoá khoá. */
export interface OpenAiProfileInput {
  id?: string;
  name?: string;
  apiKey?: string;
  clearKey?: boolean;
  baseUrl?: string;
  organization?: string;
  project?: string;
  defaultModel?: string;
}

/** Một request gửi đi: cấu hình + định hướng + prompt + tham số. */
export interface OpenAiRequest {
  /** Cấu hình dùng để gọi (khoá, base URL…); trống = cấu hình mặc định. */
  profileId: string;
  model: string;
  /** "Định hướng" — system prompt: vai trò, giọng văn, định dạng kết quả mong muốn. */
  system: string;
  prompt: string;
  /** Bỏ trống = để model tự chọn (một số model chỉ nhận mặc định). */
  temperature: number | null;
  /** Bỏ trống = không giới hạn ở phía mình. */
  maxTokens: number | null;
  format: OpenAiFormat;
  /** File đã import (chữ đọc ra) — server ghép vào sau prompt, mỗi file một khối có tên. */
  files?: OpenAiFile[];
}

/** Chữ đọc ra từ một file import (doc, docx, txt, csv, pdf, xlsx). */
export interface OpenAiFile {
  name: string;
  text: string;
}

/** Đuôi file import được vào prompt. */
export const OPENAI_FILE_EXTS = ['.txt', '.csv', '.doc', '.docx', '.pdf', '.xlsx'];

/** Prompt mẫu lưu lại để dùng lại (không có khoá, không có kết quả). `profileId` trống /
 *  cấu hình đã bị xoá = dùng cấu hình đang chọn. */
export interface OpenAiPreset extends Omit<OpenAiRequest, 'prompt'> {
  id: string;
  name: string;
  /** Prompt mẫu (có thể để trống, chỉ lưu định hướng). */
  prompt: string;
  updatedAt: string;
}

/** Token THẬT do API trả về (usage). */
export interface OpenAiUsage {
  /** Token input. */
  promptTokens: number;
  /** Token output (gồm cả token suy luận nếu có). */
  completionTokens: number;
  totalTokens: number;
  /** Phần input lấy từ bộ nhớ đệm prompt (tính giá rẻ hơn) — 0 nếu không có / API không báo. */
  cachedTokens?: number;
  /** Phần output là token suy luận (model o-series / gpt-5) — 0 nếu không có. */
  reasoningTokens?: number;
}

/** Ước tính token input trước khi gửi (lib/openaiTokens.ts). */
export interface OpenAiTokenEstimate {
  tokens: number;
  encoding: string;
  /** false: model lạ — tokenizer đoán, chỉ gần đúng. */
  exact: boolean;
}

/** Một lần hỏi tiến độ của request đang chạy. */
export interface OpenAiPoll {
  /** Phần chữ mới kể từ `from`. */
  text: string;
  next: number;
  done: boolean;
  error: string | null;
  model: string | null;
  usage: OpenAiUsage | null;
  finishReason: string | null;
  durationMs: number;
}

/** Model có vẻ dùng được cho chat (bỏ embedding, âm thanh, ảnh, kiểm duyệt…). */
export function isChatModel(id: string): boolean {
  return !/(embed|whisper|tts|dall-e|image|moderation|transcribe|realtime|audio|search|computer-use|babbage|davinci)/i.test(id);
}
