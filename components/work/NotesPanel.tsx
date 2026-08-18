'use client';

// Tab con GHI CHÚ (trong tab Công việc) — kho lưu thông tin dạng text.
//
// Cố tình ĐƠN GIẢN, khác hẳn task: một ghi chú chỉ có TÊN + DANH SÁCH TAG (tùy
// chọn) + một ô NỘI DUNG text tự do. Không trạng thái, không deadline, không
// cảnh báo. Luồng: "＋ Ghi chú mới" → nhập tên / gán tag / gõ nội dung → 💾 Lưu;
// lần sau bấm vào ghi chú trong danh sách bên trái để mở ra sửa tiếp.
//
// Layout: rail trái = danh sách (tìm theo tên/tag/nội dung, không dấu; chip tag
// để lọc nhanh) · phải = trình soạn ghi chú đang chọn.
//
// Lưu ở MongoDB, collection 'devbox_work_notes' — CÙNG cụm và database với task
// (xem lib/workNotes), nên không có bước cấu hình riêng: tab Công việc đã cấu
// hình kho lưu trữ là ghi chú dùng được ngay.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface WorkNote {
  id: string;
  name: string;
  tags: string[];
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** Bỏ dấu tiếng Việt + lowercase — search không phân biệt hoa/thường/dấu. */
function stripVN(s: string): string {
  return s
    .normalize('NFD')
    // Dải combining marks U+0300–U+036F (dấu tách ra sau NFD).
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/** 'HH:mm DD/MM/YYYY' — mốc sửa gần nhất, hiện dưới mỗi dòng. */
function fmtTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())} ${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Bản nháp đang mở trong trình soạn. id=null nghĩa là ghi chú MỚI chưa lưu. */
interface Draft {
  id: string | null;
  name: string;
  tags: string[];
  body: string;
}

const emptyDraft = (): Draft => ({ id: null, name: '', tags: [], body: '' });

const draftOf = (n: WorkNote): Draft => ({ id: n.id, name: n.name, tags: [...n.tags], body: n.body });

export default function NotesPanel({ action }: {
  /** Gọi /api/work — dùng chung helper của WorkWorkspace. */
  action: <T>(name: string, params?: Record<string, unknown>) => Promise<T>;
}) {
  const [notes, setNotes] = useState<WorkNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  /** Bản gốc của ghi chú đang mở — để biết có thay đổi chưa lưu hay không. */
  const [base, setBase] = useState<Draft | null>(null);
  const [tagInput, setTagInput] = useState('');

  const [kw, setKw] = useState('');
  /** Tag đang lọc; rỗng = không lọc. Nhiều tag = phải có ĐỦ (AND). */
  const [tagSel, setTagSel] = useState<string[]>([]);

  const nameRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (keepId?: string | null) => {
    try {
      const r = await action<{ notes: WorkNote[] }>('notes-list');
      setNotes(r.notes);
      setErr(null);
      // Ghi chú đang mở vừa bị xóa ở máy khác → đóng trình soạn để khỏi lưu nhầm.
      if (keepId && !r.notes.some((n) => n.id === keepId)) { setDraft(null); setBase(null); }
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }, [action]);

  useEffect(() => { void load(); }, [load]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [notes]);

  const filtered = useMemo(() => {
    const q = stripVN(kw.trim());
    return notes.filter((n) => {
      if (tagSel.length > 0 && !tagSel.every((t) => n.tags.includes(t))) return false;
      if (!q) return true;
      // Tìm trên TÊN + TAG + NỘI DUNG — ghi chú là để tra lại, nội dung phải khớp được.
      return stripVN(`${n.name} ${n.tags.join(' ')} ${n.body}`).includes(q);
    });
  }, [notes, kw, tagSel]);

  const dirty = useMemo(() => {
    if (!draft) return false;
    if (!base) return draft.name.trim() !== '' || draft.body !== '' || draft.tags.length > 0;
    return draft.name !== base.name || draft.body !== base.body
      || draft.tags.join(' ') !== base.tags.join(' ');
  }, [draft, base]);

  /** Mở một bản nháp khác — hỏi trước nếu bản đang mở còn thay đổi chưa lưu. */
  const openDraft = (next: Draft | null, focusName = false) => {
    if (dirty && !window.confirm('Ghi chú đang mở có thay đổi chưa lưu. Bỏ thay đổi đó?')) return;
    setDraft(next);
    setBase(next && next.id ? next : null);
    setTagInput('');
    setErr(null);
    if (focusName) setTimeout(() => nameRef.current?.focus(), 0);
  };

  const addTag = (raw: string) => {
    // Cho dán nhiều tag một lần: "a, b, c".
    const parts = raw.split(',').map((t) => t.trim()).filter(Boolean);
    if (parts.length === 0) { setTagInput(''); return; }
    setDraft((d) => {
      if (!d) return d;
      const tags = [...d.tags];
      for (const p of parts) if (!tags.includes(p) && tags.length < 20) tags.push(p);
      return { ...d, tags };
    });
    setTagInput('');
  };

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    setBusy(true); setErr(null);
    try {
      const params = { name: draft.name.trim(), tags: draft.tags, body: draft.body };
      const r = draft.id
        ? await action<{ note: WorkNote }>('note-update', { id: draft.id, ...params })
        : await action<{ note: WorkNote }>('note-add', params);
      const saved = draftOf(r.note);
      setDraft(saved);
      setBase(saved);
      await load(r.note.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const remove = async (n: WorkNote) => {
    if (!window.confirm(`Xóa ghi chú "${n.name}"?`)) return;
    setBusy(true);
    try {
      await action('note-remove', { id: n.id });
      if (draft?.id === n.id) { setDraft(null); setBase(null); }
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="wk-notes">
      {/* ── Rail trái: tìm kiếm + danh sách ghi chú ── */}
      <aside className="wk-notes-list">
        <div className="wk-notes-head">
          <input
            className="input"
            placeholder="🔎 Tìm tên, tag, nội dung…"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="ghost sm" onClick={() => void load(draft?.id)} title="Tải lại">↻</button>
          <button className="sm" onClick={() => openDraft(emptyDraft(), true)} title="Tạo ghi chú mới">＋</button>
        </div>

        {allTags.length > 0 && (
          <div className="wk-notes-tags" role="group" aria-label="Lọc theo tag">
            {allTags.map(([t, n]) => {
              const on = tagSel.includes(t);
              return (
                <button
                  key={t}
                  className={`wk-st-btn kd${on ? ' on' : ''}`}
                  aria-pressed={on}
                  onClick={() => setTagSel((prev) => (on ? prev.filter((x) => x !== t) : [...prev, t]))}
                  title={`${n} ghi chú gắn tag này`}
                >#{t} <span className="wk-st-n">{n}</span></button>
              );
            })}
            {tagSel.length > 0 && <button className="ghost sm" onClick={() => setTagSel([])}>✕ Bỏ lọc tag</button>}
          </div>
        )}

        <div className="wk-notes-scroll">
          {loading && <p className="small" style={{ color: 'var(--muted)' }}><span className="spinner" /> Đang tải…</p>}
          {!loading && notes.length === 0 && (
            <p className="small" style={{ color: 'var(--muted)' }}>Chưa có ghi chú nào — bấm ＋ để tạo.</p>
          )}
          {!loading && notes.length > 0 && filtered.length === 0 && (
            <p className="small" style={{ color: 'var(--muted)' }}>Không có ghi chú nào khớp.</p>
          )}
          {filtered.map((n) => (
            <div key={n.id} className={`wk-note-item${draft?.id === n.id ? ' on' : ''}`}>
              <button className="wk-note-open" onClick={() => openDraft(draftOf(n))} title="Mở để xem / sửa">
                <b className="wk-note-name">{n.name}</b>
                {n.tags.length > 0 && (
                  <span className="wk-note-tags">{n.tags.map((t) => <span key={t} className="wk-tag">#{t}</span>)}</span>
                )}
                {/* Dòng preview: 120 ký tự đầu, xuống dòng nén lại thành khoảng trắng. */}
                {n.body.trim() && <span className="wk-note-prev">{n.body.replace(/\s+/g, ' ').trim().slice(0, 120)}</span>}
                <span className="wk-note-time">Sửa lúc {fmtTime(n.updatedAt || n.createdAt)}</span>
              </button>
              <button className="ghost sm" onClick={() => void remove(n)} disabled={busy} title="Xóa ghi chú">🗑</button>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Phải: trình soạn ── */}
      <section className="wk-notes-editor">
        {!draft ? (
          <div className="office-hero" style={{ margin: 'auto' }}>
            <div className="office-hero-ico" aria-hidden>📝</div>
            <div className="office-hero-title">Ghi chú</div>
            <p className="office-hero-sub">
              Chọn một ghi chú ở danh sách bên trái để xem / sửa, hoặc bấm <b>＋ Ghi chú mới</b> để tạo mới.
            </p>
            <button className="sm" onClick={() => openDraft(emptyDraft(), true)}>＋ Ghi chú mới</button>
          </div>
        ) : (
          <>
            <div className="wk-notes-bar">
              <input
                ref={nameRef}
                className="input"
                placeholder="Tên ghi chú (ví dụ: Dự án ABC)"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                style={{ flex: 1, minWidth: 160, fontWeight: 600 }}
              />
              <span className="small" style={{ color: 'var(--muted)' }}>
                {draft.id ? (dirty ? '● Chưa lưu' : 'Đã lưu') : '● Ghi chú mới'}
              </span>
              <button className="sm" onClick={() => void save()} disabled={busy || !draft.name.trim() || !dirty}
                title={!draft.name.trim() ? 'Nhập tên ghi chú trước' : dirty ? 'Lưu ghi chú' : 'Không có thay đổi nào để lưu'}>
                {busy ? <span className="spinner" aria-hidden /> : '💾'} Lưu
              </button>
              <button className="ghost sm" onClick={() => openDraft(null)} disabled={busy} title="Đóng trình soạn">✕</button>
            </div>

            {/* Tag: chip đã gán + ô nhập (Enter hoặc dấu phẩy để thêm). */}
            <div className="wk-notes-tagedit">
              <span className="small" style={{ color: 'var(--muted)' }}>Tag:</span>
              {draft.tags.map((t) => (
                <span key={t} className="wk-note-chip">
                  #{t}
                  <button className="wk-note-chip-x" onClick={() => setDraft({ ...draft, tags: draft.tags.filter((x) => x !== t) })} title={`Bỏ tag ${t}`}>✕</button>
                </span>
              ))}
              <input
                className="input sm"
                placeholder="+ tag rồi Enter"
                value={tagInput}
                onChange={(e) => {
                  // Gõ dấu phẩy = chốt tag luôn, không cần Enter.
                  if (e.target.value.includes(',')) addTag(e.target.value);
                  else setTagInput(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); }
                  // Backspace trong ô rỗng = xóa tag cuối (thói quen quen thuộc).
                  else if (e.key === 'Backspace' && !tagInput && draft.tags.length > 0) {
                    setDraft({ ...draft, tags: draft.tags.slice(0, -1) });
                  }
                }}
                onBlur={() => addTag(tagInput)}
                style={{ width: 150 }}
              />
              {/* Gợi ý từ tag đã dùng ở ghi chú khác — gõ lại tay dễ sai chính tả. */}
              {allTags.filter(([t]) => !draft.tags.includes(t)).slice(0, 6).map(([t]) => (
                <button key={t} className="ghost sm wk-note-sugg" onClick={() => addTag(t)} title={`Gán tag ${t}`}>+ #{t}</button>
              ))}
            </div>

            {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: 0 }}>{err}</pre>}

            <textarea
              className="input wk-notes-body"
              placeholder="Nội dung ghi chú…"
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              onKeyDown={(e) => {
                // Ctrl/Cmd+S — phản xạ soạn thảo, khỏi rời tay khỏi bàn phím.
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
              }}
              spellCheck={false}
            />
            <div className="small" style={{ color: 'var(--muted)' }}>
              {draft.body.length.toLocaleString('vi-VN')} ký tự · Ctrl+S để lưu nhanh
              {base && ` · tạo lúc ${fmtTime(notes.find((n) => n.id === base.id)?.createdAt ?? 0)}`}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
