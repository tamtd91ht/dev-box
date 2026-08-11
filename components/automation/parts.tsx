'use client';

// Shared form atoms for the Automation tab. Small on purpose — they only exist
// so the rule/watch editors read as a description of the model instead of a
// wall of <div className="…"><label>.

import { useState, type ReactNode } from 'react';

/**
 * Hover help. Separate from `hint` on purpose: a hint is short enough to sit
 * under the input permanently, while a tip is the two or three sentences that
 * explain how a control is meant to be USED — worth having, but not worth the
 * vertical space in a form this long.
 */
export function Tip({ text }: { text: string }) {
  return (
    <span className="auto-tip" tabIndex={0} role="note" aria-label={text}>
      <span aria-hidden>?</span>
      <span className="auto-tip-pop">{text}</span>
    </span>
  );
}

export function Field({
  label,
  hint,
  tip,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  /** Longer "how to use this" text, shown on hover/focus of the ? marker. */
  tip?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`auto-field${wide ? ' wide' : ''}`}>
      <label>
        {label}
        {tip ? <Tip text={tip} /> : null}
      </label>
      {children}
      {hint ? <span className="auto-hint">{hint}</span> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  tone,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** 'risk' paints the switch amber — for anything that writes or reads content. */
  tone?: 'risk';
}) {
  return (
    <label className={`auto-toggle${disabled ? ' off' : ''}${tone === 'risk' ? ' risk' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="auto-toggle-text">
        <b>{label}</b>
        {hint ? <em>{hint}</em> : null}
      </span>
    </label>
  );
}

/** Number input that reports 0 for an empty box instead of NaN. */
export function Num({
  value,
  onChange,
  min = 0,
  placeholder,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  min?: number;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      min={min}
      value={value === undefined ? '' : String(value)}
      placeholder={placeholder}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) ? n : 0);
      }}
    />
  );
}

/** Comma-separated list ⇄ string[]. Used for scope ids and header lists. */
export function ListInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value.join(', ')}
      placeholder={placeholder}
      onChange={(e) =>
        onChange(
          e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/**
 * A collapsible section of the rule editor.
 *
 * The editor is a long single column — scope, conditions, several action cards,
 * schedule — and editing the last one meant scrolling past everything above it
 * every time. Folding a finished part lifts the rest into view.
 */
export function Section({
  title,
  extra,
  blurb,
  defaultOpen = true,
  children,
}: {
  title: string;
  /** Controls rendered next to the title, e.g. the all/any selector. */
  extra?: ReactNode;
  /**
   * One line saying what this section decides. Two adjacent sections that both
   * "filter events" are indistinguishable without it — which is exactly how
   * Scope and Conditions read side by side.
   */
  blurb?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`auto-sec${open ? '' : ' is-closed'}`}>
      <h4>
        <button
          type="button"
          className="auto-fold"
          aria-expanded={open}
          title={open ? 'Thu gọn' : 'Mở ra'}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '▾' : '▸'}
        </button>
        <button type="button" className="auto-sec-title" onClick={() => setOpen((v) => !v)}>
          {title}
        </button>
        {extra}
      </h4>
      {open ? (
        <>
          {blurb ? <p className="auto-sec-blurb">{blurb}</p> : null}
          {children}
        </>
      ) : null}
    </section>
  );
}

export const Empty = ({ icon, text }: { icon: string; text: string }) => (
  <div className="auto-empty">
    <span aria-hidden>{icon}</span>
    {text}
  </div>
);
