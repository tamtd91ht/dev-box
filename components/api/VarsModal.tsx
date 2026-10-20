'use client';

// Quản lý biến {{tên}} của tab API: một danh sách CHUNG + một danh sách riêng cho
// từng DỰ ÁN (thư mục). Biến của dự án ghi đè biến chung cùng tên; request thuộc
// dự án nào (`folder`) thì dùng biến dự án đó. Biến động ({{$guid}}, {{$timestamp}}…)
// có sẵn, không cần khai.
//
// MỖI BIẾN MỘT DÒNG, kể cả khi có nhiều giá trị (dev / stg, user A / user B…):
//   · cột "Đang dùng" chọn giá trị của RIÊNG biến đó — không còn một ô name
//     chung ép mọi biến cùng nhãn. Lựa chọn lưu chung cho mọi request.
//   · ô Giá trị sửa thẳng giá trị đang dùng; ▸ mở ra để sửa / thêm các giá trị.
//   · ⇄ Chuyển nhanh: mọi biến có giá trị mang nhãn X chuyển sang X một lần.
// Dưới đáy vẫn là danh sách phẳng ApiVar[] (mỗi giá trị một dòng, `name` = nhãn)
// — file cũ đọc được nguyên, không phải migrate.
//
// TAG tự gán để lọc: ô tìm (tên / giá trị / nhãn / tag), chip tag có đếm số
// (bấm để lọc, chọn nhiều = khớp bất kỳ), gán / gỡ tag cho nhiều biến cùng lúc.

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiSaveGlobals, apiSaveProjectVars, type ApiData, type ApiHeader } from '@/lib/api';
import { DYNAMIC_VARS, pickLabel, varNames } from '@/lib/apiVars';
import TagEditor, { TagChip, addTags } from './TagEditor';

/** Khoá phạm vi: '' = biến chung. */
const GLOBAL = '';
/** Chip lọc "chưa gắn tag". */
const NO_TAG = '\u0000none';

/** Một giá trị đang sửa: `gid` gom các giá trị của cùng một biến, `rid` định danh dòng. */
interface VRow extends ApiHeader { gid: string; rid: string }

interface Group { gid: string; key: string; rows: VRow[]; tags: string[]; on: boolean }

let seq = 0;
const uid = (p: string) => `${p}${(seq += 1).toString(36)}`;

function rowsOf(vars: ApiData['globalVars']): VRow[] {
  const gids = new Map<string, string>();
  return (vars ?? []).map((v) => {
    const k = v.key.trim();
    let gid = gids.get(k);
    if (!gid) { gid = uid('g'); gids.set(k, gid); }
    return { key: v.key, value: v.value, on: v.on !== false, name: v.name ?? '', tags: v.tags ?? [], gid, rid: uid('r') };
  });
}

/** Gom theo biến, giữ thứ tự xuất hiện đầu tiên. */
function groupsOf(rows: VRow[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    let g = map.get(r.gid);
    if (!g) { g = { gid: r.gid, key: r.key, rows: [], tags: r.tags ?? [], on: false }; map.set(r.gid, g); }
    g.rows.push(r);
    if (r.on !== false) g.on = true;
  }
  return [...map.values()];
}

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
const labelText = (l: string) => l || 'mặc định';

type Sort = 'manual' | 'az' | 'tag';

export default function VarsModal({
  data, projects, initialScope, initialKey, onSaved, onClose,
}: {
  data: ApiData;
  /** Các dự án đã có (từ request đã lưu). */
  projects: string[];
  /** Phạm vi mở sẵn: '' = chung, hoặc tên dự án. */
  initialScope: string;
  /** Mở sẵn biến này (chưa có thì thêm sẵn một dòng mang tên đó) — từ chip "chưa khai". */
  initialKey?: string;
  onSaved: (d: ApiData) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState(initialScope);
  // Bản đang sửa của từng phạm vi — chỉ phạm vi nào CÓ trong đây mới bị ghi lúc Lưu.
  const [edits, setEdits] = useState<Record<string, VRow[]>>({});
  const [pickEdits, setPickEdits] = useState<Record<string, Record<string, string>>>({});
  const [extra, setExtra] = useState<string[]>(initialScope && !projects.includes(initialScope) ? [initialScope] : []);
  const [newProj, setNewProj] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showDyn, setShowDyn] = useState(false);
  const [q, setQ] = useState('');
  const [tagSel, setTagSel] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>('manual');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [bulkTag, setBulkTag] = useState('');
  /** Dòng vừa thêm — focus ô tên. */
  const [focusGid, setFocusGid] = useState<string | null>(null);

  // Bản gốc theo phạm vi, dựng MỘT lần (gid/rid phải ổn định giữa các lượt
  // render, không thì key React đổi liên tục và ô đang gõ mất focus).
  const baseCache = useRef(new Map<string, VRow[]>());
  const baseOf = (sc: string): VRow[] => {
    let b = baseCache.current.get(sc);
    if (!b) { b = rowsOf(sc === GLOBAL ? data.globalVars : data.projectVars?.[sc]); baseCache.current.set(sc, b); }
    return b;
  };
  const rowsAt = (sc: string) => edits[sc] ?? baseOf(sc);
  const picksAt = (sc: string) => pickEdits[sc] ?? data.varPicks?.[sc] ?? {};

  const allProjects = useMemo(
    () => [...new Set([...projects, ...Object.keys(data.projectVars ?? {}), ...extra])].sort((a, b) => a.localeCompare(b)),
    [projects, data.projectVars, extra],
  );

  const rows = rowsAt(scope);
  const picks = picksAt(scope);
  const groups = useMemo(() => groupsOf(rows), [rows]);

  const setRows = (fn: (rows: VRow[]) => VRow[]) => setEdits((e) => ({ ...e, [scope]: fn(e[scope] ?? baseOf(scope)) }));
  const setPicks = (fn: (p: Record<string, string>) => Record<string, string>) =>
    setPickEdits((p) => ({ ...p, [scope]: fn(p[scope] ?? data.varPicks?.[scope] ?? {}) }));

  const countOf = (sc: string) => groupsOf(rowsAt(sc)).filter((g) => g.key.trim()).length;
  const dirty = Object.keys(edits).length > 0 || Object.keys(pickEdits).length > 0;

  // Gợi ý nhãn + tag: gom từ mọi phạm vi (đã lưu + đang sửa) để gõ lại cho đồng nhất.
  const labelList = useMemo(() => varNames([
    data.globalVars, ...Object.values(data.projectVars ?? {}), ...Object.values(edits),
  ]), [data.globalVars, data.projectVars, edits]);
  const tagList = useMemo(() => {
    const s = new Set<string>();
    for (const list of [data.globalVars, ...Object.values(data.projectVars ?? {}), ...Object.values(edits)]) {
      for (const v of list ?? []) for (const t of v.tags ?? []) s.add(t);
    }
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [data.globalVars, data.projectVars, edits]);

  // ── Thao tác theo biến (gid) ───────────────────────────────────────────────
  const patchGroup = (gid: string, patch: Partial<ApiHeader>) =>
    setRows((rs) => rs.map((r) => (r.gid === gid ? { ...r, ...patch } : r)));
  const renameGroup = (g: Group, key: string) => {
    patchGroup(g.gid, { key });
    // Lựa chọn giá trị đi theo tên mới.
    const old = g.key.trim();
    if (old && old in picks) setPicks((p) => { const n = { ...p, [key.trim()]: p[old] }; delete n[old]; return n; });
  };
  const patchRow = (rid: string, patch: Partial<ApiHeader>) =>
    setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));
  const removeGroups = (gids: Set<string>) => {
    setRows((rs) => rs.filter((r) => !gids.has(r.gid)));
    setSelected((s) => new Set([...s].filter((x) => !gids.has(x))));
  };
  const removeRow = (rid: string) => setRows((rs) => rs.filter((r) => r.rid !== rid));
  const addValue = (g: Group) => {
    const used = new Set(g.rows.map((r) => r.name ?? ''));
    // Nhãn gợi ý: nhãn đã dùng ở biến khác mà biến này chưa có, không thì v2, v3…
    const label = labelList.find((l) => !used.has(l)) ?? (() => { let i = g.rows.length + 1; while (used.has(`v${i}`)) i += 1; return `v${i}`; })();
    const last = g.rows[g.rows.length - 1];
    setRows((rs) => {
      const at = rs.findIndex((r) => r.rid === last.rid);
      const row: VRow = { key: g.key, value: '', on: true, name: label, tags: g.tags, gid: g.gid, rid: uid('r') };
      return [...rs.slice(0, at + 1), row, ...rs.slice(at + 1)];
    });
    setOpen((o) => new Set(o).add(g.gid));
  };
  const addVar = (key = '') => {
    const gid = uid('g');
    // Đang lọc theo tag → biến mới mang sẵn tag đó (khỏi mất dấu ngay khi vừa thêm).
    const tags = tagSel.filter((t) => t !== NO_TAG);
    setRows((rs) => [...rs, { key, value: '', on: true, name: '', tags, gid, rid: uid('r') }]);
    setFocusGid(gid);
    return gid;
  };

  // Mở từ chip "chưa khai" / chip biến: nhảy tới đúng biến đó.
  const focusDone = useRef(false);
  useEffect(() => {
    if (focusDone.current || !initialKey) return;
    focusDone.current = true;
    const g = groupsOf(rowsAt(scope)).find((x) => x.key.trim() === initialKey);
    if (g) {
      setOpen((o) => new Set(o).add(g.gid));
      requestAnimationFrame(() => document.getElementById(`var-${g.gid}`)?.scrollIntoView({ block: 'center' }));
    } else {
      addVar(initialKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Lọc + sắp xếp ─────────────────────────────────────────────────────────
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    let none = 0;
    for (const g of groups) {
      if (!g.tags.length) none += 1;
      for (const t of g.tags) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return { list: [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])), none };
  }, [groups]);

  const visible = useMemo(() => {
    const needle = strip(q.trim());
    let out = groups.filter((g) => {
      // Dòng mới chưa đặt tên luôn hiện — vừa bấm thêm mà biến mất thì khó hiểu.
      if (!g.key.trim()) return true;
      if (tagSel.length && !tagSel.some((t) => (t === NO_TAG ? !g.tags.length : g.tags.includes(t)))) return false;
      if (needle) {
        const hay = strip([g.key, ...g.tags, ...g.rows.flatMap((r) => [r.name ?? '', r.value])].join(' '));
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    if (sort === 'az') out = [...out].sort((a, b) => a.key.localeCompare(b.key));
    if (sort === 'tag') {
      out = [...out].sort((a, b) => (a.tags[0] ?? '￿').localeCompare(b.tags[0] ?? '￿') || a.key.localeCompare(b.key));
    }
    return out;
  }, [groups, q, tagSel, sort]);

  const toggleTagSel = (t: string) => setTagSel((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
  const toggleSel = (gid: string) => setSelected((s) => { const n = new Set(s); if (n.has(gid)) n.delete(gid); else n.add(gid); return n; });
  const allVisibleSel = visible.length > 0 && visible.every((g) => selected.has(g.gid));
  const selGroups = groups.filter((g) => selected.has(g.gid));
  const selTags = [...new Set(selGroups.flatMap((g) => g.tags))].sort();

  const bulkAddTag = () => {
    const parts = bulkTag.split(',').map((t) => t.trim()).filter(Boolean);
    if (!parts.length) return;
    setRows((rs) => rs.map((r) => (selected.has(r.gid) ? { ...r, tags: addTags(r.tags ?? [], parts) } : r)));
    setBulkTag('');
  };
  const bulkRemoveTag = (t: string) =>
    setRows((rs) => rs.map((r) => (selected.has(r.gid) ? { ...r, tags: (r.tags ?? []).filter((x) => x !== t) } : r)));
  const bulkOn = (on: boolean) => setRows((rs) => rs.map((r) => (selected.has(r.gid) ? { ...r, on } : r)));

  /** ⇄ Chuyển nhanh (trong hộp): mọi phạm vi, mọi biến có nhãn này — lưu khi bấm Lưu. */
  const quickSwitch = (label: string) => {
    const scopes = [GLOBAL, ...allProjects];
    setPickEdits((pe) => {
      const next = { ...pe };
      for (const sc of scopes) {
        const keys = rowsAt(sc).filter((r) => r.on !== false && (r.name ?? '') === label && r.key.trim()).map((r) => r.key.trim());
        if (!keys.length) continue;
        next[sc] = { ...(pe[sc] ?? data.varPicks?.[sc] ?? {}), ...Object.fromEntries(keys.map((k) => [k, label])) };
      }
      return next;
    });
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      let latest = data;
      for (const sc of new Set([...Object.keys(edits), ...Object.keys(pickEdits)])) {
        const vars = rowsAt(sc).map(({ gid: _g, rid: _r, ...v }) => v);
        const p = picksAt(sc);
        latest = sc === GLOBAL ? await apiSaveGlobals(vars, p) : await apiSaveProjectVars(sc, vars, p);
      }
      onSaved(latest);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addProject = () => {
    const n = newProj.trim();
    if (!n) return;
    setExtra((x) => (x.includes(n) ? x : [...x, n]));
    pickScope(n);
    setNewProj('');
  };
  const pickScope = (sc: string) => { setScope(sc); setSelected(new Set()); setOpen(new Set()); };

  // ── Render một biến ────────────────────────────────────────────────────────
  const renderGroup = (g: Group) => {
    const options = g.rows.filter((r) => r.on !== false).map((r) => ({ label: r.name ?? '', value: r.value }));
    const pick = pickLabel(options, picks[g.key.trim()], data.activeVarName);
    const cur = g.rows.find((r) => (r.name ?? '') === pick && r.on !== false) ?? g.rows[0];
    const multi = g.rows.length > 1;
    const isOpen = open.has(g.gid);
    const dupLabels = new Set(g.rows.map((r) => r.name ?? '')).size < g.rows.length;
    return (
      <div key={g.gid} id={`var-${g.gid}`} className={`vm-var${g.on ? '' : ' off'}${selected.has(g.gid) ? ' sel' : ''}`}>
        <div className="vm-row">
          <input type="checkbox" checked={selected.has(g.gid)} onChange={() => toggleSel(g.gid)} title="Chọn để gán tag / bật tắt / xoá hàng loạt" />
          <button className={`vm-on${g.on ? ' is-on' : ''}`} onClick={() => patchGroup(g.gid, { on: !g.on })}
            title={g.on ? 'Đang bật — bấm để tắt tạm (không thay khi gửi)' : 'Đang tắt — bấm để bật'}>{g.on ? '●' : '○'}</button>
          <input className="input vm-key" placeholder="tên_biến" value={g.key} autoFocus={focusGid === g.gid}
            onChange={(e) => renameGroup(g, e.target.value)} />
          <TagEditor tags={g.tags} listId="vm-tags" onChange={(tags) => patchGroup(g.gid, { tags })} />
          {multi ? (
            <select className="input vm-pick" value={pick}
              title="Giá trị đang dùng của biến này — áp cho mọi request"
              onChange={(e) => {
                if (e.target.value === '\u0000edit') { setOpen((o) => new Set(o).add(g.gid)); return; }
                const v = e.target.value;
                setPicks((p) => ({ ...p, [g.key.trim()]: v }));
              }}>
              {g.rows.filter((r) => r.on !== false).map((r) => (
                <option key={r.rid} value={r.name ?? ''}>{labelText(r.name ?? '')}</option>
              ))}
              <option value={'\u0000edit'}>✎ Sửa các giá trị…</option>
            </select>
          ) : (
            <span className="vm-pick vm-pick-one" title="Biến chỉ có một giá trị">{cur?.name ? cur.name : '—'}</span>
          )}
          <input className="input vm-val" placeholder="giá trị" value={cur?.value ?? ''}
            title={multi ? `Giá trị “${labelText(pick)}” — đang dùng` : undefined}
            onChange={(e) => cur && patchRow(cur.rid, { value: e.target.value })} />
          <button className="ghost sm vm-more" onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(g.gid)) n.delete(g.gid); else n.add(g.gid); return n; })}
            title={multi ? 'Sửa các giá trị' : 'Thêm giá trị khác (dev / stg, user A / user B…)'}>
            {isOpen ? '▾' : '▸'} {multi ? g.rows.length : '＋'}
          </button>
          <button className="ghost sm" onClick={() => removeGroups(new Set([g.gid]))} title="Xoá biến (mọi giá trị)">✕</button>
        </div>
        {isOpen && (
          <div className="vm-values">
            {g.rows.map((r) => (
              <div key={r.rid} className="vm-value">
                <input type="radio" name={`pick-${g.gid}`} checked={r === cur} disabled={r.on === false}
                  onChange={() => setPicks((p) => ({ ...p, [g.key.trim()]: r.name ?? '' }))} title="Dùng giá trị này" />
                <input className="input vm-label" placeholder="nhãn (vd dev, user A)" list="vm-labels" value={r.name ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    // Đổi nhãn của giá trị đang dùng → lựa chọn đi theo.
                    if (r === cur) setPicks((p) => ({ ...p, [g.key.trim()]: v }));
                    patchRow(r.rid, { name: v });
                  }} />
                <input className="input vm-val" placeholder="giá trị" value={r.value} onChange={(e) => patchRow(r.rid, { value: e.target.value })} />
                <button className="ghost sm" onClick={() => patchRow(r.rid, { on: r.on === false })}
                  title={r.on === false ? 'Giá trị đang tắt — bấm để bật' : 'Tắt tạm giá trị này'}>{r.on === false ? '○' : '●'}</button>
                <button className="ghost sm" onClick={() => (g.rows.length > 1 ? removeRow(r.rid) : removeGroups(new Set([g.gid])))} title="Xoá giá trị">✕</button>
              </div>
            ))}
            <div className="vm-values-foot">
              <button className="ghost sm" onClick={() => addValue(g)}>＋ Thêm giá trị</button>
              {dupLabels && <span className="small" style={{ color: 'var(--warn, #d29922)' }}>⚠ Có nhãn trùng nhau — chỉ giá trị đầu tiên của nhãn đó chọn được.</span>}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Gom theo tag: tiêu đề nhóm trước biến đầu tiên của mỗi tag.
  let lastTag: string | null = null;

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mail-compose panel api-vars" style={{ width: 'min(1080px, 96vw)' }}>
        <div className="mail-compose-head">
          <b>🔣 Biến</b><span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <datalist id="vm-tags">{tagList.map((t) => <option key={t} value={t} />)}</datalist>
        <datalist id="vm-labels">{labelList.map((n) => <option key={n} value={n} />)}</datalist>

        <div className="api-vars-body">
          <nav className="api-vars-scopes" aria-label="Phạm vi biến">
            <button className={`api-vars-scope${scope === GLOBAL ? ' on' : ''}`} onClick={() => pickScope(GLOBAL)}>
              <span>🌐 Chung</span><span className="api-proj-n">{countOf(GLOBAL)}</span>
            </button>
            <div className="api-folder" style={{ margin: '8px 4px 2px' }}>Dự án</div>
            {allProjects.map((p) => (
              <button key={p} className={`api-vars-scope${scope === p ? ' on' : ''}`} onClick={() => pickScope(p)}>
                <span>📁 {p}</span><span className="api-proj-n">{countOf(p)}</span>
              </button>
            ))}
            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
              <input className="input sm" placeholder="Dự án mới…" value={newProj}
                onChange={(e) => setNewProj(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addProject()} />
              <button className="ghost sm" onClick={addProject} disabled={!newProj.trim()} title="Thêm dự án">＋</button>
            </div>
          </nav>

          <div className="api-vars-main">
            <p className="small" style={{ color: 'var(--muted)', margin: '0 2px 6px' }}>
              {scope === GLOBAL
                ? 'Biến chung — dùng được ở mọi dự án. Biến của dự án cùng tên sẽ ghi đè.'
                : <>Biến của dự án <b>{scope}</b> — chỉ áp cho request thuộc dự án này, và ghi đè biến chung cùng tên.</>}
              {' '}Mỗi biến tự chọn <b>giá trị đang dùng</b> (áp cho mọi request); bấm ▸ để thêm giá trị khác như dev / stg.
            </p>

            {/* Thanh lọc: tìm + sắp xếp + chuyển nhanh */}
            <div className="vm-toolbar">
              <input className="input sm vm-search" placeholder="🔍 Tìm tên, giá trị, nhãn, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="input sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)} title="Sắp xếp">
                <option value="manual">Thứ tự nhập</option>
                <option value="az">Tên A → Z</option>
                <option value="tag">Gom theo tag</option>
              </select>
              {labelList.length > 0 && (
                <select className="input sm" value="" title="Mọi biến (mọi phạm vi) có giá trị mang nhãn này chuyển sang giá trị đó"
                  onChange={(e) => { if (e.target.value) quickSwitch(e.target.value); }}>
                  <option value="">⇄ Chuyển nhanh →</option>
                  {labelList.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
            </div>
            {(tagCounts.list.length > 0 || tagSel.length > 0) && (
              <div className="vm-tagbar" title="Bấm để lọc — chọn nhiều tag = khớp bất kỳ">
                <button className={`api-tag is-btn vm-all${tagSel.length === 0 ? ' on' : ''}`} onClick={() => setTagSel([])}>
                  Tất cả<span className="api-tag-n">{groups.length}</span>
                </button>
                {tagCounts.list.map(([t, n]) => <TagChip key={t} tag={t} count={n} on={tagSel.includes(t)} onClick={() => toggleTagSel(t)} />)}
                {tagCounts.none > 0 && (
                  <button className={`api-tag is-btn vm-none${tagSel.includes(NO_TAG) ? ' on' : ''}`} onClick={() => toggleTagSel(NO_TAG)}>
                    chưa gắn tag<span className="api-tag-n">{tagCounts.none}</span>
                  </button>
                )}
              </div>
            )}

            {/* Thao tác hàng loạt */}
            {selected.size > 0 && (
              <div className="vm-bulk">
                <b>Đã chọn {selected.size}</b>
                <input className="input sm" placeholder="tag1, tag2" list="vm-tags" value={bulkTag}
                  onChange={(e) => setBulkTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && bulkAddTag()} style={{ width: 140 }} />
                <button className="ghost sm" onClick={bulkAddTag} disabled={!bulkTag.trim()}>🏷 Gán tag</button>
                {selTags.length > 0 && (
                  <select className="input sm" value="" onChange={(e) => e.target.value && bulkRemoveTag(e.target.value)}>
                    <option value="">Gỡ tag…</option>
                    {selTags.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
                <button className="ghost sm" onClick={() => bulkOn(true)}>● Bật</button>
                <button className="ghost sm" onClick={() => bulkOn(false)}>○ Tắt</button>
                <button className="ghost sm danger" onClick={() => removeGroups(new Set(selected))}>✕ Xoá</button>
                <span style={{ flex: 1 }} />
                <button className="ghost sm" onClick={() => setSelected(new Set())}>Bỏ chọn</button>
              </div>
            )}

            <div className="vm-head">
              <input type="checkbox" checked={allVisibleSel} disabled={!visible.length}
                onChange={() => setSelected(allVisibleSel ? new Set() : new Set(visible.map((g) => g.gid)))} title="Chọn tất cả đang hiện" />
              <span />
              <span>Tên biến</span><span>Tags</span><span>Đang dùng</span><span>Giá trị</span><span /><span />
            </div>
            <div className="vm-list">
              {visible.length === 0 && (
                <p className="small" style={{ color: 'var(--muted)', margin: 8 }}>
                  {groups.length ? 'Không có biến nào khớp bộ lọc.' : 'Chưa có biến nào ở phạm vi này.'}
                </p>
              )}
              {visible.map((g) => {
                const head = sort === 'tag' && (g.tags[0] ?? '') !== lastTag
                  ? <div key={`h-${g.gid}`} className="vm-group">{g.tags[0] ? <TagChip tag={g.tags[0]} /> : 'chưa gắn tag'}</div>
                  : null;
                if (sort === 'tag') lastTag = g.tags[0] ?? '';
                return [head, renderGroup(g)];
              })}
            </div>
            <button className="ghost sm" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => addVar()}>＋ Thêm biến</button>
          </div>
        </div>

        <div>
          <button className="ghost sm" onClick={() => setShowDyn((v) => !v)}>{showDyn ? '▾' : '▸'} Biến động có sẵn</button>
          {showDyn && (
            <div className="api-vars-dyn">
              {Object.entries(DYNAMIC_VARS).map(([k, v]) => (
                <button key={k} className="chip-btn" title={`${v.desc} — bấm để chép {{${k}}}`}
                  onClick={() => void navigator.clipboard?.writeText(`{{${k}}}`)}>
                  <code>{`{{${k}}}`}</code> <span className="small" style={{ color: 'var(--muted)' }}>{v.desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: 0 }}>{err}</pre>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => void save()} disabled={busy || !dirty}>{busy ? '…' : '💾 Lưu'}</button>
          <button className="ghost" onClick={onClose}>{dirty ? 'Hủy' : 'Đóng'}</button>
        </div>
      </div>
    </div>
  );
}
