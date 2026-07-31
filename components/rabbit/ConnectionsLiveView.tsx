'use client';

// Who is connected, and — via the channel rows merged in — what their prefetch
// and unacked counts look like. Channels get no tab of their own: a channel is
// only interesting relative to its connection, and prefetch/unacked is the whole
// reason to look (prefetch=∞ with a large unacked count is a classic consumer
// that grabbed the queue and stalled).

import { useMemo } from 'react';
import { fmtInt, fmtTs, vhostLabel, type ChannelInfo, type ConnectionInfo } from '@/lib/rabbit';

export interface ConnectionsLiveViewProps {
  connections: ConnectionInfo[];
  channels: ChannelInfo[];
  loading: boolean;
}

export default function ConnectionsLiveView({ connections, channels, loading }: ConnectionsLiveViewProps) {
  // Channels reference their parent by connection name.
  const byConnection = useMemo(() => {
    const m = new Map<string, ChannelInfo[]>();
    for (const ch of channels) {
      const arr = m.get(ch.connectionName) ?? [];
      arr.push(ch);
      m.set(ch.connectionName, arr);
    }
    return m;
  }, [channels]);

  const totalUnacked = channels.reduce((s, c) => s + c.unacked, 0);

  return (
    <div className="rabbit-scroll" style={{ marginTop: 8 }}>
      <div className="rabbit-meta">
        {loading ? <span className="spinner" /> : `${connections.length} connection · ${channels.length} channel · ${fmtInt(totalUnacked)} unacked`}
      </div>
      <table className="rabbit-table">
        <thead>
          <tr><th>Client</th><th>User</th><th>vhost</th><th>Ch</th><th>Prefetch</th><th>Unacked</th><th>Proto</th><th>Kết nối lúc</th><th>State</th></tr>
        </thead>
        <tbody>
          {connections.map((c, i) => {
            const chs = byConnection.get(c.name) ?? [];
            const unacked = chs.reduce((s, x) => s + x.unacked, 0);
            // Distinct prefetch values across the connection's channels; 0 means
            // unlimited in AMQP, which is worth showing as ∞ rather than "0".
            const prefetches = [...new Set(chs.map((x) => x.prefetch))].sort((a, b) => a - b);
            return (
              <tr key={i}>
                <td style={{ textAlign: 'left' }} title={c.name}>{c.peerHost || c.name}</td>
                <td style={{ textAlign: 'left' }}>{c.user}</td>
                <td>{vhostLabel(c.vhost)}</td>
                <td>{c.channels}</td>
                <td>{prefetches.length === 0 ? '—' : prefetches.map((p) => (p === 0 ? '∞' : p)).join(', ')}</td>
                <td style={unacked > 0 ? { color: 'var(--warn)' } : undefined}>{fmtInt(unacked)}</td>
                <td>{c.protocol}</td>
                <td>{fmtTs(c.connectedAtMs)}</td>
                <td><span className={`rabbit-state s-${c.state}`}>{c.state}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!loading && connections.length === 0 && <p className="empty">Không có connection nào đang mở.</p>}
    </div>
  );
}
