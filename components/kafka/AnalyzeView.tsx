'use client';

// Tab "Phân tích" của từng cụm Kafka. Bên trái chọn mục, bên phải là nội dung; chọn
// mục nào mới chạy mục đó. Mọi mục đều CHỈ ĐỌC (lệnh admin đọc metadata / offset,
// bắt tay TCP) — không join consumer group, không commit offset, không đổi cấu hình,
// nên group đang chạy trên production không hề biết có người đo.
//   • Sức khoẻ cụm & replication — components/kafka/ClusterDiagnosis.
//   • Lag consumer group — bảng group đang lag (cùng lệnh tab Lag), chọn một group
//     để phân tích sâu bằng bộ của Monitor (components/monitor/KafkaLagDiagnosis).
//   • Kết nối broker — bắt tay TCP từng seed broker + một câu Kafka + DNS.
// Đổi cụm → về trạng thái chưa chọn (component được key theo cụm ở KafkaWorkspace).

import { useCallback, useEffect, useState } from 'react';
import { kafkaBrokerReach, kafkaConsumerLag, type KafkaConsumerLag, type KafkaReachReport } from '@/lib/kafka';
import { fmtN, fmtSec } from '@/lib/diagnose';
import ClusterDiagnosis from './ClusterDiagnosis';
import KafkaLagDiagnosis from '../monitor/KafkaLagDiagnosis';

type Kind = 'cluster' | 'lag' | 'reach';

const ITEMS: { kind: Kind; icon: string; label: string; desc: string }[] = [
  { kind: 'cluster', icon: '🧬', label: 'Sức khoẻ cụm & replication', desc: 'Partition offline, ISR thiếu, broker vắng, lệch leader, cấu hình topic rủi ro.' },
  { kind: 'lag', icon: '⏳', label: 'Lag consumer group', desc: 'Group nào đang lag, vì sao: không ai tiêu thụ, consumer kẹt / chậm, dồn partition, rebalance.' },
  { kind: 'reach', icon: '🔌', label: 'Kết nối broker', desc: 'Bắt tay TCP từng seed broker, cụm có trả lời giao thức không, advertised.listeners, DNS.' },
];

export default function AnalyzeView({ connectionId }: { connectionId: string }) {
  const [kind, setKind] = useState<Kind | null>(null);

  return (
    <div className="redis-diag">
      <nav className="redis-diag-nav" aria-label="Chọn nội dung phân tích">
        {ITEMS.map((it) => (
          <button
            key={it.kind}
            type="button"
            className={`redis-diag-item${kind === it.kind ? ' on' : ''}`}
            onClick={() => setKind(it.kind)}
            aria-current={kind === it.kind}
          >
            <span className="redis-diag-ico" aria-hidden>{it.icon}</span>
            <span>
              <b>{it.label}</b>
              <small>{it.desc}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="redis-diag-body">
        {!kind ? (
          <div className="empty" style={{ padding: '32px 8px' }}>
            <div className="empty-ico">🔍</div>
            <p className="small">Chọn một mục bên trái để phân tích. Mục nào chọn mới chạy mục đó — chỉ đọc, không join group, không commit offset, không đổi cấu hình.</p>
          </div>
        ) : null}
        {kind === 'cluster' ? <ClusterDiagnosis connectionId={connectionId} /> : null}
        {kind === 'lag' ? <LagPicker connectionId={connectionId} /> : null}
        {kind === 'reach' ? <BrokerReach connectionId={connectionId} /> : null}
      </div>
    </div>
  );
}

/** Bảng group đang lag → chọn một group để phân tích sâu. */
function LagPicker({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: KafkaConsumerLag; error?: string }>({ busy: true });
  const [group, setGroup] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const load = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    kafkaConsumerLag(connectionId)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId]);
  useEffect(load, [load]);

  const sorted = [...(state.data?.groups ?? [])].sort((a, b) => b.totalLag - a.totalLag);
  const lagged = sorted.filter((g) => g.totalLag > 0 && !g.error);
  const shown = all ? sorted : lagged;

  if (group) {
    return (
      <>
        <button type="button" className="mon-btn" style={{ marginBottom: 10 }} onClick={() => setGroup(null)}>← Chọn group khác</button>
        <KafkaLagDiagnosis
          key={group}
          connectionId={connectionId}
          groups={(lagged.some((g) => g.groupId === group) ? lagged : [...lagged, ...sorted.filter((g) => g.groupId === group)])
            .map((g) => ({ groupId: g.groupId, lag: g.totalLag }))}
          initialGroup={group}
        />
      </>
    );
  }

  return (
    <section className="pgd">
      <h4>
        Lag consumer group
        <span className="pgd-head-acts">
          <label className="rmd-dur"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Hiện cả group không lag</label>
          <button type="button" className="mon-btn" onClick={load} disabled={state.busy}>{state.busy ? '⟳ Đang đọc…' : '⟳ Đọc lại'}</button>
        </span>
      </h4>
      {state.error ? <p className="pgd-error">Không đọc được lag: {state.error}</p> : null}
      {state.busy && !state.data ? <p className="mon-d-faint">Đang đọc offset đã commit + log-end của mọi group (chỉ đọc)…</p> : null}
      {state.data ? (
        <>
          <p className="mon-d-faint">
            {fmtN(lagged.length)} / {fmtN(sorted.length)} group đang lag
            {state.data.skippedGroups ? ` · bỏ qua ${fmtN(state.data.skippedGroups)} group (quá giới hạn)` : ''}.
            {' '}Chọn một group để đo hai lần cách vài giây → tốc độ sản xuất / tiêu thụ, consumer nào giữ partition nào, rebalance, tuổi message chờ.
          </p>
          {shown.length ? (
            <div className="rmd-table-wrap rmd-scroll">
              <table className="mon-mini">
                <thead><tr><th>Group</th><th>Trạng thái</th><th className="r">Consumer</th><th className="r">Lag</th><th>Topic lag nhất</th><th className="r">Chờ lâu nhất</th><th /></tr></thead>
                <tbody>
                  {shown.map((g) => (
                    <tr key={g.groupId} className={g.error ? 'lv-down' : g.totalLag > 0 && (g.members === 0 || g.stalledSec) ? 'lv-warn' : ''}>
                      <td><code>{g.groupId}</code></td>
                      <td>{g.error ? <span className="esd-crit" title={g.error}>lỗi</span> : g.described ? g.state : '?'}</td>
                      <td className="r">{g.described ? fmtN(g.members) : '?'}</td>
                      <td className="r">{fmtN(g.totalLag)}</td>
                      <td>{g.worstTopic ? <><code>{g.worstTopic}</code> <span className="mon-d-faint">({fmtN(g.worstTopicLag)})</span></> : '—'}</td>
                      <td className="r">{g.stalledSec ? fmtSec(g.stalledSec) : '—'}</td>
                      <td><button type="button" className="mon-btn" onClick={() => setGroup(g.groupId)} disabled={!!g.error}>🔍 Phân tích</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="mon-d-faint">Không group nào đang lag.</p>}
        </>
      ) : null}
    </section>
  );
}

/** Bắt tay TCP từng seed broker + một câu Kafka + DNS. */
function BrokerReach({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: KafkaReachReport; error?: string }>({ busy: true });
  const load = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    kafkaBrokerReach(connectionId)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId]);
  useEffect(load, [load]);

  const d = state.data;
  const down = d?.brokers.filter((b) => !b.reachable).length ?? 0;
  return (
    <section className="pgd">
      <h4>
        Kết nối broker
        <span className="pgd-head-acts">
          <button type="button" className="mon-btn" onClick={load} disabled={state.busy}>{state.busy ? '⟳ Đang đo…' : '⟳ Đo lại'}</button>
        </span>
      </h4>
      {state.error ? <p className="pgd-error">Không đo được: {state.error}</p> : null}
      {state.busy && !d ? <p className="mon-d-faint">Đang bắt tay TCP từng seed broker (hạn 3 giây mỗi broker)…</p> : null}
      {d ? (
        <>
          <p className="pgd-headline">
            {down === 0
              ? d.protocol?.spoke === false ? 'Cổng mở nhưng cụm không trả lời giao thức Kafka' : 'Mọi seed broker mở cổng, cụm trả lời bình thường'
              : down === d.brokers.length ? 'Không seed broker nào mở cổng — cụm không tới được từ DevBox' : `${down} / ${d.brokers.length} seed broker không tới được`}
          </p>
          <table className="mon-mini">
            <tbody>
              {d.brokers.map((b) => (
                <tr key={b.addr} className={b.reachable ? '' : 'lv-down'}>
                  <td><code>{b.addr}</code></td>
                  <td>{b.reachable ? `mở cổng · ${b.latencyMs ?? '?'} ms` : <span className="esd-crit">{b.error ?? 'không tới được'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.protocol ? (
            <p className="mon-d-faint" style={{ marginTop: 8 }}>
              Giao thức Kafka: {d.protocol.spoke ? `trả lời được${d.protocol.latencyMs !== undefined ? ` · ${d.protocol.latencyMs} ms` : ''}` : `không trả lời${d.protocol.error ? ` (${d.protocol.error})` : ''}`}
              {d.protocol.controllerId === null ? <> · <b className="esd-crit">không có controller</b></> : d.protocol.controllerId !== undefined ? <> · controller {d.protocol.controllerId}</> : null}
              {d.protocol.advertised?.length ? <> · advertised: <code>{d.protocol.advertised.join(', ')}</code></> : null}
            </p>
          ) : null}
          {d.dns && !d.dns.noNames && d.dns.hosts.length ? (
            <>
              <div className="pgd-sub">DNS (nameserver: {d.dns.servers.join(', ') || '?'})</div>
              <table className="mon-mini">
                <tbody>
                  {d.dns.hosts.map((h) => (
                    <tr key={h.host} className={h.system.resolved ? (h.hostsFileOverride ? 'lv-warn' : '') : 'lv-down'}>
                      <td><code>{h.host}</code></td>
                      <td>
                        {h.system.resolved ? h.system.addresses?.join(', ') : <span className="esd-crit">{h.system.error ?? 'không phân giải được'}</span>}
                        {h.hostsFileOverride ? <span className="mon-d-faint"> · khác kết quả nameserver ({h.nameserver?.addresses?.join(', ') || h.nameserver?.error || '—'}) — đang bị hosts file can thiệp</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
