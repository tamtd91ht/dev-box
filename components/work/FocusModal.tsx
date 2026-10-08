'use client';

// Hộp thêm / sửa MỘT nhiệm vụ trọng tâm: tên, ưu tiên, trạng thái, deadline, dự
// án, tag, ghi chú, checklist việc con. Nút "Chuyển sang kỳ sau" và "Xóa" chỉ có
// khi sửa nhiệm vụ đã tồn tại.

import { useState } from 'react';
import {
  FOCUS_STATUSES, FOCUS_PRIORITIES, periodEnd, cleanTags,
  type FocusItem, type FocusPeriod, type FocusPriority, type FocusStatus, type FocusSub,
} from '@/lib/workFocusCore';

export const STATUS_META: Record<FocusStatus, { label: string; icon: string }> = {
  todo: { label: 'Chưa làm', icon: '⏳' },
  doing: { label: 'Đang làm', icon: '▶' },
  done: { label: 'Hoàn thành', icon: '✓' },
  dropped: { label: 'Đã bỏ', icon: '✕' },
};

export const PRIORITY_META: Record<FocusPriority, { label: string; cls: string }> = {
  normal: { label: 'Thường', cls: 'p-normal' },
  high: { label: 'Cao', cls: 'p-high' },
  urgent: { label: 'Khẩn', cls: 'p-urgent' },
};

/** Dữ liệu form — chính là phần người dùng sửa được của FocusItem. */
export interface FocusDraft {
  title: string;
  note: string;
  project: string;
  tags: string[];
  priority: FocusPriority;
  status: FocusStatus;
  deadline: string | null;
  subtasks: FocusSub[];
}

export function draftOf(it: FocusItem): FocusDraft {
  return {
    title: it.title, note: it.note, project: it.project, tags: [...it.tags], priority: it.priority,
    status: it.status, deadline: it.deadline, subtasks: it.subtasks.map((s) => ({ ...s })),
  };
}

export function blankDraft(period: FocusPeriod, key: string): FocusDraft {
  return {
    title: '', note: '', project: '', tags: [], priority: 'normal', status: 'todo',
    deadline: periodEnd(period, key), subtasks: [],
  };
}

export default function FocusModal({
  initial, isNew, period, periodKey, projects, tagSuggestions, nextLabel, busy, err, onSave, onCarry, onRemove, onClose,
}: {
  initial: FocusDraft;
  isNew: boolean;
  period: FocusPeriod;
  periodKey: string;
  projects: string[];
  /** Tag đã có trong kho — gợi ý bấm một cái là gắn. */
  tagSuggestions: string[];
  /** 'tuần sau' / 'tháng sau' — nhãn nút chuyển kỳ. */
  nextLabel: string;
  busy: boolean;
  err: string | null;
  onSave: (d: FocusDraft) => void;
  onCarry: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<FocusDraft>(initial);
  const [tagIn, setTagIn] = useState('');
  const [subIn, setSubIn] = useState('');
  const set = (patch: Partial<FocusDraft>) => setD((x) => ({ ...x, ...patch }));

  const addTags = (raw: string) => {
    const add = cleanTags(raw);
    if (add.length) set({ tags: cleanTags([...d.tags, ...add]) });
    setTagIn('');
  };
  const addSub = () => {
    const text = subIn.trim();
    if (!text) return;
    set({ subtasks: [...d.subtasks, { id: globalThis.crypto.randomUUID(), text, done: false }] });
    setSubIn('');
  };
  const setSub = (id: string, patch: Partial<FocusSub>) =>
    set({ subtasks: d.subtasks.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  // Tag nhập dở trong ô chưa Enter thì vẫn tính khi bấm Lưu — mất tag vì quên Enter là bực nhất.
  const submit = () => onSave({ ...d, tags: cleanTags([...d.tags, ...cleanTags(tagIn)]), subtasks: subIn.trim()
    ? [...d.subtasks, { id: globalThis.crypto.randomUUID(), text: subIn.trim(), done: false }] : d.subtasks });

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal fc-modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 96vw)' }}>
        <div className="status-line" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{isNew ? '🎯 Nhiệm vụ trọng tâm mới' : '🎯 Sửa nhiệm vụ'}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div className="fc-form">
          <input className="input" autoFocus placeholder="Tên nhiệm vụ…" value={d.title}
            onChange={(e) => set({ title: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }} />

          <div className="fc-row">
            <label className="fc-fld"><span>Ưu tiên</span>
              <select className="input" value={d.priority} onChange={(e) => set({ priority: e.target.value as FocusPriority })}>
                {FOCUS_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
              </select>
            </label>
            <label className="fc-fld"><span>Trạng thái</span>
              <select className="input" value={d.status} onChange={(e) => set({ status: e.target.value as FocusStatus })}>
                {FOCUS_STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].icon} {STATUS_META[s].label}</option>)}
              </select>
            </label>
            <label className="fc-fld"><span>Deadline</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <input className="input" type="date" value={d.deadline ?? ''} style={{ flex: 1, minWidth: 0 }}
                  onChange={(e) => set({ deadline: e.target.value || null })} />
                <button type="button" className="ghost sm" title={`Đặt về cuối ${period === 'week' ? 'tuần' : 'tháng'}`}
                  onClick={() => set({ deadline: periodEnd(period, periodKey) })}>Cuối kỳ</button>
                <button type="button" className="ghost sm" title="Không đặt deadline" onClick={() => set({ deadline: null })}>✕</button>
              </div>
            </label>
          </div>

          <label className="fc-fld"><span>Dự án</span>
            <input className="input" list="fc-projects" placeholder="(tuỳ chọn)" value={d.project}
              onChange={(e) => set({ project: e.target.value })} />
            <datalist id="fc-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
          </label>

          <div className="fc-fld"><span>Tags</span>
            <div className="fc-tagbox">
              {d.tags.map((t) => (
                <span key={t} className="fc-tag">#{t}<button type="button" aria-label={`Bỏ tag ${t}`}
                  onClick={() => set({ tags: d.tags.filter((x) => x !== t) })}>✕</button></span>
              ))}
              <input className="fc-taginput" placeholder={d.tags.length ? 'thêm tag…' : 'Gõ tag rồi Enter hoặc dấu phẩy'} value={tagIn}
                onChange={(e) => (e.target.value.endsWith(',') ? addTags(e.target.value) : setTagIn(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addTags(tagIn); }
                  else if (e.key === 'Backspace' && !tagIn && d.tags.length) set({ tags: d.tags.slice(0, -1) });
                }}
                onBlur={() => tagIn.trim() && addTags(tagIn)} />
            </div>
            {tagSuggestions.filter((t) => !d.tags.includes(t)).length > 0 && (
              <div className="fc-sugg">
                {tagSuggestions.filter((t) => !d.tags.includes(t)).slice(0, 12).map((t) => (
                  <button key={t} type="button" className="chip-btn" onClick={() => set({ tags: cleanTags([...d.tags, t]) })}>#{t}</button>
                ))}
              </div>
            )}
          </div>

          <label className="fc-fld"><span>Ghi chú</span>
            <textarea className="input" rows={4} placeholder="Mô tả, tiêu chí hoàn thành, liên kết…" value={d.note}
              onChange={(e) => set({ note: e.target.value })} style={{ resize: 'vertical' }} />
          </label>

          <div className="fc-fld"><span>Việc con{d.subtasks.length ? ` (${d.subtasks.filter((s) => s.done).length}/${d.subtasks.length})` : ''}</span>
            <div className="fc-subs">
              {d.subtasks.map((s) => (
                <div key={s.id} className="fc-sub">
                  <input type="checkbox" checked={s.done} onChange={(e) => setSub(s.id, { done: e.target.checked })} />
                  <input className="input" value={s.text} onChange={(e) => setSub(s.id, { text: e.target.value })} />
                  <button type="button" className="ghost sm" onClick={() => set({ subtasks: d.subtasks.filter((x) => x.id !== s.id) })}>✕</button>
                </div>
              ))}
              <div className="fc-sub">
                <span aria-hidden style={{ width: 16 }} />
                <input className="input" placeholder="＋ Thêm việc con, Enter để thêm" value={subIn}
                  onChange={(e) => setSubIn(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } }} />
              </div>
            </div>
          </div>
        </div>

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{err}</pre>}
        <div className="fc-foot">
          <button className="sm" onClick={submit} disabled={busy || !d.title.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : '💾'} Lưu
          </button>
          <button className="ghost sm" onClick={onClose} disabled={busy}>Hủy</button>
          <span style={{ flex: 1 }} />
          {!isNew && (
            <>
              <button className="ghost sm" onClick={onCarry} disabled={busy}
                title={`Dời nhiệm vụ này sang ${nextLabel} (deadline dời theo)`}>↪ Chuyển sang {nextLabel}</button>
              <button className="ghost sm" onClick={onRemove} disabled={busy}>🗑 Xóa</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
