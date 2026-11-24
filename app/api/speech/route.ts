// /api/speech — STT & TTS (lib/speechServer.ts).
//
// STT — Whisper chạy trên máy, job + poll (nhận dạng lâu hơn hạn của cầu apiFetch):
//   POST { action:'stt.status' }                    → { ok, result: SttStatus }  (model nào đã tải)
//   POST { action:'stt.start', model, language }    → { ok, result: { id } }
//   POST { action:'stt.append', id, data }          → { ok, result: { bytes } }  (PCM 16 kHz mono 16-bit, base64)
//   POST { action:'stt.run', id }                   → { ok, result: { ok } }     (đã gửi đủ → xếp hàng chạy)
//   POST { action:'stt.poll', id }                  → { ok, result: SttPoll }
//   POST { action:'stt.cancel', id }                → { ok }
// TTS — Google translate_tts (chữ được gửi tới Google):
//   POST { action:'tts', text, lang, provider? }    → { ok, result: { mime, chunks: base64[] } }
//
// Nhà cung cấp tích hợp qua API (cấu hình động — lib/speechProviders.ts). `provider`
// ở stt.start / tts là id của một bản cấu hình; bỏ trống hoặc 'default' = mặc định.
//   POST { action:'providers.list' }                → { ok, result: SpeechProvider[] }
//   POST { action:'providers.save', provider }      → { ok, result: SpeechProvider[] }   (có id = cập nhật)
//   POST { action:'providers.remove', id }          → { ok, result: SpeechProvider[] }
//   POST { action:'providers.test', provider, text? | pcm?, language? }
//                                                   → { ok, result: ProviderTest }       (thử cấu hình CHƯA lưu,
//                                                      trả kèm phản hồi thô để dò đường dẫn output)

import { NextResponse, type NextRequest } from 'next/server';
import { sttAppend, sttCancel, sttPoll, sttRun, sttStart, sttStatus, tts } from '@/lib/speechServer';
import { providerRemove, providerSave, providerTest, providersList } from '@/lib/speechProviderServer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? '');
  try {
    switch (action) {
      case 'stt.status':
        return NextResponse.json({ ok: true, result: sttStatus() });
      case 'stt.start':
        return NextResponse.json({ ok: true, result: sttStart(body ?? {}) });
      case 'stt.append':
        return NextResponse.json({ ok: true, result: sttAppend(body?.id, body?.data) });
      case 'stt.run':
        return NextResponse.json({ ok: true, result: sttRun(body?.id) });
      case 'stt.poll':
        return NextResponse.json({ ok: true, result: sttPoll(body?.id) });
      case 'stt.cancel':
        sttCancel(body?.id);
        return NextResponse.json({ ok: true });
      case 'tts':
        return NextResponse.json({ ok: true, result: await tts(body?.text, body?.lang, body?.provider) });
      case 'providers.list':
        return NextResponse.json({ ok: true, result: await providersList() });
      case 'providers.save':
        return NextResponse.json({ ok: true, result: await providerSave(body?.provider) });
      case 'providers.remove':
        return NextResponse.json({ ok: true, result: await providerRemove(body?.id) });
      case 'providers.test':
        return NextResponse.json({ ok: true, result: await providerTest(body ?? {}) });
      default:
        return NextResponse.json({ ok: false, error: `action không hỗ trợ: "${action}"` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
