'use client';

// "Quản lý theo routing key" — one flat table of EVERY binding in scope, filtered
// by source / destination / routing key, plus inline create and delete, and the
// route tester underneath.
//
// Per-queue and per-exchange panes only ever show one side of a binding. This is
// the view that answers "which routing keys exist at all", "is anything bound to
// this key twice", and "did someone bind to the wrong queue".

import { useMemo, useState } from 'react';
import {
  vhostLabel,
  type BindingDeclarationInput,
  type BindingInfo,
  type ExchangeSummary,
  type QueueSummary,
} from '@/lib/rabbit';
import DangerModal from './DangerModal';
import RouteTester from './RouteTester';
import { LockNotice } from './shared';

export interface BindingsViewProps {
  bindings: BindingInfo[];
  exchanges: ExchangeSummary[];
  queues: QueueSummary[];
  loading: boolean;
  readOnly: boolean;
  vhostScope: string;
  onCreate: (d: BindingDeclarationInput) => Promise<void>;
  onDelete: (b: BindingInfo) => Promise<void>;
  onOpenQueue?: (name: string) => void;
}

export default function BindingsView({
  bindings,
  exchanges,
  queues,
  loading,
  readOnly,
  vhostScope,
  onCreate,
  onDelete,
  onOpenQueue,
}: BindingsViewProps) {
  const [filter, setFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<BindingInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const queueNames = useMemo(() => queues.map((q) => q.name), [queues]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f
      ? bindings.filter(
          (b) =>
            b.source.toLowerCase().includes(f) ||
            b.destination.toLowerCase().includes(f) ||
            b.routingKey.toLowerCase().includes(f),
        )
      : bindings;
    return [...list].sort(
      (a, b) => a.source.localeCompare(b.source) || a.routingKey.localeCompare(b.routingKey) || a.destination.localeCompare(b.destination),
    );
  }, [bindings, filter]);

  return (
    <div className="rabbit-bindings">
      <LockNotice readOnly={readOnly} />

      <div className="rabbit-toolbar">
        <input
          className="input"
          placeholder="Lọc theo exchange / routing key / đích…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="chip-btn" disabled={readOnly} onClick={() => setShowCreate((v) => !v)} title={readOnly ? 'Broker read-only' : 'Tạo binding mới'}>
          {showCreate ? '✕ Đóng' : '+ Bind'}
        </button>
      </div>

      {showCreate && (
        <BindForm
          exchanges={exchanges}
          queues={queues}
          vhostScope={vhostScope}
          onCancel={() => setShowCreate(false)}
          onSubmit={async (d) => { await onCreate(d); setShowCreate(false); }}
        />
      )}

      <div className="rabbit-meta">
        {loading ? <span className="spinner" /> : `${filtered.length}/${bindings.length} binding`}
      </div>

      <div className="rabbit-scroll">
        <table className="rabbit-table">
          <thead>
            <tr><th>Exchange (nguồn)</th><th>Routing key</th><th>Đích</th><th>Loại</th><th>vhost</th><th /></tr>
          </thead>
          <tbody>
            {filtered.map((b) => (
              <tr key={`${b.source}|${b.destinationType}|${b.destination}|${b.propertiesKey}`} className="rabbit-binding-row">
                <td style={{ textAlign: 'left' }}>{b.source || '(default)'}</td>
                <td style={{ textAlign: 'left' }}><code className="small">{b.routingKey || '—'}</code></td>
                <td style={{ textAlign: 'left' }}>
                  {onOpenQueue && b.destinationType === 'queue' ? (
                    <button className="rabbit-link" onClick={() => onOpenQueue(b.destination)}>{b.destination} ↗</button>
                  ) : (
                    b.destination
                  )}
                </td>
                <td>{b.destinationType}</td>
                <td>{vhostLabel(vhostScope)}</td>
                <td>
                  <button
                    className="chip-btn"
                    // The default exchange's implicit bindings have no properties_key
                    // and cannot be deleted — the broker owns them.
                    disabled={readOnly || !b.source || !b.propertiesKey}
                    title={!b.source ? 'Binding ngầm của default exchange — không xoá được' : readOnly ? 'Broker read-only' : 'Xoá binding'}
                    onClick={() => setPendingDelete(b)}
                  >🗑</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 && <p className="empty">Không có binding khớp.</p>}
      </div>

      <div className="rabbit-meta">Route tester</div>
      <RouteTester bindings={bindings} exchanges={exchanges} queueNames={queueNames} onOpenQueue={onOpenQueue} />

      {pendingDelete && (
        <DangerModal
          title="Xoá binding?"
          confirmName={pendingDelete.destination}
          warning="Xoá binding sẽ khiến message publish với routing key này KHÔNG còn tới queue đó nữa. Producer không nhận lỗi — message chỉ im lặng bị drop."
          details={[
            { label: 'Exchange', value: pendingDelete.source || '(default)' },
            { label: 'Routing key', value: pendingDelete.routingKey || '(rỗng)' },
            { label: 'Đích', value: `${pendingDelete.destination} (${pendingDelete.destinationType})` },
          ]}
          actionLabel="Xoá binding"
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            setBusy(true);
            try { await onDelete(pendingDelete); setPendingDelete(null); }
            finally { setBusy(false); }
          }}
        />
      )}
    </div>
  );
}

/** Inline binding form — datalist so you can pick an existing name or type a new one. */
function BindForm({
  exchanges,
  queues,
  vhostScope,
  onCancel,
  onSubmit,
}: {
  exchanges: ExchangeSummary[];
  queues: QueueSummary[];
  vhostScope: string;
  onCancel: () => void;
  onSubmit: (d: BindingDeclarationInput) => Promise<void>;
}) {
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [destinationType, setDestinationType] = useState<'queue' | 'exchange'>('queue');
  const [routingKey, setRoutingKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const srcType = exchanges.find((x) => x.name === source)?.type;
  // fanout ignores the routing key entirely, so requiring one would be noise.
  const keyRequired = srcType !== 'fanout';

  return (
    <div className="rabbit-form">
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
      <div className="rabbit-form-row">
        <label className="rabbit-field" style={{ flex: 1 }}>
          <span>Exchange nguồn</span>
          <input className="input" list="rabbit-ex-list" value={source} onChange={(e) => setSource(e.target.value)} placeholder="app.events" />
          <datalist id="rabbit-ex-list">
            {exchanges.filter((x) => x.name).map((x) => <option key={x.name} value={x.name}>{x.type}</option>)}
          </datalist>
        </label>
        <label className="rabbit-field" style={{ width: 130 }}>
          <span>Loại đích</span>
          <select className="input" value={destinationType} onChange={(e) => setDestinationType(e.target.value as 'queue' | 'exchange')}>
            <option value="queue">queue</option>
            <option value="exchange">exchange</option>
          </select>
        </label>
        <label className="rabbit-field" style={{ flex: 1 }}>
          <span>Đích</span>
          <input
            className="input"
            list={destinationType === 'queue' ? 'rabbit-q-list' : 'rabbit-ex-list'}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder={destinationType === 'queue' ? 'app.order.created' : 'app.events.internal'}
          />
          <datalist id="rabbit-q-list">
            {queues.map((q) => <option key={`${q.vhost}/${q.name}`} value={q.name} />)}
          </datalist>
        </label>
        <label className="rabbit-field" style={{ flex: 1 }}>
          <span>Routing key {keyRequired ? '' : '(fanout — bỏ qua)'}</span>
          <input className="input" value={routingKey} onChange={(e) => setRoutingKey(e.target.value)} disabled={!keyRequired} placeholder="order.created" />
        </label>
      </div>
      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={busy || !source.trim() || !destination.trim() || (keyRequired && !routingKey.trim())}
          onClick={async () => {
            setBusy(true); setErr(null);
            try {
              await onSubmit({
                vhost: vhostScope || '/',
                source: source.trim(),
                destination: destination.trim(),
                destinationType,
                routingKey: keyRequired ? routingKey : '',
                arguments: {},
              });
            } catch (e) { setErr((e as Error).message); }
            finally { setBusy(false); }
          }}
        >{busy ? 'Đang bind…' : 'Bind'}</button>
      </div>
    </div>
  );
}
