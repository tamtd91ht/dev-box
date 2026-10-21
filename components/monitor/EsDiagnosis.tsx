'use client';

// "Phân tích" cụm Elasticsearch (lib/esDiagnose): heap / GC, shard chưa gán
// (lời giải thích của ES), CPU (việc gì đang ăn), đĩa so với watermark,
// thread pool bị từ chối, pending task. Toàn GET — chạy ngay khi mở.
// Kết quả qua DiagnosisView + bảng node.

import { useCallback, useEffect, useState } from 'react';
import { esDiagnose, type EsDiagnosis } from '@/lib/es';
import DiagnosisView from './DiagnosisView';

const lv = (v: number | null, warn: number, crit: number): string =>
  v === null ? '' : v >= crit ? 'esd-crit' : v >= warn ? 'esd-warn' : '';

export default function EsDiagnosisPanel({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: EsDiagnosis; error?: string }>({ busy: true });

  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    esDiagnose(connectionId)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId]);
  useEffect(run, [run]);

  const d = state.data;
  return (
    <DiagnosisView
      title="Phân tích cụm Elasticsearch"
      busy={state.busy}
      busyText="Đang đọc trạng thái cụm và đo GC / request bị từ chối trong 5 giây…"
      error={state.error}
      data={d}
      onRerun={run}
      nums={d ? <>Trạng thái <b className={`esd-status esd-${d.status}`}>{d.status}</b> · {d.nodes.length} node · đo trong {d.windowSec}s</> : null}
      extra={d && d.nodes.length ? (
        <>
          <div className="pgd-sub">Node</div>
          <div className="rmd-table-wrap">
            <table className="mon-mini">
              <thead>
                <tr>
                  <th>Node</th><th className="r">Heap</th><th className="r">GC old</th><th className="r">CPU</th>
                  <th className="r">Đĩa</th><th className="r">Shard</th><th className="r">Từ chối</th><th>Bận việc</th>
                </tr>
              </thead>
              <tbody>
                {d.nodes.map((n) => (
                  <tr key={n.name}>
                    <td title={n.roles}><code>{n.name}</code></td>
                    <td className={`r ${lv(n.heapPct, 85, 95)}`}>{n.heapPct ?? '?'}%</td>
                    <td className={`r ${lv(n.gcOldPct, 5, 15)}`} title="% thời gian cửa sổ đo nằm trong GC old gen">{n.gcOldPct}%</td>
                    <td className={`r ${lv(n.cpu, 85, 95)}`}>{n.cpu ?? '?'}%</td>
                    <td className={`r ${lv(n.diskPct, 85, 90)}`}>{n.diskPct ?? '?'}%</td>
                    <td className="r">{n.shards}</td>
                    <td className={`r ${n.rejected ? 'esd-crit' : ''}`}>{n.rejected}</td>
                    <td>{n.top ?? <span className="mon-d-faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      foot={d ? <>lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ dùng lệnh GET, không đổi gì trên cụm.</> : null}
    />
  );
}
