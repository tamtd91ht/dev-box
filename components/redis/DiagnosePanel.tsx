'use client';

// Tab "Phân tích" của từng kết nối Redis — cùng các bộ phân tích của tab Monitor
// (components/monitor/*Diagnosis), nhưng mở được bất kỳ lúc nào chứ không cần đợi
// cảnh báo. Bên trái chọn mục, bên phải là nội dung; chọn mục nào mới chạy mục đó
// (mỗi lần chỉ một mục, để không dồn nhiều lệnh đọc lên production cùng lúc).
// Đổi kết nối → về trạng thái chưa chọn.

import { useEffect, useState } from 'react';
import RedisMissDiagnosis from '../monitor/RedisMissDiagnosis';
import RedisMemDiagnosis from '../monitor/RedisMemDiagnosis';
import RedisClientsDiagnosis from '../monitor/RedisClientsDiagnosis';
import RedisFragDiagnosis from '../monitor/RedisFragDiagnosis';
import KeymissFlagsPanel from '../monitor/KeymissFlagsPanel';

type Kind = 'miss' | 'mem' | 'clients' | 'frag' | 'keymiss';

const ITEMS: { kind: Kind; icon: string; label: string; desc: string }[] = [
  { kind: 'miss', icon: '🎯', label: 'Hit rate', desc: 'Dạng key nào đang miss — bật tạm cờ key-miss vài giây (hỏi trước khi chạy).' },
  { kind: 'mem', icon: '🧠', label: 'RAM đang dùng', desc: 'RAM nằm ở đâu, đầy thì sao, dạng key nào chiếm, key không TTL.' },
  { kind: 'clients', icon: '🔌', label: 'Client kết nối', desc: 'Còn bao xa maxclients, kết nối mới / bị từ chối, đến từ đâu.' },
  { kind: 'frag', icon: '🧩', label: 'Phân mảnh bộ nhớ', desc: 'Phân mảnh nằm ở đâu, có nên bật activedefrag.' },
  { kind: 'keymiss', icon: '🔎', label: 'Cờ key-miss', desc: 'Cờ mà phân tích hit rate bật tạm còn bật không — tắt khi bạn bấm.' },
];

export default function DiagnosePanel({ connectionId }: { connectionId: string }) {
  const [kind, setKind] = useState<Kind | null>(null);

  useEffect(() => { setKind(null); }, [connectionId]);

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
            <p className="small">Chọn một mục bên trái để phân tích. Mục nào chọn mới chạy mục đó — chỉ đọc thống kê, không đổi gì trên server (trừ cờ key-miss, có hỏi trước).</p>
          </div>
        ) : null}
        {kind === 'miss' ? <RedisMissDiagnosis key={connectionId} connectionId={connectionId} /> : null}
        {/* Lịch sử RAM chỉ có ở tab Monitor — ở đây xu hướng tăng sẽ là "chưa đủ lịch sử". */}
        {kind === 'mem' ? <RedisMemDiagnosis key={connectionId} connectionId={connectionId} history={[]} /> : null}
        {kind === 'clients' ? <RedisClientsDiagnosis key={connectionId} connectionId={connectionId} /> : null}
        {kind === 'frag' ? <RedisFragDiagnosis key={connectionId} connectionId={connectionId} /> : null}
        {kind === 'keymiss' ? <KeymissFlagsPanel key={connectionId} connectionId={connectionId} /> : null}
      </div>
    </div>
  );
}
