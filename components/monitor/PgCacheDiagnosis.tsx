'use client';

// "Phân tích" cache hit thấp của một PostgreSQL (lib/pgDiagnose) — chạy ngay khi
// mở (chỉ đọc thống kê, không đổi gì trên server). Hiển thị qua DiagnosisView.

import { useCallback, useEffect, useState } from 'react';
import { pgDiagnoseCacheHit, type CacheHitDiagnosis } from '@/lib/pg';
import DiagnosisView from './DiagnosisView';

export default function PgCacheDiagnosis({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: CacheHitDiagnosis; error?: string }>({ busy: true });

  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    pgDiagnoseCacheHit(connectionId)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId]);
  useEffect(run, [run]);

  const d = state.data;
  return (
    <DiagnosisView
      title="Phân tích cache hit"
      busy={state.busy}
      busyText="Đang đọc thống kê và đo tỉ lệ hiện tại (khoảng 6–10 giây)…"
      error={state.error}
      data={d}
      onRerun={run}
      nums={d ? (
        <>
          Hiện tại: <b>{d.currentPct === null ? 'chưa đo được' : `${d.currentPct}%`}</b>
          {d.windowSec ? ` (trong ${d.windowSec}s)` : ''} · Cộng dồn: <b>{d.cumulativePct ?? '?'}%</b>
        </>
      ) : null}
      foot={d ? (
        <>
          Đã xét: {d.analyzedDbs.length ? d.analyzedDbs.join(', ') : '—'}
          {d.skippedDbs.length ? <> · bỏ qua: {d.skippedDbs.map((s) => `${s.name} (${s.error})`).join('; ')}</> : null}
          {' '}· lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ đọc thống kê, không chạy lệnh nào.
        </>
      ) : null}
    />
  );
}
