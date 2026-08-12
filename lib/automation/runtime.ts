'use client';

// DevBox Automation — the renderer-side runtime.
//
// ONE module-level singleton owns the live automation state for the whole app:
// the config, the engine's firing history, the activity feed and the toast
// stream. The Workspace tab feeds it events while you are reading Kafka logs on
// another tab, and the Automation tab renders the very same object — a React
// context would have forced both to live under one provider and would have
// reset the engine history on every remount.
//
//   source → automation.submit(event) → evaluate() → plans
//                                     ├─ notify                   → here (toast + OS)
//                                     ├─ webhook / telegram / log → POST /api/automation/dispatch
//                                     ├─ kafka                    → /api/kafka produce
//                                     └─ reply                    → held for approval
//
// Subscribe with useSyncExternalStore (see useAutomation()).

import { produceKafkaMessage } from '@/lib/kafka';
import { sendToTargetGroup } from './wsSend';
import { sendViaZaloApi } from './zaloApiSend';
import { hasMark, stripMark } from './mark';
import {
  createEngineState,
  evaluate,
  isDuplicateEvent,
  mergeEngineState,
  snapshotEngineState,
  type EngineState,
} from './engine';
import { normalizeConfig } from './normalize';
import {
  DEFAULT_AUTOMATION_CONFIG,
  type ActionOutcome,
  type ActionPlan,
  type ActivityEntry,
  type AutomationConfig,
  type AutomationEvent,
  type EvaluationResult,
  type EventCategory,
  type NotifyAction,
  type RuleDecision,
} from './types';

export interface AutomationSnapshot {
  config: AutomationConfig;
  /** Newest first, capped by config.activityLimit. */
  activity: ActivityEntry[];
  /** False until the on-disk config has been read once. */
  loaded: boolean;
  /** Bumped on every change so components re-render cheaply. */
  rev: number;
}

/** A notify action that fired — the shell turns these into toasts. */
export interface AutomationToast {
  id: string;
  level: NotifyAction['level'];
  title: string;
  body: string;
  ruleName: string;
  dryRun: boolean;
  at: number;
}

type Listener = () => void;

class AutomationRuntime {
  private config: AutomationConfig = { ...DEFAULT_AUTOMATION_CONFIG, rules: [], watches: [] };
  private activity: ActivityEntry[] = [];
  private loaded = false;
  private rev = 0;
  private state: EngineState = createEngineState();
  private snap: AutomationSnapshot = this.build();
  private listeners = new Set<Listener>();
  private toastListeners = new Set<(t: AutomationToast) => void>();
  private loading: Promise<AutomationConfig> | null = null;

  // ── store plumbing ───────────────────────────────────────────────────────

  private build(): AutomationSnapshot {
    return { config: this.config, activity: this.activity, loaded: this.loaded, rev: this.rev };
  }

  private emit(): void {
    this.rev += 1;
    this.snap = this.build();
    for (const l of this.listeners) l();
  }

  getSnapshot = (): AutomationSnapshot => this.snap;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Toast sink for the app shell. Returns an unsubscribe function. */
  onToast = (fn: (t: AutomationToast) => void): (() => void) => {
    this.toastListeners.add(fn);
    return () => this.toastListeners.delete(fn);
  };

  // ── config ───────────────────────────────────────────────────────────────

  /** Read the config once per session; concurrent callers share the fetch. */
  load(): Promise<AutomationConfig> {
    if (this.loaded) return Promise.resolve(this.config);
    if (this.loading) return this.loading;
    this.loading = this.fetchConfig()
      // Hydrate lịch sử bắn TRƯỚC khi loaded=true: sự kiện đầu tiên sau khi mở
      // app phải nhìn thấy cooldown đang chạy từ phiên trước, nếu không "nghỉ
      // 5 phút" thành "nghỉ đến lần F5 gần nhất".
      .then((cfg) => this.hydrateLimits().then(() => cfg))
      .then((cfg) => {
        this.config = cfg;
        this.loaded = true;
        this.loading = null;
        this.emit();
        return cfg;
      });
    return this.loading;
  }

  // ── lịch sử bắn dùng chung (xem /api/automation/limits) ────────────────────
  //
  // EngineState trong RAM chết theo cửa sổ; bản trên server thì không. Hai chiều:
  // hydrate lúc load (kéo lịch sử của mọi phiên/cửa sổ trước về), push sau mỗi
  // lần có rule bắn thật (đẩy mốc mới lên + merge lại phần server biết mà mình
  // chưa biết). Cả hai đều fail-soft — mất route thì hành xử như bản cũ.

  private limitsPushTimer: ReturnType<typeof setTimeout> | null = null;

  private async hydrateLimits(): Promise<void> {
    try {
      const r = await fetch('/api/automation/limits');
      mergeEngineState(this.state, await r.json());
    } catch {
      /* route lỗi/chưa có file — chạy với state trống như trước */
    }
  }

  /** Gom nhiều lần bắn sát nhau thành một PUT — bão cảnh báo không thành bão HTTP. */
  private schedulePushLimits(): void {
    if (this.limitsPushTimer) return;
    this.limitsPushTimer = setTimeout(() => {
      this.limitsPushTimer = null;
      void this.pushLimits();
    }, 800);
  }

  private async pushLimits(): Promise<void> {
    try {
      const r = await fetch('/api/automation/limits', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshotEngineState(this.state)),
      });
      // Server trả bản merge — nhận lại để biết cả mốc các cửa sổ khác vừa đẩy.
      mergeEngineState(this.state, await r.json());
    } catch {
      /* lần bắn sau sẽ thử lại — mốc vẫn còn trong RAM */
    }
  }

  /** Fetch + normalize the on-disk config; falls back to the current copy on
   *  network/route error so a transient failure never wipes local state. */
  private fetchConfig(): Promise<AutomationConfig> {
    return fetch('/api/automation')
      .then((r) => r.json())
      .then((raw) => normalizeConfig(raw))
      .catch(() => this.config);
  }

  /** Force a re-read from disk and adopt it — the Automation tab calls this on
   *  mount so a config another window/device wrote is picked up, instead of
   *  the stale copy this session loaded once at startup. */
  async reload(): Promise<AutomationConfig> {
    const cfg = await this.fetchConfig();
    this.config = cfg;
    this.loaded = true;
    this.emit();
    return cfg;
  }

  /**
   * Persist a whole config (the editor's explicit "write everything").
   *
   * Lost-update guard: re-read the disk copy right before writing and, when it
   * changed under us since this session loaded, MERGE rather than clobber —
   * fields the caller did not touch keep the newer disk value. `rules`/
   * `watches`/top-level switches the caller changed still win (that is the
   * point of Save), but a rule another window added in the meantime is not
   * silently dropped. onConflict fires so the UI can tell the user a refresh
   * happened underneath them.
   */
  async save(next: AutomationConfig, onConflict?: (disk: AutomationConfig) => void): Promise<AutomationConfig> {
    const desired = normalizeConfig(next);
    const base = this.config; // what this session believed was current

    let toWrite = desired;
    const disk = await this.fetchConfig();
    if (JSON.stringify(disk) !== JSON.stringify(base)) {
      // Someone else wrote since we loaded. Start from THEIR copy and lay only
      // the fields we actually intended to change on top.
      toWrite = normalizeConfig(this.mergeChanges(base, desired, disk));
      onConflict?.(disk);
    }

    // Adopt locally first so the UI never feels laggy…
    this.config = toWrite;
    this.loaded = true;
    this.emit();
    try {
      const r = await fetch('/api/automation', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.config),
      });
      // …then reconcile with what actually hit the disk.
      this.config = normalizeConfig(await r.json());
      this.emit();
    } catch {
      /* keep the local copy; the next save retries */
    }
    return this.config;
  }

  /** Take `disk` as the base and apply only the keys the caller changed
   *  (base → desired). rules/watches are whole-array replacements when the
   *  caller touched them; otherwise disk's newer arrays are kept. */
  private mergeChanges(
    base: AutomationConfig,
    desired: AutomationConfig,
    disk: AutomationConfig,
  ): AutomationConfig {
    const merged = { ...disk } as unknown as Record<string, unknown>;
    const d = desired as unknown as Record<string, unknown>;
    const b = base as unknown as Record<string, unknown>;
    for (const key of Object.keys(d)) {
      if (JSON.stringify(d[key]) !== JSON.stringify(b[key])) {
        // Caller changed this key relative to what they loaded → their value wins.
        merged[key] = d[key];
      }
    }
    return merged as unknown as AutomationConfig;
  }

  /**
   * Convenience for toggles: flip a few top-level switches WITHOUT risking the
   * rules/watches arrays. Always re-reads disk first so a toggle can never
   * carry a stale rule list back over a concurrent edit.
   */
  async patch(patch: Partial<AutomationConfig>): Promise<AutomationConfig> {
    const disk = await this.fetchConfig();
    return this.save({ ...disk, ...patch });
  }

  get current(): AutomationConfig {
    return this.config;
  }

  // ── the pipeline ─────────────────────────────────────────────────────────

  /**
   * Feed one event through the rules and run whatever they planned.
   * Never throws: a source (a 3-second poll) must not be able to break.
   */
  async submit(event: AutomationEvent): Promise<EvaluationResult | null> {
    try {
      if (!this.loaded) await this.load();
      if (isDuplicateEvent(this.state, event)) return null;

      // Our own message coming back. Recorded in the activity feed rather than
      // dropped in silence — "the rule didn't fire" with no trace is the worst
      // possible way to learn about a loop guard.
      if (this.config.loopGuard && event.category === 'social') {
        this.traceEcho(event); // record the comparison, matched or not, for diagnosis
      }
      if (this.config.loopGuard && this.isEcho(event)) {
        const decisions = this.config.rules.map((r) => ({
          ruleId: r.id,
          ruleName: r.name,
          matched: false,
          skipped: 'echo' as const,
        }));
        this.record({ event: this.forStorage(event), decisions, outcomes: [] });
        if (event.category === 'social') void this.logIncoming(event, true, decisions);
        return { event, decisions, plans: [] };
      }

      const result = evaluate(this.config, event, this.state);
      // Có rule bắn thật (không bị chặn bởi giới hạn) → mốc cooldown vừa đổi,
      // đẩy lên server để cửa sổ khác / phiên sau tôn trọng nó.
      if (result.decisions.some((d) => d.matched && !d.skipped)) this.schedulePushLimits();
      if (event.category === 'social') void this.logIncoming(event, false, result.decisions);
      // Nhật ký engine cho event Zalo API — in ra console (terminal) mỗi quyết
      // định của từng rule, để chẩn đoán "vì sao không match" ngoài tab Zalo API.
      if (event.sourceId === 'zaloapi') {
        const summary = result.decisions
          .map((d) => `${d.matched ? '✓' : '✗'}${d.ruleName}${d.skipped ? `(${d.skipped})` : ''}`)
          .join(', ') || '(chưa có rule social)';
        // eslint-disable-next-line no-console
        console.log(`ZALOAPI_AUTOMATION conv="${event.fields?.conversation ?? ''}" text="${String(event.text).slice(0, 40)}" → ${summary}`);
      }
      const outcomes = await this.execute(result);
      if (this.worthRecording(result)) {
        this.record({ event: this.forStorage(event), decisions: result.decisions, outcomes });
      }
      return result;
    } catch {
      return null;
    }
  }

  /** Strip message text from what we KEEP when the user asked not to store it.
   *  Also drops the watermark: invisible characters that survive into a copied
   *  bug report are their own kind of confusing. */
  private forStorage(event: AutomationEvent): AutomationEvent {
    const clean = { ...event, title: stripMark(event.title), text: stripMark(event.text) };
    if (this.config.storeMessageText || clean.category !== 'social') return clean;
    return { ...clean, text: clean.text ? '••••' : '', fields: { ...clean.fields, text: '' } };
  }

  /**
   * Should this evaluation take a line in the activity feed?
   *
   * A breaching watch now emits on EVERY poll (rationing moved to the rules), so
   * with 30s watches a handful of simultaneous breaches would churn the 200-line
   * feed in about a minute and destroy its diagnostic value exactly when it is
   * needed. Infra entries are therefore kept only when they say something:
   *
   *   • a rule actually ran            → what happened
   *   • a rule matched but was held    → NOT kept: the limit doing its job is
   *                                      not news, and it is the high-volume case
   *   • nothing matched at all         → kept: means the config is wrong
   *
   * Social is untouched — one entry per message is the point there.
   */
  private worthRecording(result: EvaluationResult): boolean {
    if (result.event.category !== 'infra') return true;
    if (result.plans.length) return true;
    const held = new Set(['dedupe', 'cooldown', 'rate-limit', 'window']);
    return !result.decisions.some((d) => d.matched && d.skipped && held.has(d.skipped));
  }

  private record(entry: ActivityEntry): void {
    const cap = Math.max(20, this.config.activityLimit || 200);
    this.activity = [entry, ...this.activity].slice(0, cap);
    this.emit();
  }

  /** Run the planned actions, splitting them by who can actually do the work. */
  private async execute(result: EvaluationResult): Promise<ActionOutcome[]> {
    const plans = result.plans;
    if (!plans.length) return [];

    const local: ActionPlan[] = [];
    const server: ActionPlan[] = [];
    const SERVER_SIDE: ActionPlan['action']['type'][] = ['webhook', 'telegram', 'log'];
    for (const p of plans) {
      if (SERVER_SIDE.includes(p.action.type)) server.push(p);
      else local.push(p);
    }

    const [localOutcomes, serverOutcomes] = await Promise.all([
      Promise.all(local.map((p) => this.runLocal(p, result.event))),
      this.dispatch(result.event, server),
    ]);
    return [...localOutcomes, ...serverOutcomes];
  }

  private async dispatch(event: AutomationEvent, plans: ActionPlan[]): Promise<ActionOutcome[]> {
    if (!plans.length) return [];
    // Telegram lands in the same trap as Zalo: send into a group a linked
    // Telegram workspace account also reads, and the reply comes straight back
    // in as a new message. Record it so the trigger skips that echo.
    if (this.config.loopGuard) {
      for (const p of plans) {
        if (!p.dryRun && p.action.type === 'telegram') this.noteSentEcho('', p.action.text ?? '');
      }
    }
    try {
      const r = await fetch('/api/automation/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, plans }),
      });
      const d = (await r.json()) as { outcomes?: ActionOutcome[] };
      return d.outcomes ?? [];
    } catch (e) {
      return plans.map((p) => ({
        ruleId: p.ruleId,
        ruleName: p.ruleName,
        type: p.action.type,
        status: 'error' as const,
        detail: (e as Error).message,
      }));
    }
  }

  private async runLocal(plan: ActionPlan, event: AutomationEvent): Promise<ActionOutcome> {
    const base = { ruleId: plan.ruleId, ruleName: plan.ruleName, type: plan.action.type };
    const action = plan.action;

    // Dry-run still produces a toast for `notify` — that IS the point of a
    // dry-run: see what the rule would say, without any outside side effect.
    // `wsSend` is also let through: ITS dry-run walks the whole path (open the
    // conversation, type the message) and then clears the box without sending,
    // which is the only way to find out that a selector broke BEFORE 3am.
    if (plan.dryRun && action.type !== 'notify' && action.type !== 'wsSend' && action.type !== 'zaloApiSend') {
      return { ...base, status: 'dry-run' };
    }

    switch (action.type) {
      case 'notify': {
        const title = action.title || event.title || 'DevBox';
        const body = action.body || event.text || '';
        this.toast({
          id: `${event.id}-${plan.ruleId}-${this.rev}`,
          level: action.level,
          title,
          body,
          ruleName: plan.ruleName,
          dryRun: plan.dryRun,
          at: Date.now(),
        });
        if (!plan.dryRun && this.osAllowed(event.category)) this.osNotify(title, body, !!action.sound);
        return { ...base, status: plan.dryRun ? 'dry-run' : 'ok' };
      }
      case 'kafka': {
        if (!action.connectionId || !action.topic) {
          return { ...base, status: 'error', detail: 'thiếu kết nối hoặc topic' };
        }
        try {
          const res = await produceKafkaMessage(action.connectionId, {
            topic: action.topic,
            key: action.key || undefined,
            value: action.valueTemplate || JSON.stringify(event),
          });
          return { ...base, status: 'ok', detail: `partition ${res.partition} @ ${res.offset}` };
        } catch (e) {
          return { ...base, status: 'error', detail: (e as Error).message };
        }
      }
      case 'wsSend': {
        if (!action.accountKey || !action.targetGroupId) {
          return { ...base, status: 'error', detail: 'chưa chọn tài khoản gửi hoặc danh sách đích' };
        }
        // The guards below stop a message going OUT. A dry run never sends, so
        // gating it would only stop you from checking the path works before
        // enabling sending — the exact thing dry-run exists for.
        if (!plan.dryRun) {
          if (!this.config.allowSend) {
            return { ...base, status: 'skipped', detail: 'công tắc “cho phép gửi” đang tắt' };
          }
          // Hard floor, independent of the rule's own limits: a personal account
          // firing messages back to back is exactly what gets it restricted.
          const gate = this.sendGate(action.accountKey);
          if (gate) return { ...base, status: 'skipped', detail: gate };
        }
        try {
          // Record the echo BEFORE the send returns — the message can bounce
          // back the instant it goes out, before this line would run otherwise.
          // (Handled per-target inside runtime just below is too late.)
          const res = await sendToTargetGroup(action, plan.dryRun, (conv) => {
            if (this.config.loopGuard && !plan.dryRun) this.noteSentEcho(conv, action.text);
          });
          this.noteSend(action.accountKey, res.sent);
          return {
            ...base,
            status: res.status,
            detail: res.detail,
          };
        } catch (e) {
          return { ...base, status: 'error', detail: (e as Error).message };
        }
      }
      case 'zaloApiSend': {
        if (!action.accountKey) {
          return { ...base, status: 'error', detail: 'chưa chọn tài khoản Zalo API gửi' };
        }
        // Same guards as wsSend — sending on a personal account is what gets it
        // flagged, and the API path has none of the UI's natural rate limit, so
        // the floor matters MORE here, not less. Dry-run skips the guards on
        // purpose: it never sends, so gating it defeats its purpose.
        if (!plan.dryRun) {
          if (!this.config.allowSend) {
            return { ...base, status: 'skipped', detail: 'công tắc “cho phép gửi” đang tắt' };
          }
          const gate = this.sendGate(action.accountKey);
          if (gate) return { ...base, status: 'skipped', detail: gate };
        }
        try {
          // Record the echo BEFORE the send, by threadId: an API send can bounce
          // back through the WebSocket feed as a new event just like a DOM send.
          if (this.config.loopGuard && !plan.dryRun) {
            this.noteSentEcho(action.threadLabel ?? action.threadId ?? '', action.text);
          }
          const res = await sendViaZaloApi(action, plan.dryRun);
          this.noteSend(action.accountKey, res.sent);
          return { ...base, status: res.status, detail: res.detail };
        } catch (e) {
          return { ...base, status: 'error', detail: (e as Error).message };
        }
      }
      case 'reply':
        // Deliberately not implemented as an automatic send: replying on a
        // personal account is exactly what gets accounts flagged. The plan is
        // surfaced in the activity feed for the human to act on.
        return {
          ...base,
          status: this.config.allowSend ? 'pending-approval' : 'skipped',
          detail: this.config.allowSend ? action.text : 'gửi tự động đang tắt',
        };
      default:
        return { ...base, status: 'skipped' };
    }
  }

  private toast(t: AutomationToast): void {
    for (const l of this.toastListeners) l(t);
  }

  // ── send throttle (workspace accounts) ───────────────────────────────────
  //
  // A hard floor that a rule cannot opt out of. Rule limits protect against a
  // noisy RULE; this protects the ACCOUNT, which is the thing that gets
  // restricted when messages go out back to back.

  // ── loop guard ───────────────────────────────────────────────────────────
  //
  // Everything automation sends is remembered briefly. An incoming message
  // whose text matches one of those is OUR OWN message coming back — through a
  // second linked account that shares the group, or through the app echoing it
  // — and evaluating it would start a ping-pong that per-rule cooldowns cannot
  // stop, because every bounce is a genuinely new message.

  /**
   * A record of one message automation sent, so its echo can be recognised
   * WITHOUT relying on anything surviving the app's round trip.
   *
   * The invisible watermark was supposed to do this, but Zalo strips zero-width
   * characters from a message before it comes back — so the mark never arrives
   * and the loop guard missed its own echo. Remembering the send is the signal
   * that cannot be stripped.
   */
  private echoes: { at: number; conv: string; text: string }[] = [];
  /** How long a sent message can still be recognised as its own echo. An echo
   *  returns within seconds; past this, identical text is a human, not a loop. */
  private static readonly ECHO_WINDOW_MS = 120_000;

  private static echoNorm(s: string): string {
    return stripMark(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  /** "Tâm: nội dung" → "nội dung": a group notification carries the sender. */
  private static echoBody(s: string): string {
    const i = s.indexOf(':');
    return AutomationRuntime.echoNorm(i > 0 && i <= 40 ? s.slice(i + 1) : s);
  }

  /**
   * A visible trail of the echo comparison — the thing I kept guessing at.
   *
   * For each incoming social message it captures what came in (conversation +
   * normalised body) beside the records present, and whether they matched. Read
   * live in the 🔬 Thu tin tab: if an automation message triggers a rule, this
   * shows EXACTLY why its record did not match — wrong conversation name,
   * truncated text, extra prefix — instead of leaving it to speculation.
   */
  echoTrace: {
    at: number;
    conv: string;
    body: string;
    matched: boolean;
    records: { conv: string; text: string; age: number }[];
  }[] = [];

  private traceEcho(event: AutomationEvent): void {
    const now = Date.now();
    const conv = AutomationRuntime.echoNorm(String(event.fields?.conversation ?? ''));
    const body = AutomationRuntime.echoBody(event.text || event.title);
    const records = this.echoes
      .filter((e) => now - e.at < AutomationRuntime.ECHO_WINDOW_MS)
      .map((e) => ({ conv: e.conv, text: e.text, age: Math.round((now - e.at) / 1000) }));
    const matched =
      (hasMark(event.text) || hasMark(event.title)) || records.some((e) => e.text === body);
    this.echoTrace.unshift({ at: now, conv, body, matched, records });
    if (this.echoTrace.length > 12) this.echoTrace.length = 12;
  }

  /**
   * Log what happened to ONE incoming social message, to the same debug file as
   * the send trace. This answers the real question — "why don't later messages
   * trigger?" — by showing each arrival's disposition: was it caught, was it
   * dropped as an echo, and what every rule decided (matched / skip reason).
   */
  private async logIncoming(
    event: AutomationEvent,
    echo: boolean,
    decisions: RuleDecision[],
  ): Promise<void> {
    try {
      await fetch('/api/ws-sendlog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'incoming',
          account: event.instanceLabel,
          conversation: String(event.fields?.conversation ?? ''),
          sender: String(event.fields?.sender ?? ''),
          chatType: String(event.fields?.chatType ?? ''),
          text: stripMark(event.text).slice(0, 80),
          droppedAsEcho: echo,
          decisions: decisions.map((d) => ({
            rule: d.ruleName,
            matched: d.matched,
            skip: d.skipped ?? '',
          })),
          pendingEchoes: this.echoes.map((e) => e.text.slice(0, 40)),
        }),
      });
    } catch {
      /* logging must never break the pipeline */
    }
  }

  /** Remember a message just sent, so the trigger can skip its echo. */
  noteSentEcho(conversation: string, text: string): void {
    const t = AutomationRuntime.echoNorm(text);
    if (!t) return;
    this.echoes.push({ at: Date.now(), conv: AutomationRuntime.echoNorm(conversation), text: t });
    if (this.echoes.length > 100) this.echoes.splice(0, this.echoes.length - 100);
  }

  /**
   * Is this event automation's own message coming back?
   *
   * Matches an incoming message against what we RECORDED sending, by EXACT text
   * within the window. Match-and-KEEP, NOT consume-once.
   *
   * Consume-once was the loop bug: ONE sent message is seen by MORE THAN ONE
   * capture surface. The recipient account sees it, AND the sender's own account
   * sees the very same text mirrored under a different conversation name (a group
   * both accounts are in, "Tâm 2"/group/"Vài giâyBạn"). The first surface
   * consumed the single record; the second found nothing, was treated as fresh,
   * re-triggered, and the template re-wrapped the text — "[Automation]
   * [Automation] …" growing without bound (see ws-send-debug.log 15:39). Keeping
   * the record suppresses EVERY surface that carries that text inside the window.
   *
   * NOT scoped by conversation — the mirror surface reports a different name, so
   * a conversation check would let it through. The cost of keep-not-consume is
   * dropping identical human text for up to the window (2 min) after a send;
   * automation text is distinctive and an unbounded loop is far worse.
   */
  private isEcho(event: AutomationEvent): boolean {
    if (hasMark(event.text) || hasMark(event.title)) return true; // belt, if a mark ever survives

    const now = Date.now();
    this.echoes = this.echoes.filter((e) => now - e.at < AutomationRuntime.ECHO_WINDOW_MS);
    if (!this.echoes.length) return false;

    const body = AutomationRuntime.echoBody(event.text || event.title);
    if (!body) return false;

    // Keep the record: a single send has multiple echoes (recipient view +
    // sender's own mirror), and each must be dropped.
    return this.echoes.some((e) => e.text === body);
  }

  /** accountKey → timestamps of sends inside the last hour. */
  private sendLog = new Map<string, number[]>();
  private static readonly SEND_GAP_MS = 5_000;
  private static readonly SEND_PER_HOUR = 20;

  /** '' when a send may proceed, otherwise the reason to show. */
  private sendGate(accountKey: string): string {
    const now = Date.now();
    const list = (this.sendLog.get(accountKey) ?? []).filter((t) => now - t < 3_600_000);
    this.sendLog.set(accountKey, list);
    const last = list[list.length - 1];
    if (last && now - last < AutomationRuntime.SEND_GAP_MS) {
      return `nghỉ giữa 2 tin (${Math.ceil((AutomationRuntime.SEND_GAP_MS - (now - last)) / 1000)}s nữa)`;
    }
    if (list.length >= AutomationRuntime.SEND_PER_HOUR) {
      return `vượt trần ${AutomationRuntime.SEND_PER_HOUR} tin/giờ của tài khoản này`;
    }
    return '';
  }

  private noteSend(accountKey: string, n: number): void {
    if (n <= 0) return;
    const now = Date.now();
    const list = this.sendLog.get(accountKey) ?? [];
    for (let i = 0; i < n; i++) list.push(now);
    this.sendLog.set(accountKey, list);
  }

  /** Toast + OS notification phát từ một host hệ thống NGOÀI rule engine
   *  (vd: tiến trình tự pull Git). Dùng chung kênh với action `notify` nên
   *  hiển thị y hệt trong AutomationHost. */
  systemNotify(level: NotifyAction['level'], title: string, body: string, source = 'hệ thống'): void {
    this.toast({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      level,
      title,
      body,
      ruleName: source,
      dryRun: false,
      at: Date.now(),
    });
    // Git auto-pull & friends ride the `system` group's setting.
    if (this.osAllowed('system')) this.osNotify(title, body, level !== 'info');
  }

  /** Is this group allowed to interrupt the desktop? Default: none is. */
  private osAllowed(category: EventCategory): boolean {
    return (this.config.osNotify ?? []).includes(category);
  }

  /**
   * OS-level notification — OFF for every group by default.
   *
   * It opens a separate "Electron" window per firing, stacks outside the app
   * and outlives it; during a feedback loop that buried the desktop. The in-app
   * toast carries the same text, sits next to the activity feed that explains
   * it, and disappears with the window. Turn a group back on only for alerts
   * worth interrupting you when DevBox is not in front of you.
   */
  private osNotify(title: string, body: string, sound: boolean): void {
    try {
      if (typeof Notification === 'undefined') return;
      const show = () => new Notification(title, { body, silent: !sound });
      if (Notification.permission === 'granted') show();
      else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => {
        if (p === 'granted') show();
      });
    } catch {
      /* no OS notifications available */
    }
  }

  /** Clear the in-memory activity feed (does not touch log files). */
  clearActivity(): void {
    this.activity = [];
    this.emit();
  }

  /**
   * Evaluate WITHOUT executing or touching the live firing history — the Test
   * console's engine. Uses a throwaway state so a test can never consume a real
   * rule's cooldown.
   */
  dryEvaluate(event: AutomationEvent): EvaluationResult {
    return evaluate(this.config, event, createEngineState());
  }
}

export const automation = new AutomationRuntime();
