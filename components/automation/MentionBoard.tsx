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

import { useEffect, useMemo, useState } from 'react';
import { automation, useAutomation } from '@/lib/automation/useAutomation';
import { fetchKafkaConnections, listKafkaTopics, type PublicKafkaConnection } from '@/lib/kafka';
import { zaloApiPeople } from '@/lib/zaloapi/api';
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
  /** Chỉ dùng khi values có token ★ tất-cả: topic loại trừ, phẩy phân tách. */
  excludesText: string;
  tagText: string;
  note: string;
  conditions: AutomationCondition[];
}

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/** Dòng có token "tất cả" ('*' / '*:<cụm>') không — quyết định hiện ô loại trừ. */
const hasWildcard = (valuesText: string) =>
  splitList(valuesText).some((v) => v === '*' || v.startsWith('*:'));

/** alias tự sinh từ tên: bỏ dấu tiếng Việt, thường hoá, nối bằng gạch. */
const aliasOf = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'user';

// Cache trong phiên: danh sách cụm + topic theo cụm — mở đi mở lại bảng không
// phải hỏi Kafka lần nữa (listTopics trên cụm lớn không rẻ).
let kafkaConnsCache: PublicKafkaConnection[] | null = null;
const kafkaTopicsCache = new Map<string, string[]>();

/**
 * Bộ chọn topic theo CỤM: chọn cụm → gợi ý đúng topic của cụm đó, bấm topic là
 * thêm vào dòng; đổi sang cụm khác chọn tiếp — nhiều cụm gom vào một dòng.
 * Mục "★ Tất cả topic của cụm này" thêm token `*:<tên cụm>` — người đó nhận MỌI
 * cảnh báo dính topic/consumer của cụm, khỏi check từng topic (xem mention.ts).
 * Nhập tay vẫn còn (ô text bên cạnh) cho topic chưa tồn tại/regex tương lai.
 */
function TopicPicker({ onAdd }: { onAdd: (topic: string) => void }) {
  const [conns, setConns] = useState<PublicKafkaConnection[] | null>(kafkaConnsCache);
  const [connId, setConnId] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (kafkaConnsCache) return;
    fetchKafkaConnections()
      .then((r) => { kafkaConnsCache = r.connections; setConns(r.connections); })
      .catch(() => setConns([]));
  }, []);

  const pickConn = (id: string) => {
    setConnId(id);
    setTopics(id ? kafkaTopicsCache.get(id) ?? [] : []);
    if (!id || kafkaTopicsCache.has(id)) return;
    setLoading(true);
    listKafkaTopics(id)
      .then((list) => {
        const names = list.filter((t) => !t.internal).map((t) => t.name).sort();
        kafkaTopicsCache.set(id, names);
        setTopics(names);
      })
      .catch(() => setTopics([]))
      .finally(() => setLoading(false));
  };

  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <select value={connId} onChange={(e) => pickConn(e.target.value)} style={{ fontSize: 12, maxWidth: 150 }}
        title="Chọn cụm Kafka để gợi ý đúng topic">
        <option value="">— cụm Kafka —</option>
        {(conns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select
        value=""
        disabled={!connId || loading}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          // "Tất cả" → token wildcard theo TÊN cụm (mention.ts hiểu '*:<cụm>'):
          // sự kiện nào của cụm dính topic/consumer là tag, khỏi check từng topic.
          if (v === '__all') {
            const name = (conns ?? []).find((c) => c.id === connId)?.name ?? connId;
            onAdd(`*:${name}`);
          } else onAdd(v);
        }}
        style={{ fontSize: 12, maxWidth: 220 }}
        title="Bấm một topic là thêm vào dòng — chọn tiếp topic khác hoặc đổi cụm. '★ Tất cả' = mọi cảnh báo dính topic/consumer của cụm này, không cần liệt kê từng topic"
      >
        <option value="">{loading ? 'đang tải topic…' : `＋ chọn topic (${topics.length})`}</option>
        {connId && <option value="__all">★ Tất cả topic của cụm này</option>}
        {topics.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </span>
  );
}

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

export default function MentionBoard({ onClose, accountKey }: {
  onClose: () => void;
  /** Tài khoản Zalo API của action đang mở bảng — nguồn gợi ý "người từng nhắn". */
  accountKey?: string;
}) {
  const { config } = useAutomation();
  // Người từng xuất hiện trong tin nhắn của tài khoản gửi — gợi ý uid, khỏi
  // phải đi mò fromId bằng tay. null = đang tải/không có tài khoản.
  const [zaloPeople, setZaloPeople] = useState<{ uid: string; name: string }[] | null>(null);
  useEffect(() => {
    if (!accountKey) { setZaloPeople([]); return; }
    zaloApiPeople(accountKey).then(setZaloPeople).catch(() => setZaloPeople([]));
  }, [accountKey]);
  const [people, setPeople] = useState<ZaloMentionPerson[]>(
    () => config.mentionPeople.map((p) => ({ ...p })),
  );
  const [rows, setRows] = useState<RowDraft[]>(() => config.mentionAssignments.map((a) => ({
    id: a.id,
    enabled: a.enabled,
    kind: a.kind,
    valuesText: (a.values ?? []).join(', '),
    excludesText: (a.excludes ?? []).join(', '),
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
          // Loại trừ chỉ có nghĩa khi có token ★ — không có thì lưu rỗng để
          // config không mang theo danh sách chết gây hiểu lầm.
          excludes: r.kind === 'topic' && hasWildcard(r.valuesText) ? splitList(r.excludesText) : [],
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
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="ghost sm" onClick={() => setPeople((cur) => [...cur, { alias: '', name: '', uid: '' }])}>
            ＋ Thêm người (nhập tay)
          </button>
          {/* Gợi ý từ chính tài khoản Zalo dùng để gửi: chọn là điền sẵn cả
              tên + uid, alias tự sinh từ tên. Người không có trong nhóm đích
              thì lúc gửi Zalo tự bỏ qua mention — không cần lo chọn dư. */}
          <select
            value=""
            onChange={(e) => {
              const uid = e.target.value;
              const p = (zaloPeople ?? []).find((x) => x.uid === uid);
              if (!p) return;
              setPeople((cur) => (cur.some((x) => x.uid === p.uid)
                ? cur
                : [...cur, { alias: aliasOf(p.name), name: p.name, uid: p.uid }]));
            }}
            style={{ fontSize: 12, maxWidth: 280 }}
            disabled={!zaloPeople?.length}
            title={accountKey
              ? 'Người từng nhắn tới tài khoản Zalo đang dùng để gửi — chọn là có sẵn uid'
              : 'Mở từ action Gửi Zalo API để có gợi ý theo tài khoản'}
          >
            <option value="">
              {zaloPeople === null
                ? '＋ từ Zalo… (đang tải)'
                : zaloPeople.length
                  ? `＋ từ Zalo (${zaloPeople.length} người từng nhắn)`
                  : '＋ từ Zalo (chưa có ai nhắn tới)'}
            </option>
            {(zaloPeople ?? []).map((p) => (
              <option key={p.uid} value={p.uid}>{p.name} · {p.uid}</option>
            ))}
          </select>
        </div>

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
              {r.kind === 'topic' && (
                // Chọn cụm → chọn topic là THÊM vào dòng (chọn tiếp topic khác,
                // hoặc đổi cụm rồi chọn tiếp — nhiều cụm gom một dòng). Ô text
                // vẫn sửa/xoá tay được, phẩy phân tách.
                <TopicPicker onAdd={(t) => {
                  const list = splitList(rows[i].valuesText);
                  if (!list.includes(t)) patchRow(i, { valuesText: [...list, t].join(', ') });
                }} />
              )}
              {r.kind !== 'custom' && (
                <input className="input" style={{ flex: '1 1 200px', fontFamily: 'var(--mono)', fontSize: 12 }}
                  placeholder={r.kind === 'topic'
                    ? 'topic đã chọn hiện ở đây — sửa/xoá tay được, phẩy phân tách'
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
            {/* Ô loại trừ chỉ hiện khi dòng có token ★ tất-cả — với topic liệt
                kê tường minh thì "loại trừ" vô nghĩa (đừng liệt kê là xong). */}
            {r.kind === 'topic' && hasWildcard(r.valuesText) && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                <span className="small" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>🚫 trừ topic</span>
                <input className="input" style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 12 }}
                  placeholder="sự kiện nhắc tới topic này thì ★ không tag — phẩy phân tách: log-spam, test-events"
                  value={r.excludesText} onChange={(e) => patchRow(i, { excludesText: e.target.value })} />
              </div>
            )}
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
            valuesText: '', excludesText: '', tagText: '', note: '', conditions: [],
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
