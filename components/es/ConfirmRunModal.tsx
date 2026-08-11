'use client';

// Chốt xác nhận trước khi Console chạy một lệnh ghi.
//
// HAI mức, theo phân loại của lib/esConsole.ts:
//   · 'write'       — xem lại lệnh rồi bấm Chạy. Đủ để không PUT nhầm mapping vì
//                     con trỏ đứng sai khối lệnh.
//   · 'destructive' — phải GÕ LẠI tên index/endpoint, giống DangerModal của tab
//                     RabbitMQ và DeleteModal của Redis, để thói quen dùng chung.
//
// Đây là lớp chặn phía client. Server chấm lại độc lập (`vetConsoleCommand` đòi
// `confirmed: true` cho lệnh destructive), nên bỏ qua modal này bằng cách gọi
// API tay thì lệnh xoá vẫn bị từ chối.

import { useState } from 'react';
import type { EsConsoleRisk } from '@/lib/esConsole';

export interface ConfirmRunModalProps {
  risk: Exclude<EsConsoleRisk, 'read'>;
  method: string;
  path: string;
  body: string;
  /** Chuỗi phải gõ lại — chỉ dùng ở mức 'destructive'. */
  target: string;
  /** Cluster đang nhắm tới, hiện to để không chạy nhầm môi trường. */
  clusterName: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const BODY_PREVIEW_MAX = 1200;

export default function ConfirmRunModal({
  risk, method, path, body, target, clusterName, busy, onCancel, onConfirm,
}: ConfirmRunModalProps) {
  const [typed, setTyped] = useState('');
  const needsTyping = risk === 'destructive';
  const canRun = (!needsTyping || typed === target) && !busy;

  const preview = body.length > BODY_PREVIEW_MAX
    ? `${body.slice(0, BODY_PREVIEW_MAX)}\n… (còn ${body.length - BODY_PREVIEW_MAX} ký tự)`
    : body;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(620px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>
            {needsTyping ? 'Xác nhận lệnh xoá / đổi trạng thái' : 'Xác nhận lệnh ghi'}
          </h3>
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>

        <div className={needsTyping ? 'rabbit-danger' : 'es-con-warnbox'}>
          {needsTyping
            ? '⚠ Lệnh này xoá dữ liệu hoặc đổi trạng thái index — không lùi lại được.'
            : '⚠ Lệnh này ghi vào cluster (tạo/sửa). Xem lại trước khi chạy.'}
        </div>

        <div className="es-con-cfm-grid">
          <span className="small" style={{ color: 'var(--muted)' }}>Cluster</span>
          <strong>{clusterName}</strong>
          <span className="small" style={{ color: 'var(--muted)' }}>Lệnh</span>
          <code className="es-con-cfm-cmd">
            <span className={`es-con-rk ${risk}`}>{method}</span> {path}
          </code>
        </div>

        {preview && (
          <pre className="code es-con-cfm-body">{preview}</pre>
        )}

        {needsTyping && (
          <>
            <div className="small" style={{ color: 'var(--muted)', margin: '10px 0 6px' }}>
              Gõ lại đúng chuỗi này để xác nhận:
            </div>
            <code className="small" style={{ display: 'block', marginBottom: 8, wordBreak: 'break-all' }}>{target}</code>
            <input
              className="input"
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canRun && onConfirm()}
              placeholder="gõ lại để mở nút chạy"
              autoFocus
              style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }}
            />
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="ghost sm" onClick={onCancel} disabled={busy}>Huỷ</button>
          <button
            className="sm"
            onClick={onConfirm}
            disabled={!canRun}
            autoFocus={!needsTyping}
            style={needsTyping ? { color: 'var(--err)', borderColor: 'var(--err)' } : undefined}
            title={canRun ? `Chạy ${method} ${path}` : 'Gõ đúng chuỗi xác nhận để bật nút này'}
          >
            {busy ? <span className="spinner" aria-hidden /> : needsTyping ? '⚠' : '▶'} Chạy lệnh
          </button>
        </div>
      </div>
    </div>
  );
}
