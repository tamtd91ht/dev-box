'use client';

// Overview: server version KPI + databases table (name, size on disk).
// Clicking a database jumps to the Data browser scoped to it.

import { fmtBytes, type PgTestResult, type PgDatabaseInfo } from '@/lib/pg';

export interface OverviewViewProps {
  info: PgTestResult | null;
  databases: PgDatabaseInfo[];
  loading: boolean;
  onReload: () => void;
  onOpenDb: (db: string) => void;
}

export default function OverviewView({ info, databases, loading, onReload, onOpenDb }: OverviewViewProps) {
  if (loading && !info) return <p className="empty"><span className="spinner" /> Đang tải…</p>;

  return (
    <div className="pg-overview">
      {info && (
        <div className="pg-kpis">
          <div className="pg-kpi"><span className="pg-kpi-label">Version</span><b>PostgreSQL {info.version}</b></div>
          <div className="pg-kpi"><span className="pg-kpi-label">Default DB</span><b>{info.database}</b></div>
          <div className="pg-kpi"><span className="pg-kpi-label">Ping</span><b>{info.latencyMs}ms</b></div>
        </div>
      )}

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
