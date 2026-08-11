// DevBox Automation — where the log actually goes. SERVER ONLY.
//
// One entry point (`writeLogEntry`) that both the `log` action and the settings
// panel's "ghi thử" call, so what you test is what runs at 2am.
//
// TWO TARGETS, chosen in the settings panel:
//
//   local  a JSONL file next to the config, pruned after N days. Enough to
//          answer "what fired last night" on this machine.
//   mongo  documents in a collection. History that outlives this machine and
//          can be queried — and, unlike the file, is reachable from anywhere.
//
// WHY MONGO IS ADDRESSED BY REGISTRY ID rather than a connection string kept
// here: credentials then live in exactly ONE place (configs/mongoconnections.json),
// the Mongo tab already knows how to test and edit them, and this config never
// carries a password. A connection typed into the log panel is SAVED into that
// registry first — which is what makes it appear in the Mongo tab as well.
//
// RETENTION on Mongo is deliberately NOT enforced from here. Deleting documents
// on a shared cluster behind its owners' backs is not a local tool's call; the
// panel offers to create a TTL index instead, which is Mongo's own mechanism and
// visible to anyone inspecting the collection.

import type { Collection, Db, Document } from 'mongodb';
import { getConnection } from '@/lib/mongoConnections';
import { internalClient } from '@/lib/mongoClient';
import { appendLocalLog } from './store';
import type { LogStoreConfig } from './types';

export const DEFAULT_LOG_DB = 'devbox';
export const DEFAULT_LOG_COLLECTION = 'automation_log';

/** Field the TTL index is built on. */
export const TTL_FIELD = 'at';

export interface LogWriteResult {
  target: 'local' | 'mongo';
  /** File name, or `db.collection`. */
  where: string;
}

/**
 * One log record, shaped so REPORTS are possible without reprocessing.
 *
 * The first version stored the whole `AutomationEvent` nested under `event`, which
 * logs fine and reports terribly: `fields.value` is `string | number` there, so
 * "average heap when ES alerted" cannot be aggregated without cleaning every
 * document first. Here the few things a report actually groups by — severity,
 * stack, instance, metric — are top-level and typed, `value`/`threshold` are
 * always numbers, and the free-form remainder stays in `fields` for reference.
 *
 * Every field is optional except `at`/`kind`, because social and infra events
 * carry different halves of this and a report must be able to filter on `kind`
 * rather than guess from which fields exist.
 */
export interface LogEntry {
  /** BSON date in Mongo, ISO string in the local file. */
  at: Date | string;
  /** Event category — the first thing every report filters on. */
  kind: 'infra' | 'social' | 'system';
  /** Dotted trigger type ('infra.metric', 'infra.recovered', 'message.received'). */
  type: string;
  ruleId: string;
  rule: string;
  /** Was this a real firing or a dry run? Reports must not count rehearsals. */
  dryRun: boolean;
  title: string;
  text: string;
  /** Plugin id or stack id ('redis', 'zalo'). */
  source: string;
  /** Connection/account id, and its human label. */
  instanceId: string;
  instance: string;

  // ── infra only ──
  severity?: 'critical' | 'warning' | 'info';
  stack?: string;
  metric?: string;
  /** Numbers, always — this is what makes avg/max/percentile possible. */
  value?: number;
  threshold?: number;
  op?: string;
  watchId?: string;
  watch?: string;
  /** infra.recovered: how long the breach lasted. Powers MTTR. */
  downSec?: number;
  tags?: string[];

  /** Everything else from the event, unmodelled. Reference, not report input. */
  fields?: Record<string, string | number>;
}

const SEVERITIES = new Set(['critical', 'warning', 'info']);
const numOrUndef = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  // Number('') and Number(' ') are both 0 — storing that would report a missing
  // threshold as a real zero, which is worse than reporting nothing.
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const strOrUndef = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  return s || undefined;
};

/** Flatten an event + the rule that matched it into a reportable record. */
export function buildLogEntry(
  event: {
    category: string;
    type: string;
    title: string;
    text: string;
    sourceId: string;
    instanceId: string;
    instanceLabel: string;
    fields?: Record<string, string | number>;
  },
  rule: { ruleId: string; ruleName: string; dryRun?: boolean },
  at: Date = new Date(),
): LogEntry {
  const f = event.fields ?? {};
  const sev = strOrUndef(f.severity);
  const tags = strOrUndef(f.tags);
  return {
    at,
    kind: event.category === 'infra' || event.category === 'social' ? event.category : 'system',
    type: event.type,
    ruleId: rule.ruleId,
    rule: rule.ruleName,
    dryRun: !!rule.dryRun,
    title: event.title,
    text: event.text,
    source: event.sourceId,
    instanceId: event.instanceId,
    instance: event.instanceLabel,
    ...(sev && SEVERITIES.has(sev) ? { severity: sev as LogEntry['severity'] } : {}),
    ...(strOrUndef(f.stack) ? { stack: strOrUndef(f.stack) } : {}),
    ...(strOrUndef(f.metric) ? { metric: strOrUndef(f.metric) } : {}),
    ...(numOrUndef(f.value) !== undefined ? { value: numOrUndef(f.value) } : {}),
    ...(numOrUndef(f.threshold) !== undefined ? { threshold: numOrUndef(f.threshold) } : {}),
    ...(strOrUndef(f.op) ? { op: strOrUndef(f.op) } : {}),
    ...(strOrUndef(f.watchId) ? { watchId: strOrUndef(f.watchId) } : {}),
    ...(strOrUndef(f.watch) ? { watch: strOrUndef(f.watch) } : {}),
    ...(numOrUndef(f.downSec) !== undefined ? { downSec: numOrUndef(f.downSec) } : {}),
    ...(tags ? { tags: tags.split(',').filter(Boolean) } : {}),
    fields: f,
  };
}

/** The collection plus its Db handle — `ensureMongoTtl` needs collMod. */
async function logHandles(cfg: LogStoreConfig): Promise<{ coll: Collection<Document>; db: Db; name: string }> {
  if (!cfg.connectionId) throw new Error('Chưa chọn kết nối MongoDB cho log.');
  const conn = await getConnection(cfg.connectionId);
  if (!conn) {
    throw new Error('Kết nối MongoDB đã bị xoá khỏi danh sách quản lý Mongo — chọn lại.');
  }
  const name = cfg.collection || DEFAULT_LOG_COLLECTION;
  const db = internalClient(conn).db(cfg.database || DEFAULT_LOG_DB);
  return { coll: db.collection(name), db, name };
}

async function logCollection(cfg: LogStoreConfig): Promise<Collection<Document>> {
  return (await logHandles(cfg)).coll;
}

/**
 * Write one entry to whichever target is configured.
 *
 * THROWS on failure — the caller turns that into an `error` outcome in the
 * activity feed. Swallowing it would leave logging silently off, which is the
 * one failure mode a log must not have.
 */
export async function writeLogEntry(cfg: LogStoreConfig, entry: LogEntry): Promise<LogWriteResult> {
  if (cfg.target === 'mongo') {
    const coll = await logCollection(cfg);
    // A real Date, not the ISO string the local file keeps: Mongo can only
    // range-query and TTL-expire on a BSON date.
    const at = entry.at instanceof Date ? entry.at : new Date(entry.at);
    await coll.insertOne({ ...entry, at });
    return { target: 'mongo', where: `${cfg.database || DEFAULT_LOG_DB}.${cfg.collection || DEFAULT_LOG_COLLECTION}` };
  }
  // JSONL keeps ISO — a text log has to stay readable with `tail`.
  const at = entry.at instanceof Date ? entry.at.toISOString() : entry.at;
  const name = await appendLocalLog(cfg.file, cfg.retentionDays ?? 7, { ...entry, at });
  return { target: 'local', where: name };
}

/**
 * Indexes the report queries need. Created on demand from the settings panel
 * rather than on every write: index creation is idempotent but not free, and a
 * log that is only ever tailed does not need them.
 */
export async function ensureReportIndexes(cfg: LogStoreConfig): Promise<string[]> {
  const coll = await logCollection(cfg);
  return coll.createIndexes([
    // Every report is "this window, this category" — the compound order matters.
    { key: { kind: 1, at: -1 }, name: 'rpt_kind_at' },
    // "Which watch fired most", "MTTR per watch".
    { key: { watchId: 1, at: -1 }, name: 'rpt_watch_at' },
    // "Noisiest cluster", "alerts per stack".
    { key: { stack: 1, instanceId: 1, at: -1 }, name: 'rpt_stack_instance_at' },
    { key: { severity: 1, at: -1 }, name: 'rpt_severity_at' },
  ]);
}

// ── Reports ─────────────────────────────────────────────────────────────────
//
// Five questions an operator actually asks after a rough week. Each is one
// aggregation over the indexes above, and each EXCLUDES dry-run records — a
// rehearsal is not an incident and must never pad the numbers.
//
//   1. noisiest    which watches fire most        → what to re-tune or delete
//   2. byStack     alerts per stack/cluster       → where the trouble lives
//   3. mttr        breach → recovered, per watch  → how long problems last
//   4. timeline    alerts per hour/day            → is it getting worse?
//   5. flapping    fire/recover churn per watch   → thresholds sitting too close
//
// `noisiest` is the one to read first: a monitoring setup fails by being ignored,
// and it gets ignored because a handful of watches produce most of the volume.

export type ReportKind = 'noisiest' | 'byStack' | 'mttr' | 'timeline' | 'flapping';

export interface ReportRow {
  key: string;
  /** Second grouping level, when the report has one (cluster under stack). */
  sub?: string;
  count: number;
  /** mttr: seconds. timeline: bucket size is in the row key. */
  avgSec?: number;
  maxSec?: number;
  avgValue?: number;
  maxValue?: number;
  critical?: number;
  warning?: number;
  info?: number;
  recovered?: number;
}

export interface ReportResult {
  kind: ReportKind;
  fromMs: number;
  toMs: number;
  /** Total non-dry-run records in the window, so a row's share is readable. */
  total: number;
  rows: ReportRow[];
}

/** Only real firings count. A dry run is a rehearsal, not an incident. */
const REAL = { dryRun: { $ne: true } };

export async function runReport(
  cfg: LogStoreConfig,
  kind: ReportKind,
  fromMs: number,
  toMs: number,
  limit = 25,
): Promise<ReportResult> {
  const coll = await logCollection(cfg);
  const window = { at: { $gte: new Date(fromMs), $lte: new Date(toMs) } };
  const base = { ...window, ...REAL };
  const cap = Math.min(200, Math.max(1, limit));

  const total = await coll.countDocuments(base);
  let rows: ReportRow[] = [];

  if (kind === 'noisiest') {
    const raw = (await coll
      .aggregate([
        { $match: { ...base, kind: 'infra', type: 'infra.metric' } },
        {
          $group: {
            _id: { watch: { $ifNull: ['$watch', '$title'] }, instance: '$instance' },
            count: { $sum: 1 },
            avgValue: { $avg: '$value' },
            maxValue: { $max: '$value' },
            critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
            warning: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
            info: { $sum: { $cond: [{ $eq: ['$severity', 'info'] }, 1, 0] } },
          },
        },
        { $sort: { count: -1 } },
        { $limit: cap },
      ])
      .toArray()) as Document[];
    rows = raw.map((r) => ({
      key: String((r._id as Document).watch ?? '—'),
      sub: String((r._id as Document).instance ?? ''),
      count: r.count as number,
      avgValue: round2(r.avgValue as number),
      maxValue: round2(r.maxValue as number),
      critical: r.critical as number,
      warning: r.warning as number,
      info: r.info as number,
    }));
  } else if (kind === 'byStack') {
    const raw = (await coll
      .aggregate([
        { $match: { ...base, kind: 'infra' } },
        {
          $group: {
            _id: { stack: '$stack', instance: '$instance' },
            count: { $sum: 1 },
            critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
            warning: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
            info: { $sum: { $cond: [{ $eq: ['$severity', 'info'] }, 1, 0] } },
            recovered: { $sum: { $cond: [{ $eq: ['$type', 'infra.recovered'] }, 1, 0] } },
          },
        },
        { $sort: { count: -1 } },
        { $limit: cap },
      ])
      .toArray()) as Document[];
    rows = raw.map((r) => ({
      key: String((r._id as Document).stack ?? '—'),
      sub: String((r._id as Document).instance ?? ''),
      count: r.count as number,
      critical: r.critical as number,
      warning: r.warning as number,
      info: r.info as number,
      recovered: r.recovered as number,
    }));
  } else if (kind === 'mttr') {
    // downSec is carried by infra.recovered, so MTTR needs no join back to the
    // breach — the watcher already measured the gap.
    const raw = (await coll
      .aggregate([
        { $match: { ...base, type: 'infra.recovered', downSec: { $gt: 0 } } },
        {
          $group: {
            _id: { watch: { $ifNull: ['$watch', '$title'] }, instance: '$instance' },
            count: { $sum: 1 },
            avgSec: { $avg: '$downSec' },
            maxSec: { $max: '$downSec' },
          },
        },
        { $sort: { avgSec: -1 } },
        { $limit: cap },
      ])
      .toArray()) as Document[];
    rows = raw.map((r) => ({
      key: String((r._id as Document).watch ?? '—'),
      sub: String((r._id as Document).instance ?? ''),
      count: r.count as number,
      avgSec: Math.round(r.avgSec as number),
      maxSec: r.maxSec as number,
    }));
  } else if (kind === 'timeline') {
    // Hourly buckets under ~3 days, daily above — an 8-week chart of hours is
    // unreadable, and a 6-hour chart of days is a single bar.
    const hourly = toMs - fromMs <= 3 * 24 * 3600e3;
    const fmt = hourly ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
    const raw = (await coll
      .aggregate([
        { $match: base },
        {
          $group: {
            _id: { $dateToString: { format: fmt, date: '$at' } },
            count: { $sum: 1 },
            critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
            warning: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
            info: { $sum: { $cond: [{ $eq: ['$severity', 'info'] }, 1, 0] } },
            recovered: { $sum: { $cond: [{ $eq: ['$type', 'infra.recovered'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 400 },
      ])
      .toArray()) as Document[];
    rows = raw.map((r) => ({
      key: String(r._id),
      count: r.count as number,
      critical: r.critical as number,
      warning: r.warning as number,
      info: r.info as number,
      recovered: r.recovered as number,
    }));
  } else {
    // flapping: a watch that alerts AND recovers repeatedly is a threshold sitting
    // right at the working range — the fix is the threshold, not the cluster.
    const raw = (await coll
      .aggregate([
        { $match: { ...base, kind: 'infra' } },
        {
          $group: {
            _id: { watch: { $ifNull: ['$watch', '$title'] }, instance: '$instance' },
            count: { $sum: 1 },
            recovered: { $sum: { $cond: [{ $eq: ['$type', 'infra.recovered'] }, 1, 0] } },
            avgSec: { $avg: '$downSec' },
          },
        },
        { $match: { recovered: { $gte: 3 } } },
        { $sort: { recovered: -1 } },
        { $limit: cap },
      ])
      .toArray()) as Document[];
    rows = raw.map((r) => ({
      key: String((r._id as Document).watch ?? '—'),
      sub: String((r._id as Document).instance ?? ''),
      count: r.count as number,
      recovered: r.recovered as number,
      avgSec: r.avgSec != null ? Math.round(r.avgSec as number) : undefined,
    }));
  }

  return { kind, fromMs, toMs, total, rows };
}

const round2 = (n: number | null | undefined): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;

export interface MongoLogStats {
  where: string;
  documents: number;
  /** ISO of the oldest entry, when there is one. */
  oldest?: string;
  /** Seconds configured on the TTL index, when one exists. */
  ttlSeconds?: number;
}

export async function mongoLogStats(cfg: LogStoreConfig): Promise<MongoLogStats> {
  const coll = await logCollection(cfg);
  const where = `${cfg.database || DEFAULT_LOG_DB}.${cfg.collection || DEFAULT_LOG_COLLECTION}`;
  const [documents, first, indexes] = await Promise.all([
    coll.estimatedDocumentCount(),
    coll.find({}, { sort: { [TTL_FIELD]: 1 }, limit: 1, projection: { [TTL_FIELD]: 1 } }).toArray(),
    coll.indexes().catch(() => [] as Document[]),
  ]);
  const ttl = indexes.find(
    (i) => (i as Document).expireAfterSeconds !== undefined && (i as Document).key?.[TTL_FIELD] !== undefined,
  ) as { expireAfterSeconds?: number } | undefined;
  const oldestAt = (first[0] as Document | undefined)?.[TTL_FIELD];
  return {
    where,
    documents,
    oldest: oldestAt instanceof Date ? oldestAt.toISOString() : undefined,
    ttlSeconds: ttl?.expireAfterSeconds,
  };
}

/**
 * Ask Mongo to expire log documents after `days`.
 *
 * Mongo refuses to change `expireAfterSeconds` by re-creating the index, so an
 * existing TTL is adjusted with collMod instead of a drop/create — dropping it
 * first would leave the collection unbounded if the re-create then failed.
 */
export async function ensureMongoTtl(cfg: LogStoreConfig, days: number): Promise<number> {
  const { coll, db, name } = await logHandles(cfg);
  const seconds = Math.max(1, Math.floor(days)) * 24 * 60 * 60;
  const existing = (await coll.indexes().catch(() => [] as Document[])).find(
    (i) => (i as Document).expireAfterSeconds !== undefined && (i as Document).key?.[TTL_FIELD] !== undefined,
  ) as { name?: string; expireAfterSeconds?: number } | undefined;

  if (!existing) {
    await coll.createIndex({ [TTL_FIELD]: 1 }, { expireAfterSeconds: seconds, name: 'automation_log_ttl' });
    return seconds;
  }
  if (existing.expireAfterSeconds === seconds) return seconds;
  await db.command({ collMod: name, index: { name: existing.name, expireAfterSeconds: seconds } });
  return seconds;
}
