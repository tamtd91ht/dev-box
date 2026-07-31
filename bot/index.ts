// Telegram MR-review bot — entry point.
//
// Long-polls Telegram for /review commands and runs the read-only
// /review-mr-dev engine locally, replying in the same chat. Runs as a
// standalone Node process (NOT part of the Next.js server), on the developer's
// local machine. It opens no listening port — it only makes outbound HTTPS
// long-poll calls to Telegram — so it needs no inbound network exposure.
//
//   npm run bot            (see package.json "bot" script)
//
// State (Telegram offset + per-commit dedup) is a local JSON file (bot/.state.json),
// not Redis: the bot runs on ONE machine at a time (company OR home), so there is
// nothing to lock across machines. When the machine is off, Telegram queues
// updates (up to ~24h); they are drained on next start via the persisted offset.

import { config as loadEnv } from 'dotenv';
// Load .env.local first (Next.js convention, gitignored, holds real secrets),
// then .env as a fallback. dotenv never overrides an already-set process.env,
// so .env.local wins and real shell env wins over both.
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { loadConfig, type BotConfig } from './config';
import { BotStore } from './store';
import { TelegramClient } from './telegram';
import { handleMessage, type Deps } from './handler';
import { StatusWriter } from './status';

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  const cfg: BotConfig = await loadConfig();
  const store = new BotStore();
  const tg = new TelegramClient(cfg.botToken);
  const status = new StatusWriter(cfg.instanceId);

  await store.connect();
  const me = await tg.getMe();
  log(`bot @${me.username} up · instance=${cfg.instanceId} · base=${cfg.basePath} · chats=${cfg.allowedChatIds.join(',')}`);
  log(`workspace lấy từ: ${cfg.basePathSource}`);
  if (cfg.ownerChatId) log(`owner DM bật (chat=${cfg.ownerChatId}) — báo START/DONE mỗi review`);
  else log('owner DM tắt (đặt BOT_OWNER_CHAT_ID để nhận báo riêng khi review start/done)');

  const deps: Deps = { cfg, store, tg, log, status };

  let running = true;
  const stop = async (signal: string) => {
    if (!running) return;
    running = false;
    log(`${signal} received — shutting down…`);
    await status.set('stopped').catch(() => {});
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  let idleAnnounced = false;
  while (running) {
    // 1. Long-poll for updates newer than the persisted offset.
    let updates;
    try {
      if (!idleAnnounced) {
        await status.set('idle');
        log('💤 idle — đang chờ lệnh (polling)');
        idleAnnounced = true;
      }
      const offset = await store.getOffset();
      updates = await tg.getUpdates(offset, cfg.pollTimeoutSec);
    } catch (e) {
      log(`getUpdates error: ${(e as Error).message}`);
      await sleep(3000);
      continue;
    }

    // 2. Process sequentially (one review at a time — reviews are heavy), then
    //    advance the offset PAST each update so it is never reprocessed.
    if (updates.length > 0) idleAnnounced = false; // handleMessage will set state
    for (const u of updates) {
      const msg = u.message;
      if (msg) {
        try {
          await handleMessage(msg, deps);
        } catch (e) {
          log(`handleMessage crashed: ${(e as Error).message}`);
        }
      }
      await store.setOffset(u.update_id + 1);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
