'use client';

// "Phân tích" cụm Elasticsearch (lib/esDiagnose) — chạy được cả khi cụm XANH
// (truy vấn chậm mà không có cảnh báo nào): heap / GC, shard chưa gán (lời giải
// thích của ES), CPU (việc gì đang ăn), đĩa so với watermark, thread pool bị từ
// chối, query đang chạy lâu, index / node chậm. Chỉ đọc thống kê, không chặn
// cụm; hot_threads (lấy mẫu stack) chỉ chạy khi người dùng bật hẳn.

import { useCallback, useEffect, useState } from 'react';
import { esDiagnose, type EsDiagnosis } from '@/lib/es';
import { fmtN } from '@/lib/diagnose';
import DiagnosisView from './DiagnosisView';

const lv = (v: number | null, warn: number, crit: number): string =>
  v === null ? '' : v >= crit ? 'esd-crit' : v >= warn ? 'esd-warn' : '';

export default function EsDiagnosisPanel({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: EsDiagnosis; error?: string }>({ busy: true });
  const [hotThreads, setHotThreads] = useState(false);

  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    esDiagnose(connectionId, hotThreads)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId, hotThreads]);
  // Chỉ tự chạy lần đầu; bật hot_threads xong người dùng bấm "Phân tích lại".
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(run, [connectionId]);

  const d = state.data;
  return (
    <DiagnosisView
      title="Phân tích cụm Elasticsearch"
      busy={state.busy}
      busyText="Đang đọc thống kê cụm và đo truy vấn / GC / request bị từ chối trong 8 giây…"
      error={state.error}
      data={d}
      onRerun={run}
      nums={d ? <>Trạng thái <b className={`esd-status esd-${d.status}`}>{d.status}</b> · {d.nodes.length} node · đo trong {d.windowSec}s</> : null}
      extra={d ? (
        <>
          {d.running.length ? (
            <>
              <div className="pgd-sub">Truy vấn đang chạy lâu</div>
              <div className="rmd-table-wrap">
                <table className="mon-mini">
                  <thead><tr><th className="r">Đã chạy</th><th>Index</th><th>Node</th><th>Dấu hiệu</th><th>Query</th></tr></thead>
                  <tbody>
                    {d.running.map((r) => (
                      <tr key={r.taskId} className={r.ms >= 30_000 ? 'lv-warn' : ''}>
                        <td className="r">{Math.round(r.ms / 1000)}s</td>
                        <td><code>{r.indices}</code></td>
                        <td>{r.node}</td>
                        <td>{r.flags.join(', ') || <span className="mon-d-faint">—</span>}</td>
                        <td className="esd-query" title={r.query}><code>{r.query.slice(0, 160)}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {d.slowIndices.length ? (
            <>
              <div className="pgd-sub">Index theo tốc độ truy vấn (trong {d.windowSec}s)</div>
              <div className="rmd-table-wrap">
                <table className="mon-mini">
                  <thead><tr><th>Index</th><th className="r">ms / lượt query (shard)</th><th className="r">Số lượt</th></tr></thead>
                  <tbody>
                    {d.slowIndices.map((x) => (
                      <tr key={x.index}><td><code>{x.index}</code></td><td className={`r ${lv(x.avgMs, 100, 500)}`}>{fmtN(x.avgMs)}</td><td className="r">{fmtN(x.queries)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {d.nodes.length ? (
            <>
              <div className="pgd-sub">Node</div>
              <div className="rmd-table-wrap">
                <table className="mon-mini">
                  <thead>
                    <tr>
                      <th>Node</th><th className="r">Heap</th><th className="r">GC old</th><th className="r">CPU</th>
                      <th className="r">Đĩa</th><th className="r">Shard</th><th className="r">ms/query</th><th className="r">Từ chối</th><th>Bận việc</th>
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
                        <td className={`r ${lv(n.queryMs, 100, 500)}`} title="ms trung bình mỗi lượt query trên shard trong cửa sổ đo">{n.queryMs ?? '—'}</td>
                        <td className={`r ${n.rejected ? 'esd-crit' : ''}`}>{n.rejected}</td>
                        <td>{n.top ?? <span className="mon-d-faint">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}
      foot={d ? (
        <>
          <label className="rmd-dur esd-hot" title="Lấy mẫu stack mọi luồng trên mọi node (5 lần trong 500ms) — mỗi lần là một safepoint JVM rất ngắn. Chỉ bật khi cần biết chính xác luồng nào ăn CPU.">
            <input type="checkbox" checked={hotThreads} onChange={(e) => setHotThreads(e.target.checked)} disabled={state.busy} />
            Kèm hot_threads ở lần phân tích sau
          </label>
          {' '}· lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ đọc thống kê ES, không chặn cụm, không đổi gì.
          {d.skipped.length ? <> · Bỏ qua: {d.skipped.join('; ')}.</> : null}
        </>
      ) : null}
    />
  );
}
