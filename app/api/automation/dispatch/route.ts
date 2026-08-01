// /api/automation/dispatch
//   POST { event, plans } → execute the SERVER-SIDE actions of an evaluation.
//
// Only `webhook` and `log` land here:
//   webhook — running it server-side dodges CORS entirely and keeps auth headers
//             out of the browser's network log.
//   log     — the renderer cannot touch the filesystem.
// `notify` and `reply` are renderer concerns; `kafka` goes through the existing
// /api/kafka producer with the user's saved connection. Anything else is
// reported as skipped rather than silently dropped.
//
// Dry-run plans never execute — they are reported so the activity feed can show
// exactly what would have happened.

import { NextResponse, type NextRequest } from 'next/server';
import { appendLogLine } from '@/lib/automation/store';
import type { ActionOutcome, ActionPlan, AutomationEvent } from '@/lib/automation/types';

export const runtime = 'nodejs';

/** A webhook must not hold the dispatch open — the poll loop is waiting. */
const WEBHOOK_TIMEOUT_MS = 10_000;

async function runWebhook(plan: ActionPlan, event: AutomationEvent): Promise<ActionOutcome> {
  const base = { ruleId: plan.ruleId, ruleName: plan.ruleName, type: 'webhook' as const };
  const action = plan.action;
  if (action.type !== 'webhook') return { ...base, status: 'skipped', detail: 'not a webhook' };
  if (!/^https?:\/\//i.test(action.url)) {
    return { ...base, status: 'error', detail: 'URL phải bắt đầu bằng http:// hoặc https://' };
  }

  const body = action.bodyTemplate || JSON.stringify(event);
  const headers: Record<string, string> = { ...(action.headers ?? {}) };
  if (action.method !== 'GET' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    // Templated bodies are JSON far more often than not; only guess when the
    // user did not say.
    headers['content-type'] = body.trimStart().startsWith('{') ? 'application/json' : 'text/plain';
  }

  try {
    const res = await fetch(action.url, {
      method: action.method,
      headers,
      body: action.method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return {
      ...base,
      status: res.ok ? 'ok' : 'error',
      detail: `HTTP ${res.status}${res.ok ? '' : ' ' + (await res.text().catch(() => '')).slice(0, 200)}`,
    };
  } catch (e) {
    return { ...base, status: 'error', detail: (e as Error).message };
  }
}

async function runLog(plan: ActionPlan, event: AutomationEvent): Promise<ActionOutcome> {
  const base = { ruleId: plan.ruleId, ruleName: plan.ruleName, type: 'log' as const };
  const action = plan.action;
  if (action.type !== 'log') return { ...base, status: 'skipped', detail: 'not a log action' };
  try {
    const name = await appendLogLine(action.file, {
      at: new Date().toISOString(),
      rule: plan.ruleName,
      ruleId: plan.ruleId,
      event,
    });
    return { ...base, status: 'ok', detail: name };
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
          return runWebhook(plan, event);
        case 'log':
          return runLog(plan, event);
        default:
          return { ...base, status: 'skipped', detail: 'không chạy phía server' } as ActionOutcome;
      }
    }),
  );

  return NextResponse.json({ outcomes });
}
