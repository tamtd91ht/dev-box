// Server-only persistence for SEND TARGETS — the address book that lives in
// DevBox instead of inside the chat app.
//
// WHY IT EXISTS (measured, not assumed): chat.zalo.me exposes no
// per-conversation id. Every row carries the same component marker, and only a
// group's collage avatar has `id`s — one per member, none of them the group.
// So a target can only be identified by its NAME, and a name is safe exactly
// when the set is small and a human curated it. Zalo's own "Phân loại" is that
// set: tag the groups there once, sync here, and the rule sends to a list you
// can read before you switch sending on.
//
//   configs/wstargets.json
//   { version: 1, groups: [ { id, accountKey, label, name, targets[], syncedAt } ] }
//
// One entry per (account × label). Re-syncing replaces that entry's targets, so
// removing a tag in Zalo removes the recipient here too — which is the point of
// keeping Zalo as the source of truth.

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from '../configDir';

/** One conversation that may receive a message. */
export interface SendTarget {
  /** Display name, exactly as the chat app shows it — this IS the identifier. */
  name: string;
  kind: 'group' | 'user';
}

/** All targets carrying one label, for one account. */
export interface TargetGroup {
  /** Stable opaque id. */
  id: string;
  /** `${pluginId}::${instanceId}` — which logged-in account can reach these. */
  accountKey: string;
  /** Account label at sync time, so the UI can name it without loading the rail. */
  accountLabel: string;
  /** The app's own label ("Công việc"). */
  label: string;
  targets: SendTarget[];
  /** Epoch ms of the last sync. */
  syncedAt: number;
}

export interface TargetStore {
  version: 1;
  groups: TargetGroup[];
}

const FILE = process.env.WS_TARGETS_PATH
  ? path.resolve(process.cwd(), process.env.WS_TARGETS_PATH)
  : configPath('wstargets.json', ['.wstargets.json']);

const EMPTY: TargetStore = { version: 1, groups: [] };

const str = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

function normTarget(raw: unknown): SendTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const name = str(t.name);
  if (!name) return null;
  return { name, kind: t.kind === 'group' ? 'group' : 'user' };
}

/**
 * Id DERIVED from (account × label), not from a counter.
 *
 * Two properties matter and an index has neither: it must be unique (an
 * index-based id gave every entry `tg-1`, so a rule resolved to whichever came
 * first), and it must survive a re-sync — a rule points at this id, and
 * re-syncing a label must not orphan the rule.
 */
function groupId(accountKey: string, label: string): string {
  const raw = `${accountKey}::${label}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${slug || 'tag'}-${h.toString(36)}`;
}

function normGroup(raw: unknown, i: number): TargetGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  const accountKey = str(g.accountKey, 80);
  const label = str(g.label, 80);
  if (!accountKey || !label) return null;
  const targets = (Array.isArray(g.targets) ? g.targets : [])
    .map(normTarget)
    .filter((t): t is SendTarget => !!t);
  // Two entries with the same name would send the same message twice.
  const seen = new Set<string>();
  const unique = targets.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  const at = Number(g.syncedAt);
  return {
    id: str(g.id, 60) || groupId(accountKey, label),
    accountKey,
    accountLabel: str(g.accountLabel, 80),
    label,
    targets: unique,
    syncedAt: Number.isFinite(at) && at > 0 ? at : Date.now(),
  };
}

export function normalizeTargets(raw: unknown): TargetStore {
  if (!raw || typeof raw !== 'object') return { ...EMPTY, groups: [] };
  const c = raw as Record<string, unknown>;
  const groups = (Array.isArray(c.groups) ? c.groups : [])
    .map(normGroup)
    .filter((g): g is TargetGroup => !!g);
  // A hand-edited file can still carry duplicates; an id must resolve to ONE
  // recipient list or a rule silently messages the wrong people.
  const seen = new Set<string>();
  for (const g of groups) {
    while (seen.has(g.id)) g.id = groupId(g.accountKey, `${g.label}-${seen.size}`);
    seen.add(g.id);
  }
  return { version: 1, groups };
}

export async function readTargets(): Promise<TargetStore> {
  try {
    return normalizeTargets(JSON.parse(await fs.readFile(FILE, 'utf8')));
  } catch {
    return { ...EMPTY, groups: [] };
  }
}

async function write(store: TargetStore): Promise<TargetStore> {
  const clean = normalizeTargets(store);
  await fs.writeFile(FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return clean;
}

/**
 * Add or replace the entry for one (account × label). Replacing rather than
 * merging is deliberate: a conversation you untagged in Zalo must STOP being a
 * recipient here, and a merge would keep sending to it forever.
 */
export async function upsertGroup(raw: unknown): Promise<TargetStore> {
  const incoming = normGroup(raw, 0);
  if (!incoming) throw new Error('cần accountKey + label + targets');
  const store = await readTargets();
  const rest = store.groups.filter(
    (g) => !(g.accountKey === incoming.accountKey && g.label === incoming.label),
  );
  // Always the derived id, so re-syncing the same label keeps the id a rule
  // already points at instead of minting a second entry.
  incoming.id = groupId(incoming.accountKey, incoming.label);
  incoming.syncedAt = Date.now();
  return write({ version: 1, groups: [...rest, incoming] });
}

export async function removeGroup(id: string): Promise<TargetStore> {
  const store = await readTargets();
  return write({ version: 1, groups: store.groups.filter((g) => g.id !== id) });
}

/** The recipients a rule's action resolves to. Empty when the entry is gone. */
export function targetsOf(store: TargetStore, id: string): SendTarget[] {
  return store.groups.find((g) => g.id === id)?.targets ?? [];
}
