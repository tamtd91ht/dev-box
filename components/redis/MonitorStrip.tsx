'use client';

// Redis monitor strip — INFO snapshot per node (single, or every cluster
// master): memory vs maxmemory (fallback: system RAM), clients, ops/s,
// keyspace hit-rate, fragmentation, uptime. Collapsed by default; expanding
// starts a 30s poll that pauses when the browser tab is hidden and stops when
// collapsed — a monitor must never quietly hammer a production instance.

import { useCallback, useEffect, useState } from 'react';
import { redisStats, humanizeTtl, type RedisNodeStats } from '@/lib/redis';

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

export default function MonitorStrip({ connectionId }: { connectionId: string }) {
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<RedisNodeStats[]>([]);
  const [at, setAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setNodes(await redisStats(connectionId));
      setAt(Date.now());
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [connectionId]);

  // Reset when the connection changes.
  useEffect(() => { setNodes([]); setAt(0); setError(null); }, [connectionId]);

  // Poll every 30s while OPEN and the browser tab is visible.
  useEffect(() => {
    if (!open) return;
    void refresh();
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, [open, refresh]);

  return (
    <div className="redis-monitor">
      <div className="status-line" style={{ justifyContent: 'space-between' }}>
        <button className="chip-btn" onClick={() => setOpen((v) => !v)} title="INFO mỗi 30s khi đang mở">
          {open ? '▾' : '▸'} 📈 Monitor{open ? '' : ' (memory · clients · ops/s)'}
        </button>
        {open && at > 0 && <span className="badge">↻ {new Date(at).toLocaleTimeString('vi-VN')} · auto 30s</span>}
      </div>

      {open && error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

      {open && nodes.length > 0 && (
        <div className="redis-monitor-grid">
          {nodes.map((n) => {
            const memMax = n.maxMemoryBytes > 0 ? n.maxMemoryBytes : n.systemMemoryBytes;
            const pct = memMax > 0 ? (n.usedMemoryBytes / memMax) * 100 : null;
            const level = pct !== null ? gaugeLevel(pct) : 'ok';
            return (
              <div key={n.addr} className={`redis-monitor-card${level === 'crit' ? ' alarm' : ''}`}>
                <div className="redis-monitor-head">
                  <strong>{n.addr}</strong>
                  <span className="badge">{n.role}{n.connectedSlaves > 0 ? ` +${n.connectedSlaves} repl` : ''}</span>
                </div>
                <div className="redis-monitor-gauge">
                  <div className="redis-monitor-gauge-head">
                    <span>Memory{n.maxMemoryBytes > 0 ? '' : ' (vs system RAM)'}</span>
                    <span>{fmtBytes(n.usedMemoryBytes)}{memMax > 0 ? ` / ${fmtBytes(memMax)}` : ''}</span>
                    {pct !== null && (
                      <b style={{ color: level === 'ok' ? undefined : level === 'warn' ? 'var(--warn, #d5a021)' : 'var(--err)' }}>
                        {Math.round(pct)}%
                      </b>
                    )}
                  </div>
                  {pct !== null && (
                    <div className="redis-monitor-track">
                      <div className={`redis-monitor-fill l-${level}`} style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                  )}
                </div>
                <div className="redis-monitor-stats">
                  <span>clients <b>{n.connectedClients}</b></span>
                  <span>ops/s <b>{n.opsPerSec}</b></span>
                  {n.hitRatePct !== null && <span>hit <b>{n.hitRatePct.toFixed(1)}%</b></span>}
                  {n.fragmentationRatio !== null && (
                    <span style={{ color: n.fragmentationRatio > 1.5 ? 'var(--warn, #d5a021)' : undefined }}>
                      frag <b>{n.fragmentationRatio.toFixed(2)}</b>
                    </span>
                  )}
                  <span>up <b>{humanizeTtl(n.uptimeSec)}</b></span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
