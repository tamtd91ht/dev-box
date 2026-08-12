// DevBox Automation — condition matching + template rendering.
//
// Pure functions only: same input, same output, no I/O. The UI's Test console
// and the live engine both run through here, so what you see in the tester is
// exactly what happens at 2am.

import type { AutomationCondition, AutomationEvent, RuleWindow } from './types';
import { buildAlertMeta, META_BLOCK_CLOSE, META_BLOCK_OPEN } from './meta';

/** Core fields every event has, regardless of which source produced it. */
const CORE: Record<string, (e: AutomationEvent) => string | number> = {
  title: (e) => e.title ?? '',
  text: (e) => e.text ?? '',
  category: (e) => e.category,
  type: (e) => e.type,
  source: (e) => e.sourceId,
  instance: (e) => e.instanceLabel ?? '',
  instanceId: (e) => e.instanceId ?? '',
  ts: (e) => e.ts,
};

/**
 * Resolve a condition/template field. Core names win, then event.fields — so a
 * social rule reads `sender` and an infra rule reads `value` with no special
 * casing anywhere in the engine.
 */
export function fieldRaw(event: AutomationEvent, field: string): string | number | undefined {
  const core = CORE[field];
  if (core) return core(event);
  return event.fields?.[field];
}

export function fieldValue(event: AutomationEvent, field: string): string {
  const v = fieldRaw(event, field);
  return v === undefined || v === null ? '' : String(v);
}

/** Split an anyOf/noneOf operand: comma or newline separated, trimmed. */
export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Regex groups captured by matching conditions, for {{m1}}…{{m9}}. */
export type Captures = string[];

const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

/**
 * Evaluate ONE condition. Regex groups are appended to `captures` so actions can
 * template them. A malformed regex or a non-numeric comparison never throws —
 * it simply fails to match (a broken rule must not break the pipeline).
 */
export function testCondition(
  event: AutomationEvent,
  cond: AutomationCondition,
  captures?: Captures,
): boolean {
  if (NUMERIC_OPS.has(cond.op)) {
    const left = Number(fieldRaw(event, cond.field));
    const right = Number(cond.value);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    switch (cond.op) {
      case 'gt':
        return left > right;
      case 'gte':
        return left >= right;
      case 'lt':
        return left < right;
      case 'lte':
        return left <= right;
    }
  }

  const raw = fieldValue(event, cond.field);
  const ci = !cond.caseSensitive;
  const hay = ci ? raw.toLowerCase() : raw;
  const needle = ci ? (cond.value ?? '').toLowerCase() : cond.value ?? '';

  switch (cond.op) {
    case 'empty':
      return raw.trim() === '';
    case 'notEmpty':
      return raw.trim() !== '';
    case 'contains':
      return needle !== '' && hay.includes(needle);
    case 'notContains':
      return needle === '' || !hay.includes(needle);
    case 'equals':
      return hay === needle;
    case 'notEquals':
      return hay !== needle;
    case 'startsWith':
      return needle !== '' && hay.startsWith(needle);
    case 'endsWith':
      return needle !== '' && hay.endsWith(needle);
    case 'anyOf': {
      const list = parseList(cond.value).map((s) => (ci ? s.toLowerCase() : s));
      return list.some((s) => hay.includes(s));
    }
    case 'noneOf': {
      const list = parseList(cond.value).map((s) => (ci ? s.toLowerCase() : s));
      return !list.some((s) => hay.includes(s));
    }
    case 'regex': {
      try {
        const re = new RegExp(cond.value ?? '', cond.caseSensitive ? '' : 'i');
        const m = re.exec(raw);
        if (m && captures) captures.push(...m.slice(1).map((g) => g ?? ''));
        return !!m;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/** Evaluate a whole condition set. No conditions = match (scope already gated). */
export function testConditions(
  event: AutomationEvent,
  mode: 'all' | 'any',
  conditions: AutomationCondition[],
  captures?: Captures,
): boolean {
  if (!conditions.length) return true;
  return mode === 'all'
    ? conditions.every((c) => testCondition(event, c, captures))
    : conditions.some((c) => testCondition(event, c, captures));
}

// ── Active-hours window ────────────────────────────────────────────────────

/** Minutes since midnight for "HH:mm"; -1 when unparseable. */
function minutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return -1;
  return h * 60 + min;
}

/**
 * Is `at` inside the rule's active window? A window with no usable from/to is
 * always-on, so a half-filled form never silently disables a rule.
 */
export function inWindow(win: RuleWindow | undefined, at: Date): boolean {
  if (!win) return true;
  if (win.days?.length && !win.days.includes(at.getDay())) return false;
  const from = minutes(win.from);
  const to = minutes(win.to);
  if (from < 0 || to < 0 || from === to) return true;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

// ── Templating ─────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** Variables available to every templated action field. */
export function templateVars(event: AutomationEvent, captures: Captures = []): Record<string, string> {
  const d = new Date(event.ts);
  const vars: Record<string, string> = {
    title: event.title ?? '',
    text: event.text ?? '',
    category: event.category,
    type: event.type,
    source: event.sourceId ?? '',
    instance: event.instanceLabel ?? '',
    instanceId: event.instanceId ?? '',
    id: event.id ?? '',
    ts: String(event.ts ?? 0),
    iso: Number.isFinite(event.ts) ? new Date(event.ts).toISOString() : '',
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    date: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
    json: JSON.stringify(event),
  };
  // Metadata chuẩn hoá (AlertMeta v1 — meta.ts): bản có cấu trúc của cùng sự
  // kiện, cho webhook và cho bot AI đọc tin nhắn. Đặt TRƯỚC vòng fields để một
  // field trùng tên không bao giờ che được chúng.
  const meta = buildAlertMeta(event);
  vars.metaJson = JSON.stringify(meta);
  vars.metaJsonPretty = JSON.stringify(meta, null, 2);
  vars.metaBlock = `${META_BLOCK_OPEN}\n${vars.metaJsonPretty}\n${META_BLOCK_CLOSE}`;
  // Source-specific fields (sender, conversation, metric, value, threshold…).
  for (const [k, v] of Object.entries(event.fields ?? {})) {
    if (!(k in vars)) vars[k] = String(v);
  }
  captures.forEach((c, i) => {
    vars[`m${i + 1}`] = c;
  });
  return vars;
}

/**
 * Replace {{var}} placeholders. Unknown names render empty — a typo must never
 * leak `{{sendr}}` into a webhook payload. No escaping, no nesting.
 *
 * Chấp nhận CẢ HAI cách viết cho field riêng của nguồn: `{{sender}}` và
 * `{{fields.sender}}`. templateVars() trải fields ra thẳng tên, nhưng UI và
 * tài liệu (ActionCard, types.ts) lâu nay vẫn dạy dạng có tiền tố `fields.` —
 * trước đây regex không nhận dấu chấm nên mọi `{{fields.*}}` âm thầm render ra
 * chuỗi rỗng. Nhận cả hai để thứ đã dạy người dùng là thứ chạy đúng.
 */
export function render(tpl: string | undefined, vars: Record<string, string>): string {
  if (!tpl) return '';
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, name: string) => {
    const hit = vars[name];
    if (hit !== undefined) return hit;
    // `fields.x` → `x` (templateVars đã trải phẳng). Chỉ bóc đúng tiền tố này,
    // không bóc dấu chấm bất kỳ, để `{{a.b}}` sai vẫn ra rỗng như trước.
    const bare = name.startsWith('fields.') ? vars[name.slice(7)] : undefined;
    return bare ?? '';
  });
}
