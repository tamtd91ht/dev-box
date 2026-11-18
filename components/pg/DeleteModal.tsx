'use client';

// DELETE-with-WHERE cho PostgreSQL — cùng quy trình với UpdateModal:
//   1. schema.table cố định (bảng đang chọn ở trình duyệt dữ liệu),
//   2. WHERE (BẮT BUỘC — server từ chối WHERE rỗng; cấm ';'),
//   3. DRY-RUN count bắt buộc trước khi nút xoá mở khoá; số đếm được gửi kèm,
//      lúc xoá mà khớp số khác (dữ liệu vừa đổi) thì server ROLLBACK,
//   4. gõ lại schema.table để xác nhận.
// Server tự chặn độc lập theo PG_ALLOW_WRITE + readOnly của connection.

import { useState } from 'react';
import { pgCountWhere, pgDelete, fmtCount } from '@/lib/pg';

export interface DeleteModalProps {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
  onClose: () => void;
  onDone: (deleted: number) => void;
}

export default function DeleteModal({ connectionId, db, schema, table, onClose, onDone }: DeleteModalProps) {
  const [where, setWhere] = useState('');
  const [matched, setMatched] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ns = `${schema}.${table}`;
  const whereEmpty = !where.trim();
  const canRun = !busy && !whereEmpty && matched !== null && matched > 0 && typed === ns;

  const dryRun = async () => {
    setBusy(true); setError(null); setMatched(null);
    try {
      const r = await pgCountWhere(connectionId, db, schema, table, where);
      setMatched(r.count);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const run = async () => {
    if (matched === null) return;
    setBusy(true); setError(null);
    try {
      const r = await pgDelete(connectionId, db, { schema, table, where, expected: matched });
      onDone(r.deleted);
    } catch (e) { setError((e as Error).message); setMatched(null); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(680px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>🗑 DELETE — {db}.{ns}</h3>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <div className="pg-danger">
          ⚠ DELETE chạy thẳng trên server và không hoàn tác được. WHERE bắt buộc (xoá cả bảng bị server từ chối);
          chỉ 1 câu lệnh — không cho phép “;”. Phải dry-run trước; nếu lúc xoá số dòng khớp khác số đã đếm thì server ROLLBACK.
        </div>

        <label className="pg-field"><span>WHERE (bắt buộc — SQL condition, không gồm chữ WHERE)</span>
          <textarea
            className="input mono"
            rows={3}
            value={where}
            onChange={(e) => { setWhere(e.target.value); setMatched(null); }}
            placeholder="id = 123  hoặc  tenant_id = 't_123' AND created_at < now() - interval '30 days'"
            autoFocus
          />
        </label>
        {whereEmpty && <div className="badge" style={{ color: 'var(--err)' }}>WHERE trống — bắt buộc nhập điều kiện trước khi xoá.</div>}

        <div className="status-line" style={{ gap: 12 }}>
          <button className="ghost sm" disabled={busy || whereEmpty} onClick={() => void dryRun()}>
            {busy ? <span className="spinner" aria-hidden /> : '≈'} Dry-run count
          </button>
          {matched !== null && (
            <span className="badge" style={matched > 0 ? { color: 'var(--err)' } : undefined}>
              {matched > 0 ? `sẽ xoá ${fmtCount(matched)} dòng` : 'không khớp dòng nào'}
            </span>
          )}
          {matched === null && !whereEmpty && <span className="xhint">Dry-run để mở khoá nút xoá.</span>}
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
          style={{ width: '100%', fontSize: 12, marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="ghost sm" onClick={onClose} disabled={busy}>Huỷ</button>
          <button
            className="sm"
            onClick={() => void run()}
            disabled={!canRun}
            style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
            title={canRun ? `Xoá ${matched} dòng` : 'Cần WHERE + dry-run (khớp > 0 dòng) + gõ đúng schema.table'}
          >
            {busy ? <span className="spinner" aria-hidden /> : '🗑'} Xoá{matched ? ` ${fmtCount(matched)} dòng` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
