// Kiểm luật lib/kafkaClusterRules bằng số liệu giả (thuần, không kết nối cụm).
// Chạy: npx tsx scripts/check-kafka-cluster.ts
import { analyzeKafkaCluster, type KafkaClusterFacts, type KcPartition } from '../lib/kafkaClusterRules';

let fail = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { fail++; console.error('✗', msg); } else console.log('✓', msg); };
const ids = (f: KafkaClusterFacts) => analyzeKafkaCluster(f, 0).findings.map((x) => x.id);

const brokers = [1, 2, 3].map((n) => ({ nodeId: n, addr: `b${n}:9092` }));
const parts = (topic: string, n: number, mk: (i: number) => Partial<KcPartition> = () => ({})): KcPartition[] =>
  Array.from({ length: n }, (_, i) => {
    const replicas = [1 + (i % 3), 1 + ((i + 1) % 3), 1 + ((i + 2) % 3)];
    return { topic, partition: i, leader: replicas[0], replicas, isr: [...replicas], offlineReplicas: [], ...mk(i) };
  });

// 1. Cụm khoẻ.
const healthy: KafkaClusterFacts = {
  brokers, controllerId: 1, internalTopics: ['__consumer_offsets'],
  topics: [{ name: 'orders', partitions: 30, rf: 3, minIsr: 2 }, { name: '__consumer_offsets', partitions: 50, rf: 3, minIsr: 2 }],
  partitions: [...parts('orders', 30), ...parts('__consumer_offsets', 50)],
};
ok(ids(healthy).join() === 'ok', 'cụm khoẻ → chỉ ok');

// 2. Broker 3 vắng: partition chỉ có replica ở 3 → offline; còn lại ISR thiếu 3.
const b3down: KafkaClusterFacts = {
  ...healthy,
  brokers: brokers.slice(0, 2),
  partitions: parts('orders', 30, (i) => {
    const replicas = [1 + (i % 3), 1 + ((i + 1) % 3), 1 + ((i + 2) % 3)];
    const isr = replicas.filter((r) => r !== 3);
    return { leader: replicas[0] === 3 ? replicas[1] : replicas[0], isr };
  }),
};
const r2 = ids(b3down);
ok(r2.includes('missing-broker') && r2.includes('urp') && !r2.includes('offline'), `broker vắng → missing + urp, không offline (${r2.join()})`);

// 3. Offline + dưới min ISR.
const off: KafkaClusterFacts = {
  ...healthy,
  partitions: parts('orders', 30, (i) => (i === 0 ? { leader: -1, isr: [] } : i === 1 ? { isr: [2] } : {})),
};
const d3 = analyzeKafkaCluster(off, 0);
ok(d3.offline === 1 && d3.underMinIsr === 1 && d3.findings[0].level === 'crit', `offline 1 + dưới min ISR 1 (${d3.findings.map((x) => x.id).join()})`);
ok(/offline/.test(d3.headline), 'headline nói offline');

// 4. Lệch leader: mọi leader dồn về broker 1.
const skew: KafkaClusterFacts = { ...healthy, partitions: parts('orders', 30, () => ({ leader: 1 })) };
ok(ids(skew).includes('leader-skew'), 'leader dồn broker 1 → leader-skew');

// 5. Cấu hình rủi ro.
const conf: KafkaClusterFacts = {
  ...healthy,
  topics: [{ name: 'tmp', partitions: 3, rf: 1, minIsr: 1 }, { name: 'strict', partitions: 3, rf: 2, minIsr: 2 }, { name: '__consumer_offsets', partitions: 50, rf: 1, minIsr: 1 }],
  partitions: [
    ...parts('tmp', 3, (i) => ({ replicas: [1 + i], isr: [1 + i], leader: 1 + i })),
    ...parts('strict', 3, (i) => ({ replicas: [1 + i, 1 + ((i + 1) % 3)], isr: [1 + i, 1 + ((i + 1) % 3)], leader: 1 + i })),
  ],
};
const r5 = ids(conf);
ok(r5.includes('rf1') && r5.includes('min-isr-ge-rf') && r5.includes('internal-rf1'), `RF1 / minISR≥RF / offsets RF1 (${r5.join()})`);

// 6. Một broker: không báo RF=1, không lệch leader.
const single: KafkaClusterFacts = {
  brokers: brokers.slice(0, 1), controllerId: 1, internalTopics: [],
  topics: [{ name: 'a', partitions: 40, rf: 1, minIsr: 1 }],
  partitions: parts('a', 40, () => ({ leader: 1, replicas: [1], isr: [1] })),
};
ok(ids(single).join() === 'ok', 'cụm 1 broker → ok');

if (fail) { console.error(`\n${fail} kiểm tra hỏng`); process.exit(1); }
console.log('\nTất cả đạt');
