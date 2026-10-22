'use client';

// "Phân tích" phân mảnh bộ nhớ Redis (lib/redisFragDiagnose) — chạy ngay khi mở vì
// chỉ đọc (INFO + CONFIG GET, mỗi node có timeout), không đổi gì trên server.
// Kết quả hiển thị qua DiagnosisView + bảng từng node.

import { useCallback, useEffect, useState } from 'react';
import { redisDiagnoseFrag, type RedisFragDiagnosis } from '@/lib/redis';
import { fmtBytes } from '@/lib/diagnose';
import DiagnosisView from './DiagnosisView';

/** Giải thích cơ chế — khớp với lib/redisFragDiagnose.ts + lib/redisFragRules.ts. */
const MECHANISM = (
  <>
    <p>
      <b>Tỉ lệ phân mảnh</b> = RSS (RAM tiến trình thật sự chiếm) / <code>used_memory</code> (dữ liệu Redis cấp phát). Tỉ lệ cao chưa
      nói phần thừa nằm ở đâu, nên app tách nó theo các số <code>INFO memory</code> đã báo sẵn:
    </p>
    <ol className="pgd-info-steps">
      <li><b>Lỗ giữa các object</b> (<code>allocator_frag</code>): xoá / hết hạn / đổi kích thước để lại chỗ trống không dùng được → <code>activedefrag</code>.</li>
      <li><b>Trang chưa trả OS</b> (<code>allocator_rss</code>): jemalloc giữ trang trống sau khi xoá nhiều → <code>MEMORY PURGE</code>.</li>
      <li><b>Ngoài allocator</b> (<code>rss_overhead</code>): copy-on-write khi BGSAVE / AOF rewrite, Transparent Huge Pages, Lua, module.</li>
      <li><b>Tỉ lệ &lt; 1</b>: RSS nhỏ hơn dữ liệu = một phần đã bị đẩy ra swap — nặng hơn phân mảnh.</li>
      <li><b>Dữ liệu nhỏ</b> (&lt; 256 MB hoặc thừa &lt; 100 MB): tỉ lệ cao chỉ do phần RSS cố định của tiến trình — không cần xử lý.</li>
    </ol>
    <p>
      Thêm <code>INFO stats</code> đọc hai lần cách 3 giây để biết activedefrag có đang dời object không, và{' '}
      <code>CONFIG GET</code> các tham số activedefrag để biết vì sao nó chạy / không chạy.
    </p>
    <p className="mon-d-faint">
      <b>An toàn production:</b> chỉ <code>INFO</code> từng section và <code>CONFIG GET</code> đúng tên — lệnh O(1), không <code>SCAN</code>,
      không <code>MEMORY USAGE</code> / <code>MALLOC-STATS</code>, không đổi cấu hình. Mỗi node có hạn 5 giây, node treo thì bỏ qua và báo.
      Lệnh sửa (activedefrag, MEMORY PURGE) chỉ được đề xuất kèm lưu ý chạy lúc thấp điểm — app không tự chạy.
    </p>
  </>
);

export default function RedisFragDiagnosis({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: RedisFragDiagnosis; error?: string }>({ busy: true });

  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    redisDiagnoseFrag(connectionId)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId]);
  useEffect(run, [run]);

  const d = state.data;
  const w = d?.nodes[0];
  return (
    <DiagnosisView
      title="Phân tích phân mảnh"
      busy={state.busy}
      busyText="Đang đọc INFO memory / stats và cấu hình activedefrag (khoảng 3–5 giây, chỉ đọc)…"
      error={state.error}
      data={d}
      onRerun={run}
      info={MECHANISM}
      infoSummary="Tách RSS thừa thành lỗ giữa object / trang chưa trả OS / ngoài allocator — chỉ đọc INFO + CONFIG GET"
      nums={w ? (
        <>
          Tỉ lệ: <b>{w.ratio ?? '?'}</b> · Thừa: <b>{fmtBytes(w.fragBytes)}</b> · Dữ liệu {fmtBytes(w.used)} · RSS {fmtBytes(w.rss)}
          {w.peak > w.used ? ` · đỉnh ${fmtBytes(w.peak)}` : ''}
        </>
      ) : null}
      extra={d && d.nodes.length > 1 ? (
        <>
          <div className="pgd-sub">Từng node</div>
          <div className="rmd-table-wrap">
            <table className="mon-mini rmd-table">
              <thead>
                <tr><th>Node</th><th className="r">Tỉ lệ</th><th className="r">Thừa</th><th className="r">Dữ liệu</th><th>Phần lớn nhất</th><th>activedefrag</th></tr>
              </thead>
              <tbody>
                {d.nodes.map((n) => (
                  <tr key={n.addr}>
                    <td><code>{n.addr}</code></td>
                    <td className="r">{n.ratio ?? '?'}</td>
                    <td className="r">{fmtBytes(n.fragBytes)}</td>
                    <td className="r">{fmtBytes(n.used)}</td>
                    <td>{n.verdict}</td>
                    <td>{n.defrag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      foot={d ? (
        <>
          lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ đọc INFO + CONFIG GET, không đổi gì trên server
          {d.skipped.length ? <> · bỏ qua: {d.skipped.map((s) => `${s.addr} (${s.error})`).join('; ')}</> : null}
        </>
      ) : null}
    />
  );
}
