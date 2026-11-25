// Server-only: ƯỚC TÍNH token input của một request OpenAI TRƯỚC khi gửi (menu 🤖 OpenAI).
//
// Đếm bằng tokenizer của OpenAI (js-tiktoken, chạy trên Node — không gọi API, không tốn tiền),
// trên đúng các message sẽ gửi (định hướng + prompt + chữ của file — lib/openaiServer.ts
// chatBody), cộng phần phụ của định dạng chat theo OpenAI cookbook: mỗi message ~3 token + tên
// role, cuối cùng +3 token mồi câu trả lời. Sau khi gửi, số THẬT lấy từ `usage` của API.
//
// Bảng mã theo model: o200k_base (gpt-4o, gpt-4.1, gpt-4.5, gpt-5, o1/o3/o4…), cl100k_base
// (gpt-4, gpt-3.5). Model lạ (dịch vụ tương thích, model mới) → o200k_base, đánh dấu `exact:false`.

import type { Tiktoken } from 'js-tiktoken/lite';

export interface TokenEstimate {
  tokens: number;
  encoding: 'o200k_base' | 'cl100k_base';
  /** false: model lạ — bảng mã đoán, chỉ là ước lượng gần đúng. */
  exact: boolean;
}

/** Quá chừng này ký tự thì không đếm (tốn CPU) — trả ước lượng thô theo ký tự. */
const MAX_COUNT_CHARS = 2_000_000;

const encoders: Partial<Record<TokenEstimate['encoding'], Promise<Tiktoken>>> = {};

async function encoder(name: TokenEstimate['encoding']): Promise<Tiktoken> {
  // Nạp lười: bảng mã vài MB, chỉ nạp khi có người đếm lần đầu, rồi giữ lại.
  encoders[name] ??= (async () => {
    const { Tiktoken: T } = await import('js-tiktoken/lite');
    const ranks = name === 'o200k_base'
      ? (await import('js-tiktoken/ranks/o200k_base')).default
      : (await import('js-tiktoken/ranks/cl100k_base')).default;
    return new T(ranks);
  })();
  return encoders[name]!;
}

function encodingFor(model: string): { encoding: TokenEstimate['encoding']; exact: boolean } {
  const m = model.toLowerCase().replace(/^.*\//, ''); // "openai/gpt-4o" (OpenRouter) → "gpt-4o"
  if (/^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o1|o3|o4)/.test(m)) return { encoding: 'o200k_base', exact: true };
  if (/^(gpt-4|gpt-3\.5)/.test(m)) return { encoding: 'cl100k_base', exact: true };
  return { encoding: 'o200k_base', exact: false };
}

/** Token input của các message (chat format). */
export async function countChatTokens(model: string, messages: { role: string; content: string }[]): Promise<TokenEstimate> {
  const { encoding, exact } = encodingFor(model);
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_COUNT_CHARS) {
    // ~4 ký tự / token với tiếng Anh, tiếng Việt dày hơn — lấy 3 để không ước thấp.
    return { tokens: Math.ceil(chars / 3), encoding, exact: false };
  }
  const enc = await encoder(encoding);
  let tokens = 3; // mồi câu trả lời: <|start|>assistant<|message|>
  for (const m of messages) tokens += 3 + enc.encode(m.role).length + enc.encode(m.content).length;
  return { tokens, encoding, exact };
}
