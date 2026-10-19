'use client';

// Thanh chỉ số sức khoẻ dùng chung cho màn Tổng quan của các tab hạ tầng
// (PostgreSQL, MinIO…). Màu lấy từ ĐÚNG luật của Monitor (lib/monitor/status):
// đỏ ở đây là đỏ ở Monitor, không có hai bộ ngưỡng lệch nhau.

import type { InfraStack } from '@/lib/automation/types';
import { levelOf, RULES } from '@/lib/monitor/status';

export type MeterLevel = 'ok' | 'warn' | 'crit';

export const METER_COLOR: Record<MeterLevel, string> = {
  ok: 'var(--ok, #3fb950)',
  warn: 'var(--warn, #d29922)',
  crit: 'var(--err, #f85149)',
};

/** Mức của một chỉ số theo luật của Monitor (không có luật / không có số → ok). */
export function levelFor(stack: InfraStack, metric: string, v: number | null | undefined): MeterLevel {
  if (v === null || v === undefined) return 'ok';
  const rule = RULES[stack].find((r) => r.metric === metric);
  return rule ? levelOf(rule, v) : 'ok';
}

export function Meter({ label, value, text, pct, level, hint }: {
  label: string;
  value?: string;
  text?: string;
  /** 0–100 để vẽ thanh; bỏ trống = chỉ hiện số. */
  pct?: number | null;
  level: MeterLevel;
  hint?: string;
}) {
  return (
    <div className="pg-meter" title={hint}>
      <div className="pg-meter-head">
        <span className="pg-kpi-label">{label}</span>
        <b style={{ color: level === 'ok' ? undefined : METER_COLOR[level] }}>{value ?? '—'}</b>
      </div>
      {pct !== null && pct !== undefined && (
        <div className="pg-meter-bar"><div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: METER_COLOR[level] }} /></div>
      )}
      {text && <div className="pg-meter-sub">{text}</div>}
    </div>
  );
}

/** Một máy từ node_exporter — hình dạng chung của Kafka/Postgres/MinIO. */
export interface HostLike {
  url: string;
  host: string;
  error?: string;
  load1?: number;
  memTotalBytes?: number;
  memAvailableBytes?: number;
  disks?: { mount: string; sizeBytes: number; availBytes: number }[];
  cpuCores?: number;
}

const GB = 1024 ** 3;

export function HostSection({ stack, hosts, hasMetricsUrls, what }: {
  stack: InfraStack;
  hosts: HostLike[];
  /** Connection có khai metricsUrls không — để gợi ý khi chưa có số. */
  hasMetricsUrls: boolean;
  /** Tên dịch vụ trong câu gợi ý ("Postgres", "MinIO"). */
  what: string;
}) {
  if (hosts.length === 0) {
    return (
      <p className="empty" style={{ margin: '10px 0 0', textAlign: 'left' }}>
        {hasMetricsUrls
          ? 'Chưa đọc được máy chủ nào từ node_exporter.'
          : <>Muốn xem <b>đĩa / RAM / CPU</b> của máy chạy {what}: sửa server và điền <b>Metrics URLs</b> (node_exporter, vd <code>http://10.0.0.5:9100/metrics</code>) — không có cách nào đo các chỉ số này từ phía {what}.</>}
      </p>
    );
  }
  return (
    <>
      <div className="status-line" style={{ marginTop: 12 }}><strong>Máy chủ (node_exporter)</strong></div>
      <div className="pg-meters">
        {hosts.map((h) => {
          if (h.error) return <Meter key={h.url} label={h.host} value="không đọc được" level="crit" text={h.error} />;
          const memPct = h.memTotalBytes && h.memAvailableBytes !== undefined
            ? ((h.memTotalBytes - h.memAvailableBytes) / h.memTotalBytes) * 100 : null;
          const load = typeof h.load1 === 'number' && h.cpuCores ? h.load1 / h.cpuCores : null;
          const disk = (h.disks ?? [])
            .filter((d) => d.sizeBytes > 0)
            .map((d) => ({ ...d, pct: ((d.sizeBytes - d.availBytes) / d.sizeBytes) * 100 }))
            .sort((a, b) => b.pct - a.pct)[0];
          return (
            <div key={h.url} className="pg-meters-host">
              <div className="pg-kpi-label" style={{ marginBottom: 4 }}>{h.host}</div>
              <div className="pg-meters">
                {disk && (
                  <Meter
                    label={`Đĩa ${disk.mount}`}
                    value={`${disk.pct.toFixed(1)}%`}
                    pct={disk.pct}
                    level={levelFor(stack, 'hostDiskUsedPct', disk.pct)}
                    text={`còn trống ${(disk.availBytes / GB).toFixed(1)} GB / ${(disk.sizeBytes / GB).toFixed(0)} GB`}
                    hint="Phân vùng chật nhất của máy"
                  />
                )}
                {memPct !== null && (
                  <Meter
                    label="RAM"
                    value={`${memPct.toFixed(1)}%`}
                    pct={memPct}
                    level={levelFor(stack, 'hostMemUsedPct', memPct)}
                    text={h.memTotalBytes ? `tổng ${(h.memTotalBytes / GB).toFixed(1)} GB` : undefined}
                  />
                )}
                {load !== null && (
                  <Meter
                    label="Load / core"
                    value={load.toFixed(2)}
                    level={levelFor(stack, 'hostLoad1PerCore', load)}
                    text={`load1 ${h.load1?.toFixed(2)} · ${h.cpuCores} core`}
                    hint="load trung bình 1 phút chia số core; > 1 là có việc xếp hàng chờ CPU"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
