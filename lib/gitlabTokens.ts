// Server-only persistence for GitLab API tokens, keyed by host.
//
// WHY THIS EXISTS — the MR features (list open MRs, merge by iid) talk to the
// GitLab REST API, which authenticates with a Personal/Project Access Token via
// the PRIVATE-TOKEN header. That is NOT the same secret as the one `git push`
// uses: a self-hosted instance may well accept an account password for HTTPS git
// operations, but the REST API rejects a password outright. So reading whatever
// `git credential fill` has stored (the previous approach) yields a value that
// works for push and 401s for the API — and, because `fill` only READS, it also
// popped a credential dialog whose answer was never saved, once per call.
//
// Tokens live in a single JSON file under ./configs (gitignored via `configs/`,
// see configDir.ts). One token per host, because a PAT is issued by the GitLab
// instance and is valid for every project on it.
//
// SECURITY MODEL — mirrors gitProjects.ts: a LOCAL single-user tool gated by
// GIT_TOOL_ENABLED (the /api/git route 403s otherwise). The token is a secret at
// rest on the developer's own machine, so:
//   1. It is written with 0600 where the platform honours it, and never logged.
//   2. It is NEVER returned to the client. The API surfaces only a redacted
//      preview + whether a token exists (see publicView), so the UI can show
//      "configured / not configured" without shipping the secret to the browser.

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';

/** File holding the host→token map. Overridable via GITLAB_TOKENS_PATH. */
const TOKENS_FILE = process.env.GITLAB_TOKENS_PATH
  ? path.resolve(process.cwd(), process.env.GITLAB_TOKENS_PATH)
  : configPath('gitlabtokens.json');

interface TokenEntry {
  /** The PAT itself. Never leaves the server. */
  token: string;
  /** When it was saved — shown in the UI so a stale token is recognisable. */
  savedAt: string;
}

type TokenMap = Record<string, TokenEntry>;

/** What the client is allowed to know about a stored token. */
export interface TokenStatus {
  host: string;
  /** Last 4 chars only, e.g. "…a1b2" — enough to tell two tokens apart. */
  preview: string;
  savedAt: string;
}

/** Normalize a host for use as a key: lowercase, no port-less trailing dot. */
function normalizeHost(host: unknown): string {
  const h = typeof host === 'string' ? host.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!h) throw new Error('host is required');
  // Reject anything that isn't a bare hostname[:port] — the key ends up in a
  // JSON object, and a URL or path here would silently never match a lookup.
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(h)) throw new Error(`invalid host: ${host}`);
  return h;
}

/** Read the persisted map. Returns {} on missing/unparseable file. */
async function readRaw(): Promise<TokenMap> {
  let raw: string;
  try {
    raw = await fs.readFile(TOKENS_FILE, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const src = (parsed as { tokens?: unknown })?.tokens ?? parsed;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return {};
  const out: TokenMap = {};
  for (const [host, v] of Object.entries(src as Record<string, unknown>)) {
    // Tolerate both the current shape and a bare string token.
    if (typeof v === 'string' && v) {
      out[host.toLowerCase()] = { token: v, savedAt: '' };
    } else if (v && typeof v === 'object' && typeof (v as TokenEntry).token === 'string' && (v as TokenEntry).token) {
      const e = v as TokenEntry;
      out[host.toLowerCase()] = { token: e.token, savedAt: typeof e.savedAt === 'string' ? e.savedAt : '' };
    }
  }
  return out;
}

async function writeRaw(map: TokenMap): Promise<void> {
  const body = JSON.stringify({ tokens: map }, null, 2) + '\n';
  // mode 0600: owner-only. No-op on Windows ACLs, correct on POSIX.
  await fs.writeFile(TOKENS_FILE, body, { encoding: 'utf8', mode: 0o600 });
}

/** Redact a token down to what is safe to show: its last 4 characters. */
function preview(token: string): string {
  return token.length <= 4 ? '…' : `…${token.slice(-4)}`;
}

/**
 * The stored token for `host`, or null when none is configured. Server-only —
 * callers must never forward the result to the client.
 */
export async function getToken(host: string): Promise<string | null> {
  const key = normalizeHost(host);
  const map = await readRaw();
  return map[key]?.token ?? null;
}

/**
 * Save (or replace) the token for `host`. `savedAt` is stamped by the caller so
 * this module stays free of ambient clock reads.
 */
export async function setToken(host: unknown, token: unknown, savedAt: string): Promise<TokenStatus> {
  const key = normalizeHost(host);
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t) throw new Error('token is required');
  // A PAT pasted with surrounding quotes or a "PRIVATE-TOKEN: " prefix is a
  // common copy/paste slip that would 401 with a confusing message.
  if (/\s/.test(t)) throw new Error('token must not contain whitespace');
  const map = await readRaw();
  map[key] = { token: t, savedAt };
  await writeRaw(map);
  return { host: key, preview: preview(t), savedAt };
}

/** Forget the token for `host`. Returns true when one was actually removed. */
export async function deleteToken(host: unknown): Promise<boolean> {
  const key = normalizeHost(host);
  const map = await readRaw();
  if (!(key in map)) return false;
  delete map[key];
  await writeRaw(map);
  return true;
}

/** Redacted status for every configured host — safe to send to the client. */
export async function listTokens(): Promise<TokenStatus[]> {
  const map = await readRaw();
  return Object.entries(map)
    .map(([host, e]) => ({ host, preview: preview(e.token), savedAt: e.savedAt }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

/** Redacted status for ONE host, or null when not configured. */
export async function tokenStatus(host: string): Promise<TokenStatus | null> {
  const key = normalizeHost(host);
  const map = await readRaw();
  const e = map[key];
  return e ? { host: key, preview: preview(e.token), savedAt: e.savedAt } : null;
}
