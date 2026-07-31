// Bot configuration — secrets from env, WORKSPACE from the per-machine registry.
//
// This is a LOCAL-ONLY long-running process (not part of the Next.js app). It
// long-polls a Telegram bot for /review commands, runs the read-only
// `/review-mr-dev` Claude Code command against a project workspace, and replies
// in the same Telegram chat. It never opens a listening port.
//
// Config discipline mirrors the rest of the repo (config-no-url-fallback):
// required secrets have NO default and abort boot when absent; everything else
// has a safe default.
//
// WHICH WORKSPACE DOES IT REVIEW?
// DevBox is project-neutral, so the bot does not hardcode a path. It reuses the
// SAME per-machine registries the UI already writes — the way integration packs
// work — in this order:
//
//   1. BOT_BASE_PATH (legacy alias: OMICX_BASE_PATH) — an explicit path wins.
//   2. BOT_PROJECT=<id|name> matched against both per-machine registries:
//        .apiintegrations.json  ← ＋ Projects (integration packs)
//        .gitprojects.json      ← Git tab's project list
//   3. No BOT_PROJECT → exactly ONE integration pack wins (a pack IS a project
//      deliberately plugged into DevBox); else exactly ONE git project wins.
//      Several candidates → boot fails asking for BOT_PROJECT, never guesses.
//   4. Nothing registered → parent folder of this repo (sibling-workspace default).
//
// So for OMICX: register D:/works/vihat/sources/omicx once (Git tab or ＋
// Projects) and `npm run bot` picks it up.

import path from 'path';
import { listProjects } from '../lib/gitProjects';
import { listIntegrations } from '../lib/apiIntegrations';

export interface BotConfig {
  /** Telegram bot token from @BotFather. REQUIRED. */
  botToken: string;
  /**
   * Whitelisted chat id(s) — the bot only acts on messages from these chats.
   * REQUIRED (comma-separated for more than one). A group chat id is negative.
   */
  allowedChatIds: number[];
  /** Workspace root that holds the reviewable repos. */
  basePath: string;
  /** Where basePath came from — logged at boot so a wrong workspace is obvious. */
  basePathSource: string;
  /** getUpdates long-poll timeout, seconds. */
  pollTimeoutSec: number;
  /** A stable id for THIS machine (company / home) — shown in logs + status. */
  instanceId: string;
  /**
   * Optional private chat id of the operator (you). When set, the bot DMs you at
   * exactly two moments per branch — review START and review DONE — so you know
   * work is happening even when you're away from the terminal. Unset = disabled.
   */
  ownerChatId?: number;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `Missing required env ${name}. Set it in .env.local (see .env.example) before starting the bot.`,
    );
  }
  return v;
}

function parseChatIds(raw: string): number[] {
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  if (ids.some((n) => !Number.isInteger(n))) {
    throw new Error('TELEGRAM_ALLOWED_CHAT_ID must be a comma-separated list of integer chat ids');
  }
  if (ids.length === 0) {
    throw new Error('TELEGRAM_ALLOWED_CHAT_ID must contain at least one chat id');
  }
  return ids;
}

interface NamedRoot {
  id: string;
  name: string;
  root: string;
  /** Registry the entry came from, for the boot log. */
  origin: string;
}

/** Integration packs registered on this machine (＋ Projects tab). */
async function packRoots(): Promise<NamedRoot[]> {
  try {
    const packs = await listIntegrations();
    return packs.map((p) => ({ id: p.id, name: p.name, root: p.root, origin: '.apiintegrations.json' }));
  } catch {
    return []; // registry unreadable → treat as none
  }
}

/** Git projects registered on this machine (Git tab). */
async function gitRoots(): Promise<NamedRoot[]> {
  try {
    const { projects, configured } = await listProjects();
    // An unconfigured list is only the GIT_TOOL_ROOT fallback — not a real choice.
    if (!configured) return [];
    return projects.map((p) => ({ id: p.id, name: p.name, root: p.root, origin: '.gitprojects.json' }));
  } catch {
    return [];
  }
}

/** Resolve the workspace root + a human explanation of where it came from. */
async function resolveBasePath(): Promise<{ basePath: string; basePathSource: string }> {
  const explicit = (process.env.BOT_BASE_PATH || process.env.OMICX_BASE_PATH || '').trim();
  if (explicit) {
    return {
      basePath: path.resolve(explicit),
      basePathSource: process.env.BOT_BASE_PATH?.trim() ? 'env BOT_BASE_PATH' : 'env OMICX_BASE_PATH',
    };
  }

  const packs = await packRoots();
  const gits = await gitRoots();
  const pick = (r: NamedRoot) => ({
    basePath: path.resolve(r.root),
    basePathSource: `project "${r.name}" (${r.origin})`,
  });

  const wanted = process.env.BOT_PROJECT?.trim().toLowerCase();
  if (wanted) {
    const hit = [...packs, ...gits].find(
      (r) => r.id.toLowerCase() === wanted || r.name.toLowerCase() === wanted,
    );
    if (!hit) {
      // Same folder registered in both registries → list it once.
      const all = [...new Map([...packs, ...gits].map((r) => [r.id + '|' + path.resolve(r.root).toLowerCase(), r])).values()];
      const known = all.length
        ? all.map((r) => `${r.name} (id=${r.id})`).join(', ')
        : 'chưa đăng ký project nào — mở DevBox, tab Git hoặc ＋ Projects, thêm folder workspace';
      throw new Error(`BOT_PROJECT="${process.env.BOT_PROJECT}" không khớp project nào. Đang có: ${known}`);
    }
    return pick(hit);
  }

  // A single integration pack is the clearest signal: that project deliberately
  // plugged itself into DevBox. Then fall back to a single git project.
  if (packs.length === 1) return pick(packs[0]);
  if (packs.length === 0 && gits.length === 1) return pick(gits[0]);

  const candidates = packs.length > 1 ? packs : gits;
  if (candidates.length > 1) {
    throw new Error(
      `Có ${candidates.length} project đã đăng ký (${candidates.map((r) => r.name).join(', ')}) — ` +
        'chọn một bằng BOT_PROJECT=<tên hoặc id>, hoặc đặt BOT_BASE_PATH.',
    );
  }

  // Nothing registered → the old default: the folder holding this repo.
  return { basePath: path.resolve(process.cwd(), '..'), basePathSource: 'mặc định (thư mục cha của repo)' };
}

export async function loadConfig(): Promise<BotConfig> {
  const botToken = required('TELEGRAM_BOT_TOKEN');
  const allowedChatIds = parseChatIds(required('TELEGRAM_ALLOWED_CHAT_ID'));

  const { basePath, basePathSource } = await resolveBasePath();

  const pollTimeoutSec = clampInt(process.env.BOT_POLL_TIMEOUT_SEC, 30, 1, 60);
  const instanceId =
    process.env.BOT_INSTANCE_ID?.trim() || process.env.COMPUTERNAME || process.env.HOSTNAME || 'local';

  const ownerRaw = process.env.BOT_OWNER_CHAT_ID?.trim();
  let ownerChatId: number | undefined;
  if (ownerRaw) {
    const n = Number(ownerRaw);
    if (!Number.isInteger(n)) throw new Error('BOT_OWNER_CHAT_ID must be an integer chat id');
    ownerChatId = n;
  }

  return { botToken, allowedChatIds, basePath, basePathSource, pollTimeoutSec, instanceId, ownerChatId };
}

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
