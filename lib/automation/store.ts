// DevBox Automation — server-only persistence.
//
// The automation config lives in ONE JSON file next to the tester's own config
// (see lib/localStore.ts). It is gitignored: it can hold webhook URLs, tokens in
// headers and message text, and this is a locally-run internal tool.
//
//   <cwd>/.automation.json        the config  (override: AUTOMATION_CONFIG_PATH)
//   <cwd>/.automation-log.jsonl   default target of the `log` action
//
// Everything read from disk goes through normalizeConfig(), so a hand-edited
// file with a typo degrades to defaults instead of breaking the pipeline.

import { promises as fs } from 'fs';
import path from 'path';
import { normalizeConfig } from './normalize';
import { DEFAULT_AUTOMATION_CONFIG, type AutomationConfig } from './types';
import { configPath } from '../configDir';

const CONFIG_FILE = process.env.AUTOMATION_CONFIG_PATH
  ? path.resolve(process.cwd(), process.env.AUTOMATION_CONFIG_PATH)
  : configPath('automation.json', ['.automation.json']);

export const DEFAULT_LOG_FILE = '.automation-log.jsonl';

/** Read the config. A missing or broken file yields the safe defaults. */
export async function readAutomationConfig(): Promise<AutomationConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AUTOMATION_CONFIG, rules: [], watches: [] };
  }
}

/** Normalize, persist, and return exactly what was written. */
export async function writeAutomationConfig(raw: unknown): Promise<AutomationConfig> {
  const config = normalizeConfig(raw);
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

/**
 * Resolve a `log` action's target file. Rules come from a browser form, so the
 * path is confined to the working directory: name only, no traversal, .jsonl.
 * Anything suspicious silently falls back to the default file.
 */
export function resolveLogFile(file?: string): string {
  const name = (file ?? '').trim();
  const safe =
    name &&
    !path.isAbsolute(name) &&
    !name.includes('..') &&
    !/[\\/]/.test(name) &&
    /^[\w.-]+\.jsonl$/.test(name)
      ? name
      : DEFAULT_LOG_FILE;
  return path.join(process.cwd(), safe);
}

/** Append one JSON line. Never throws — logging must not break a rule chain. */
export async function appendLogLine(file: string | undefined, entry: unknown): Promise<string> {
  const target = resolveLogFile(file);
  await fs.appendFile(target, JSON.stringify(entry) + '\n', 'utf8');
  return path.basename(target);
}

// ── Retention for the local log ─────────────────────────────────────────────

/** Rewrite the file without lines older than `days`. Returns how many went. */
async function pruneLocalLog(target: string, days: number): Promise<number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch {
    return 0; // nothing written yet
  }
  const lines = raw.split('\n').filter(Boolean);
  const keep = lines.filter((line) => {
    // A line we cannot parse or date is KEPT: retention exists to bound growth,
    // not to quietly discard records whose shape we failed to recognise.
    try {
      const at = (JSON.parse(line) as { at?: string }).at;
      if (!at) return true;
      const ts = Date.parse(at);
      return !Number.isFinite(ts) || ts >= cutoff;
    } catch {
      return true;
    }
  });
  const dropped = lines.length - keep.length;
  if (dropped > 0) await fs.writeFile(target, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
  return dropped;
}

/**
 * Prune at most once an hour per file. Reading and rewriting the whole log on
 * every append would make an alert storm quadratic in the number of lines.
 */
const lastPrune = new Map<string, number>();
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export async function appendLocalLog(
  file: string | undefined,
  retentionDays: number,
  entry: unknown,
): Promise<string> {
  const target = resolveLogFile(file);
  await fs.appendFile(target, JSON.stringify(entry) + '\n', 'utf8');
  const now = Date.now();
  if (now - (lastPrune.get(target) ?? 0) >= PRUNE_EVERY_MS) {
    lastPrune.set(target, now);
    // Never let housekeeping fail the write that already succeeded.
    try {
      await pruneLocalLog(target, retentionDays);
    } catch {
      /* bỏ qua — dòng log đã ghi xong, dọn dẹp để lần sau */
    }
  }
  return path.basename(target);
}

/** Force a prune now (the UI's "dọn ngay"). Returns lines removed. */
export async function pruneLocalLogNow(file: string | undefined, retentionDays: number): Promise<number> {
  const target = resolveLogFile(file);
  lastPrune.set(target, Date.now());
  return pruneLocalLog(target, retentionDays);
}

/** Size + line count of the local log, for the settings panel. */
export async function localLogStats(
  file: string | undefined,
): Promise<{ name: string; bytes: number; lines: number; oldest?: string }> {
  const target = resolveLogFile(file);
  const name = path.basename(target);
  try {
    const [stat, raw] = await Promise.all([fs.stat(target), fs.readFile(target, 'utf8')]);
    const lines = raw.split('\n').filter(Boolean);
    let oldest: string | undefined;
    for (const line of lines) {
      try {
        const at = (JSON.parse(line) as { at?: string }).at;
        if (at) {
          oldest = at;
          break;
        }
      } catch {
        /* dòng lỗi — bỏ qua khi tìm mốc cũ nhất */
      }
    }
    return { name, bytes: stat.size, lines: lines.length, oldest };
  } catch {
    return { name, bytes: 0, lines: 0 };
  }
}
