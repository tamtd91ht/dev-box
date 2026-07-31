'use client';

// The ONE write this tool offers: update-with-query. The modal enforces the
// workflow a careful operator would follow by hand:
//   1. filter (NON-EMPTY — server refuses a blind collection-wide update),
//   2. $-operator update doc (server refuses whole-document replaces),
//   3. DRY-RUN count — see how many documents the filter matches,
//   4. typed confirm (retype db.collection) before the button arms.
// This is the client-side guard only; the server independently enforces
// MONGO_ALLOW_WRITE + per-connection readOnly + filter/update validation, so
// bypassing this modal still gets a 403 (same layering as rabbit/DangerModal).

import { useState } from 'react';
import { countMongo, updateMongo, fmtCount, type UpdateResult } from '@/lib/mongo';

export interface UpdateModalProps {
  connectionId: string;
  db: string;
  coll: string;
  /** Prefilled from the query bar's current filter. */
  initialFilter: string;
  onClose: () => void;
  onDone: (r: UpdateResult) => void;
}

export default function UpdateModal({ connectionId, db, coll, initialFilter, onClose, onDone }: UpdateModalProps) {
  const [filter, setFilter] = useState(initialFilter);
  const [update, setUpdate] = useState('');
  const [mode, setMode] = useState<'one' | 'many'>('one');
  const [matched, setMatched] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ns = `${db}.${coll}`;
  const filterEmpty = !filter.trim() || filter.trim() === '{}';
  const canRun = !busy && !filterEmpty && !!update.trim() && typed === ns;

  const dryRun = async () => {
    setBusy(true); setError(null); setMatched(null);
    try {
      const r = await countMongo(connectionId, db, coll, filter);
      setMatched(r.count);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await updateMongo(connectionId, db, coll, { filter, update, mode });
      onDone(r);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>✎ Update — {ns}</h3>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <div className="mongo-danger">
          ⚠ Update chạy thẳng trên cluster. Filter bắt buộc phải có (update không query bị server từ chối);
          update chỉ nhận toán tử $ ($set, $inc, …) — không thay thế cả document, không upsert.
        </div>

        <label className="mongo-field"><span>Filter (bắt buộc, không được {'{}'})</span>
          <textarea
            className="input mono"
            rows={3}
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setMatched(null); }}
            placeholder='{"_id": {"$oid": "665f1c…"}}'
          />
        </label>
        {filterEmpty && <div className="badge" style={{ color: 'var(--err)' }}>Filter trống — bắt buộc nhập query trước khi update.</div>}

        <label className="mongo-field"><span>Update document ($-operators)</span>
          <textarea
            className="input mono"
            rows={3}
            value={update}
            onChange={(e) => setUpdate(e.target.value)}
            placeholder='{"$set": {"status": "INACTIVE"}}'
          />
        </label>

        <div className="status-line" style={{ gap: 12 }}>
          <label className="mongo-check">
            <input type="radio" name="mongo-upd-mode" checked={mode === 'one'} onChange={() => setMode('one')} /> updateOne
          </label>
          <label className="mongo-check">
            <input type="radio" name="mongo-upd-mode" checked={mode === 'many'} onChange={() => setMode('many')} /> updateMany
          </label>
          <button className="ghost sm" disabled={busy || filterEmpty} onClick={() => void dryRun()}>
            {busy ? <span className="spinner" aria-hidden /> : '≈'} Dry-run count
          </button>
          {matched !== null && (
            <span className="badge" style={{ color: mode === 'one' && matched > 1 ? 'var(--warn, var(--muted))' : undefined }}>
              khớp {fmtCount(matched)} document{matched === 1 ? '' : 's'}
              {mode === 'one' && matched > 1 ? ' — updateOne chỉ sửa 1' : ''}
            </span>
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
            title={canRun ? `Chạy update${mode === 'many' ? 'Many' : 'One'}` : 'Cần filter + update doc + gõ đúng namespace'}
          >
            {busy ? <span className="spinner" aria-hidden /> : '⚠'} Chạy update{mode === 'many' ? 'Many' : 'One'}
          </button>
        </div>
      </div>
    </div>
  );
}
