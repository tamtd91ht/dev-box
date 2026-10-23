'use client';

// Tab "Phân tích" của từng cụm Elasticsearch. Bên trái chọn mục, bên phải là nội dung;
// chọn mục nào mới chạy mục đó. Chỉ GET đọc thống kê, không chặn cụm:
//   • Phân tích cụm — bộ của tab Monitor (components/monitor/EsDiagnosis): heap / shard /
//     CPU / đĩa / truy vấn chậm, chạy được cả khi cụm xanh.
//   • Truy vấn đang chạy lâu — task ≥ N giây (_tasks) + pending task chờ master.
// Đổi cụm → về trạng thái chưa chọn (component được key theo cụm ở EsWorkspace).

import { useCallback, useState } from 'react';
import { esLongRunning } from '@/lib/es';
import EsDiagnosisPanel from '../monitor/EsDiagnosis';
import LongRunningView from '../monitor/LongRunningView';

type Kind = 'cluster' | 'long';

const ITEMS: { kind: Kind; icon: string; label: string; desc: string }[] = [
  { kind: 'long', icon: '⏱', label: 'Truy vấn đang chạy lâu', desc: 'Search / bulk / *_by_query đang chạy ≥ N giây, pending task chờ master — nhẹ, đọc trong bộ nhớ.' },
  { kind: 'cluster', icon: '🩺', label: 'Phân tích cụm', desc: 'Heap / GC, shard chưa gán, CPU, đĩa, thread pool bị từ chối, index / node chậm (đo ~8 giây).' },
];

export default function AnalyzeView({ connectionId }: { connectionId: string }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const load = useCallback((sec: number) => esLongRunning(connectionId, sec), [connectionId]);

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
            <p className="small">Chọn một mục bên trái để phân tích. Mục nào chọn mới chạy mục đó — chỉ GET đọc thống kê, không chặn cụm, không huỷ task.</p>
          </div>
        ) : null}
        {kind === 'long' ? (
          <LongRunningView
            storeKey="es.longRunningSec"
            title="Truy vấn đang chạy lâu"
            how="_tasks (task gốc của search / msearch / scroll / bulk / *_by_query / reindex, timeout 5s mỗi node) + _cluster/pending_tasks — trạng thái trong bộ nhớ, không chặn cụm."
            load={load}
          />
        ) : null}
        {kind === 'cluster' ? <EsDiagnosisPanel connectionId={connectionId} /> : null}
      </div>
    </div>
  );
}
