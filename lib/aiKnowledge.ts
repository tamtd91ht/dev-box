// Kho tri thức riêng của trợ lý AI — phía server (per-machine, file
// ai-knowledge.json trong thư mục cấu hình, full-file read/write như lib/docStore).
//
// "Đào tạo" ở đây KHÔNG phải fine-tune model: mỗi câu hỏi, các tài liệu đang
// bật được chèn vào prompt (thẻ <kho_tri_thuc>) để trợ lý trả lời dựa trên đó.
//   · Tổng tài liệu bật ≤ KB_BUDGET ký tự → gửi nguyên văn tất cả.
//   · Nhiều hơn → cắt tài liệu thành đoạn, chấm điểm theo từ khoá của câu hỏi
//     (không dấu, có trọng số từ hiếm + cộng điểm trùng tiêu đề) và chỉ gửi các
//     đoạn liên quan nhất cho vừa hạn mức.
// Trợ lý vẫn không có công cụ — nó không tự đọc được file nào ngoài phần chữ
// được chèn ở đây.

import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';
import { KB_BUDGET, KB_LIMITS, type KbDoc, type KbMeta } from './aiChat';

const REG_PATH = configPath('ai-knowledge.json');
const CHUNK_CHARS = 1600;

async function readAll(): Promise<KbDoc[]> {
  try {
    const data = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as { docs?: KbDoc[] };
    return Array.isArray(data.docs) ? data.docs : [];
  } catch { return []; }
}
async function writeAll(docs: KbDoc[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ docs }, null, 2), 'utf8');
}

const meta = (d: KbDoc): KbMeta => ({
  id: d.id, title: d.title, enabled: d.enabled, updatedAt: d.updatedAt, chars: d.content.length,
});

export async function kbList(): Promise<KbMeta[]> {
  return (await readAll()).map(meta);
}

export async function kbGet(id: unknown): Promise<KbDoc> {
  const d = (await readAll()).find((x) => x.id === id);
  if (!d) throw new Error('Không tìm thấy tài liệu.');
  return d;
}

export async function kbSave(input: Record<string, unknown>): Promise<KbMeta[]> {
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, KB_LIMITS.maxTitle) : '';
  const content = typeof input.content === 'string' ? input.content.replace(/\r\n?/g, '\n').trim() : '';
  if (!title) throw new Error('Thiếu tiêu đề tài liệu.');
  if (!content) throw new Error('Tài liệu chưa có nội dung.');
  if (content.length > KB_LIMITS.maxDocChars) {
    throw new Error(`Tài liệu dài quá ${KB_LIMITS.maxDocChars.toLocaleString('vi-VN')} ký tự — tách thành nhiều tài liệu nhỏ hơn.`);
  }
  const docs = await readAll();
  const now = new Date().toISOString();
  if (typeof input.id === 'string' && input.id) {
    const d = docs.find((x) => x.id === input.id);
    if (!d) throw new Error('Không tìm thấy tài liệu.');
    d.title = title; d.content = content; d.updatedAt = now;
  } else {
    if (docs.length >= KB_LIMITS.maxDocs) throw new Error(`Kho đã đủ ${KB_LIMITS.maxDocs} tài liệu — xoá bớt trước khi thêm.`);
    docs.unshift({ id: randomUUID(), title, content, enabled: true, updatedAt: now });
  }
  await writeAll(docs);
  return docs.map(meta);
}

export async function kbToggle(id: unknown, enabled: unknown): Promise<KbMeta[]> {
  const docs = await readAll();
  const d = docs.find((x) => x.id === id);
  if (!d) throw new Error('Không tìm thấy tài liệu.');
  d.enabled = enabled === true;
  await writeAll(docs);
  return docs.map(meta);
}

export async function kbRemove(id: unknown): Promise<KbMeta[]> {
  const docs = (await readAll()).filter((d) => d.id !== id);
  await writeAll(docs);
  return docs.map(meta);
}

// ── Chọn tri thức cho một câu hỏi ────────────────────────────────────────────

/** Từ quá phổ biến trong tiếng Việt/Anh (đã bỏ dấu) — không giúp phân biệt đoạn. */
const STOP = new Set(('la va cua cho co khong nhu the nao toi ban minh nay kia do thi ma de duoc trong ngoai khi neu voi cac nhung mot hai '
  + 'the a an and or of to in on is are be it for with how what why this that').split(' '));

function tokens(s: string): string[] {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .split(/[^a-z0-9_]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Cắt theo đoạn văn, gom lại cho mỗi khối khoảng CHUNK_CHARS ký tự. */
function chunksOf(content: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of content.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > CHUNK_CHARS) { out.push(cur); cur = ''; }
    if (para.length > CHUNK_CHARS * 1.5) {
      // Đoạn liền quá dài (log, JSON một khối): cắt cứng theo dòng.
      if (cur) { out.push(cur); cur = ''; }
      let piece = '';
      for (const line of para.split('\n')) {
        if (piece && piece.length + line.length + 1 > CHUNK_CHARS) { out.push(piece); piece = ''; }
        piece += (piece ? '\n' : '') + line.slice(0, CHUNK_CHARS * 2);
      }
      if (piece) out.push(piece);
      continue;
    }
    cur += (cur ? '\n\n' : '') + para;
  }
  if (cur) out.push(cur);
  return out;
}

export interface KnowledgePick {
  /** Khối chèn vào prompt ('' = không có gì để gửi). */
  text: string;
  /** Tiêu đề các tài liệu đã gửi — hiện dưới câu trả lời. */
  sources: string[];
}

const esc = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, ' ');

export async function pickKnowledge(query: string): Promise<KnowledgePick> {
  const docs = (await readAll()).filter((d) => d.enabled && d.content.trim());
  if (!docs.length) return { text: '', sources: [] };

  const total = docs.reduce((n, d) => n + d.content.length, 0);
  if (total <= KB_BUDGET) {
    return {
      text: docs.map((d) => `<tai_lieu ten="${esc(d.title)}">\n${d.content}\n</tai_lieu>`).join('\n\n'),
      sources: docs.map((d) => d.title),
    };
  }

  // Vượt hạn mức → chỉ lấy các đoạn liên quan nhất tới câu hỏi.
  const q = [...new Set(tokens(query))];
  if (!q.length) return { text: '', sources: [] };
  const all = docs.flatMap((d, di) => {
    const titleToks = new Set(tokens(d.title));
    return chunksOf(d.content).map((text, ci) => ({ di, ci, text, toks: tokens(text), titleToks }));
  });
  // Trọng số từ hiếm: từ xuất hiện ở ít đoạn thì đáng giá hơn.
  const df = new Map<string, number>();
  for (const c of all) for (const t of new Set(c.toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const scored = all.map((c) => {
    const tf = new Map<string, number>();
    for (const t of c.toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const n = tf.get(t);
      if (n) score += (1 + Math.log(n)) * Math.log(1 + all.length / (df.get(t) ?? 1));
      if (c.titleToks.has(t)) score += 1.5;
    }
    return { ...c, score };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);

  const picked: typeof scored = [];
  let size = 0;
  for (const c of scored) {
    if (size + c.text.length > KB_BUDGET) continue;
    picked.push(c);
    size += c.text.length;
  }
  if (!picked.length) return { text: '', sources: [] };

  // Xếp lại theo tài liệu + thứ tự gốc để đọc liền mạch.
  picked.sort((a, b) => a.di - b.di || a.ci - b.ci);
  const byDoc = new Map<number, string[]>();
  for (const c of picked) byDoc.set(c.di, [...(byDoc.get(c.di) ?? []), c.text]);
  return {
    text: [...byDoc].map(([di, parts]) =>
      `<tai_lieu ten="${esc(docs[di].title)}" ghi_chu="trích các đoạn liên quan">\n${parts.join('\n\n[…]\n\n')}\n</tai_lieu>`).join('\n\n'),
    sources: [...byDoc.keys()].map((di) => docs[di].title),
  };
}
