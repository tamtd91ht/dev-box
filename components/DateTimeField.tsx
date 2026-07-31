'use client';

import DatePicker from 'react-datepicker';

interface Props {
  /** Current value as "YYYY-MM-DDTHH:mm" (local), or '' when unset. */
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}

/** Parse a "YYYY-MM-DDTHH:mm" local string into a Date (null when empty/invalid). */
function parse(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Serialize a Date back to the "YYYY-MM-DDTHH:mm" local string the app speaks. */
function serialize(d: Date | null): string {
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Modern datetime picker built on react-datepicker. Keeps the same contract as
 * before — the value is the "YYYY-MM-DDTHH:mm" local string that `toLocalInput(ms)`
 * produces and `new Date(value).getTime()` parses — so every call site (search
 * filter + preset wizard) works unchanged.
 *
 * The calendar renders in a portal (`withPortal={false}` + `popperClassName`) so it
 * floats above the panel without being clipped, shows an inline time column
 * (15-min steps), and is themed for the app's dark surface via `.omi-datepicker`
 * overrides in globals.css. This replaces the native `datetime-local` input.
 */
export default function DateTimeField({ value, onChange, className, placeholder }: Props) {
  return (
    <DatePicker
      selected={parse(value)}
      onChange={(d) => onChange(serialize(d))}
      showTimeSelect
      timeIntervals={15}
      timeCaption="Giờ"
      dateFormat="dd/MM/yyyy HH:mm"
      timeFormat="HH:mm"
      placeholderText={placeholder ?? 'dd/mm/yyyy --:--'}
      className={className}
      calendarClassName="omi-datepicker"
      popperClassName="omi-datepicker-popper"
      popperPlacement="bottom-start"
      shouldCloseOnSelect={false}
      isClearable
    />
  );
}
