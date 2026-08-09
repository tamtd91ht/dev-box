'use client';

// Rule list + editor. Order matters (a rule with "dừng tại đây" hides the ones
// below it), so the list is explicitly reorderable rather than sorted.

import { useState } from 'react';
import { GROUPS, groupOf, triggerDef } from '@/lib/automation/catalog';
import { blankRule, newId } from '@/lib/automation/engine';
import type { AutomationConfig, AutomationRule, EventCategory } from '@/lib/automation/types';
import { Empty } from './parts';
import RuleEditor from './RuleEditor';
import { useSplit } from '@/lib/useSplit';
import Splitter from '../Splitter';

const actionSummary = (r: AutomationRule): string =>
  r.actions.length ? r.actions.map((a) => a.type).join(' · ') : 'chưa có hành động';

export default function RulesPanel({
  config,
  onChange,
}: {
  config: AutomationConfig;
  onChange: (next: AutomationConfig) => void;
}) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--auto-list', min: 200, max: 640, gap: 12 });
  const [filter, setFilter] = useState<EventCategory | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const rules = config.rules;
  const shown = filter === 'all' ? rules : rules.filter((r) => r.category === filter);
  const current = rules.find((r) => r.id === selected) ?? null;

  const setRules = (next: AutomationRule[]) => onChange({ ...config, rules: next });
  const patch = (id: string, p: Partial<AutomationRule>) =>
    setRules(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const add = () => {
    const category: EventCategory = filter === 'all' ? 'social' : filter;
    const r = blankRule(category, `Quy tắc ${rules.length + 1}`);
    setRules([...rules, r]);
    setSelected(r.id);
  };

  const duplicate = (r: AutomationRule) => {
    const copy: AutomationRule = { ...r, id: newId('r'), name: `${r.name} (bản sao)`, enabled: false, dryRun: true };
    const at = rules.findIndex((x) => x.id === r.id);
    setRules([...rules.slice(0, at + 1), copy, ...rules.slice(at + 1)]);
    setSelected(copy.id);
  };

  const remove = (r: AutomationRule) => {
    setRules(rules.filter((x) => x.id !== r.id));
    if (selected === r.id) setSelected(null);
  };

  const move = (r: AutomationRule, dir: -1 | 1) => {
    const at = rules.findIndex((x) => x.id === r.id);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= rules.length) return;
    const next = [...rules];
    [next[at], next[to]] = [next[to], next[at]];
    setRules(next);
  };

  return (
    <div className="auto-split" ref={railSplit.ref} style={railSplit.style}>
      <div className="auto-list panel">
        <div className="auto-list-head">
          <div className="auto-checks">
            <button
              type="button"
              className={`auto-chip${filter === 'all' ? ' on' : ''}`}
              onClick={() => setFilter('all')}
            >
              Tất cả <span className="auto-count">{rules.length}</span>
            </button>
            {GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`auto-chip${filter === g.id ? ' on' : ''}`}
                onClick={() => setFilter(g.id)}
              >
                {g.icon} {g.label}
                <span className="auto-count">{rules.filter((r) => r.category === g.id).length}</span>
              </button>
            ))}
          </div>
          <button type="button" className="sm" onClick={add}>
            ＋ Quy tắc
          </button>
        </div>

        {!shown.length ? (
          <Empty icon="🗂" text="Chưa có quy tắc nào trong nhóm này." />
        ) : (
          <div className="auto-rules">
            {shown.map((r) => (
              <div
                key={r.id}
                className={`auto-rule${selected === r.id ? ' on' : ''}${r.enabled ? '' : ' off'}`}
                onClick={() => setSelected(r.id)}
              >
                <span className="auto-rule-ico" aria-hidden>
                  {groupOf(r.category).icon}
                </span>
                <span className="auto-rule-main">
                  <span className="auto-rule-name">
                    {r.name}
                    {r.dryRun ? <em className="auto-dry">thử</em> : null}
                    {r.stopOnMatch ? <em className="auto-stop">dừng</em> : null}
                  </span>
                  <span className="auto-rule-sub">
                    {triggerDef(r.trigger)?.label ?? r.trigger} → {actionSummary(r)}
                  </span>
                </span>
                <span className="auto-rule-ops" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    title={r.enabled ? 'Đang bật' : 'Đang tắt'}
                    onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                  />
                  <button type="button" className="ghost sm" title="Lên" onClick={() => move(r, -1)}>↑</button>
                  <button type="button" className="ghost sm" title="Xuống" onClick={() => move(r, 1)}>↓</button>
                  <button type="button" className="ghost sm" title="Nhân bản" onClick={() => duplicate(r)}>⧉</button>
                  <button type="button" className="ghost sm" title="Xoá" onClick={() => remove(r)}>✕</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="auto-detail panel">
        {current ? (
          <RuleEditor rule={current} onChange={(next) => setRules(rules.map((r) => (r.id === next.id ? next : r)))} />
        ) : (
          <Empty icon="👈" text="Chọn một quy tắc để sửa, hoặc tạo quy tắc mới." />
        )}
      </div>
      <Splitter {...railSplit.grip} />
    </div>
  );
}
