'use client';

// Shared form atoms for the Automation tab. Small on purpose — they only exist
// so the rule/watch editors read as a description of the model instead of a
// wall of <div className="…"><label>.

import type { ReactNode } from 'react';

export function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`auto-field${wide ? ' wide' : ''}`}>
      <label>{label}</label>
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

export const Empty = ({ icon, text }: { icon: string; text: string }) => (
  <div className="auto-empty">
    <span aria-hidden>{icon}</span>
    {text}
  </div>
);
