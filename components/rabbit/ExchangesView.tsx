'use client';

// Per-exchange management: what it routes to, whether its config matches what the
// service expects, publish/create/delete.
//
// The "Kiểm tra cấu hình" button is the honest answer to "update được không":
// RabbitMQ cannot alter an existing exchange, so instead of a fake Save we DIFF
// the desired declaration against the broker and, on a mismatch, say plainly that
// the only path is delete + recreate.

import { useState } from 'react';
import {
  vhostLabel,
  type DeclarationDiff,
  type ExchangeDeclarationInput,
  type ExchangeDetail,
  type ExchangeSummary,
} from '@/lib/rabbit';
import DangerModal from './DangerModal';
import { ArgsTable, FocusPane, LockNotice } from './shared';

const TYPES = ['direct', 'topic', 'fanout', 'headers'] as const;

export interface ExchangesViewProps {
  exchanges: ExchangeSummary[];
  loading: boolean;
  selected: { vhost: string; name: string } | null;
  detail: ExchangeDetail | null;
  detailLoading: boolean;
  readOnly: boolean;
  vhostScope: string;
  onSelect: (vhost: string, name: string) => void;
  /** Clear the selection — returns the pane to the full-width list. */
  onClearSelect: () => void;
  onPublish: (vhost: string, name: string) => void;
  onCreate: (d: ExchangeDeclarationInput) => Promise<void>;
  onDelete: (vhost: string, name: string, opts: { ifUnused: boolean }) => Promise<void>;
  onDiff: (d: ExchangeDeclarationInput) => Promise<DeclarationDiff>;
  onOpenQueue: (name: string) => void;
}

export default function ExchangesView(props: ExchangesViewProps) {
  const {
    exchanges, loading, selected, detail, detailLoading, readOnly, vhostScope,
    onSelect, onClearSelect, onPublish, onCreate, onDelete, onDiff, onOpenQueue,
  } = props;

  const [filter, setFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ifUnused, setIfUnused] = useState(true);

  const f = filter.trim().toLowerCase();
  const filtered = f
    ? exchanges.filter((x) => x.name.toLowerCase().includes(f) || x.type.toLowerCase().includes(f))
    : exchanges;

  // Built into the focus header, so they stay reachable while the list is hidden.
  const focusActions = detail ? (
    <>
      <button className="chip-btn" onClick={() => onPublish(detail.vhost, detail.name)}>+ Publish</button>
      <button
        className="chip-btn"
        // The default exchange and the built-in amq.* set belong to the
        // broker — deleting them breaks it, so don't offer the button.
        disabled={readOnly || !detail.name || detail.name.startsWith('amq.')}
        title={!detail.name || detail.name.startsWith('amq.') ? 'Exchange hệ thống — không xoá được' : readOnly ? 'Broker read-only' : 'Xoá exchange'}
        onClick={() => setShowDelete(true)}
      >🗑</button>
    </>
  ) : null;

  return (
    <FocusPane
      focused={!!selected}
      backLabel={`Tất cả exchange (${exchanges.length})`}
      title={selected?.name || '(default)'}
      subtitle={detail
        ? `${vhostLabel(detail.vhost)} · ${detail.type} · ${detail.bindings.length} route`
        : selected ? vhostLabel(selected.vhost) : undefined}
      actions={focusActions}
      onBack={onClearSelect}
      list={
        <>
          <div className="rabbit-toolbar">
            <input className="input" placeholder="Tìm exchange theo tên / type…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} />
            <button className="chip-btn" disabled={readOnly} title={readOnly ? 'Broker read-only' : 'Tạo exchange mới'} onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? '✕' : '+ Tạo exchange'}
            </button>
          </div>

          {showCreate && (
            <ExchangeForm
              vhostScope={vhostScope}
              onCancel={() => setShowCreate(false)}
              onSubmit={async (d) => { await onCreate(d); setShowCreate(false); }}
              onDiff={onDiff}
            />
          )}

          <div className="rabbit-meta">{loading ? <span className="spinner" /> : `${filtered.length}/${exchanges.length} exchange`}</div>
          <div className="endpoint-list rabbit-scroll">
            {filtered.map((x) => (
              <button
                key={`${x.vhost}/${x.name}`}
                className="ep-item"
                onClick={() => onSelect(x.vhost, x.name)}
              >
                <span className="rabbit-topic-name">{x.name || '(default)'}</span>
                <span className="rabbit-topic-meta">{vhostLabel(x.vhost)} · {x.type}{x.internal ? ' · internal' : ''}</span>
              </button>
            ))}
            {!loading && filtered.length === 0 && <p className="empty">Không có exchange khớp.</p>}
          </div>
        </>
      }
    >
      {detailLoading ? (
        <p><span className="spinner" /> Đang tải…</p>
      ) : detail ? (
        <>
            <LockNotice readOnly={readOnly} />

            <div className="rabbit-stat-row">
              <span className="badge">{vhostLabel(detail.vhost)}</span>
              <span className="badge">{detail.type}</span>
              <span className="badge">{detail.durable ? 'durable' : 'transient'}</span>
              {detail.internal && <span className="badge">internal</span>}
            </div>

            {detail.type === 'headers' && (
              <p className="rabbit-hint">
                Exchange kiểu <b>headers</b> — route theo header của message + <code>x-match</code>, không theo routing
                key. Route tester không mô phỏng được loại này.
              </p>
            )}

            <div className="rabbit-meta">Cấu hình (arguments)</div>
            <ArgsTable args={detail.arguments} onJumpExchange={undefined} />

            <div className="rabbit-meta">Routes tới ({detail.bindings.length})</div>
            {detail.bindings.length === 0 ? (
              <p className="rabbit-hint" style={{ color: 'var(--warn)' }}>
                Exchange này <b>không bind tới đâu cả</b> — mọi message publish vào đây sẽ bị drop im lặng (trừ khi có
                <code> alternate-exchange</code>).
              </p>
            ) : (
              <table className="rabbit-table">
                <thead><tr><th>Đích</th><th>Routing key</th><th>Loại</th></tr></thead>
                <tbody>
                  {detail.bindings.map((b, i) => (
                    <tr key={i}>
                      <td style={{ textAlign: 'left' }}>
                        {b.destinationType === 'queue' ? (
                          <button className="rabbit-link" onClick={() => onOpenQueue(b.destination)}>{b.destination} ↗</button>
                        ) : (
                          b.destination
                        )}
                      </td>
                      <td style={{ textAlign: 'left' }}><code className="small">{b.routingKey || '—'}</code></td>
                      <td>{b.destinationType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {showDelete && (
              <DangerModal
                title="Xoá exchange?"
                confirmName={detail.name}
                warning={`Xoá exchange sẽ phá ${detail.bindings.length} binding. Mọi producer đang publish vào exchange này sẽ bị drop message im lặng — không có lỗi phía producer.`}
                details={[
                  { label: 'vhost', value: vhostLabel(detail.vhost) },
                  { label: 'Type', value: detail.type },
                  { label: 'Điều kiện an toàn', value: ifUnused ? 'chỉ khi không còn binding nào' : 'bỏ qua (xoá cả khi đang dùng)' },
                ]}
                actionLabel="Xoá exchange"
                busy={busy}
                onCancel={() => setShowDelete(false)}
                onConfirm={async () => {
                  setBusy(true);
                  try { await onDelete(detail.vhost, detail.name, { ifUnused }); setShowDelete(false); }
                  finally { setBusy(false); }
                }}
              />
            )}

            {!readOnly && detail.name && (
              <div className="rabbit-actionbar">
                <span className="rabbit-hint">Điều kiện an toàn khi xoá exchange:</span>
                <label className="rabbit-check">
                  <input type="checkbox" checked={ifUnused} onChange={(e) => setIfUnused(e.target.checked)} /> chỉ khi không còn binding
                </label>
              </div>
            )}
        </>
      ) : null}
    </FocusPane>
  );
}

/**
 * Declare-or-check form. "Kiểm tra" runs a read-only diff so you can verify a
 * service's expected exchange config against the live broker WITHOUT the write
 * gate — useful even on a read-only production broker.
 */
function ExchangeForm({
  vhostScope,
  onCancel,
  onSubmit,
  onDiff,
}: {
  vhostScope: string;
  onCancel: () => void;
  onSubmit: (d: ExchangeDeclarationInput) => Promise<void>;
  onDiff: (d: ExchangeDeclarationInput) => Promise<DeclarationDiff>;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('topic');
  const [durable, setDurable] = useState(true);
  const [internal, setInternal] = useState(false);
  const [altExchange, setAltExchange] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<DeclarationDiff | null>(null);

  const build = (): ExchangeDeclarationInput => {
    const args: Record<string, unknown> = {};
    if (altExchange.trim()) args['alternate-exchange'] = altExchange.trim();
    return { vhost: vhostScope || '/', name: name.trim(), type, durable, autoDelete: false, internal, arguments: args };
  };

  return (
    <div className="rabbit-form">
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
      <label className="rabbit-field"><span>Tên exchange</span>
        <input className="input" value={name} onChange={(e) => { setName(e.target.value); setDiff(null); }} placeholder="app.events" />
      </label>
      <div className="rabbit-form-row">
        <label className="rabbit-field" style={{ flex: 1 }}><span>Type</span>
          <select className="input" value={type} onChange={(e) => { setType(e.target.value); setDiff(null); }}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="rabbit-check" style={{ marginTop: 16 }}>
          <input type="checkbox" checked={durable} onChange={(e) => { setDurable(e.target.checked); setDiff(null); }} /> durable
        </label>
        <label className="rabbit-check" style={{ marginTop: 16 }}>
          <input type="checkbox" checked={internal} onChange={(e) => { setInternal(e.target.checked); setDiff(null); }} /> internal
        </label>
      </div>
      <label className="rabbit-field">
        <span>Alternate exchange (nơi nhận message không route được)</span>
        <input className="input" value={altExchange} onChange={(e) => { setAltExchange(e.target.value); setDiff(null); }} placeholder="app.unroutable" />
      </label>

      {diff && <DiffPanel diff={diff} name={name.trim()} />}

      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="ghost sm"
          disabled={busy || !name.trim()}
          title="So sánh cấu hình mong muốn với broker (chỉ đọc, không ghi)"
          onClick={async () => {
            setBusy(true); setErr(null);
            try { setDiff(await onDiff(build())); }
            catch (e) { setErr((e as Error).message); }
            finally { setBusy(false); }
          }}
        >Kiểm tra cấu hình</button>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          // A mismatching exchange cannot be fixed by declaring again — the broker
          // returns 406. Block the button rather than let the user hit that wall.
          disabled={busy || !name.trim() || !!diff?.requiresRecreate}
          title={diff?.requiresRecreate ? 'Cấu hình lệch — phải xoá và tạo lại' : 'Tạo exchange'}
          onClick={async () => {
            setBusy(true); setErr(null);
            try { await onSubmit(build()); }
            catch (e) { setErr((e as Error).message); }
            finally { setBusy(false); }
          }}
        >{busy ? 'Đang tạo…' : 'Tạo exchange'}</button>
      </div>
    </div>
  );
}

/** Renders the desired-vs-actual comparison and the only valid next step. */
function DiffPanel({ diff, name }: { diff: DeclarationDiff; name: string }) {
  if (!diff.exists) {
    return <p className="rabbit-hint" style={{ color: 'var(--ok)' }}>✓ Chưa tồn tại — tạo mới được ngay.</p>;
  }
  if (diff.identical) {
    return <p className="rabbit-hint" style={{ color: 'var(--ok)' }}>✓ Đã tồn tại và cấu hình <b>khớp hoàn toàn</b> — không cần làm gì.</p>;
  }
  return (
    <>
      <div className="rabbit-danger">
        Đã tồn tại nhưng <b>cấu hình lệch</b>. RabbitMQ <b>không cho sửa</b> exchange đã có — declare lại sẽ bị
        <code> 406 PRECONDITION_FAILED</code>. Cách duy nhất: xoá <code>{name}</code> rồi tạo lại (kiểm tra binding và
        producer đang dùng trước khi làm).
      </div>
      <table className="rabbit-table">
        <thead><tr><th>Trường</th><th>Mong muốn</th><th>Trên broker</th></tr></thead>
        <tbody>
          {diff.fields.map((f) => (
            <tr key={f.field} style={f.equal ? undefined : { color: 'var(--err)' }}>
              <td>{f.field}</td>
              <td style={{ textAlign: 'left' }}><code className="small">{f.desired}</code></td>
              <td style={{ textAlign: 'left' }}><code className="small">{f.actual}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
