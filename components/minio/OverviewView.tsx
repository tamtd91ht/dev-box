'use client';

// Overview: health KPIs, cluster capacity / drives / nodes (Prometheus metrics —
// cần token hoặc MINIO_PROMETHEUS_AUTH_TYPE=public), host metrics (node_exporter)
// và bảng bucket. Dung lượng từng bucket lấy từ metrics khi có; không thì bấm
// "Tính dung lượng" để quét theo yêu cầu (quét đệ quy tốn thời gian nên không tự chạy).
// Màu các thanh lấy từ ĐÚNG luật của Monitor (xem components/health/Meters).

import { useState } from 'react';
import {
  fmtBytes,
  minioBucketStats,
  type MinioBucketInfo,
  type MinioHostMetrics,
  type MinioMetrics,
  type MinioTestResult,
} from '@/lib/minio';
import { HostSection, levelFor, Meter } from '../health/Meters';

export interface OverviewViewProps {
  connectionId: string;
  info: MinioTestResult | null;
  metrics: MinioMetrics | null;
  hosts: MinioHostMetrics[];
  hasMetricsUrls: boolean;
  buckets: MinioBucketInfo[];
  loading: boolean;
  onReload: () => void;
  onOpenBucket: (bucket: string) => void;
}

interface Stat { objects: number; sizeBytes: number; truncated: boolean }

const pctOf = (used: number, total: number): number => (total > 0 ? (used / total) * 100 : 0);

export default function OverviewView({ connectionId, info, metrics, hosts, hasMetricsUrls, buckets, loading, onReload, onOpenBucket }: OverviewViewProps) {
  const [stats, setStats] = useState<Record<string, Stat | 'busy' | 'err'>>({});

  async function calc(name: string) {
    setStats((s) => ({ ...s, [name]: 'busy' }));
    try {
      const r = await minioBucketStats(connectionId, name);
      setStats((s) => ({ ...s, [name]: r }));
    } catch {
      setStats((s) => ({ ...s, [name]: 'err' }));
    }
  }

  if (loading && !info) return <p className="empty"><span className="spinner" /> Đang tải…</p>;

  const usage = new Map((metrics?.bucketUsage ?? []).map((u) => [u.bucket, u]));
  const biggest = Math.max(0, ...(metrics?.bucketUsage ?? []).map((u) => u.sizeBytes));

  return (
    <div className="pg-overview">
      {info && (
        <div className="pg-kpis">
          <div className="pg-kpi"><span className="pg-kpi-label">Server</span><b>{info.server ?? 'S3'}</b></div>
          <div className="pg-kpi"><span className="pg-kpi-label">Bucket</span><b>{info.buckets}</b></div>
          <div className="pg-kpi"><span className="pg-kpi-label">Ping</span><b>{info.latencyMs}ms</b></div>
          <div className="pg-kpi">
            <span className="pg-kpi-label">Sức khoẻ</span>
            <b style={{ color: info.live && info.clusterOk ? 'var(--ok)' : 'var(--err)' }}>
              {!info.live ? 'live: lỗi' : info.clusterOk ? 'ổn' : 'thiếu quorum'}
            </b>
          </div>
          {info.deploymentId && (
            <div className="pg-kpi"><span className="pg-kpi-label">Deployment</span><b className="mono" title={info.deploymentId}>{info.deploymentId.slice(0, 8)}…</b></div>
          )}
        </div>
      )}

      <ClusterSection metrics={metrics} />
      <HostSection stack="minio" what="MinIO" hosts={hosts} hasMetricsUrls={hasMetricsUrls} />

      <div className="status-line" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <strong>Buckets ({buckets.length})</strong>
        <button className="chip-btn" onClick={onReload} disabled={loading}>↻</button>
      </div>
      <table className="pg-table">
        <thead>
          <tr><th style={{ textAlign: 'left' }}>Bucket</th><th>Tạo lúc</th><th>Object</th><th>Dung lượng</th></tr>
        </thead>
        <tbody>
          {buckets.map((b) => {
            const m = usage.get(b.name);
            const st = stats[b.name];
            return (
              <tr key={b.name}>
                <td style={{ textAlign: 'left' }}>
                  <button className="pg-link" onClick={() => onOpenBucket(b.name)}>{b.name}</button>
                </td>
                <td>{b.createdAt ? new Date(b.createdAt).toLocaleDateString('vi-VN') : '—'}</td>
                {m ? (
                  <>
                    <td>{m.objects === null ? '—' : m.objects.toLocaleString('vi-VN')}</td>
                    <td style={{ minWidth: 150 }}>
                      {fmtBytes(m.sizeBytes)}
                      <div className="pg-meter-bar" style={{ marginTop: 3 }}>
                        <div style={{ width: `${pctOf(m.sizeBytes, biggest)}%`, background: 'var(--accent, #6c8cff)' }} />
                      </div>
                    </td>
                  </>
                ) : typeof st === 'object' ? (
                  <>
                    <td>{st.objects.toLocaleString('vi-VN')}{st.truncated ? '+' : ''}</td>
                    <td>{fmtBytes(st.sizeBytes)}{st.truncated ? '+' : ''}</td>
                  </>
                ) : (
                  <td colSpan={2}>
                    <button className="chip-btn" disabled={st === 'busy'} onClick={() => void calc(b.name)}>
                      {st === 'busy' ? <><span className="spinner" /> đang quét…</> : st === 'err' ? 'lỗi — thử lại' : 'Tính dung lượng'}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
          {buckets.length === 0 && !loading && (
            <tr><td colSpan={4} className="empty">Chưa có bucket nào (hoặc key không có quyền liệt kê).</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ClusterSection({ metrics }: { metrics: MinioMetrics | null }) {
  if (!metrics) return null;
  if (!metrics.available) {
    return (
      <p className="empty" style={{ margin: '10px 0 0', textAlign: 'left' }}>
        <b>Chưa đọc được metrics cụm</b> (dung lượng, ổ đĩa, node) — {metrics.reason}.{' '}
        Sửa server → mục <b>Giám sát</b> để điền Metrics URL / token. <span className="small mono" title="URL đã thử">{metrics.source}</span>
      </p>
    );
  }
  const m = metrics;
  const total = m.usableTotalBytes ?? 0;
  const free = m.usableFreeBytes ?? 0;
  const usedPct = total > 0 ? pctOf(total - free, total) : null;
  const drivesTotal = m.drivesTotal ?? ((m.drivesOnline ?? 0) + (m.drivesOffline ?? 0));
  const nodesTotal = (m.nodesOnline ?? 0) + (m.nodesOffline ?? 0);
  return (
    <>
      <div className="status-line" style={{ marginTop: 12 }}><strong>Cụm MinIO</strong></div>
      <div className="pg-meters">
        {usedPct !== null && (
          <Meter
            label="Dung lượng khả dụng"
            value={`${usedPct.toFixed(1)}%`}
            pct={usedPct}
            level={levelFor('minio', 'diskUsedPct', usedPct)}
            text={`${fmtBytes(total - free)} / ${fmtBytes(total)} · còn ${fmtBytes(free)}`}
            hint="Dung lượng dữ liệu đã dùng so với dung lượng khả dụng (sau erasure coding)"
          />
        )}
        {m.rawTotalBytes !== undefined && m.rawFreeBytes !== undefined && m.rawTotalBytes > 0 && (
          <Meter
            label="Dung lượng thô"
            value={fmtBytes(m.rawTotalBytes)}
            text={`còn trống ${fmtBytes(m.rawFreeBytes)} (tính cả phần dự phòng)`}
            level="ok"
          />
        )}
        {drivesTotal > 0 && (
          <Meter
            label="Ổ đĩa"
            value={`${m.drivesOnline ?? 0} / ${drivesTotal} online`}
            pct={pctOf(m.drivesOnline ?? 0, drivesTotal)}
            level={levelFor('minio', 'drivesOffline', m.drivesOffline ?? 0)}
            text={m.drivesOffline ? `${m.drivesOffline} ổ offline` : 'tất cả ổ hoạt động'}
          />
        )}
        {nodesTotal > 0 && (
          <Meter
            label="Node"
            value={`${m.nodesOnline ?? 0} / ${nodesTotal} online`}
            pct={pctOf(m.nodesOnline ?? 0, nodesTotal)}
            level={levelFor('minio', 'nodesOffline', m.nodesOffline ?? 0)}
            text={m.nodesOffline ? `${m.nodesOffline} node offline` : 'tất cả node hoạt động'}
          />
        )}
        {m.objects !== undefined && (
          <Meter
            label="Tổng object"
            value={m.objects.toLocaleString('vi-VN')}
            level="ok"
            text={m.usedBytes !== undefined ? `dữ liệu ${fmtBytes(m.usedBytes)}` : undefined}
            hint="Số liệu do MinIO scanner cập nhật định kỳ nên có thể trễ vài phút"
          />
        )}
      </div>
    </>
  );
}
