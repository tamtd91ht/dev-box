// DevBox Automation — the configuration model.
//
// ONE engine, several FEATURE GROUPS. A source turns "something happened" into a
// normalized event; rules match events and run actions. Nothing here is bound to
// a specific app or a specific database:
//
//   GROUP           SOURCE                           EXAMPLE EVENT
//   ───────────────────────────────────────────────────────────────────────────
//   social      workspace plugins (Zalo, Telegram,   message.received
//               WhatsApp — see lib/workspace)
//   infra       watches over the DevBox connection   infra.metric / infra.recovered
//               registries (Mongo · Redis · ES ·
//               Kafka · Rabbit · Postgres)
//   system      the app itself (reserved: schedule   system.*
//               ticks, app lifecycle)
//
//   event → rule.scope → rule.window → rule.match → rule.limits → actions
//
// Files:
//   types.ts      this file — events, rules, actions, watches, config
//   match.ts      condition evaluation + {{template}} rendering (pure)
//   engine.ts     the pipeline above → an executable plan (pure + tiny state)
//   normalize.ts  defensive parsing of hand-edited / posted config
//   catalog.ts    what the UI offers per group: fields, ops, metrics
//   sources/*     the adapters that produce events
//   store.ts      on-disk persistence (server)
//   client.ts     renderer-side load/save + action execution

/** Feature group an event (and therefore a rule) belongs to. */
export type EventCategory = 'social' | 'infra' | 'system';

/** Dotted trigger type. Rules subscribe to exactly one. */
export type TriggerType =
  | 'message.received' // social — a message arrived in a workspace
  | 'infra.metric' // infra  — a watched metric breached its threshold
  | 'infra.recovered' // infra  — …and came back to normal
  | 'system.test'; // system — injected from the Test console

/**
 * One normalized event. Every source produces this shape, so a rule written for
 * Zalo and a rule written for "Redis memory > 80%" run through the same code.
 */
export interface AutomationEvent {
  /** Stable id — used to drop duplicate deliveries. */
  id: string;
  /** Epoch ms. */
  ts: number;
  category: EventCategory;
  type: TriggerType;
  /** What produced it: a plugin id ('zalo') or a stack id ('redis'). */
  sourceId: string;
  /** Which instance: an account instanceId or a connection id. */
  instanceId: string;
  /** Human label of that instance ("Zalo 1", "redis-prod-01"). */
  instanceLabel: string;
  /** One-line headline for the activity feed (sender name, or "heap 91%"). */
  title: string;
  /** Body: the message text, or the alert description. */
  text: string;
  /**
   * Everything else, addressable by conditions and templates. Social puts
   * sender/conversation here; infra puts metric/value/threshold/node/stack.
   */
  fields: Record<string, string | number>;
}

// ── Conditions ─────────────────────────────────────────────────────────────

/**
 * Field name a condition reads. Core fields (title, text, source, instance,
 * category, type) always exist; everything else resolves against event.fields,
 * so the same condition editor serves every group. See catalog.ts for what the
 * UI suggests per trigger.
 */
export type ConditionField = string;

export type ConditionOp =
  // text
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'anyOf' // value = comma/newline list; true if ANY entry is contained
  | 'noneOf'
  | 'empty'
  | 'notEmpty'
  // numeric (infra thresholds)
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface AutomationCondition {
  field: ConditionField;
  op: ConditionOp;
  /** Operand. Ignored by empty/notEmpty; a list for anyOf/noneOf; a number for gt/lt. */
  value?: string;
  /** Default false — text matching is case-insensitive unless asked otherwise. */
  caseSensitive?: boolean;
}

// ── Actions ────────────────────────────────────────────────────────────────

/** In-app + OS notification. Runs in the renderer. */
export interface NotifyAction {
  type: 'notify';
  level: 'info' | 'warn' | 'urgent';
  /** Templated. Empty → the event title. */
  title?: string;
  /** Templated. Empty → the event text. */
  body?: string;
  /** Chime even when workspaces are muted. */
  sound?: boolean;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How to authenticate an API call. Kept out of `headers` on purpose: the editor
 * can then mask the secret, and the dispatcher knows which value must never be
 * echoed back into an outcome detail.
 */
export interface ApiAuth {
  kind: 'none' | 'bearer' | 'basic' | 'header';
  /** bearer → the token · basic → the password · header → the value. Templated. */
  token?: string;
  /** basic → the username. */
  user?: string;
  /** header → the header name. Empty → X-API-Key. */
  header?: string;
}

/**
 * Call an HTTP API. Runs server-side: no CORS, and the auth header never shows
 * up in the browser's network log.
 *
 * The discriminator stays `'webhook'` — this action started life as a bare
 * webhook and rules saved back then must keep working untouched (url + method +
 * headers + bodyTemplate still mean exactly what they meant).
 */
export interface WebhookAction {
  type: 'webhook';
  url: string;
  method: HttpMethod;
  /** Appended to the URL as a query string. Keys and values are templated. */
  query?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: ApiAuth;
  /** Decides the content-type when the user did not set one. Empty → json. */
  bodyType?: 'json' | 'text' | 'form';
  /** Templated body. Empty → the whole event as JSON. Ignored by GET/DELETE. */
  bodyTemplate?: string;
  /** Seconds, clamped 1…60 by normalize. Empty → 10. */
  timeoutSec?: number;
  /** Keep the response body (truncated) in the activity feed — for debugging. */
  captureResponse?: boolean;
}

/**
 * Send a message through a Telegram bot. Runs server-side — the token stays out
 * of the browser entirely.
 *
 * `env` is the default source: this machine already configures a bot for the
 * MR-review process (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_CHAT_ID` in
 * .env.local, see bot/README.md). Reusing it means the token is read at dispatch
 * time and NEVER written into `.automation.json` — one bot, one place to rotate
 * it. `inline` is for a second bot that env doesn't know about.
 */
export interface TelegramAction {
  type: 'telegram';
  /** Where the bot token comes from. Empty → 'env'. */
  tokenSource?: 'env' | 'inline';
  /** Only for tokenSource 'inline': the token from @BotFather ("123456:AA…"). */
  botToken?: string;
  /** Numeric chat id, or @channelusername. Templated.
   *  Empty + 'env' → the first id in TELEGRAM_ALLOWED_CHAT_ID. */
  chatId: string;
  /** Templated. Empty → the event title + text. */
  text?: string;
  /** Telegram's formatting mode. 'none' = plain text (never fails to parse). */
  parseMode?: 'none' | 'Markdown' | 'MarkdownV2' | 'HTML';
  /** Deliver without a notification sound. */
  silent?: boolean;
  /** Don't unfurl links. Default true — alert spam with previews is unreadable. */
  noPreview?: boolean;
  /** Forum topic / thread id inside a supergroup. Templated. */
  threadId?: string;
}

/** Append one JSON line per hit to a local file. Runs server-side. */
export interface LogAction {
  type: 'log';
  /** Relative to the DevBox working dir. Empty → .automation-log.jsonl */
  file?: string;
}

/** Produce to Kafka through the DevBox's existing connection registry. */
export interface KafkaAction {
  type: 'kafka';
  connectionId: string;
  topic: string;
  /** Templated. Empty → the event instanceId (keeps one source on one partition). */
  key?: string;
  /** Templated. Empty → the whole event as JSON. */
  valueTemplate?: string;
}

/**
 * Send a message from a workspace account (Zalo…) to conversations the user
 * tagged in that app and synced into `configs/wstargets.json`.
 *
 * Why targets are a SAVED LIST rather than a name typed here: chat.zalo.me
 * exposes no per-conversation id, so a recipient can only be identified by its
 * display name — which is safe exactly when the set is small and curated. The
 * rule therefore points at a synced (account × label) entry, and the recipients
 * are visible in DevBox before sending is ever switched on.
 *
 * GUARDED like `reply`: needs config.allowSend, obeys rule dry-run, and the
 * runtime applies a hard floor between sends (a personal account blasting
 * messages is what gets it restricted).
 */
export interface WorkspaceSendAction {
  type: 'wsSend';
  /** `${pluginId}::${instanceId}` — which logged-in account sends. */
  accountKey: string;
  /** Id of a target group in the address book (account × label). */
  targetGroupId: string;
  /** Cached label, so the editor can name it without loading the store. */
  targetLabel?: string;
  /** Templated message. */
  text: string;
}

/**
 * Send a reply back into a social workspace. GUARDED: requires
 * config.allowSend AND, by default, per-send approval. Automated sending on a
 * personal account is what gets accounts flagged — the engine treats this as a
 * proposal, never a silent side effect.
 */
export interface ReplyAction {
  type: 'reply';
  text: string;
  /** Default true. */
  requireApproval?: boolean;
}

export type AutomationAction =
  | NotifyAction
  | WebhookAction
  | TelegramAction
  | WorkspaceSendAction
  | LogAction
  | KafkaAction
  | ReplyAction;
export type ActionType = AutomationAction['type'];

// ── Rules ──────────────────────────────────────────────────────────────────

/** Restrict a rule to some sources/instances. Empty array = all of them. */
export interface RuleScope {
  /** Plugin ids ('zalo') or stack ids ('redis'). */
  sourceIds: string[];
  /** Account instance ids or connection ids. */
  instanceIds: string[];
  /**
   * SOCIAL: restrict to specific conversations, by display name — a person for
   * a 1-1 chat, the group name for a group. Empty = every conversation of the
   * accounts in scope.
   *
   * Matched case-insensitively against `fields.conversation`. Names, not ids,
   * for the same measured reason the send directory uses names: chat.zalo.me
   * exposes no per-conversation id anywhere in the page.
   */
  conversations?: string[];
}

/** Active-hours window. Outside it the rule is skipped (quiet hours). */
export interface RuleWindow {
  /** 0=Sun … 6=Sat. Empty = every day. */
  days: number[];
  /** "HH:mm" local. from > to spans midnight (22:00 → 06:00). */
  from: string;
  to: string;
}

/** Firing limits — the guard against a runaway loop or an alert storm. */
export interface RuleLimits {
  /** Ignore a repeat with the same title+text within N seconds. */
  dedupeSec?: number;
  /** Minimum seconds between two firings of this rule. */
  cooldownSec?: number;
  /** Hard cap per rolling hour. */
  maxPerHour?: number;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Evaluate and record, execute nothing. How every new rule should start. */
  dryRun: boolean;
  /** Feature group — drives which fields/actions the editor offers. */
  category: EventCategory;
  trigger: TriggerType;
  scope: RuleScope;
  match: {
    /** all = AND, any = OR. No conditions = every event in scope. */
    mode: 'all' | 'any';
    conditions: AutomationCondition[];
  };
  actions: AutomationAction[];
  window?: RuleWindow;
  limits?: RuleLimits;
  /** Stop evaluating later rules once this one matches. */
  stopOnMatch?: boolean;
  notes?: string;
}

// ── Infrastructure watches (the `infra` source) ────────────────────────────

/** Stacks the probe layer can poll — all reuse the DevBox connection registries. */
export type InfraStack = 'mongo' | 'redis' | 'es' | 'kafka' | 'rabbit' | 'pg';

/**
 * One thing to keep an eye on. The runner polls the stack every `everySec`,
 * evaluates `metric op threshold`, and emits an `infra.metric` event when the
 * breach has held for `forSec` (plus `infra.recovered` when it clears). Rules
 * then decide what that means — notify, webhook, Kafka…
 */
export interface InfraWatch {
  id: string;
  name: string;
  enabled: boolean;
  stack: InfraStack;
  /** Id from that stack's connection list in the DevBox. */
  connectionId: string;
  /** Cached label so the UI can show it without loading every registry. */
  connectionLabel?: string;
  /** Metric key from the stack's probe adapter (see catalog.ts). */
  metric: string;
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  threshold: number;
  /** Poll interval (seconds). Minimum enforced by the runner. */
  everySec: number;
  /** Breach must hold this long before firing (debounce). 0 = fire at once. */
  forSec?: number;
  /** Minimum seconds between two alerts for this watch. */
  cooldownSec?: number;
  /** Also emit infra.recovered when the metric returns to normal. */
  notifyRecovery?: boolean;
}

// ── The whole persisted configuration ──────────────────────────────────────

export interface AutomationConfig {
  version: 1;
  /** Master kill switch — off means no rule ever runs. */
  enabled: boolean;
  /** SOCIAL: read message content at all. Off = counts only, no text anywhere. */
  captureEnabled: boolean;
  /** SOCIAL: keep message text in the activity feed / log files. */
  storeMessageText: boolean;
  /** SOCIAL: master switch for anything that writes back (reply). */
  allowSend: boolean;
  /** INFRA: run the watch pollers. Off = no background probing. */
  watchEnabled: boolean;
  /**
   * Drop an incoming message that automation itself sent.
   *
   * Without it: a rule sends into a group where ANOTHER linked account is also
   * a member → that account's collector sees a new message → the rule fires
   * again → the two accounts ping-pong. Per-rule cooldowns do not stop it,
   * because each bounce is a genuinely new message to a different account.
   *
   * Recognition is by an invisible WATERMARK on everything automation sends
   * (lib/automation/mark.ts) — never by comparing text. Comparing text guesses,
   * and every version of that guess ended up blocking real messages.
   */
  loopGuard: boolean;
  /**
   * Feature groups allowed to raise an OS (Electron) notification.
   *
   * Empty by DEFAULT — in-app toasts only. An OS notification opens a separate
   * window per firing, stacks outside the app and outlives it; during a
   * feedback loop that buried the desktop. Opt in per group, for the alerts
   * that are worth interrupting you when DevBox is not in front of you.
   */
  osNotify: EventCategory[];
  /** How many recent events the activity feed keeps in memory. */
  activityLimit: number;
  rules: AutomationRule[];
  watches: InfraWatch[];
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  version: 1,
  enabled: true,
  captureEnabled: false, // opt-in: no message content is read until asked for
  storeMessageText: true,
  allowSend: false, // sending is off until deliberately enabled
  watchEnabled: false, // opt-in: no background polling until asked for
  loopGuard: true, // ON by default — a feedback loop is worse than a missed event
  osNotify: [], // no OS pop-ups until asked for, per group
  activityLimit: 200,
  rules: [],
  watches: [],
};

// ── Engine output ──────────────────────────────────────────────────────────

export type SkipReason =
  | 'echo'
  | 'config-disabled'
  | 'rule-disabled'
  | 'trigger'
  | 'scope'
  | 'window'
  | 'no-match'
  | 'dedupe'
  | 'cooldown'
  | 'rate-limit';

/** One action ready to execute, templates already rendered. */
export interface ActionPlan {
  ruleId: string;
  ruleName: string;
  dryRun: boolean;
  action: AutomationAction;
}

export interface RuleDecision {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  skipped?: SkipReason;
}

export interface EvaluationResult {
  event: AutomationEvent;
  decisions: RuleDecision[];
  plans: ActionPlan[];
}

/** Result of actually running one planned action. */
export interface ActionOutcome {
  ruleId: string;
  ruleName: string;
  type: ActionType;
  status: 'ok' | 'error' | 'skipped' | 'dry-run' | 'pending-approval';
  detail?: string;
}

/** One line in the activity feed: an event plus what the rules did with it. */
export interface ActivityEntry {
  event: AutomationEvent;
  decisions: RuleDecision[];
  outcomes: ActionOutcome[];
}
