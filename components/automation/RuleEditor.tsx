'use client';

// The rule editor — built entirely from lib/automation/catalog.ts.
//
// Nothing here knows what Zalo or Redis are: the group decides which triggers
// exist, the trigger decides which fields a condition can read, and the group
// decides which action types are on offer. Adding "Telegram reactions" or
// "Postgres replication lag" is a catalog entry, not a change to this file.

import { useEffect, useMemo, useState } from 'react';
import {
  GROUPS,
  OPERATORS,
  STACKS,
  groupOf,
  opDef,
  triggerDef,
  type FieldDef,
} from '@/lib/automation/catalog';
import { blankRule } from '@/lib/automation/engine';
import { listConnections, connLabel, type ConnOption } from '@/lib/automation/connections';
import type {
  AutomationAction,
  AutomationCondition,
  AutomationRule,
  ActionType,
  EventCategory,
  InfraStack,
  TriggerType,
} from '@/lib/automation/types';
import { accountKey, loadAccounts } from '@/lib/workspace/accounts';
import { messagingPlugins } from '@/lib/workspace/plugins';
import { Field, Num, Toggle } from './parts';

const ACTION_LABEL: Record<ActionType, string> = {
  notify: '🔔 Thông báo',
  webhook: '🌐 Gọi webhook',
  log: '📄 Ghi file log',
  kafka: '≋ Bắn Kafka',
  reply: '↩ Trả lời (cần duyệt)',
};

const DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/** Source options for the scope picker, per feature group. */
function useSourceOptions(category: EventCategory): { id: string; label: string }[] {
  return useMemo(() => {
    if (category === 'social') return messagingPlugins().map((p) => ({ id: p.id, label: p.name }));
    if (category === 'infra') return STACKS.map((s) => ({ id: s.id, label: `${s.icon} ${s.label}` }));
    return [];
  }, [category]);
}

/** Instance options: workspace accounts for social, connections for infra. */
function useInstanceOptions(category: EventCategory, sourceIds: string[]): { id: string; label: string }[] {
  const [infra, setInfra] = useState<{ id: string; label: string }[]>([]);
  const stacks = category === 'infra' ? (sourceIds.length ? sourceIds : STACKS.map((s) => s.id)) : [];
  const key = stacks.join(',');

  useEffect(() => {
    if (category !== 'infra') return;
    let alive = true;
    void Promise.all(
      key
        .split(',')
        .filter(Boolean)
        .map((s) => listConnections(s as InfraStack)),
    ).then((lists) => {
      if (!alive) return;
      setInfra(lists.flat().map((c) => ({ id: c.id, label: connLabel(c) })));
    });
    return () => {
      alive = false;
    };
  }, [category, key]);

  return useMemo(() => {
    if (category === 'infra') return infra;
    if (category !== 'social') return [];
    const plugins = messagingPlugins().filter((p) => !sourceIds.length || sourceIds.includes(p.id));
    // Qualify with the plugin id: every plugin's first account is `main`, so a
    // bare instanceId collides across apps (duplicate React keys, and a scope
    // entry that can't tell Zalo's "main" from Telegram's).
    return plugins.flatMap((p) =>
      loadAccounts(p).map((a) => ({
        id: accountKey(p.id, a.instanceId),
        label: `${p.name} — ${a.label}`,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, infra, sourceIds.join(',')]);
}

function CheckList({
  options,
  value,
  onChange,
  allLabel,
}: {
  options: { id: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  allLabel: string;
}) {
  if (!options.length) return <div className="auto-hint">chưa có lựa chọn nào</div>;
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="auto-checks">
      <button
        type="button"
        className={`auto-chip${value.length === 0 ? ' on' : ''}`}
        onClick={() => onChange([])}
      >
        {allLabel}
      </button>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`auto-chip${value.includes(o.id) ? ' on' : ''}`}
          onClick={() => toggle(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Conditions ─────────────────────────────────────────────────────────────

function ConditionRow({
  cond,
  fields,
  onChange,
  onRemove,
}: {
  cond: AutomationCondition;
  fields: FieldDef[];
  onChange: (c: AutomationCondition) => void;
  onRemove: () => void;
}) {
  const kind = opDef(cond.op).kind;
  const known = fields.some((f) => f.name === cond.field);
  return (
    <div className="auto-cond">
      <select
        value={known ? cond.field : '__custom'}
        onChange={(e) =>
          onChange({ ...cond, field: e.target.value === '__custom' ? '' : e.target.value })
        }
      >
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
        <option value="__custom">— trường khác —</option>
      </select>
      {!known ? (
        <input
          className="auto-cond-custom"
          value={cond.field}
          placeholder="tên trường"
          onChange={(e) => onChange({ ...cond, field: e.target.value })}
        />
      ) : null}
      <select value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value as AutomationCondition['op'] })}>
        {OPERATORS.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      {kind === 'unary' ? (
        <span className="auto-hint">không cần giá trị</span>
      ) : (
        <input
          type={kind === 'number' ? 'number' : 'text'}
          value={cond.value ?? ''}
          placeholder={kind === 'list' ? 'a, b, c' : kind === 'number' ? '0' : 'giá trị'}
          onChange={(e) => onChange({ ...cond, value: e.target.value })}
        />
      )}
      <button type="button" className="ghost sm" onClick={onRemove} title="Xoá điều kiện">
        ✕
      </button>
    </div>
  );
}

// ── Actions ────────────────────────────────────────────────────────────────

function ActionCard({
  action,
  allowed,
  onChange,
  onRemove,
}: {
  action: AutomationAction;
  allowed: ActionType[];
  onChange: (a: AutomationAction) => void;
  onRemove: () => void;
}) {
  const [kafkaConns, setKafkaConns] = useState<ConnOption[]>([]);
  useEffect(() => {
    if (action.type !== 'kafka') return;
    void listConnections('kafka').then(setKafkaConns);
  }, [action.type]);

  const switchType = (type: ActionType) => {
    if (type === action.type) return;
    onChange(defaultAction(type));
  };

  return (
    <div className="auto-action">
      <div className="auto-action-head">
        <select value={action.type} onChange={(e) => switchType(e.target.value as ActionType)}>
          {allowed.map((t) => (
            <option key={t} value={t}>
              {ACTION_LABEL[t]}
            </option>
          ))}
        </select>
        <button type="button" className="ghost sm" onClick={onRemove} title="Xoá hành động">
          ✕
        </button>
      </div>

      {action.type === 'notify' ? (
        <div className="auto-grid">
          <Field label="Mức độ">
            <select
              value={action.level}
              onChange={(e) => onChange({ ...action, level: e.target.value as typeof action.level })}
            >
              <option value="info">Thông tin</option>
              <option value="warn">Cảnh báo</option>
              <option value="urgent">Khẩn (không tự tắt)</option>
            </select>
          </Field>
          <Field label="Tiêu đề" hint="để trống = tiêu đề sự kiện">
            <input value={action.title ?? ''} onChange={(e) => onChange({ ...action, title: e.target.value })} />
          </Field>
          <Field label="Nội dung" wide hint="dùng {{sender}}, {{text}}, {{value}}…">
            <input value={action.body ?? ''} onChange={(e) => onChange({ ...action, body: e.target.value })} />
          </Field>
          <Toggle
            checked={!!action.sound}
            onChange={(v) => onChange({ ...action, sound: v })}
            label="Có tiếng"
            hint="kêu cả khi workspace đang tắt tiếng"
          />
        </div>
      ) : null}

      {action.type === 'webhook' ? (
        <div className="auto-grid">
          <Field label="Phương thức">
            <select
              value={action.method}
              onChange={(e) => onChange({ ...action, method: e.target.value as typeof action.method })}
            >
              <option>POST</option>
              <option>PUT</option>
              <option>GET</option>
            </select>
          </Field>
          <Field label="URL" wide hint="chạy phía server — không dính CORS">
            <input value={action.url} placeholder="https://…" onChange={(e) => onChange({ ...action, url: e.target.value })} />
          </Field>
          <Field label="Body" wide hint="để trống = toàn bộ sự kiện dạng JSON">
            <input
              value={action.bodyTemplate ?? ''}
              placeholder='{"text":"{{title}}"}'
              onChange={(e) => onChange({ ...action, bodyTemplate: e.target.value })}
            />
          </Field>
        </div>
      ) : null}

      {action.type === 'log' ? (
        <Field label="Tên file" hint="cùng thư mục DevBox, đuôi .jsonl — để trống = .automation-log.jsonl">
          <input value={action.file ?? ''} placeholder=".automation-log.jsonl" onChange={(e) => onChange({ ...action, file: e.target.value })} />
        </Field>
      ) : null}

      {action.type === 'kafka' ? (
        <div className="auto-grid">
          <Field label="Kết nối">
            <select value={action.connectionId} onChange={(e) => onChange({ ...action, connectionId: e.target.value })}>
              <option value="">— chọn —</option>
              {kafkaConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {connLabel(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Topic">
            <input value={action.topic} onChange={(e) => onChange({ ...action, topic: e.target.value })} />
          </Field>
          <Field label="Key" hint="để trống = instanceId">
            <input value={action.key ?? ''} onChange={(e) => onChange({ ...action, key: e.target.value })} />
          </Field>
          <Field label="Value" wide hint="để trống = toàn bộ sự kiện dạng JSON">
            <input
              value={action.valueTemplate ?? ''}
              onChange={(e) => onChange({ ...action, valueTemplate: e.target.value })}
            />
          </Field>
        </div>
      ) : null}

      {action.type === 'reply' ? (
        <div className="auto-grid">
          <Field label="Nội dung trả lời" wide hint="LUÔN cần bật 'cho phép gửi' + duyệt tay — không bao giờ tự gửi">
            <input value={action.text} onChange={(e) => onChange({ ...action, text: e.target.value })} />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function defaultAction(type: ActionType): AutomationAction {
  switch (type) {
    case 'notify':
      return { type: 'notify', level: 'info' };
    case 'webhook':
      return { type: 'webhook', url: '', method: 'POST' };
    case 'log':
      return { type: 'log', file: '' };
    case 'kafka':
      return { type: 'kafka', connectionId: '', topic: '' };
    case 'reply':
      return { type: 'reply', text: '', requireApproval: true };
  }
}

// ── The editor ─────────────────────────────────────────────────────────────

export default function RuleEditor({
  rule,
  onChange,
}: {
  rule: AutomationRule;
  onChange: (r: AutomationRule) => void;
}) {
  const group = groupOf(rule.category);
  const trig = triggerDef(rule.trigger) ?? group.triggers[0];
  const fields = trig?.fields ?? [];
  const sources = useSourceOptions(rule.category);
  const instances = useInstanceOptions(rule.category, rule.scope.sourceIds);
  const set = (patch: Partial<AutomationRule>) => onChange({ ...rule, ...patch });

  const changeCategory = (category: EventCategory) => {
    // A rule's conditions and actions are written against its trigger; moving
    // it to another group would leave both dangling. Start clean, keep name.
    const fresh = blankRule(category, rule.name);
    onChange({ ...fresh, id: rule.id, enabled: rule.enabled, dryRun: rule.dryRun, notes: rule.notes });
  };

  return (
    <div className="auto-editor">
      <div className="auto-grid">
        <Field label="Tên quy tắc" wide>
          <input value={rule.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Nhóm tính năng" hint={group.blurb}>
          <select value={rule.category} onChange={(e) => changeCategory(e.target.value as EventCategory)}>
            {GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.icon} {g.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Khi nào chạy" hint={trig?.blurb}>
          <select value={rule.trigger} onChange={(e) => set({ trigger: e.target.value as TriggerType })}>
            {group.triggers.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="auto-switches">
        <Toggle checked={rule.enabled} onChange={(v) => set({ enabled: v })} label="Bật" />
        <Toggle
          checked={rule.dryRun}
          onChange={(v) => set({ dryRun: v })}
          label="Chạy thử"
          hint="đánh giá + ghi nhật ký, không thực thi (thông báo vẫn hiện để xem trước)"
        />
        <Toggle
          checked={!!rule.stopOnMatch}
          onChange={(v) => set({ stopOnMatch: v })}
          label="Dừng tại đây"
          hint="khớp rồi thì bỏ qua các quy tắc phía sau"
        />
      </div>

      <section className="auto-sec">
        <h4>Phạm vi</h4>
        <Field label={rule.category === 'infra' ? 'Stack' : 'Ứng dụng'}>
          <CheckList
            options={sources}
            value={rule.scope.sourceIds}
            onChange={(v) => set({ scope: { ...rule.scope, sourceIds: v } })}
            allLabel="Tất cả"
          />
        </Field>
        <Field label={rule.category === 'infra' ? 'Kết nối' : 'Tài khoản'}>
          <CheckList
            options={instances}
            value={rule.scope.instanceIds}
            onChange={(v) => set({ scope: { ...rule.scope, instanceIds: v } })}
            allLabel="Tất cả"
          />
        </Field>
      </section>

      <section className="auto-sec">
        <h4>
          Điều kiện
          <select
            className="auto-mode"
            value={rule.match.mode}
            onChange={(e) => set({ match: { ...rule.match, mode: e.target.value as 'all' | 'any' } })}
          >
            <option value="all">thoả TẤT CẢ</option>
            <option value="any">thoả BẤT KỲ</option>
          </select>
        </h4>
        {rule.match.conditions.map((c, i) => (
          <ConditionRow
            key={i}
            cond={c}
            fields={fields}
            onChange={(next) =>
              set({
                match: {
                  ...rule.match,
                  conditions: rule.match.conditions.map((x, j) => (i === j ? next : x)),
                },
              })
            }
            onRemove={() =>
              set({ match: { ...rule.match, conditions: rule.match.conditions.filter((_, j) => j !== i) } })
            }
          />
        ))}
        <button
          type="button"
          className="ghost sm"
          onClick={() =>
            set({
              match: {
                ...rule.match,
                conditions: [...rule.match.conditions, { field: fields[0]?.name ?? 'text', op: 'contains', value: '' }],
              },
            })
          }
        >
          ＋ điều kiện
        </button>
        {!rule.match.conditions.length ? (
          <div className="auto-hint">không có điều kiện = khớp mọi sự kiện trong phạm vi</div>
        ) : null}
      </section>

      <section className="auto-sec">
        <h4>Hành động</h4>
        {rule.actions.map((a, i) => (
          <ActionCard
            key={i}
            action={a}
            allowed={group.actions}
            onChange={(next) => set({ actions: rule.actions.map((x, j) => (i === j ? next : x)) })}
            onRemove={() => set({ actions: rule.actions.filter((_, j) => j !== i) })}
          />
        ))}
        <button
          type="button"
          className="ghost sm"
          onClick={() => set({ actions: [...rule.actions, defaultAction(group.actions[0])] })}
        >
          ＋ hành động
        </button>
      </section>

      <section className="auto-sec">
        <h4>Khung giờ & giới hạn</h4>
        <div className="auto-grid">
          <Field label="Chỉ chạy trong khung giờ">
            <Toggle
              checked={!!rule.window}
              onChange={(v) => set({ window: v ? { days: [], from: '08:00', to: '18:00' } : undefined })}
              label={rule.window ? 'đang bật' : 'cả ngày'}
            />
          </Field>
          {rule.window ? (
            <>
              <Field label="Từ">
                <input
                  type="time"
                  value={rule.window.from}
                  onChange={(e) => set({ window: { ...rule.window!, from: e.target.value } })}
                />
              </Field>
              <Field label="Đến" hint="từ > đến = qua đêm (22:00 → 06:00)">
                <input
                  type="time"
                  value={rule.window.to}
                  onChange={(e) => set({ window: { ...rule.window!, to: e.target.value } })}
                />
              </Field>
              <Field label="Ngày trong tuần" wide hint="không chọn = mọi ngày">
                <div className="auto-checks">
                  {DAYS.map((d, i) => (
                    <button
                      key={d}
                      type="button"
                      className={`auto-chip${rule.window!.days.includes(i) ? ' on' : ''}`}
                      onClick={() => {
                        const days = rule.window!.days.includes(i)
                          ? rule.window!.days.filter((x) => x !== i)
                          : [...rule.window!.days, i].sort();
                        set({ window: { ...rule.window!, days } });
                      }}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </Field>
            </>
          ) : null}
          <Field label="Chống trùng (giây)" hint="bỏ qua tin trùng nội dung trong N giây">
            <Num value={rule.limits?.dedupeSec} onChange={(v) => set({ limits: { ...rule.limits, dedupeSec: v } })} />
          </Field>
          <Field label="Nghỉ giữa 2 lần (giây)">
            <Num value={rule.limits?.cooldownSec} onChange={(v) => set({ limits: { ...rule.limits, cooldownSec: v } })} />
          </Field>
          <Field label="Tối đa mỗi giờ">
            <Num value={rule.limits?.maxPerHour} onChange={(v) => set({ limits: { ...rule.limits, maxPerHour: v } })} />
          </Field>
        </div>
      </section>

      <Field label="Ghi chú" wide>
        <input value={rule.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </div>
  );
}
