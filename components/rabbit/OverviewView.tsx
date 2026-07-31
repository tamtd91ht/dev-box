'use client';

// Cluster-level overview: totals, throughput, per-node resource headroom, health
// probes, vhost scope switcher and an on-demand aliveness test.
//
// The per-node gauges exist because a triggered mem_alarm or disk_free_alarm
// BLOCKS EVERY PUBLISHER cluster-wide, and nothing in the queue/message numbers
// hints at it — the queues just stop moving. That is the single most common cause
// of "my producer hangs" and it gets top billing here for that reason.
//
// Auto-refresh is OPT-IN and starts OFF: this tool points at real clusters, and
// silently polling /api/nodes + /api/overview forever is load we did not ask the
// broker for.

import { useEffect, useRef, useState } from 'react';
import {
  fmtBytes,
  fmtInt,
  fmtRate,
  fmtUptime,
  vhostLabel,
  type AlivenessResult,
  type ClusterHealthResult,
  type NodeInfo,
  type OverviewResult,
  type VhostInfo,
} from '@/lib/rabbit';
import { Card, Gauge } from './shared';

const REFRESH_MS = 10_000;

export interface OverviewViewProps {
  overview: OverviewResult | null;
  nodes: NodeInfo[];
  health: ClusterHealthResult | null;
  vhosts: VhostInfo[];
  loading: boolean;
  /** Currently selected vhost scope ('' = every vhost the user can see). */
  vhostScope: string;
  onVhostScope: (v: string) => void;
  onReload: () => void;
  onAliveness: (vhost: string) => Promise<AlivenessResult>;
}

export default function OverviewView({
  overview,
  nodes,
  health,
  vhosts,
  loading,
  vhostScope,
  onVhostScope,
  onReload,
  onAliveness,
}: OverviewViewProps) {
  const [auto, setAuto] = useState(false);
  const [alive, setAlive] = useState<AlivenessResult | null>(null);
  const [aliveBusy, setAliveBusy] = useState(false);

  // Interval owns only the tick; onReload comes from the parent and is stable per
  // connection. Held in a ref so toggling `auto` doesn't restart on every render.
  const reloadRef = useRef(onReload);
  reloadRef.current = onReload;
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => reloadRef.current(), REFRESH_MS);
    return () => clearInterval(t);
  }, [auto]);

  if (loading && !overview) return <p><span className="spinner" /> Đang tải tổng quan…</p>;
  if (!overview) return null;

  const alarmed = nodes.filter((n) => n.memAlarm || n.diskFreeAlarm);
  const down = nodes.filter((n) => !n.running);
  const partitioned = nodes.filter((n) => n.partitions.length > 0);

  return (
    <div className="rabbit-overview">
      {/* Publishers blocked is the loudest thing this tool can say — say it first. */}
      {alarmed.length > 0 && (
        <div className="rabbit-danger">
          ⚠ <b>Publisher đang bị chặn toàn cluster.</b>{' '}
          {alarmed.map((n) => `${n.name} (${[n.memAlarm && 'mem_alarm', n.diskFreeAlarm && 'disk_free_alarm'].filter(Boolean).join(' + ')})`).join(', ')}
          {' '}— RabbitMQ chặn mọi publish cho tới khi alarm tắt. Queue sẽ đứng im mà không báo lỗi ở phía consumer.
        </div>
      )}
      {partitioned.length > 0 && (
        <div className="rabbit-danger">
          ⚠ <b>Network partition (split brain):</b> {partitioned.map((n) => `${n.name} ↮ ${n.partitions.join(', ')}`).join(' · ')}
        </div>
      )}
      {down.length > 0 && (
        <div className="rabbit-danger">⚠ Node không chạy: {down.map((n) => n.name).join(', ')}</div>
      )}

      <div className="rabbit-toolbar">
        <label className="rabbit-inline-field">
          <span>Vhost</span>
          <select className="input" value={vhostScope} onChange={(e) => onVhostScope(e.target.value)}>
            <option value="">(tất cả)</option>
            {vhosts.map((v) => (
              <option key={v.name} value={v.name}>
                {vhostLabel(v.name)} — {fmtInt(v.messages)} msg
              </option>
            ))}
          </select>
        </label>

        {health && (
          <span className="badge" style={{ color: health.ok ? 'var(--ok)' : 'var(--err)' }} title={health.checks.map((c) => `${c.name}: ${c.detail}`).join('\n')}>
            {health.ok ? '● healthy' : '● unhealthy'}
          </span>
        )}

        <label className="rabbit-check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Tự tải lại {REFRESH_MS / 1000}s
        </label>

        <button
          className="chip-btn"
          disabled={aliveBusy}
          title="Publish + consume thật một message để kiểm tra broker có nhận traffic không"
          onClick={async () => {
            setAliveBusy(true);
            try { setAlive(await onAliveness(vhostScope)); }
            finally { setAliveBusy(false); }
          }}
        >
          {aliveBusy ? '…' : '⚡ Aliveness test'}
        </button>

        {alive && (
          <span className="badge" style={{ color: alive.ok ? 'var(--ok)' : 'var(--err)' }}>
            {alive.ok ? `OK · ${vhostLabel(alive.vhost)}` : `Lỗi: ${alive.detail}`}
          </span>
        )}
      </div>

      {health && !health.ok && (
        <table className="rabbit-table">
          <thead><tr><th>Health check</th><th>Kết quả</th></tr></thead>
          <tbody>
            {health.checks.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td style={{ textAlign: 'left', color: c.ok ? 'var(--ok)' : 'var(--err)' }}>{c.ok ? 'ok' : c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="rabbit-cards">
        <Card label="Cluster" value={overview.clusterName} sub={overview.node} />
        <Card label="Phiên bản" value={overview.version} sub={`Erlang ${overview.erlangVersion}`} />
        <Card label="Queues" value={fmtInt(overview.totals.queues)} sub={`${fmtInt(overview.totals.exchanges)} exchanges`} />
        <Card
          label="Consumers"
          value={fmtInt(overview.totals.consumers)}
          sub={`${fmtInt(overview.totals.connections)} conn · ${fmtInt(overview.totals.channels)} ch`}
        />
      </div>
      <div className="rabbit-cards">
        <Card
          label="Messages"
          value={fmtInt(overview.messages.total)}
          sub={`${fmtInt(overview.messages.ready)} ready · ${fmtInt(overview.messages.unacked)} unacked`}
          tone={overview.messages.total > 0 ? 'warn' : 'ok'}
        />
        <Card label="Publish/s" value={fmtRate(overview.rates.publish)} />
        <Card label="Deliver/s" value={fmtRate(overview.rates.deliver)} />
        <Card label="Ack/s" value={fmtRate(overview.rates.ack)} />
      </div>

      <div className="rabbit-meta">Node ({nodes.length}) — RAM / disk / file descriptor / socket</div>
      <div className="rabbit-node-grid">
        {nodes.map((n) => (
          <div key={n.name} className={`rabbit-node-card${n.memAlarm || n.diskFreeAlarm || !n.running ? ' alarm' : ''}`}>
            <div className="rabbit-node-head">
              <strong className="code">{n.name}</strong>
              <span className="badge" style={{ color: n.running ? 'var(--ok)' : 'var(--err)' }}>
                {n.running ? 'running' : 'down'}
              </span>
              <span className="badge">{n.type}</span>
              <span className="rabbit-topic-meta">up {fmtUptime(n.uptimeMs)}</span>
            </div>

            <Gauge label="RAM" used={n.memUsed} limit={n.memLimit} format={fmtBytes} alarm={n.memAlarm} />
            {/*
              Disk is inverted vs the others: the broker reports FREE space and a
              LOW watermark. So "used" here = how much of the safety margin is
              gone. At diskFree == diskFreeLimit the alarm fires, hence 100%.
            */}
            <Gauge
              label="Disk (free vs watermark)"
              used={Math.max(0, n.diskFreeLimit)}
              limit={Math.max(n.diskFree, n.diskFreeLimit) || 0}
              format={fmtBytes}
              alarm={n.diskFreeAlarm}
            />
            <div className="rabbit-hint">
              Còn trống {fmtBytes(n.diskFree)} · ngưỡng alarm {fmtBytes(n.diskFreeLimit)}
            </div>
            <Gauge label="File descriptor" used={n.fdUsed} limit={n.fdTotal} />
            <Gauge label="Socket" used={n.socketsUsed} limit={n.socketsTotal} />
            <Gauge label="Erlang process" used={n.procUsed} limit={n.procTotal} />
          </div>
        ))}
        {nodes.length === 0 && <p className="empty">Không đọc được /api/nodes.</p>}
      </div>
    </div>
  );
}
