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
//                                     ├─ notify        → here (toast + OS)
//                                     ├─ webhook / log → POST /api/automation/dispatch
//                                     ├─ kafka         → /api/kafka produce
//                                     └─ reply         → held for approval
//
// Subscribe with useSyncExternalStore (see useAutomation()).

import { produceKafkaMessage } from '@/lib/kafka';
import { createEngineState, evaluate, isDuplicateEvent, type EngineState } from './engine';
import { normalizeConfig } from './normalize';
import {
  DEFAULT_AUTOMATION_CONFIG,
  type ActionOutcome,
  type ActionPlan,
  type ActivityEntry,
  type AutomationConfig,
  type AutomationEvent,
  type EvaluationResult,
  type NotifyAction,
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
      .then((cfg) => {
        this.config = cfg;
        this.loaded = true;
        this.loading = null;
        this.emit();
        return cfg;
      });
    return this.loading;
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

      const result = evaluate(this.config, event, this.state);
      const outcomes = await this.execute(result);
      this.record({ event: this.forStorage(event), decisions: result.decisions, outcomes });
      return result;
    } catch {
      return null;
    }
  }

  /** Strip message text from what we KEEP when the user asked us not to store it. */
  private forStorage(event: AutomationEvent): AutomationEvent {
    if (this.config.storeMessageText || event.category !== 'social') return event;
    return { ...event, text: event.text ? '••••' : '', fields: { ...event.fields, text: '' } };
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
    for (const p of plans) {
      if (p.action.type === 'webhook' || p.action.type === 'log') server.push(p);
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
    if (plan.dryRun && action.type !== 'notify') return { ...base, status: 'dry-run' };

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
        if (!plan.dryRun) this.osNotify(title, body, action);
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

  private osNotify(title: string, body: string, action: NotifyAction): void {
    try {
      if (typeof Notification === 'undefined') return;
      const show = () => new Notification(title, { body, silent: !action.sound });
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
