'use client';

// "Publish to exchange E with routing key K — which queues get it?"
//
// Resolved entirely in the browser from the already-loaded binding list, so it
// costs zero management-API calls and updates as you type. The alternative —
// publishing a probe message and watching where it lands — is a side effect
// nobody wants while debugging someone else's cluster.
//
// Honest about its limit: `headers` exchanges route on message headers + x-match,
// not on the routing key, so they cannot be simulated from a key. We say so
// instead of printing a confident wrong answer.
//
// `x-delayed-message` exchanges (the delay plugin) ARE simulated: they route by
// their `x-delayed-type` argument once the delay elapses, so the destination set
// is predictable — only the timing isn't. Hence the args map passed through.

import { useMemo, useState } from 'react';
import { vhostLabel, type BindingInfo, type ExchangeSummary } from '@/lib/rabbit';
import { resolveDefaultExchange, resolveRoute } from '@/lib/rabbitRouting';

export interface RouteTesterProps {
  bindings: BindingInfo[];
  exchanges: ExchangeSummary[];
  queueNames: string[];
  /** Pre-fill the exchange (e.g. opened from an exchange's detail pane). */
  initialExchange?: string;
  onOpenQueue?: (name: string) => void;
}

export default function RouteTester({
  bindings,
  exchanges,
  queueNames,
  initialExchange,
  onOpenQueue,
}: RouteTesterProps) {
  const [exchange, setExchange] = useState(initialExchange ?? '');
  const [routingKey, setRoutingKey] = useState('');

  // name → type, so the resolver can apply direct/topic/fanout rules correctly.
  const exchangeTypes = useMemo(() => {
    const m: Record<string, string> = {};
    for (const x of exchanges) m[x.name] = x.type;
    return m;
  }, [exchanges]);

  // name → declaration arguments. Only consulted for plugin types that delegate
  // their routing, i.e. x-delayed-message's `x-delayed-type`.
  const exchangeArgs = useMemo(() => {
    const m: Record<string, Record<string, unknown>> = {};
    for (const x of exchanges) m[x.name] = x.arguments ?? {};
    return m;
  }, [exchanges]);

  const result = useMemo(() => {
    // The default exchange ("") has no binding rows — it routes by exact queue
    // name, so it needs its own path.
    if (exchange === '') return resolveDefaultExchange(queueNames, routingKey);
    return resolveRoute(bindings, exchange, routingKey, exchangeTypes, exchangeArgs);
  }, [bindings, exchange, routingKey, exchangeTypes, exchangeArgs, queueNames]);

  const declaredType = exchange === '' ? 'default' : exchangeTypes[exchange] ?? 'direct';
  // What the delay plugin will actually route as, once the delay elapses.
  const delayedInner = declaredType === 'x-delayed-message'
    ? String(exchangeArgs[exchange]?.['x-delayed-type'] ?? 'direct')
    : '';
  // Drives the routing-key hints below: for a delayed exchange the matching rules
  // are the INNER type's, not the plugin's.
  const selectedType = delayedInner || declaredType;

  return (
    <div className="rabbit-route">
      <div className="rabbit-toolbar">
        <label className="rabbit-inline-field">
          <span>Exchange</span>
          <select className="input" value={exchange} onChange={(e) => setExchange(e.target.value)}>
            <option value="">(default — route theo tên queue)</option>
            {exchanges
              .filter((x) => x.name !== '')
              .map((x) => (
                <option key={`${x.vhost}/${x.name}`} value={x.name}>
                  {x.name} · {x.type} · {vhostLabel(x.vhost)}
                </option>
              ))}
          </select>
        </label>
        <label className="rabbit-inline-field" style={{ flex: 1 }}>
          <span>Routing key</span>
          <input
            className="input"
            value={routingKey}
            onChange={(e) => setRoutingKey(e.target.value)}
            placeholder={selectedType === 'topic' ? 'vd: order.vn.created' : 'vd: order.created'}
          />
        </label>
        <span className="badge">{declaredType}</span>
      </div>

      {delayedInner && (
        <p className="rabbit-hint">
          Exchange delay (plugin <code>x-delayed-message</code>): message được giữ lại theo header{' '}
          <code>x-delay</code> (ms), sau đó route <b>đúng như một exchange {delayedInner}</b>. Danh sách
          queue dưới đây là chính xác — chỉ thời điểm nhận là bị hoãn.
        </p>
      )}

      {selectedType === 'topic' && (
        <p className="rabbit-hint">
          Topic: <code>*</code> = đúng 1 từ, <code>#</code> = 0 hoặc nhiều từ, phân tách bằng <code>.</code>
        </p>
      )}
      {selectedType === 'fanout' && (
        <p className="rabbit-hint">Fanout: routing key bị bỏ qua — mọi queue đã bind đều nhận.</p>
      )}

      {result.unknownExchange && (
        <p className="rabbit-hint" style={{ color: 'var(--warn)' }}>
          Không tìm thấy exchange này trong danh sách binding đã tải — có thể nó chưa có binding nào, hoặc bạn đang lọc sai vhost.
        </p>
      )}

      {result.unsupported.length > 0 && (
        <div className="rabbit-danger">
          <strong>Không mô phỏng được</strong> —{' '}
          {result.unsupported.map((u) => `${u.exchange} (${u.type})`).join(', ')}. Exchange kiểu{' '}
          <code>headers</code> route dựa trên header của message + <code>x-match</code>, không phải routing key;
          các loại plugin khác thì luật route nằm trong plugin. Cần publish thử để xác nhận.
        </div>
      )}

      <div className="rabbit-meta">
        {result.hits.length === 0
          ? 'Không queue nào nhận — message sẽ bị drop (unroutable) trừ khi exchange có alternate-exchange.'
          : `${result.hits.length} queue sẽ nhận message này`}
      </div>

      {result.hits.length > 0 && (
        <table className="rabbit-table">
          <thead>
            <tr><th>Queue</th><th>Binding khớp</th><th>Qua exchange</th></tr>
          </thead>
          <tbody>
            {result.hits.map((h) => (
              <tr key={`${h.via.join('>')}/${h.queue}`} className="rabbit-route-hit">
                <td style={{ textAlign: 'left' }}>
                  {onOpenQueue ? (
                    <button className="rabbit-link" onClick={() => onOpenQueue(h.queue)}>{h.queue} ↗</button>
                  ) : (
                    h.queue
                  )}
                </td>
                <td style={{ textAlign: 'left' }}><code className="small">{h.matchedRoutingKey || '(rỗng)'}</code></td>
                <td style={{ textAlign: 'left' }}>{h.via.length > 0 ? h.via.join(' → ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
