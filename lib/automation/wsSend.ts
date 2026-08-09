'use client';

// The `wsSend` action's executor: turn "send to the group tagged X" into real
// messages typed into the logged-in Zalo.
//
// Runs in the RENDERER, unlike webhook/telegram/log — the only handle on a
// workspace guest is the <webview> element, and that lives in this process
// (see lib/workspace/guests.ts).
//
//   action → /api/ws-targets (who) → guest.exec(sendScript) per target (how)
//
// Targets are sent to ONE AT A TIME with a pause between them. A loop that
// fires N messages as fast as the DOM allows is precisely the pattern that gets
// a personal account restricted, and the pause also gives Zalo time to switch
// conversations before the next one starts.

import { getPlugin } from '@/lib/workspace/plugins';
import { requireGuest } from '@/lib/workspace/guests';
import { buildSendScript, buildFocusScript, type SendResult } from '@/lib/workspace/send';
import type { TargetGroup } from '@/lib/workspace/targets';
import type { WorkspaceSendAction } from './types';

export interface WsSendOutcome {
  status: 'ok' | 'error' | 'dry-run';
  detail: string;
  /** How many messages actually went out (0 on a dry run). */
  sent: number;
  /**
   * Per-target step log. The activity feed only shows `detail`, but the action
   * editor's "gửi thử" renders these: which of open → focus → type → send →
   * verify failed is the whole difference between a fixable report and
   * "không gửi được".
   */
  results: { target: string; result: SendResult | null; error: string }[];
}

/** Pause between two recipients of the same rule. */
const BETWEEN_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One send at a time per account — the single most important guarantee here.
 *
 * Every send drives the SAME live UI: it opens a conversation, types into the
 * one composer, presses send. Two of them running at once interleave, and the
 * result is exactly what a real run produced — messages silently missing, and
 * one reply carrying the text of an earlier event because the other script had
 * already moved the app somewhere else.
 *
 * Rules fire independently and messages arrive in bursts, so concurrency here
 * is the normal case, not an edge case.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Ceiling for one queued send. A guest that navigates or crashes mid-script can
 * leave `executeJavaScript` pending FOREVER, and a queue is only as good as its
 * ability to move on: without this, one hung send silences the account for the
 * rest of the session — the same "works once, then never again" symptom the
 * queue was added to fix.
 */
const JOB_TIMEOUT_MS = 90_000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: quá ${JOB_TIMEOUT_MS / 1000}s không phản hồi`)), JOB_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

function enqueue<T>(accountKey: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(accountKey) ?? Promise.resolve();
  // Run after whatever is in flight, whether it succeeded or not — a failed
  // send must not block the account forever.
  const run = () => withTimeout(job(), 'lượt gửi');
  const next = prev.then(run, run);
  queues.set(
    accountKey,
    next.catch(() => undefined),
  );
  return next;
}

/** Append one send attempt to the focused debug file (configs/ws-send-debug.log). */
async function logTrace(trace: unknown): Promise<void> {
  try {
    await fetch('/api/ws-sendlog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(trace),
    });
  } catch {
    /* logging must never break a send */
  }
}

async function loadGroup(id: string): Promise<TargetGroup | null> {
  try {
    const r = await fetch('/api/ws-targets');
    const d = (await r.json()) as { groups?: TargetGroup[] };
    return d.groups?.find((g) => g.id === id) ?? null;
  } catch {
    return null;
  }
}

export function sendToTargetGroup(
  action: WorkspaceSendAction,
  dryRun: boolean,
  /** Called with each conversation name just BEFORE its message is sent, so the
   *  caller can record the echo before it can bounce back. */
  onSending?: (conversation: string) => void,
): Promise<WsSendOutcome> {
  return enqueue(action.accountKey, () => runSend(action, dryRun, onSending));
}

async function runSend(
  action: WorkspaceSendAction,
  dryRun: boolean,
  onSending?: (conversation: string) => void,
): Promise<WsSendOutcome> {
  const group = await loadGroup(action.targetGroupId);
  if (!group) {
    return { status: 'error', detail: 'danh sách đích không còn trong danh bạ — đồng bộ lại', sent: 0, results: [] };
  }
  if (!group.targets.length) {
    return { status: 'error', detail: `danh sách “${group.label}” chưa có hội thoại nào`, sent: 0, results: [] };
  }

  const { guest, error } = requireGuest(action.accountKey);
  if (!guest || error) return { status: 'error', detail: error ?? 'không tìm thấy tài khoản', sent: 0, results: [] };

  const plugin = getPlugin(action.accountKey.split('::')[0]);
  if (!plugin?.send) {
    return { status: 'error', detail: `${plugin?.name ?? 'workspace'} chưa khai báo cách gửi`, sent: 0, results: [] };
  }

  const ok: string[] = [];
  const failed: string[] = [];
  const results: WsSendOutcome['results'] = [];
  for (const t of group.targets) {
    const script = buildSendScript(plugin.directory ?? {}, plugin.send, {
      name: t.name,
      text: action.text,
      dryRun,
      phase: 'type',
    });
    let res: SendResult | null = null;
    // One trace object per target, written to the debug file at the end — the
    // whole send in one readable block instead of scattered console lines.
    const trace: Record<string, unknown> = { target: t.name, dryRun, textLen: action.text.length };
    // Record the echo BEFORE the message can go out. A dry run sends nothing,
    // so it must not poison the loop guard with a record.
    if (!dryRun) onSending?.(t.name);
    try {
      // Phase 'type': open, focus, type. userGesture is required — a background
      // page refuses document.execCommand without it.
      res = (await guest.exec(script, true)) as SendResult | null;
      trace.type = res
        ? { ok: res.ok, awaitingKey: res.awaitingKey, error: res.error, steps: res.steps, controls: res.controls, editables: res.editables }
        : null;

      // Phase 'finish': only when the type phase typed the text and is waiting
      // for a TRUSTED Enter that a synthetic event cannot provide.
      if (!dryRun && res?.awaitingKey) {
        // Re-assert composer focus so the trusted Enter lands in it as the
        // active element — the round trip out to type + back can lose focus.
        try {
          trace.focusActiveEl = await guest.exec(buildFocusScript(plugin.send), true);
        } catch (e) {
          trace.focusActiveEl = `err: ${(e as Error).message}`;
        }
        trace.pressKey = await guest.pressKey('Return'); // trusted Enter
        await sleep(1200);
        const finish = buildSendScript(plugin.directory ?? {}, plugin.send, {
          name: t.name,
          text: action.text,
          phase: 'finish',
        });
        const fin = (await guest.exec(finish, false)) as SendResult | null;
        trace.finish = fin ? { ok: fin.ok, sent: fin.sent, error: fin.error, lastMessage: fin.lastMessage, steps: fin.steps } : null;
        if (fin) {
          res = {
            ...res,
            ...fin,
            steps: [...(res.steps ?? []), ...(fin.steps ?? [])],
            editables: res.editables,
            controls: res.controls,
            composerHtml: res.composerHtml,
          };
        }
      }
      void logTrace(trace);
    } catch (e) {
      trace.exception = (e as Error).message;
      void logTrace(trace);
      failed.push(`${t.name}: ${(e as Error).message}`);
      results.push({ target: t.name, result: null, error: (e as Error).message });
      continue;
    }
    results.push({ target: t.name, result: res, error: res?.ok ? '' : (res?.error ?? '') });
    if (res?.ok) ok.push(t.name);
    else {
      // The failing STEP is what makes this fixable — "không gửi được" alone
      // never told anyone which half of the path broke.
      const lastStep = res?.steps?.filter((s) => !s.ok).slice(-1)[0];
      const why = res?.error || lastStep?.detail || 'không rõ lỗi';
      const at = lastStep ? `[${lastStep.step}] ` : '';
      // When the composer could not be found, carry the page's editable
      // elements INTO the activity line. That one line is then enough to pin
      // the right selector — without it the reader has to go and re-run a
      // separate test to learn the same thing.
      const seen = (res?.editables ?? [])
        .slice(0, 4)
        .map((e) => `${e.tag}${e.contentEditable ? '[ce]' : ''} ${e.w}×${e.h} @${e.x},${e.y} ${e.path}`)
        .join(' | ');
      // When the composer was found but sending failed, the buttons next to it
      // are what pins the send selector — carry them into the line too.
      const ctrls = (res?.controls ?? [])
        .slice(0, 6)
        .map((c) => `${c.dataId || c.title || c.text || c.tag}${c.hasSvg ? '(svg)' : ''} ${c.path}`)
        .join(' | ');
      const extra = seen ? ` · ô nhập liệu: ${seen}` : ctrls ? ` · nút cạnh ô soạn: ${ctrls}` : '';
      failed.push(`${t.name}: ${at}${why}${extra}`);
    }
    if (group.targets.length > 1) await sleep(BETWEEN_MS);
  }

  const summary = `${ok.length}/${group.targets.length} tới “${group.label}”`;
  const detail = failed.length ? `${summary} · lỗi: ${failed.join(' | ')}` : summary;
  if (dryRun) {
    return { status: 'dry-run', detail: `chạy thử ${detail} (đã gõ rồi xoá, không gửi)`, sent: 0, results };
  }
  return { status: failed.length ? 'error' : 'ok', detail, sent: ok.length, results };
}
