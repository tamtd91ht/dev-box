'use client';

// Quản lý biến {{tên}} của tab API: một danh sách CHUNG + một danh sách riêng cho
// từng DỰ ÁN. Biến của dự án ghi đè biến chung cùng tên; request thuộc dự án nào
// (`folder`) thì dùng biến dự án đó. Biến động ({{$guid}}, {{$timestamp}}…) có
// sẵn, không cần khai.

import { useMemo, useState } from 'react';
import { apiSaveGlobals, apiSaveProjectVars, type ApiData, type ApiHeader } from '@/lib/api';
import { DYNAMIC_VARS } from '@/lib/apiVars';
import KvTable from './KvTable';

/** Khoá phạm vi: '' = biến chung. */
const GLOBAL = '';

const rowsOf = (vars: ApiData['globalVars']): ApiHeader[] =>
  (vars ?? []).map((v) => ({ key: v.key, value: v.value, on: v.on !== false }));

export default function VarsModal({
  data, projects, initialScope, onSaved, onClose,
}: {
  data: ApiData;
  /** Các dự án đã có (từ request đã lưu). */
  projects: string[];
  /** Phạm vi mở sẵn: '' = chung, hoặc tên dự án. */
  initialScope: string;
  onSaved: (d: ApiData) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState(initialScope);
  // Bản đang sửa của từng phạm vi — chỉ phạm vi nào CÓ trong đây mới bị ghi lúc Lưu.
  const [edits, setEdits] = useState<Record<string, ApiHeader[]>>({});
  const [extra, setExtra] = useState<string[]>(initialScope && !projects.includes(initialScope) ? [initialScope] : []);
  const [newProj, setNewProj] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showDyn, setShowDyn] = useState(false);

  const allProjects = useMemo(
    () => [...new Set([...projects, ...Object.keys(data.projectVars ?? {}), ...extra])].sort((a, b) => a.localeCompare(b)),
    [projects, data.projectVars, extra],
  );

  const current = edits[scope] ?? rowsOf(scope === GLOBAL ? data.globalVars : data.projectVars?.[scope]);
  const setCurrent = (rows: ApiHeader[]) => setEdits((e) => ({ ...e, [scope]: rows }));
  const countOf = (sc: string) => {
    const rows = edits[sc] ?? rowsOf(sc === GLOBAL ? data.globalVars : data.projectVars?.[sc]);
    return rows.filter((r) => r.key.trim()).length;
  };
  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      let latest = data;
      for (const [sc, rows] of Object.entries(edits)) {
        latest = sc === GLOBAL ? await apiSaveGlobals(rows) : await apiSaveProjectVars(sc, rows);
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
    setScope(n);
    setNewProj('');
  };

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mail-compose panel api-vars" style={{ width: 'min(720px, 94vw)' }}>
        <div className="mail-compose-head">
          <b>🔣 Biến</b><span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <div className="api-vars-body">
          <nav className="api-vars-scopes" aria-label="Phạm vi biến">
            <button className={`api-vars-scope${scope === GLOBAL ? ' on' : ''}`} onClick={() => setScope(GLOBAL)}>
              <span>🌐 Chung</span><span className="api-proj-n">{countOf(GLOBAL)}</span>
            </button>
            <div className="api-folder" style={{ margin: '8px 4px 2px' }}>Dự án</div>
            {allProjects.map((p) => (
              <button key={p} className={`api-vars-scope${scope === p ? ' on' : ''}`} onClick={() => setScope(p)}>
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
              {' '}Dùng bằng <code>{'{{tên}}'}</code> trong URL, header, body, auth.
            </p>
            <KvTable rows={current} onChange={setCurrent} keyPlaceholder="Tên biến" valuePlaceholder="Giá trị" addLabel="＋ Thêm biến" />
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
