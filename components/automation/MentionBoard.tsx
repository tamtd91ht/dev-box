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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { automation, useAutomation } from '@/lib/automation/useAutomation';
import { fetchKafkaConnections, listKafkaTopics, type PublicKafkaConnection } from '@/lib/kafka';
import { zaloApiPeople } from '@/lib/zaloapi/api';
import { MAX_MENTIONS } from '@/lib/automation/mention';
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
  /** Khung giờ được phép tag (quyền riêng tư người trực) — tắt = tag 24/7. */
  winOn: boolean;
  winFrom: string;
  winTo: string;
  /** 0=CN … 6=T7. Rỗng = mọi ngày. */
  winDays: number[];
}

/** Nhãn ngày cho nút bật/tắt — index khớp RuleWindow.days (0=CN). */
const DAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/** Số người dòng này đang tag — hiện ngay cạnh nhãn để nhìn là biết. */
const tagCount = (r: { tagText: string }) => splitList(r.tagText).length;

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
function TopicPicker({ onAdd, allowAll = true, lockClusters }: {
  onAdd: (topic: string) => void;
  /** false = bỏ mục "★ Tất cả" (ô LOẠI TRỪ dùng — loại trừ tất cả là vô nghĩa). */
  allowAll?: boolean;
  /**
   * Giới hạn vào đúng các cụm này (tên hoặc id) — ô LOẠI TRỪ dùng: token
   * '*:<cụm>' phía trên đã chốt cụm rồi, bắt chọn lại là vừa thừa vừa dễ chọn
   * nhầm cụm khác. Đúng một cụm → tự chọn luôn, ẩn hẳn dropdown cụm.
   */
  lockClusters?: string[];
}) {
  const [conns, setConns] = useState<PublicKafkaConnection[] | null>(kafkaConnsCache);
  const [connId, setConnId] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  /** Tìm nhanh trong danh sách topic — cụm thật có hàng trăm topic. */
  const [q, setQ] = useState('');

  useEffect(() => {
    if (kafkaConnsCache) return;
    fetchKafkaConnections()
      .then((r) => { kafkaConnsCache = r.connections; setConns(r.connections); })
      .catch(() => setConns([]));
  }, []);

  // Danh sách cụm được phép chọn (khoá theo lockClusters nếu có).
  const lockKey = (lockClusters ?? []).join('|').toLowerCase();
  const usable = useMemo(() => {
    const all = conns ?? [];
    if (!lockKey) return all;
    const want = lockKey.split('|').map((s) => s.trim()).filter(Boolean);
    return all.filter((c) => want.includes(c.name.toLowerCase()) || want.includes(c.id.toLowerCase()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns, lockKey]);

  const pickConn = (id: string) => {
    setConnId(id);
    setQ('');
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

  // Khoá về đúng MỘT cụm → tự chọn, người dùng khỏi bấm thêm một lần vô nghĩa.
  useEffect(() => {
    if (usable.length === 1 && connId !== usable[0].id) pickConn(usable[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable]);

  const shown = q.trim()
    ? topics.filter((t) => t.toLowerCase().includes(q.trim().toLowerCase()))
    : topics;
  const lockedToOne = !!lockKey && usable.length === 1;

  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      {lockedToOne ? (
        <span className="badge" title="Cụm lấy theo token ★ phía trên — loại trừ luôn chung cụm với nó">
          {usable[0].name}
        </span>
      ) : (
        <select value={connId} onChange={(e) => pickConn(e.target.value)} style={{ fontSize: 12, maxWidth: 150 }}
          title="Chọn cụm Kafka để gợi ý đúng topic">
          <option value="">— cụm Kafka —</option>
          {usable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      <input
        className="input"
        style={{ width: 110, fontSize: 12, padding: '3px 6px' }}
        placeholder="🔎 lọc topic…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={!connId || loading}
        title="Gõ để lọc danh sách topic bên cạnh — cụm thật có hàng trăm topic"
      />
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
        <option value="">
          {loading ? 'đang tải topic…' : `＋ chọn topic (${q.trim() ? `${shown.length}/${topics.length}` : topics.length})`}
        </option>
        {connId && allowAll && !q.trim() && <option value="__all">★ Tất cả topic của cụm này</option>}
        {shown.map((t) => <option key={t} value={t}>{t}</option>)}
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

/**
 * Chọn NGƯỜI ĐỂ TAG cho một dòng — checkbox chip, không phải ô gõ tay.
 *
 * Vì sao đổi khỏi ô text phẩy-phân-tách: alias là tiếng Việt có dấu ("Thức"),
 * gõ tay thì sai một dấu là dòng đó IM LẶNG không tag ai — lỗi chỉ lộ ra ở
 * dòng "⚠ alias chưa có trong danh bạ" trong trace, lúc sự cố đã trôi qua.
 * Bấm chọn từ danh bạ thì alias luôn đúng, và nhìn là biết dòng đang tag mấy
 * người — đó mới là chỗ khiến người ta thực sự tag nhiều người.
 *
 * Alias lạ (danh bạ vừa xoá, hoặc config sửa tay) vẫn hiện thành chip ⚠ để
 * người dùng thấy mà bỏ, thay vì bị nuốt mất khi lưu lại.
 */
function TagPicker({ selected, people, onChange }: {
  selected: string[];
  people: ZaloMentionPerson[];
  onChange: (next: string[]) => void;
}) {
  const known = people.filter((p) => p.alias.trim());
  const lower = new Set(known.map((p) => p.alias.trim().toLowerCase()));
  const unknown = selected.filter((a) => !lower.has(a.trim().toLowerCase()));
  const has = (alias: string) => selected.some((a) => a.trim().toLowerCase() === alias.trim().toLowerCase());
  const toggle = (alias: string) => {
    onChange(has(alias)
      ? selected.filter((a) => a.trim().toLowerCase() !== alias.trim().toLowerCase())
      : [...selected, alias]);
  };

  if (known.length === 0 && unknown.length === 0) {
    return <span className="small" style={{ color: 'var(--faint)' }}>— chưa có ai trong danh bạ —</span>;
  }
  return (
    <div className="mention-tagpick">
      {known.map((p) => (
        <button
          key={p.alias}
          type="button"
          className={`mention-tagchip${has(p.alias) ? ' on' : ''}`}
          title={p.uid.trim() ? `${p.name || p.alias} · uid ${p.uid}` : '⚠ người này chưa có UID — tag sẽ không ping được'}
          onClick={() => toggle(p.alias)}
        >
          {has(p.alias) ? '☑' : '☐'} {p.name.trim() || p.alias}
          {!p.uid.trim() && ' ⚠'}
        </button>
      ))}
      {unknown.map((a) => (
        <button
          key={`x-${a}`}
          type="button"
          className="mention-tagchip on unknown"
          title="Alias không có trong danh bạ — bấm để bỏ khỏi dòng này"
          onClick={() => toggle(a)}
        >⚠ {a} ✕</button>
      ))}
    </div>
  );
}

export default function MentionBoard({ onClose, accountKey }: {
  onClose: () => void;
  /** Tài khoản Zalo API của action đang mở bảng — nguồn gợi ý "người từng nhắn". */
  accountKey?: string;
}) {
  const { config } = useAutomation();
  // Người từng xuất hiện trong tin nhắn của tài khoản gửi — gợi ý uid, khỏi
  // phải đi mò fromId bằng tay. null = đang tải/không có tài khoản.
  const [zaloPeople, setZaloPeople] = useState<{ uid: string; name: string }[] | null>(null);
  const reloadZaloPeople = useCallback(() => {
    if (!accountKey) { setZaloPeople([]); return; }
    setZaloPeople(null);
    zaloApiPeople(accountKey).then(setZaloPeople).catch(() => setZaloPeople([]));
  }, [accountKey]);
  useEffect(reloadZaloPeople, [reloadZaloPeople]);
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
    winOn: !!a.window && !!(a.window.from || a.window.to || a.window.days.length),
    winFrom: a.window?.from ?? '08:00',
    winTo: a.window?.to ?? '18:00',
    winDays: [...(a.window?.days ?? [])],
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
          window: r.winOn ? { days: r.winDays, from: r.winFrom, to: r.winTo } : undefined,
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
          Mỗi dòng <b>tag được nhiều người</b> — bấm chọn trong danh bạ, không phải gõ alias.
          Mọi dòng khớp đều <b>cộng dồn</b>: sự kiện dính topic A + B là một tin tag đủ người của cả hai dòng
          (trần {MAX_MENTIONS} người/tin, quá số đó thì trace ghi rõ ai bị bỏ).
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
          {/* Người mới nhắn tới SAU khi mở bảng thì danh sách chưa có — nạp
              lại tại chỗ, khỏi phải đóng mở modal. */}
          <button className="ghost sm" onClick={reloadZaloPeople} disabled={!accountKey || zaloPeople === null}
            title="Nạp lại danh sách người từng nhắn (vd vừa có người mới nhắn tới)">↻</button>
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
              <button className="ghost sm" title="Xoá dòng" style={{ marginLeft: 'auto' }}
                onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>✕</button>
            </div>

            {/* Người được tag: CHỌN NHIỀU từ danh bạ. Xuống dòng riêng vì đây
                là thứ hay phải sửa nhất và cần đủ chỗ cho nhiều chip. */}
            <div className="mention-tagrow">
              <span className="small" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                → tag{tagCount(r) > 0 ? ` (${tagCount(r)})` : ''}
              </span>
              <TagPicker
                selected={splitList(r.tagText)}
                people={people}
                onChange={(next) => patchRow(i, { tagText: next.join(', ') })}
              />
              {tagCount(r) === 0 && (
                <span className="small" style={{ color: 'var(--warn)' }}>
                  chưa chọn ai — dòng này sẽ không tag
                </span>
              )}
            </div>
            {/* Ô loại trừ chỉ hiện khi dòng có token ★ tất-cả — với topic liệt
                kê tường minh thì "loại trừ" vô nghĩa (đừng liệt kê là xong). */}
            {r.kind === 'topic' && hasWildcard(r.valuesText) && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                <span className="small" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>🚫 trừ topic</span>
                {/* Cùng bộ gợi ý cụm→topic như ô chọn phía trên — không có mục
                    ★ (loại trừ "tất cả" là vô nghĩa), và CHUNG CỤM với token
                    ★ phía trên: '*:<cụm>' đã chốt cụm rồi, một cụm thì tự
                    chọn luôn khỏi hỏi lại. */}
                <TopicPicker
                  allowAll={false}
                  lockClusters={(() => {
                    const named = splitList(r.valuesText)
                      .filter((v) => v.startsWith('*:'))
                      .map((v) => v.slice(2).trim())
                      .filter(Boolean);
                    // '*' trần (mọi cụm) → không khoá, cho chọn tự do.
                    return named.length ? named : undefined;
                  })()}
                  onAdd={(t) => {
                    const list = splitList(rows[i].excludesText);
                    if (!list.includes(t)) patchRow(i, { excludesText: [...list, t].join(', ') });
                  }} />
                <input className="input" style={{ flex: '1 1 200px', fontFamily: 'var(--mono)', fontSize: 12 }}
                  placeholder="sự kiện nhắc tới topic này thì ★ không tag — phẩy phân tách: log-spam, test-events"
                  value={r.excludesText} onChange={(e) => patchRow(i, { excludesText: e.target.value })} />
              </div>
            )}
            {/* Khung giờ được phép tag — quyền riêng tư người trực: ngoài khung
                dòng này KHÔNG ping ai, cảnh báo vẫn gửi vào nhóm bình thường.
                Sự cố thật sự gấp thì đừng đặt khung giờ (tag 24/7). */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
              <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', whiteSpace: 'nowrap' }}
                title="Ngoài khung giờ: cảnh báo vẫn gửi, chỉ thôi ping người — trace ghi rõ vì sao không tag">
                <input type="checkbox" checked={r.winOn} onChange={(e) => patchRow(i, { winOn: e.target.checked })} />
                ⏰ chỉ tag trong khung giờ
              </label>
              {r.winOn && (
                <>
                  <input type="time" className="input" style={{ width: 96, fontSize: 12, padding: '3px 6px' }}
                    value={r.winFrom} onChange={(e) => patchRow(i, { winFrom: e.target.value })} />
                  <span className="small" style={{ color: 'var(--muted)' }}>→</span>
                  <input type="time" className="input" style={{ width: 96, fontSize: 12, padding: '3px 6px' }}
                    value={r.winTo} onChange={(e) => patchRow(i, { winTo: e.target.value })} />
                  {DAY_LABELS.map((d, di) => (
                    <button key={d} type="button"
                      className={r.winDays.includes(di) ? 'sm' : 'ghost sm'}
                      style={{ padding: '2px 7px', fontSize: 11 }}
                      title="Ngày được tag — không chọn ngày nào = mọi ngày"
                      onClick={() => patchRow(i, {
                        winDays: r.winDays.includes(di)
                          ? r.winDays.filter((x) => x !== di)
                          : [...r.winDays, di].sort(),
                      })}>
                      {d}
                    </button>
                  ))}
                  <span className="small" style={{ color: 'var(--faint)' }}>
                    không chọn ngày = mọi ngày · giờ đầu &gt; giờ cuối = vắt qua đêm
                  </span>
                </>
              )}
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
            valuesText: '', excludesText: '', tagText: '', note: '', conditions: [],
            winOn: false, winFrom: '08:00', winTo: '18:00', winDays: [],
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
