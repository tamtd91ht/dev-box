'use client';

// "Phân tích" hit rate thấp của Redis (lib/redisDiagnose): dạng key nào đang
// miss và vì sao. Khác PostgreSQL ở chỗ phải BẬT TẠM notify-keyspace-events
// trên server trong vài giây — nên hỏi xác nhận trước, nói rõ sẽ đổi gì và
// trả lại thế nào. Kết quả hiển thị qua DiagnosisView + bảng dạng key.

import { useCallback, useState } from 'react';
import { redisDiagnoseMisses, type RedisMissDiagnosis } from '@/lib/redis';
import { fmtN } from '@/lib/diagnose';
import DiagnosisView from './DiagnosisView';

const DURATIONS = [10, 30, 60];

export default function RedisMissDiagnosis({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: RedisMissDiagnosis; error?: string }>({ busy: false });
  const [seconds, setSeconds] = useState(10);

  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    redisDiagnoseMisses(connectionId, seconds)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId, seconds]);

  const d = state.data;
  const durationPick = (
    <label className="rmd-dur">
      Thời gian bắt
      <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={state.busy}>
        {DURATIONS.map((s) => <option key={s} value={s}>{s} giây</option>)}
      </select>
    </label>
  );

  return (
    <DiagnosisView
      title="Phân tích hit rate"
      busy={state.busy}
      busyText={`Đang bắt key bị miss trong ${seconds} giây, rồi quét keyspace có giới hạn…`}
      error={state.error}
      data={d}
      onRerun={run}
      start={(
        <div className="rmd-confirm">
          <p>
            Để biết <b>dạng key nào</b> đang miss, app sẽ <b>bật tạm</b> cờ <code>Em</code> của{' '}
            <code>notify-keyspace-events</code> trên server trong thời gian bắt, nghe sự kiện{' '}
            <code>keymiss</code>, rồi <b>trả lại giá trị cũ</b> ngay khi xong (kể cả khi lỗi).
          </p>
          <p className="mon-d-faint">
            Chỉ đọc TÊN key bị miss, không đọc giá trị. Sau đó quét SCAN tối đa 200.000 key (không dùng KEYS) để
            đếm key cùng dạng và lấy mẫu TTL. Cần Redis ≥ 6.0.
          </p>
          <div className="rmd-actions">
            {durationPick}
            <button type="button" className="mon-btn primary" onClick={run}>🔍 Bắt đầu phân tích</button>
          </div>
        </div>
      )}
      nums={d ? (
        <>
          Hiện tại: <b>{d.currentPct === null ? 'chưa đo được' : `${d.currentPct}%`}</b>
          {d.windowSec ? ` (trong ${d.windowSec}s)` : ''} · Cộng dồn: <b>{d.cumulativePct ?? '?'}%</b>
          {' '}· Bắt được <b>{fmtN(d.captured)}</b> miss
        </>
      ) : null}
      extra={d && d.patterns.length ? (
        <>
          <div className="pgd-sub">Dạng key bị miss</div>
          <div className="rmd-table-wrap">
            <table className="mon-mini rmd-table">
              <thead>
                <tr><th>Dạng key</th><th className="r">Miss</th><th className="r">Key</th><th className="r">Đang có</th><th>Phán đoán</th></tr>
              </thead>
              <tbody>
                {d.patterns.map((p) => (
                  <tr key={`${p.db}|${p.pattern}`} title={`Ví dụ: ${p.samples.join('\n')}`}>
                    <td><code>{p.pattern}</code>{p.db ? <span className="mon-d-faint"> · db {p.db}</span> : null}</td>
                    <td className="r">{fmtN(p.misses)} <span className="mon-d-faint">({p.sharePct}%)</span></td>
                    <td className="r">{fmtN(p.distinct)}</td>
                    <td className="r">{p.existing === null ? '?' : fmtN(p.existing)}</td>
                    <td>{p.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      foot={d ? (
        <>
          {durationPick}
          {' '}· lúc {new Date(d.at).toLocaleTimeString('vi-VN')} ·{' '}
          {d.findings.some((f) => f.id === 'restore')
            ? <b className="pgd-error">CHƯA trả lại được notify-keyspace-events — xem mục đỏ</b>
            : 'đã trả lại notify-keyspace-events như cũ.'}
        </>
      ) : null}
    />
  );
}
