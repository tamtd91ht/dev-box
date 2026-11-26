// Kỹ năng của trợ lý AI — phía server (per-machine, file ai-skills.json trong thư mục cấu hình,
// đọc/ghi cả file như lib/aiKnowledge.ts).
//
// Kỹ năng là QUY TRÌNH người dùng tự soạn cho một loại việc (vd "đọc & phân tích nhóm Zalo"):
// cách lấy dữ liệu, cách phân tích, cách trình bày. Mỗi câu hỏi (pickSkills):
//   1. KÍCH HOẠT — chọn tối đa SKILL_LIMITS.maxActive kỹ năng đang bật, theo thứ tự:
//        · trợ lý / người dùng xin nạp đích danh (client gửi `skills: [tên]`);
//        · câu hỏi (+ câu hỏi liền trước) chứa từ khoá của kỹ năng — không dấu, nguyên từ;
//        · màn hình đang mở có tên khớp `screens` của kỹ năng.
//      Hướng dẫn của các kỹ năng này được chèn NGUYÊN VĂN vào prompt (thẻ <ky_nang>).
//   2. DANH MỤC — các kỹ năng bật còn lại chỉ gửi tên + "dùng khi" (thẻ <ky_nang_khac>). Trợ lý thấy
//      câu hỏi khớp thì trả lời đúng một khối <dung_ky_nang ten="…"/>; components/AiChat.tsx hỏi lại
//      kèm kỹ năng đó (≤ SKILL_LIMITS.maxRequests lần / câu hỏi).
// Kỹ năng chỉ là CHỮ trong prompt: nó không cấp thêm công cụ hay hành động nào cho trợ lý.

import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';
import { SKILL_LIMITS, type AiSkill, type AiSkillMeta } from './aiChat';
import { matchPhrase, normText, parseSkillMd, splitList } from './aiSkillFormat';

const REG_PATH = configPath('ai-skills.json');

async function readAll(): Promise<AiSkill[]> {
  try {
    const data = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as { skills?: AiSkill[] };
    return Array.isArray(data.skills) ? data.skills : [];
  } catch { return []; }
}
async function writeAll(skills: AiSkill[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ skills }, null, 2), 'utf8');
}

const meta = ({ instructions, ...s }: AiSkill): AiSkillMeta => ({ ...s, chars: instructions.length });

export async function skillList(): Promise<AiSkillMeta[]> {
  return (await readAll()).map(meta);
}

export async function skillGet(id: unknown): Promise<AiSkill> {
  const s = (await readAll()).find((x) => x.id === id);
  if (!s) throw new Error('Không tìm thấy kỹ năng.');
  return s;
}

export async function skillSave(input: Record<string, unknown>): Promise<AiSkillMeta[]> {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const name = str(input.name).replace(/\s+/g, ' ').trim().slice(0, SKILL_LIMITS.maxName);
  const description = str(input.description).replace(/\s+/g, ' ').trim();
  const instructions = str(input.instructions).replace(/\r\n?/g, '\n').trim();
  if (!name) throw new Error('Thiếu tên kỹ năng.');
  if (!description) throw new Error('Thiếu mô tả "Dùng khi" — trợ lý dựa vào đó để biết lúc nào cần kỹ năng này.');
  if (description.length > SKILL_LIMITS.maxDesc) throw new Error(`Mô tả dài quá ${SKILL_LIMITS.maxDesc} ký tự — viết ngắn lại, chi tiết để ở phần hướng dẫn.`);
  if (!instructions) throw new Error('Kỹ năng chưa có hướng dẫn.');
  if (instructions.length > SKILL_LIMITS.maxInstructions) {
    throw new Error(`Hướng dẫn dài quá ${SKILL_LIMITS.maxInstructions.toLocaleString('vi-VN')} ký tự — tài liệu tham khảo dài thì đưa vào Kho tri thức.`);
  }
  const keywords = splitList(input.keywords, SKILL_LIMITS.maxKeywords);
  const screens = splitList(input.screens, SKILL_LIMITS.maxScreens);

  const skills = await readAll();
  const id = typeof input.id === 'string' && input.id ? input.id : null;
  const clash = skills.find((s) => s.id !== id && normText(s.name) === normText(name));
  if (clash) throw new Error(`Đã có kỹ năng tên "${clash.name}" — đặt tên khác (trợ lý gọi kỹ năng theo tên).`);
  const now = new Date().toISOString();
  if (id) {
    const s = skills.find((x) => x.id === id);
    if (!s) throw new Error('Không tìm thấy kỹ năng.');
    Object.assign(s, { name, description, keywords, screens, instructions, updatedAt: now });
  } else {
    if (skills.length >= SKILL_LIMITS.maxSkills) throw new Error(`Đã đủ ${SKILL_LIMITS.maxSkills} kỹ năng — xoá bớt trước khi thêm.`);
    skills.unshift({ id: randomUUID(), name, description, keywords, screens, instructions, enabled: true, updatedAt: now });
  }
  await writeAll(skills);
  return skills.map(meta);
}

/** Nhập file SKILL.md (một hoặc nhiều — gọi lần lượt). Trùng tên thì ghi đè kỹ năng cũ. */
export async function skillImport(text: unknown, fileName: unknown): Promise<AiSkillMeta[]> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('File trống.');
  const d = parseSkillMd(text, typeof fileName === 'string' ? fileName : '');
  const same = (await readAll()).find((s) => normText(s.name) === normText(d.name));
  return skillSave({
    ...d,
    id: same?.id,
    description: d.description || `Dùng khi cần: ${d.name}`,
  });
}

export async function skillToggle(id: unknown, enabled: unknown): Promise<AiSkillMeta[]> {
  const skills = await readAll();
  const s = skills.find((x) => x.id === id);
  if (!s) throw new Error('Không tìm thấy kỹ năng.');
  s.enabled = enabled === true;
  await writeAll(skills);
  return skills.map(meta);
}

export async function skillRemove(id: unknown): Promise<AiSkillMeta[]> {
  const skills = (await readAll()).filter((s) => s.id !== id);
  await writeAll(skills);
  return skills.map(meta);
}

// ── Chọn kỹ năng cho một câu hỏi ────────────────────────────────────────────

export interface SkillPick {
  /** Khối chèn vào prompt ('' = không có kỹ năng nào bật). */
  text: string;
  /** Tên các kỹ năng đã kích hoạt — hiện dưới câu trả lời. */
  active: string[];
}

const esc = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, ' ');

export async function pickSkills(opts: { question: string; prevQuestion: string; screen: string; requested: unknown }): Promise<SkillPick> {
  const skills = (await readAll()).filter((s) => s.enabled && s.instructions.trim());
  if (!skills.length) return { text: '', active: [] };

  const requested = Array.isArray(opts.requested) ? opts.requested.filter((x): x is string => typeof x === 'string').slice(0, 6) : [];
  const q = normText(opts.question);
  const prev = normText(opts.prevQuestion);
  const scr = normText(opts.screen);

  const scored = skills.map((s, order) => {
    const asked = requested.some((r) => normText(r) === normText(s.name));
    const kwNow = s.keywords.filter((k) => matchPhrase(q, k));
    const kwPrev = kwNow.length ? [] : s.keywords.filter((k) => matchPhrase(prev, k));
    const scrHit = s.screens.find((x) => matchPhrase(scr, x));
    const nameHit = matchPhrase(q, s.name);
    const score = (asked ? 100 : 0) + (nameHit ? 20 : 0) + kwNow.length * 3 + kwPrev.length + (scrHit ? 2 : 0);
    const why = asked ? 'được xin nạp'
      : nameHit ? 'câu hỏi nhắc tên kỹ năng'
        : kwNow.length ? `từ khoá “${kwNow.slice(0, 3).join('”, “')}”`
          : scrHit ? `đang mở màn hình ${scrHit}`
            : kwPrev.length ? `câu hỏi trước có “${kwPrev[0]}”` : '';
    return { s, score, why, order };
  });

  const picked: typeof scored = [];
  let size = 0;
  for (const c of scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.order - b.order)) {
    if (picked.length >= SKILL_LIMITS.maxActive) break;
    if (size + c.s.instructions.length > SKILL_LIMITS.activeBudget && picked.length) continue;
    picked.push(c);
    size += c.s.instructions.length;
  }
  const missing = requested.filter((r) => !skills.some((s) => normText(s.name) === normText(r)));
  const rest = skills.filter((s) => !picked.some((p) => p.s.id === s.id)).slice(0, 60);

  const parts: string[] = [];
  if (picked.length) {
    parts.push(`<ky_nang_dang_dung>\n${picked.map((p) => (
      `<ky_nang ten="${esc(p.s.name)}" dung_khi="${esc(p.s.description)}" ly_do_kich_hoat="${esc(p.why)}">\n${p.s.instructions}\n</ky_nang>`
    )).join('\n\n')}\n</ky_nang_dang_dung>`);
  }
  if (rest.length) {
    parts.push(`<ky_nang_khac>\n${rest.map((s) => `- ${s.name} — dùng khi: ${s.description.slice(0, 300)}`).join('\n')}\n</ky_nang_khac>`);
  }
  if (missing.length) parts.push(`(Không có kỹ năng tên: ${missing.map((m) => `"${esc(m)}"`).join(', ')} — đừng xin nạp lại, làm tiếp bình thường.)`);
  return { text: parts.join('\n\n'), active: picked.map((p) => p.s.name) };
}
