'use client';

// What the engine actually did, newest first. This is the honesty surface: an
// event that matched nothing still shows up, with the reason each rule skipped
// it — that is how you debug a rule that "doesn't work".

import { groupOf } from '@/lib/automation/catalog';
import { automation } from '@/lib/automation/useAutomation';
import type { ActionOutcome, ActivityEntry, RuleDecision, SkipReason } from '@/lib/automation/types';
import { Empty } from './parts';

const SKIP: Record<SkipReason, string> = {
  'config-disabled': 'engine đang tắt',
  'rule-disabled': 'quy tắc tắt',
  trigger: 'khác loại sự kiện',
  scope: 'ngoài phạm vi',
  window: 'ngoài khung giờ',
  'no-match': 'không khớp điều kiện',
  dedupe: 'trùng nội dung',
  cooldown: 'đang nghỉ',
  'rate-limit': 'vượt giới hạn/giờ',
};

const STATUS: Record<ActionOutcome['status'], string> = {
  ok: 'ok',
  error: 'lỗi',
  skipped: 'bỏ qua',
  'dry-run': 'chạy thử',
  'pending-approval': 'chờ duyệt',
};

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const decisionText = (d: RuleDecision): string =>
  d.matched ? `${d.ruleName}: khớp` : `${d.ruleName}: ${d.skipped ? SKIP[d.skipped] : 'không khớp'}`;

export default function ActivityPanel({ activity }: { activity: ActivityEntry[] }) {
  if (!activity.length) {
    return (
      <div className="panel">
        <Empty
          icon="🕓"
          text="Chưa có sự kiện nào. Bật thu thập tin nhắn hoặc theo dõi hạ tầng, hoặc bắn một sự kiện thử ở tab Thử."
        />
      </div>
    );
  }

  return (
    <div className="panel auto-activity">
      <div className="auto-list-head">
        <span className="auto-hint">{activity.length} sự kiện gần nhất</span>
        <button type="button" className="ghost sm" onClick={() => automation.clearActivity()}>
          Xoá danh sách
        </button>
      </div>

      {activity.map((a, i) => {
        const matched = a.decisions.filter((d) => d.matched);
        return (
          <div key={`${a.event.id}-${i}`} className="auto-act">
            <span className="auto-act-time">{time(a.event.ts)}</span>
            <span className="auto-act-ico" aria-hidden>
              {groupOf(a.event.category).icon}
            </span>
            <span className="auto-act-main">
              <span className="auto-act-title">
                {a.event.title}
                <em className="auto-act-src">
                  {a.event.sourceId} · {a.event.instanceLabel}
                </em>
              </span>
              {a.event.text ? <span className="auto-act-text">{a.event.text}</span> : null}
              <span className="auto-act-meta">
                {matched.length ? (
                  a.outcomes.map((o, j) => (
                    <em key={j} className={`auto-out st-${o.status}`} title={o.detail}>
                      {o.type} · {STATUS[o.status]}
                    </em>
                  ))
                ) : (
                  <em className="auto-out st-skipped">không quy tắc nào khớp</em>
                )}
                <em className="auto-act-dec" title={a.decisions.map(decisionText).join('\n')}>
                  {a.decisions.length} quy tắc đã xét
                </em>
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
