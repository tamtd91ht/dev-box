'use client';

// "Sức khoẻ cụm & replication" Kafka (lib/kafkaClusterDiagnose) — chỉ đọc metadata +
// min.insync.replicas, chạy ngay khi mở. Kết quả qua DiagnosisView + bảng broker +
// bảng topic có vấn đề.

import { useCallback, useEffect, useState } from 'react';
import { kafkaDiagnoseCluster, type KafkaClusterDiagnosis } from '@/lib/kafka';
import { fmtN } from '@/lib/diagnose';
import DiagnosisView from '../monitor/DiagnosisView';

const MECHANISM = (
  <>
    <p>
      Chỉ dùng lệnh admin <b>đọc</b>: <code>DescribeCluster</code> (broker, controller), <code>Metadata</code> của mọi topic (leader /
      replicas / ISR từng partition — cùng lệnh producer / consumer gọi định kỳ) và <code>DescribeConfigs</code> chỉ hỏi{' '}
      <code>min.insync.replicas</code> (lô 100 topic, tối đa 2.000). Không đọc message, không join group, không đổi cấu hình.
    </p>
    <ol className="pgd-info-steps">
      <li><b>Offline</b>: partition không có leader → producer / consumer trên đó đang lỗi.</li>
      <li><b>Broker vắng</b>: có trong replica list nhưng không có trong cụm.</li>
      <li><b>Dưới min.insync.replicas</b>: ISR &lt; min ISR → producer acks=all bị từ chối.</li>
      <li><b>Under-replicated</b>: ISR &lt; replicas, gom theo broker có replica ngoài ISR.</li>
      <li><b>Lệch leader</b>: broker giữ leader &gt; 1,5× trung bình, hoặc ≥ 10% partition không do preferred leader giữ.</li>
      <li><b>Cấu hình rủi ro</b>: topic RF = 1, min.insync.replicas ≥ RF, <code>__consumer_offsets</code> RF = 1.</li>
    </ol>
    <p className="mon-d-faint">
      <b>Không phân tích được:</b> throughput / độ trễ request của broker, đĩa / CPU (cần JMX hoặc node_exporter — xem thanh sức khoẻ
      phía trên nếu kết nối có metrics URL), lag của consumer (mục &quot;Lag consumer group&quot;).
    </p>
  </>
);

export default function ClusterDiagnosis({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: KafkaClusterDiagnosis; error?: string }>({ busy: true });

  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    kafkaDiagnoseCluster(connectionId)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId]);
  useEffect(run, [run]);

  const d = state.data;
  return (
    <DiagnosisView
      title="Sức khoẻ cụm & replication"
      busy={state.busy}
      busyText="Đang đọc metadata cụm và cấu hình topic (chỉ đọc)…"
      error={state.error}
      data={d}
      onRerun={run}
      info={MECHANISM}
      infoSummary="Offline, ISR thiếu, dưới min.insync.replicas, broker vắng, lệch leader, cấu hình topic rủi ro — chỉ đọc metadata"
      nums={d ? (
        <>
          {fmtN(d.brokerCount)} broker · {fmtN(d.topicCount)} topic · {fmtN(d.partitionCount)} partition
          {' · '}offline <b className={d.offline ? 'esd-crit' : ''}>{fmtN(d.offline)}</b>
          {' · '}under-replicated <b className={d.underReplicated ? 'esd-warn' : ''}>{fmtN(d.underReplicated)}</b>
          {' · '}dưới min ISR <b className={d.underMinIsr ? 'esd-crit' : ''}>{fmtN(d.underMinIsr)}</b>
        </>
      ) : null}
      extra={d ? (
        <>
          <div className="pgd-sub">Broker</div>
          <div className="rmd-table-wrap">
            <table className="mon-mini">
              <thead><tr><th>Broker</th><th>Địa chỉ</th><th className="r">Leader</th><th className="r">Replica</th><th className="r">Ngoài ISR</th></tr></thead>
              <tbody>
                {d.brokers.map((b) => (
                  <tr key={b.nodeId} className={b.missing ? 'lv-down' : b.outOfIsr ? 'lv-warn' : ''}>
                    <td>{b.nodeId}{b.controller ? <span className="mon-d-faint"> · controller</span> : null}{b.missing ? <b className="esd-crit"> · vắng</b> : null}</td>
                    <td><code>{b.addr}</code></td>
                    <td className="r">{fmtN(b.leaders)}</td>
                    <td className="r">{fmtN(b.replicas)}</td>
                    <td className="r">{b.outOfIsr ? <b className="esd-warn">{fmtN(b.outOfIsr)}</b> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.topicRows.length ? (
            <>
              <div className="pgd-sub">Topic có vấn đề ({fmtN(d.topicRows.length)})</div>
              <div className="rmd-table-wrap rmd-scroll">
                <table className="mon-mini">
                  <thead><tr><th>Topic</th><th className="r">Partition</th><th className="r">RF</th><th className="r">Min ISR</th><th className="r">Offline</th><th className="r">Under-repl.</th><th className="r">Dưới min ISR</th></tr></thead>
                  <tbody>
                    {d.topicRows.map((t) => (
                      <tr key={t.name} className={t.offline || t.underMinIsr ? 'lv-down' : t.underReplicated ? 'lv-warn' : ''}>
                        <td><code>{t.name}</code></td>
                        <td className="r">{fmtN(t.partitions)}</td>
                        <td className="r">{t.rf === 1 ? <b className="esd-warn">1</b> : t.rf}</td>
                        <td className="r">{t.minIsr ?? '?'}</td>
                        <td className="r">{t.offline || ''}</td>
                        <td className="r">{t.underReplicated || ''}</td>
                        <td className="r">{t.underMinIsr || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}
      foot={d ? <>lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ đọc metadata, không đổi gì trên cụm</> : null}
    />
  );
}
