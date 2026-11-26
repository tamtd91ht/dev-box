// /api/claude — gửi prompt tới Claude qua Claude API (menu ClaudeAI). Server: lib/claudeServer.ts
// (SDK @anthropic-ai/sdk). Cùng bộ action với /api/openai để giao diện dùng chung
// (components/OpenAiWorkspace.tsx, provider "claude"):
//   profiles.list / profiles.save / profiles.remove / profiles.setDefault   — nhiều cấu hình, khoá không trả về
//   models { profileId?, profile? }      — Models API (profile = bản nháp để Thử kết nối)
//   start { request } / poll { id, from } / stop { id }   — request chạy thành job
//   tokens { request }                   — token input THẬT (endpoint count_tokens)
//   curl { request, withKey? }           — lệnh cURL tương đương
//   file.read { name, data }             — doc, docx, txt, csv, pdf, xlsx → chữ (lib/fileText.ts)
//   presets.list / presets.save / presets.remove

import { NextResponse, type NextRequest } from 'next/server';
import {
  copyCurl, estimateTokens, listModels, poll, presetRemove, presetSave, presetsList, profileRemove, profileSave,
  profileSetDefault, profilesList, start, stop,
} from '@/lib/claudeServer';
import { fileToText } from '@/lib/fileText';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? '');
  try {
    switch (action) {
      case 'profiles.list':
        return NextResponse.json({ ok: true, result: await profilesList() });
      case 'profiles.save':
        return NextResponse.json({ ok: true, result: await profileSave(body?.profile) });
      case 'profiles.remove':
        return NextResponse.json({ ok: true, result: await profileRemove(body?.id) });
      case 'profiles.setDefault':
        return NextResponse.json({ ok: true, result: await profileSetDefault(body?.id) });
      case 'models':
        return NextResponse.json({ ok: true, result: await listModels(body?.profileId, body?.profile) });
      case 'start':
        return NextResponse.json({ ok: true, result: await start(body?.request) });
      case 'poll':
        return NextResponse.json({ ok: true, result: poll(body?.id, body?.from) });
      case 'stop':
        stop(body?.id);
        return NextResponse.json({ ok: true });
      case 'tokens':
        return NextResponse.json({ ok: true, result: await estimateTokens(body?.request) });
      case 'curl':
        return NextResponse.json({ ok: true, result: await copyCurl(body?.request, body?.withKey) });
      case 'file.read':
        return NextResponse.json({ ok: true, result: await fileToText(body?.name, body?.data) });
      case 'presets.list':
        return NextResponse.json({ ok: true, result: await presetsList() });
      case 'presets.save':
        return NextResponse.json({ ok: true, result: await presetSave(body?.preset) });
      case 'presets.remove':
        return NextResponse.json({ ok: true, result: await presetRemove(body?.id) });
      default:
        return NextResponse.json({ ok: false, error: `action không hỗ trợ: "${action}"` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
