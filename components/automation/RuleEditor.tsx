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
  InfraWatch,
  RuleLimits,
  TriggerType,
} from '@/lib/automation/types';
import { accountKey, loadAccounts } from '@/lib/workspace/accounts';
import type { TargetGroup } from '@/lib/workspace/targets';
import { messagingPlugins } from '@/lib/workspace/plugins';
import { loadZaloApiAccounts, zaloApiAccountKey } from '@/lib/zaloapi/accounts';
import { zaloApiContacts } from '@/lib/zaloapi/api';
import { TEMPLATE_CORE_VARS } from '@/lib/automation/meta';
import { Field, Num, Section, Toggle } from './parts';
import ActionCard, { defaultAction } from './ActionCard';
import VarsPanel from './VarsPanel';
import { TplVars } from './TplField';

const DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

const SEV_ICON: Record<string, string> = { critical: '🔴', warning: '🟠', info: '🔵' };

/** Dấu so sánh cho dòng tóm tắt "metric > ngưỡng". Khớp với WatchesPanel. */
const OP_TEXT: Record<string, string> = {
  gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠',
};

/**
 * Pick the watches a rule answers for, BY ID.
 *
 * Shows the name (what a human recognises) over the id (what the rule stores),
 * because a rule written against ids is unreadable otherwise. The list narrows to
 * the Stack/Connection already chosen above — with 150+ watches declared, an
 * unfiltered list is not something you can pick from.
 *
 * Empty selection = every watch passing Stack/Connection. That matches how the
 * two pickers above already behave, and means a watch added later is covered by
 * the rule without anyone having to remember to come back here.
 */
function WatchScope({
  watches,
  value,
  onChange,
  stacks,
  instances,
  onOpenWatch,
}: {
  watches: InfraWatch[];
  value: string[];
  onChange: (v: string[]) => void;
  stacks: string[];
  instances: string[];
  /** Mở watch này ở tab Theo dõi hạ tầng để sửa. Vắng = không hiện nút. */
  onOpenWatch?: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  // Joined once: the arrays are fresh objects on every render, so memoizing on
  // their contents rather than their identity is what keeps this stable.
  const stackKey = stacks.join(',');
  const instanceKey = instances.join(',');

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const stackSet = stackKey ? new Set(stackKey.split(',')) : null;
    const instSet = instanceKey ? new Set(instanceKey.split(',')) : null;
    return watches.filter((w) => {
      if (stackSet && !stackSet.has(w.stack)) return false;
      if (instSet && !instSet.has(w.connectionId)) return false;
      if (!needle) return true;
      const hay = `${w.name} ${w.id} ${w.connectionLabel ?? ''} ${w.metric} ${(w.tags ?? []).join(' ')}`;
      return hay.toLowerCase().includes(needle);
    });
  }, [watches, stackKey, instanceKey, q]);

  // A selected watch the filters now hide is still selected — surfacing the count
  // stops a narrowed view from reading as "the rule only covers these".
  const hiddenSelected = value.filter((id) => !visible.some((w) => w.id === id)).length;
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="auto-watchscope">
      <div className="auto-watchscope-bar">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Tìm trong ${visible.length} watch…`}
        />
        {/* Union, not replace: with a filter active, replacing would silently
            drop the watches the filter is hiding — and a non-empty watchIds
            means those watches stop being covered by the rule at all. */}
        <button
          type="button"
          className="ghost sm"
          title="Thêm mọi watch đang hiện vào lựa chọn (không bỏ watch đang bị lọc ẩn)"
          onClick={() => onChange([...new Set([...value, ...visible.map((w) => w.id)])])}
        >
          Chọn hết
        </button>
        <button
          type="button"
          className="ghost sm"
          disabled={!visible.some((w) => value.includes(w.id))}
          title="Bỏ chọn các watch đang hiện"
          onClick={() => onChange(value.filter((id) => !visible.some((w) => w.id === id)))}
        >
          Bỏ chọn
        </button>
      </div>

      <div className="auto-watchscope-note">
        {value.length === 0 ? (
          <>
            <b>Tất cả</b> watch thoả Stack/Kết nối ở trên — kể cả watch thêm về sau
          </>
        ) : (
          <>
            đã chọn <b>{value.length}</b> watch
            {hiddenSelected ? ` (${hiddenSelected} đang bị lọc ẩn)` : ''}
          </>
        )}
      </div>

      {!visible.length ? (
        <div className="auto-watchscope-empty">
          {watches.length ? 'Không watch nào khớp bộ lọc.' : 'Chưa khai báo watch nào ở tab Theo dõi hạ tầng.'}
        </div>
      ) : (
        <div className="auto-watchscope-list">
          {visible.map((w) => (
            <label key={w.id} className={`auto-watchscope-row${value.includes(w.id) ? ' on' : ''}`}>
              <input type="checkbox" checked={value.includes(w.id)} onChange={() => toggle(w.id)} />
              <span className="auto-watchscope-main">
                <span className="auto-watchscope-name">
                  {SEV_ICON[w.severity ?? 'warning']} {w.name}
                  {w.enabled ? null : <em className="auto-watchscope-off">đang tắt</em>}
                </span>
                <span className="auto-watchscope-sub">
                  {w.connectionLabel || w.connectionId || '—'} · {w.metric} {OP_TEXT[w.op] ?? w.op}{' '}
                  {w.threshold}
                </span>
                <code className="auto-watchscope-id">{w.id}</code>
              </span>
              {/* Sang thẳng watch để sửa ngưỡng, thay vì tự đi tìm nó giữa 150+
                  mục ở tab kia. Nút nằm TRONG <label> nên phải chặn cả click
                  (label sẽ chuyển click vào checkbox → chọn/bỏ chọn nhầm) lẫn
                  mousedown (nếu không, ô đang sửa mất focus trước khi kịp đi). */}
              {onOpenWatch ? (
                <button
                  type="button"
                  className="auto-watchscope-go"
                  title={`Mở "${w.name}" ở tab Theo dõi hạ tầng để sửa (ngưỡng, chu kỳ, mức độ…)`}
                  aria-label={`Mở watch ${w.name} để sửa`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenWatch(w.id);
                  }}
                >
                  Xem ↗
                </button>
              ) : null}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

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
/** Bỏ dấu tiếng Việt để search "tam" khớp "Tâm". */
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
}

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
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    const seen = new Map<string, 'group' | 'user'>();

    // Danh bạ Workspace (bám tên) + danh bạ Zalo API (tự học từ tin đến).
    const jobs: Promise<unknown>[] = [
      fetch('/api/ws-targets')
        .then((r) => r.json())
        .then((d: { groups?: TargetGroup[] }) => {
          for (const g of d.groups ?? []) {
            if (accountKeys.length && !accountKeys.includes(g.accountKey)) continue;
            for (const t of g.targets) if (!seen.has(t.name)) seen.set(t.name, t.kind);
          }
        })
        .catch(() => undefined),
    ];

    // Nếu scope trống hoặc có tài khoản zaloapi::* → nạp danh bạ Zalo API. Tên
    // phải KHỚP cách zaloIncomingEvent đặt fields.conversation (tên người gửi /
    // tên hội thoại), nếu không rule scope theo tên sẽ không bao giờ match.
    const zaKeys = accountKeys.length ? accountKeys.filter((k) => k.startsWith('zaloapi::')) : ['zaloapi::main'];
    for (const key of zaKeys) {
      jobs.push(
        zaloApiContacts(key)
          .then((cs) => { for (const c of cs) if (!seen.has(c.name)) seen.set(c.name, c.group ? 'group' : 'user'); })
          .catch(() => undefined),
      );
    }

    void Promise.all(jobs).then(() => {
      if (alive) setKnown([...seen.entries()].map(([name, kind]) => ({ name, kind })));
    });
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

  // Lọc theo từ khoá (bỏ dấu). Mục ĐÃ CHỌN hiển thị riêng nên ở danh sách cuộn
  // chỉ cần các mục CHƯA chọn để tránh trùng.
  const q = stripAccents(query.trim());
  const unpicked = known.filter((k) => !value.includes(k.name));
  const filtered = q ? unpicked.filter((k) => stripAccents(k.name).includes(q)) : unpicked;

  return (
    <>
      <div className="auto-scope-bar">
        <button type="button" className={`auto-chip${!value.length ? ' on' : ''}`} onClick={() => onChange([])}>
          Mọi hội thoại
        </button>
        <input
          className="auto-scope-search"
          value={query}
          placeholder={`🔎 Tìm trong ${known.length} hội thoại…`}
          onChange={(e) => setQuery(e.target.value)}
        />
        {value.length > 0 && (
          <button type="button" className="ghost sm" onClick={() => onChange([])} title="Bỏ chọn tất cả">
            đã chọn {value.length} · xoá
          </button>
        )}
      </div>

      {/* Mục ĐÃ CHỌN — luôn hiện để bỏ chọn được kể cả khi search lọc mất. */}
      {value.length > 0 && (
        <div className="auto-checks auto-scope-selected">
          {value.map((n) => {
            const k = known.find((x) => x.name === n);
            return (
              <button key={n} type="button" className="auto-chip on" onClick={() => toggle(n)}>
                {k ? (k.kind === 'group' ? '👥 ' : '👤 ') : ''}{n} ✕
              </button>
            );
          })}
        </div>
      )}

      {/* Danh sách CUỘN — không còn tràn cả màn hình khi có hàng trăm hội thoại. */}
      <div className="auto-scope-list">
        <div className="auto-checks">
          {filtered.map((k) => (
            <button key={k.name} type="button" className="auto-chip" onClick={() => toggle(k.name)}>
              {k.kind === 'group' ? '👥' : '👤'} {k.name}
            </button>
          ))}
        </div>
        {known.length > 0 && filtered.length === 0 && (
          <span className="auto-hint">{q ? `Không có hội thoại khớp “${query}”.` : 'Đã chọn hết các hội thoại trong danh bạ.'}</span>
        )}
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
          Chưa có danh sách nào trong danh bạ — quét ở tab Zalo API (nút ⟲) hoặc tab 🧭 Workspace → 🔎, hoặc gõ tay
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
  watches = [],
  onOpenWatch,
}: {
  rule: AutomationRule;
  onChange: (r: AutomationRule) => void;
  /** Every declared watch — the pool an infra rule picks from, by id. */
  watches?: InfraWatch[];
  /** Nhảy sang tab Theo dõi hạ tầng, mở sẵn watch này. Vắng = ẩn nút "Xem". */
  onOpenWatch?: (id: string) => void;
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
  // Biến khả dụng cho gợi ý {{…}} trong các ô action — theo trigger đang chọn.
  const tplVars = useMemo(() => [...fields, ...TEMPLATE_CORE_VARS], [fields]);
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

      <Section
        title="Phạm vi — NGUỒN nào"
        blurb={
          rule.category === 'infra' ? (
            <>
              Chọn <b>sự kiện từ đâu</b> thì quy tắc này lo. Ba ô lọc dần: Stack → Kết nối → Watch.
              Đây là chỗ bạn dùng cho hầu hết mọi việc — để trống ô nào là “tất cả” ô đó.
            </>
          ) : (
            <>
              Chọn <b>sự kiện từ đâu</b> thì quy tắc này lo: ứng dụng → tài khoản → hội thoại.
              Để trống ô nào là “tất cả” ô đó.
            </>
          )
        }
      >
        <Field
          label={rule.category === 'infra' ? 'Stack' : 'Ứng dụng'}
          tip={
            rule.category === 'infra'
              ? 'Loại hạ tầng. Chọn ở đây sẽ thu hẹp luôn ô Kết nối và ô Watch bên dưới — cách nhanh nhất để tìm watch trong danh sách dài.'
              : 'Ứng dụng nhắn tin. Chọn ở đây sẽ thu hẹp ô Tài khoản bên dưới.'
          }
        >
          <CheckList
            options={sources}
            value={rule.scope.sourceIds}
            onChange={(v) => set({ scope: { ...rule.scope, sourceIds: v } })}
            allLabel="Tất cả"
          />
        </Field>
        <Field
          label={rule.category === 'infra' ? 'Kết nối' : 'Tài khoản'}
          tip={
            rule.category === 'infra'
              ? 'Cụm cụ thể (ES-02, Kafka-01…). Chọn ở đây sẽ thu hẹp ô Watch bên dưới. Để trống = mọi cụm của các Stack đã chọn.'
              : 'Tài khoản cụ thể. Để trống = mọi tài khoản của các ứng dụng đã chọn.'
          }
        >
          <CheckList
            options={instances}
            value={rule.scope.instanceIds}
            onChange={(v) => set({ scope: { ...rule.scope, instanceIds: v } })}
            allLabel="Tất cả"
          />
        </Field>
        {rule.category === 'infra' && (
          <Field
            label="Watch"
            tip="Cách chính xác nhất để chỉ định quy tắc này lo watch nào. Quy tắc lưu theo ID watch, nên đổi tên watch sau này không làm đứt liên kết. Danh sách tự thu hẹp theo Stack/Kết nối đã chọn ở trên; ô tìm kiếm nhận cả tên, id, tag và tên chỉ số. Để trống = mọi watch thoả Stack/Kết nối, kể cả watch bạn thêm về sau."
            hint="quy tắc nhắm theo ID watch — đổi tên watch không làm đứt liên kết. Để trống = mọi watch thoả Stack/Kết nối"
          >
            <WatchScope
              watches={watches}
              value={rule.scope.watchIds ?? []}
              onChange={(v) => set({ scope: { ...rule.scope, watchIds: v } })}
              stacks={rule.scope.sourceIds}
              instances={rule.scope.instanceIds}
              onOpenWatch={onOpenWatch}
            />
          </Field>
        )}
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
        title={`Điều kiện (${rule.match.conditions.length}) — lọc thêm theo NỘI DUNG`}
        defaultOpen={rule.match.conditions.length > 0}
        blurb={
          rule.category === 'infra' ? (
            <>
              <b>Không bắt buộc</b> — Phạm vi ở trên đã đủ cho phần lớn trường hợp. Chỉ thêm ở đây khi
              cần lọc theo <b>giá trị của sự kiện</b>, thứ mà Phạm vi không biết: ví dụ chỉ báo khi{' '}
              <code>value</code> ≥ 95, hoặc chỉ khi <code>severity</code> là <code>critical</code>.
              <br />
              Đừng dùng để chỉ định watch — việc đó thuộc ô <b>Watch</b> ở Phạm vi (theo id, không đứt
              khi đổi tên).
            </>
          ) : (
            <>
              <b>Không bắt buộc.</b> Phạm vi ở trên chọn nguồn; ở đây lọc theo <b>nội dung tin</b> —
              ví dụ <code>text</code> chứa “lỗi”, hoặc <code>sender</code> là một người cụ thể.
            </>
          )
        }
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
        title={`Hành động (${rule.actions.length}) — LÀM GÌ`}
        blurb={
          <>
            Chạy khi sự kiện qua được Phạm vi + Điều kiện. Nhiều hành động chạy{' '}
            <b>lần lượt từ trên xuống</b>. Nội dung dùng được <code>{'{{template}}'}</code> —
            danh sách biến + JSON metadata mẫu ở ngay dưới; <code>{'{{metaJson}}'}</code> là
            cả metadata cho webhook/bot.
          </>
        }
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
        <TplVars vars={tplVars}>
          <VarsPanel trigger={rule.trigger} stacks={rule.category === 'infra' ? rule.scope.sourceIds : undefined} />
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
        </TplVars>
      </Section>

      <Section
        title="Khung giờ & giới hạn — BAO NHIÊU LẦN"
        defaultOpen={false}
        blurb={
          <>
            Chống bão cảnh báo. Watch chỉ lo việc đo — còn vi phạm thì nó phát sự kiện mỗi lần poll,
            nên <b>tần suất thông báo do đây quyết định</b>. Muốn “mỗi giờ 1 lần”: đặt{' '}
            <b>Nghỉ giữa 2 lần = 3600</b> rồi chọn <b>Đếm theo</b> cho đúng phạm vi.
          </>
        }
      >
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
          <Field
            label="Chống trùng (giây)"
            tip="Bỏ qua sự kiện TRÙNG NỘI DUNG (cùng tiêu đề + nội dung) trong N giây. Với cảnh báo hạ tầng thì giá trị đo đổi liên tục (85% rồi 86%…) nên nội dung không bao giờ trùng — ô này hầu như không chặn được gì. Hãy dùng 'Nghỉ giữa 2 lần' + 'Đếm theo'."
            hint="theo nội dung — ít tác dụng với hạ tầng"
          >
            <Num value={rule.limits?.dedupeSec} onChange={(v) => set({ limits: { ...rule.limits, dedupeSec: v } })} />
          </Field>
          <Field
            label="Nghỉ giữa 2 lần (giây)"
            tip="Khoảng cách tối thiểu giữa 2 lần cảnh báo. 3600 = mỗi giờ 1 lần. Phạm vi đếm do ô 'Đếm theo' quyết định."
            hint="3600 = mỗi giờ 1 lần"
          >
            <Num value={rule.limits?.cooldownSec} onChange={(v) => set({ limits: { ...rule.limits, cooldownSec: v } })} />
          </Field>
          <Field
            label="Tối đa mỗi giờ"
            tip="Trần cứng theo giờ trượt — van an toàn cuối cùng khi có sự cố diện rộng. Cũng đếm theo phạm vi của ô 'Đếm theo'."
          >
            <Num value={rule.limits?.maxPerHour} onChange={(v) => set({ limits: { ...rule.limits, maxPerHour: v } })} />
          </Field>
          <Field
            label="Đếm theo"
            tip="Phạm vi đếm của 2 ô trên. 'cả quy tắc' = một bộ đếm chung, watch A hoặc B match thì chỉ 1 cảnh báo — dùng khi quy tắc đại diện MỘT mối lo. 'từng watch' = mỗi watch một bộ đếm riêng, A và B báo độc lập — dùng khi quy tắc bao nhiều thứ, để 40 cụm sập cùng lúc vẫn báo đủ 40 chứ không phải 1. 'từng kết nối' = mọi watch trên cùng một cụm chia nhau một bộ đếm."
            hint="cả quy tắc = A hoặc B → 1 lần · từng watch = A và B riêng"
          >
            <select
              value={rule.limits?.countBy ?? 'rule'}
              onChange={(e) =>
                set({ limits: { ...rule.limits, countBy: e.target.value as RuleLimits['countBy'] } })
              }
            >
              <option value="rule">cả quy tắc</option>
              <option value="watch">từng watch</option>
              <option value="instance">từng kết nối</option>
            </select>
          </Field>
        </div>
      </Section>

      <Field label="Ghi chú" wide>
        <input value={rule.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </div>
  );
}
