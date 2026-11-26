// Kỹ năng của trợ lý AI — phần dùng chung client/server (không đụng fs).
//
//   · normText / matchPhrase: so khớp từ khoá / tên màn hình KHÔNG dấu, theo nguyên từ.
//   · parseSkillMd / skillToMd: nhập / xuất kỹ năng dạng SKILL.md (frontmatter name, description,
//     keywords, screens + phần thân là hướng dẫn) — cùng khuôn với Agent Skills của Claude.
//   · parseSkillRequest / stripSkillRequest: khối <dung_ky_nang ten="…"/> trợ lý viết khi muốn
//     app nạp một kỹ năng trong danh mục (lib/aiChatServer.ts mô tả luật cho model).

import type { AiSkill } from './aiChat';

/** Chữ thường, bỏ dấu, mọi ký tự không phải chữ/số thành dấu cách, có đệm cách hai đầu. */
export function normText(s: string): string {
  const t = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return t ? ` ${t} ` : ' ';
}

/** `phrase` (một từ hoặc cụm từ) có nằm NGUYÊN TỪ trong `normed` (kết quả normText) không. */
export function matchPhrase(normed: string, phrase: string): boolean {
  const p = normText(phrase);
  return p.trim() !== '' && normed.includes(p);
}

/** "a, b; c\nd" → ['a','b','c','d'] (bỏ trùng, bỏ rỗng). */
export function splitList(v: unknown, max: number, maxLen = 60): string[] {
  const arr = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,;\n]/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const x = raw.replace(/\s+/g, ' ').trim().slice(0, maxLen);
    const k = normText(x);
    if (!x || k === ' ' || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

export interface SkillDraft { name: string; description: string; keywords: string[]; screens: string[]; instructions: string }

/** Đọc một file SKILL.md. Không có frontmatter thì lấy tiêu đề # đầu tiên (hoặc tên file) làm tên. */
export function parseSkillMd(text: string, fileName = ''): SkillDraft {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const head: Record<string, string> = {};
  let body = src;
  if (fm) {
    body = src.slice(fm[0].length);
    let key = '';
    for (const line of fm[1].split('\n')) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) { key = kv[1].toLowerCase(); head[key] = kv[2].trim(); continue; }
      // Giá trị nhiều dòng (description: > … hoặc danh sách "- a").
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (key && item) head[key] = `${head[key] ? `${head[key]},` : ''}${item[1].trim()}`;
      else if (key && /^\s+\S/.test(line)) head[key] = `${head[key]} ${line.trim()}`.trim();
    }
  }
  const unq = (s = '') => s.replace(/^[>|]\s*/, '').replace(/^\[(.*)\]$/, '$1').replace(/^(["'])(.*)\1$/, '$2').trim();
  const list = (s = '') => unq(s).split(',').map((x) => unq(x.trim())).filter(Boolean);
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    name: unq(head.name) || h1 || fileName.replace(/\.[^.]+$/, '').replace(/^SKILL$/i, '') || 'Kỹ năng mới',
    description: unq(head.description),
    keywords: list(head.keywords ?? head.triggers),
    screens: list(head.screens),
    instructions: body.trim(),
  };
}

const yq = (s: string) => (/^[\w À-ỹ.()/-]+$/.test(s) && !/^\s|\s$/.test(s) ? s : JSON.stringify(s));

/** Kỹ năng → SKILL.md (nhập lại được bằng parseSkillMd). */
export function skillToMd(s: Pick<AiSkill, 'name' | 'description' | 'keywords' | 'screens' | 'instructions'>): string {
  return [
    '---',
    `name: ${yq(s.name)}`,
    `description: ${JSON.stringify(s.description)}`,
    ...(s.keywords.length ? [`keywords: [${s.keywords.map(yq).join(', ')}]`] : []),
    ...(s.screens.length ? [`screens: [${s.screens.map(yq).join(', ')}]`] : []),
    '---',
    '',
    s.instructions.trim(),
    '',
  ].join('\n');
}

const REQ_RE = /<dung_ky_nang\s+ten\s*=\s*"([^"]{1,120})"\s*\/?>(?:\s*<\/dung_ky_nang>)?/i;

/** Tên kỹ năng trợ lý xin nạp (null = không xin). */
export function parseSkillRequest(raw: string): string | null {
  return REQ_RE.exec(raw)?.[1]?.trim() || null;
}

/** Bỏ khối xin nạp kỹ năng (kể cả khối đang stream dở) khỏi phần chữ hiển thị. */
export function stripSkillRequest(raw: string): string {
  let out = raw.replace(new RegExp(REQ_RE.source, 'gi'), '');
  // Đang stream dở: "<dung_ky_na…" chưa có '>' ở cuối chữ.
  const i = out.lastIndexOf('<');
  const tail = i >= 0 ? out.slice(i + 1).toLowerCase() : '';
  if (i >= 0 && !tail.includes('>') && ('dung_ky_nang'.startsWith(tail) || tail.startsWith('dung_ky_nang'))) out = out.slice(0, i);
  return out.trim();
}

/** Mẫu điền sẵn khi thêm kỹ năng — đúng ví dụ hay dùng nhất: đọc & phân tích nhóm Zalo. */
export const SKILL_TEMPLATE: SkillDraft = {
  name: 'Phân tích nhóm Zalo',
  description: 'Dùng khi người hỏi muốn đọc, tóm tắt, phân tích vấn đề / sự cố / yêu cầu trong một nhóm (group) Zalo.',
  keywords: ['zalo', 'nhóm', 'group', 'tin nhắn', 'đoạn chat'],
  screens: ['Zalo'],
  instructions: `# Phân tích nhóm Zalo

## Cách đọc
1. Mở tab Zalo (nếu chưa mở), đọc màn hình để biết đang ở nhóm nào. Người hỏi nói tên nhóm khác thì bấm vào đúng nhóm đó trong danh sách.
2. Cuộn LÊN trong khung tin nhắn cho tới mốc thời gian người hỏi cần (mặc định: hôm nay). Mỗi lần cuộn ghi chú ngắn các tin mới thấy (giờ — người gửi — nội dung chính).
3. Ảnh / file trong nhóm: chỉ ghi tên file và ai gửi, không đoán nội dung ảnh nếu không nhìn rõ.

## Cách phân tích
- Gom các tin theo VẤN ĐỀ (cùng một sự cố / yêu cầu), không liệt kê theo thứ tự thời gian.
- Với mỗi vấn đề: mô tả ngắn, ai báo, lúc nào, mức độ (khẩn / bình thường), đã có ai nhận xử lý chưa, trạng thái hiện tại (đã xong / đang xử lý / chưa ai trả lời).
- Đánh dấu riêng các câu hỏi / yêu cầu nhắc tới người hỏi mà CHƯA được trả lời.

## Cách trình bày
- Mở đầu bằng 2–3 dòng tóm tắt.
- Bảng: | Vấn đề | Người báo | Thời gian | Trạng thái | Cần làm |
- Cuối cùng: "Việc cần làm ngay" (tối đa 5 gạch đầu dòng).
- Không chép lại số điện thoại, mật khẩu, mã OTP có trong tin nhắn.`,
};
