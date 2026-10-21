'use client';

// Ngăn chi tiết một tài nguyên (bấm vào thẻ / dòng bảng): nguyên nhân, lịch sử
// trạng thái, toàn bộ chỉ số kèm đồ thị nhỏ, và số liệu riêng của Kafka.
// Cảnh báo nào có bộ phân tích nguyên nhân (cache hit PostgreSQL, hit rate Redis, lag Kafka) thì có
// nút "Phân tích" ngay trên dòng nguyên nhân.

import { useEffect, useMemo, useState } from 'react';
import type { Row } from '@/lib/monitor/useMonitor';
import {
  LEVEL_LABEL, STACK_META, ago, describeMetric, fmtDuration, fmtNum, fmtValue, gatedOff, levelOf,
  type Overrides,
} from '@/lib/monitor/status';
import { Spark, Timeline } from './Spark';
import PgCacheDiagnosis from './PgCacheDiagnosis';
import RedisMissDiagnosis from './RedisMissDiagnosis';
import KafkaLagDiagnosis from './KafkaLagDiagnosis';
import { focusFromRow } from '@/lib/monitor/focus';

interface Props {
  row: Row;
  now: number;
  overrides: Overrides;
  onClose: () => void;
  onRefresh: () => void;
  onOpenTab: (tab: string) => void;
}

/** Cảnh báo Kafka có nút Phân tích lag (đều xoay quanh một consumer group). */
const KAFKA_LAG_METRICS = new Set(['maxConsumerLag', 'deadLagGroups', 'stalledGroups', 'maxStalledSec']);

/** Chỉ số có luật lên đầu, rồi tới phần còn lại theo bảng chữ cái. */
function orderMetrics(keys: string[], ruled: Set<string>): string[] {
  return [...keys].sort((a, b) => {
    const ra = ruled.has(a) ? 0 : 1;
    const rb = ruled.has(b) ? 0 : 1;
    return ra - rb || a.localeCompare(b);
  });
}

export default function MonitorDetail({ row, now, overrides, onClose, onRefresh, onOpenTab }: Props) {
  const { res, st, ev } = row;
  const meta = STACK_META[res.stack];
  const last = st.last;
  const metrics = last?.metrics ?? {};

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const keys = useMemo(() => {
    const ruled = new Set(Object.keys(metrics).filter((k) => describeMetric(res.stack, k).rule));
    return orderMetrics(Object.keys(metrics).filter((k) => k !== 'up'), ruled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.at, res.stack]);

  // Phân tích nguyên nhân — mở theo tài nguyên, chuyển sang tài nguyên khác thì đóng.
  const [diagOpen, setDiagOpen] = useState(false);
  useEffect(() => { setDiagOpen(false); }, [res.key]);
  const canDiagnose = (metric: string): boolean =>
    (res.stack === 'pg' && metric === 'cacheHitPct') || (res.stack === 'redis' && metric === 'hitRatePct')
    || (res.stack === 'kafka' && KAFKA_LAG_METRICS.has(metric));
  // Kafka: group có lag để chọn, mặc định group gắn với cảnh báo nặng nhất (cùng cách nút "Mở Kafka").
  const lagGroups = useMemo(
    () => (last?.kafkaGroups ?? []).filter((g) => g.lag > 0 && !g.error).sort((a, b) => b.lag - a.lag).map((g) => ({ groupId: g.groupId, lag: g.lag })),
    [last?.kafkaGroups],
  );
  const defaultGroup = res.stack === 'kafka' ? focusFromRow(row).group ?? lagGroups[0]?.groupId ?? '' : '';

  const groups = useMemo(
    () => [...(last?.kafkaGroups ?? [])].sort((a, b) => b.lag - a.lag).slice(0, 12),
    [last?.kafkaGroups],
  );

  return (
    <aside className="mon-detail" role="dialog" aria-label={`Chi tiết ${res.name}`}>
      <header className="mon-d-head">
        <span className={`mon-dot lv-${ev.level}`} aria-hidden />
        <div className="mon-d-title">
          <div className="mon-d-name">{res.name}</div>
          <div className="mon-d-sub">
            {meta.icon} {meta.label} · {res.project}
            {res.address ? <> · <code>{res.address}</code></> : null}
          </div>
        </div>
        <button className="mon-btn" onClick={onRefresh} disabled={st.busy} title="Đo lại ngay (Kafka: kèm lag + host)">
          {st.busy ? '⟳ Đang đo…' : '⟳ Đo lại'}
        </button>
        <button className="mon-btn" onClick={() => onOpenTab(meta.tab)} title={`Mở tab ${meta.label} — chọn sẵn cụm ${res.name} và mục liên quan tới cảnh báo`}>
          ↗ Mở {meta.label}
        </button>
        <button className="mon-btn icon" onClick={onClose} aria-label="Đóng">✕</button>
      </header>

      <div className="mon-d-body">
        <section className={`mon-d-banner lv-${ev.level}`}>
          <strong>{LEVEL_LABEL[ev.level]}</strong>
          {st.since && ev.level !== 'unknown' ? <span> · từ {ago(st.since, now)}</span> : null}
          {last ? <span className="mon-d-faint"> · đo {ago(last.at, now)}</span> : null}
        </section>

        <section>
          <h4>Nguyên nhân</h4>
          {ev.reasons.length === 0 ? (
            <p className="mon-d-faint">{ev.level === 'unknown' ? 'Đang chờ lần đo đầu tiên.' : 'Mọi chỉ số đang trong ngưỡng.'}</p>
          ) : (
            <ul className="mon-reasons">
              {ev.reasons.map((r) => (
                <li key={r.metric} className={`lv-${r.level}`}>
                  <span className="mon-dot sm" aria-hidden />
                  <div className="mon-reason-body">
                    <div>{r.text}</div>
                    {r.why ? <div className="mon-d-faint">{r.why}</div> : null}
                  </div>
                  {canDiagnose(r.metric) ? (
                    <button
                      type="button"
                      className="mon-btn mon-reason-act"
                      onClick={() => setDiagOpen(true)}
                      disabled={diagOpen}
                      title="Đọc thống kê của server (chỉ đọc) để tìm bảng / query / cấu hình gây ra, kèm cách khắc phục"
                    >
                      🔍 Phân tích
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {diagOpen && res.stack === 'pg' ? <PgCacheDiagnosis key={res.key} connectionId={res.id} /> : null}
        {diagOpen && res.stack === 'redis' ? <RedisMissDiagnosis key={res.key} connectionId={res.id} /> : null}
        {diagOpen && res.stack === 'kafka' && defaultGroup
          ? <KafkaLagDiagnosis key={res.key} connectionId={res.id} groups={lagGroups} initialGroup={defaultGroup} />
          : null}

        {last?.brokerReach?.length ? (
          <section>
            <h4>Chẩn đoán broker (TCP)</h4>
            <table className="mon-mini">
              <tbody>
                {last.brokerReach.map((b) => (
                  <tr key={b.addr}>
                    <td><span className={`mon-dot sm lv-${b.reachable ? 'ok' : 'down'}`} aria-hidden /> <code>{b.addr}</code></td>
                    <td>{b.reachable ? `mở cổng · ${b.latencyMs ?? '?'} ms` : b.error ?? 'không tới được'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {last.kafkaProtocol ? (
              <p className="mon-d-faint">
                Giao thức Kafka: {last.kafkaProtocol.spoke ? 'trả lời được' : `không trả lời${last.kafkaProtocol.error ? ` (${last.kafkaProtocol.error})` : ''}`}
                {last.kafkaProtocol.advertised?.length ? <> · advertised: <code>{last.kafkaProtocol.advertised.join(', ')}</code></> : null}
              </p>
            ) : null}
          </section>
        ) : null}

        <section>
          <h4>Lịch sử trạng thái <span className="mon-d-faint">({st.samples.length} mẫu gần nhất)</span></h4>
          <Timeline samples={st.samples} max={90} />
        </section>

        {keys.length > 0 && (
          <section>
            <h4>Chỉ số</h4>
            <div className="mon-metrics">
              {keys.map((k) => {
                const d = describeMetric(res.stack, k, overrides);
                const v = metrics[k];
                const lv = d.rule && !gatedOff(d.rule, metrics) ? levelOf(d.rule, v) : 'ok';
                const series = st.samples.map((s) => s.metrics[k]).filter((x): x is number => typeof x === 'number');
                const thr = d.rule
                  ? [d.rule.warn !== undefined ? `vàng ${d.rule.dir === 'gt' ? '>' : '<'} ${fmtValue(d.rule.warn, d.unit)}` : '',
                     d.rule.crit !== undefined ? `đỏ ${d.rule.dir === 'gt' ? '>' : '<'} ${fmtValue(d.rule.crit, d.unit)}` : '']
                      .filter(Boolean).join(' · ')
                  : '';
                return (
                  <div key={k} className={`mon-metric lv-${lv}`}>
                    <div className="mon-metric-label" title={k}>{d.label}</div>
                    <div className="mon-metric-val">{fmtValue(v, d.unit, d.say)}</div>
                    {thr && !d.say ? <div className="mon-metric-thr">{thr}</div> : null}
                    <Spark values={series} width={150} height={26} level={lv} />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {groups.length > 0 && (
          <section>
            <h4>Consumer group <span className="mon-d-faint">(top {groups.length} theo lag)</span></h4>
            <table className="mon-mini">
              <thead>
                <tr><th>Group</th><th>Trạng thái</th><th className="r">Member</th><th className="r">Lag</th><th>Topic nặng nhất</th></tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.groupId} className={g.error ? 'lv-warn' : g.lag > 0 && g.members === 0 ? 'lv-warn' : ''}>
                    <td title={g.groupId}><code>{g.groupId}</code></td>
                    <td>{g.error ? 'lỗi đọc lag' : g.state}</td>
                    <td className="r">{g.described ? g.members : '?'}</td>
                    <td className="r">{g.error ? '?' : fmtNum(g.lag)}</td>
                    <td>{g.worstTopic ? `${g.worstTopic} (${fmtNum(g.worstTopicLag)})` : '—'}
                      {g.stalledSec ? <span className="mon-d-faint"> · đứng im {fmtDuration(g.stalledSec)}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {last?.kafkaHosts?.length ? (
          <section>
            <h4>Host broker</h4>
            <table className="mon-mini">
              <thead>
                <tr><th>Host</th><th className="r">Đĩa</th><th className="r">RAM</th><th className="r">CPU</th><th className="r">Load/core</th></tr>
              </thead>
              <tbody>
                {last.kafkaHosts.map((h) => (
                  <tr key={h.host} className={h.reachable ? '' : 'lv-down'}>
                    <td><code>{h.host}</code></td>
                    {h.reachable ? (
                      <>
                        <td className="r">{h.diskUsedPct !== null ? `${h.diskUsedPct}%${h.diskFreeGb !== null ? ` (còn ${h.diskFreeGb} GB)` : ''}` : '—'}</td>
                        <td className="r">{h.memUsedPct !== null ? `${h.memUsedPct}%` : '—'}</td>
                        <td className="r">{h.cpuPct !== null ? `${h.cpuPct}%` : '…'}</td>
                        <td className="r">{h.load1PerCore ?? '—'}</td>
                      </>
                    ) : (
                      <td colSpan={4}>exporter không trả lời{h.error ? `: ${h.error}` : ''}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {last?.error ? (
          <section>
            <h4>Lỗi gốc</h4>
            <pre className="mon-raw">{last.error}</pre>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
