// DevBox Automation — defensive normalization.
//
// The config round-trips through a JSON file the user may hand-edit and through
// a browser form. Anything the engine reads goes through here first, so a
// half-written rule degrades (missing bits get defaults) instead of throwing
// inside the event pipeline. Isomorphic — no Node imports, never throws.

import {
  DEFAULT_AUTOMATION_CONFIG,
  type ActionType,
  type AutomationAction,
  type AutomationCondition,
  type AutomationConfig,
  type AutomationRule,
  type ConditionOp,
  type EventCategory,
  type HttpMethod,
  type InfraStack,
  type InfraWatch,
  type TriggerType,
} from './types';

const OPS: ConditionOp[] = [
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'startsWith',
  'endsWith',
  'regex',
  'anyOf',
  'noneOf',
  'empty',
  'notEmpty',
  'gt',
  'gte',
  'lt',
  'lte',
];
const ACTION_TYPES: ActionType[] = ['notify', 'webhook', 'telegram', 'wsSend', 'log', 'kafka', 'reply'];
const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const CATEGORIES: EventCategory[] = ['social', 'infra', 'system'];
const TRIGGERS: TriggerType[] = ['message.received', 'infra.metric', 'infra.recovered', 'system.test'];
const STACKS: InfraStack[] = ['mongo', 'redis', 'es', 'kafka', 'rabbit', 'pg'];
const WATCH_OPS: InfraWatch['op'][] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];

/** Default trigger for a group, used when the stored one doesn't belong to it. */
const DEFAULT_TRIGGER: Record<EventCategory, TriggerType> = {
  social: 'message.received',
  infra: 'infra.metric',
  system: 'system.test',
};
const TRIGGER_CATEGORY: Record<TriggerType, EventCategory> = {
  'message.received': 'social',
  'infra.metric': 'infra',
  'infra.recovered': 'infra',
  'system.test': 'system',
};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const posInt = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};
const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
/** A hand-editable string→string map (query params, headers). Drops junk keys. */
const strMap = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k, val]) => k.trim() && typeof val === 'string')
          .map(([k, val]) => [k.trim(), val as string]),
      )
    : {};
/** Field names are open (they resolve against event.fields) but must be tame. */
const fieldName = (v: unknown, fallback = 'text'): string => {
  const s = str(v).trim();
  return /^[A-Za-z0-9_.]{1,40}$/.test(s) ? s : fallback;
};

function normCondition(raw: unknown): AutomationCondition | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const op = OPS.includes(c.op as ConditionOp) ? (c.op as ConditionOp) : 'contains';
  return { field: fieldName(c.field), op, value: str(c.value), caseSensitive: bool(c.caseSensitive) };
}

function normAction(raw: unknown): AutomationAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const type = a.type as ActionType;
  if (!ACTION_TYPES.includes(type)) return null;

  switch (type) {
    case 'notify':
      return {
        type,
        level: (['info', 'warn', 'urgent'] as const).includes(a.level as 'info')
          ? (a.level as 'info' | 'warn' | 'urgent')
          : 'info',
        title: str(a.title),
        body: str(a.body),
        sound: bool(a.sound),
      };
    case 'webhook': {
      const auth = (a.auth ?? {}) as Record<string, unknown>;
      const kind = (['none', 'bearer', 'basic', 'header'] as const).includes(auth.kind as 'none')
        ? (auth.kind as 'none' | 'bearer' | 'basic' | 'header')
        : 'none';
      return {
        type,
        url: str(a.url),
        method: HTTP_METHODS.includes(a.method as HttpMethod) ? (a.method as HttpMethod) : 'POST',
        query: strMap(a.query),
        headers: strMap(a.headers),
        // 'none' carries no secret, so it is stored flat rather than as a null.
        auth: { kind, token: str(auth.token), user: str(auth.user), header: str(auth.header) },
        bodyType: (['json', 'text', 'form'] as const).includes(a.bodyType as 'json')
          ? (a.bodyType as 'json' | 'text' | 'form')
          : 'json',
        bodyTemplate: str(a.bodyTemplate),
        // A hand-edited 600s timeout would pin the dispatch open while the poll
        // loop waits behind it — one minute is already generous.
        timeoutSec: Math.min(60, Math.max(1, posInt(a.timeoutSec) ?? 10)),
        captureResponse: bool(a.captureResponse),
      };
    }
    case 'telegram':
      return {
        type,
        tokenSource: a.tokenSource === 'inline' ? 'inline' : 'env',
        botToken: str(a.botToken),
        chatId: str(a.chatId),
        text: str(a.text),
        parseMode: (['none', 'Markdown', 'MarkdownV2', 'HTML'] as const).includes(a.parseMode as 'none')
          ? (a.parseMode as 'none' | 'Markdown' | 'MarkdownV2' | 'HTML')
          : 'none',
        silent: bool(a.silent),
        // Defaults TRUE: an alert whose link unfurls into a preview card buries
        // the next alert.
        noPreview: bool(a.noPreview, true),
        threadId: str(a.threadId),
      };
    case 'log':
      return { type, file: str(a.file) };
    case 'kafka':
      return {
        type,
        connectionId: str(a.connectionId),
        topic: str(a.topic),
        key: str(a.key),
        valueTemplate: str(a.valueTemplate),
      };
    case 'wsSend':
      return {
        type,
        accountKey: str(a.accountKey),
        targetGroupId: str(a.targetGroupId),
        targetLabel: str(a.targetLabel),
        text: str(a.text),
      };
    case 'reply':
      // requireApproval defaults TRUE — an omitted flag must never mean
      // "send silently".
      return { type, text: str(a.text), requireApproval: bool(a.requireApproval, true) };
    default:
      return null;
  }
}

function normRule(raw: unknown, index: number): AutomationRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id) || `rule-${index + 1}`;
  const match = (r.match ?? {}) as Record<string, unknown>;
  const scope = (r.scope ?? {}) as Record<string, unknown>;
  const win = r.window as Record<string, unknown> | undefined;
  const lim = (r.limits ?? {}) as Record<string, unknown>;

  // Trigger is authoritative: it decides the group. A stored category that
  // disagrees with the trigger is a hand-edit slip, not a new feature group.
  const trigger = TRIGGERS.includes(r.trigger as TriggerType) ? (r.trigger as TriggerType) : undefined;
  const storedCat = CATEGORIES.includes(r.category as EventCategory)
    ? (r.category as EventCategory)
    : undefined;
  const category = trigger ? TRIGGER_CATEGORY[trigger] : storedCat ?? 'social';

  const rule: AutomationRule = {
    id,
    name: str(r.name) || `Quy tắc ${index + 1}`,
    enabled: bool(r.enabled, true),
    dryRun: bool(r.dryRun),
    category,
    trigger: trigger ?? DEFAULT_TRIGGER[category],
    scope: {
      sourceIds: strArr(scope.sourceIds),
      instanceIds: strArr(scope.instanceIds),
      conversations: strArr(scope.conversations)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    },
    match: {
      mode: match.mode === 'any' ? 'any' : 'all',
      conditions: (Array.isArray(match.conditions) ? match.conditions : [])
        .map(normCondition)
        .filter((c): c is AutomationCondition => !!c),
    },
    actions: (Array.isArray(r.actions) ? r.actions : [])
      .map(normAction)
      .filter((a): a is AutomationAction => !!a),
    stopOnMatch: bool(r.stopOnMatch),
    notes: str(r.notes),
  };

  if (win && typeof win === 'object') {
    const days = Array.isArray(win.days)
      ? win.days.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
      : [];
    rule.window = { days, from: str(win.from), to: str(win.to) };
  }

  const limits = {
    dedupeSec: posInt(lim.dedupeSec),
    cooldownSec: posInt(lim.cooldownSec),
    maxPerHour: posInt(lim.maxPerHour),
  };
  if (limits.dedupeSec || limits.cooldownSec || limits.maxPerHour) rule.limits = limits;

  return rule;
}

/** Never poll faster than this — the probes hit real infrastructure. */
export const MIN_WATCH_INTERVAL_SEC = 15;

function normWatch(raw: unknown, index: number): InfraWatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const stack = STACKS.includes(w.stack as InfraStack) ? (w.stack as InfraStack) : 'redis';
  return {
    id: str(w.id) || `watch-${index + 1}`,
    name: str(w.name) || `Theo dõi ${index + 1}`,
    enabled: bool(w.enabled),
    stack,
    connectionId: str(w.connectionId),
    connectionLabel: str(w.connectionLabel),
    metric: fieldName(w.metric, 'up'),
    op: WATCH_OPS.includes(w.op as InfraWatch['op']) ? (w.op as InfraWatch['op']) : 'gt',
    threshold: num(w.threshold),
    everySec: Math.max(MIN_WATCH_INTERVAL_SEC, posInt(w.everySec) ?? 60),
    forSec: Math.max(0, Math.floor(num(w.forSec))),
    cooldownSec: Math.max(0, Math.floor(num(w.cooldownSec, 600))),
    notifyRecovery: bool(w.notifyRecovery, true),
  };
}

/** Ids key the engine's firing history / watch state — they must be unique. */
function dedupeIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  for (const it of items) {
    while (seen.has(it.id)) it.id = `${it.id}-${seen.size}`;
    seen.add(it.id);
  }
  return items;
}

/** Merge anything into a valid AutomationConfig. Never throws. */
export function normalizeConfig(raw: unknown): AutomationConfig {
  const d = DEFAULT_AUTOMATION_CONFIG;
  if (!raw || typeof raw !== 'object') return { ...d, rules: [], watches: [] };
  const c = raw as Record<string, unknown>;

  const rules = dedupeIds(
    (Array.isArray(c.rules) ? c.rules : []).map(normRule).filter((r): r is AutomationRule => !!r),
  );
  const watches = dedupeIds(
    (Array.isArray(c.watches) ? c.watches : []).map(normWatch).filter((w): w is InfraWatch => !!w),
  );

  return {
    version: 1,
    enabled: bool(c.enabled, d.enabled),
    captureEnabled: bool(c.captureEnabled, d.captureEnabled),
    storeMessageText: bool(c.storeMessageText, d.storeMessageText),
    allowSend: bool(c.allowSend, d.allowSend),
    watchEnabled: bool(c.watchEnabled, d.watchEnabled),
    // Defaults TRUE: an omitted flag in a hand-edited file must not silently
    // remove the only thing standing between two linked accounts and a
    // ping-pong loop.
    loopGuard: bool(c.loopGuard, d.loopGuard),
    // Unknown/missing → no group gets OS pop-ups. Opting IN must be explicit.
    osNotify: strArr(c.osNotify).filter((g): g is EventCategory =>
      CATEGORIES.includes(g as EventCategory),
    ),
    activityLimit: Math.min(2000, posInt(c.activityLimit) ?? d.activityLimit),
    rules,
    watches,
  };
}
