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
    this.loading = fetch('/api/automation')
      .then((r) => r.json())
      .then((raw) => normalizeConfig(raw))
      .catch(() => this.config) // offline / route missing → safe defaults
      .then((cfg) => {
        this.config = cfg;
        this.loaded = true;
        this.loading = null;
        this.emit();
        return cfg;
      });
    return this.loading;
  }

  /** Persist a whole config and adopt whatever the server normalized it to. */
  async save(next: AutomationConfig): Promise<AutomationConfig> {
    // Adopt locally first so the UI never feels laggy…
    this.config = normalizeConfig(next);
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

  /** Convenience for toggles: patch a few top-level switches. */
  patch(patch: Partial<AutomationConfig>): Promise<AutomationConfig> {
    return this.save({ ...this.config, ...patch });
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
