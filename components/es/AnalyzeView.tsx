'use client';

// Tab "Phân tích" của từng cụm Elasticsearch — cùng bộ phân tích cụm của tab Monitor
// (components/monitor/EsDiagnosis), nhưng mở được bất kỳ lúc nào, kể cả khi cụm xanh
// mà truy vấn vẫn chậm. Không tự chạy khi vào tab (đọc thống kê ~8 giây): người dùng
// bấm "Phân tích cụm" mới chạy; sau đó "Phân tích lại" nằm trong khung kết quả.

import { useState } from 'react';
import EsDiagnosisPanel from '../monitor/EsDiagnosis';

export default function AnalyzeView({ connectionId }: { connectionId: string }) {
  const [started, setStarted] = useState(false);

  return (
    <div className="es-diag">
      {!started ? (
        <div className="es-diag-intro">
          <div className="empty-ico">🔍</div>
          <p className="small">
            Phân tích cụm: <b>heap / GC</b>, <b>shard chưa gán</b> (kèm lời giải thích của ES), <b>CPU</b> (việc gì đang ăn),
            {' '}<b>đĩa</b> so với watermark, <b>thread pool</b> bị từ chối, <b>truy vấn đang chạy lâu</b>, index / node chậm.
          </p>
          <p className="small" style={{ color: 'var(--muted)' }}>
            Chỉ đọc thống kê trong khoảng 8 giây, không chặn cụm. hot_threads (lấy mẫu stack) chỉ chạy khi bạn bật hẳn trong kết quả.
          </p>
          <button type="button" className="chip-btn on" onClick={() => setStarted(true)}>🔍 Phân tích cụm</button>
        </div>
      ) : (
        <EsDiagnosisPanel connectionId={connectionId} />
      )}
    </div>
  );
}
