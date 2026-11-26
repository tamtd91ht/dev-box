'use client';

// Màn "Kỹ năng" trong bảng Trợ lý AI (components/AiChat.tsx) — người dùng soạn quy trình cho từng
// loại việc; trợ lý tự kích hoạt kỹ năng theo từ khoá / màn hình, hoặc tự xin nạp theo mô tả
// "Dùng khi" (lib/aiSkills.ts). Nhập / xuất được dạng SKILL.md (lib/aiSkillFormat.ts).
// Bố cục theo màn Kho tri thức ngay cạnh: danh sách có công tắc bật/tắt, bấm vào để sửa.

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { fmtRel } from '@/lib/google';
import { saveBlob } from '@/lib/aiExportClient';
import { SKILL_LIMITS, type AiSkill, type AiSkillMeta } from '@/lib/aiChat';
import { SKILL_TEMPLATE, matchPhrase, normText, skillToMd } from '@/lib/aiSkillFormat';

interface Draft { id?: string; name: string; description: string; keywords: string; screens: string; instructions: string }

const num = (n: number) => n.toLocaleString('vi-VN');

async function call<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await apiFetch('/api/ai', { method: 'POST', body: JSON.stringify({ action, ...params }), timeoutMs: 30000 });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: T };
  if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
  return data.result as T;
}

/** Kỹ năng nào tự bật khi đang ở màn hình này. */
export function skillsForScreen(skills: AiSkillMeta[] | null, screen: string): AiSkillMeta[] {
  const scr = normText(screen);
  return (skills ?? []).filter((s) => s.enabled && s.screens.some((x) => matchPhrase(scr, x)));
}

export default function AiSkillsView(props: {
  skills: AiSkillMeta[] | null;
  error: string | null;
  screen: string;
  onSkills: (s: AiSkillMeta[]) => void;
  onReload: () => void;
}) {
  const { skills, error, screen, onSkills, onReload } = props;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [askDel, setAskDel] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const editing = draft !== null;
  useEffect(() => { if (editing) nameRef.current?.focus(); }, [editing]);

  const run = async (fn: () => Promise<AiSkillMeta[]>, okText?: string) => {
    setMsg(null);
    try { onSkills(await fn()); if (okText) setMsg({ kind: 'ok', text: okText }); return true; }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); return false; }
  };

  const importFiles = async (files: File[]) => {
    if (!files.length) return;
    setMsg(null);
    let done = 0;
    const errors: string[] = [];
    let last: AiSkillMeta[] | null = null;
    for (const f of files) {
      try {
        const text = await f.text();
        if (text.slice(0, 4000).includes('\u0000')) throw new Error(`${f.name}: không phải file chữ`);
        last = await call<AiSkillMeta[]>('skill.import', { text, fileName: f.name });
        done += 1;
      } catch (e) { errors.push((e as Error).message); }
    }
    if (last) onSkills(last);
    setMsg(errors.length
      ? { kind: 'err', text: `${done ? `Đã nhập ${done} kỹ năng. ` : ''}Lỗi: ${errors.join(' · ')}` }
      : { kind: 'ok', text: `Đã nhập ${done} kỹ năng.` });
  };

  const edit = async (id: string) => {
    setMsg(null);
    try {
      const s = await call<AiSkill>('skill.get', { id });
      setDraft({ id: s.id, name: s.name, description: s.description, keywords: s.keywords.join(', '), screens: s.screens.join(', '), instructions: s.instructions });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const exportMd = async (id: string) => {
    setMsg(null);
    try {
      const s = await call<AiSkill>('skill.get', { id });
      const file = `${s.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'skill'}.md`;
      saveBlob(new Blob([skillToMd(s)], { type: 'text/markdown;charset=utf-8' }), file);
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    const ok = await run(() => call<AiSkillMeta[]>('skill.save', { ...draft }), draft.id ? 'Đã lưu kỹ năng.' : 'Đã thêm kỹ năng.');
    setSaving(false);
    if (ok) setDraft(null);
  };

  // ── Soạn / sửa ─────────────────────────────────────────────────────────────
  if (draft) {
    const tooLong = draft.instructions.length > SKILL_LIMITS.maxInstructions;
    const valid = draft.name.trim() !== '' && draft.description.trim() !== '' && draft.instructions.trim() !== '' && !tooLong;
    const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
    const screenName = screen.split(/\s*\+\s*/)[0]?.replace(/\s*\(.*\)$/, '').trim();
    return (
      <div className="aic-kb">
        <div className="aic-kb-bar">
          <button className="aic-link" onClick={() => { setDraft(null); setMsg(null); }}>← Kỹ năng</button>
          <span className="aic-kb-h">{draft.id ? 'Sửa kỹ năng' : 'Thêm kỹ năng'}</span>
          <span className="aic-spacer" />
          {!draft.id && (
            <button className="ghost sm" title="Điền sẵn ví dụ: đọc & phân tích nhóm Zalo"
              onClick={() => setDraft({ ...SKILL_TEMPLATE, keywords: SKILL_TEMPLATE.keywords.join(', '), screens: SKILL_TEMPLATE.screens.join(', ') })}>
              Dùng mẫu
            </button>
          )}
        </div>
        <div className="aic-form aic-skill-form">
          <label className="aic-label" htmlFor="aic-sk-name">Tên <span className="aic-req" aria-hidden>*</span></label>
          <input id="aic-sk-name" ref={nameRef} className="input" value={draft.name} maxLength={SKILL_LIMITS.maxName}
            placeholder="Vd: Phân tích nhóm Zalo" onChange={(e) => set({ name: e.target.value })} />

          <label className="aic-label" htmlFor="aic-sk-desc">
            Dùng khi <span className="aic-req" aria-hidden>*</span>
            <span className="aic-hint">trợ lý đọc dòng này để tự quyết có dùng kỹ năng không</span>
          </label>
          <textarea id="aic-sk-desc" className="aic-sk-desc" rows={2} value={draft.description} maxLength={SKILL_LIMITS.maxDesc}
            placeholder="Vd: Dùng khi người hỏi muốn đọc, tóm tắt, phân tích vấn đề trong một nhóm Zalo."
            onChange={(e) => set({ description: e.target.value })} />

          <label className="aic-label" htmlFor="aic-sk-kw">
            Từ khoá kích hoạt <span className="aic-hint">cách nhau bằng dấu phẩy · không phân biệt dấu</span>
          </label>
          <input id="aic-sk-kw" className="input" value={draft.keywords} placeholder="zalo, nhóm, group, tin nhắn"
            onChange={(e) => set({ keywords: e.target.value })} />

          <label className="aic-label" htmlFor="aic-sk-scr">
            Màn hình áp dụng <span className="aic-hint">đang mở màn này thì tự kích hoạt</span>
          </label>
          <div className="aic-sk-row">
            <input id="aic-sk-scr" className="input" value={draft.screens} placeholder="Zalo, Browser"
              onChange={(e) => set({ screens: e.target.value })} />
            {screenName && !draft.screens.split(',').some((x) => normText(x) === normText(screenName)) && (
              <button className="ghost sm" title={`Thêm màn hình đang mở: ${screenName}`}
                onClick={() => set({ screens: draft.screens.trim() ? `${draft.screens.replace(/[,\s]+$/, '')}, ${screenName}` : screenName })}>
                ＋ {screenName}
              </button>
            )}
          </div>

          <label className="aic-label" htmlFor="aic-sk-ins">
            Hướng dẫn <span className="aic-req" aria-hidden>*</span>
            <span className="aic-hint">{num(draft.instructions.length)} ký tự · Markdown</span>
          </label>
          <textarea id="aic-sk-ins" className="aic-kb-text" value={draft.instructions}
            placeholder={'Các bước làm, tiêu chí phân tích, định dạng kết quả…\nVd: 1. Mở tab Zalo, đọc nhóm đang mở  2. Cuộn lên tới đầu ngày  3. Gom tin theo vấn đề…'}
            onChange={(e) => set({ instructions: e.target.value })}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void save(); } }} />
          {tooLong && (
            <div className="aic-note err" role="alert">
              Dài quá {num(SKILL_LIMITS.maxInstructions)} ký tự — tài liệu tham khảo dài thì đưa vào Kho tri thức.
            </div>
          )}
          {msg?.kind === 'err' && <div className="aic-note err" role="alert">{msg.text}</div>}
        </div>
        <div className="aic-kb-foot">
          <button className="ghost sm" onClick={() => { setDraft(null); setMsg(null); }} disabled={saving}>Đóng</button>
          <button className="aic-cta" onClick={() => void save()} disabled={!valid || saving} title="Lưu (Ctrl+Enter)">
            {saving ? <span className="spinner" aria-hidden /> : null} {draft.id ? 'Lưu thay đổi' : 'Thêm kỹ năng'}
          </button>
        </div>
      </div>
    );
  }

  // ── Danh sách ──────────────────────────────────────────────────────────────
  const list = skills ?? [];
  const needle = normText(q);
  const shown = q.trim()
    ? list.filter((s) => normText(`${s.name} ${s.description} ${s.keywords.join(' ')}`).includes(needle.trim()))
    : list;
  const here = new Set(skillsForScreen(skills, screen).map((s) => s.id));

  return (
    <div className="aic-kb">
      <p className="aic-kb-intro">
        Kỹ năng là <b>quy trình</b> bạn soạn cho một loại việc (vd phân tích nhóm Zalo). Trợ lý tự dùng kỹ năng đang <b>bật</b> khi
        câu hỏi có từ khoá, khi bạn đang mở đúng màn hình, hoặc khi nó thấy câu hỏi khớp mục “Dùng khi”.
      </p>

      <div className="aic-kb-bar">
        <input className="input aic-search" type="search" value={q} placeholder="Tìm kỹ năng" aria-label="Tìm kỹ năng"
          onChange={(e) => setQ(e.target.value)} />
        <button className="ghost sm" onClick={() => fileRef.current?.click()} title="Nhập file SKILL.md (frontmatter name / description / keywords / screens)">
          Nhập .md
        </button>
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt" multiple hidden
          onChange={(e) => { void importFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <button className="aic-cta" onClick={() => { setMsg(null); setDraft({ name: '', description: '', keywords: '', screens: '', instructions: '' }); }}>
          ＋ Thêm mới
        </button>
      </div>

      {msg && <div className={`aic-note ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</div>}

      <div className="aic-kb-list">
        {error ? (
          <div className="aic-error" role="alert">
            <span>Không tải được danh sách kỹ năng: {error}</span>
            <button className="ghost sm" onClick={onReload}>Thử lại</button>
          </div>
        ) : skills === null ? (
          <div className="aic-skel" aria-label="Đang tải kỹ năng"><i /><i /><i /></div>
        ) : list.length === 0 ? (
          <div className="aic-empty">
            <div className="aic-empty-ico" aria-hidden>🧩</div>
            <p className="aic-empty-title">Chưa có kỹ năng</p>
            <p className="aic-empty-sub">Bấm “Thêm mới” → “Dùng mẫu” để bắt đầu từ ví dụ phân tích nhóm Zalo, hoặc nhập file SKILL.md.</p>
          </div>
        ) : shown.length === 0 ? (
          <p className="aic-empty-sub" style={{ padding: 16 }}>Không có kỹ năng nào khớp “{q}”.</p>
        ) : shown.map((s) => (
          <div key={s.id} className={`aic-doc${s.enabled ? '' : ' off'}`}>
            <button
              className={`aic-switch${s.enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={s.enabled}
              aria-label={`${s.enabled ? 'Tắt' : 'Bật'} kỹ năng ${s.name}`}
              title={s.enabled ? 'Đang bật — bấm để tắt' : 'Đang tắt — trợ lý không dùng kỹ năng này'}
              onClick={() => void run(() => call<AiSkillMeta[]>('skill.toggle', { id: s.id, enabled: !s.enabled }))}
            ><i /></button>
            <button className="aic-doc-main" onClick={() => void edit(s.id)} title={`Dùng khi: ${s.description}\n\nBấm để xem / sửa`}>
              <span className="aic-doc-title">
                {s.name}
                {here.has(s.id) && <span className="aic-sk-here" title="Màn hình đang mở khớp — kỹ năng tự kích hoạt">hợp màn này</span>}
              </span>
              <span className="aic-doc-sub aic-sk-desc-line">{s.description}</span>
              <span className="aic-doc-sub">
                {s.keywords.length ? `🔑 ${s.keywords.slice(0, 6).join(', ')}${s.keywords.length > 6 ? '…' : ''} · ` : ''}
                {s.screens.length ? `🖥 ${s.screens.join(', ')} · ` : ''}
                {num(s.chars)} ký tự · {fmtRel(s.updatedAt)}
              </span>
            </button>
            <button className="aic-del" onClick={() => void exportMd(s.id)} aria-label={`Tải kỹ năng ${s.name} dạng SKILL.md`} title="Tải về dạng SKILL.md">⤓</button>
            {askDel === s.id ? (
              <button className="aic-del ask" autoFocus onBlur={() => setAskDel(null)}
                onClick={() => { setAskDel(null); void run(() => call<AiSkillMeta[]>('skill.remove', { id: s.id }), 'Đã xoá kỹ năng.'); }}>
                Xoá hẳn?
              </button>
            ) : (
              <button className="aic-del" onClick={() => setAskDel(s.id)} aria-label={`Xoá kỹ năng ${s.name}`} title="Xoá">✕</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
