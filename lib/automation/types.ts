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

/**
 * Ghi một dòng log cho sự kiện khớp. Runs server-side.
 *
 * KHÔNG có tham số: nơi ghi (file cục bộ hay Mongo, tên file, collection) là
 * cấu hình CHUNG ở LogStoreConfig — vì tab Log & báo cáo chỉ đọc từ đó. Bản cũ
 * từng cho mỗi action đặt tên file riêng: rule hôm nay ghi A, mai ghi B, và
 * mọi dòng ghi ngoài file cấu hình là log UI không bao giờ đọc — một lựa chọn
 * chỉ tạo ra dữ liệu mồ côi thì không nên tồn tại.
 */
export interface LogAction {
  type: 'log';
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
 * Zalo API (THỬ NGHIỆM): gửi tin qua API nội bộ của Zalo Web thay vì gõ DOM.
 *
 * Khác `wsSend` ở MỘT điểm cốt lõi và đó là lý do nó tồn tại: đích được định
 * bằng `threadId` THẬT (ổn định), không phải tên hiển thị. Luồng DOM buộc phải
 * bám tên vì chat.zalo.me không lộ id ra trang; nhánh API đọc được id nên gửi
 * chính xác kể cả khi hai hội thoại trùng tên.
 *
 * GÁC CHẶT HƠN cả `wsSend` — vì đây là nhánh dễ bị Zalo đánh dấu nhất:
 *   • cần config.allowSend (chung công tắc với các action gửi khác);
 *   • đi qua đúng sendGate (nghỉ giữa 2 tin + trần/giờ) theo accountKey;
 *   • loopGuard ghi lại echo y như wsSend/telegram;
 *   • dry-run dựng request rồi in ra, KHÔNG bắn đi.
 * Chạy trong RENDERER (như wsSend) vì phải exec script trong guest webview.
 */
export interface ZaloApiSendAction {
  type: 'zaloApiSend';
  /** `zaloapi::<instanceId>` — tài khoản Zalo API nào gửi. */
  accountKey: string;
  /**
   * threadId đích. Rỗng = gửi cho chính mình (self-chat) — an toàn nhất khi thử.
   * Có thể là template ({{fields.threadId}}) để trả lời đúng hội thoại vừa đến.
   */
  threadId?: string;
  /** Hội thoại nhóm hay cá nhân (hai endpoint khác nhau). Empty → cá nhân. */
  group?: boolean;
  /** Nhãn hội thoại, chỉ để hiển thị trong trình soạn rule. */
  threadLabel?: string;
  /** Nội dung, có template. */
  text: string;
  /**
   * TAG (@) người phụ trách theo BẢNG PHÂN CÔNG chung (config.mentionAssignments)
   * — chỉ có nghĩa khi gửi NHÓM. Cờ opt-in nằm ở action để rule editor NHÌN
   * THẤY tin này sẽ tag; còn "ai phụ trách gì" là dữ liệu miền dùng chung, sống
   * ở bảng — đổi người trực sửa một chỗ, mọi rule tự ăn theo. Mention là mention
   * THẬT (mentionInfo của Zalo, có ping), không phải chữ "@tên" trần.
   */
  tagAssignees?: boolean;
}

// ── Mention (@) khi gửi Zalo nhóm ───────────────────────────────────────────

/** Một người trong danh bạ mention Zalo — Zalo cần UID thật mới ping được. */
export interface ZaloMentionPerson {
  /** Khoá gọi trong bảng phân công (viết ngắn, không dấu: 'userA', 'devops'). */
  alias: string;
  /** Tên hiển thị — thành chữ "@Tên" trong tin nhắn. */
  name: string;
  /** UID Zalo thật (chuỗi số) — đổ vào mentionInfo để Zalo ping đúng người. */
  uid: string;
}

/**
 * Một dòng bảng phân công: SỰ KIỆN NÀO → TAG NHỮNG AI.
 *
 * Mọi dòng khớp đều được CỘNG DỒN (khử trùng người): sự kiện dính cả topic A
 * lẫn topic B thì một tin tag đủ người của cả hai dòng. Hai kiểu đầu là
 * "hardcode có chủ đích" — người cấu hình chỉ gõ tên topic, KHÔNG phải biết
 * topic nằm ở field nào của event; tri thức đó nằm trong lib/automation/mention.ts.
 */
export interface MentionAssignment {
  id: string;
  enabled: boolean;
  /**
   * 'topic'  — cảnh báo Kafka dính một trong các topic ở `values`
   *            (dò trong fields.topics / fields.groups / title / text).
   *            Giá trị đặc biệt: '*' = mọi sự kiện dính topic/consumer;
   *            '*:<cụm>' = như trên nhưng riêng một cụm (id hoặc tên) —
   *            gán cả cụm cho một người, khỏi liệt kê từng topic.
   * 'infra'  — sự cố hạ tầng kiểu devops: mất kết nối, host down, đĩa/RAM/CPU/
   *            load/heap… `values` rỗng = cả nhóm metric đó; có giá trị = giới
   *            hạn đúng các metric key này.
   * 'custom' — điều kiện tuỳ ý (AND toàn bộ `conditions`) — lối thoát cho case
   *            thứ ba sau này mà không phải đục engine.
   */
  kind: 'topic' | 'infra' | 'custom';
  /** kind 'topic': danh sách topic. kind 'infra': (tuỳ chọn) danh sách metric key. */
  values?: string[];
  /**
   * kind 'topic', chỉ có tác dụng với token tất-cả ('*' / '*:<cụm>'): sự kiện
   * NHẮC TỚI một topic trong danh sách này thì wildcard bỏ qua — "gán cả cụm,
   * trừ mấy topic ồn ào". Tên topic tường minh trong `values` không bị ảnh hưởng.
   */
  excludes?: string[];
  /** kind 'custom': tất cả điều kiện phải đúng (AND). */
  conditions?: AutomationCondition[];
  /** Alias trong danh bạ mention — nhiều người một dòng. */
  tag: string[];
  note?: string;
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
  | ZaloApiSendAction
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
  /**
   * INFRA: the watches this rule answers for, BY ID. Empty = every watch that
   * passes sourceIds/instanceIds.
   *
   * Ids, not names: a watch id is stable, so renaming "Campaign — RAM cao" never
   * detaches it from its rule. (The first cut of this encoded severity as a
   * `[P2]` prefix in the name and matched on the text — one rename silently took
   * a watch off alerting, which is exactly what this field exists to prevent.)
   */
  watchIds?: string[];
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
  /**
   * What `cooldownSec` / `maxPerHour` count over. This is a POLICY choice, not a
   * technical one, which is why it is asked rather than assumed:
   *
   *   'rule'     one counter for the whole rule. Watch A or watch B fires → one
   *              alert per cooldown. Use when the rule represents ONE concern
   *              ("something is wrong with the message bus") and a second alert
   *              adds nothing.
   *   'watch'    a counter per watch. A and B each get their own alert. Use when
   *              the rule covers many independent things — 40 clusters failing at
   *              once must produce 40 alerts, not 1.
   *   'instance' a counter per connection. Every watch on the same cluster shares
   *              one counter; different clusters never silence each other.
   *
   * Empty → 'rule' (the narrowest, quietest choice; widen deliberately).
   */
  countBy?: 'rule' | 'watch' | 'instance';
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
 * How serious a breach of this watch is. PURE METADATA: it travels on the event
 * as `fields.severity` so an alert can identify itself ("🔴 NGHIÊM TRỌNG"), and a
 * rule may read it as a condition — but it routes nothing by itself. A rule picks
 * its watches by id (`scope.watchIds`), never by severity.
 *
 * That separation is deliberate. Severity is a property of the MEASUREMENT ("a
 * dead controller is worse than 81% RAM"); which channel to alert and how often
 * is a property of the RULE. Encoding one in the other is what the earlier
 * `[P2]`-in-the-name scheme did wrong.
 */
export type WatchSeverity = 'critical' | 'warning' | 'info';

/**
 * One thing to keep an eye on — the TRIGGER side of automation, and nothing more.
 *
 * The runner polls the stack every `everySec`, evaluates `metric op threshold`,
 * and emits an `infra.metric` event once the breach has held for `forSec` (plus
 * `infra.recovered` when it clears). It decides WHETHER something happened; a
 * rule decides what that means and how loudly to say it.
 *
 * `forSec` lives here rather than on the rule because it is part of MEASURING —
 * a metric that crosses a threshold for 20 seconds has not really breached it.
 * Alert frequency (once an hour, per watch or per rule) belongs to the rule; see
 * RuleLimits. A watch therefore emits on EVERY poll while breaching, and a rule
 * that pays attention to a chatty watch must set its own limits.
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
  /**
   * CHỈ Kafka + chỉ số theo consumer group (maxConsumerLag, stalledGroups…):
   * giới hạn phép đo vào ĐÚNG các consumer group này (theo groupId), chọn từ
   * dropdown gợi ý trong editor. Rỗng/không có = mọi group trên cụm (hành vi
   * cũ). Nhờ đó `maxConsumerLag > X` với danh sách rỗng = "bất kỳ consumer nào
   * lag > X", và với danh sách đã chọn = "chỉ 1 trong các consumer này lag > X
   * là báo" — cùng một chỉ số, khác nhau ở tập group được xét.
   */
  groupFilter?: string[];
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  threshold: number;
  /** Poll interval (seconds). Minimum enforced by the runner. */
  everySec: number;
  /** Breach must hold this long before firing (debounce). 0 = fire at once. */
  forSec?: number;
  /** Alert identity, not routing. Empty → 'warning'. */
  severity?: WatchSeverity;
  /** Free-form labels for finding a watch in a long list. Never used to route. */
  tags?: string[];
  /** Also emit infra.recovered when the metric returns to normal. */
  notifyRecovery?: boolean;
  /**
   * Ghi chú nghiệp vụ tự do ("Redis này cấp session cho tổng đài…"). Được NỐI
   * vào description tự sinh của mọi cảnh báo — là phần ngữ cảnh mà catalog
   * không thể biết, và là thứ giúp một con bot AI đánh giá đúng mức độ.
   */
  note?: string;
}

// ── Log storage ────────────────────────────────────────────────────────────

/**
 * Where automation writes its history.
 *
 * `local` is a JSONL file next to the config, pruned after `retentionDays` —
 * good enough to answer "what fired last night" on this one machine.
 * `mongo` writes documents to a collection instead, for history that outlives
 * this machine and can be queried. Retention there is left to Mongo (a TTL
 * index), because deleting other people's data on a shared cluster is not
 * something a local tool should do behind their back.
 */
export type LogTarget = 'local' | 'mongo';

export interface LogStoreConfig {
  /** Off = nothing is written anywhere. The `log` action then reports skipped. */
  enabled: boolean;
  target: LogTarget;
  /** local: file name inside the working dir. Empty → .automation-log.jsonl */
  file?: string;
  /** local: lines older than this are dropped on write. Empty → 7. */
  retentionDays?: number;
  /**
   * mongo: id from the DevBox Mongo registry (configs/mongoconnections.json).
   *
   * An id, not a connection string: the credentials then live in ONE place, the
   * Mongo tab already knows how to test/edit them, and this config carries no
   * password of its own. A connection typed here is saved INTO that registry
   * first, so it shows up in the Mongo tab like any other.
   */
  connectionId?: string;
  /** mongo: cached label so the UI can name it without loading the registry. */
  connectionLabel?: string;
  /** mongo: database name. Empty → devbox. */
  database?: string;
  /** mongo: collection name. Empty → automation_log. */
  collection?: string;
  /**
   * mongo: set once a write actually succeeded against this target.
   *
   * The UI requires that confirmation before switching the target over: silently
   * pointing logging at an unreachable cluster loses exactly the records you
   * would need to diagnose why.
   */
  verifiedAt?: number;
}

export const DEFAULT_LOG_STORE: LogStoreConfig = {
  enabled: false, // opt-in, like every other side effect here
  target: 'local',
  retentionDays: 7,
};

/**
 * Trace of the watch runner itself: "is the infrastructure campaign actually
 * running right now?"
 *
 * Distinct from `logStore`, which records what the RULES did. A watch that polls
 * every 60s and never breaches produces no rule activity at all, so the activity
 * feed stays empty and there is no way to tell "quiet because healthy" from
 * "quiet because the runner died". This answers that.
 *
 * Off by default and separate from the alert log because it is DEBUG volume: 153
 * watches at 60s is ~150 lines a minute. Kept for one day, then dropped.
 */
export interface TraceConfig {
  /** Print each poll to the DevTools console (renderer — that is where it runs). */
  console: boolean;
  /** Append each poll to a JSON-lines file, pruned to `retentionHours`. */
  file: boolean;
  /** File name in the working dir. Empty → .automation-trace.jsonl */
  fileName?: string;
  /** Hours to keep. Empty → 24. */
  retentionHours?: number;
  /**
   * Trace every poll, or only the ones that mean something.
   *
   * 'all'      every poll, including "read 72%, still fine" — what you want for
   *            ten minutes while checking the campaign runs at all.
   * 'changes'  only breach / recovery / probe error, plus a periodic heartbeat.
   *            Sustainable to leave on.
   */
  verbosity: 'all' | 'changes';
}

export const DEFAULT_TRACE: TraceConfig = {
  console: false,
  file: false,
  retentionHours: 24,
  verbosity: 'changes',
};

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
   * INFRA: chống TRÙNG cảnh báo giữa các watch xếp bậc ngưỡng trên cùng một thứ.
   *
   * Đặt "disk > 90% (critical)" và "disk > 80% (warning)" cho cùng một máy là
   * cách khai mức nặng nhẹ rất thường gặp. Khi disk = 95% thì CẢ HAI cùng vượt
   * ngưỡng và mỗi watch phát một sự kiện → hai cảnh báo cho một sự việc. Bật cờ
   * này thì trong mỗi nhóm (cùng máy + cùng chỉ số + cùng chiều so sánh) chỉ
   * watch có ngưỡng CHẶT NHẤT còn khớp được phát; các mức nhẹ hơn im.
   *
   * Disk tụt về 85% → mức 90% hết khớp, mức 80% thành cái chặt nhất → nó phát.
   * Cảnh báo tự "hạ cấp" thay vì im lặng.
   *
   * Mặc định BẬT: gần như không ai muốn hai tin cho cùng một sự việc. Tắt khi
   * thực sự cần từng mức một tiếng nói riêng (vd mỗi mức đẩy vào một hệ thống
   * khác nhau). Xem lib/automation/watcher.ts · ladderKey/stricter.
   */
  dedupeLadder?: boolean;
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
  /** Where the `log` action writes. Off by default — see LogStoreConfig. */
  logStore: LogStoreConfig;
  /** Trace of the watch runner (is the campaign running?). Off by default. */
  trace: TraceConfig;
  rules: AutomationRule[];
  watches: InfraWatch[];
  /** Danh bạ mention Zalo (alias → tên + uid) — bảo trì uid MỘT chỗ. */
  mentionPeople: ZaloMentionPerson[];
  /** Bảng phân công tag — dữ liệu miền "ai phụ trách gì", dùng chung mọi rule. */
  mentionAssignments: MentionAssignment[];
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  version: 1,
  enabled: true,
  captureEnabled: false, // opt-in: no message content is read until asked for
  storeMessageText: true,
  allowSend: false, // sending is off until deliberately enabled
  watchEnabled: false, // opt-in: no background polling until asked for
  dedupeLadder: true, // hai ngưỡng trên cùng một thứ → chỉ mức nặng nhất kêu
  loopGuard: true, // ON by default — a feedback loop is worse than a missed event
  osNotify: [], // no OS pop-ups until asked for, per group
  activityLimit: 200,
  logStore: DEFAULT_LOG_STORE, // opt-in: nothing is written to disk until asked for
  trace: DEFAULT_TRACE, // opt-in: debug volume, not something to leave on by accident
  rules: [],
  watches: [],
  mentionPeople: [],
  mentionAssignments: [],
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
