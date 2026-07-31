// Server-only MUTATING RabbitMQ ops: create queue/exchange/binding, purge, and
// delete. Split out of rabbitClient.ts so the dangerous surface is one small,
// auditable file.
//
// GUARD MODEL — three server-side layers, all enforced in app/api/rabbit/route.ts
// before anything here is called:
//   1. RABBIT_ALLOW_DESTRUCTIVE env flag (off by default, whole tool).
//   2. per-connection `readOnly` flag (defaults TRUE, even for pre-existing
//      records — see lib/rabbitConnections.ts).
//   3. UI typed-confirm modal (client side, defence in depth, not a substitute).
// Every function here emits a RABBIT_AUDIT line to stdout via sanitize().
//
// ── The "update" trap ────────────────────────────────────────────────────────
// RabbitMQ does NOT support altering an existing queue/exchange. Re-declaring one
// with different durable/type/arguments returns 406 PRECONDITION_FAILED; the
// broker only accepts an IDENTICAL re-declaration (idempotent no-op). So there is
// deliberately no `updateQueue`/`updateExchange` here. Instead diffDeclaration()
// compares desired vs actual and tells the UI whether a recreate is required —
// the UI must never present a "Save" that silently does nothing.

import type { RabbitConnection } from './rabbitConnections';
import { mgmt, vh, sanitize } from './rabbitClient';

export interface MutationResult {
  ok: true;
}

export interface DiffField {
  field: string;
  desired: string;
  actual: string;
  equal: boolean;
}

export interface DeclarationDiff {
  exists: boolean;
  /** True when every compared field already matches — declaring again is a no-op. */
  identical: boolean;
  /** True when a field differs, so the only way to converge is delete + recreate. */
  requiresRecreate: boolean;
  fields: DiffField[];
}

function audit(op: string, conn: RabbitConnection, vhost: string, resource: string, extra = ''): void {
  console.log(
    `RABBIT_AUDIT operation=${op} conn=${sanitize(conn.id)} vhost=${sanitize(vhost)} resource=${sanitize(resource)}${extra ? ` ${extra}` : ''}`,
  );
}

/** Normalize an argument map to a stable comparable string. */
function argsKey(a: Record<string, unknown> | undefined): string {
  const o = a ?? {};
  const keys = Object.keys(o).sort();
  return JSON.stringify(keys.map((k) => [k, o[k]]));
}

// ── Create (declare) ──────────────────────────────────────────────────────────

export interface QueueDeclaration {
  vhost: string;
  name: string;
  durable: boolean;
  autoDelete: boolean;
  arguments: Record<string, unknown>;
}

export async function createQueue(conn: RabbitConnection, d: QueueDeclaration): Promise<MutationResult> {
  if (!d.name) throw new Error('queue name is required');
  await mgmt<void>(conn, `/api/queues/${vh(d.vhost)}/${encodeURIComponent(d.name)}`, {
    method: 'PUT',
    body: JSON.stringify({ durable: d.durable, auto_delete: d.autoDelete, arguments: d.arguments ?? {} }),
  });
  audit('CREATE_QUEUE', conn, d.vhost, d.name, `durable=${d.durable}`);
  return { ok: true };
}

export interface ExchangeDeclaration {
  vhost: string;
  name: string;
  type: string;
  durable: boolean;
  autoDelete: boolean;
  internal: boolean;
  arguments: Record<string, unknown>;
}

export async function createExchange(conn: RabbitConnection, d: ExchangeDeclaration): Promise<MutationResult> {
  if (!d.name) throw new Error('exchange name is required');
  if (!['direct', 'topic', 'fanout', 'headers'].includes(d.type)) {
    throw new Error(`unsupported exchange type: ${d.type}`);
  }
  await mgmt<void>(conn, `/api/exchanges/${vh(d.vhost)}/${encodeURIComponent(d.name)}`, {
    method: 'PUT',
    body: JSON.stringify({
      type: d.type,
      durable: d.durable,
      auto_delete: d.autoDelete,
      internal: d.internal,
      arguments: d.arguments ?? {},
    }),
  });
  audit('CREATE_EXCHANGE', conn, d.vhost, d.name, `type=${d.type} durable=${d.durable}`);
  return { ok: true };
}

export interface BindingDeclaration {
  vhost: string;
  source: string;
  destination: string;
  /** 'queue' → .../q/..., 'exchange' → .../e/... (exchange-to-exchange binding). */
  destinationType: 'queue' | 'exchange';
  routingKey: string;
  arguments: Record<string, unknown>;
}

export async function createBinding(conn: RabbitConnection, d: BindingDeclaration): Promise<MutationResult> {
  if (!d.source) throw new Error('source exchange is required');
  if (!d.destination) throw new Error('destination is required');
  const kind = d.destinationType === 'exchange' ? 'e' : 'q';
  await mgmt<void>(
    conn,
    `/api/bindings/${vh(d.vhost)}/e/${encodeURIComponent(d.source)}/${kind}/${encodeURIComponent(d.destination)}`,
    { method: 'POST', body: JSON.stringify({ routing_key: d.routingKey, arguments: d.arguments ?? {} }) },
  );
  audit('CREATE_BINDING', conn, d.vhost, `${d.source}->${d.destination}`, `routingKey=${sanitize(d.routingKey)}`);
  return { ok: true };
}

// ── Destructive ───────────────────────────────────────────────────────────────

export async function purgeQueue(conn: RabbitConnection, vhost: string, name: string): Promise<MutationResult> {
  if (!name) throw new Error('queue name is required');
  await mgmt<void>(conn, `/api/queues/${vh(vhost)}/${encodeURIComponent(name)}/contents`, { method: 'DELETE' });
  audit('PURGE_QUEUE', conn, vhost, name);
  return { ok: true };
}

/**
 * Delete a queue. `ifEmpty`/`ifUnused` map to the broker's own preconditions —
 * safer than a bare delete because the BROKER refuses if the queue still has
 * messages or consumers, closing the race between "UI showed 0" and "delete ran".
 */
export async function deleteQueue(
  conn: RabbitConnection,
  vhost: string,
  name: string,
  opts: { ifEmpty?: boolean; ifUnused?: boolean } = {},
): Promise<MutationResult> {
  if (!name) throw new Error('queue name is required');
  const q: string[] = [];
  if (opts.ifEmpty) q.push('if-empty=true');
  if (opts.ifUnused) q.push('if-unused=true');
  const qs = q.length ? `?${q.join('&')}` : '';
  await mgmt<void>(conn, `/api/queues/${vh(vhost)}/${encodeURIComponent(name)}${qs}`, { method: 'DELETE' });
  audit('DELETE_QUEUE', conn, vhost, name, `ifEmpty=${!!opts.ifEmpty} ifUnused=${!!opts.ifUnused}`);
  return { ok: true };
}

export async function deleteExchange(
  conn: RabbitConnection,
  vhost: string,
  name: string,
  opts: { ifUnused?: boolean } = {},
): Promise<MutationResult> {
  if (!name) throw new Error('exchange name is required');
  const qs = opts.ifUnused ? '?if-unused=true' : '';
  await mgmt<void>(conn, `/api/exchanges/${vh(vhost)}/${encodeURIComponent(name)}${qs}`, { method: 'DELETE' });
  audit('DELETE_EXCHANGE', conn, vhost, name, `ifUnused=${!!opts.ifUnused}`);
  return { ok: true };
}

/**
 * Delete ONE binding. `propertiesKey` comes from the binding row (management API
 * `properties_key`) and is what disambiguates bindings sharing source+destination.
 */
export async function deleteBinding(
  conn: RabbitConnection,
  d: { vhost: string; source: string; destination: string; destinationType: 'queue' | 'exchange'; propertiesKey: string },
): Promise<MutationResult> {
  if (!d.source || !d.destination) throw new Error('source and destination are required');
  if (!d.propertiesKey) throw new Error('propertiesKey is required to address a binding');
  const kind = d.destinationType === 'exchange' ? 'e' : 'q';
  await mgmt<void>(
    conn,
    `/api/bindings/${vh(d.vhost)}/e/${encodeURIComponent(d.source)}/${kind}/${encodeURIComponent(d.destination)}/${encodeURIComponent(d.propertiesKey)}`,
    { method: 'DELETE' },
  );
  audit('DELETE_BINDING', conn, d.vhost, `${d.source}->${d.destination}`, `propsKey=${sanitize(d.propertiesKey)}`);
  return { ok: true };
}

// ── Declaration diff (the honest "can I update this?" answer) ─────────────────

/**
 * Compare a DESIRED queue declaration against what's on the broker.
 * Returns exists=false when absent (safe to create), identical=true when a
 * re-declare would be a harmless no-op, and requiresRecreate=true when a field
 * differs — because RabbitMQ cannot alter it in place.
 */
export async function diffQueueDeclaration(conn: RabbitConnection, d: QueueDeclaration): Promise<DeclarationDiff> {
  let actual: Record<string, unknown> | null = null;
  try {
    actual = await mgmt<Record<string, unknown>>(conn, `/api/queues/${vh(d.vhost)}/${encodeURIComponent(d.name)}`);
  } catch (e) {
    // 404 → does not exist yet. Anything else is a real failure worth surfacing.
    if (!/not found \(404\)/i.test((e as Error).message)) throw e;
  }
  if (!actual) return { exists: false, identical: false, requiresRecreate: false, fields: [] };

  const fields: DiffField[] = [
    mkField('durable', String(d.durable), String(!!actual.durable)),
    mkField('auto_delete', String(d.autoDelete), String(!!actual.auto_delete)),
    mkField('arguments', argsKey(d.arguments), argsKey(actual.arguments as Record<string, unknown>)),
  ];
  const identical = fields.every((f) => f.equal);
  return { exists: true, identical, requiresRecreate: !identical, fields };
}

export async function diffExchangeDeclaration(conn: RabbitConnection, d: ExchangeDeclaration): Promise<DeclarationDiff> {
  let actual: Record<string, unknown> | null = null;
  try {
    actual = await mgmt<Record<string, unknown>>(conn, `/api/exchanges/${vh(d.vhost)}/${encodeURIComponent(d.name)}`);
  } catch (e) {
    if (!/not found \(404\)/i.test((e as Error).message)) throw e;
  }
  if (!actual) return { exists: false, identical: false, requiresRecreate: false, fields: [] };

  const fields: DiffField[] = [
    mkField('type', d.type, String(actual.type ?? '')),
    mkField('durable', String(d.durable), String(!!actual.durable)),
    mkField('auto_delete', String(d.autoDelete), String(!!actual.auto_delete)),
    mkField('internal', String(d.internal), String(!!actual.internal)),
    mkField('arguments', argsKey(d.arguments), argsKey(actual.arguments as Record<string, unknown>)),
  ];
  const identical = fields.every((f) => f.equal);
  return { exists: true, identical, requiresRecreate: !identical, fields };
}

function mkField(field: string, desired: string, actual: string): DiffField {
  return { field, desired, actual, equal: desired === actual };
}
