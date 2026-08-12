// /api/automation/dispatch
//   POST { event, plans } → execute the SERVER-SIDE actions of an evaluation.
//
// Only `webhook` (an API call), `telegram` and `log` land here:
//   webhook  — running it server-side dodges CORS entirely and keeps auth
//              headers/tokens out of the browser's network log.
//   telegram — same reason, plus the bot token can come from this machine's
//              .env.local and then never travels to the renderer at all.
//   log      — the renderer cannot touch the filesystem.
// `notify` and `reply` are renderer concerns; `kafka` goes through the existing
// /api/kafka producer with the user's saved connection. Anything else is
// reported as skipped rather than silently dropped.
//
// Dry-run plans never execute — they are reported so the activity feed can show
// exactly what would have happened.

import { NextResponse, type NextRequest } from 'next/server';
import { readAutomationConfig } from '@/lib/automation/store';
import { buildLogEntry, writeLogEntry } from '@/lib/automation/logStore';
import { envTelegram, telegramApi } from '@/lib/automation/telegram';
import type { ActionOutcome, ActionPlan, AutomationEvent } from '@/lib/automation/types';

export const runtime = 'nodejs';

/** Fallback when the action carries no timeout: an API call must not hold the
 *  dispatch open — the poll loop is waiting behind it. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** How much of a response body we are willing to keep in the activity feed. */
const CAPTURE_LIMIT = 500;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Build the final URL: templated base + templated query params. */
function withQuery(url: string, query: Record<string, string> | undefined): string {
  const entries = Object.entries(query ?? {}).filter(([k]) => k.trim());
  if (!entries.length) return url;
  const u = new URL(url);
  for (const [k, v] of entries) u.searchParams.set(k, v);
  return u.toString();
}

const CONTENT_TYPE: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain; charset=utf-8',
  form: 'application/x-www-form-urlencoded',
};

async function runApi(plan: ActionPlan, event: AutomationEvent): Promise<ActionOutcome> {
  const base = { ruleId: plan.ruleId, ruleName: plan.ruleName, type: 'webhook' as const };
  const action = plan.action;
  if (action.type !== 'webhook') return { ...base, status: 'skipped', detail: 'not an API action' };
  if (!/^https?:\/\//i.test(action.url)) {
    return { ...base, status: 'error', detail: 'URL phải bắt đầu bằng http:// hoặc https://' };
  }

  const hasBody = action.method !== 'GET' && action.method !== 'DELETE';
  const body = action.bodyTemplate || JSON.stringify(event);
  const headers: Record<string, string> = { ...(action.headers ?? {}) };
  const has = (name: string) => Object.keys(headers).some((h) => h.toLowerCase() === name);

  if (hasBody && !has('content-type')) {
    // Only guess when the user did not say. bodyType is what they picked in the
    // editor; the {-sniff keeps rules written before bodyType existed working.
    headers['content-type'] =
      CONTENT_TYPE[action.bodyType ?? (body.trimStart().startsWith('{') ? 'json' : 'text')] ??
      CONTENT_TYPE.json;
  }

  // Auth lives outside `headers` so it can be masked in the editor — it is
  // folded in here, at the last possible moment.
  const auth = action.auth;
  if (auth && auth.kind !== 'none' && !has('authorization')) {
    if (auth.kind === 'bearer' && auth.token) headers.authorization = `Bearer ${auth.token}`;
    else if (auth.kind === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${auth.user ?? ''}:${auth.token ?? ''}`).toString('base64')}`;
    } else if (auth.kind === 'header' && auth.token) {
      headers[auth.header?.trim() || 'X-API-Key'] = auth.token;
    }
  }

  let url: string;
  try {
    url = withQuery(action.url, action.query);
  } catch {
    return { ...base, status: 'error', detail: 'URL không hợp lệ' };
  }

  // No timeout on the action (a rule saved before it existed) → the default,
  // NOT the 1s floor that clamping an absent value would produce.
  const timeout = action.timeoutSec
    ? Math.min(60, Math.max(1, action.timeoutSec)) * 1000
    : DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetch(url, {
      method: action.method,
      headers,
      body: hasBody ? body : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    // Read the body only when asked to, or when it explains a failure.
    const text =
      action.captureResponse || !res.ok ? await res.text().catch(() => '') : '';
    const detail = `HTTP ${res.status}${text ? ` · ${clip(text, action.captureResponse ? CAPTURE_LIMIT : 200)}` : ''}`;
    return { ...base, status: res.ok ? 'ok' : 'error', detail };
  } catch (e) {
    const msg = (e as Error).message;
    return {
      ...base,
      status: 'error',
      detail: (e as Error).name === 'TimeoutError' ? `quá ${timeout / 1000}s không phản hồi` : msg,
    };
  }
}

async function runTelegram(plan: ActionPlan, event: AutomationEvent): Promise<ActionOutcome> {
  const base = { ruleId: plan.ruleId, ruleName: plan.ruleName, type: 'telegram' as const };
  const action = plan.action;
  if (action.type !== 'telegram') return { ...base, status: 'skipped', detail: 'not a telegram action' };

  const env = envTelegram();
  const inline = action.tokenSource === 'inline';
  const token = inline ? (action.botToken ?? '').trim() : env.token;
  if (!token) {
    return {
      ...base,
      status: 'error',
      detail: inline ? 'chưa nhập bot token' : 'máy này chưa đặt TELEGRAM_BOT_TOKEN trong .env.local',
    };
  }

  const chatId = (action.chatId || (inline ? '' : env.chatIds[0]) || '').trim();
  if (!chatId) return { ...base, status: 'error', detail: 'chưa có chat id' };

  const text = action.text || event.title || event.text || '(rỗng)';
  // A thread id that isn't a number would serialize to null and make Telegram
  // reject the whole send — drop it instead.
  const thread = Number(action.threadId);
  const r = await telegramApi(token, 'sendMessage', {
    chat_id: chatId,
    // Telegram hard-rejects anything past 4096 characters — clip rather than
    // lose the whole alert to a 400.
    text: clip(text, 4000),
    ...(action.parseMode && action.parseMode !== 'none' ? { parse_mode: action.parseMode } : {}),
    ...(action.silent ? { disable_notification: true } : {}),
    ...(action.noPreview !== false ? { link_preview_options: { is_disabled: true } } : {}),
    ...(action.threadId && Number.isFinite(thread) ? { message_thread_id: thread } : {}),
  });

  if (!r.ok) return { ...base, status: 'error', detail: r.error };
  const id = (r.result as { message_id?: number } | undefined)?.message_id;
  return { ...base, status: 'ok', detail: `đã gửi tới ${chatId}${id ? ` (msg ${id})` : ''}` };
}

async function runLog(plan: ActionPlan, event: AutomationEvent): Promise<ActionOutcome> {
  const base = { ruleId: plan.ruleId, ruleName: plan.ruleName, type: 'log' as const };
  const action = plan.action;
  if (action.type !== 'log') return { ...base, status: 'skipped', detail: 'not a log action' };
  try {
    // The storage target is a CONFIG-level choice (local file vs Mongo), read
    // here rather than carried on the plan: the renderer would otherwise have to
    // know about connection ids, and a stale plan could write somewhere the user
    // has since switched away from.
    const cfg = (await readAutomationConfig()).logStore;
    if (!cfg.enabled) {
      return { ...base, status: 'skipped', detail: 'lưu trữ log đang tắt (bật ở tab Automation)' };
    }
    const entry = buildLogEntry(event, { ruleId: plan.ruleId, ruleName: plan.ruleName, dryRun: plan.dryRun });
    // Ghi ĐÚNG nơi đã cấu hình, không nhận override từ action: tab Log & báo
    // cáo chỉ đọc từ đây, nên mọi dòng ghi chỗ khác là dữ liệu mồ côi.
    const r = await writeLogEntry(cfg, entry);
    return { ...base, status: 'ok', detail: `${r.target}: ${r.where}` };
  } catch (e) {
    return { ...base, status: 'error', detail: (e as Error).message };
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { event?: AutomationEvent; plans?: ActionPlan[] }
    | null;

  const event = body?.event;
  const plans = Array.isArray(body?.plans) ? body!.plans : [];
  if (!event || typeof event !== 'object') {
    return NextResponse.json({ error: 'expected { event, plans }' }, { status: 400 });
  }

  const outcomes = await Promise.all(
    plans.map(async (plan): Promise<ActionOutcome> => {
      const base = { ruleId: plan.ruleId, ruleName: plan.ruleName, type: plan.action?.type ?? 'log' };
      if (plan.dryRun) return { ...base, status: 'dry-run' } as ActionOutcome;
      switch (plan.action?.type) {
        case 'webhook':
          return runApi(plan, event);
        case 'telegram':
          return runTelegram(plan, event);
        case 'log':
          return runLog(plan, event);
        default:
          return { ...base, status: 'skipped', detail: 'không chạy phía server' } as ActionOutcome;
      }
    }),
  );

  return NextResponse.json({ outcomes });
}
