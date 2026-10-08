'use client';

// Tab con NHIỆM VỤ TRỌNG TÂM (trong tab Công việc): danh sách việc QUAN TRỌNG phải
// xong trong một kỳ — chia hai tab con TUẦN và THÁNG.
//
//   · Mỗi nhiệm vụ có deadline (mặc định cuối kỳ), ưu tiên, dự án, tag, ghi chú và
//     checklist việc con. Quá deadline mà chưa xong thì tô đỏ.
//   · Hai cách xem: KANBAN (4 cột theo trạng thái, kéo thả thẻ để đổi trạng thái) và
//     BẢNG (sắp xếp theo cột, đổi trạng thái ngay trên dòng). Lọc chung cho cả hai:
//     từ khoá (không dấu), tag (nhiều tag = phải có đủ), dự án.
//   · Việc chưa xong có thể "chuyển sang kỳ sau" (deadline dời theo, đếm số lần dời).
//
// Lưu: Mongo nếu tab Công việc đã cấu hình cụm Mongo, không thì file local — server
// tự chọn (lib/workFocus). Nhãn kho + nút cấu hình/đưa dữ liệu local lên Mongo ở
// thanh trên cùng.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FOCUS_STATUSES, dstr, keyOf, shiftKey, periodLabel, periodEnd, parseDate,
  type FocusItem, type FocusPeriod, type FocusPriority, type FocusStatus,
} from '@/lib/workFocusCore';
import FocusModal, { STATUS_META, PRIORITY_META, blankDraft, draftOf, type FocusDraft } from './FocusModal';

interface Storage { mode: 'mongo' | 'local'; label: string }
interface ListResult { items: FocusItem[]; storage: Storage; localPending: number }
type View = 'kanban' | 'table';
type SortCol = 'title' | 'priority' | 'status' | 'deadline';

const VIEW_KEY = 'devbox.work.focus.view';
const PERIOD_KEY = 'devbox.work.focus.period';

/** Bỏ dấu tiếng Việt + lowercase — tìm không phân biệt hoa/thường/dấu. */
function stripVN(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

const PRI_RANK: Record<FocusPriority, number> = { urgent: 0, high: 1, normal: 2 };
const ST_RANK: Record<FocusStatus, number> = { doing: 0, todo: 1, done: 2, dropped: 3 };
const OPEN: FocusStatus[] = ['todo', 'doing'];

const daysBetween = (a: string, b: string): number => {
  const da = parseDate(a); const db = parseDate(b);
  return da && db ? Math.round((db.getTime() - da.getTime()) / 86400000) : 0;
};

/** Chữ + màu cho deadline so với hôm nay. Việc đã xong/bỏ thì không báo gấp. */
function deadlineInfo(it: FocusItem, today: string): { text: string; cls: string } | null {
  if (!it.deadline) return null;
  const dd = `${it.deadline.slice(8, 10)}/${it.deadline.slice(5, 7)}`;
  if (!OPEN.includes(it.status)) return { text: dd, cls: '' };
  const left = daysBetween(today, it.deadline);
  if (left < 0) return { text: `${dd} · quá ${-left} ngày`, cls: 'fc-over' };
  if (left === 0) return { text: `${dd} · hôm nay`, cls: 'fc-soon' };
  if (left <= 2) return { text: `${dd} · còn ${left} ngày`, cls: 'fc-soon' };
  return { text: dd, cls: '' };
}

function sortCards(a: FocusItem, b: FocusItem): number {
  return PRI_RANK[a.priority] - PRI_RANK[b.priority]
    || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999')
    || a.createdAt - b.createdAt;
}

export default function FocusPanel({ action, onConfigureMongo }: {
  action: <T>(name: string, params?: Record<string, unknown>) => Promise<T>;
  /** Mở màn cấu hình cụm Mongo của tab Công việc. */
  onConfigureMongo: () => void;
}) {
  const [items, setItems] = useState<FocusItem[]>([]);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [localPending, setLocalPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const today = dstr(new Date());
  const [period, setPeriod] = useState<FocusPeriod>('week');
  const [keys, setKeys] = useState<Record<FocusPeriod, string>>(() => ({
    week: keyOf('week', dstr(new Date())), month: keyOf('month', dstr(new Date())),
  }));
  const [view, setView] = useState<View>('kanban');
  const key = keys[period];

  const [kw, setKw] = useState('');
  const [tagSel, setTagSel] = useState<string[]>([]);
  const [projSel, setProjSel] = useState('');
  const [showDropped, setShowDropped] = useState(false);
  const [statusSel, setStatusSel] = useState<FocusStatus[]>([]);
  const [sort, setSort] = useState<{ col: SortCol; dir: 1 | -1 }>({ col: 'deadline', dir: 1 });

  const [quick, setQuick] = useState('');
  const [modal, setModal] = useState<{ item: FocusItem | null } | null>(null);
  const [modalErr, setModalErr] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<FocusStatus | null>(null);

  // Nhớ cách xem + kỳ đang xem — đọc SAU mount (đọc lúc render là hydration mismatch).
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'kanban' || v === 'table') setView(v);
      const p = localStorage.getItem(PERIOD_KEY);
      if (p === 'week' || p === 'month') setPeriod(p);
    } catch { /* bỏ qua */ }
  }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* bỏ qua */ } };
  const pickPeriod = (p: FocusPeriod) => { setPeriod(p); try { localStorage.setItem(PERIOD_KEY, p); } catch { /* bỏ qua */ } };

  const load = useCallback(async () => {
    try {
      const r = await action<ListResult>('focus-list');
      setItems(r.items);
      setStorage(r.storage);
      setLocalPending(r.localPending);
      setErr(null);
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }, [action]);
  useEffect(() => { void load(); }, [load]);

  const replace = (it: FocusItem) => setItems((xs) => xs.map((x) => (x.id === it.id ? it : x)));

  /** Gửi patch; thành công thì thay bản mới vào danh sách. Lỗi thì ném cho nơi gọi xử lý. */
  const patch = async (id: string, body: Record<string, unknown>): Promise<FocusItem> => {
    const r = await action<{ item: FocusItem }>('focus-update', { id, ...body });
    replace(r.item);
    return r.item;
  };

  // ── Dữ liệu của kỳ đang xem ────────────────────────────────────────────────
  const inPeriod = useMemo(() => items.filter((i) => i.period === period && i.periodKey === key), [items, period, key]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of inPeriod) for (const t of i.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [inPeriod]);
  /** Mọi tag/dự án trong kho — gợi ý khi gõ trong hộp sửa. */
  const allTags = useMemo(() => [...new Set(items.flatMap((i) => i.tags))].sort(), [items]);
  const projects = useMemo(() => [...new Set(items.map((i) => i.project).filter(Boolean))].sort(), [items]);
  const periodProjects = useMemo(() => [...new Set(inPeriod.map((i) => i.project).filter(Boolean))].sort(), [inPeriod]);

  const filtered = useMemo(() => {
    const q = stripVN(kw.trim());
    return inPeriod.filter((i) => {
      if (tagSel.length && !tagSel.every((t) => i.tags.includes(t))) return false;
      if (projSel && i.project !== projSel) return false;
      if (!q) return true;
      return stripVN(`${i.title} ${i.note} ${i.project} ${i.tags.join(' ')} ${i.subtasks.map((s) => s.text).join(' ')}`).includes(q);
    });
  }, [inPeriod, kw, tagSel, projSel]);

  const stats = useMemo(() => {
    const live = inPeriod.filter((i) => i.status !== 'dropped');
    const done = live.filter((i) => i.status === 'done').length;
    const over = live.filter((i) => OPEN.includes(i.status) && i.deadline && i.deadline < today).length;
    return { total: live.length, done, over, pct: live.length ? Math.round((done / live.length) * 100) : 0 };
  }, [inPeriod, today]);

  const cols = FOCUS_STATUSES.filter((s) => s !== 'dropped' || showDropped);
  const nextLabel = period === 'week' ? 'tuần sau' : 'tháng sau';
  const isCurrent = key === keyOf(period, today);

  // ── Thao tác ──────────────────────────────────────────────────────────────
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); await load(); } finally { setBusy(false); }
  };

  const quickAdd = () => {
    const title = quick.trim();
    if (!title) return;
    void run(async () => {
      const r = await action<{ item: FocusItem }>('focus-add', {
        period, periodKey: key, title,
        // Đang lọc theo tag/dự án thì việc thêm nhanh mang theo — khỏi thêm xong lại biến mất khỏi danh sách.
        tags: tagSel, project: projSel,
      });
      setItems((xs) => [...xs, r.item]);
      setQuick('');
    });
  };

  const setStatus = (it: FocusItem, status: FocusStatus) => {
    if (it.status === status) return;
    replace({ ...it, status }); // lạc quan: kéo thả phải mượt, lỗi thì load lại ở run()
    void run(async () => { await patch(it.id, { status }); });
  };

  const carry = (it: FocusItem) => {
    void run(async () => {
      await patch(it.id, { periodKey: shiftKey(it.period, it.periodKey, 1) });
      setModal(null);
      setNote(`Đã chuyển “${it.title}” sang ${it.period === 'week' ? 'tuần' : 'tháng'} sau.`);
    });
  };

  const remove = (it: FocusItem) => {
    if (!window.confirm(`Xóa nhiệm vụ "${it.title}"?`)) return;
    void run(async () => {
      await action('focus-remove', { id: it.id });
      setItems((xs) => xs.filter((x) => x.id !== it.id));
      setModal(null);
    });
  };

  const saveModal = async (d: FocusDraft) => {
    setBusy(true); setModalErr(null);
    try {
      if (modal?.item) await patch(modal.item.id, { ...d });
      else {
        const r = await action<{ item: FocusItem }>('focus-add', { period, periodKey: key, ...d });
        setItems((xs) => [...xs, r.item]);
      }
      setModal(null);
    } catch (e) { setModalErr((e as Error).message); } finally { setBusy(false); }
  };

  const importLocal = () => {
    if (!window.confirm(`Đưa ${localPending} nhiệm vụ đang lưu trên máy này lên Mongo?\nSau khi đưa xong, bản trong file local sẽ được xóa.`)) return;
    void run(async () => {
      const r = await action<{ imported: number }>('focus-import-local');
      setNote(`Đã đưa ${r.imported} nhiệm vụ lên Mongo.`);
      await load();
    });
  };

  const toggleTag = (t: string) => setTagSel((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
  const filtering = !!kw.trim() || tagSel.length > 0 || !!projSel;

  // ── Hiển thị ──────────────────────────────────────────────────────────────
  const renderMeta = (it: FocusItem) => {
    const dl = deadlineInfo(it, today);
    const subDone = it.subtasks.filter((s) => s.done).length;
    return (
      <>
        {dl && <span className={`fc-dl ${dl.cls}`} title={`Deadline ${it.deadline}`}>⏰ {dl.text}</span>}
        {it.project && <span className="fc-proj">{it.project}</span>}
        {it.subtasks.length > 0 && <span className="fc-subcount" title="Việc con đã xong">☑ {subDone}/{it.subtasks.length}</span>}
        {it.carried > 0 && <span className="fc-carried" title={`Đã dời sang kỳ sau ${it.carried} lần`}>↪ {it.carried}</span>}
        {it.tags.map((t) => (
          <button key={t} className={`fc-tag sm${tagSel.includes(t) ? ' on' : ''}`} title="Bấm để lọc theo tag này"
            onClick={(e) => { e.stopPropagation(); toggleTag(t); }}>#{t}</button>
        ))}
      </>
    );
  };

  const card = (it: FocusItem) => (
    <div
      key={it.id}
      className={`fc-card st-${it.status} ${PRIORITY_META[it.priority].cls}${dragId === it.id ? ' dragging' : ''}`}
      draggable
      onDragStart={(e) => { setDragId(it.id); e.dataTransfer.setData('text/plain', it.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={() => { setDragId(null); setDragOver(null); }}
      onClick={() => { setModalErr(null); setModal({ item: it }); }}
      title="Bấm để sửa · kéo sang cột khác để đổi trạng thái"
    >
      <div className="fc-card-top">
        <input type="checkbox" checked={it.status === 'done'} title={it.status === 'done' ? 'Mở lại' : 'Đánh dấu hoàn thành'}
          onClick={(e) => e.stopPropagation()}
          onChange={() => setStatus(it, it.status === 'done' ? 'todo' : 'done')} />
        <b className="fc-card-title">{it.title}</b>
        {it.priority !== 'normal' && <span className={`fc-pri ${PRIORITY_META[it.priority].cls}`}>{PRIORITY_META[it.priority].label}</span>}
      </div>
      <div className="fc-card-meta">{renderMeta(it)}</div>
      {it.subtasks.length > 0 && (
        <div className="fc-bar sm" aria-hidden><i style={{ width: `${(it.subtasks.filter((s) => s.done).length / it.subtasks.length) * 100}%` }} /></div>
      )}
    </div>
  );

  const kanban = (
    <div className="fc-board" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))` }}>
      {cols.map((st) => {
        const list = filtered.filter((i) => i.status === st).sort(sortCards);
        return (
          <section
            key={st}
            className={`fc-col st-${st}${dragOver === st ? ' over' : ''}`}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); setDragOver(st); } }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(null); }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain') || dragId;
              const it = items.find((x) => x.id === id);
              setDragId(null); setDragOver(null);
              if (it) setStatus(it, st);
            }}
          >
            <header className="fc-col-head">
              <span>{STATUS_META[st].icon} {STATUS_META[st].label}</span>
              <span className="badge">{list.length}</span>
            </header>
            <div className="fc-col-body">
              {list.map(card)}
              {list.length === 0 && <p className="fc-empty">{dragId ? 'Thả vào đây' : 'Trống'}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );

  const tableRows = useMemo(() => {
    const base = filtered.filter((i) => (statusSel.length ? statusSel.includes(i.status) : true));
    const cmp: Record<SortCol, (a: FocusItem, b: FocusItem) => number> = {
      title: (a, b) => a.title.localeCompare(b.title, 'vi'),
      priority: (a, b) => PRI_RANK[a.priority] - PRI_RANK[b.priority],
      status: (a, b) => ST_RANK[a.status] - ST_RANK[b.status],
      deadline: (a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'),
    };
    return [...base].sort((a, b) => cmp[sort.col](a, b) * sort.dir || sortCards(a, b));
  }, [filtered, statusSel, sort]);

  const th = (col: SortCol, label: string) => (
    <th>
      <button className="fc-th" onClick={() => setSort((s) => (s.col === col ? { col, dir: (s.dir * -1) as 1 | -1 } : { col, dir: 1 }))}>
        {label}{sort.col === col ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );

  const table = (
    <div className="fc-table-wrap">
      <div className="fc-chips" style={{ marginBottom: 6 }}>
        {FOCUS_STATUSES.map((s) => (
          <button key={s} className={`chip-btn${statusSel.includes(s) ? ' on' : ''}`}
            onClick={() => setStatusSel((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]))}>
            {STATUS_META[s].icon} {STATUS_META[s].label} ({filtered.filter((i) => i.status === s).length})
          </button>
        ))}
      </div>
      <table className="fc-table">
        <thead>
          <tr>
            <th style={{ width: 28 }} />
            {th('title', 'Nhiệm vụ')}
            {th('priority', 'Ưu tiên')}
            {th('status', 'Trạng thái')}
            {th('deadline', 'Deadline')}
            <th>Dự án · Tags</th>
            <th style={{ width: 96 }} />
          </tr>
        </thead>
        <tbody>
          {tableRows.map((it) => {
            const dl = deadlineInfo(it, today);
            const subDone = it.subtasks.filter((s) => s.done).length;
            return (
              <tr key={it.id} className={`st-${it.status}`}>
                <td><input type="checkbox" checked={it.status === 'done'} onChange={() => setStatus(it, it.status === 'done' ? 'todo' : 'done')} /></td>
                <td>
                  <button className="fc-link" onClick={() => { setModalErr(null); setModal({ item: it }); }}>{it.title}</button>
                  {it.subtasks.length > 0 && <span className="fc-subcount"> ☑ {subDone}/{it.subtasks.length}</span>}
                  {it.carried > 0 && <span className="fc-carried" title={`Đã dời ${it.carried} lần`}> ↪ {it.carried}</span>}
                </td>
                <td><span className={`fc-pri ${PRIORITY_META[it.priority].cls}`}>{PRIORITY_META[it.priority].label}</span></td>
                <td>
                  <select className="input sm" value={it.status} onChange={(e) => setStatus(it, e.target.value as FocusStatus)}>
                    {FOCUS_STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].icon} {STATUS_META[s].label}</option>)}
                  </select>
                </td>
                <td>{dl ? <span className={`fc-dl ${dl.cls}`}>{dl.text}</span> : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                <td>
                  {it.project && <span className="fc-proj">{it.project}</span>}
                  {it.tags.map((t) => (
                    <button key={t} className={`fc-tag sm${tagSel.includes(t) ? ' on' : ''}`} onClick={() => toggleTag(t)}>#{t}</button>
                  ))}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="ghost sm" title="Sửa" onClick={() => { setModalErr(null); setModal({ item: it }); }}>✎</button>
                  {OPEN.includes(it.status) && <button className="ghost sm" title={`Chuyển sang ${nextLabel}`} onClick={() => carry(it)}>↪</button>}
                  <button className="ghost sm" title="Xóa" onClick={() => remove(it)}>🗑</button>
                </td>
              </tr>
            );
          })}
          {tableRows.length === 0 && <tr><td colSpan={7} className="fc-empty">Không có nhiệm vụ nào.</td></tr>}
        </tbody>
      </table>
    </div>
  );

  if (loading) return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;

  return (
    <div className="fc">
      {/* ── Hàng 1: kỳ + điều hướng + kho lưu ── */}
      <div className="fc-bar-top">
        <div className="wk-subtabs" role="tablist" aria-label="Kỳ">
          <button role="tab" aria-selected={period === 'week'} className={`wk-subtab${period === 'week' ? ' on' : ''}`} onClick={() => pickPeriod('week')}>Tuần</button>
          <button role="tab" aria-selected={period === 'month'} className={`wk-subtab${period === 'month' ? ' on' : ''}`} onClick={() => pickPeriod('month')}>Tháng</button>
        </div>
        <button className="ghost sm" onClick={() => setKeys((k) => ({ ...k, [period]: shiftKey(period, k[period], -1) }))} title="Kỳ trước">‹</button>
        <b className="fc-label">{periodLabel(period, key)}</b>
        <button className="ghost sm" onClick={() => setKeys((k) => ({ ...k, [period]: shiftKey(period, k[period], 1) }))} title="Kỳ sau">›</button>
        <button className="ghost sm" disabled={isCurrent} onClick={() => setKeys((k) => ({ ...k, [period]: keyOf(period, today) }))}>
          {period === 'week' ? 'Tuần này' : 'Tháng này'}
        </button>
        <span style={{ flex: 1 }} />
        <div className="wk-subtabs" role="tablist" aria-label="Cách xem">
          <button role="tab" aria-selected={view === 'kanban'} className={`wk-subtab${view === 'kanban' ? ' on' : ''}`} onClick={() => pickView('kanban')} title="Kanban — kéo thả thẻ giữa các cột">▥ Kanban</button>
          <button role="tab" aria-selected={view === 'table'} className={`wk-subtab${view === 'table' ? ' on' : ''}`} onClick={() => pickView('table')} title="Bảng — sắp xếp theo cột">▤ Bảng</button>
        </div>
        {storage && (
          <span className="badge" title={storage.mode === 'mongo' ? 'Đang lưu trên MongoDB (cụm cấu hình ở tab Công việc)' : 'Chưa cấu hình Mongo nên đang lưu trong file trên máy này'}>
            {storage.mode === 'mongo' ? '🍃' : '💾'} {storage.label}
          </span>
        )}
        {storage?.mode === 'local' && (
          <button className="ghost sm" onClick={onConfigureMongo} title="Cấu hình cụm Mongo để lưu lên Mongo">⚙ Dùng Mongo</button>
        )}
        <button className="ghost sm" onClick={() => void load()} title="Tải lại">↻</button>
        <button className="sm" onClick={() => { setModalErr(null); setModal({ item: null }); }}>＋ Thêm</button>
      </div>

      {storage?.mode === 'mongo' && localPending > 0 && (
        <div className="fc-banner">
          Có <b>{localPending}</b> nhiệm vụ trong file local (lưu từ trước khi dùng Mongo).
          <button className="sm" onClick={importLocal} disabled={busy}>⬆ Đưa lên Mongo</button>
        </div>
      )}
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: 0 }}>{err}</pre>}
      {note && <div className="badge" style={{ color: 'var(--ok)', alignSelf: 'flex-start' }}>{note}</div>}

      {/* ── Hàng 2: tiến độ kỳ ── */}
      <div className="fc-progress">
        <div className="fc-bar" aria-label={`Hoàn thành ${stats.pct}%`}><i style={{ width: `${stats.pct}%` }} /></div>
        <span className="small"><b>{stats.done}/{stats.total}</b> hoàn thành ({stats.pct}%)</span>
        {stats.over > 0 && <span className="fc-over small">⚠ {stats.over} quá hạn</span>}
      </div>

      {/* ── Hàng 3: lọc ── */}
      <div className="fc-filter">
        <input className="input" placeholder="🔎 Lọc theo tên, ghi chú, tag, dự án (không dấu cũng được)…" value={kw}
          onChange={(e) => setKw(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        {periodProjects.length > 0 && (
          <select className="input" value={projSel} onChange={(e) => setProjSel(e.target.value)} style={{ width: 160 }}>
            <option value="">Mọi dự án</option>
            {periodProjects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        {view === 'kanban' && inPeriod.some((i) => i.status === 'dropped') && (
          <button className={`chip-btn${showDropped ? ' on' : ''}`} onClick={() => setShowDropped((v) => !v)}>
            {showDropped ? 'Ẩn' : 'Hiện'} cột đã bỏ
          </button>
        )}
        {filtering && <button className="ghost sm" onClick={() => { setKw(''); setTagSel([]); setProjSel(''); }}>✕ Bỏ lọc</button>}
      </div>
      {tagCounts.length > 0 && (
        <div className="fc-chips" aria-label="Lọc theo tag">
          <span className="small" style={{ color: 'var(--muted)' }}>Tags:</span>
          {tagCounts.map(([t, n]) => (
            <button key={t} className={`chip-btn${tagSel.includes(t) ? ' on' : ''}`} onClick={() => toggleTag(t)}
              title={tagSel.includes(t) ? 'Bỏ lọc tag này' : 'Chỉ hiện nhiệm vụ có tag này (chọn nhiều tag = phải có đủ)'}>
              #{t} <span className="small" style={{ opacity: .7 }}>{n}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Thêm nhanh ── */}
      <div className="fc-quick">
        <input className="input" placeholder={`＋ Thêm nhiệm vụ trọng tâm cho ${period === 'week' ? 'tuần' : 'tháng'} này (Enter) — deadline mặc định ${periodEnd(period, key).slice(8, 10)}/${periodEnd(period, key).slice(5, 7)}`}
          value={quick} onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && quickAdd()} disabled={busy} />
        <button className="sm" onClick={quickAdd} disabled={busy || !quick.trim()}>Thêm</button>
      </div>

      {inPeriod.length === 0 ? (
        <div className="fc-emptyhero">
          <div style={{ fontSize: 34 }} aria-hidden>🎯</div>
          <b>Chưa có nhiệm vụ trọng tâm nào cho {periodLabel(period, key).toLowerCase()}</b>
          <span className="small" style={{ color: 'var(--muted)' }}>Gõ tên vào ô ở trên rồi Enter để thêm. Chỉ nên giữ vài việc thật sự quan trọng.</span>
        </div>
      ) : view === 'kanban' ? kanban : table}

      {modal && (
        <FocusModal
          key={modal.item?.id ?? 'new'}
          initial={modal.item ? draftOf(modal.item) : { ...blankDraft(period, key), tags: tagSel, project: projSel }}
          isNew={!modal.item}
          period={modal.item?.period ?? period}
          periodKey={modal.item?.periodKey ?? key}
          projects={projects}
          tagSuggestions={allTags}
          nextLabel={nextLabel}
          busy={busy}
          err={modalErr}
          onSave={(d) => void saveModal(d)}
          onCarry={() => modal.item && carry(modal.item)}
          onRemove={() => modal.item && remove(modal.item)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
