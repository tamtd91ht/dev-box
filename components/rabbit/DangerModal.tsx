'use client';

// Typed-confirm modal for every mutating RabbitMQ op. Mirrors the DeleteModal in
// components/RedisWorkspace.tsx (canDelete = typed === name) so both ops tools
// gate destructive actions the same way and muscle memory carries over.
//
// This is the THIRD guard layer and the only client-side one. The server enforces
// RABBIT_ALLOW_DESTRUCTIVE + the per-connection readOnly flag independently; a
// user who bypasses this modal still gets a 403.

import { useState } from 'react';

export interface DangerModalProps {
  title: string;
  /** Exact string the operator must retype — always the resource's own name. */
  confirmName: string;
  /** Loud, specific consequence. Include the message count for purge/delete. */
  warning: string;
  /** Extra context lines (vhost, bindings that will die with the resource, …). */
  details?: { label: string; value: string }[];
  actionLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function DangerModal({
  title,
  confirmName,
  warning,
  details,
  actionLabel,
  busy,
  onCancel,
  onConfirm,
}: DangerModalProps) {
  const [typed, setTyped] = useState('');
  const canRun = typed === confirmName && !busy;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 92vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{title}</h3>
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>

        <div className="rabbit-danger">⚠ {warning}</div>

        {details && details.length > 0 && (
          <table className="rabbit-table" style={{ marginBottom: 10 }}>
            <tbody>
              {details.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td style={{ textAlign: 'left' }}>{d.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="small" style={{ color: 'var(--muted)', marginBottom: 8 }}>
          Gõ lại đúng tên để xác nhận:
        </div>
        <code className="small" style={{ display: 'block', marginBottom: 8, wordBreak: 'break-all' }}>{confirmName}</code>
        <input
          className="input"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canRun && onConfirm()}
          placeholder="gõ lại tên"
          autoFocus
          style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="ghost sm" onClick={onCancel} disabled={busy}>Huỷ</button>
          <button
            className="sm"
            onClick={onConfirm}
            disabled={!canRun}
            style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
            title={canRun ? actionLabel : 'Gõ đúng tên để bật nút này'}
          >
            {busy ? <span className="spinner" aria-hidden /> : '⚠'} {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
