'use client';

// "Phân tích" lag của một consumer group Kafka (lib/kafkaDiagnose) — chỉ đọc,
// chạy ngay khi mở với group liên quan tới cảnh báo; đổi group / thời gian đo
// thì chạy lại. Kết quả qua DiagnosisView + bảng partition + bảng consumer.

import { useCallback, useEffect, useState } from 'react';
import { kafkaDiagnoseLag, type KafkaLagDiagnosis } from '@/lib/kafka';
import { fmtN } from '@/lib/diagnose';
import DiagnosisView from './DiagnosisView';

const DURATIONS = [10, 15, 30];

interface Props {
  connectionId: string;
  /** Group có lag (từ lần đo gần nhất của Monitor) — nặng nhất trước. */
  groups: { groupId: string; lag: number }[];
  initialGroup: string;
}

export default function KafkaLagDiagnosis({ connectionId, groups, initialGroup }: Props) {
  const [groupId, setGroupId] = useState(initialGroup);
  const [seconds, setSeconds] = useState(15);
  const [state, setState] = useState<{ busy: boolean; data?: KafkaLagDiagnosis; error?: string }>({ busy: true });

  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    kafkaDiagnoseLag(connectionId, groupId, seconds)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId, groupId, seconds]);
  // Chạy ngay khi mở và mỗi khi đổi group / thời gian đo.
  useEffect(run, [run]);

  const d = state.data;
  const pickers = (
    <span className="kld-pick">
      <label className="rmd-dur">
        Group
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={state.busy}>
          {!groups.some((g) => g.groupId === groupId) ? <option value={groupId}>{groupId}</option> : null}
          {groups.map((g) => <option key={g.groupId} value={g.groupId}>{g.groupId} · lag {fmtN(g.lag)}</option>)}
        </select>
      </label>
      <label className="rmd-dur">
        Đo trong
        <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={state.busy}>
          {DURATIONS.map((s) => <option key={s} value={s}>{s} giây</option>)}
        </select>
      </label>
    </span>
  );

  return (
    <DiagnosisView
      title="Phân tích lag"
      busy={state.busy}
      busyText={`Đang đo ${groupId} trong ${seconds} giây (offset + tốc độ từng partition)…`}
      error={state.error}
      data={d}
      onRerun={run}
      nums={d ? (
        <>
          {pickers}
          <span className="kld-nums">
            Lag <b>{fmtN(d.totalLag)}</b> ({d.lagDelta >= 0 ? '+' : ''}{fmtN(d.lagDelta)} trong {d.sec}s)
            {' '}· sản xuất <b>{fmtN(d.produceRate)}</b> / tiêu thụ <b>{fmtN(d.consumeRate)}</b> msg/s
            {' '}· {d.members} consumer / {d.partitionCount} partition
          </span>
        </>
      ) : null}
      extra={d && d.rows.length ? (
        <>
          <div className="pgd-sub">Partition (lag nặng nhất trước)</div>
          <div className="rmd-table-wrap">
            <table className="mon-mini">
              <thead>
                <tr><th>Partition</th><th className="r">Lag</th><th className="r">Sản xuất/s</th><th className="r">Tiêu thụ/s</th><th>Consumer</th><th>Tình trạng</th></tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={`${r.topic}:${r.partition}`} className={r.status === 'Đứng im' || r.status === 'Không có leader' ? 'lv-warn' : ''}>
                    <td><code>{r.topic}:{r.partition}</code></td>
                    <td className="r">{r.lag === null ? '—' : fmtN(r.lag)}</td>
                    <td className="r">{r.produceRate}</td>
                    <td className="r">{r.consumeRate ?? '—'}</td>
                    <td className="kld-owner" title={r.owner ?? ''}>{r.owner ?? <span className="mon-d-faint">không ai</span>}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.memberRows.length ? (
            <>
              <div className="pgd-sub">Consumer trong group</div>
              <div className="rmd-table-wrap">
                <table className="mon-mini">
                  <thead><tr><th>Client</th><th>Host</th><th className="r">Partition được gán</th></tr></thead>
                  <tbody>
                    {d.memberRows.map((m) => (
                      <tr key={m.memberId}><td><code>{m.clientId}</code></td><td>{m.host}</td><td className="r">{m.assigned}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}
      foot={d ? <>lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ đọc offset / metadata, không đổi gì trên cụm.</> : null}
      start={pickers}
    />
  );
}
