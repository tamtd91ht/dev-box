'use client';

// Overview: cluster health KPIs + per-node monitor (heap/disk/cpu/load — the
// shell refreshes it every 10s while this view is open) + indices table.
// Clicking an index jumps to the Data browser scoped to it. Red/yellow health
// is surfaced loudly — an unassigned-shard count is the first thing an
// operator needs to see.

import { fmtBytes, fmtCount, type EsHealthResult, type EsIndexInfo, type EsNodeInfo } from '@/lib/es';

export interface OverviewViewProps {
  health: EsHealthResult | null;
  nodes: EsNodeInfo[];
  indices: EsIndexInfo[];
  loading: boolean;
  /** Auto-refresh (10s) state + toggle — owned by the shell. */
  autoRefresh: boolean;
  onAutoRefresh: (on: boolean) => void;
  /** Timestamp of the last live refresh (ms) — 0 when never. */
  lastRefreshAt: number;
  onReload: () => void;
  onOpenIndex: (index: string) => void;
}

function healthColor(h: string): string {
  if (h === 'green') return 'var(--ok)';
  if (h === 'yellow') return 'var(--warn, #d5a021)';
  if (h === 'red') return 'var(--err)';
  return 'var(--muted)';
}

/** Gauge severity: ok < 75% · warn 75–90% · crit ≥90%. */
function gaugeLevel(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}

function Gauge({ label, pct, detail }: { label: string; pct: number | null; detail?: string }) {
  if (pct === null) return null;
  const level = gaugeLevel(pct);
  return (
    <div className="es-gauge">
      <div className="es-gauge-head">
        <span>{label}</span>
        <span className="es-gauge-num">{detail ?? ''}</span>
        <span className="es-gauge-pct" style={{ color: level === 'ok' ? undefined : level === 'warn' ? 'var(--warn, #d5a021)' : 'var(--err)' }}>
          {Math.round(pct)}%
        </span>
      </div>
      <div className="es-gauge-track">
        <div className={`es-gauge-fill l-${level}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}

export default function OverviewView({
  health, nodes, indices, loading, autoRefresh, onAutoRefresh, lastRefreshAt, onReload, onOpenIndex,
}: OverviewViewProps) {
  if (loading && !health) return <p className="empty"><span className="spinner" /> Đang tải…</p>;

  return (
    <div className="es-overview">
      {health && (
        <div className="es-kpis">
          <div className="es-kpi"><span className="es-kpi-label">Cluster</span><b>{health.clusterName}</b></div>
          <div className="es-kpi"><span className="es-kpi-label">Version</span><b>ES {health.version}</b></div>
          <div className="es-kpi">
            <span className="es-kpi-label">Health</span>
            <b style={{ color: healthColor(health.status) }}>● {health.status}</b>
          </div>
          <div className="es-kpi"><span className="es-kpi-label">Nodes</span><b>{health.nodes}</b></div>
          <div className="es-kpi"><span className="es-kpi-label">Shards</span><b>{fmtCount(health.activeShards)} active</b></div>
          <div className="es-kpi">
            <span className="es-kpi-label">Unassigned</span>
            <b style={{ color: health.unassignedShards > 0 ? 'var(--err)' : undefined }}>{health.unassignedShards}</b>
          </div>
          <div className="es-kpi"><span className="es-kpi-label">Ping</span><b>{health.latencyMs}ms</b></div>
        </div>
      )}

      {/* ── Per-node monitor (heap / disk / cpu / load) ─────────────────── */}
      {nodes.length > 0 && (
        <>
          <div className="status-line" style={{ justifyContent: 'space-between', marginTop: 12 }}>
            <strong>Nodes ({nodes.length})</strong>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {lastRefreshAt > 0 && (
                <span className="badge" title="Lần cập nhật gần nhất">
                  ↻ {new Date(lastRefreshAt).toLocaleTimeString('vi-VN')}
                </span>
              )}
              <label className="es-check" title="Tự fetch _cat/nodes + _cluster/health mỗi 10s khi đang mở Tổng quan">
                <input type="checkbox" checked={autoRefresh} onChange={(e) => onAutoRefresh(e.target.checked)} />
                auto 10s
              </label>
            </div>
          </div>
          <div className="es-node-grid">
            {nodes.map((n) => (
              <div key={`${n.name}-${n.ip}`} className={`es-node-card${(n.heapPercent ?? 0) >= 90 || (n.diskUsedPercent ?? 0) >= 90 ? ' alarm' : ''}`}>
                <div className="es-node-head">
                  <strong>{n.master && <span title="Elected master">★ </span>}{n.name}</strong>
                  <span className="badge" title={`roles: ${n.roles}`}>{n.ip}</span>
                </div>
                <Gauge label="Heap" pct={n.heapPercent} />
                <Gauge
                  label="Disk"
                  pct={n.diskUsedPercent}
                  detail={n.diskAvailBytes !== null ? `còn ${fmtBytes(n.diskAvailBytes)}` : undefined}
                />
                <Gauge label="CPU" pct={n.cpu} />
                <div className="es-gauge-head" style={{ marginTop: 2 }}>
                  <span>Load</span>
                  <span className="es-gauge-num">
                    {n.load1m ?? '—'} · {n.load5m ?? '—'} · {n.load15m ?? '—'}
                    <span style={{ color: 'var(--muted)', marginLeft: 4 }}>(1m·5m·15m)</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="status-line" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <strong>Indices ({indices.length})</strong>
        <button className="chip-btn" onClick={onReload} disabled={loading}>↻</button>
      </div>
      <div className="es-scroll">
        <table className="es-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Index</th><th>Health</th><th>Docs</th><th>Size</th><th>Pri×Rep</th>
            </tr>
          </thead>
          <tbody>
            {indices.map((ix) => (
              <tr key={ix.name}>
                <td style={{ textAlign: 'left' }}>
                  <button className="es-link" onClick={() => onOpenIndex(ix.name)}>{ix.name}</button>
                </td>
                <td><span style={{ color: healthColor(ix.health) }}>● {ix.health}</span></td>
                <td>{fmtCount(ix.docsCount)}</td>
                <td>{fmtBytes(ix.sizeBytes)}</td>
                <td>{ix.primaries}×{ix.replicas}</td>
              </tr>
            ))}
            {indices.length === 0 && !loading && (
              <tr><td colSpan={5} className="empty">Không có index nào (index hệ thống “.*” được ẩn).</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
