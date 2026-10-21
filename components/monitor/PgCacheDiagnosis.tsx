'use client';

// Kết quả "Phân tích" cache hit thấp của một PostgreSQL (lib/pgDiagnose):
// câu kết luận → đề xuất hướng xử lý (các bước theo thứ tự nên làm) → chi tiết
// từng nguyên nhân kèm bằng chứng (số liệu thật) + lệnh mẫu để sao chép.
// Thu gọn được về một dòng kết luận. App chỉ đọc thống kê — không tự chạy lệnh sửa nào.

import { useCallback, useEffect, useRef, useState } from 'react';
import { pgDiagnoseCacheHit, type CacheHitDiagnosis } from '@/lib/pg';
import type { Finding, PlanPhase } from '@/lib/pgDiagnoseRules';

const LEVEL_TEXT: Record<Finding['level'], string> = { crit: 'Nghiêm trọng', warn: 'Nên xử lý', info: 'Thông tin', ok: 'Ổn' };
const PHASE_TEXT: Record<PlanPhase, string> = { now: 'Làm ngay', restart: 'Cần restart', long: 'Dài hạn', observe: 'Theo dõi' };

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="mon-btn pgd-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? '✓ Đã chép' : 'Sao chép'}
    </button>
  );
}

export default function PgCacheDiagnosis({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: CacheHitDiagnosis; error?: string }>({ busy: true });
  const [collapsed, setCollapsed] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const run = useCallback(() => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    setCollapsed(false);
    pgDiagnoseCacheHit(connectionId)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId]);
  useEffect(run, [run]);

  // Bấm một bước → cuộn tới nguyên nhân sinh ra nó, chớp sáng để mắt bắt được.
  const goFinding = (id: string) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-fid="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1400);
  };

  const d = state.data;
  return (
    <section className="pgd">
      <h4>
        Phân tích cache hit
        <span className="pgd-head-acts">
          {d ? (
            <button
              type="button"
              className="mon-btn"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              title={collapsed ? 'Hiện lại toàn bộ kết quả phân tích' : 'Thu gọn — chỉ giữ câu kết luận'}
            >
              {collapsed ? '▸ Mở rộng' : '▾ Thu gọn'}
            </button>
          ) : null}
          <button type="button" className="mon-btn" onClick={run} disabled={state.busy}>
            {state.busy ? '⟳ Đang phân tích…' : '⟳ Phân tích lại'}
          </button>
        </span>
      </h4>

      {state.busy && !d ? (
        <p className="mon-d-faint">Đang đọc thống kê và đo tỉ lệ hiện tại (khoảng 6–10 giây)…</p>
      ) : null}
      {state.error ? <p className="pgd-error">Không phân tích được: {state.error}</p> : null}

      {d ? (
        <div className={state.busy ? 'pgd-stale' : undefined}>
          <p className="pgd-headline">{d.headline}</p>
          <p className="mon-d-faint pgd-nums">
            Hiện tại: <b>{d.currentPct === null ? 'chưa đo được' : `${d.currentPct}%`}</b>
            {d.windowSec ? ` (trong ${d.windowSec}s)` : ''} · Cộng dồn: <b>{d.cumulativePct ?? '?'}%</b>
            {collapsed ? ` · ${d.findings.length} nguyên nhân · ${d.plan.length} bước xử lý` : ''}
          </p>

          {!collapsed ? (
            <>
              {d.plan.length ? (
                <div className="pgd-plan">
                  <div className="pgd-sub">Đề xuất hướng xử lý</div>
                  <ol>
                    {d.plan.map((st, i) => (
                      <li key={i} className={`pgd-step ph-${st.phase}`}>
                        <span className="pgd-phase">{PHASE_TEXT[st.phase]}</span>
                        {st.findingId ? (
                          <button type="button" className="pgd-step-link" onClick={() => goFinding(st.findingId)} title="Xem bằng chứng và lệnh của bước này">
                            {st.text}
                          </button>
                        ) : (
                          <span className="pgd-step-text">{st.text}</span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              <div className="pgd-sub">Chi tiết nguyên nhân</div>
              <ol className="pgd-list" ref={listRef}>
                {d.findings.map((f) => (
                  <li key={f.id} data-fid={f.id} className={`pgd-item lv-${f.level}${flash === f.id ? ' flash' : ''}`}>
                    <div className="pgd-tag">{LEVEL_TEXT[f.level]}</div>
                    <div className="pgd-title">{f.title}</div>
                    {f.evidence.length ? (
                      <ul className="pgd-evidence">
                        {f.evidence.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    ) : null}
                    {f.fix ? <p className="pgd-fix"><b>Khắc phục:</b> {f.fix}</p> : null}
                    {f.sql ? (
                      <div className="pgd-sql">
                        <pre>{f.sql}</pre>
                        <CopyBtn text={f.sql} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>

              <p className="mon-d-faint pgd-foot">
                Đã xét: {d.analyzedDbs.length ? d.analyzedDbs.join(', ') : '—'}
                {d.skippedDbs.length ? <> · bỏ qua: {d.skippedDbs.map((s) => `${s.name} (${s.error})`).join('; ')}</> : null}
                {' '}· lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ đọc thống kê, không chạy lệnh nào.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
