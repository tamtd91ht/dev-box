// DevBox Automation — Telegram Bot API, server side only.
//
// This machine usually ALREADY has a bot configured: the MR-review process in
// `bot/` boots from TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_CHAT_ID in .env.local
// (see bot/README.md). The `telegram` action reuses that by default, so the
// token is read here, at send time, and is never copied into `.automation.json`
// nor handed to the renderer — one bot, one place to rotate it.
//
// Deliberately NOT reusing bot/telegram.ts: that client belongs to the separate
// long-poll process (it throws on failure, it knows about documents and long
// polling). An automation action wants the opposite — never throw, report the
// failure as an outcome the activity feed can show.

/** Never let a token reach a UI string, an outcome detail or a log line. */
export const maskToken = (token: string): string => {
  const t = (token ?? '').trim();
  if (!t) return '';
  const [id] = t.split(':');
  return `${id}:${'•'.repeat(6)}`;
};

/** A chat id this machine already trusts, and which variable declared it. */
export interface EnvChat {
  id: string;
  /** 'allowed' = TELEGRAM_ALLOWED_CHAT_ID (the group) · 'owner' = BOT_OWNER_CHAT_ID (the DM). */
  from: 'allowed' | 'owner';
}

export interface EnvTelegram {
  /** Empty when this machine has no bot configured. */
  token: string;
  chats: EnvChat[];
  /** Just the ids, in the same order — the default target is chatIds[0]. */
  chatIds: string[];
}

/** What .env.local offers. Never throws — an unset bot is a normal state here,
 *  unlike in bot/config.ts where it is a fatal boot error. */
export function envTelegram(): EnvTelegram {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const owner = (process.env.BOT_OWNER_CHAT_ID ?? '').trim();
  const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // The owner DM is often ALSO the allowed group id — list each id once, and
  // attribute it to the group, which is what a rule normally wants.
  const chats: EnvChat[] = [
    ...allowed.map((id): EnvChat => ({ id, from: 'allowed' })),
    ...(owner && !allowed.includes(owner) ? [{ id: owner, from: 'owner' as const }] : []),
  ];
  return { token, chats, chatIds: chats.map((c) => c.id) };
}

export interface TelegramResult {
  ok: boolean;
  result?: unknown;
  /** Human-readable, token already scrubbed. */
  error: string;
}

const TIMEOUT_MS = 15_000;

/**
 * Call one Bot API method. Returns the failure instead of throwing, and scrubs
 * the token out of every message — a network error can otherwise echo the whole
 * request URL, token included, straight into the activity feed.
 */
export async function telegramApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<TelegramResult> {
  const scrub = (s: string) => (token ? s.split(token).join(maskToken(token)) : s);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
      error_code?: number;
    };
    if (!res.ok || !data.ok) {
      const why = data.description ?? `HTTP ${res.status}`;
      return { ok: false, error: scrub(`Telegram từ chối (${data.error_code ?? res.status}): ${why}`) };
    }
    return { ok: true, result: data.result, error: '' };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      error: scrub(err.name === 'TimeoutError' ? 'Telegram không phản hồi sau 15s' : err.message),
    };
  }
}
