'use client';

// Overview: cluster health KPIs + per-node monitor (heap/disk/cpu/load — the
// shell refreshes it every 10s while this view is open) + indices table.
// Indices table: lọc theo tên (chứa / wildcard *) + sort từng cột (bấm tên cột).
// Clicking an index jumps to the Data browser scoped to it. Red/yellow health
// is surfaced loudly — an unassigned-shard count is the first thing an
// operator needs to see.

import { useMemo, useState } from 'react';
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

type SortKey = 'name' | 'health' | 'docs' | 'size' | 'shards';
interface SortState { key: SortKey; dir: 'asc' | 'desc' }

/** Cột số mặc định giảm dần (to nhất lên đầu); tên mặc định A→Z. */
const DEFAULT_DIR: Record<SortKey, 'asc' | 'desc'> = { name: 'asc', health: 'desc', docs: 'desc', size: 'desc', shards: 'desc' };
const HEALTH_RANK: Record<string, number> = { green: 0, yellow: 1, red: 2 };

/**
 * Ô tìm → bộ so khớp tên index, không phân biệt hoa thường.
 *   · không có '*'  → CHỨA chuỗi đó (call_bot ≡ *call_bot*)
 *   · có '*'        → wildcard đúng nghĩa, neo hai đầu (call_bot* = bắt đầu bằng)
 *   · nhiều mẫu cách nhau dấu phẩy → khớp MỘT trong số đó
 */
function indexMatcher(q: string): ((name: string) => boolean) | null {
  const pats = q.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!pats.length) return null;
  const tests = pats.map((p) => {
    if (!p.includes('*')) return (n: string) => n.includes(p);
    const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${p.split('*').map(esc).join('.*')}$`);
    return (n: string) => re.test(n);
  });
  return (name) => { const n = name.toLowerCase(); return tests.some((t) => t(n)); };
}

function compareIndex(a: EsIndexInfo, b: EsIndexInfo, key: SortKey): number {
  switch (key) {
    case 'name': return a.name.localeCompare(b.name, undefined, { numeric: true });
    case 'health': return (HEALTH_RANK[a.health] ?? -1) - (HEALTH_RANK[b.health] ?? -1);
    case 'docs': return a.docsCount - b.docsCount;
    case 'size': return a.sizeBytes - b.sizeBytes;
    case 'shards': return a.primaries - b.primaries || a.replicas - b.replicas;
  }
}

export default function OverviewView({
  health, nodes, indices, loading, autoRefresh, onAutoRefresh, lastRefreshAt, onReload, onOpenIndex,
}: OverviewViewProps) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });

  const shown = useMemo(() => {
    const match = indexMatcher(q);
    const rows = match ? indices.filter((ix) => match(ix.name)) : indices.slice();
    const sign = sort.dir === 'asc' ? 1 : -1;
    // Hoà nhau thì theo tên — thứ tự ổn định giữa các lần auto-refresh 10s.
    rows.sort((a, b) => sign * compareIndex(a, b, sort.key) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return rows;
  }, [indices, q, sort]);
  const totals = useMemo(
    () => shown.reduce((t, ix) => ({ docs: t.docs + ix.docsCount, size: t.size + ix.sizeBytes }), { docs: 0, size: 0 }),
    [shown],
  );

  /** Bấm cột: cột mới → chiều mặc định của cột; cùng cột → đảo chiều. */
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: DEFAULT_DIR[key] }));
  const th = (key: SortKey, label: string, left = false) => {
    const on = sort.key === key;
    return (
      <th
        style={left ? { textAlign: 'left' } : undefined}
        aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button className={`es-th-sort${on ? ' on' : ''}`} onClick={() => toggleSort(key)}
          title={`Sắp xếp theo ${label}${on ? (sort.dir === 'asc' ? ' — đang tăng dần' : ' — đang giảm dần') : ''}`}>
          {label}<span className="es-th-arrow">{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
        </button>
      </th>
    );
  };

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

      <div className="status-line" style={{ gap: 8, marginTop: 12 }}>
        <strong>Indices ({q.trim() ? `${shown.length}/${indices.length}` : indices.length})</strong>
        <input
          className="input es-ix-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
          placeholder="🔎 Tìm index — call_bot = *call_bot*, hỗ trợ * và nhiều mẫu cách nhau dấu phẩy"
        />
        {q.trim() && (
          <span className="small" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            {fmtCount(totals.docs)} docs · {fmtBytes(totals.size)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="chip-btn" onClick={onReload} disabled={loading}>↻</button>
      </div>
      <div className="es-scroll">
        <table className="es-table">
          <thead>
            <tr>
              {th('name', 'Index', true)}{th('health', 'Health')}{th('docs', 'Docs')}{th('size', 'Size')}{th('shards', 'Pri×Rep')}
            </tr>
          </thead>
          <tbody>
            {shown.map((ix) => (
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
            {indices.length > 0 && shown.length === 0 && (
              <tr><td colSpan={5} className="empty">Không có index nào khớp “{q.trim()}”.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
