'use client';

// Publish one message. Deliberately NOT behind the write gate: sending a test
// message is how you verify a route, and it was already allowed before this
// refactor. It is still audit-logged server-side.

import { useState } from 'react';

export interface PublishModalProps {
  target: { kind: 'queue' | 'exchange'; vhost: string; name: string };
  onClose: () => void;
  onSent: (routed: boolean) => void;
  onPublish: (p: {
    vhost: string;
    exchange: string;
    routingKey: string;
    payload: string;
    contentType?: string;
  }) => Promise<{ routed: boolean }>;
}

export default function PublishModal({ target, onClose, onSent, onPublish }: PublishModalProps) {
  // Publishing to a QUEUE goes through the default exchange ("") with the queue
  // name as routing key. Publishing to an EXCHANGE uses that exchange + a key.
  const toQueue = target.kind === 'queue';
  const [routingKey, setRoutingKey] = useState(toQueue ? target.name : '');
  const [payload, setPayload] = useState('');
  const [contentType, setContentType] = useState('application/json');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h3>Publish → <span className="code">{toQueue ? target.name : (target.name || '(default exchange)')}</span></h3>
        <p className="rabbit-hint">
          {toQueue
            ? 'Gửi qua default exchange, routing key = tên queue.'
            : 'Gửi tới exchange này với routing key bên dưới. Nếu không khớp binding nào, message sẽ bị drop (unroutable).'}
        </p>
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <label className="rabbit-field">
          <span>Routing key</span>
          <input className="input" value={routingKey} onChange={(e) => setRoutingKey(e.target.value)} disabled={toQueue} />
        </label>
        <label className="rabbit-field">
          <span>Content type</span>
          <input className="input" value={contentType} onChange={(e) => setContentType(e.target.value)} placeholder="application/json" />
        </label>
        <label className="rabbit-field">
          <span>Payload</span>
          <textarea className="input" rows={6} value={payload} onChange={(e) => setPayload(e.target.value)} />
        </label>
        <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button className="ghost sm" onClick={onClose}>Huỷ</button>
          <button
            className="sm"
            disabled={busy || !payload || (!toQueue && !routingKey)}
            onClick={async () => {
              setBusy(true); setErr(null);
              try {
                const r = await onPublish({
                  vhost: target.vhost,
                  exchange: toQueue ? '' : target.name,
                  routingKey,
                  payload,
                  contentType: contentType.trim() || undefined,
                });
                onSent(r.routed);
              } catch (e) { setErr((e as Error).message); }
              finally { setBusy(false); }
            }}
          >{busy ? 'Đang gửi…' : 'Gửi'}</button>
        </div>
      </div>
    </div>
  );
}
