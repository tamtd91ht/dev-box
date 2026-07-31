'use client';

// The ONE write this tool offers for PostgreSQL: UPDATE-with-WHERE. Mirrors
// the Mongo UpdateModal workflow:
//   1. schema.table is fixed (opened from the browser's selected table),
//   2. SET rows — column + value, values parameterized server-side,
//   3. WHERE text (MANDATORY — server refuses empty; ';' rejected),
//   4. DRY-RUN count — see how many rows the WHERE matches,
//   5. typed confirm (retype schema.table) before the button arms.
// Server independently enforces PG_ALLOW_WRITE + per-connection readOnly.

import { useState } from 'react';
import { pgCountWhere, pgUpdate, fmtCount, type PgUpdateSet } from '@/lib/pg';
import { PG_QUICK_FIELD_TYPES } from '@/lib/pgQuickFinds';

export interface UpdateModalProps {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
  /** Column-name suggestions for the SET rows. */
  columnSuggestions: string[];
  onClose: () => void;
  onDone: (updated: number) => void;
}

interface SetDraft extends PgUpdateSet { key: number; }

export default function UpdateModal({ connectionId, db, schema, table, columnSuggestions, onClose, onDone }: UpdateModalProps) {
  const [set, setSet] = useState<SetDraft[]>([{ key: 0, column: '', type: 'text', value: '' }]);
  const [where, setWhere] = useState('');
  const [matched, setMatched] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ns = `${schema}.${table}`;
  const whereEmpty = !where.trim();
  const validSet = set.filter((s) => s.column.trim() && (s.type === 'null' || s.value.trim() !== ''));
  const canRun = !busy && !whereEmpty && validSet.length > 0 && typed === ns;

  const patch = (key: number, p: Partial<SetDraft>) =>
    setSet((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));

  const dryRun = async () => {
    setBusy(true); setError(null); setMatched(null);
    try {
      const r = await pgCountWhere(connectionId, db, schema, table, where);
      setMatched(r.count);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await pgUpdate(connectionId, db, {
        schema, table,
        set: validSet.map(({ column, type, value }) => ({ column: column.trim(), type, value })),
        where,
      });
      onDone(r.updated);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(680px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>✎ UPDATE — {db}.{ns}</h3>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <div className="pg-danger">
          ⚠ UPDATE chạy thẳng trên server. WHERE bắt buộc phải có (update không WHERE bị server từ chối);
          giá trị SET đi bằng bind parameter, không nối chuỗi. Chỉ 1 câu lệnh — không cho phép “;”.
        </div>

        <div className="pg-field" style={{ marginBottom: 4 }}>
          <span>SET (cột · kiểu · giá trị)</span>
          {set.map((s) => (
            <div key={s.key} className="pg-form-row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
              <input className="input mono" style={{ flex: 1 }} value={s.column} list="pg-update-cols"
                placeholder="cột (vd. status)" onChange={(e) => patch(s.key, { column: e.target.value })} />
              <select className="input" style={{ flex: '0 0 110px' }} value={s.type}
                onChange={(e) => patch(s.key, { type: e.target.value as SetDraft['type'] })}>
                {PG_QUICK_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                <option value="null">NULL</option>
              </select>
              {s.type === 'boolean' ? (
                <select className="input" style={{ flex: 1 }} value={s.value}
                  onChange={(e) => patch(s.key, { value: e.target.value })}>
                  <option value="">— chọn —</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input className="input mono" style={{ flex: 1 }} value={s.value} disabled={s.type === 'null'}
                  placeholder={s.type === 'null' ? 'NULL' : s.type === 'number' ? 'số' : 'giá trị'}
                  onChange={(e) => patch(s.key, { value: e.target.value })} />
              )}
              <button className="chip-btn" title="Bỏ dòng" disabled={set.length <= 1}
                onClick={() => setSet((cs) => cs.filter((x) => x.key !== s.key))}>✕</button>
            </div>
          ))}
          <datalist id="pg-update-cols">{columnSuggestions.map((c) => <option key={c} value={c} />)}</datalist>
          <div>
            <button className="ghost sm" onClick={() => setSet((cs) => [...cs, { key: Math.max(0, ...cs.map((c) => c.key)) + 1, column: '', type: 'text', value: '' }])}>
              + Thêm cột SET
            </button>
          </div>
        </div>

        <label className="pg-field"><span>WHERE (bắt buộc — SQL condition, không gồm chữ WHERE)</span>
          <textarea
            className="input mono"
            rows={2}
            value={where}
            onChange={(e) => { setWhere(e.target.value); setMatched(null); }}
            placeholder="tenant_id = 't_123' AND status = 'PENDING'"
          />
        </label>
        {whereEmpty && <div className="badge" style={{ color: 'var(--err)' }}>WHERE trống — bắt buộc nhập điều kiện trước khi update.</div>}

        <div className="status-line" style={{ gap: 12 }}>
          <button className="ghost sm" disabled={busy || whereEmpty} onClick={() => void dryRun()}>
            {busy ? <span className="spinner" aria-hidden /> : '≈'} Dry-run count
          </button>
          {matched !== null && (
            <span className="badge">khớp {fmtCount(matched)} dòng</span>
          )}
        </div>

        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

        <div className="small" style={{ color: 'var(--muted)', margin: '8px 0 4px' }}>
          Gõ lại <code>{ns}</code> để xác nhận:
        </div>
        <input
          className="input mono"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canRun && void run()}
          placeholder={ns}
          autoFocus
          style={{ width: '100%', fontSize: 12, marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="ghost sm" onClick={onClose} disabled={busy}>Huỷ</button>
          <button
            className="sm"
            onClick={() => void run()}
            disabled={!canRun}
            style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
            title={canRun ? 'Chạy UPDATE' : 'Cần SET + WHERE + gõ đúng schema.table'}
          >
            {busy ? <span className="spinner" aria-hidden /> : '⚠'} Chạy UPDATE
          </button>
        </div>
      </div>
    </div>
  );
}
