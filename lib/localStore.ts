// Server-only persistence for the tester's connection config.
//
// Reads/writes a single JSON file on the local machine so that base URLs, tokens
// and the shared global variables survive a restart and are re-mapped
// automatically on next launch. Because it holds API keys/tokens in plaintext,
// the file is gitignored — this is an internal, locally-run tool.
//
// File location: <cwd>/.apitester-config.json, overridable via
// APITESTER_CONFIG_PATH (absolute or cwd-relative).
//
// The store is a flat map: service id → { field: value }, plus one reserved
// entry (GLOBAL_KEY = "__global__") holding the shared global variables. The
// split into { services, global } happens in the route.

import { promises as fs } from 'fs';
import path from 'path';
import type { ConfigPatch } from './persist';

/** Raw on-disk shape: every entry is a flat string map (service config or globals). */
export type RawStore = Record<string, Record<string, string>>;

const CONFIG_FILE = process.env.APITESTER_CONFIG_PATH
  ? path.resolve(process.cwd(), process.env.APITESTER_CONFIG_PATH)
  : path.join(process.cwd(), '.apitester-config.json');

/** Read the whole store. Returns {} when the file is missing or unparseable. */
export async function readStore(): Promise<RawStore> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as RawStore) : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the `key` entry (a service id or GLOBAL_KEY) and write the
 * file back. A `null` (or empty-string) patch value deletes that field, so
 * clearing a field in the UI removes it from disk. Returns the full updated store.
 */
export async function writeEntry(key: string, patch: ConfigPatch): Promise<RawStore> {
  const all = await readStore();
  const merged: Record<string, string> = { ...(all[key] ?? {}) };

  for (const [field, value] of Object.entries(patch)) {
    if (value === null || value === '') {
      delete merged[field];
    } else {
      merged[field] = value;
    }
  }

  if (Object.keys(merged).length === 0) {
    delete all[key];
  } else {
    all[key] = merged;
  }

  await fs.writeFile(CONFIG_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8');
  return all;
}
