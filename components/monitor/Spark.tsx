'use client';

// Đồ thị nhỏ cho Monitor — SVG thuần, không thư viện.
//   <Spark>     đường + vùng tô dưới đường (kiểu stat panel của Grafana)
//   <Timeline>  dải trạng thái theo thời gian, mỗi mẫu một ô màu (state timeline)

import type { Level } from '@/lib/monitor/status';
import type { Sample } from '@/lib/monitor/useMonitor';
import { LEVEL_LABEL } from '@/lib/monitor/status';

interface SparkProps {
  values: number[];
  width?: number;
  height?: number;
  /** Màu đường — mặc định theo mức hiện tại của tài nguyên. */
  level?: Level;
}

export function Spark({ values, width = 120, height = 28, level = 'ok' }: SparkProps) {
  if (values.length < 2) {
    return <svg className={`mon-spark lv-${level}`} width={width} height={height} aria-hidden />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const step = (width - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => [pad + i * step, height - pad - ((v - min) / span) * (height - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${height} L${pts[0][0].toFixed(1)} ${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className={`mon-spark lv-${level}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path className="mon-spark-area" d={area} />
      <path className="mon-spark-line" d={line} />
      <circle className="mon-spark-dot" cx={lx} cy={ly} r={2.2} />
    </svg>
  );
}

interface TimelineProps {
  samples: Sample[];
  /** Số ô tối đa hiển thị (mẫu cũ hơn bị cắt). */
  max?: number;
}

export function Timeline({ samples, max = 60 }: TimelineProps) {
  const shown = samples.slice(-max);
  if (shown.length === 0) return <div className="mon-timeline empty">Chưa có mẫu nào</div>;
  return (
    <div className="mon-timeline" role="img" aria-label="Lịch sử trạng thái">
      {shown.map((s) => (
        <span
          key={s.at}
          className={`mon-tl-cell lv-${s.level}`}
          title={`${new Date(s.at).toLocaleTimeString('vi-VN')} — ${LEVEL_LABEL[s.level]}`}
        />
      ))}
    </div>
  );
}
