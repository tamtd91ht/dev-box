// Server-only: gọi nguồn dịch thật cho /api/translate.
//
// NGUỒN CHÍNH — Google Translate endpoint `client=gtx` (cái mà extension/trang
// dịch nhanh vẫn dùng): miễn phí, không key, nhanh, chất lượng tốt nhất trong
// các nguồn free, và một lượt gọi trả luôn từ điển, định nghĩa, ví dụ, đồng
// nghĩa, phiên âm, cách dịch khác, sửa chính tả — đủ cho nút "Xem thêm".
// Không chính thức nên có thể bị giới hạn tần suất → có DỰ PHÒNG.
//
// DỰ PHÒNG — MyMemory (api.mymemory.translated.net): free 5.000 ký tự/ngày
// không cần key, chỉ có bản dịch (không từ điển).
//
// GỢI Ý — Google Suggest (client=firefox): gợi ý cụm từ cho mọi ngôn ngữ;
// tiếng Anh thì bù thêm Datamuse (sửa chính tả theo âm/chữ) khi Google trống.
//
// Đi qua server vì: các endpoint này không mở CORS cho renderer, và đổi nguồn
// chỉ phải sửa ở đây.

import { LANG_CODES, type TransResult } from './translate';

const TIMEOUT_MS = 8_000;
export const MAX_CHARS = 5_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Cache nhỏ trong bộ nhớ: gõ đi gõ lại / bật "Xem thêm" không gọi lại nguồn. */
const cache = new Map<string, TransResult>();
const CACHE_MAX = 300;

export function checkLang(code: unknown, allowAuto: boolean): string {
  const c = String(code ?? '');
  if (!LANG_CODES.has(c) || (!allowAuto && c === 'auto')) throw new Error(`Ngôn ngữ không hỗ trợ: "${c}"`);
  return c;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');

/* eslint-disable @typescript-eslint/no-explicit-any -- JSON của gtx không có schema */
async function viaGoogle(q: string, from: string, to: string): Promise<TransResult> {
  const dts = ['t', 'bd', 'md', 'ex', 'ss', 'rm', 'at', 'qca'].map((d) => `dt=${d}`).join('&');
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&hl=vi&ie=UTF-8&oe=UTF-8&dj=1&${dts}`;
  // POST form: câu dài không vướng giới hạn độ dài URL.
  const j = (await getJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ q }).toString(),
  })) as any;

  const sentences: any[] = Array.isArray(j?.sentences) ? j.sentences : [];
  const text = sentences.map((s) => s.trans ?? '').join('');
  if (!text) throw new Error('Google không trả bản dịch');
  const tl = sentences.find((s) => s.translit || s.src_translit) ?? {};

  // Với tiếng Việt Google đôi khi trả chuỗi sửa chính tả vỡ mã (có U+FFFD) — bỏ.
  const spellRaw = j?.spell?.spell_res ? String(j.spell.spell_res) : '';
  const spell = spellRaw && !spellRaw.includes('�') ? spellRaw : undefined;
  const alternatives: string[] = [];
  // Cách dịch khác chỉ có nghĩa khi cả input là MỘT cụm (nhiều câu thì mỗi câu một bộ, đọc rối).
  if (Array.isArray(j?.alternative_translations) && j.alternative_translations.length === 1) {
    for (const a of j.alternative_translations[0]?.alternative ?? []) {
      const w = String(a?.word_postproc ?? '').trim();
      if (w && w !== text.trim() && !alternatives.includes(w)) alternatives.push(w);
    }
  }

  return {
    text,
    src: String(j?.src ?? from),
    srcTranslit: tl.src_translit || undefined,
    translit: tl.translit || undefined,
    didYouMean: spell && spell.toLowerCase() !== q.trim().toLowerCase() ? spell : undefined,
    dict: (j?.dict ?? []).map((d: any) => ({
      pos: String(d.pos ?? ''),
      entries: (d.entry ?? []).slice(0, 12).map((e: any) => ({
        word: String(e.word ?? ''),
        reverse: (e.reverse_translation ?? []).slice(0, 6).map(String),
      })),
    })),
    definitions: (j?.definitions ?? []).map((d: any) => ({
      pos: String(d.pos ?? ''),
      items: (d.entry ?? []).slice(0, 6).map((e: any) => ({
        gloss: String(e.gloss ?? ''),
        example: e.example ? String(e.example) : undefined,
      })),
    })),
    synonyms: (j?.synsets ?? []).map((s: any) => ({
      pos: String(s.pos ?? ''),
      words: [...new Set<string>((s.entry ?? []).flatMap((e: any) => e.synonym ?? []).map(String))].slice(0, 20),
    })),
    examples: (j?.examples?.example ?? []).slice(0, 8).map((e: any) => String(e.text ?? '')),
    alternatives: alternatives.slice(0, 8),
    engine: 'google',
  };
}

async function viaMyMemory(q: string, from: string, to: string): Promise<TransResult> {
  // MyMemory không có "auto" và giới hạn ~500 byte mỗi lượt.
  const sl = from === 'auto' ? 'en' : from;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q.slice(0, 480))}&langpair=${sl}|${to}`;
  const j = (await getJson(url)) as any;
  const text = String(j?.responseData?.translatedText ?? '');
  if (!text || j?.responseStatus !== 200) throw new Error(String(j?.responseDetails || 'MyMemory không trả bản dịch'));
  return {
    text: stripTags(text), src: sl, dict: [], definitions: [], synonyms: [], examples: [],
    alternatives: [], engine: 'mymemory',
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function translate(qRaw: unknown, fromRaw: unknown, toRaw: unknown): Promise<TransResult> {
  const q = String(qRaw ?? '').trim();
  if (!q) throw new Error('Chưa có nội dung cần dịch.');
  if (q.length > MAX_CHARS) throw new Error(`Dài quá ${MAX_CHARS} ký tự — dịch từng đoạn.`);
  const from = checkLang(fromRaw, true);
  const to = checkLang(toRaw, false);

  const key = `${from}|${to}|${q}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let r: TransResult;
  try {
    r = await viaGoogle(q, from, to);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[translate] Google lỗi, chuyển MyMemory: ${(e as Error).message}`);
    try {
      // KHÔNG cache bản dự phòng: Google lỗi thường chỉ thoáng qua (429), cache
      // lại thì từ đó cụm này mãi mất phần từ điển / "Xem thêm".
      return await viaMyMemory(q, from, to);
    } catch (e2) {
      throw new Error(`Không dịch được — Google: ${(e as Error).message}; MyMemory: ${(e2 as Error).message}`);
    }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, r);
  return r;
}

export async function suggest(qRaw: unknown, langRaw: unknown): Promise<string[]> {
  const q = String(qRaw ?? '').trim();
  if (!q || q.length > 80) return [];
  const lang = checkLang(langRaw, true);
  const hl = lang === 'auto' ? 'en' : lang;
  let out: string[] = [];
  try {
    const j = (await getJson(
      `https://suggestqueries.google.com/complete/search?client=firefox&ie=UTF-8&oe=UTF-8&hl=${hl}&q=${encodeURIComponent(q)}`,
    )) as [string, string[]];
    out = Array.isArray(j?.[1]) ? j[1].map(String) : [];
  } catch { /* thử nguồn sau */ }
  if (!out.length && (hl === 'en') && /^[a-z' -]+$/i.test(q)) {
    try {
      const j = (await getJson(`https://api.datamuse.com/sug?max=8&s=${encodeURIComponent(q)}`)) as { word: string }[];
      out = j.map((x) => x.word);
    } catch { /* không có gợi ý cũng không sao */ }
  }
  return [...new Set(out)].filter((s) => s.toLowerCase() !== q.toLowerCase()).slice(0, 8);
}

// ── Đọc to (nút 🔊) ──────────────────────────────────────────────────────────
//
// Google translate_tts trả 404 nếu request mang Referer của localhost — mà thẻ
// <audio> trong renderer luôn gửi Referer, nên phát thẳng URL từ client thì im
// lặng. Server tải về (không Referer) rồi trả base64 qua apiFetch.
//
// Mỗi lượt Google chỉ đọc ~200 ký tự → cắt theo câu / dấu phẩy / khoảng trắng.

const TTS_CHUNK = 190;
const TTS_MAX_CHUNKS = 8;

function ttsChunks(text: string): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trim();
  while (rest && out.length < TTS_MAX_CHUNKS) {
    if (rest.length <= TTS_CHUNK) { out.push(rest); break; }
    const head = rest.slice(0, TTS_CHUNK);
    // Ưu tiên cắt sau dấu câu, rồi dấu phẩy, rồi khoảng trắng; không có thì cắt cứng.
    let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('。'));
    if (cut < 60) cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf('，'));
    if (cut < 60) cut = head.lastIndexOf(' ');
    if (cut < 20) cut = TTS_CHUNK - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  return out.filter(Boolean);
}

/** → các đoạn MP3 base64, phát lần lượt. */
export async function tts(qRaw: unknown, langRaw: unknown): Promise<{ mime: string; chunks: string[] }> {
  const q = String(qRaw ?? '').trim();
  if (!q) throw new Error('Không có gì để đọc.');
  // Ngôn ngữ đọc có thể là mã Google tự nhận diện (nl, sv…) ngoài danh sách
  // chọn được — chỉ kiểm tra đúng DẠNG mã, không đòi nằm trong LANGS.
  const lang = String(langRaw ?? '');
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) throw new Error(`Mã ngôn ngữ đọc không hợp lệ: "${lang}"`);
  const parts = ttsChunks(q);
  const chunks = await Promise.all(parts.map(async (part, i) => {
    const url = `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=${encodeURIComponent(lang)}`
      + `&total=${parts.length}&idx=${i}&textlen=${part.length}&q=${encodeURIComponent(part)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Google đọc lỗi HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  }));
  return { mime: 'audio/mpeg', chunks };
}
