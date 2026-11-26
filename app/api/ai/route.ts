// /api/ai — trợ lý AI (components/AiChat.tsx). Xem lib/aiChatServer.ts.
//
//   POST { action:'ask', question, history?, screen?, model?, attachments?,
//          agent?, tabs?, steps? } → { ok, id }
//        agent=true: bật "thao tác màn hình" — model có thể trả về một khối
//        <hanh_dong>; RENDERER thực hiện (lib/aiScreen.ts) rồi hỏi tiếp kèm steps.
//   POST { action:'poll', id, from }  → { ok, result: AiPoll }   (phần chữ mới + trạng thái)
//   POST { action:'stop', id }        → { ok }
//
// Kho tri thức riêng (lib/aiKnowledge.ts) — tài liệu bật được chèn vào prompt:
//   POST { action:'kb.list' }                    → { ok, result: KbMeta[] }
//   POST { action:'kb.get', id }                 → { ok, result: KbDoc }
//   POST { action:'kb.save', id?, title, content } → { ok, result: KbMeta[] }
//   POST { action:'kb.toggle', id, enabled }     → { ok, result: KbMeta[] }
//   POST { action:'kb.remove', id }              → { ok, result: KbMeta[] }
//
// Kỹ năng (lib/aiSkills.ts) — quy trình người dùng soạn; kích hoạt theo từ khoá / màn hình / trợ lý xin nạp:
//   POST { action:'skill.list' }                                     → { ok, result: AiSkillMeta[] }
//   POST { action:'skill.get', id }                                  → { ok, result: AiSkill }
//   POST { action:'skill.save', id?, name, description, keywords, screens, instructions } → { ok, result: AiSkillMeta[] }
//   POST { action:'skill.import', text, fileName }                   → { ok, result: AiSkillMeta[] }   (SKILL.md)
//   POST { action:'skill.toggle', id, enabled }                      → { ok, result: AiSkillMeta[] }
//   POST { action:'skill.remove', id }                               → { ok, result: AiSkillMeta[] }
//   ('ask' nhận thêm `skills: [tên]` — kỹ năng trợ lý vừa xin nạp.)
//
// Link ẩn trong ô Google Sheets (trợ lý đọc màn hình — lib/aiScreen.ts; main.cjs tải .xlsx của tab):
//   POST { action:'links.xlsx', data, sheet? } → { ok, result: { links, sheets, truncated } }   (chỉ đọc file gửi lên)
//
// Xuất file trợ lý viết (khối <xuat_file>) — CHỈ sau khi người dùng bấm đồng ý (components/AiChat.tsx):
//   POST { action:'export.build', name, content } → { ok, result: { data (base64), mime } }   (.docx / .xlsx; dựng
//   trong bộ nhớ, không ghi đĩa — lib/aiExport.ts)
//
// Trợ lý không có công cụ và route này không chạy gì khác
// ngoài `claude -p` không-công-cụ — đừng thêm action cho nó thao tác lên máy.

import { NextResponse, type NextRequest } from 'next/server';
import { ask, poll, stop } from '@/lib/aiChatServer';
import { kbGet, kbList, kbRemove, kbSave, kbToggle } from '@/lib/aiKnowledge';
import { buildExport } from '@/lib/aiExport';
import { skillGet, skillImport, skillList, skillRemove, skillSave, skillToggle } from '@/lib/aiSkills';
import { xlsxLinks } from '@/lib/aiLinks';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? '');
  try {
    switch (action) {
      case 'ask':
        return NextResponse.json({ ok: true, ...(await ask(body ?? {})) });
      case 'export.build':
        return NextResponse.json({ ok: true, result: await buildExport(body?.name, body?.content) });
      case 'links.xlsx':
        return NextResponse.json({ ok: true, result: await xlsxLinks(body?.data, body?.sheet) });
      case 'poll':
        return NextResponse.json({ ok: true, result: poll(body?.id, body?.from) });
      case 'stop':
        stop(body?.id);
        return NextResponse.json({ ok: true });
      case 'kb.list':
        return NextResponse.json({ ok: true, result: await kbList() });
      case 'kb.get':
        return NextResponse.json({ ok: true, result: await kbGet(body?.id) });
      case 'kb.save':
        return NextResponse.json({ ok: true, result: await kbSave(body ?? {}) });
      case 'kb.toggle':
        return NextResponse.json({ ok: true, result: await kbToggle(body?.id, body?.enabled) });
      case 'kb.remove':
        return NextResponse.json({ ok: true, result: await kbRemove(body?.id) });
      case 'skill.list':
        return NextResponse.json({ ok: true, result: await skillList() });
      case 'skill.get':
        return NextResponse.json({ ok: true, result: await skillGet(body?.id) });
      case 'skill.save':
        return NextResponse.json({ ok: true, result: await skillSave(body ?? {}) });
      case 'skill.import':
        return NextResponse.json({ ok: true, result: await skillImport(body?.text, body?.fileName) });
      case 'skill.toggle':
        return NextResponse.json({ ok: true, result: await skillToggle(body?.id, body?.enabled) });
      case 'skill.remove':
        return NextResponse.json({ ok: true, result: await skillRemove(body?.id) });
      default:
        return NextResponse.json({ ok: false, error: `action không hỗ trợ: "${action}"` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
