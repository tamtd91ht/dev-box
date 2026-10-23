'use client';

// "Phân tích" ngay trong từng kết nối Redis — cùng các bộ phân tích của tab Monitor
// (components/monitor/*Diagnosis), nhưng mở được bất kỳ lúc nào chứ không cần đợi
// cảnh báo. Thu gọn mặc định; chọn mục nào mới chạy mục đó (mỗi lần chỉ một mục,
// để không dồn nhiều lệnh đọc lên production cùng lúc). Đổi kết nối → đóng lại.

import { useEffect, useState } from 'react';
import RedisMissDiagnosis from '../monitor/RedisMissDiagnosis';
import RedisMemDiagnosis from '../monitor/RedisMemDiagnosis';
import RedisClientsDiagnosis from '../monitor/RedisClientsDiagnosis';
import RedisFragDiagnosis from '../monitor/RedisFragDiagnosis';
import KeymissFlagsPanel from '../monitor/KeymissFlagsPanel';

type Kind = 'miss' | 'mem' | 'clients' | 'frag' | 'keymiss';

const ITEMS: { kind: Kind; label: string; title: string }[] = [
  { kind: 'miss', label: 'Hit rate', title: 'Phân tích nguyên nhân hit rate thấp — bật tạm cờ key-miss để bắt key bị miss trong vài giây (hỏi trước khi chạy)' },
  { kind: 'mem', label: 'RAM đang dùng', title: 'RAM nằm ở đâu, đầy thì sao, dạng key nào chiếm; lấy mẫu / liệt kê key không TTL khi bấm. Chỉ đọc.' },
  { kind: 'clients', label: 'Client kết nối', title: 'Còn bao xa maxclients, kết nối mới mỗi giây, bị từ chối; CLIENT LIST khi bấm. Chỉ đọc.' },
  { kind: 'frag', label: 'Phân mảnh bộ nhớ', title: 'Phân mảnh nằm ở đâu (allocator / RSS / THP), có nên bật activedefrag. Chỉ đọc.' },
  { kind: 'keymiss', label: 'Cờ key-miss', title: 'Kiểm tra cờ notify-keyspace-events m mà phân tích hit rate bật tạm còn bật không — chỉ đọc; tắt khi bạn bấm.' },
];

export default function DiagnosePanel({ connectionId }: { connectionId: string }) {
  const [kind, setKind] = useState<Kind | null>(null);

  useEffect(() => { setKind(null); }, [connectionId]);

  return (
    <div className="redis-diag">
      <div className="status-line" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span className="small" style={{ color: 'var(--muted)' }}>🔍 Phân tích:</span>
        {ITEMS.map((it) => (
          <button
            key={it.kind}
            type="button"
            className={`chip-btn${kind === it.kind ? ' on' : ''}`}
            onClick={() => setKind(kind === it.kind ? null : it.kind)}
            title={it.title}
          >
            {kind === it.kind ? '▾ ' : ''}{it.label}
          </button>
        ))}
      </div>
      {kind ? (
        <div className="redis-diag-body">
          {kind === 'miss' ? <RedisMissDiagnosis key={connectionId} connectionId={connectionId} /> : null}
          {/* Lịch sử RAM chỉ có ở tab Monitor — ở đây xu hướng tăng sẽ là "chưa đủ lịch sử". */}
          {kind === 'mem' ? <RedisMemDiagnosis key={connectionId} connectionId={connectionId} history={[]} /> : null}
          {kind === 'clients' ? <RedisClientsDiagnosis key={connectionId} connectionId={connectionId} /> : null}
          {kind === 'frag' ? <RedisFragDiagnosis key={connectionId} connectionId={connectionId} /> : null}
          {kind === 'keymiss' ? <KeymissFlagsPanel key={connectionId} connectionId={connectionId} /> : null}
        </div>
      ) : null}
    </div>
  );
}
