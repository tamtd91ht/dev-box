// Handle one Telegram message end-to-end: authorize the chat, parse the command,
// resolve the branch(es), dedup by commit sha, run the review engine, and reply
// into the chat quoting the requester. Kept free of the poll loop so it can be
// driven directly in a test.

import type { BotConfig } from './config';
import type { BotStore } from './store';
import { BotStore as Store } from './store';
import type { TelegramClient, TgMessage } from './telegram';
import { escapeHtml, mention } from './telegram';
import { parseCommand, USAGE } from './command';
import * as bgit from './git';
import { runReview, type ReviewResult, type Verdict } from './reviewer';
import path from 'path';
import { promises as fs } from 'fs';
import type { StatusWriter } from './status';

const VERDICT_LABEL: Record<Verdict, string> = {
  APPROVE: '✅ APPROVE',
  FIX_REQUIRED: '⚠️ FIX REQUIRED',
  BLOCK: '❌ BLOCK',
  UNKNOWN: '❔ (không xác định verdict — xem file report)',
};

export interface Deps {
  cfg: BotConfig;
  store: BotStore;
  tg: TelegramClient;
  log: (msg: string) => void;
  status: StatusWriter;
}

/** DM the operator (C) — best-effort, only if an owner chat is configured. */
async function notifyOwner(deps: Deps, text: string): Promise<void> {
  const owner = deps.cfg.ownerChatId;
  if (!owner) return;
  await deps.tg.sendMessage(owner, text, { parseMode: 'HTML' }).catch((e) => {
    deps.log(`owner DM failed: ${(e as Error).message}`);
  });
}

/** Entry point for one incoming message. Never throws — errors are reported to chat. */
export async function handleMessage(msg: TgMessage, deps: Deps): Promise<void> {
  const { cfg, tg, log } = deps;

  // 1. Chat whitelist — ignore anything not from an allowed chat.
  if (!cfg.allowedChatIds.includes(msg.chat.id)) return;

  // (A) One line so the operator sees every command as it arrives.
  const rawText = (msg.text ?? '').replace(/\s+/g, ' ').trim();
  if (rawText.toLowerCase().startsWith('/review')) {
    log(`📥 lệnh từ ${stripTags(mention(msg.from))}: ${rawText.slice(0, 120)}`);
  }

  const text = msg.text ?? '';
  const parsed = await parseCommand(text, cfg.basePath).catch(
    (e): { kind: 'error'; message: string } => ({
      kind: 'error',
      message: `Lỗi phân tích lệnh: ${escapeHtml((e as Error).message)}`,
    }),
  );

  switch (parsed.kind) {
    case 'ignore':
      return;
    case 'help':
      await reply(tg, msg, USAGE);
      return;
    case 'error':
      await reply(tg, msg, parsed.message);
      return;
    case 'review':
      break;
  }

  const requester = mention(msg.from);

  try {
    await bgit.fetch(parsed.repoPath);

    // Resolve which branch(es) to review.
    let branches: string[];
    if (parsed.branch) {
      const exists = await bgit.remoteBranchExists(parsed.repoPath, parsed.branch);
      if (!exists) {
        await reply(tg, msg, `${requester} branch <code>${escapeHtml(parsed.branch)}</code> không tồn tại trên origin.`);
        return;
      }
      if ((await bgit.aheadCount(parsed.repoPath, parsed.branch)) === 0) {
        await reply(tg, msg, `${requester} branch <code>${escapeHtml(parsed.branch)}</code> không ahead <code>origin/dev</code> — không có gì để review.`);
        return;
      }
      branches = [parsed.branch];
    } else {
      branches = await bgit.featureBranchesAheadDev(parsed.repoPath);
      if (branches.length === 0) {
        await reply(tg, msg, `${requester} service <code>${escapeHtml(parsed.service)}</code> không có feature branch nào ahead <code>origin/dev</code>.`);
        return;
      }
    }

    const descLine = parsed.description ? `\n📝 ${escapeHtml(parsed.description)}` : '';
    await reply(
      tg,
      msg,
      `${requester} 🔍 Bắt đầu review <b>${escapeHtml(parsed.service)}</b> · ${branches.length} branch: ${branches.map((b) => `<code>${escapeHtml(b)}</code>`).join(', ')}${descLine}\nSẽ trả kết quả từng branch khi xong.`,
    );

    // Review each branch independently, reply per branch. `remaining` feeds the
    // status file's queue count so `bot:status` shows how many are still pending.
    for (let i = 0; i < branches.length; i++) {
      const remaining = branches.length - 1 - i;
      await reviewOneBranch(parsed.repoPath, parsed.service, branches[i], msg, requester, parsed.description, remaining, deps);
    }
    await deps.status.set('idle');
    log('💤 idle — đang chờ lệnh (polling)');
  } catch (e) {
    log(`review error: ${(e as Error).message}`);
    await deps.status.set('idle');
    await reply(tg, msg, `${requester} ❌ Lỗi khi review: ${escapeHtml((e as Error).message)}`);
  }
}

async function reviewOneBranch(
  repoPath: string,
  service: string,
  branch: string,
  msg: TgMessage,
  requester: string,
  description: string,
  remaining: number,
  deps: Deps,
): Promise<void> {
  const { cfg, store, tg, log, status } = deps;
  const repoName = path.basename(repoPath);

  const state = await bgit.branchState(repoPath, branch);
  const dedupKey = Store.dedupKey(repoName, branch, state.headSha);

  // Already reviewed this exact commit → return the cached result, no Claude run.
  const cached = await store.getReview(dedupKey);
  if (cached) {
    log(`♻️ ${service}/${branch} @ ${state.headSha.slice(0, 8)} — đã review, trả report cũ (không chạy engine)`);
    await reply(
      tg,
      msg,
      `${requester} ♻️ <b>${escapeHtml(service)}</b> / <code>${escapeHtml(branch)}</code> — đã review commit này (<code>${state.headSha.slice(0, 8)}</code>) trước đó. Report: <code>${escapeHtml(shortenPath(cfg.basePath, cached))}</code>\n<i>Push commit mới để review lại.</i>`,
    );
    return;
  }

  const startedAt = Date.now();
  const who = stripTags(requester);

  // (A) console  ·  (B) status file  ·  (C) owner DM — all at review START.
  log(`🔍 reviewing ${service}/${branch} @ ${state.headSha.slice(0, 8)} (ahead ${state.ahead}, author ${state.author}) — đang chạy…`);
  await status.startReview({ service, branch, requester: who, startedAt }, remaining);
  await notifyOwner(
    deps,
    `⏳ <b>Bắt đầu review</b>\n${escapeHtml(service)} / <code>${escapeHtml(branch)}</code>\nxin bởi: ${escapeHtml(who)}${description ? `\n📝 ${escapeHtml(description)}` : ''}`,
  );

  let result: ReviewResult;
  try {
    result = await runReview({ basePath: cfg.basePath, service, branch });
  } catch (e) {
    const em = (e as Error).message;
    log(`❌ engine error ${service}/${branch}: ${em}`);
    await notifyOwner(deps, `❌ <b>Lỗi engine</b>\n${escapeHtml(service)} / <code>${escapeHtml(branch)}</code>\n${escapeHtml(em)}`);
    await reply(tg, msg, `${requester} ❌ <b>${escapeHtml(service)}</b> / <code>${escapeHtml(branch)}</code> — lỗi engine: ${escapeHtml(em)}`);
    return;
  }

  // Stamp the human request note onto the report the engine wrote, so the file
  // itself records what the requester asked for (does not affect the review).
  if (description && result.reportPath) {
    await stampRequestNote(result.reportPath, requester, description).catch(() => {});
  }

  // Record the commit as reviewed so a repeat request is deduped.
  await store.saveReview(dedupKey, result.reportPath ?? '(no report file)');

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const scoreStr = result.score
    ? `CRIT=${result.score.crit} HIGH=${result.score.high} MED=${result.score.med} LOW=${result.score.low}`
    : '';

  // (A) console  ·  (B) status file  ·  (C) owner DM — all at review DONE.
  log(`✅ done ${service}/${branch} → ${result.verdict}${scoreStr ? ` (${scoreStr})` : ''} · ${durationSec}s`);
  await status.finishReview({ service, branch, verdict: result.verdict, score: scoreStr, durationSec, finishedAt: new Date().toISOString() });
  await notifyOwner(
    deps,
    `${verdictEmoji(result.verdict)} <b>Xong review</b>\n${escapeHtml(service)} / <code>${escapeHtml(branch)}</code> → <b>${result.verdict}</b>${scoreStr ? `\n${escapeHtml(scoreStr)}` : ''}\n⏱ ${durationSec}s`,
  );

  await reply(tg, msg, formatResult(service, branch, state.author, description, result, cfg.basePath));

  // Attach the full report file when the result is anything other than APPROVE —
  // i.e. there's something the requester actually needs to read (FIX_REQUIRED /
  // BLOCK / UNKNOWN). A clean APPROVE gets the summary text only. Best-effort:
  // a failed upload never breaks the review flow (the report path is in the text).
  if (result.verdict !== 'APPROVE' && result.reportPath) {
    await sendReportFile(tg, msg, service, branch, result.verdict, result.reportPath).catch((e) => {
      log(`report upload failed ${service}/${branch}: ${(e as Error).message}`);
    });
  }
}

/** Upload the report .md into the chat, quoting the requester's message. */
async function sendReportFile(
  tg: TelegramClient,
  msg: TgMessage,
  service: string,
  branch: string,
  verdict: Verdict,
  reportPath: string,
): Promise<void> {
  const bytes = await fs.readFile(reportPath);
  const filename = path.basename(reportPath);
  await tg.sendDocument(
    msg.chat.id,
    { filename, bytes, contentType: 'text/markdown' },
    {
      caption: `${verdictEmoji(verdict)} Report đầy đủ · <b>${escapeHtml(service)}</b> / <code>${escapeHtml(branch)}</code>`,
      replyToMessageId: msg.message_id,
      parseMode: 'HTML',
    },
  );
}

function verdictEmoji(v: Verdict): string {
  return v === 'APPROVE' ? '✅' : v === 'FIX_REQUIRED' ? '⚠️' : v === 'BLOCK' ? '❌' : '❔';
}

/** Prepend a "> Yêu cầu review: …" note under the report's H1 title. */
async function stampRequestNote(reportPath: string, requester: string, description: string): Promise<void> {
  const content = await fs.readFile(reportPath, 'utf8');
  const note = `\n> 🗒️ **Yêu cầu review** (${stripTags(requester)}): ${description}\n`;
  const nl = content.indexOf('\n');
  const updated = nl >= 0 ? content.slice(0, nl + 1) + note + content.slice(nl + 1) : content + note;
  await fs.writeFile(reportPath, updated, 'utf8');
}

/** requester may be an HTML mention link — keep it plain in the markdown file. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

function formatResult(
  service: string,
  branch: string,
  author: string,
  description: string,
  r: ReviewResult,
  basePath: string,
): string {
  const lines: string[] = [];
  lines.push(`<b>${VERDICT_LABEL[r.verdict]}</b> · <b>${escapeHtml(service)}</b> / <code>${escapeHtml(branch)}</code>`);
  if (description) lines.push(`📝 ${escapeHtml(description)}`);
  lines.push(`Author: ${escapeHtml(author)}`);
  if (r.score) {
    const { crit, high, med, low } = r.score;
    const risk = crit * 10 + high * 3 + med;
    lines.push(`Findings: <b>${crit}</b> CRITICAL · <b>${high}</b> HIGH · ${med} MED · ${low} LOW — risk ${risk}`);
  }
  if (r.reportPath) {
    lines.push(`Report: <code>${escapeHtml(shortenPath(basePath, r.reportPath))}</code>`);
  }
  return lines.join('\n');
}

/** Show a path relative to the workspace root when possible, for compactness. */
function shortenPath(basePath: string, full: string): string {
  const rel = path.relative(basePath, full);
  return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : full;
}

async function reply(tg: TelegramClient, msg: TgMessage, html: string): Promise<void> {
  await tg.sendMessage(msg.chat.id, html, { replyToMessageId: msg.message_id, parseMode: 'HTML' });
}
