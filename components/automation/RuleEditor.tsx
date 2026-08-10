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
import { listConnections, connLabel } from '@/lib/automation/connections';
import type {
  AutomationCondition,
  AutomationRule,
  EventCategory,
  InfraStack,
  TriggerType,
} from '@/lib/automation/types';
import { accountKey, loadAccounts } from '@/lib/workspace/accounts';
import type { TargetGroup } from '@/lib/workspace/targets';
import { messagingPlugins } from '@/lib/workspace/plugins';
import { loadZaloApiAccounts, zaloApiAccountKey } from '@/lib/zaloapi/accounts';
import { Field, Num, Section, Toggle } from './parts';
import ActionCard, { defaultAction } from './ActionCard';

const DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/** Source options for the scope picker, per feature group. */
function useSourceOptions(category: EventCategory): { id: string; label: string }[] {
  return useMemo(() => {
    if (category === 'social') {
      // Workspace (DOM) + nhánh Zalo API (sourceId 'zaloapi'). Zalo API không
      // phải workspace plugin nên phải thêm tay ở đây.
      return [
        ...messagingPlugins().map((p) => ({ id: p.id, label: p.name })),
        { id: 'zaloapi', label: '🟦 Zalo API' },
      ];
    }
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
    const workspace = plugins.flatMap((p) =>
      loadAccounts(p).map((a) => ({
        id: accountKey(p.id, a.instanceId),
        label: `${p.name} — ${a.label}`,
      })),
    );
    // Tài khoản nhánh Zalo API (accountKey 'zaloapi::<id>').
    const zaloApi = !sourceIds.length || sourceIds.includes('zaloapi')
      ? loadZaloApiAccounts().map((a) => ({ id: zaloApiAccountKey(a.instanceId), label: `Zalo API — ${a.label}` }))
      : [];
    return [...workspace, ...zaloApi];
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

/**
 * Conversations a social rule can be limited to.
 *
 * Offered from the send-target directory (`configs/wstargets.json`) — the same
 * lists built in the Workspace tab's 🔎 panel, so a conversation you already
 * curated once is one click here. Free text stays available: a rule may need a
 * conversation you never send to.
 */
function ConversationScope({
  value,
  onChange,
  accountKeys,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  /** Accounts the rule is scoped to; empty = offer every saved conversation. */
  accountKeys: string[];
}) {
  const [known, setKnown] = useState<{ name: string; kind: 'group' | 'user' }[]>([]);
  const [custom, setCustom] = useState('');

  useEffect(() => {
    let alive = true;
    void fetch('/api/ws-targets')
      .then((r) => r.json())
      .then((d: { groups?: TargetGroup[] }) => {
        if (!alive) return;
        const seen = new Map<string, 'group' | 'user'>();
        for (const g of d.groups ?? []) {
          if (accountKeys.length && !accountKeys.includes(g.accountKey)) continue;
          for (const t of g.targets) if (!seen.has(t.name)) seen.set(t.name, t.kind);
        }
        setKnown([...seen.entries()].map(([name, kind]) => ({ name, kind })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKeys.join(',')]);

  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((x) => x !== name) : [...value, name]);

  const add = () => {
    const n = custom.replace(/\s+/g, ' ').trim();
    if (n && !value.includes(n)) onChange([...value, n]);
    setCustom('');
  };

  // Names the rule uses that are not in the directory — still removable.
  const extra = value.filter((v) => !known.some((k) => k.name === v));

  return (
    <>
      <div className="auto-checks">
        <button type="button" className={`auto-chip${!value.length ? ' on' : ''}`} onClick={() => onChange([])}>
          Mọi hội thoại
        </button>
        {known.map((k) => (
          <button
            key={k.name}
            type="button"
            className={`auto-chip${value.includes(k.name) ? ' on' : ''}`}
            onClick={() => toggle(k.name)}
          >
            {k.kind === 'group' ? '👥' : '👤'} {k.name}
          </button>
        ))}
        {extra.map((n) => (
          <button key={n} type="button" className="auto-chip on" onClick={() => toggle(n)}>
            {n} ✕
          </button>
        ))}
      </div>
      <div className="auto-cond" style={{ marginTop: 6 }}>
        <input
          value={custom}
          placeholder="tên hội thoại khác — gõ đúng như hiện trong Zalo"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="ghost sm" disabled={!custom.trim()} onClick={add}>
          ＋ thêm
        </button>
      </div>
      {!known.length && (
        <span className="auto-hint">
          Chưa có danh sách nào trong danh bạ — vào tab 🧭 Workspace → 🔎 để quét và lưu, hoặc gõ tay
          tên hội thoại ở trên.
        </span>
      )}
    </>
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

// ── The editor ─────────────────────────────────────────────────────────────

export default function RuleEditor({
  rule,
  onChange,
}: {
  rule: AutomationRule;
  onChange: (r: AutomationRule) => void;
}) {
  /**
   * Which action cards are open, by index. Absent = open.
   *
   * Kept HERE rather than inside each card so "thu gọn tất cả" can reach them,
   * and so the map can be re-indexed when a card is removed — otherwise
   * deleting the second card would fold whichever card took its place.
   */
  const [folded, setFolded] = useState<Record<number, boolean>>({});
  const isOpen = (i: number) => folded[i] !== true;
  const toggleAt = (i: number) => setFolded((f) => ({ ...f, [i]: !f[i] }));
  const foldAll = (v: boolean) =>
    setFolded(Object.fromEntries(rule.actions.map((_, i) => [i, v])));
  const dropAt = (i: number) =>
    setFolded((f) => {
      const next: Record<number, boolean> = {};
      for (const [k, v] of Object.entries(f)) {
        const n = Number(k);
        if (n < i) next[n] = v;
        else if (n > i) next[n - 1] = v;
      }
      return next;
    });

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

      <Section title="Phạm vi">
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
        {rule.category === 'social' && (
          <Field
            label="Hội thoại"
            hint="giới hạn theo TÊN hội thoại — nhóm hoặc chat 1-1. Để trống = mọi hội thoại của các tài khoản trên"
          >
            <ConversationScope
              value={rule.scope.conversations ?? []}
              onChange={(v) => set({ scope: { ...rule.scope, conversations: v } })}
              accountKeys={rule.scope.instanceIds}
            />
          </Field>
        )}
      </Section>

      <Section
        title={`Điều kiện (${rule.match.conditions.length})`}
        extra={
          <select
            className="auto-mode"
            value={rule.match.mode}
            onChange={(e) => set({ match: { ...rule.match, mode: e.target.value as 'all' | 'any' } })}
          >
            <option value="all">thoả TẤT CẢ</option>
            <option value="any">thoả BẤT KỲ</option>
          </select>
        }
      >
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
      </Section>

      <Section
        title={`Hành động (${rule.actions.length})`}
        extra={
          rule.actions.length > 1 ? (
            <span className="auto-sec-tools">
              <button type="button" className="ghost sm" onClick={() => foldAll(true)}>
                thu gọn tất cả
              </button>
              <button type="button" className="ghost sm" onClick={() => foldAll(false)}>
                mở tất cả
              </button>
            </span>
          ) : undefined
        }
      >
        {rule.actions.map((a, i) => (
          <ActionCard
            key={i}
            action={a}
            allowed={group.actions}
            open={isOpen(i)}
            onToggle={() => toggleAt(i)}
            onChange={(next) => set({ actions: rule.actions.map((x, j) => (i === j ? next : x)) })}
            onRemove={() => {
              dropAt(i);
              set({ actions: rule.actions.filter((_, j) => j !== i) });
            }}
          />
        ))}
        <button
          type="button"
          className="ghost sm"
          onClick={() => set({ actions: [...rule.actions, defaultAction(group.actions[0])] })}
        >
          ＋ hành động
        </button>
      </Section>

      <Section title="Khung giờ & giới hạn" defaultOpen={false}>
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
      </Section>

      <Field label="Ghi chú" wide>
        <input value={rule.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </div>
  );
}
