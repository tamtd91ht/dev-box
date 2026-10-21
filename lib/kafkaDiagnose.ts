// Server-only: phân tích lag của MỘT consumer group Kafka — phần GOM SỐ LIỆU.
//
// Chỉ ĐỌC (admin API + một Fetch đọc message đang chờ), không đổi gì trên cụm:
//   • Hai lần đo cách nhau `seconds` giây: offset đã commit + log-end (READ_COMMITTED,
//     cùng cách với tab Kafka) từng partition → tốc độ sản xuất / tiêu thụ thật.
//   • describeGroups ở đầu / giữa / cuối cửa sổ → rebalance, member vào/ra.
//   • Giải mã assignment của consumer protocol → partition nào do consumer nào giữ.
//   • Metadata (số partition, leader) + retention / cleanup.policy của topic.
//   • Tuổi message chờ lâu nhất (đọc record đầu tiên chưa commit của vài partition lag nặng).
// Luật biến số liệu thành kết luận nằm ở lib/kafkaDiagnoseRules (thuần, kiểm được).

import { AssignerProtocol, ConfigResourceTypes, type GroupDescription } from 'kafkajs';
import type { KafkaConnection } from '@/lib/kafkaConnections';
import { firstPendingRecord, getAdmin, topicHighWatermarks } from '@/lib/kafkaClient';
import {
  analyzeKafkaLag,
  type KafkaLagDiagnosis, type KafkaLagFacts, type KMember, type KPartition, type KTopic,
} from '@/lib/kafkaDiagnoseRules';

const MIN_SEC = 5;
const MAX_SEC = 30;
/** Số partition lag nặng nhất được đọc message đang chờ để đo tuổi. */
const AGE_PROBES = 3;
/** Producer lệch đồng hồ quá mức này thì bỏ số tuổi (giống kafkaClient). */
const AGE_SANE_MAX_MS = 400 * 24 * 3600 * 1000;

interface Sample {
  at: number;
  group: GroupDescription | undefined;
  committed: Map<string, number | null>;
  ends: Map<string, number>;
  topics: string[];
}

const key = (topic: string, partition: number): string => `${topic}:${partition}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sample(conn: KafkaConnection, groupId: string): Promise<Sample> {
  const admin = await getAdmin(conn);
  const [desc, offsets] = await Promise.all([
    admin.describeGroups([groupId]),
    admin.fetchOffsets({ groupId }),
  ]);
  const committed = new Map<string, number | null>();
  for (const t of offsets) {
    for (const p of t.partitions) {
      const n = Number(p.offset);
      committed.set(key(t.topic, p.partition), n < 0 ? null : n);
    }
  }
  const topics = offsets.map((t) => t.topic);
  const ends = new Map<string, number>();
  const highs = await Promise.all(topics.map((t) => topicHighWatermarks(conn, t).then((m) => [t, m] as const)));
  for (const [t, m] of highs) for (const [p, off] of m) ends.set(key(t, p), off);
  return { at: Date.now(), group: desc.groups[0], committed, ends, topics };
}

/** "clientId@host" — host của kafkajs có dấu "/" ở đầu (/10.0.0.5). */
const label = (m: { clientId: string; clientHost: string }): string => `${m.clientId}@${m.clientHost.replace(/^\//, '')}`;

export async function diagnoseLag(conn: KafkaConnection, groupId: string, seconds: number): Promise<KafkaLagDiagnosis> {
  if (!groupId) throw new Error('groupId is required');
  const sec = Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(Number(seconds) || 15)));
  const admin = await getAdmin(conn);

  const s0 = await sample(conn, groupId);
  if (!s0.group || (s0.group.state === 'Dead' && s0.topics.length === 0)) {
    throw new Error(`Không tìm thấy group ${groupId} (hoặc group chưa commit offset nào)`);
  }
  await sleep(Math.max(0, s0.at + (sec * 1000) / 2 - Date.now()));
  const mid = (await admin.describeGroups([groupId]).catch(() => null))?.groups[0];
  await sleep(Math.max(0, s0.at + sec * 1000 - Date.now()));
  const s1 = await sample(conn, groupId);

  const states: string[] = [s0.group?.state, mid?.state, s1.group?.state].filter((x) => !!x).map(String);
  const ids = (g: GroupDescription | undefined) => (g?.members ?? []).map((m) => m.memberId).sort().join(',');
  const membersChanged = ids(s0.group) !== ids(s1.group) || (!!mid && ids(mid) !== ids(s1.group));

  // Phân công partition: chỉ giải mã được với consumer protocol (subscribe). Group
  // dùng assign() tay (protocolType rỗng) thì không có — luật bỏ qua phần đó.
  const owner = new Map<string, string>();
  let assignmentKnown = s1.group?.protocolType === 'consumer';
  const members: KMember[] = (s1.group?.members ?? []).map((m) => {
    let assigned = 0;
    try {
      const a = AssignerProtocol.MemberAssignment.decode(m.memberAssignment);
      for (const [topic, parts] of Object.entries(a?.assignment ?? {})) {
        for (const p of parts) { owner.set(key(topic, p), label(m)); assigned++; }
      }
    } catch {
      assignmentKnown = false;
    }
    return { memberId: m.memberId, clientId: m.clientId, host: m.clientHost.replace(/^\//, ''), assigned };
  });

  // Metadata + cấu hình topic.
  const topicNames = [...new Set([...s0.topics, ...s1.topics])];
  const meta = topicNames.length ? await admin.fetchTopicMetadata({ topics: topicNames }).catch(() => ({ topics: [] })) : { topics: [] };
  const leaderOf = new Map<string, boolean>();
  const partCount = new Map<string, number>();
  for (const t of meta.topics) {
    partCount.set(t.name, t.partitions.length);
    for (const p of t.partitions) leaderOf.set(key(t.name, p.partitionId), p.leader >= 0);
  }
  const conf = new Map<string, { retentionMs: number | null; compact: boolean }>();
  try {
    const res = await admin.describeConfigs({
      includeSynonyms: false,
      resources: topicNames.map((name) => ({ type: ConfigResourceTypes.TOPIC, name, configNames: ['retention.ms', 'cleanup.policy'] })),
    });
    for (const r of res.resources) {
      const get = (n: string) => r.configEntries.find((e) => e.configName === n)?.configValue;
      const ret = Number(get('retention.ms'));
      conf.set(r.resourceName, { retentionMs: Number.isFinite(ret) ? ret : null, compact: /compact/.test(get('cleanup.policy') ?? '') });
    }
  } catch {
    /* thiếu quyền DescribeConfigs — bỏ phần retention */
  }
  const topics: KTopic[] = topicNames.map((name) => ({
    name,
    partitions: partCount.get(name) ?? 0,
    retentionMs: conf.get(name)?.retentionMs ?? null,
    compact: conf.get(name)?.compact ?? false,
  }));

  const partitions: KPartition[] = [...new Set([...s0.committed.keys(), ...s1.committed.keys()])].map((k) => {
    const i = k.lastIndexOf(':');
    const topic = k.slice(0, i);
    const partition = Number(k.slice(i + 1));
    return {
      topic,
      partition,
      owner: owner.get(k) ?? null,
      committed0: s0.committed.get(k) ?? null,
      committed1: s1.committed.get(k) ?? null,
      end0: s0.ends.get(k) ?? 0,
      end1: s1.ends.get(k) ?? 0,
      hasLeader: leaderOf.get(k) ?? true,
    };
  });

  // Tuổi message chờ lâu nhất — đọc record đầu tiên chưa commit của vài partition lag nặng.
  let oldest: KafkaLagFacts['oldest'] = null;
  const heavy = partitions
    .filter((p) => p.committed1 !== null && p.end1 > p.committed1)
    .sort((a, b) => (b.end1 - (b.committed1 ?? 0)) - (a.end1 - (a.committed1 ?? 0)))
    .slice(0, AGE_PROBES);
  for (const p of heavy) {
    const probe = await firstPendingRecord(conn, p.topic, p.partition, p.committed1!);
    if (probe.kind !== 'record' || probe.timestamp === null) continue;
    const age = Date.now() - probe.timestamp;
    if (age < 0 || age > AGE_SANE_MAX_MS) continue;
    if (!oldest || age / 1000 > oldest.ageSec) oldest = { topic: p.topic, partition: p.partition, ageSec: Math.round(age / 1000) };
  }

  const facts: KafkaLagFacts = {
    groupId,
    sec: Math.max(1, Math.round((s1.at - s0.at) / 1000)),
    states,
    membersChanged,
    members,
    assignmentKnown,
    partitions,
    topics,
    oldest,
  };
  return analyzeKafkaLag(facts);
}
