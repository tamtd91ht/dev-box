// /api/automation/telegram — what the Telegram action editor needs.
//
//   GET            → does this machine already have a bot? which chat ids?
//                    (token NEVER leaves the server — only a masked hint)
//   POST { … }     → "Kiểm tra": getMe + getChat, so a wrong token or a chat the
//                    bot was never added to is caught while editing the rule,
//                    not at 3am when the alert should have fired.
//
// Both are read-only: nothing here sends a message. To see a real send, use the
// Test tab's "bắn thật".

import { NextResponse, type NextRequest } from 'next/server';
import { envTelegram, maskToken, telegramApi } from '@/lib/automation/telegram';

export const runtime = 'nodejs';

export async function GET() {
  const env = envTelegram();
  return NextResponse.json({
    configured: !!env.token,
    tokenHint: maskToken(env.token),
    chats: env.chats,
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { tokenSource?: 'env' | 'inline'; botToken?: string; chatId?: string }
    | null;

  const env = envTelegram();
  const inline = body?.tokenSource === 'inline';
  const token = (inline ? body?.botToken : env.token)?.trim() ?? '';
  if (!token) {
    return NextResponse.json({
      ok: false,
      error: inline ? 'chưa nhập bot token' : 'máy này chưa đặt TELEGRAM_BOT_TOKEN trong .env.local',
    });
  }

  const me = await telegramApi(token, 'getMe', {});
  if (!me.ok) return NextResponse.json({ ok: false, error: me.error });
  const bot = me.result as { username?: string; first_name?: string };
  const botLabel = bot.username ? `@${bot.username}` : (bot.first_name ?? 'bot');

  const chatId = (body?.chatId || (inline ? '' : env.chatIds[0]) || '').trim();
  if (!chatId) return NextResponse.json({ ok: true, bot: botLabel, chat: '', error: 'chưa có chat id' });

  const chat = await telegramApi(token, 'getChat', { chat_id: chatId });
  if (!chat.ok) return NextResponse.json({ ok: false, bot: botLabel, error: chat.error });
  const c = chat.result as { title?: string; username?: string; first_name?: string; type?: string };
  const name = c.title ?? (c.username ? `@${c.username}` : (c.first_name ?? chatId));

  return NextResponse.json({ ok: true, bot: botLabel, chat: `${name}${c.type ? ` (${c.type})` : ''}`, error: '' });
}
