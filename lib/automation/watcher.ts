'use client';

// DevBox Automation — the infrastructure WATCH RUNNER.
//
// One timer for every watch would mean N drifting intervals to reconcile on
// every config edit; instead a single 2-second tick asks each watch "are you
// due?". A watch polling every 60s therefore costs one probe a minute, and
// editing a watch takes effect on the next tick without restarting anything.
//
// Per watch it keeps the little state a threshold alert needs:
//
//   breachSince  when the metric first went out of range  → debounce (forSec)
//   firing       an alert is currently open               → recovery detection
//   lastAlertAt  last emitted breach                      → shown in the UI
//
// It does NOT ration alerts. A breaching watch emits on every poll, and the RULE
// decides how often that turns into a notification (RuleLimits.cooldownSec /
// maxPerHour / countBy). Watches measure; rules decide — a watch that also
// throttled would silently cap what a rule is allowed to say.
//
// Emitted events go through automation.submit(), so infra alerts land in the
// SAME rule engine, activity feed and action set as social messages.

import { automation } from './runtime';
import { listConnections, peekAddress } from './connections';
import { MIN_WATCH_INTERVAL_SEC } from './normalize';
import { breaches, infraBreachEvent, infraRecoveredEvent, probeStack, type ProbeResult } from './sources/infra';
import { trace } from './trace';
import type { AutomationConfig, InfraWatch } from './types';

const TICK_MS = 2000;
/** How often the trace says "still running" when nothing else happens. */
const HEARTBEAT_MS = 5 * 60 * 1000;

/** What the UI shows next to each watch. */
export interface WatchSample {
  at: number;
  /** Absent when the metric is not in the probe's map (or the probe failed). */
  value?: number;
  breaching: boolean;
  firing: boolean;
  error?: string;
}

export interface WatcherSnapshot {
  running: boolean;
  samples: Record<string, WatchSample>;
  rev: number;
}

interface WatchState {
  sig: string;
  nextDue: number;
  breachSince: number | null;
  firing: boolean;
  lastAlertAt: number;
  inFlight: boolean;
}

/** Anything here changing means the old breach history is meaningless. */
const signature = (w: InfraWatch): string =>
  [w.stack, w.connectionId, w.metric, w.op, w.threshold].join('|');

const sec = (n: number | undefined, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;

class InfraWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private states = new Map<string, WatchState>();
  private samples: Record<string, WatchSample> = {};
  private listeners = new Set<() => void>();
  private snap: WatcherSnapshot = { running: false, samples: {}, rev: 0 };
  private rev = 0;
  private unsubConfig: (() => void) | null = null;
  private started = false;
  private lastBeat = 0;

  getSnapshot = (): WatcherSnapshot => this.snap;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit(): void {
    this.rev += 1;
    this.snap = { running: this.timer !== null, samples: this.samples, rev: this.rev };
    for (const l of this.listeners) l();
  }

  /**
   * Attach to the config once for the lifetime of the app (the AutomationHost
   * does this). Idempotent — a second call is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubConfig = automation.subscribe(() => this.reconcile());
    void automation.load().then(() => this.reconcile());
  }

  stop(): void {
    this.unsubConfig?.();
    this.unsubConfig = null;
    this.started = false;
    this.halt();
  }

  private halt(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.emit();
  }

  /** Bring the timer + per-watch state in line with the current config. */
  private reconcile(): void {
    const cfg = automation.current;
    const live = this.activeWatches(cfg);

    // Warm the connection cache per active stack so peekAddress() has an
    // address to attach the moment a watch breaches. Fire-and-forget: the
    // first poll may still race this and emit address:'' — acceptable, the
    // alert itself never waits on a registry fetch.
    for (const stack of new Set(live.map((w) => w.stack))) void listConnections(stack);

    // Forget watches that were deleted, disabled, or edited in a way that
    // invalidates their breach history.
    const keep = new Set(live.map((w) => w.id));
    for (const id of [...this.states.keys()]) {
      if (!keep.has(id)) this.states.delete(id);
    }
    for (const w of live) {
      const st = this.states.get(w.id);
      if (!st) {
        this.states.set(w.id, {
          sig: signature(w),
          nextDue: 0, // probe immediately after enabling
          breachSince: null,
          firing: false,
          lastAlertAt: 0,
          inFlight: false,
        });
      } else if (st.sig !== signature(w)) {
        st.sig = signature(w);
        st.breachSince = null;
        st.firing = false;
        st.lastAlertAt = 0;
        st.nextDue = 0;
      }
    }

    if (live.length && !this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.emit();
      void this.tick(); // don't wait a full tick for the first probe
    } else if (!live.length && this.timer) {
      this.halt();
    }
  }

  private activeWatches(cfg: AutomationConfig): InfraWatch[] {
    if (!cfg.enabled || !cfg.watchEnabled) return [];
    return cfg.watches.filter((w) => w.enabled && w.connectionId);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const watches = this.activeWatches(automation.current);
    this.heartbeat(now, watches.length);
    await Promise.all(
      watches.map(async (w) => {
        const st = this.states.get(w.id);
        if (!st || st.inFlight || now < st.nextDue) return;
        st.inFlight = true;
        st.nextDue = now + Math.max(MIN_WATCH_INTERVAL_SEC, w.everySec) * 1000;
        try {
          await this.poll(w, st);
        } finally {
          st.inFlight = false;
        }
      }),
    );
  }

  /**
   * Periodic "still alive" line.
   *
   * Without it, `verbosity: 'changes'` on a healthy system writes nothing at all —
   * which is indistinguishable from the runner having died, the exact confusion
   * this trace exists to remove.
   */
  private heartbeat(now: number, active: number): void {
    const cfg = automation.current.trace;
    if (!cfg.console && !cfg.file) return;
    if (now - this.lastBeat < HEARTBEAT_MS) return;
    this.lastBeat = now;
    trace(cfg, {
      ts: now,
      kind: 'heartbeat',
      watchId: '',
      watch: '(runner)',
      stack: '',
      instance: '',
      note: `đang chạy · ${active} watch đang bật`,
    });
  }

  private async poll(watch: InfraWatch, st: WatchState): Promise<void> {
    const cfg = automation.current.trace;
    const t0 = Date.now();
    const res = await probeStack(watch.stack, watch.connectionId, watch.metric);
    const tookMs = Date.now() - t0;
    const value = res.metrics[watch.metric];
    const has = typeof value === 'number' && Number.isFinite(value);

    const base = {
      watchId: watch.id,
      watch: watch.name,
      stack: watch.stack,
      instance: watch.connectionLabel || watch.connectionId,
      metric: watch.metric,
      op: watch.op,
      threshold: watch.threshold,
      tookMs,
    };

    // A metric the probe could not read is NOT a breach — silence beats a false
    // alarm. `up` is always present, so "mất kết nối" still fires.
    if (!has) {
      const note = res.error ?? `không đọc được chỉ số ${watch.metric}`;
      trace(cfg, { ...base, ts: res.at, kind: 'error', note });
      this.sample(watch.id, { at: res.at, breaching: false, firing: st.firing, error: note });
      return;
    }

    const breaching = breaches(value, watch.op, watch.threshold);
    const now = res.at;

    if (breaching) {
      if (st.breachSince === null) st.breachSince = now;
      const heldSec = (now - st.breachSince) / 1000;
      // A watch reports on EVERY poll while the breach holds — it measures, it
      // does not ration. How often that becomes an actual alert is the rule's
      // call (RuleLimits.cooldownSec / maxPerHour / countBy), so a rule can say
      // "once an hour per watch" without every watch having to agree.
      if (heldSec >= sec(watch.forSec, 0)) {
        st.lastAlertAt = now;
        st.firing = true;
        trace(cfg, { ...base, ts: now, kind: 'breach', value, note: `vượt ngưỡng ${Math.round(heldSec)}s` });
        void automation.submit(
          infraBreachEvent(watch, value, now, { address: peekAddress(watch.stack, watch.connectionId) }),
        );
      } else {
        // Breaching but still inside forSec — worth seeing, because "why did it
        // not alert" is answered right here.
        trace(cfg, {
          ...base,
          ts: now,
          kind: 'ok',
          value,
          note: `vượt ngưỡng nhưng chưa đủ ${sec(watch.forSec, 0)}s (${Math.round(heldSec)}s)`,
        });
      }
    } else if (st.firing) {
      const downSec = Math.round((now - (st.breachSince ?? now)) / 1000);
      st.firing = false;
      st.breachSince = null;
      st.lastAlertAt = 0;
      trace(cfg, { ...base, ts: now, kind: 'recovered', value, note: `bình thường sau ${downSec}s` });
      if (watch.notifyRecovery !== false) {
        void automation.submit(
          infraRecoveredEvent(watch, value, now, downSec, {
            address: peekAddress(watch.stack, watch.connectionId),
          }),
        );
      }
    } else {
      st.breachSince = null;
      trace(cfg, { ...base, ts: now, kind: 'ok', value });
    }

    this.sample(watch.id, { at: now, value, breaching, firing: st.firing, error: res.error });
  }

  private sample(id: string, s: WatchSample): void {
    this.samples = { ...this.samples, [id]: s };
    this.emit();
  }

  /** One-off probe for the editor's "Thử ngay" button — touches no state. */
  probe(watch: Pick<InfraWatch, 'stack' | 'connectionId'>): Promise<ProbeResult> {
    return probeStack(watch.stack, watch.connectionId);
  }
}

export const watcher = new InfraWatcher();
