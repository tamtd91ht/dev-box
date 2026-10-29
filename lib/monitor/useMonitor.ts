'use client';

// DevBox Monitor — vòng đo định kỳ toàn bộ kết nối hạ tầng.
//
// Không có backend riêng: mỗi tài nguyên được đo bằng `probeStack()` của
// Automation (cùng API /api/redis, /api/kafka… mà các tab công cụ đang dùng).
// Hook này lo ba việc:
//   1. Gom kết nối của 6 stack thành một danh sách tài nguyên phẳng.
//   2. Đo lần lượt với độ song song GIỚI HẠN (renderer chỉ có 6 socket tới mỗi
//      host — xem lib/apiFetch; đo đồng loạt 40 kết nối sẽ làm đói mọi tab khác).
//   3. Giữ lịch sử ngắn từng tài nguyên (sparkline + dải trạng thái theo thời gian).
//
// Kafka là stack đắt nhất (quét lag từng group + node_exporter từng broker), nên
// vòng thường chỉ hỏi cụm còn lag/host được đo "sâu" thưa hơn và giữ lại giữa
// các vòng — xem DEEP_EVERY.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { listConnections, refreshConnections, sanitizeAddress, type ConnOption } from '@/lib/automation/connections';
import { probeStack, KAFKA_HOST_METRICS, KAFKA_LAG_METRICS, type MetricMap, type ProbeResult } from '@/lib/automation/sources/infra';
import type { InfraStack } from '@/lib/automation/types';
import { STACK_ORDER, evaluate, countLevels, type Counts, type Evaluation, type Level, type Overrides } from './status';

export interface Resource {
  /** `${stack}:${connectionId}` — khoá ổn định xuyên các vòng đo. */
  key: string;
  stack: InfraStack;
  id: string;
  name: string;
  project: string;
  address: string;
}

export interface Sample {
  at: number;
  level: Level;
  metrics: MetricMap;
}

export interface ResState {
  last?: ProbeResult;
  samples: Sample[];
  busy: boolean;
  /** Mức hiện tại bắt đầu từ lúc nào (epoch ms) — "mất kết nối từ 10 phút trước". */
  since?: number;
}

export interface Row {
  res: Resource;
  st: ResState;
  ev: Evaluation;
}

const MAX_SAMPLES = 90;
/** Số probe chạy song song — thấp có chủ đích, xem ghi chú đầu file. */
const CONCURRENCY = 3;
/** Cứ N vòng đo Kafka sâu (lag + host) một lần; các vòng giữa giữ số liệu cũ. */
const DEEP_EVERY = 5;
/** Tab ẩn: vẫn đo (cảnh báo critical ở footer + chấm đỏ trên menu) nhưng thưa hơn — đủ gần để không báo trễ. */
const HIDDEN_MIN_SEC = 60;

const KAFKA_HEAVY = new Set<string>([...KAFKA_LAG_METRICS, ...KAFKA_HOST_METRICS]);

const rkey = (stack: InfraStack, id: string): string => `${stack}:${id}`;

function toResource(stack: InfraStack, c: ConnOption): Resource {
  return {
    key: rkey(stack, c.id),
    stack,
    id: c.id,
    name: c.name,
    project: c.project || 'default',
    address: sanitizeAddress(c.address),
  };
}

/** Vòng đo Kafka nhẹ không có lag/host: mượn lại từ lần đo sâu gần nhất. */
function carryHeavy(next: ProbeResult, prev: ProbeResult | undefined): ProbeResult {
  if (!prev || prev.error || next.error) return next;
  const metrics: MetricMap = { ...next.metrics };
  for (const k of Object.keys(prev.metrics)) {
    if (KAFKA_HEAVY.has(k) && metrics[k] === undefined) metrics[k] = prev.metrics[k];
  }
  return { ...next, metrics, kafkaGroups: next.kafkaGroups ?? prev.kafkaGroups, kafkaHosts: next.kafkaHosts ?? prev.kafkaHosts };
}

export interface UseMonitor {
  rows: Row[];
  counts: Counts;
  /** Đã có ít nhất một danh sách kết nối (phân biệt "đang tải" với "chưa cấu hình gì"). */
  loaded: boolean;
  roundBusy: boolean;
  lastRoundAt: number | null;
  refreshAll: () => void;
  /** Đo lại một tài nguyên, sâu (Kafka: kèm lag/host). */
  refreshOne: (key: string) => void;
}

export function useMonitor(opts: {
  visible: boolean;
  intervalSec: number;
  paused: boolean;
  overrides: Overrides;
}): UseMonitor {
  const { visible, intervalSec, paused, overrides } = opts;

  const [resources, setResources] = useState<Resource[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [roundBusy, setRoundBusy] = useState(false);
  const [lastRoundAt, setLastRoundAt] = useState<number | null>(null);
  const [ver, bump] = useReducer((n: number) => n + 1, 0);

  const states = useRef<Record<string, ResState>>({});
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const running = useRef(false);
  const roundNo = useRef(0);
  const lastRoundRef = useRef(0);
  const alive = useRef(true);
  // Phải đặt lại true khi mount: StrictMode (dev) chạy mount → cleanup → mount, nếu
  // chỉ có cleanup thì alive kẹt false mãi → không bao giờ setLoaded, treo "Đang tải…".
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const patch = useCallback((key: string, fn: (s: ResState) => ResState) => {
    const cur = states.current[key] ?? { samples: [], busy: false };
    states.current[key] = fn(cur);
    if (alive.current) bump();
  }, []);

  const probeOne = useCallback(async (r: Resource, deep: boolean): Promise<void> => {
    patch(r.key, (s) => ({ ...s, busy: true }));
    const prev = states.current[r.key]?.last;
    // Kafka nhẹ: hỏi 'brokers' (chỉ clusterHealth) để KHÔNG kích hoạt quét lag/host.
    const light = r.stack === 'kafka' && !deep && !!prev && !prev.error;
    let res = await probeStack(r.stack, r.id, light ? 'brokers' : undefined);
    if (light) res = carryHeavy(res, prev);
    const ev = evaluate(r.stack, res, overridesRef.current);
    patch(r.key, (s) => {
      const lastLevel = s.samples[s.samples.length - 1]?.level;
      const samples = [...s.samples, { at: res.at, level: ev.level, metrics: res.metrics }].slice(-MAX_SAMPLES);
      return {
        last: res,
        samples,
        busy: false,
        since: lastLevel === ev.level && s.since ? s.since : res.at,
      };
    });
  }, [patch]);

  const runRound = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setRoundBusy(true);
    try {
      refreshConnections(); // kết nối mới thêm ở tab khác phải hiện mà không cần khởi động lại
      const lists = await Promise.all(STACK_ORDER.map((s) => listConnections(s)));
      const list = STACK_ORDER.flatMap((s, i) => lists[i].map((c) => toResource(s, c)));
      if (!alive.current) return;
      // Dọn trạng thái của kết nối đã bị xoá.
      const keep = new Set(list.map((r) => r.key));
      for (const k of Object.keys(states.current)) if (!keep.has(k)) delete states.current[k];
      setResources(list);
      setLoaded(true);

      roundNo.current += 1;
      const deepRound = roundNo.current % DEEP_EVERY === 1;
      const queue = [...list];
      const worker = async (): Promise<void> => {
        for (let r = queue.shift(); r && alive.current; r = queue.shift()) {
          try { await probeOne(r, deepRound); } catch { /* probeStack không ném; chặn thêm một lớp */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
      lastRoundRef.current = Date.now();
      if (alive.current) setLastRoundAt(lastRoundRef.current);
    } finally {
      running.current = false;
      if (alive.current) setRoundBusy(false);
    }
  }, [probeOne]);

  // Lịch đo. Đổi chu kỳ / ẩn-hiện tab chỉ dời mốc, không đo dồn.
  useEffect(() => {
    if (paused) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = false;
    const period = (visible ? intervalSec : Math.max(intervalSec, HIDDEN_MIN_SEC)) * 1000;
    const loop = async (): Promise<void> => {
      if (stop) return;
      await runRound();
      if (stop) return;
      timer = setTimeout(loop, period);
    };
    const wait = Math.max(0, lastRoundRef.current + period - Date.now());
    timer = setTimeout(loop, lastRoundRef.current ? wait : 0);
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [paused, visible, intervalSec, runRound]);

  // Đang tạm dừng thì vòng đo không chạy → danh sách kết nối cũng không bao giờ được
  // nạp, màn hình kẹt ở "Đang tải danh sách kết nối…". Nạp danh sách (không đo) một lần.
  useEffect(() => {
    if (!paused || loaded) return;
    void Promise.all(STACK_ORDER.map((s) => listConnections(s))).then((lists) => {
      if (!alive.current || running.current) return;
      setResources(STACK_ORDER.flatMap((s, i) => lists[i].map((c) => toResource(s, c))));
      setLoaded(true);
    });
  }, [paused, loaded]);

  const refreshAll = useCallback(() => { roundNo.current = 0; void runRound(); }, [runRound]);

  const resRef = useRef<Resource[]>([]);
  resRef.current = resources;
  const refreshOne = useCallback((key: string) => {
    const r = resRef.current.find((x) => x.key === key);
    if (r) void probeOne(r, true);
  }, [probeOne]);

  // `bump()` đổi version → useMemo chạy lại; states.current là nguồn thật.
  const rows = useMemo<Row[]>(
    () => resources.map((res) => {
      const st = states.current[res.key] ?? { samples: [], busy: false };
      return { res, st, ev: evaluate(res.stack, st.last, overrides) };
    }),
    // `ver` đổi mỗi lần patch(); states.current là nguồn thật nên không nằm trong deps.
    [resources, overrides, ver],
  );
  const counts = useMemo(() => countLevels(rows.map((r) => r.ev.level)), [rows]);

  return { rows, counts, loaded, roundBusy, lastRoundAt, refreshAll, refreshOne };
}
