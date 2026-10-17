// Dịch nhanh (components/QuickTranslate.tsx) — kiểu dữ liệu + ngôn ngữ + gọi API.
//
// Dùng chung client/server: chỉ có type, hằng số và hàm gọi /api/translate.
// Phần gọi nguồn dịch thật nằm ở lib/translateServer.ts.

import { apiFetch } from './apiFetch';

export interface TransLang { code: string; name: string }

/** Ngôn ngữ chọn được. 'auto' chỉ hợp lệ ở phía NGUỒN. */
export const LANGS: TransLang[] = [
  { code: 'auto', name: 'Tự nhận diện' },
  { code: 'en', name: 'English' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'fr', name: 'Français' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'zh-CN', name: '中文 (giản thể)' },
  { code: 'zh-TW', name: '中文 (phồn thể)' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'th', name: 'ไทย' },
  { code: 'id', name: 'Indonesia' },
  { code: 'ms', name: 'Melayu' },
  { code: 'lo', name: 'ລາວ' },
  { code: 'km', name: 'ខ្មែរ' },
];

export const LANG_CODES = new Set(LANGS.map((l) => l.code));

/** Nhãn ngắn trên chip: en, vi, zh… */
export const shortLang = (code: string) => (code === 'auto' ? 'auto' : code.split('-')[0]);

export interface LangPair { from: string; to: string }

export const DEFAULT_PAIRS: LangPair[] = [
  { from: 'en', to: 'vi' },
  { from: 'vi', to: 'en' },
  { from: 'fr', to: 'vi' },
  { from: 'auto', to: 'vi' },
];

export const pairKey = (p: LangPair) => `${p.from}-${p.to}`;

export interface TransResult {
  /** Bản dịch chính. */
  text: string;
  /** Ngôn ngữ nguồn (đã nhận diện khi from=auto). */
  src: string;
  /** Phiên âm của câu gốc / bản dịch (pinyin, romaji, IPA…), nếu có. */
  srcTranslit?: string;
  translit?: string;
  /** "Có phải bạn muốn gõ…" — chuỗi đã sửa chính tả. */
  didYouMean?: string;
  /** Từ điển theo từ loại: nghĩa + các từ dịch ngược. */
  dict: { pos: string; entries: { word: string; reverse: string[] }[] }[];
  /** Định nghĩa (ngôn ngữ gốc) kèm ví dụ. */
  definitions: { pos: string; items: { gloss: string; example?: string }[] }[];
  synonyms: { pos: string; words: string[] }[];
  /** Câu ví dụ — có thẻ <b> quanh từ đang tra (render an toàn ở client). */
  examples: string[];
  /** Cách dịch khác cho cả cụm. */
  alternatives: string[];
  /** Nguồn đã trả kết quả: google | mymemory. */
  engine: string;
}

/**
 * Gọi /api/translate qua apiFetch (main process ở bản desktop): fetch thẳng từ
 * renderer có thể treo vô hạn khi 6 kết nối tới localhost bị SSE terminal /
 * automation chiếm hết. `signal` chỉ để huỷ LOGIC — cầu không huỷ được giữa
 * chừng, nên kết quả về muộn bị bỏ qua ở đây thay vì ở call site.
 */
async function call<T>(body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
  const res = await apiFetch('/api/translate', { method: 'POST', body: JSON.stringify(body), timeoutMs });
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; result?: T } | null;
  if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data.result as T;
}

export const translateText = (q: string, from: string, to: string, signal?: AbortSignal) =>
  call<TransResult>({ action: 'translate', q, from, to }, signal);

export const suggestText = (q: string, lang: string, signal?: AbortSignal) =>
  call<string[]>({ action: 'suggest', q, lang }, signal, 8_000);

/** Âm thanh đọc to (base64 MP3, chia đoạn) — xem tts() trong lib/translateServer.ts. */
export const speechAudio = (q: string, lang: string) =>
  call<{ mime: string; chunks: string[] }>({ action: 'tts', q, lang }, undefined, 20_000);
