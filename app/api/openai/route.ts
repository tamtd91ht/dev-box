// /api/openai — gửi prompt tới OpenAI (ChatGPT qua API). Server: lib/openaiServer.ts.
//
// Cấu hình — lưu được NHIỀU cấu hình; khoá API KHÔNG bao giờ trả về (chỉ keyHint):
//   POST { action:'profiles.list' }                 → { ok, result: OpenAiProfiles }
//   POST { action:'profiles.save', profile }        → { ok, result: OpenAiProfiles }
//        profile.id trống = tạo mới; profile.apiKey trống = giữ khoá cũ; profile.clearKey = xoá khoá
//   POST { action:'profiles.remove', id }           → { ok, result: OpenAiProfiles }
//   POST { action:'profiles.setDefault', id }       → { ok, result: OpenAiProfiles }
//   POST { action:'models', profileId?, profile? }  → { ok, result: string[] }
//        profile = bản nháp để Thử trước khi lưu (có id = đè lên cấu hình đó)
// Request — job + poll (model suy luận có thể chạy vài phút):
//   POST { action:'start', request }                → { ok, result: { id } }     (request.profileId chọn cấu hình)
//   POST { action:'poll', id, from }                → { ok, result: OpenAiPoll }
//   POST { action:'stop', id }                      → { ok }
//   POST { action:'tokens', request }               → { ok, result: TokenEstimate }  (ước tính token input, không gọi API)
//   POST { action:'curl', request, withKey? }       → { ok, result: { curl, hasKey } }
//        lệnh cURL tương đương (stream:false; khoá = $OPENAI_API_KEY trừ khi withKey:true)
// File import vào prompt (doc, docx, txt, csv, pdf, xlsx → chữ; lib/fileText.ts):
//   POST { action:'file.read', name, data(base64) } → { ok, result: FileText }
//        chữ đọc ra gửi kèm request ở request.files [{ name, text }]
// Prompt mẫu:
//   POST { action:'presets.list' }                  → { ok, result: OpenAiPreset[] }
//   POST { action:'presets.save', preset }          → { ok, result: OpenAiPreset[] }   (có id = cập nhật)
//   POST { action:'presets.remove', id }            → { ok, result: OpenAiPreset[] }

import { NextResponse, type NextRequest } from 'next/server';
import {
  copyCurl, estimateTokens, listModels, poll, presetRemove, presetSave, presetsList, profileRemove, profileSave, profileSetDefault,
  profilesList, start, stop,
} from '@/lib/openaiServer';
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
