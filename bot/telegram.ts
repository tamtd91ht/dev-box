// Minimal Telegram Bot API client over fetch — no external library.
//
// Only the two methods this bot needs: getUpdates (long-poll for new messages)
// and sendMessage (reply into the chat, quoting the original message). Node 18+
// provides a global fetch, so there is nothing to install.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string; // 'private' | 'group' | 'supergroup' | 'channel'
  title?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramClient {
  private readonly base: string;

  constructor(botToken: string) {
    this.base = `https://api.telegram.org/bot${botToken}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = (await res.json()) as TgResponse<T>;
      if (!data.ok) {
        throw new Error(`Telegram ${method} failed (${data.error_code}): ${data.description ?? 'unknown'}`);
      }
      return data.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Long-poll for updates newer than `offset`. The HTTP request itself blocks up
   * to `timeoutSec` on Telegram's side, so a locally short client timeout would
   * abort it prematurely — give the fetch a margin over the server timeout.
   */
  async getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message'],
      },
      (timeoutSec + 15) * 1000,
    );
  }

  /** Send a text message, optionally replying to (quoting) a specific message. */
  async sendMessage(
    chatId: number,
    text: string,
    opts: { replyToMessageId?: number; parseMode?: 'HTML' | 'MarkdownV2' } = {},
  ): Promise<TgMessage> {
    return this.call<TgMessage>(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        parse_mode: opts.parseMode ?? 'HTML',
        // Reply even if the quoted message was deleted, rather than erroring out.
        reply_parameters: opts.replyToMessageId
          ? { message_id: opts.replyToMessageId, allow_sending_without_reply: true }
          : undefined,
        disable_web_page_preview: true,
      },
      20_000,
    );
  }

  /**
   * Upload a file into the chat (as a document attachment), optionally quoting a
   * message. Uses multipart/form-data — the bytes go in the body, so this does
   * NOT use the JSON `call()` path. Node 18+ provides global FormData/Blob/fetch.
   */
  async sendDocument(
    chatId: number,
    file: { filename: string; bytes: Uint8Array; contentType?: string },
    opts: { caption?: string; replyToMessageId?: number; parseMode?: 'HTML' | 'MarkdownV2' } = {},
  ): Promise<TgMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (opts.caption) {
      form.append('caption', opts.caption);
      form.append('parse_mode', opts.parseMode ?? 'HTML');
    }
    if (opts.replyToMessageId) {
      form.append(
        'reply_parameters',
        JSON.stringify({ message_id: opts.replyToMessageId, allow_sending_without_reply: true }),
      );
    }
    const blob = new Blob([file.bytes], { type: file.contentType ?? 'application/octet-stream' });
    form.append('document', blob, file.filename);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${this.base}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const data = (await res.json()) as TgResponse<TgMessage>;
      if (!data.ok) {
        throw new Error(`Telegram sendDocument failed (${data.error_code}): ${data.description ?? 'unknown'}`);
      }
      return data.result as TgMessage;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Confirm the token is valid and return the bot's own identity. */
  async getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe', {}, 10_000);
  }
}

/** Escape text for Telegram HTML parse mode (only &, <, > are special). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render a chat member mention. Telegram links a user by numeric id even when
 * they have no @username, so we prefer @username but fall back to a tg://user
 * HTML link on the id.
 */
export function mention(user: TgUser | undefined): string {
  if (!user) return '';
  if (user.username) return `@${escapeHtml(user.username)}`;
  const name = escapeHtml(user.first_name || 'member');
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}
