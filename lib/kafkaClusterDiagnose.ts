// Server-only: phân tích sức khoẻ cụm / replication Kafka — phần GOM SỐ LIỆU.
//
// AN TOÀN CHO PRODUCTION — chỉ các lệnh admin ĐỌC metadata, nhẹ với broker:
//   • DescribeCluster (broker, controller).
//   • Metadata của mọi topic (leader / replicas / ISR từng partition) — cùng lệnh
//     mà producer / consumer gọi định kỳ.
//   • DescribeConfigs của topic, chỉ hỏi min.insync.replicas, theo lô CONFIG_BATCH,
//     tối đa CONFIG_MAX topic.
// Không đọc message, không join consumer group, không đổi cấu hình.
// Luật biến số liệu thành kết luận nằm ở lib/kafkaClusterRules (thuần).

import { ConfigResourceTypes } from 'kafkajs';
import type { KafkaConnection } from '@/lib/kafkaConnections';
import { getAdmin } from '@/lib/kafkaClient';
import { analyzeKafkaCluster, type KafkaClusterDiagnosis, type KcPartition, type KcTopic } from '@/lib/kafkaClusterRules';

const CONFIG_BATCH = 100;
const CONFIG_MAX = 2_000;
const TIMEOUT_MS = 15_000;
/** Topic nội bộ đáng kiểm (offset của group, transaction). */
const INTERNAL = new Set(['__consumer_offsets', '__transaction_state']);

const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([
  p,
  new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: quá ${TIMEOUT_MS / 1000}s không trả lời`)), TIMEOUT_MS)),
]);

export async function diagnoseKafkaCluster(conn: KafkaConnection): Promise<KafkaClusterDiagnosis> {
  const admin = await getAdmin(conn);
  const cluster = await withTimeout(admin.describeCluster(), 'DescribeCluster');
  const names = (await withTimeout(admin.listTopics(), 'ListTopics'))
    .filter((n) => !n.startsWith('__') || INTERNAL.has(n));
  const meta = names.length ? await withTimeout(admin.fetchTopicMetadata({ topics: names }), 'Metadata') : { topics: [] };

  const partitions: KcPartition[] = [];
  const rfOf = new Map<string, { partitions: number; rf: number }>();
  for (const t of meta.topics) {
    rfOf.set(t.name, { partitions: t.partitions.length, rf: t.partitions[0]?.replicas.length ?? 0 });
    for (const p of t.partitions) {
      partitions.push({
        topic: t.name, partition: p.partitionId, leader: p.leader,
        replicas: p.replicas ?? [], isr: p.isr ?? [], offlineReplicas: p.offlineReplicas ?? [],
      });
    }
  }

  // min.insync.replicas theo lô — thiếu quyền / lỗi thì bỏ phần này, vẫn phân tích phần còn lại.
  const minIsr = new Map<string, number>();
  let configNote: string | undefined;
  const confNames = names.slice(0, CONFIG_MAX);
  if (names.length > CONFIG_MAX) configNote = `Chỉ đọc cấu hình ${CONFIG_MAX} / ${names.length} topic`;
  for (let i = 0; i < confNames.length; i += CONFIG_BATCH) {
    try {
      const res = await withTimeout(admin.describeConfigs({
        includeSynonyms: false,
        resources: confNames.slice(i, i + CONFIG_BATCH).map((name) => ({ type: ConfigResourceTypes.TOPIC, name, configNames: ['min.insync.replicas'] })),
      }), 'DescribeConfigs');
      for (const r of res.resources) {
        const v = Number(r.configEntries.find((e) => e.configName === 'min.insync.replicas')?.configValue);
        if (Number.isFinite(v)) minIsr.set(r.resourceName, v);
      }
    } catch (e) {
      configNote = `DescribeConfigs lỗi: ${(e as Error).message}`;
      break;
    }
  }

  const topics: KcTopic[] = meta.topics.map((t) => ({
    name: t.name,
    partitions: rfOf.get(t.name)?.partitions ?? 0,
    rf: rfOf.get(t.name)?.rf ?? 0,
    minIsr: minIsr.get(t.name) ?? null,
  }));

  return analyzeKafkaCluster({
    brokers: cluster.brokers.map((b) => ({ nodeId: b.nodeId, addr: `${b.host}:${b.port}` })),
    controllerId: cluster.controller ?? null,
    topics,
    partitions,
    internalTopics: names.filter((n) => INTERNAL.has(n)),
    configNote,
  });
}
