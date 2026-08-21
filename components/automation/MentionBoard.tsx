'use client';

// Bảng phân công tag (@) khi gửi Zalo nhóm + danh bạ mention.
//
// Vì sao là MỘT MODAL riêng thay vì nhét vào từng rule: "topic nào của ai" là
// dữ liệu miền, đổi thường xuyên (thêm topic, đổi người trực) trong khi rule
// đổi vài lần một năm — sửa 1 dòng ở đây là mọi rule bật cờ tag tự ăn theo.
// Action zaloApiSend chỉ giữ đúng một checkbox opt-in (xem ActionCard).
//
// MỌI CẤP ĐỀU MULTI: một dòng khớp nhiều topic / nhiều điều kiện, tag nhiều
// người. Ô nhập danh sách là text phân tách phẩy — gõ tự nhiên, chỉ tách khi
// Lưu (tách theo từng phím gõ là con trỏ nhảy loạn).

import { useMemo, useState } from 'react';
import { automation, useAutomation } from '@/lib/automation/useAutomation';
import type {
  AutomationCondition,
  MentionAssignment,
  ZaloMentionPerson,
} from '@/lib/automation/types';

/** Bản nháp một dòng phân công — danh sách để dạng TEXT cho tới khi Lưu. */
interface RowDraft {
  id: string;
  enabled: boolean;
  kind: MentionAssignment['kind'];
  valuesText: string;
  tagText: string;
  note: string;
  conditions: AutomationCondition[];
}

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

const KIND_LABEL: Record<MentionAssignment['kind'], string> = {
  topic: '📦 Topic Kafka',
  infra: '🔧 Sự cố hạ tầng',
  custom: '⚙ Điều kiện tuỳ ý',
};

/** Field gợi ý cho điều kiện tuỳ ý — các field infra hay dùng nhất. */
const FIELD_SUGGEST = ['metric', 'topics', 'groups', 'severity', 'watch', 'stack', 'instance', 'title', 'text', 'type'];
const OP_CHOICES: { v: AutomationCondition['op']; label: string }[] = [
  { v: 'contains', label: 'chứa' },
  { v: 'notContains', label: 'không chứa' },
  { v: 'equals', label: '=' },
  { v: 'anyOf', label: 'một trong (phẩy)' },
  { v: 'regex', label: 'regex' },
  { v: 'notEmpty', label: 'có giá trị' },
  { v: 'gt', label: '>' },
  { v: 'lt', label: '<' },
];

export default function MentionBoard({ onClose }: { onClose: () => void }) {
  const { config } = useAutomation();
  const [people, setPeople] = useState<ZaloMentionPerson[]>(
    () => config.mentionPeople.map((p) => ({ ...p })),
  );
  const [rows, setRows] = useState<RowDraft[]>(() => config.mentionAssignments.map((a) => ({
    id: a.id,
    enabled: a.enabled,
    kind: a.kind,
    valuesText: (a.values ?? []).join(', '),
    tagText: a.tag.join(', '),
    note: a.note ?? '',
    conditions: (a.conditions ?? []).map((c) => ({ ...c })),
  })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const aliases = useMemo(() => people.map((p) => p.alias).filter(Boolean), [people]);

  const patchRow = (i: number, patch: Partial<RowDraft>) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await automation.patch({
        mentionPeople: people
          .map((p) => ({ alias: p.alias.trim(), name: p.name.trim(), uid: p.uid.trim() }))
          .filter((p) => p.alias && p.uid),
        mentionAssignments: rows.map((r, i) => ({
          id: r.id || `mention-${i + 1}`,
          enabled: r.enabled,
          kind: r.kind,
          values: splitList(r.valuesText),
          conditions: r.kind === 'custom' ? r.conditions.filter((c) => c.field.trim()) : [],
          tag: splitList(r.tagText),
          note: r.note.trim(),
        })),
      });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mail-compose panel" style={{ width: 'min(860px, 96vw)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="mail-compose-head">
          <b>🏷 Bảng phân công tag (@) — Zalo nhóm</b>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <p className="small" style={{ color: 'var(--muted)', margin: '2px 0 8px' }}>
          Cảnh báo gửi vào nhóm Zalo (action có bật 🏷) sẽ được nối dòng <code>→ @A @B</code> ping thật.
          Mọi dòng khớp đều <b>cộng dồn</b>: sự kiện dính topic A + B là một tin tag đủ người của cả hai dòng (trần 5 người/tin).
        </p>

        {/* ── Danh bạ: alias → tên + UID Zalo ─────────────────────────────── */}
        <div className="group-title" style={{ margin: '6px 0 4px' }}>Danh bạ mention ({people.length})</div>
        <p className="small" style={{ color: 'var(--faint)', margin: '0 0 6px' }}>
          UID Zalo là chuỗi số của TỪNG người — xem ở tab Zalo API (tin nhắn đến có <code>fromId</code>), đổi người trực chỉ sửa ở đây.
        </p>
        {people.map((p, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <input className="input" style={{ flex: '0 0 130px' }} placeholder="alias (userA)"
              value={p.alias} onChange={(e) => setPeople((cur) => cur.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)))} />
            <input className="input" style={{ flex: 1 }} placeholder="Tên hiển thị (thành chữ @Tên)"
              value={p.name} onChange={(e) => setPeople((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input className="input" style={{ flex: '0 0 180px', fontFamily: 'var(--mono)' }} placeholder="UID Zalo"
              value={p.uid} onChange={(e) => setPeople((cur) => cur.map((x, j) => (j === i ? { ...x, uid: e.target.value } : x)))} />
            <button className="ghost sm" title="Xoá người này"
              onClick={() => setPeople((cur) => cur.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="ghost sm" onClick={() => setPeople((cur) => [...cur, { alias: '', name: '', uid: '' }])}>
          ＋ Thêm người
        </button>

        {/* ── Bảng phân công ──────────────────────────────────────────────── */}
        <div className="group-title" style={{ margin: '14px 0 4px' }}>Phân công ({rows.length} dòng)</div>
        {rows.map((r, i) => (
          <div key={r.id || i} className="panel" style={{ padding: 10, marginBottom: 6, opacity: r.enabled ? 1 : 0.55 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                title="Tắt = dòng nằm đó nhưng không tag ai">
                <input type="checkbox" checked={r.enabled} onChange={(e) => patchRow(i, { enabled: e.target.checked })} />
              </label>
              <select value={r.kind} onChange={(e) => patchRow(i, { kind: e.target.value as MentionAssignment['kind'] })}
                style={{ fontSize: 12 }}>
                {(Object.keys(KIND_LABEL) as MentionAssignment['kind'][]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
              {r.kind !== 'custom' && (
                <input className="input" style={{ flex: '1 1 200px', fontFamily: 'var(--mono)', fontSize: 12 }}
                  placeholder={r.kind === 'topic'
                    ? 'topic, nhiều thì phẩy: orders, payments'
                    : 'metric cụ thể (tuỳ chọn) — trống = mọi sự cố kết nối/đĩa/RAM/CPU'}
                  value={r.valuesText} onChange={(e) => patchRow(i, { valuesText: e.target.value })} />
              )}
              <span aria-hidden style={{ color: 'var(--muted)' }}>→ tag</span>
              <input className="input" style={{ flex: '1 1 160px', fontSize: 12 }} list="mention-aliases"
                placeholder="alias, nhiều thì phẩy: userA, devops"
                value={r.tagText} onChange={(e) => patchRow(i, { tagText: e.target.value })} />
              <button className="ghost sm" title="Xoá dòng"
                onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>✕</button>
            </div>
            {r.kind === 'custom' && (
              <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                {r.conditions.map((c, ci) => (
                  <div key={ci} style={{ display: 'flex', gap: 6 }}>
                    <input className="input" style={{ flex: '0 0 140px', fontFamily: 'var(--mono)', fontSize: 12 }}
                      list="mention-fields" placeholder="field" value={c.field}
                      onChange={(e) => patchRow(i, { conditions: r.conditions.map((x, j) => (j === ci ? { ...x, field: e.target.value } : x)) })} />
                    <select value={c.op} style={{ fontSize: 12 }}
                      onChange={(e) => patchRow(i, { conditions: r.conditions.map((x, j) => (j === ci ? { ...x, op: e.target.value as AutomationCondition['op'] } : x)) })}>
                      {OP_CHOICES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                    </select>
                    <input className="input" style={{ flex: 1, fontSize: 12 }} placeholder="giá trị"
                      value={c.value ?? ''}
                      onChange={(e) => patchRow(i, { conditions: r.conditions.map((x, j) => (j === ci ? { ...x, value: e.target.value } : x)) })} />
                    <button className="ghost sm" onClick={() => patchRow(i, { conditions: r.conditions.filter((_, j) => j !== ci) })}>✕</button>
                  </div>
                ))}
                <div>
                  <button className="ghost sm"
                    onClick={() => patchRow(i, { conditions: [...r.conditions, { field: 'metric', op: 'contains', value: '' }] })}>
                    ＋ Điều kiện (AND)
                  </button>
                </div>
              </div>
            )}
            <input className="input" style={{ marginTop: 6, fontSize: 12 }} placeholder="Ghi chú (hiện trong trace: vì sao tag)"
              value={r.note} onChange={(e) => patchRow(i, { note: e.target.value })} />
          </div>
        ))}
        <button className="ghost sm"
          onClick={() => setRows((cur) => [...cur, {
            id: `mention-${Date.now().toString(36)}`, enabled: true, kind: 'topic',
            valuesText: '', tagText: '', note: '', conditions: [],
          }])}>
          ＋ Thêm dòng phân công
        </button>

        <datalist id="mention-aliases">{aliases.map((a) => <option key={a} value={a} />)}</datalist>
        <datalist id="mention-fields">{FIELD_SUGGEST.map((f) => <option key={f} value={f} />)}</datalist>

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={() => void save()} disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : '💾'} Lưu
          </button>
          <button className="ghost" onClick={onClose}>Hủy</button>
        </div>
      </div>
    </div>
  );
}
