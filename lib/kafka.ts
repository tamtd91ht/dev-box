// Client-side helpers + shared types for the Kafka workspace. All calls go to the
// same-origin /api/kafka* routes (the Next server holds the kafkajs connection —
// the browser never talks to Kafka directly). This file is browser-safe: NO `fs`,
// NO `kafkajs`, no server-only imports.

/** A Kafka connection as returned to the browser. */
export interface PublicKafkaConnection {
  id: string;
  name: string;
  project: string;
  brokers: string[];
  /** Optional node_exporter endpoints powering host metrics in the monitor. */
  metricsUrls?: string[];
}

/** Body for add/update. */
export interface KafkaConnectionInput {
  id?: string;
  name: string;
  project: string;
  /** Array of "host:port", or a comma/newline-separated string. */
  brokers: string[] | string;
}

export interface KafkaConnectionsResponse {
  enabled: boolean;
  connections: PublicKafkaConnection[];
}

export interface TopicSummary {
  name: string;
  partitions: number;
  replicationFactor: number;
  internal: boolean;
}

export interface PartitionDetail {
  partition: number;
  leader: number;
  replicas: number[];
  isr: number[];
  low: number;
  high: number;
  count: number;
}

export interface TopicDetail {
  name: string;
  partitions: PartitionDetail[];
  totalMessages: number;
}

export interface GroupSummary {
  groupId: string;
  protocolType: string;
  state: string;
  members: number;
}

export interface GroupPartitionLag {
  partition: number;
  committed: number | null;
  logEnd: number;
  lag: number | null;
}

export interface GroupTopicLag {
  topic: string;
  partitions: GroupPartitionLag[];
  totalLag: number;
}

export interface GroupDetail {
  groupId: string;
  state: string;
  members: { memberId: string; clientId: string; clientHost: string }[];
  topics: GroupTopicLag[];
  totalLag: number;
}

/** One consumer group that has committed offsets on a given topic, with its lag. */
export interface TopicConsumerGroup {
  groupId: string;
  state: string;
  members: number;
  totalLag: number;
  partitions: GroupPartitionLag[];
}

export interface PreviewMessage {
  partition: number;
  offset: string;
  timestamp: number;
  key: string | null;
  value: string | null;
  valueTruncated: boolean;
}

export interface MessagePage {
  messages: PreviewMessage[];
  scanned: number;
  truncated: boolean;
  /** Optional human note (e.g. the time window mapped to an empty offset range). */
  note?: string;
}

export interface TestResult {
  latencyMs: number;
  brokers: number;
}

// ── Connection registry (CRUD) ────────────────────────────────────────────────

/** GET the connection list — never throws; returns disabled on any error. */
export async function fetchKafkaConnections(): Promise<KafkaConnectionsResponse> {
  try {
    const r = await fetch('/api/kafka-connections');
    if (!r.ok) return { enabled: false, connections: [] };
    return (await r.json()) as KafkaConnectionsResponse;
  } catch {
    return { enabled: false, connections: [] };
  }
}

/** POST/PUT/DELETE a connection mutation. Throws Error(message) on a non-2xx. */
export async function mutateKafkaConnection(
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<PublicKafkaConnection[]> {
  const r = await fetch('/api/kafka-connections', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { connections: PublicKafkaConnection[] }).connections;
}

// ── Kafka operations ────────────────────────────────────────────────────────────

/** POST one Kafka action. Throws Error(message) on failure (surfaces Kafka error). */
async function kafkaAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/kafka', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

/** Test a not-yet-saved connection straight from the form. */
export function testKafkaConnection(brokers: string[] | string): Promise<TestResult> {
  return kafkaAction<TestResult>('test', { brokers });
}

export interface KafkaBrokerInfo {
  nodeId: number;
  addr: string;
  isController: boolean;
  leaderPartitions: number;
}

export interface KafkaClusterHealth {
  brokers: KafkaBrokerInfo[];
  controllerId: number | null;
  topicCount: number;
  partitionCount: number;
  underReplicated: number;
  offline: number;
  affectedTopics: string[];
}

/** Brokers + under-replicated/offline partition counts (60s monitor). */
export function kafkaClusterHealth(connectionId: string): Promise<KafkaClusterHealth> {
  return kafkaAction<KafkaClusterHealth>('clusterHealth', { connectionId });
}

export interface KafkaDiskMount {
  mount: string;
  sizeBytes: number;
  availBytes: number;
}

export interface KafkaHostMetrics {
  url: string;
  host: string;
  error?: string;
  load1?: number;
  load5?: number;
  load15?: number;
  memTotalBytes?: number;
  memAvailableBytes?: number;
  disks?: KafkaDiskMount[];
  cpuIdleSec?: number;
  cpuTotalSec?: number;
  at: number;
}

/** node_exporter RAM/disk/cpu/load per configured metrics URL. */
export function kafkaHostMetrics(connectionId: string): Promise<KafkaHostMetrics[]> {
  return kafkaAction<KafkaHostMetrics[]>('hostMetrics', { connectionId });
}

export function listKafkaTopics(connectionId: string): Promise<TopicSummary[]> {
  return kafkaAction<TopicSummary[]>('listTopics', { connectionId });
}

export function describeKafkaTopic(connectionId: string, topic: string): Promise<TopicDetail> {
  return kafkaAction<TopicDetail>('describeTopic', { connectionId, topic });
}

export function listKafkaGroups(connectionId: string): Promise<GroupSummary[]> {
  return kafkaAction<GroupSummary[]>('listGroups', { connectionId });
}

export function describeKafkaGroup(connectionId: string, groupId: string): Promise<GroupDetail> {
  return kafkaAction<GroupDetail>('describeGroup', { connectionId, groupId });
}

/** One consumer group's lag, as returned by the cluster-wide sweep. */
export interface GroupLagSummary {
  groupId: string;
  state: string;
  members: number;
  /** False when describeGroups failed: `members`/`state` are UNKNOWN, not measured. */
  described: boolean;
  totalLag: number;
  worstTopic: string | null;
  worstTopicLag: number;
  partitions: number;
  /** Seconds the group's committed offsets have not moved; null = moving / first sight. */
  stalledSec: number | null;
  /** This group alone failed — its lag is UNKNOWN, not zero. */
  error?: string;
}

export interface KafkaConsumerLag {
  at: number;
  groups: GroupLagSummary[];
  skippedGroups: number;
}

/**
 * Lag for EVERY consumer group in one sweep, plus how long each has been stuck.
 * Cheaper than describeGroup-per-group: high watermarks are fetched once per
 * distinct topic. This is the call the automation probe uses.
 */
export function kafkaConsumerLag(connectionId: string): Promise<KafkaConsumerLag> {
  return kafkaAction<KafkaConsumerLag>('consumerLag', { connectionId });
}

/** Consumer groups that consume THIS topic (have committed offsets), with per-partition lag. */
export function listKafkaTopicGroups(connectionId: string, topic: string): Promise<TopicConsumerGroup[]> {
  return kafkaAction<TopicConsumerGroup[]>('topicGroups', { connectionId, topic });
}

export function peekKafkaMessages(connectionId: string, topic: string, limit: number): Promise<MessagePage> {
  return kafkaAction<MessagePage>('peek', { connectionId, topic, limit });
}

/** Search REQUIRES a time window (fromMs/toMs) AND a keyword. */
export function searchKafkaMessages(
  connectionId: string,
  input: { topic: string; fromMs: number; toMs: number; keyword: string },
): Promise<MessagePage> {
  return kafkaAction<MessagePage>('search', { connectionId, ...input });
}

export function produceKafkaMessage(
  connectionId: string,
  input: { topic: string; key?: string; value: string; partition?: number },
): Promise<{ partition: number; offset: string }> {
  return kafkaAction<{ partition: number; offset: string }>('produce', { connectionId, ...input });
}

// ── Small shared formatters (used by the workspace UI) ──────────────────────────

/** Humanize a large integer with thousands separators. */
export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Format an epoch-millis timestamp for display (local time). */
export function fmtTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return d.toLocaleString('sv-SE'); // YYYY-MM-DD HH:mm:ss
}
