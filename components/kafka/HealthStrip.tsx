'use client';

// Kafka cluster-health strip. Two data sources:
//   1. Kafka protocol (always): brokers/controller, UNDER-REPLICATED partitions
//      (ISR behind) and OFFLINE partitions (leaderless — producers failing NOW).
//   2. node_exporter (when the connection declares metrics URLs): RAM, disk,
//      CPU busy % (diffed between polls from cumulative counters) and load
//      per broker host — the wire protocol itself has no host metrics.
// Collapsed by default; expanding starts a 60s poll that pauses when the
// browser tab is hidden and stops when collapsed.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  kafkaClusterHealth,
  kafkaHostMetrics,
  type KafkaClusterHealth,
  type KafkaHostMetrics,
} from '@/lib/kafka';

const HAS_METRICS_HINT = 'Thêm metrics URLs (node_exporter) vào connection để có RAM/disk/CPU/load per broker';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function gaugeLevel(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}

function Gauge({ label, pct, detail }: { label: string; pct: number; detail?: string }) {
  const level = gaugeLevel(pct);
  return (
    <div className="kafka-gauge">
      <div className="kafka-gauge-head">
        <span>{label}</span>
        <span className="kafka-gauge-num">{detail ?? ''}</span>
        <b style={{ color: level === 'ok' ? undefined : level === 'warn' ? 'var(--warn, #d5a021)' : 'var(--err)' }}>
          {Math.round(pct)}%
        </b>
      </div>
      <div className="kafka-gauge-track">
        <div className={`kafka-gauge-fill l-${level}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}

export default function HealthStrip({ connectionId, hasMetricsUrls }: { connectionId: string; hasMetricsUrls: boolean }) {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<KafkaClusterHealth | null>(null);
  const [hosts, setHosts] = useState<KafkaHostMetrics[]>([]);
  /** Previous cumulative CPU counters per url — for busy-% rates. */
  const prevCpuRef = useRef<Map<string, { idle: number; total: number }>>(new Map());
  const [cpuPct, setCpuPct] = useState<Record<string, number>>({});
  const [at, setAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [h, m] = await Promise.allSettled([
      kafkaClusterHealth(connectionId),
      hasMetricsUrls ? kafkaHostMetrics(connectionId) : Promise.resolve([] as KafkaHostMetrics[]),
    ]);
    if (h.status === 'fulfilled') { setHealth(h.value); setError(null); }
    else setError((h.reason as Error).message);
    if (m.status === 'fulfilled') {
      setHosts(m.value);
      // CPU busy % = 1 - Δidle/Δtotal between consecutive polls.
      const rates: Record<string, number> = {};
      for (const host of m.value) {
        if (host.cpuIdleSec === undefined || host.cpuTotalSec === undefined) continue;
        const prev = prevCpuRef.current.get(host.url);
        if (prev && host.cpuTotalSec > prev.total) {
          const dIdle = host.cpuIdleSec - prev.idle;
          const dTotal = host.cpuTotalSec - prev.total;
          if (dTotal > 0) rates[host.url] = Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100));
        }
        prevCpuRef.current.set(host.url, { idle: host.cpuIdleSec, total: host.cpuTotalSec });
      }
      setCpuPct((old) => ({ ...old, ...rates }));
    }
    setAt(Date.now());
  }, [connectionId, hasMetricsUrls]);

  useEffect(() => {
    setHealth(null); setHosts([]); setCpuPct({}); prevCpuRef.current = new Map();
    setAt(0); setError(null);
  }, [connectionId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh();
    }, 60_000);
    return () => clearInterval(t);
  }, [open, refresh]);

  const bad = (health?.underReplicated ?? 0) > 0 || (health?.offline ?? 0) > 0;

  return (
    <div className="kafka-health">
      <div className="status-line" style={{ justifyContent: 'space-between' }}>
        <button className="chip-btn" onClick={() => setOpen((v) => !v)} title="describeCluster + topic metadata (+ node_exporter nếu cấu hình) mỗi 60s khi đang mở">
          {open ? '▾' : '▸'} 📈 Cluster health{open ? '' : ' (brokers · URP · offline · host metrics)'}
        </button>
        {open && at > 0 && <span className="badge">↻ {new Date(at).toLocaleTimeString('vi-VN')} · auto 60s</span>}
      </div>

      {open && error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

      {open && health && (
        <div className={`kafka-health-body${bad ? ' alarm' : ''}`}>
          <div className="kafka-health-kpis">
            <span>brokers <b>{health.brokers.length}</b></span>
            <span>topics <b>{health.topicCount}</b></span>
            <span>partitions <b>{health.partitionCount}</b></span>
            <span style={{ color: health.underReplicated > 0 ? 'var(--err)' : 'var(--ok)' }}>
              under-replicated <b>{health.underReplicated}</b>
            </span>
            <span style={{ color: health.offline > 0 ? 'var(--err)' : 'var(--ok)' }}>
              offline <b>{health.offline}</b>
            </span>
          </div>
          <div className="kafka-health-brokers">
            {health.brokers.map((b) => (
              <span key={b.nodeId} className="badge" title={`leader của ${b.leaderPartitions} partition`}>
                {b.isController && <span title="controller">★ </span>}#{b.nodeId} {b.addr} · {b.leaderPartitions}p
              </span>
            ))}
          </div>
          {bad && health.affectedTopics.length > 0 && (
            <div className="kafka-health-affected">
              ⚠ topic ảnh hưởng: {health.affectedTopics.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Host metrics (node_exporter) — only when the connection declares URLs. */}
      {open && !hasMetricsUrls && (
        <p className="kafka-health-hint">{HAS_METRICS_HINT} (sửa connection → ô Metrics URLs).</p>
      )}
      {open && hosts.length > 0 && (
        <div className="kafka-health-hosts">
          {hosts.map((h) => {
            const memPct = h.memTotalBytes && h.memAvailableBytes !== undefined
              ? ((h.memTotalBytes - h.memAvailableBytes) / h.memTotalBytes) * 100
              : null;
            const alarm = (memPct ?? 0) >= 90
              || (h.disks ?? []).some((d) => d.sizeBytes > 0 && (1 - d.availBytes / d.sizeBytes) * 100 >= 90);
            return (
              <div key={h.url} className={`kafka-host-card${alarm ? ' alarm' : ''}`}>
                <div className="kafka-health-brokers" style={{ justifyContent: 'space-between' }}>
                  <strong style={{ fontSize: 13 }}>{h.host}</strong>
                  {h.error && <span className="badge" style={{ color: 'var(--err)' }}>{h.error}</span>}
                </div>
                {memPct !== null && (
                  <Gauge
                    label="RAM"
                    pct={memPct}
                    detail={`${fmtBytes((h.memTotalBytes ?? 0) - (h.memAvailableBytes ?? 0))} / ${fmtBytes(h.memTotalBytes ?? 0)}`}
                  />
                )}
                {(h.disks ?? []).map((d) => (
                  <Gauge
                    key={d.mount}
                    label={`Disk ${d.mount}`}
                    pct={d.sizeBytes > 0 ? (1 - d.availBytes / d.sizeBytes) * 100 : 0}
                    detail={`còn ${fmtBytes(d.availBytes)}`}
                  />
                ))}
                {cpuPct[h.url] !== undefined && <Gauge label="CPU" pct={cpuPct[h.url]} />}
                {h.load1 !== undefined && (
                  <div className="kafka-gauge-head" style={{ marginTop: 2 }}>
                    <span>Load</span>
                    <span className="kafka-gauge-num">
                      {h.load1} · {h.load5 ?? '—'} · {h.load15 ?? '—'}
                      <span style={{ color: 'var(--muted)', marginLeft: 4 }}>(1m·5m·15m)</span>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
