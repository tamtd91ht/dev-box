'use client';

// Overview: server version + topology + LIVE MONITOR (RAM / disk / connections
// / WiredTiger cache / ops-per-second / replica lag — the shell refreshes it
// every 30s while this view is open) + databases table. Clicking a database
// jumps to the Data browser scoped to it.

import { fmtBytes, fmtCount, type DatabaseInfo, type ServerInfoResult, type MongoMonitorResult } from '@/lib/mongo';

export interface OverviewViewProps {
  info: ServerInfoResult | null;
  databases: DatabaseInfo[];
  monitor: MongoMonitorResult | null;
  /** ops/s per opcounter, diffed by the shell between consecutive polls. */
  opsPerSec: Record<string, number> | null;
  autoRefresh: boolean;
  onAutoRefresh: (on: boolean) => void;
  lastRefreshAt: number;
  loading: boolean;
  onReload: () => void;
  onOpenDb: (db: string) => void;
}

function gaugeLevel(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}

function Gauge({ label, used, max, detail }: { label: string; used: number; max: number; detail?: string }) {
  if (!(max > 0)) return null;
  const pct = (used / max) * 100;
  const level = gaugeLevel(pct);
  return (
    <div className="mongo-gauge">
      <div className="mongo-gauge-head">
        <span>{label}</span>
        <span className="mongo-gauge-num">{detail ?? `${fmtBytes(used)} / ${fmtBytes(max)}`}</span>
        <span className="mongo-gauge-pct" style={{ color: level === 'ok' ? undefined : level === 'warn' ? 'var(--warn, #d5a021)' : 'var(--err)' }}>
          {Math.round(pct)}%
        </span>
      </div>
      <div className="mongo-gauge-track">
        <div className={`mongo-gauge-fill l-${level}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}

function fmtUptime(sec: number): string {
  if (sec >= 86400) return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 60)}m`;
}

export default function OverviewView({
  info, databases, monitor, opsPerSec, autoRefresh, onAutoRefresh, lastRefreshAt, loading, onReload, onOpenDb,
}: OverviewViewProps) {
  if (loading && !info) return <p className="empty"><span className="spinner" /> Đang tải…</p>;

  return (
    <div className="mongo-overview">
      {info && (
        <div className="mongo-kpis">
          <div className="mongo-kpi"><span className="mongo-kpi-label">Version</span><b>MongoDB {info.version}</b></div>
          <div className="mongo-kpi"><span className="mongo-kpi-label">Topology</span><b>{info.topology}</b></div>
          <div className="mongo-kpi"><span className="mongo-kpi-label">Ping</span><b>{info.latencyMs}ms</b></div>
          {monitor && <div className="mongo-kpi"><span className="mongo-kpi-label">Uptime</span><b>{fmtUptime(monitor.uptimeSec)}</b></div>}
          {info.hosts.length > 0 && (
            <div className="mongo-kpi"><span className="mongo-kpi-label">Members</span><b>{info.hosts.join(', ')}</b></div>
          )}
        </div>
      )}

      {/* ── Live monitor (30s): RAM / disk / connections / cache / ops ──── */}
      {monitor && (
        <>
          <div className="status-line" style={{ justifyContent: 'space-between', marginTop: 12 }}>
            <strong>Monitor</strong>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {lastRefreshAt > 0 && (
                <span className="badge" title="Lần cập nhật gần nhất">↻ {new Date(lastRefreshAt).toLocaleTimeString('vi-VN')}</span>
              )}
              <label className="mongo-check" title="Tự fetch serverStatus + dbStats + replSetGetStatus mỗi 30s khi đang mở Tổng quan">
                <input type="checkbox" checked={autoRefresh} onChange={(e) => onAutoRefresh(e.target.checked)} />
                auto 30s
              </label>
            </div>
          </div>
          <div className="mongo-node-grid">
            <div className="mongo-node-card">
              <div className="mongo-node-head"><strong>Tài nguyên (node đang kết nối)</strong></div>
              <div className="mongo-gauge">
                <div className="mongo-gauge-head">
                  <span>RAM (resident)</span>
                  <span className="mongo-gauge-num">{fmtBytes(monitor.memResidentBytes)} · virtual {fmtBytes(monitor.memVirtualBytes)}</span>
                </div>
              </div>
              {monitor.fsTotalBytes !== null && monitor.fsUsedBytes !== null && (
                <Gauge label="Disk (data volume)" used={monitor.fsUsedBytes} max={monitor.fsTotalBytes} />
              )}
              <Gauge
                label="Connections"
                used={monitor.connectionsCurrent}
                max={monitor.connectionsCurrent + monitor.connectionsAvailable}
                detail={`${fmtCount(monitor.connectionsCurrent)} đang mở · còn ${fmtCount(monitor.connectionsAvailable)}`}
              />
              <Gauge label="WiredTiger cache" used={monitor.cacheUsedBytes} max={monitor.cacheMaxBytes} />
              {opsPerSec && (
                <div className="mongo-gauge-head" style={{ marginTop: 2 }}>
                  <span>Ops/s</span>
                  <span className="mongo-gauge-num">
                    {['insert', 'query', 'update', 'delete', 'command'].map((k) => `${k[0]}:${Math.round(opsPerSec[k] ?? 0)}`).join(' · ')}
                  </span>
                </div>
              )}
            </div>

            {monitor.members.length > 0 && (
              <div className="mongo-node-card">
                <div className="mongo-node-head"><strong>Replica set members</strong></div>
                <table className="mongo-table">
                  <tbody>
                    {monitor.members.map((m) => (
                      <tr key={m.name}>
                        <td style={{ textAlign: 'left' }}><code className="small">{m.name}</code></td>
                        <td>
                          <span style={{ color: m.healthy ? (m.state === 'PRIMARY' ? 'var(--ok)' : undefined) : 'var(--err)' }}>
                            {m.healthy ? '●' : '○'} {m.state}
                          </span>
                        </td>
                        <td style={{ color: (m.lagSec ?? 0) > 10 ? 'var(--err)' : undefined }}>
                          {m.lagSec !== null ? `lag ${m.lagSec}s` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <div className="status-line" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <strong>Databases ({databases.length})</strong>
        <button className="chip-btn" onClick={onReload} disabled={loading}>↻</button>
      </div>
      <table className="mongo-table">
        <thead>
          <tr><th style={{ textAlign: 'left' }}>Database</th><th>Size on disk</th><th></th></tr>
        </thead>
        <tbody>
          {databases.map((d) => (
            <tr key={d.name}>
              <td style={{ textAlign: 'left' }}>
                <button className="mongo-link" onClick={() => onOpenDb(d.name)}>{d.name}</button>
              </td>
              <td>{fmtBytes(d.sizeOnDisk)}</td>
              <td>{d.empty ? <span className="badge">empty</span> : null}</td>
            </tr>
          ))}
          {databases.length === 0 && !loading && (
            <tr><td colSpan={3} className="empty">Không đọc được danh sách database (thiếu quyền listDatabases?).</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
