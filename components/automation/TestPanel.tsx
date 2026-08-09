'use client';

// Test console — write an event by hand and see exactly which rules would fire.
//
// "Thử" uses automation.dryEvaluate(): a throwaway engine state, so testing can
// never eat a real rule's cooldown or dedupe window. "Bắn thật" pushes the same
// event through the live pipeline, side effects and all.

import { useMemo, useState } from 'react';
import { GROUPS, groupOf, triggerDef } from '@/lib/automation/catalog';
import { automation } from '@/lib/automation/useAutomation';
import type {
  ActionPlan,
  AutomationEvent,
  EvaluationResult,
  EventCategory,
  TriggerType,
} from '@/lib/automation/types';
import { Field } from './parts';

const CORE = new Set(['title', 'text', 'source', 'instance']);

/** The plan dump is a debugging surface, not a place to put a bot token or an
 *  API key on screen — those are typed into masked inputs for a reason. */
const SECRETS = new Set(['botToken', 'token']);
const dumpPlans = (plans: ActionPlan[]): string =>
  JSON.stringify(plans, (k, v) => (SECRETS.has(k) && typeof v === 'string' && v ? '••••••' : v), 2);

export default function TestPanel() {
  const [category, setCategory] = useState<EventCategory>('social');
  const [trigger, setTrigger] = useState<TriggerType>('message.received');
  const [sourceId, setSourceId] = useState('zalo');
  const [instanceId, setInstanceId] = useState('main');
  const [title, setTitle] = useState('Sếp Tâm');
  const [text, setText] = useState('Anh gửi báo cáo giúp em nhé');
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [live, setLive] = useState(false);

  const group = groupOf(category);
  const fields = useMemo(
    () => (triggerDef(trigger)?.fields ?? []).filter((f) => !CORE.has(f.name)),
    [trigger],
  );

  const build = (): AutomationEvent => ({
    id: `test:${Date.now()}`,
    ts: Date.now(),
    category,
    type: trigger,
    sourceId,
    instanceId,
    instanceLabel: instanceId,
    title,
    text,
    fields: Object.fromEntries(
      Object.entries(extra)
        .filter(([, v]) => v !== '')
        .map(([k, v]) => [k, Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : v]),
    ),
  });

  const runDry = () => {
    setLive(false);
    setResult(automation.dryEvaluate(build()));
  };

  const runLive = async () => {
    setLive(true);
    setResult(await automation.submit(build()));
  };

  return (
    <div className="panel auto-test">
      <div className="auto-grid">
        <Field label="Nhóm">
          <select
            value={category}
            onChange={(e) => {
              const c = e.target.value as EventCategory;
              setCategory(c);
              setTrigger(groupOf(c).triggers[0].type);
              setExtra({});
            }}
          >
            {GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.icon} {g.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Loại sự kiện">
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as TriggerType)}>
            {group.triggers.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nguồn" hint="zalo · telegram · redis …">
          <input value={sourceId} onChange={(e) => setSourceId(e.target.value)} />
        </Field>
        <Field label="Tài khoản / kết nối">
          <input value={instanceId} onChange={(e) => setInstanceId(e.target.value)} />
        </Field>
        <Field label="Tiêu đề" wide>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Nội dung" wide>
          <input value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {fields.map((f) => (
          <Field key={f.name} label={f.label} hint={f.hint}>
            <input
              type={f.kind === 'number' ? 'number' : 'text'}
              value={extra[f.name] ?? ''}
              onChange={(e) => setExtra((x) => ({ ...x, [f.name]: e.target.value }))}
            />
          </Field>
        ))}
      </div>

      <div className="auto-switches">
        <button type="button" onClick={runDry}>
          Thử (không chạy)
        </button>
        <button type="button" className="ghost" onClick={() => void runLive()}>
          Bắn thật
        </button>
        <span className="auto-hint">
          “Bắn thật” đi qua đúng đường dẫn của sự kiện thật: có thể gọi API, gửi Telegram, ghi log, bắn Kafka.
        </span>
      </div>

      {result ? (
        <div className="auto-result">
          <h4>{live ? 'Đã bắn thật' : 'Kết quả thử'}</h4>
          <ul className="auto-dec">
            {result.decisions.map((d, i) => (
              <li key={i} className={d.matched ? 'ok' : ''}>
                <b>{d.ruleName}</b> — {d.matched ? 'khớp' : (d.skipped ?? 'không khớp')}
              </li>
            ))}
            {!result.decisions.length ? <li>chưa có quy tắc nào</li> : null}
          </ul>
          <h4>Hành động ({result.plans.length})</h4>
          <pre className="auto-probe">
            {result.plans.length ? dumpPlans(result.plans) : '— không có —'}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
