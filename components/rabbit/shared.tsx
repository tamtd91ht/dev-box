'use client';

// Small presentational pieces shared by the Rabbit sub-views. Kept together so
// the metric card, config table and peek list look identical everywhere rather
// than drifting per view.

import {
  fmtBytes,
  fmtInt,
  argLabel,
  fmtArgValue,
  usagePct,
  gaugeLevel,
  type PeekResult,
} from '@/lib/rabbit';

export function Card({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'ok' | 'warn' | 'err';
}) {
  const color = tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : tone === 'ok' ? 'var(--ok)' : undefined;
  return (
    <div className="rabbit-card">
      <div className="rabbit-card-label">{label}</div>
      <div className="rabbit-card-value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="rabbit-card-sub">{sub}</div>}
    </div>
  );
}

/**
 * Horizontal usage bar. `limit <= 0` means the broker reports no bound (e.g.
 * `fd_total` on some platforms) — we show the raw used value instead of a
 * misleading 0% bar.
 */
export function Gauge({
  label,
  used,
  limit,
  format = fmtInt,
  alarm,
}: {
  label: string;
  used: number;
  limit: number;
  format?: (n: number) => string;
  /** Broker-reported alarm — forces the crit colour regardless of the ratio. */
  alarm?: boolean;
}) {
  const pct = usagePct(used, limit);
  const level = alarm ? 'crit' : gaugeLevel(pct);
  const unbounded = !Number.isFinite(limit) || limit <= 0;

  return (
    <div className="rabbit-gauge">
      <div className="rabbit-gauge-head">
        <span>{label}</span>
        <span className="rabbit-gauge-num">
          {format(used)}{unbounded ? '' : ` / ${format(limit)}`}
          {!unbounded && <span className="rabbit-gauge-pct"> ({Math.round(pct)}%)</span>}
        </span>
      </div>
      <div className="rabbit-gauge-track">
        <div className={`rabbit-gauge-fill l-${level}`} style={{ width: `${unbounded ? 0 : pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Queue/exchange `arguments` as labelled fields instead of raw JSON. Known `x-*`
 * keys get a human label; unknown keys still render under their raw key so
 * nothing is silently hidden. `onJumpExchange` makes a DLX clickable so the
 * dead-letter chain can be walked without retyping names.
 */
export function ArgsTable({
  args,
  onJumpExchange,
}: {
  args: Record<string, unknown>;
  onJumpExchange?: (name: string) => void;
}) {
  const keys = Object.keys(args ?? {}).sort();
  if (keys.length === 0) {
    return <p className="rabbit-hint">Không có argument nào (dùng mặc định của broker).</p>;
  }
  const isExchangeRef = (k: string) => k === 'x-dead-letter-exchange' || k === 'alternate-exchange';

  return (
    <table className="rabbit-table">
      <tbody>
        {keys.map((k) => {
          const v = args[k];
          const jumpable = onJumpExchange && isExchangeRef(k) && typeof v === 'string' && v !== '';
          return (
            <tr key={k} className="rabbit-arg-row">
              <td title={k}>{argLabel(k)}</td>
              <td style={{ textAlign: 'left' }}>
                {jumpable ? (
                  <button className="rabbit-link" onClick={() => onJumpExchange!(v as string)} title="Mở exchange này">
                    {v as string} ↗
                  </button>
                ) : (
                  <code className="small">{fmtArgValue(v)}</code>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PeekList({ peek, loading }: { peek: PeekResult | null; loading: boolean }) {
  if (loading) return <p style={{ marginTop: 10 }}><span className="spinner" /> Đang đọc message…</p>;
  if (!peek) return null;
  return (
    <div className="rabbit-results">
      <div className="rabbit-meta">
        {peek.count} message · <span className="badge" style={{ color: 'var(--ok)' }}>requeued (không mất message)</span>
      </div>
      {peek.messages.length === 0 && <p className="empty">Queue rỗng.</p>}
      {peek.messages.map((m, i) => (
        <div key={i} className="rabbit-msg">
          <div className="rabbit-msg-head">
            <span className="badge">{m.exchange || '(default)'} → {m.routingKey || '—'}</span>
            <span className="rabbit-topic-meta">{fmtBytes(m.payloadBytes)}</span>
            {m.redelivered && <span className="badge" style={{ color: 'var(--warn)' }}>redelivered</span>}
          </div>
          <pre className="code rabbit-msg-val">{m.payload}{m.payloadTruncated ? '\n…(cắt bớt)' : ''}</pre>
        </div>
      ))}
    </div>
  );
}

/**
 * List-or-focus container.
 *
 * Nothing selected → the list gets the full width. Something selected → the list
 * is UNMOUNTED and the detail takes the whole pane, with a back button as the
 * only way out. Deliberately an exclusive swap rather than a side-by-side split:
 * a queue detail is a dense read (stats, arguments, consumers, bindings, peeked
 * payloads) and on a broker with 117 queues the list beside it is noise. Focus
 * also means the wide tables stop being squeezed into a narrow column.
 *
 * Unmounting rather than hiding is intentional — the list is up to a few hundred
 * rows, so keeping it mounted behind the detail costs layout work for something
 * nobody can see.
 */
export function FocusPane({
  focused,
  backLabel,
  title,
  subtitle,
  actions,
  onBack,
  list,
  children,
}: {
  /** True once a target is selected. Drives the swap. */
  focused: boolean;
  /** e.g. "Tất cả queue" — names where the back button returns to. */
  backLabel: string;
  /** Focused object's name. */
  title?: string;
  /** Small line under the title (vhost, type, …). */
  subtitle?: React.ReactNode;
  /** Buttons for the focused object (publish/purge/delete). */
  actions?: React.ReactNode;
  onBack: () => void;
  /** Rendered only when nothing is focused. */
  list: React.ReactNode;
  /** Rendered only when focused. */
  children?: React.ReactNode;
}) {
  if (!focused) return <div className="rabbit-pane">{list}</div>;

  return (
    <div className="rabbit-pane rabbit-focus">
      <div className="rabbit-focus-head">
        <button className="chip-btn rabbit-back" onClick={onBack} title="Quay lại danh sách">
          ← {backLabel}
        </button>
        <div className="rabbit-focus-id">
          <strong className="code">{title}</strong>
          {subtitle && <span className="rabbit-topic-meta">{subtitle}</span>}
        </div>
        {actions && <div className="rabbit-focus-actions">{actions}</div>}
      </div>
      <div className="rabbit-focus-body rabbit-scroll">{children}</div>
    </div>
  );
}

/** Inline banner shown wherever a write button is disabled by a guard. */
export function LockNotice({ readOnly }: { readOnly: boolean }) {
  if (!readOnly) return null;
  return (
    <div className="rabbit-hint rabbit-locked">
      🔒 Broker đang <b>read-only</b> — các thao tác ghi bị tắt. Sửa broker và bỏ chọn “Read-only” nếu thực sự cần ghi.
    </div>
  );
}
