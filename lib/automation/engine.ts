// DevBox Automation — the rule pipeline.
//
// evaluate() takes ONE normalized event plus the whole config and returns what
// should happen. It performs no I/O and mutates only the small `EngineState` it
// is handed (firing history for cooldown / rate limits), which makes the whole
// decision path testable and replayable from the UI's Test console.
//
//   config off?             → no decisions
//   rule off                → decision { skipped: 'rule-disabled' }
//   wrong group / trigger   → decision { skipped: 'trigger' }
//   out of scope / window   → decision { skipped: 'scope' | 'window' }
//   conditions              → matched?
//   dedupe / cooldown /     → decision { skipped } even though it matched
//   rate limit
//   → actions rendered with the event's template variables → ActionPlan[]
//
// Group-agnostic on purpose: a Zalo message and "Redis memory > 80%" travel the
// exact same path, so there is one place where firing behaviour is defined.

import { type Captures, inWindow, render, templateVars, testConditions } from './match';
import type {
  ActionPlan,
  AutomationAction,
  AutomationConfig,
  AutomationEvent,
  AutomationRule,
  EvaluationResult,
  RuleDecision,
} from './types';

/** Mutable firing history. One instance lives for the app session. */
export interface EngineState {
  /** event.id → first seen (drops duplicate deliveries of the same capture). */
  seen: Map<string, number>;
  /** ruleId → last fire time. */
  lastFire: Map<string, number>;
  /** ruleId → fire timestamps inside the rolling hour. */
  fires: Map<string, number[]>;
  /** `ruleId|title|text` → last fire time (per-rule content dedupe). */
  content: Map<string, number>;
}

export function createEngineState(): EngineState {
  return { seen: new Map(), lastFire: new Map(), fires: new Map(), content: new Map() };
}

/** How long an event id is remembered for delivery-dedupe. */
const SEEN_TTL_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Keep the state maps from growing without bound over a long session. */
function prune(state: EngineState, now: number): void {
  for (const [k, ts] of state.seen) if (now - ts > SEEN_TTL_MS) state.seen.delete(k);
  for (const [k, ts] of state.content) if (now - ts > HOUR_MS) state.content.delete(k);
  for (const [k, list] of state.fires) {
    const kept = list.filter((t) => now - t < HOUR_MS);
    if (kept.length) state.fires.set(k, kept);
    else state.fires.delete(k);
  }
}

/**
 * True when this exact event was already processed. Sources assign stable ids,
 * but a poll can hand the same batch twice after a reload.
 */
export function isDuplicateEvent(state: EngineState, event: AutomationEvent, now = Date.now()): boolean {
  prune(state, now);
  if (state.seen.has(event.id)) return true;
  state.seen.set(event.id, now);
  return false;
}

/** Does the rule listen for this kind of event at all? */
function listensTo(rule: AutomationRule, event: AutomationEvent): boolean {
  if (rule.category !== event.category) return false;
  return rule.trigger === event.type;
}

/** Does the rule apply to the event's source + instance? Empty list = all. */
function inScope(rule: AutomationRule, event: AutomationEvent): boolean {
  const { sourceIds, instanceIds } = rule.scope ?? { sourceIds: [], instanceIds: [] };
  if (sourceIds?.length && !sourceIds.includes(event.sourceId)) return false;
  if (instanceIds?.length && !instanceIds.includes(event.instanceId)) return false;
  return true;
}

/** Content-dedupe key: same rule, same headline + body. */
const contentKey = (rule: AutomationRule, event: AutomationEvent) =>
  `${rule.id}|${event.title}|${event.text}`;

/** Render every templated string of an action against the event's variables. */
export function renderAction(action: AutomationAction, vars: Record<string, string>): AutomationAction {
  switch (action.type) {
    case 'notify':
      return {
        ...action,
        title: render(action.title, vars) || vars.title || vars.instance,
        body: render(action.body, vars) || vars.text,
      };
    case 'webhook':
      return {
        ...action,
        url: render(action.url, vars),
        bodyTemplate: action.bodyTemplate ? render(action.bodyTemplate, vars) : vars.json,
        headers: Object.fromEntries(
          Object.entries(action.headers ?? {}).map(([k, v]) => [k, render(v, vars)]),
        ),
      };
    case 'kafka':
      return {
        ...action,
        topic: render(action.topic, vars) || action.topic,
        key: render(action.key, vars) || vars.instanceId,
        valueTemplate: action.valueTemplate ? render(action.valueTemplate, vars) : vars.json,
      };
    case 'reply':
      return { ...action, text: render(action.text, vars) };
    case 'log':
    default:
      return action;
  }
}

/**
 * Run the whole rule set against one event.
 *
 * Limits are consumed by dry-run rules too, so flipping dryRun off does not
 * change how often the rule fires — what you observe in dry-run is what you get.
 */
export function evaluate(
  config: AutomationConfig,
  event: AutomationEvent,
  state: EngineState,
  now = Date.now(),
): EvaluationResult {
  const decisions: RuleDecision[] = [];
  const plans: ActionPlan[] = [];

  if (!config.enabled) {
    return {
      event,
      decisions: config.rules.map((r) => ({
        ruleId: r.id,
        ruleName: r.name,
        matched: false,
        skipped: 'config-disabled' as const,
      })),
      plans,
    };
  }

  const at = new Date(now);

  for (const rule of config.rules) {
    const base = { ruleId: rule.id, ruleName: rule.name };

    if (!rule.enabled) {
      decisions.push({ ...base, matched: false, skipped: 'rule-disabled' });
      continue;
    }
    if (!listensTo(rule, event)) {
      decisions.push({ ...base, matched: false, skipped: 'trigger' });
      continue;
    }
    if (!inScope(rule, event)) {
      decisions.push({ ...base, matched: false, skipped: 'scope' });
      continue;
    }
    if (!inWindow(rule.window, at)) {
      decisions.push({ ...base, matched: false, skipped: 'window' });
      continue;
    }

    const captures: Captures = [];
    if (!testConditions(event, rule.match?.mode ?? 'all', rule.match?.conditions ?? [], captures)) {
      decisions.push({ ...base, matched: false, skipped: 'no-match' });
      continue;
    }

    // Matched — now the guards that stop a match from firing.
    const limits = rule.limits ?? {};

    if (limits.dedupeSec && limits.dedupeSec > 0) {
      const prev = state.content.get(contentKey(rule, event));
      if (prev && now - prev < limits.dedupeSec * 1000) {
        decisions.push({ ...base, matched: true, skipped: 'dedupe' });
        continue;
      }
    }
    if (limits.cooldownSec && limits.cooldownSec > 0) {
      const prev = state.lastFire.get(rule.id);
      if (prev && now - prev < limits.cooldownSec * 1000) {
        decisions.push({ ...base, matched: true, skipped: 'cooldown' });
        continue;
      }
    }
    if (limits.maxPerHour && limits.maxPerHour > 0) {
      const list = (state.fires.get(rule.id) ?? []).filter((t) => now - t < HOUR_MS);
      if (list.length >= limits.maxPerHour) {
        state.fires.set(rule.id, list);
        decisions.push({ ...base, matched: true, skipped: 'rate-limit' });
        continue;
      }
    }

    // Fires. Record history BEFORE planning so a throwing action can't unbound it.
    state.lastFire.set(rule.id, now);
    state.fires.set(rule.id, [...(state.fires.get(rule.id) ?? []), now]);
    if (limits.dedupeSec) state.content.set(contentKey(rule, event), now);

    const vars = templateVars(event, captures);
    for (const action of rule.actions ?? []) {
      plans.push({
        ruleId: rule.id,
        ruleName: rule.name,
        dryRun: !!rule.dryRun,
        action: renderAction(action, vars),
      });
    }
    decisions.push({ ...base, matched: true });

    if (rule.stopOnMatch) break;
  }

  return { event, decisions, plans };
}

// ── Construction helpers (used by the UI) ──────────────────────────────────

export function newId(prefix = 'r'): string {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  } catch {
    return `${prefix}${Math.floor(Math.random() * 1e12).toString(36)}`;
  }
}

/** Backwards-compatible alias. */
export const newRuleId = () => newId('r');

/** Default first condition per group — the field people actually filter on. */
const FIRST_CONDITION: Record<string, AutomationRule['match']['conditions'][number]> = {
  social: { field: 'text', op: 'contains', value: '' },
  infra: { field: 'metric', op: 'equals', value: '' },
  system: { field: 'text', op: 'contains', value: '' },
};

/**
 * A blank rule for a feature group. Starts enabled but in dry-run: it records
 * what it *would* do until the user is happy with the match.
 */
export function blankRule(category: AutomationRule['category'] = 'social', name?: string): AutomationRule {
  const trigger: AutomationRule['trigger'] =
    category === 'infra' ? 'infra.metric' : category === 'system' ? 'system.test' : 'message.received';
  return {
    id: newId('r'),
    name: name ?? 'Quy tắc mới',
    enabled: true,
    dryRun: true, // new rules start as observe-only
    category,
    trigger,
    scope: { sourceIds: [], instanceIds: [] },
    match: { mode: 'all', conditions: [{ ...FIRST_CONDITION[category] }] },
    actions: [{ type: 'notify', level: category === 'infra' ? 'warn' : 'info' }],
    limits: { dedupeSec: 30 },
  };
}

/** A blank infrastructure watch — 60s poll, 60s debounce, 10min cooldown. */
export function blankWatch(stack: import('./types').InfraStack = 'redis'): import('./types').InfraWatch {
  return {
    id: newId('w'),
    name: 'Theo dõi mới',
    enabled: false,
    stack,
    connectionId: '',
    metric: 'up',
    op: 'lt',
    threshold: 1,
    everySec: 60,
    forSec: 60,
    cooldownSec: 600,
    notifyRecovery: true,
  };
}
