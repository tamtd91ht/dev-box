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

const CONFIG_FILE = process.env.AUTOMATION_CONFIG_PATH
  ? path.resolve(process.cwd(), process.env.AUTOMATION_CONFIG_PATH)
  : path.join(process.cwd(), '.automation.json');

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
