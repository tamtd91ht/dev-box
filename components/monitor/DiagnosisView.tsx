'use client';

// Khung hiển thị chung cho các bộ "Phân tích nguyên nhân" của Monitor (lib/diagnose):
// câu kết luận → đề xuất hướng xử lý (bước theo thứ tự nên làm) → phần riêng của
// từng hạ tầng (`extra`, vd bảng dạng key Redis) → chi tiết từng nguyên nhân kèm
// bằng chứng + lệnh mẫu để sao chép. Thu gọn được về một dòng kết luận.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Finding, PlanPhase, PlanStep } from '@/lib/diagnose';

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

interface Props {
  title: string;
  busy: boolean;
  /** Hiện khi đang chạy lần đầu (chưa có kết quả). */
  busyText: string;
  error?: string;
  data?: { at: number; headline: string; findings: Finding[]; plan: PlanStep[] };
  /** Dòng số liệu dưới câu kết luận. */
  nums?: ReactNode;
  /** Phần riêng của từng hạ tầng, nằm giữa kế hoạch và chi tiết nguyên nhân. */
  extra?: ReactNode;
  foot?: ReactNode;
  /** Chưa chạy lần nào (vd chờ xác nhận) — hiện thay cho kết quả. */
  start?: ReactNode;
  onRerun?: () => void;
}

export default function DiagnosisView({ title, busy, busyText, error, data: d, nums, extra, foot, start, onRerun }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // Kết quả mới → mở rộng lại.
  useEffect(() => { setCollapsed(false); }, [d?.at]);

  // Bấm một bước → cuộn tới nguyên nhân sinh ra nó, chớp sáng để mắt bắt được.
  const goFinding = (id: string) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-fid="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1400);
  };

  return (
    <section className="pgd">
      <h4>
        {title}
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
          {onRerun && (d || error) ? (
            <button type="button" className="mon-btn" onClick={onRerun} disabled={busy}>
              {busy ? '⟳ Đang phân tích…' : '⟳ Phân tích lại'}
            </button>
          ) : null}
        </span>
      </h4>

      {!d && !busy && !error ? start : null}
      {busy && !d ? <p className="mon-d-faint">{busyText}</p> : null}
      {error ? <p className="pgd-error">Không phân tích được: {error}</p> : null}

      {d ? (
        <div className={busy ? 'pgd-stale' : undefined}>
          <p className="pgd-headline">{d.headline}</p>
          <p className="mon-d-faint pgd-nums">
            {nums}
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

              {extra}

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

              {foot ? <p className="mon-d-faint pgd-foot">{foot}</p> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
