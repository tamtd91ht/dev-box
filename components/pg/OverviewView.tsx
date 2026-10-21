'use client';

// Overview: version/role KPIs, server health meters (connections, cache hit,
// XID age, locks, long queries, replication), host metrics from node_exporter
// (disk / RAM / load — when the connection declares metricsUrls), the live
// session list, and the databases table. Meter colours come from the SAME rules
// the Monitor uses (lib/monitor/status), so a red here is a red there.

import {
  fmtBytes,
  type PgDatabaseInfo,
  type PgHostMetrics,
  type PgSession,
  type PgStats,
  type PgTestResult,
} from '@/lib/pg';
import { fmtDuration } from '@/lib/monitor/status';
import { HostSection, levelFor, Meter, METER_COLOR as COLOR } from '../health/Meters';

export interface OverviewViewProps {
  info: PgTestResult | null;
  stats: PgStats | null;
  hosts: PgHostMetrics[];
  /** Connection có khai metricsUrls không — để gợi ý khi chưa có số đĩa/RAM. */
  hasMetricsUrls: boolean;
  databases: PgDatabaseInfo[];
  loading: boolean;
  onReload: () => void;
  onOpenDb: (db: string) => void;
}

const lvl = (metric: string, v: number | null | undefined) => levelFor('pg', metric, v);

const orDash = (v: number | null | undefined, f: (n: number) => string): string => (v === null || v === undefined ? '—' : f(v));

export default function OverviewView({ info, stats, hosts, hasMetricsUrls, databases, loading, onReload, onOpenDb }: OverviewViewProps) {
  if (loading && !info) return <p className="empty"><span className="spinner" /> Đang tải…</p>;

  return (
    <div className="pg-overview">
      {info && (
        <div className="pg-kpis">
          <div className="pg-kpi"><span className="pg-kpi-label">Version</span><b>PostgreSQL {info.version}</b></div>
          <div className="pg-kpi"><span className="pg-kpi-label">Default DB</span><b>{info.database}</b></div>
          <div className="pg-kpi"><span className="pg-kpi-label">Ping</span><b>{info.latencyMs}ms</b></div>
          {info.endpoint && (
            <div className="pg-kpi" title={`Cluster ${info.nodes} node`}>
              <span className="pg-kpi-label">Node đang dùng</span>
              <b>{info.endpoint}</b>
            </div>
          )}
          {stats && (
            <>
              <div className="pg-kpi"><span className="pg-kpi-label">Vai trò</span><b>{stats.role === 'primary' ? 'Primary' : 'Standby'}</b></div>
              <div className="pg-kpi"><span className="pg-kpi-label">Chạy được</span><b>{fmtDuration(stats.uptimeSec)}</b></div>
            </>
          )}
        </div>
      )}

      {stats && <HealthGrid s={stats} />}
      <HostSection stack="pg" what="Postgres" hosts={hosts} hasMetricsUrls={hasMetricsUrls} />
      {stats && stats.sessions.length > 0 && <SessionsTable sessions={stats.sessions} />}

      <div className="status-line" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <strong>Databases ({databases.length})</strong>
        <button className="chip-btn" onClick={onReload} disabled={loading}>↻</button>
      </div>
      <table className="pg-table">
        <thead>
          <tr><th style={{ textAlign: 'left' }}>Database</th><th>Size</th></tr>
        </thead>
        <tbody>
          {databases.map((d) => (
            <tr key={d.name}>
              <td style={{ textAlign: 'left' }}>
                <button className="pg-link" onClick={() => onOpenDb(d.name)}>{d.name}</button>
              </td>
              <td>{fmtBytes(d.sizeBytes)}</td>
            </tr>
          ))}
          {databases.length === 0 && !loading && (
            <tr><td colSpan={2} className="empty">Không đọc được danh sách database (thiếu quyền?).</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function HealthGrid({ s }: { s: PgStats }) {
  const primary = s.role === 'primary';
  return (
    <>
      <div className="status-line" style={{ marginTop: 12 }}><strong>Sức khoẻ server</strong></div>
      <div className="pg-meters">
        <Meter
          label="Kết nối"
          value={`${s.connections} / ${s.maxConnections}`}
          pct={s.connectionsUsedPct}
          level={lvl('connectionsUsedPct', s.connectionsUsedPct)}
          text={`${s.active} đang chạy · ${s.idle} rảnh · ${s.idleInTx} idle in transaction`}
          hint="Số kết nối client so với max_connections"
        />
        <Meter
          label="Cache hit"
          value={orDash(s.cacheHitPct, (n) => `${n}%`)}
          pct={s.cacheHitPct}
          level={lvl('cacheHitPct', s.cacheHitPct)}
          text={[
            s.sharedBuffersBytes ? `shared_buffers ${fmtBytes(s.sharedBuffersBytes)}` : '',
            s.cacheHitTotalPct !== null && s.cacheHitTotalPct !== s.cacheHitPct ? `cộng dồn ${s.cacheHitTotalPct}%` : '',
          ].filter(Boolean).join(' · ') || undefined}
          hint="Tỉ lệ khối đọc từ shared_buffers thay vì phải xin hệ điều hành — tính GẦN ĐÂY (giữa các lần đo); 'cộng dồn' là từ lần reset thống kê. Thấp kéo dài = dữ liệu nóng không vừa bộ nhớ hoặc query quét nhiều — Monitor có nút Phân tích để tìm nguyên nhân."
        />
        <Meter
          label="Dung lượng database"
          value={orDash(s.dbSizeBytes, fmtBytes)}
          level="ok"
          text="Tổng mọi database trên server"
          hint="Dung lượng đĩa do dữ liệu Postgres chiếm (không gồm WAL/log)."
        />
        <Meter
          label="Tuổi XID"
          value={orDash(s.wraparoundPct, (n) => `${n}%`)}
          pct={s.wraparoundPct}
          level={lvl('wraparoundPct', s.wraparoundPct)}
          text="100% = Postgres tự dừng ghi (wraparound)"
          hint="Tuổi transaction ID lớn nhất so với giới hạn 2^31. Cao nghĩa là autovacuum không theo kịp."
        />
        <Meter
          label="Phiên chờ lock"
          value={String(s.lockWaiters)}
          level={lvl('lockWaiters', s.lockWaiters)}
          hint="Số phiên đang bị chặn chờ lock của phiên khác."
        />
        <Meter
          label="Query lâu nhất"
          value={orDash(s.longestQuerySec, fmtDuration)}
          level={lvl('longestQuerySec', s.longestQuerySec)}
          hint="Câu lệnh đang chạy lâu nhất."
        />
        <Meter
          label="Giao dịch mở lâu nhất"
          value={orDash(s.longestTxSec, fmtDuration)}
          level={lvl('longestTxSec', s.longestTxSec)}
          text={`${orDash(s.deadlocks, (n) => String(n))} deadlock · temp ${orDash(s.tempBytes, fmtBytes)} (tích luỹ)`}
          hint="Giao dịch dài chặn autovacuum nên bảng phình dần."
        />
        {primary ? (
          <Meter
            label="Replication"
            value={s.replicas === null ? '—' : `${s.replicas} replica`}
            level={lvl('replicaLagMb', s.replicaLagBytes === null ? null : s.replicaLagBytes / 1048576)}
            text={[
              s.replicaLagBytes !== null ? `tụt tối đa ${fmtBytes(s.replicaLagBytes)}` : null,
              s.inactiveSlots ? `${s.inactiveSlots} slot không hoạt động` : null,
              s.slotRetainedBytes ? `slot giữ ${fmtBytes(s.slotRetainedBytes)} WAL` : null,
            ].filter(Boolean).join(' · ') || undefined}
            hint="Replica đang nối vào primary này và mức chậm của replica chậm nhất."
          />
        ) : (
          <Meter
            label="Replay lag"
            value={orDash(s.replayLagSec, fmtDuration)}
            level={lvl('replayLagSec', s.replayLagSec)}
            text="Standby — độ trễ so với primary"
            hint="Độ trễ replay trên node standby (0 khi không còn WAL chờ)."
          />
        )}
      </div>
    </>
  );
}

function SessionsTable({ sessions }: { sessions: PgSession[] }) {
  return (
    <>
      <div className="status-line" style={{ marginTop: 12 }}><strong>Phiên đang chạy ({sessions.length})</strong></div>
      <table className="pg-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>PID</th>
            <th style={{ textAlign: 'left' }}>User / DB</th>
            <th>Trạng thái</th>
            <th>Query</th>
            <th>Giao dịch</th>
            <th style={{ textAlign: 'left' }}>Câu lệnh</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.pid}>
              <td style={{ textAlign: 'left' }}>{s.pid}</td>
              <td style={{ textAlign: 'left' }}>{s.user}@{s.db}</td>
              <td title={s.waitEvent ?? undefined} style={{ color: s.waitEvent?.startsWith('Lock') ? COLOR.warn : undefined }}>
                {s.state}{s.waitEvent ? ` · ${s.waitEvent}` : ''}
              </td>
              <td>{s.queryAgeSec === null ? '—' : fmtDuration(s.queryAgeSec)}</td>
              <td>{s.xactAgeSec === null ? '—' : fmtDuration(s.xactAgeSec)}</td>
              <td style={{ textAlign: 'left' }}>
                <code className="small" title={s.query} style={{ display: 'block', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.query}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
