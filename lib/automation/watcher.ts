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
import { newId } from './engine';
import { listConnections, peekAddress } from './connections';
import { MIN_WATCH_INTERVAL_SEC } from './normalize';
import { breaches, groupActive, infraBreachEvent, infraRecoveredEvent, probeStack, type BreachingConsumer, type BreachingHost, type KafkaGroupDetail, type ProbeResult } from './sources/infra';
import { trace } from './trace';
import type { AutomationConfig, InfraWatch } from './types';

const TICK_MS = 2000;
/** How often the trace says "still running" when nothing else happens. */
const HEARTBEAT_MS = 5 * 60 * 1000;
/**
 * Trạng thái vượt-ngưỡng cũ hơn mức này thì không dùng để che watch khác nữa.
 *
 * Watch trong cùng nhóm có thể có `everySec` khác nhau, nên số liệu "hơi cũ"
 * là bình thường và vẫn phải tin. Nhưng một watch đã ngừng đo hẳn (bị tắt, lỗi
 * mạng kéo dài) mà vẫn giữ quyền che thì cả nhóm im lặng theo nó — hỏng nặng
 * hơn nhiều so với việc báo trùng một nhịp. 15 phút đủ rộng cho watch chậm
 * nhất mà vẫn đủ chặt để không im quá lâu.
 */
const STALE_MS = 15 * 60 * 1000;

/** Ký hiệu toán tử cho câu trace "bị X (ngưỡng > 90) che". */
const OP_SIGN: Record<InfraWatch['op'], string> = {
  gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠',
};

/** What the UI shows next to each watch. */
export interface WatchSample {
  at: number;
  /** Absent when the metric is not in the probe's map (or the probe failed). */
  value?: number;
  breaching: boolean;
  firing: boolean;
  error?: string;
  /** Tên watch NẶNG HƠN cùng nhóm đang che watch này (nếu có) — UI hiện 🔇 kèm
   *  lý do, để "sao cái này không kêu" nhìn phát là biết. */
  suppressedBy?: string;
}

export interface WatcherSnapshot {
  running: boolean;
  /**
   * false = cửa sổ khác đang giữ lease runner (xem /api/automation/runner) —
   * watcher này ở chế độ CHỜ: không poll, không phát cảnh báo, và tự tiếp quản
   * trong vài giây khi leader tắt. Mỗi cửa sổ một watcher nhưng cả app chỉ một
   * runner thật — hai runner song song là hai bộ cooldown riêng, tin cảnh báo
   * sẽ xen kẽ nhau dưới mọi giới hạn đã cấu hình.
   */
  leader: boolean;
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
  /**
   * Watch này có đang vượt ngưỡng ĐỦ LÂU (qua forSec) tính tới lần đo gần nhất
   * không — tức là "đủ tư cách phát cảnh báo".
   *
   * Cần lưu lại vì các watch trong cùng một nhóm bậc ngưỡng có thể có everySec
   * khác nhau, nên không phải lúc nào chúng cũng đo trong cùng một tick. Muốn
   * biết "có ai nặng hơn đang kêu không" thì phải nhìn trạng thái GẦN NHẤT của
   * chúng, chứ không chỉ nhìn những cái vừa đo xong.
   */
  eligible: boolean;
  /** Lần cuối cập nhật `eligible` — số liệu quá cũ thì không tin nữa. */
  eligibleAt: number;
  /** Đang bị một watch nặng hơn cùng nhóm che (để UI hiện lý do). */
  suppressedBy: string | null;
}

/** Anything here changing means the old breach history is meaningless. */
const signature = (w: InfraWatch): string =>
  [w.stack, w.connectionId, w.metric, w.op, w.threshold].join('|');

// ── Chống trùng theo BẬC NGƯỠNG (threshold laddering) ──────────────────────
//
// VẤN ĐỀ: đặt hai watch trên cùng một thứ để phân mức nặng nhẹ là chuyện bình
// thường — "disk mongo1 > 90%" (critical) và "disk mongo1 > 80%" (high). Nhưng
// khi disk = 95% thì CẢ HAI cùng vượt ngưỡng, và mỗi watch tự phát một sự kiện
// → hai cảnh báo cho đúng một sự việc. Rule không cứu được: lúc nó nhìn thấy
// sự kiện thì hai cái đã là hai event riêng biệt, và `countBy` chỉ đếm thưa đi
// chứ không biết cái nào đáng giữ.
//
// GIẢI PHÁP: watcher là chỗ DUY NHẤT nhìn thấy đồng thời mọi watch cùng giá trị
// vừa đo được, nên việc chọn "cái nào đại diện" phải nằm ở đây.
//
//   1. Gom watch thành nhóm theo (connection + metric + CHIỀU so sánh).
//      Cùng máy, cùng chỉ số, cùng chiều = đang đo cùng một thứ ở các mức khác
//      nhau. Khác metric (disk vs CPU) hay khác máy → nhóm khác, không đụng nhau.
//   2. Trong một nhóm, xếp hạng theo mức NGHIÊM NGẶT của ngưỡng, không phải
//      theo severity người dùng gõ: với chiều tăng (gt/gte) thì ngưỡng CAO hơn
//      là chặt hơn; chiều giảm (lt/lte) thì ngưỡng THẤP hơn là chặt hơn.
//      Dựa vào con số nên không phụ thuộc việc khai severity có nhất quán không.
//   3. Mỗi vòng poll, trong các watch đang thực sự vượt ngưỡng của cùng nhóm,
//      CHỈ cái chặt nhất được phát. Các cái nhẹ hơn bị chặn (ghi trace 🔇).
//
// HẠ CẤP: disk tụt 95% → 85% thì A (>90) hết vượt, B (>80) vẫn vượt và giờ là
// cái chặt nhất còn khớp → B được phát. Đúng thực tế: vẫn còn vấn đề, nhẹ bớt.
//
// `eq`/`neq` KHÔNG xếp bậc được (không có "chặt hơn" giữa hai giá trị bằng
// nhau), nên mỗi watch loại đó đứng riêng một nhóm và không bao giờ bị chặn.

/** Watch cùng nhóm = đang đo cùng một thứ, chỉ khác mức. */
function ladderKey(w: InfraWatch): string | null {
  const dir = w.op === 'gt' || w.op === 'gte' ? 'up' : w.op === 'lt' || w.op === 'lte' ? 'down' : null;
  if (!dir) return null; // eq/neq: không có bậc để so
  return `${w.stack}|${w.connectionId}|${w.metric}|${dir}`;
}

/**
 * Ngưỡng này có CHẶT HƠN ngưỡng kia không (trong cùng một nhóm)?
 *
 * Chiều tăng: 90 chặt hơn 80. Chiều giảm: 10 chặt hơn 20. Bằng nhau thì không
 * cái nào chặt hơn — lúc đó dùng severity rồi tới id để chốt một cái duy nhất,
 * cốt sao KẾT QUẢ ỔN ĐỊNH giữa các vòng poll (không nhấp nháy đổi bên).
 */
const SEVERITY_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };

function stricter(a: InfraWatch, b: InfraWatch): boolean {
  const up = a.op === 'gt' || a.op === 'gte';
  if (a.threshold !== b.threshold) {
    return up ? a.threshold > b.threshold : a.threshold < b.threshold;
  }
  const sa = SEVERITY_RANK[a.severity ?? 'warning'] ?? 2;
  const sb = SEVERITY_RANK[b.severity ?? 'warning'] ?? 2;
  if (sa !== sb) return sa > sb;
  return a.id < b.id; // hoà tuyệt đối — chốt theo id cho ổn định
}

const sec = (n: number | undefined, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;

/** Chỉ số Kafka cảnh báo THEO GROUP → cần liệt kê đích danh group nào. */
const KAFKA_GROUP_ALERT_METRICS = new Set([
  'maxConsumerLag',
  'totalConsumerLag',
  'stalledGroups',
  'maxStalledSec',
  'deadLagGroups',
  'emptyGroups',
  'rebalancingGroups',
  'lagGroupsUnknown',
  'undescribedGroups',
]);

/** Chỉ số Kafka cảnh báo THEO TOPIC → cần liệt kê topic bị ảnh hưởng. */
const KAFKA_TOPIC_ALERT_METRICS = new Set(['underReplicated', 'offline']);

const isStalled = (g: { lag: number; stalledSec: number | null }): boolean =>
  g.lag > 0 && g.stalledSec !== null;
const isRebalancing = (state: string): boolean => /rebalanc|preparing/i.test(state);

/**
 * Chọn các consumer group LIÊN QUAN tới cảnh báo, tuỳ chỉ số — đích danh cái
 * nào, KHÔNG phải cái nặng nhất. Trả về danh sách để metadata + tin nhắn nêu tên:
 *
 *   maxConsumerLag        → group có lag {op} ngưỡng
 *   totalConsumerLag      → mọi group còn lag (đóng góp vào tổng)
 *   stalledGroups         → group đang đứng im
 *   maxStalledSec         → group đứng im đủ {op} ngưỡng giây
 *   deadLagGroups         → group có lag nhưng KHÔNG consumer (AKHQ vàng)
 *   emptyGroups           → group mất consumer (0 member mà có commit)
 *   rebalancingGroups     → group đang rebalance
 *   lag/undescribed       → group không đọc được lag / describe
 *
 * Mỗi group kèm nhãn hoạt động (active/state/members) để cảnh báo phân biệt
 * 🟢 còn tiêu thụ / 🟡 không consumer — trả lời "consumer nào không tiêu thụ".
 */
function offendingConsumers(watch: InfraWatch, res: ProbeResult): BreachingConsumer[] | undefined {
  if (watch.stack !== 'kafka' || !KAFKA_GROUP_ALERT_METRICS.has(watch.metric)) return undefined;
  const groups = res.kafkaGroups;
  if (!groups?.length) return undefined;

  const withTopic = (g: KafkaGroupDetail) => (g.worstTopic ? { topic: g.worstTopic, topicLag: g.worstTopicLag } : {});
  // Nhãn AKHQ vàng/xanh: active=true (🟢) hoặc kèm state khi không active (🟡).
  const act = (g: KafkaGroupDetail) => {
    const active = groupActive(g.state, g.members);
    return { active, members: g.members, ...(active ? {} : { state: g.state }) };
  };
  const lagItem = (g: KafkaGroupDetail): BreachingConsumer => ({ group: g.groupId, lag: g.lag, ...withTopic(g), ...act(g) });
  const stalledItem = (g: KafkaGroupDetail): BreachingConsumer => ({ group: g.groupId, lag: g.lag, stalledSec: g.stalledSec ?? 0, ...withTopic(g), ...act(g) });

  switch (watch.metric) {
    case 'maxConsumerLag':
      return groups
        .filter((g) => !g.error && breaches(g.lag, watch.op, watch.threshold))
        .sort((a, b) => b.lag - a.lag)
        .map(lagItem);
    case 'totalConsumerLag':
      return groups.filter((g) => !g.error && g.lag > 0).sort((a, b) => b.lag - a.lag).map(lagItem);
    case 'stalledGroups':
      return groups
        .filter((g) => !g.error && isStalled(g))
        .sort((a, b) => (b.stalledSec ?? 0) - (a.stalledSec ?? 0))
        .map(stalledItem);
    case 'maxStalledSec':
      return groups
        .filter((g) => !g.error && isStalled(g) && breaches(g.stalledSec ?? 0, watch.op, watch.threshold))
        .sort((a, b) => (b.stalledSec ?? 0) - (a.stalledSec ?? 0))
        .map(stalledItem);
    case 'deadLagGroups':
      return groups
        .filter((g) => !g.error && g.described && g.members === 0 && g.lag > 0)
        .sort((a, b) => b.lag - a.lag)
        .map((g) => ({ group: g.groupId, lag: g.lag, ...withTopic(g), active: false, members: 0, state: g.state }));
    case 'emptyGroups':
      return groups
        .filter((g) => !g.error && g.described && g.members === 0 && g.partitions > 0)
        .map((g) => ({ group: g.groupId, lag: g.lag, ...withTopic(g), active: false, members: 0, state: g.state }));
    case 'rebalancingGroups':
      return groups
        .filter((g) => !g.error && g.described && isRebalancing(g.state))
        .map((g) => ({ group: g.groupId, lag: g.lag, active: false, members: g.members, state: g.state }));
    case 'lagGroupsUnknown':
      return groups.filter((g) => g.error).map((g) => ({ group: g.groupId, lag: 0, state: 'lag không đọc được' }));
    case 'undescribedGroups':
      return groups.filter((g) => !g.described).map((g) => ({ group: g.groupId, lag: g.lag, state: 'không describe được' }));
    default:
      return undefined;
  }
}

/** Topic bị ảnh hưởng cho cảnh báo theo topic (under-replicated/offline). */
function offendingTopics(watch: InfraWatch, res: ProbeResult): string[] | undefined {
  if (watch.stack !== 'kafka' || !KAFKA_TOPIC_ALERT_METRICS.has(watch.metric)) return undefined;
  return res.affectedTopics?.length ? res.affectedTopics : undefined;
}

/** Chỉ số Kafka cảnh báo THEO HOST broker → cần liệt kê đích danh máy nào. */
const KAFKA_HOST_ALERT_METRICS = new Set([
  'hostDiskUsedPct',
  'hostDiskFreeGb',
  'hostMemUsedPct',
  'hostCpuPct',
  'hostLoad1PerCore',
  'hostsDown',
]);

/**
 * Chọn các HOST broker liên quan tới cảnh báo, tuỳ chỉ số. Cùng nguyên tắc với
 * offendingConsumers: nêu MỌI máy thoả điều kiện, không chỉ máy tệ nhất — "đĩa
 * 92%" mà không biết máy nào thì người trực vẫn phải đi dò từng broker.
 *
 * Chỉ đính field có nghĩa với chỉ số đang báo, để tin nhắn không lẫn số liệu
 * không liên quan (cảnh báo đĩa thì không cần biết CPU bao nhiêu).
 */
function offendingHosts(watch: InfraWatch, res: ProbeResult): BreachingHost[] | undefined {
  if (watch.stack !== 'kafka' || !KAFKA_HOST_ALERT_METRICS.has(watch.metric)) return undefined;
  const hosts = res.kafkaHosts;
  if (!hosts?.length) return undefined;

  // Mất số liệu là ca riêng: máy không trả lời thì không có con số nào để so.
  if (watch.metric === 'hostsDown') {
    const down = hosts.filter((h) => !h.reachable);
    return down.length
      ? down.map((h) => ({ host: h.host, unreachable: true, error: h.error }))
      : undefined;
  }

  const live = hosts.filter((h) => h.reachable);
  // Đĩa: kèm cả % lẫn GB còn trống lẫn mount, bất kể watch dùng chỉ số nào
  // trong hai — người đọc cần cả ba để quyết định có phải đi dọn ngay không.
  const diskItem = (h: (typeof live)[number]): BreachingHost => ({
    host: h.host,
    ...(h.diskUsedPct !== null ? { diskUsedPct: h.diskUsedPct } : {}),
    ...(h.diskFreeGb !== null ? { diskFreeGb: h.diskFreeGb } : {}),
    ...(h.worstMount ? { mount: h.worstMount } : {}),
  });

  switch (watch.metric) {
    case 'hostDiskUsedPct':
      return pick(live.filter((h) => h.diskUsedPct !== null && breaches(h.diskUsedPct, watch.op, watch.threshold))
        .sort((a, b) => (b.diskUsedPct ?? 0) - (a.diskUsedPct ?? 0))
        .map(diskItem));
    case 'hostDiskFreeGb':
      return pick(live.filter((h) => h.diskFreeGb !== null && breaches(h.diskFreeGb, watch.op, watch.threshold))
        .sort((a, b) => (a.diskFreeGb ?? 0) - (b.diskFreeGb ?? 0))
        .map(diskItem));
    case 'hostMemUsedPct':
      return pick(live.filter((h) => h.memUsedPct !== null && breaches(h.memUsedPct, watch.op, watch.threshold))
        .sort((a, b) => (b.memUsedPct ?? 0) - (a.memUsedPct ?? 0))
        .map((h) => ({ host: h.host, memUsedPct: h.memUsedPct ?? undefined })));
    case 'hostCpuPct':
      return pick(live.filter((h) => h.cpuPct !== null && breaches(h.cpuPct, watch.op, watch.threshold))
        .sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0))
        .map((h) => ({ host: h.host, cpuPct: h.cpuPct ?? undefined })));
    case 'hostLoad1PerCore':
      return pick(live.filter((h) => h.load1PerCore !== null && breaches(h.load1PerCore, watch.op, watch.threshold))
        .sort((a, b) => (b.load1PerCore ?? 0) - (a.load1PerCore ?? 0))
        .map((h) => ({ host: h.host, load1PerCore: h.load1PerCore ?? undefined })));
    default:
      return undefined;
  }
}

/** Danh sách rỗng → undefined, để fields host vắng mặt thay vì hiện dòng trống. */
const pick = (xs: BreachingHost[]): BreachingHost[] | undefined => (xs.length ? xs : undefined);

class InfraWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private states = new Map<string, WatchState>();
  private samples: Record<string, WatchSample> = {};
  private listeners = new Set<() => void>();
  private snap: WatcherSnapshot = { running: false, leader: false, samples: {}, rev: 0 };
  private rev = 0;
  private unsubConfig: (() => void) | null = null;
  private started = false;
  private lastBeat = 0;
  /** Danh tính của watcher NÀY trong cuộc đua lease — mỗi cửa sổ một id. */
  private holderId = newId('run');
  private leader = false;

  getSnapshot = (): WatcherSnapshot => this.snap;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit(): void {
    this.rev += 1;
    this.snap = { running: this.timer !== null, leader: this.leader, samples: this.samples, rev: this.rev };
    for (const l of this.listeners) l();
  }

  /**
   * Xin/giữ lease runner. Lỗi mạng/route thì GIỮ NGUYÊN vai trò hiện tại: đang
   * là leader mà demote vì một request rớt là tắt giám sát oan; đang standby mà
   * tự phong leader là tái diễn đúng cái lỗi hai-runner mà lease sinh ra để chặn.
   */
  private async renewLease(): Promise<void> {
    try {
      const r = await fetch('/api/automation/runner', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ holderId: this.holderId }),
      });
      const lead = !!((await r.json()) as { leader?: boolean }).leader;
      if (lead !== this.leader) {
        this.leader = lead;
        this.emit();
      }
    } catch {
      /* giữ vai trò cũ — xem docstring */
    }
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
          eligible: false,
          eligibleAt: 0,
          suppressedBy: null,
        });
      } else if (st.sig !== signature(w)) {
        st.sig = signature(w);
        st.breachSince = null;
        st.firing = false;
        st.lastAlertAt = 0;
        st.nextDue = 0;
        st.eligible = false;
        st.eligibleAt = 0;
        st.suppressedBy = null;
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
    // Lease trước, poll sau: chỉ MỘT cửa sổ được đo và phát cảnh báo. Cửa sổ
    // standby vẫn tick 2s để tiếp quản trong ~TTL khi leader đóng.
    await this.renewLease();
    if (!this.leader) return;

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
    const res = await probeStack(watch.stack, watch.connectionId, watch.metric, { groupFilter: watch.groupFilter });
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
      // Không đọc được thì cũng KHÔNG còn tư cách che watch khác: giữ nguyên
      // `eligible` cũ là để một watch đã chết tiếp tục bịt miệng cả nhóm.
      st.eligible = false;
      st.eligibleAt = res.at;
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
        // Đủ điều kiện phát — ghi lại TRƯỚC khi hỏi bậc ngưỡng, vì chính trạng
        // thái này là thứ các watch cùng nhóm nhìn vào để biết ai đang kêu.
        st.eligible = true;
        st.eligibleAt = now;

        const covering = this.strongerFiring(watch, now);
        if (covering) {
          // Có watch NẶNG HƠN cùng nhóm đang kêu → cái này im, khỏi trùng.
          // Vẫn coi là `firing` để khi nó hết vượt ngưỡng thì logic hồi phục
          // bên dưới chạy đúng (dọn state), chỉ là không phát sự kiện nào.
          st.firing = true;
          st.suppressedBy = covering.name;
          trace(cfg, {
            ...base, ts: now, kind: 'suppressed', value,
            note: `bị "${covering.name}" (ngưỡng ${OP_SIGN[covering.op]} ${covering.threshold}) che — không phát để khỏi trùng`,
          });
        } else {
          st.suppressedBy = null;
          st.lastAlertAt = now;
          st.firing = true;
          trace(cfg, { ...base, ts: now, kind: 'breach', value, note: `vượt ngưỡng ${Math.round(heldSec)}s` });
          void automation.submit(
            infraBreachEvent(watch, value, now, {
              address: peekAddress(watch.stack, watch.connectionId),
              // Cả MetricMap của CHÍNH lần đo này — cho fields tuyệt đối (absUsed…).
              metrics: res.metrics,
              // "Vì sao là bậc này" — rỗng khi watch vốn đã là bậc cao nhất.
              ladderAbove: this.quieterAbove(watch),
              // Kafka: đích danh group liên quan (lag/đứng im/mất member…) và
              // topic bị ảnh hưởng (under-replicated/offline) — tuỳ chỉ số.
              breachingConsumers: offendingConsumers(watch, res),
              affectedTopics: offendingTopics(watch, res),
              // Kafka: đích danh HOST broker liên quan (đĩa/RAM/CPU/mất exporter).
              breachingHosts: offendingHosts(watch, res),
            }),
          );
        }
      } else {
        st.eligible = false;
        st.eligibleAt = now;
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
      // Watch này có TỪNG phát cảnh báo thật không? Cái bị che suốt thời gian
      // vượt ngưỡng thì chưa hề gửi tin nào — báo "đã hồi phục" cho một cảnh
      // báo chưa từng tồn tại là gây hoang mang, nên chỉ dọn state rồi thôi.
      const everAlerted = st.lastAlertAt > 0;
      st.firing = false;
      st.breachSince = null;
      st.lastAlertAt = 0;
      st.eligible = false;
      st.eligibleAt = now;
      st.suppressedBy = null;
      if (!everAlerted) {
        trace(cfg, { ...base, ts: now, kind: 'ok', value, note: 'hết vượt ngưỡng (chưa từng phát vì bị che)' });
      } else {
        trace(cfg, { ...base, ts: now, kind: 'recovered', value, note: `bình thường sau ${downSec}s` });
        if (watch.notifyRecovery !== false) {
          void automation.submit(
            infraRecoveredEvent(watch, value, now, downSec, {
              address: peekAddress(watch.stack, watch.connectionId),
              metrics: res.metrics,
            }),
          );
        }
      }
    } else {
      st.breachSince = null;
      st.eligible = false;
      st.eligibleAt = now;
      st.suppressedBy = null;
      trace(cfg, { ...base, ts: now, kind: 'ok', value });
    }

    this.sample(watch.id, {
      at: now, value, breaching, firing: st.firing, error: res.error,
      suppressedBy: st.suppressedBy ?? undefined,
    });
  }

  /**
   * Trong cùng nhóm bậc ngưỡng, có watch nào NẶNG HƠN đang vượt ngưỡng không?
   *
   * Trả về watch đó (để ghi trace/hiện UI), hoặc null nếu watch đang xét chính
   * là cái chặt nhất còn khớp — khi đó nó được phát.
   *
   * Chỉ tin trạng thái còn MỚI: một watch poll 5 phút/lần mà ta đang xét lúc
   * phút thứ 4 thì số liệu của nó vẫn dùng được, nhưng nếu nó ngừng đo hẳn
   * (bị tắt, lỗi mạng kéo dài) thì sau STALE_MS coi như không còn che ai —
   * thà báo trùng một nhịp còn hơn im lặng vì một watch đã chết.
   */
  private strongerFiring(watch: InfraWatch, now: number): InfraWatch | null {
    const key = ladderKey(watch);
    if (!key) return null; // eq/neq — không xếp bậc, không bao giờ bị che

    const cfg = automation.current;
    if (cfg.dedupeLadder === false) return null; // người dùng tắt tính năng

    for (const other of this.activeWatches(cfg)) {
      if (other.id === watch.id) continue;
      if (ladderKey(other) !== key) continue;
      if (!stricter(other, watch)) continue;
      const os = this.states.get(other.id);
      if (!os?.eligible) continue;
      if (now - os.eligibleAt > STALE_MS) continue;
      return other;
    }
    return null;
  }

  /**
   * Các bậc NẶNG HƠN cùng nhóm mà lúc này KHÔNG vượt ngưỡng.
   *
   * Đi kèm cảnh báo để trả lời câu hỏi "sao lại là mức này": khi bậc trên vừa
   * được nâng lên khỏi giá trị hiện tại, nó thôi vượt và bậc dưới lộ ra phát
   * thay — nhìn từ tin nhắn thì rất giống "sửa ngưỡng mà cảnh báo không đổi".
   *
   * Ngược hướng với strongerFiring(): ở đó là "có ai nặng hơn ĐANG kêu không"
   * (để im), ở đây là "ai nặng hơn đang YÊN" (để giải thích). Chỉ gọi khi watch
   * thực sự sắp phát, nên không tốn gì cho vòng poll bình thường.
   */
  private quieterAbove(watch: InfraWatch): { name: string; op: InfraWatch['op']; threshold: number }[] {
    const key = ladderKey(watch);
    if (!key) return [];
    const cfg = automation.current;
    if (cfg.dedupeLadder === false) return []; // không xếp bậc thì không có gì để giải thích

    const out: { name: string; op: InfraWatch['op']; threshold: number }[] = [];
    for (const other of this.activeWatches(cfg)) {
      if (other.id === watch.id) continue;
      if (ladderKey(other) !== key) continue;
      if (!stricter(other, watch)) continue;
      // Chỉ kể cái đã ĐO và đang bình thường. Watch chưa từng đo xong (mới bật,
      // đang lỗi mạng) thì ta không biết nó thế nào — nói bừa "đang bình thường"
      // còn tệ hơn im, vì nó ngụ ý một điều chưa hề được kiểm chứng.
      const s = this.samples[other.id];
      if (!s || s.error || typeof s.value !== 'number' || s.breaching) continue;
      out.push({ name: other.name, op: other.op, threshold: other.threshold });
    }
    return out;
  }

  private sample(id: string, s: WatchSample): void {
    this.samples = { ...this.samples, [id]: s };
    this.emit();
  }

  /** One-off probe for the editor's "Thử ngay" button — touches no state.
   *  Áp cả groupFilter để "Thử ngay" hiện đúng giá trị đã giới hạn theo group. */
  probe(watch: Pick<InfraWatch, 'stack' | 'connectionId' | 'groupFilter'>): Promise<ProbeResult> {
    return probeStack(watch.stack, watch.connectionId, undefined, { groupFilter: watch.groupFilter });
  }
}

export const watcher = new InfraWatcher();
