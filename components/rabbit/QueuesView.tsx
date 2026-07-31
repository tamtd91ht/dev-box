'use client';

// Per-queue management. Answers, in order of how often a backend dev asks:
//   • does the queue exist, and is it in a healthy state?
//   • how many messages are stuck (ready vs unacked — different problems)?
//   • is it bound, to which exchange, with which routing key?
//   • is the config right — durable? DLX? TTL? max-length? overflow?
//   • can I create/purge/delete it right here?
//
// `arguments` renders as labelled fields (not raw JSON) and the dead-letter
// exchange is a link, so a DLQ chain can be walked without retyping names.

import { useState } from 'react';
import {
  fmtBytes,
  fmtInt,
  fmtRate,
  vhostLabel,
  type PeekResult,
  type QueueDeclarationInput,
  type QueueDetail,
  type QueueSummary,
} from '@/lib/rabbit';
import DangerModal from './DangerModal';
import { ArgsTable, FocusPane, LockNotice, PeekList } from './shared';

const DEFAULT_PEEK = 10;

export interface QueuesViewProps {
  queues: QueueSummary[];
  loading: boolean;
  selected: { vhost: string; name: string } | null;
  detail: QueueDetail | null;
  detailLoading: boolean;
  readOnly: boolean;
  vhostScope: string;
  peek: PeekResult | null;
  peekLoading: boolean;
  onSelect: (vhost: string, name: string) => void;
  /** Clear the selection — returns the pane to the full-width list. */
  onClearSelect: () => void;
  onPeek: (count: number) => void;
  onPublish: (vhost: string, name: string) => void;
  onCreate: (d: QueueDeclarationInput) => Promise<void>;
  onPurge: (vhost: string, name: string) => Promise<void>;
  onDelete: (vhost: string, name: string, opts: { ifEmpty: boolean; ifUnused: boolean }) => Promise<void>;
  onOpenExchange: (name: string) => void;
}

export default function QueuesView(props: QueuesViewProps) {
  const {
    queues, loading, selected, detail, detailLoading, readOnly, vhostScope,
    peek, peekLoading, onSelect, onClearSelect, onPeek, onPublish, onCreate, onPurge, onDelete, onOpenExchange,
  } = props;

  const [filter, setFilter] = useState('');
  const [peekN, setPeekN] = useState(String(DEFAULT_PEEK));
  const [showCreate, setShowCreate] = useState(false);
  const [danger, setDanger] = useState<'purge' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  // Broker-side preconditions for delete — safer than trusting a stale UI count.
  const [ifEmpty, setIfEmpty] = useState(true);
  const [ifUnused, setIfUnused] = useState(true);

  const f = filter.trim().toLowerCase();
  const filtered = [...(f ? queues.filter((q) => q.name.toLowerCase().includes(f) || q.vhost.toLowerCase().includes(f)) : queues)]
    .sort((a, b) => b.messages - a.messages);

  const focusActions = detail ? (
    <>
      <button className="chip-btn" onClick={() => onPublish(detail.vhost, detail.name)}>+ Publish</button>
      <button
        className="chip-btn"
        disabled={readOnly}
        title={readOnly ? 'Broker read-only' : 'Xoá toàn bộ message trong queue'}
        onClick={() => setDanger('purge')}
      >Purge</button>
      <button
        className="chip-btn"
        disabled={readOnly}
        title={readOnly ? 'Broker read-only' : 'Xoá queue'}
        onClick={() => setDanger('delete')}
      >🗑</button>
    </>
  ) : null;

  return (
    <FocusPane
      focused={!!selected}
      backLabel={`Tất cả queue (${queues.length})`}
      title={selected?.name}
      subtitle={detail
        ? `${vhostLabel(detail.vhost)} · ${fmtInt(detail.messages)} msg · ${detail.consumers} consumer`
        : selected ? vhostLabel(selected.vhost) : undefined}
      actions={focusActions}
      onBack={onClearSelect}
      list={
        <>
          <div className="rabbit-toolbar">
            <input className="input" placeholder="Tìm queue theo tên / vhost…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} />
            <button className="chip-btn" disabled={readOnly} title={readOnly ? 'Broker read-only' : 'Tạo queue mới'} onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? '✕' : '+ Tạo queue'}
            </button>
          </div>

          {showCreate && (
            <CreateQueueForm
              vhostScope={vhostScope}
              onCancel={() => setShowCreate(false)}
              onSubmit={async (d) => { await onCreate(d); setShowCreate(false); }}
            />
          )}

          <div className="rabbit-meta">
            {loading ? <span className="spinner" /> : `${filtered.length}/${queues.length} queue · sắp xếp theo backlog`}
          </div>
          <div className="endpoint-list rabbit-scroll">
            {filtered.map((q) => (
              <button
                key={`${q.vhost}/${q.name}`}
                className="ep-item"
                onClick={() => onSelect(q.vhost, q.name)}
              >
                <span className="rabbit-topic-name">
                  {q.name} <span className={`rabbit-state s-${q.state}`}>{q.state}</span>
                  {/* Backlog with no consumer = nothing will ever drain it. */}
                  {q.messages > 0 && q.consumers === 0 && (
                    <span className="badge" style={{ color: 'var(--err)', marginLeft: 6 }} title="Có message nhưng không có consumer">
                      no consumer
                    </span>
                  )}
                </span>
                <span className="rabbit-topic-meta">
                  {vhostLabel(q.vhost)} · {fmtInt(q.messages)} msg · {q.consumers}c
                </span>
              </button>
            ))}
            {!loading && filtered.length === 0 && <p className="empty">Không có queue khớp.</p>}
          </div>
        </>
      }
    >
      {detailLoading ? (
        <p><span className="spinner" /> Đang tải chi tiết…</p>
      ) : detail ? (
        <>
            <LockNotice readOnly={readOnly} />

            <div className="rabbit-stat-row">
              <span className="badge">{vhostLabel(detail.vhost)}</span>
              <span className="badge">{detail.durable ? 'durable' : 'transient'}</span>
              {detail.autoDelete && <span className="badge">auto-delete</span>}
              {detail.exclusive && <span className="badge">exclusive</span>}
              <span className="badge">{fmtBytes(detail.memory)}</span>
              <span className="badge">{detail.node}</span>
            </div>

            {detail.messages > 0 && detail.consumers === 0 && (
              <div className="rabbit-danger">
                ⚠ Queue có <b>{fmtInt(detail.messages)}</b> message nhưng <b>không có consumer nào</b> — không gì sẽ xử lý chúng.
              </div>
            )}
            {detail.unacked > 0 && (
              <p className="rabbit-hint">
                {fmtInt(detail.unacked)} message đang <b>unacked</b> — đã giao cho consumer nhưng chưa ack. Nếu số này
                đứng im, consumer có thể đang treo hoặc quên ack.
              </p>
            )}

            <table className="rabbit-table">
              <tbody>
                <tr><td>Messages</td><td>{fmtInt(detail.messages)}</td></tr>
                <tr><td>Ready (chưa xử lý)</td><td>{fmtInt(detail.ready)}</td></tr>
                <tr><td>Unacked (đang xử lý)</td><td>{fmtInt(detail.unacked)}</td></tr>
                <tr><td>Consumers</td><td>{fmtInt(detail.consumers)}</td></tr>
                <tr>
                  <td>Publish / Deliver / Ack /s</td>
                  <td>{fmtRate(detail.publishRate)} / {fmtRate(detail.deliverRate)} / {fmtRate(detail.ackRate)}</td>
                </tr>
              </tbody>
            </table>

            <div className="rabbit-meta">Cấu hình (arguments)</div>
            <ArgsTable args={detail.arguments} onJumpExchange={onOpenExchange} />
            <p className="rabbit-hint">
              RabbitMQ <b>không cho sửa</b> cấu hình của queue đã tồn tại. Muốn đổi <code>x-*</code>, TTL hay DLX thì
              phải xoá và tạo lại — cân nhắc backlog trước khi làm.
            </p>

            {detail.consumerList.length > 0 && (
              <>
                <div className="rabbit-meta">Consumers</div>
                <table className="rabbit-table">
                  <thead><tr><th>Tag</th><th>Prefetch</th><th>Ack</th></tr></thead>
                  <tbody>
                    {detail.consumerList.map((c, i) => (
                      <tr key={i}>
                        <td style={{ textAlign: 'left' }}>{c.tag || c.channel}</td>
                        <td>{c.prefetch || '∞'}</td>
                        <td>{c.ackRequired ? 'manual' : 'auto'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            <div className="rabbit-meta">Bindings ({detail.bindings.length})</div>
            {detail.bindings.length === 0 ? (
              <p className="rabbit-hint" style={{ color: 'var(--warn)' }}>
                Queue này <b>chưa bind vào exchange nào</b> — chỉ nhận được message publish qua default exchange với
                routing key đúng bằng tên queue. Sang tab <b>Bindings/Routing</b> để bind.
              </p>
            ) : (
              <table className="rabbit-table">
                <thead><tr><th>Exchange</th><th>Routing key</th></tr></thead>
                <tbody>
                  {detail.bindings.map((b, i) => (
                    <tr key={i}>
                      <td style={{ textAlign: 'left' }}>
                        {b.source ? (
                          <button className="rabbit-link" onClick={() => onOpenExchange(b.source)}>{b.source} ↗</button>
                        ) : '(default)'}
                      </td>
                      <td style={{ textAlign: 'left' }}><code className="small">{b.routingKey || '—'}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="rabbit-actionbar">
              <label>Peek</label>
              <input className="input" style={{ width: 64 }} type="number" min={1} max={50} value={peekN} onChange={(e) => setPeekN(e.target.value)} />
              <span className="rabbit-hint">không phá huỷ (requeue)</span>
              <button className="chip-btn" disabled={peekLoading} onClick={() => onPeek(Number(peekN) || DEFAULT_PEEK)}>Xem</button>
            </div>
            <PeekList peek={peek} loading={peekLoading} />

            {/*
              Delete preconditions live OUTSIDE the modal on purpose: they must be
              set before confirming, and the modal is a dialog you only pass
              through once. Both default ON so the BROKER refuses a delete that
              would lose messages — closing the gap between "UI showed 0" and
              "delete actually ran".
            */}
            {!readOnly && (
              <div className="rabbit-actionbar">
                <span className="rabbit-hint">Điều kiện an toàn khi xoá queue:</span>
                <label className="rabbit-check">
                  <input type="checkbox" checked={ifEmpty} onChange={(e) => setIfEmpty(e.target.checked)} /> chỉ khi rỗng
                </label>
                <label className="rabbit-check">
                  <input type="checkbox" checked={ifUnused} onChange={(e) => setIfUnused(e.target.checked)} /> chỉ khi không có consumer
                </label>
              </div>
            )}

            {danger === 'purge' && (
              <DangerModal
                title="Purge queue?"
                confirmName={detail.name}
                warning={`Queue này có ${fmtInt(detail.messages)} message — purge sẽ XOÁ VĨNH VIỄN toàn bộ, không khôi phục được.`}
                details={[
                  { label: 'vhost', value: vhostLabel(detail.vhost) },
                  { label: 'Ready / Unacked', value: `${fmtInt(detail.ready)} / ${fmtInt(detail.unacked)}` },
                ]}
                actionLabel="Purge toàn bộ message"
                busy={busy}
                onCancel={() => setDanger(null)}
                onConfirm={async () => {
                  setBusy(true);
                  try { await onPurge(detail.vhost, detail.name); setDanger(null); }
                  finally { setBusy(false); }
                }}
              />
            )}

            {danger === 'delete' && (
              <DangerModal
                title="Xoá queue?"
                confirmName={detail.name}
                warning={`Xoá queue sẽ mất ${fmtInt(detail.messages)} message VÀ toàn bộ ${detail.bindings.length} binding của nó. Producer publish sau đó sẽ bị drop im lặng.`}
                details={[
                  { label: 'vhost', value: vhostLabel(detail.vhost) },
                  { label: 'Consumers', value: String(detail.consumers) },
                  { label: 'Điều kiện an toàn', value: `${ifEmpty ? 'chỉ khi rỗng' : 'bỏ qua'} · ${ifUnused ? 'chỉ khi không có consumer' : 'bỏ qua'}` },
                ]}
                actionLabel="Xoá queue"
                busy={busy}
                onCancel={() => setDanger(null)}
                onConfirm={async () => {
                  setBusy(true);
                  try { await onDelete(detail.vhost, detail.name, { ifEmpty, ifUnused }); setDanger(null); }
                  finally { setBusy(false); }
                }}
              />
            )}
        </>
      ) : null}
    </FocusPane>
  );
}

/**
 * Create-queue form. Only exposes the arguments a backend dev actually sets;
 * anything else can be declared from application code where it belongs.
 */
function CreateQueueForm({
  vhostScope,
  onCancel,
  onSubmit,
}: {
  vhostScope: string;
  onCancel: () => void;
  onSubmit: (d: QueueDeclarationInput) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [durable, setDurable] = useState(true);
  const [queueType, setQueueType] = useState<'classic' | 'quorum'>('classic');
  const [dlx, setDlx] = useState('');
  const [dlrk, setDlrk] = useState('');
  const [ttl, setTtl] = useState('');
  const [maxLen, setMaxLen] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const build = (): QueueDeclarationInput => {
    const args: Record<string, unknown> = {};
    if (queueType === 'quorum') args['x-queue-type'] = 'quorum';
    if (dlx.trim()) args['x-dead-letter-exchange'] = dlx.trim();
    if (dlrk.trim()) args['x-dead-letter-routing-key'] = dlrk.trim();
    if (ttl.trim() && Number(ttl) > 0) args['x-message-ttl'] = Number(ttl);
    if (maxLen.trim() && Number(maxLen) > 0) args['x-max-length'] = Number(maxLen);
    return { vhost: vhostScope || '/', name: name.trim(), durable, autoDelete: false, arguments: args };
  };

  return (
    <div className="rabbit-form">
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
      <label className="rabbit-field"><span>Tên queue</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="omicx.order.created" />
      </label>
      <div className="rabbit-form-row">
        <label className="rabbit-field" style={{ flex: 1 }}><span>Queue type</span>
          <select className="input" value={queueType} onChange={(e) => setQueueType(e.target.value as 'classic' | 'quorum')}>
            <option value="classic">classic</option>
            <option value="quorum">quorum</option>
          </select>
        </label>
        <label className="rabbit-check" style={{ marginTop: 16 }}>
          <input type="checkbox" checked={durable} onChange={(e) => setDurable(e.target.checked)} /> durable
        </label>
      </div>
      <div className="rabbit-form-row">
        <label className="rabbit-field" style={{ flex: 1 }}><span>Dead-letter exchange</span>
          <input className="input" value={dlx} onChange={(e) => setDlx(e.target.value)} placeholder="omicx.dlx" />
        </label>
        <label className="rabbit-field" style={{ flex: 1 }}><span>Dead-letter routing key</span>
          <input className="input" value={dlrk} onChange={(e) => setDlrk(e.target.value)} placeholder="order.created.dead" />
        </label>
      </div>
      <div className="rabbit-form-row">
        <label className="rabbit-field" style={{ flex: 1 }}><span>Message TTL (ms)</span>
          <input className="input" type="number" min={0} value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="để trống = không TTL" />
        </label>
        <label className="rabbit-field" style={{ flex: 1 }}><span>Max length (messages)</span>
          <input className="input" type="number" min={0} value={maxLen} onChange={(e) => setMaxLen(e.target.value)} placeholder="để trống = không giới hạn" />
        </label>
      </div>
      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true); setErr(null);
            try { await onSubmit(build()); }
            catch (e) { setErr((e as Error).message); }
            finally { setBusy(false); }
          }}
        >{busy ? 'Đang tạo…' : 'Tạo queue'}</button>
      </div>
    </div>
  );
}
