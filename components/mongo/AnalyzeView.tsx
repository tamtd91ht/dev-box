'use client';

// Tab "Phân tích" của từng kết nối MongoDB (lib/mongoDiagnose). Bên trái chọn mục,
// bên phải là nội dung; chọn mục nào mới chạy mục đó (mỗi lần một mục). Mọi mục chỉ
// đọc thống kê — không ghi, không bật profiler, không kill op, không đổi cấu hình.
// Đổi kết nối → về trạng thái chưa chọn (component được key theo kết nối ở MongoWorkspace).

import { useCallback, useEffect, useState } from 'react';
import { mongoDiagnose, mongoLongRunning, type MongoDiagKind, type MongoDiagnosis } from '@/lib/mongo';
import DiagnosisView from '../monitor/DiagnosisView';
import LongRunningView from '../monitor/LongRunningView';

const ITEMS: { kind: MongoDiagKind; icon: string; label: string; desc: string; busy: string; how: string }[] = [
  {
    kind: 'queries', icon: '🐢', label: 'Hiệu năng truy vấn',
    desc: 'Quét thừa (thiếu index), collection scan, sort trong RAM, thao tác chạy lâu, chờ lock.',
    busy: 'Đang đọc serverStatus hai lần cách 5 giây + thao tác đang chạy (chỉ đọc)…',
    how: 'serverStatus hai lần cách 5s → doc quét / trả, COLLSCAN, sort trong RAM mỗi giây; $currentOp lọc trên server (đang chạy ≥ 1s, tối đa 30, bỏ replication / change stream); hàng đợi globalLock.',
  },
  {
    kind: 'indexes', icon: '🗂', label: 'Index',
    desc: 'Index không dùng, index thừa (tiền tố của index khác), collection lớn chỉ có _id.',
    busy: 'Đang đọc $indexStats + $collStats từng collection (tối đa 300, có nghỉ, trần 25 giây)…',
    how: '$indexStats (số lần dùng từ lần restart, trên node đang nối) + $collStats storageStats (dung lượng) + listIndexes, từng collection, nghỉ 20ms giữa các collection, tối đa 300 collection / 25 giây.',
  },
  {
    kind: 'memory', icon: '🧠', label: 'RAM & WiredTiger cache',
    desc: 'Cache đầy / dirty, luồng ứng dụng phải tự evict, đọc đĩa, ticket, index không vừa cache.',
    busy: 'Đang đọc serverStatus hai lần cách 5 giây + hostInfo + dbStats (chỉ đọc)…',
    how: 'serverStatus hai lần cách 5s (wiredTiger.cache, ticket ở queues.execution / concurrentTransactions), hostInfo (RAM máy), dbStats từng db (tổng data / index).',
  },
  {
    kind: 'repl', icon: '🔁', label: 'Replica set & oplog',
    desc: 'Member hỏng, không có primary, secondary lag, cửa sổ oplog, số member bỏ phiếu.',
    busy: 'Đang đọc replSetGetStatus / replSetGetConfig + oplog (chỉ đọc)…',
    how: 'replSetGetStatus + replSetGetConfig; cửa sổ oplog từ đúng một bản ghi đầu và một bản ghi cuối của local.oplog.rs ($natural — không quét).',
  },
  {
    kind: 'connections', icon: '🔌', label: 'Kết nối',
    desc: '% kết nối đã dùng, kết nối mới mỗi giây, kết nối theo máy / app.',
    busy: 'Đang đọc serverStatus hai lần cách 5 giây + gom kết nối theo máy / app…',
    how: 'serverStatus hai lần cách 5s (connections); $currentOp kể cả kết nối rảnh, gom theo máy + appName ngay trên server — chỉ khi ≤ 5.000 kết nối.',
  },
];

/** Mục riêng không thuộc MongoDiagnosis: thao tác đang chạy ≥ N giây. */
const LONG = { icon: '⏱', label: 'Truy vấn đang chạy lâu', desc: 'Thao tác đang chạy ≥ N giây: namespace, plan, client, lệnh — một $currentOp, nhẹ.' };

export default function AnalyzeView({ connectionId }: { connectionId: string }) {
  const [kind, setKind] = useState<MongoDiagKind | 'long' | null>(null);
  const item = ITEMS.find((x) => x.kind === kind);
  const load = useCallback((sec: number) => mongoLongRunning(connectionId, sec), [connectionId]);

  return (
    <div className="redis-diag">
      <nav className="redis-diag-nav" aria-label="Chọn nội dung phân tích">
        <button
          type="button"
          className={`redis-diag-item${kind === 'long' ? ' on' : ''}`}
          onClick={() => setKind('long')}
          aria-current={kind === 'long'}
        >
          <span className="redis-diag-ico" aria-hidden>{LONG.icon}</span>
          <span>
            <b>{LONG.label}</b>
            <small>{LONG.desc}</small>
          </span>
        </button>
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
        {kind === 'long' ? (
          <LongRunningView
            storeKey="mongo.longRunningSec"
            title={LONG.label}
            how="Một lệnh $currentOp lọc / sắp / cắt ngay trên server (đang chạy ≥ N giây, tối đa 100, bỏ replication / change stream), maxTimeMS 10 giây — không khoá gì."
            load={load}
          />
        ) : !item ? (
          <div className="empty" style={{ padding: '32px 8px' }}>
            <div className="empty-ico">🔍</div>
            <p className="small">Chọn một mục bên trái để phân tích. Mục nào chọn mới chạy mục đó — chỉ đọc thống kê, không ghi, không bật profiler, không kill op.</p>
          </div>
        ) : <Panel key={item.kind} connectionId={connectionId} item={item} />}
      </div>
    </div>
  );
}

function Panel({ connectionId, item }: { connectionId: string; item: (typeof ITEMS)[number] }) {
  const [state, setState] = useState<{ busy: boolean; data?: MongoDiagnosis; error?: string }>({ busy: true });
  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    mongoDiagnose(connectionId, item.kind)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId, item.kind]);
  useEffect(run, [run]);

  const d = state.data;
  return (
    <DiagnosisView
      title={item.label}
      busy={state.busy}
      busyText={item.busy}
      error={state.error}
      data={d}
      onRerun={run}
      info={<p>{item.how} Mọi lệnh có maxTimeMS 10 giây. Không ghi, không bật profiler, không kill op, không đổi cấu hình.</p>}
      infoSummary={item.how}
      nums={d?.nums.length ? <>{d.nums.join(' · ')}</> : null}
      extra={d?.tables.length ? (
        <>
          {d.tables.map((t) => (
            <div key={t.title}>
              <div className="pgd-sub">{t.title}</div>
              <div className="rmd-table-wrap rmd-scroll">
                <table className="mon-mini rmd-table">
                  <thead><tr>{t.columns.map((c, i) => <th key={c} className={t.right?.includes(i) ? 'r' : ''}>{c}</th>)}</tr></thead>
                  <tbody>
                    {t.rows.map((r, j) => (
                      <tr key={j} className={r.tone === 'down' ? 'lv-down' : r.tone === 'warn' ? 'lv-warn' : ''}>
                        {r.cells.map((c, i) => (
                          <td key={i} className={t.right?.includes(i) ? 'r' : ''}>
                            {i === t.columns.length - 1 && t.columns[i] === 'Lệnh' ? <code title={c}>{c.slice(0, 120)}</code> : c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      ) : null}
      foot={d ? (
        <>
          lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ đọc thống kê, không đổi gì trên server
          {d.notes.length ? <> · {d.notes.join(' · ')}</> : null}
        </>
      ) : null}
    />
  );
}
