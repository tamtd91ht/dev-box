// scripts/check-kafka-balance.ts — kiểm luật cân bằng consumer ↔ partition của Kafka.
//
// VÌ SAO CÓ FILE NÀY: "lệch" phải đếm theo cặp group · topic chứ không theo group (một group đọc nhiều topic có
// số partition khác nhau), consumer phải tính theo ĐĂNG KÝ (consumer thừa thì không được giao partition nào nên
// đếm theo assignment sẽ ra "cân bằng" sai), và giải mã member hỏng / group không phải consumer thì không được
// làm vỡ cả lượt đo.
//
// Thuần, không kết nối cụm. Chạy: npm run check:kafka-balance

import { AssignerProtocol } from 'kafkajs';
import {
  balanceMetrics,
  balanceOf,
  pcAdvice,
  pcRatioText,
  pcStatus,
  sortBalance,
  summarizeBalance,
  type KafkaMemberInfo,
  type KafkaPcRow,
} from '../lib/kafkaBalance';
import { decodeMembers, memberLabel } from '../lib/kafkaMembers';
import { evaluate } from '../lib/monitor/status';
import { KAFKA_LAG_METRICS } from '../lib/automation/sources/infra';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else {
    failures += 1;
    console.error(`✗ ${m}`);
  }
};

const mem = (id: string, topics: string[], assigned: Record<string, number[]>): KafkaMemberInfo => ({ memberId: id, clientId: id, host: '10.0.0.1', topics, assigned });
const parts = new Map([
  ['orders', 6],
  ['payments', 2],
  ['audit', 3],
]);
const P = (t: string) => parts.get(t);

// ── pcStatus ──
check(pcStatus(6, 6) === 'balanced', 'consumer = partition → cân bằng');
check(pcStatus(6, 2) === 'under', 'consumer < partition → thiếu');
check(pcStatus(2, 5) === 'over', 'consumer > partition → thừa');
check(pcStatus(3, 0) === 'none', '0 consumer → không có consumer');

// ── balanceOf: nhiều topic trong một group, đếm theo đăng ký ──
{
  const members = [
    mem('a', ['orders', 'payments'], { orders: [0, 1, 2], payments: [0] }),
    mem('b', ['orders', 'payments'], { orders: [3, 4, 5], payments: [1] }),
  ];
  const rows = balanceOf('g1', members, P, (t) => (t === 'orders' ? 500 : 0));
  const orders = rows.find((r) => r.topic === 'orders');
  const payments = rows.find((r) => r.topic === 'payments');
  check(rows.length === 2, 'mỗi topic một cặp');
  check(orders?.status === 'under' && orders.consumers === 2 && orders.partitions === 6, 'orders: 2 consumer / 6 partition → thiếu');
  check(payments?.status === 'balanced', 'payments: 2 consumer / 2 partition → cân bằng');
  check(orders?.lag === 500, 'lag theo topic được gắn vào cặp');
  check(pcRatioText(orders!) === '3 partition/consumer', 'tỉ lệ thiếu: "3 partition/consumer"');
  check(pcAdvice(orders!).includes('tăng consumer lên 6'), 'thiếu + lag → khuyên tăng consumer tới số partition');
}

// Consumer thừa: không được giao gì nhưng vẫn đăng ký → phải đếm là thừa, không phải cân bằng.
{
  const members = [
    mem('a', ['payments'], { payments: [0] }),
    mem('b', ['payments'], { payments: [1] }),
    mem('c', ['payments'], {}),
    mem('d', ['payments'], { payments: [] }),
  ];
  const [r] = balanceOf('g2', members, P);
  check(r.status === 'over' && r.consumers === 4 && r.active === 2, 'consumer đăng ký nhưng không được giao vẫn đếm → thừa (4 / 2, 2 đang chạy)');
  check(pcRatioText(r) === '+2 consumer rảnh', 'tỉ lệ thừa: "+2 consumer rảnh"');
}

// Group 0 member: dùng topic đã commit → "không có consumer"; topic nội bộ và topic không rõ partition bị bỏ.
{
  const rows = balanceOf('g3', [], P, () => 10, ['audit', '__consumer_offsets', 'deleted-topic']);
  check(rows.length === 1 && rows[0].topic === 'audit' && rows[0].status === 'none', 'group 0 member → cặp "không có consumer" theo topic đã commit');
}

// Tỉ lệ không chia hết.
check(pcRatioText({ partitions: 7, consumers: 3, status: 'under' }) === '~3 partition/consumer', 'chia không hết → "~3 partition/consumer"');

// ── summarize + sort ──
{
  const rows = [
    ...balanceOf('g1', [mem('a', ['orders'], { orders: [0, 1, 2, 3, 4, 5] })], P, () => 0), // thiếu, không lag
    ...balanceOf('g2', [mem('a', ['audit'], { audit: [0, 1, 2] })], P, () => 900), // thiếu, đang lag
    ...balanceOf('g3', [mem('a', ['payments'], { payments: [0] }), mem('b', ['payments'], { payments: [1] }), mem('c', ['payments'], {})], P, () => 0), // thừa 1
    ...balanceOf('g4', [mem('a', ['payments'], { payments: [0] }), mem('b', ['payments'], { payments: [1] })], P, () => 0), // cân bằng
  ];
  const s = summarizeBalance(rows);
  check(s.pairs === 4 && s.under === 2 && s.over === 1 && s.balanced === 1, 'đếm cặp theo trạng thái');
  check(s.underLagging === 1, 'chỉ cặp thiếu ĐANG lag mới tính underLagging');
  check(s.idleConsumers === 1, 'consumer rảnh = phần thừa');
  const sorted = sortBalance(rows);
  check(sorted[0].groupId === 'g2', 'thiếu-mà-lag lên đầu');
  check(sorted[sorted.length - 1].status === 'balanced', 'cân bằng xuống cuối');
}

// ── decodeMembers: buffer thật của kafkajs ──
{
  const meta = AssignerProtocol.MemberMetadata.encode({ version: 0, topics: ['orders'], userData: Buffer.alloc(0) });
  const asg = AssignerProtocol.MemberAssignment.encode({ version: 0, assignment: { orders: [0, 2] }, userData: Buffer.alloc(0) });
  const out = decodeMembers('consumer', [
    { memberId: 'm1', clientId: 'svc', clientHost: '/10.1.2.3', memberMetadata: meta, memberAssignment: asg },
    { memberId: 'm2', clientId: 'svc', clientHost: '/10.1.2.4', memberMetadata: Buffer.from([1, 2, 3]), memberAssignment: Buffer.alloc(0) },
  ]);
  check(!!out && out[0].topics[0] === 'orders' && out[0].assigned.orders.join(',') === '0,2', 'giải mã metadata + assignment');
  check(out?.[0].host === '10.1.2.3', 'bỏ dấu / đầu host');
  check(!!out && out[1].topics.length === 0 && Object.keys(out[1].assigned).length === 0, 'member giải mã hỏng vẫn được đếm, không làm vỡ');
  check(decodeMembers('connect', []) === null, 'group không phải "consumer" (Kafka Connect) → bỏ qua');
  check(!!out && memberLabel(out[0]) === 'svc@10.1.2.3', 'nhãn consumer giữ partition: clientId@host');
  check(memberLabel({ memberId: 'm9', clientId: '', host: '' }) === 'm9', 'thiếu clientId + host → memberId');
}

// ── balanceMetrics: chỉ số Monitor từ các cặp của lượt quét lag ──
{
  const rows: KafkaPcRow[] = [
    { groupId: 'g1', topic: 'orders', partitions: 6, consumers: 2, active: 2, lag: 50, status: 'under' },
    { groupId: 'g2', topic: 'payments', partitions: 2, consumers: 5, active: 2, lag: 0, status: 'over' },
    { groupId: 'g3', topic: 'audit', partitions: 3, consumers: 3, active: 3, lag: 10, status: 'balanced' },
    { groupId: 'g4', topic: 'audit', partitions: 3, consumers: 0, active: 0, lag: 99, status: 'none' },
  ];
  const m = balanceMetrics(rows);
  check(m.pcMismatch === 2, 'pcMismatch đếm cặp lệch (thiếu + thừa, không tính "không có consumer")');
  check(m.pcUnderLagging === 1, 'pcUnderLagging đếm cặp thiếu đang lag');
  check(m.idleConsumers === 3, 'idleConsumers cộng phần thừa');
  const zero = balanceMetrics([]);
  check(zero.pcMismatch === 0 && zero.pcUnderLagging === 0 && zero.idleConsumers === 0, 'không có cặp lệch → 0 (không vắng)');
}

// ── Monitor: luật + KPI + giữ chỉ số qua vòng đo nhẹ ──
{
  const probe = (metrics: Record<string, number>) => ({ at: 1, metrics: { up: 1, ...metrics } });
  const hit = evaluate('kafka', probe({ pcUnderLagging: 2, pcMismatch: 5, idleConsumers: 3 }));
  check(hit.level === 'warn' && hit.reasons.some((r) => r.metric === 'pcUnderLagging'), 'Monitor: thiếu consumer mà đang lag → vàng');
  check(hit.kpis.some((k) => k.metric === 'pcUnderLagging' && k.level === 'warn'), 'Monitor: KPI "thiếu consumer" hiện khi > 0');
  const calm = evaluate('kafka', probe({ pcUnderLagging: 0, pcMismatch: 7, idleConsumers: 4 }));
  check(calm.level === 'ok', 'Monitor: lệch / consumer rảnh chỉ để theo dõi, không cảnh báo');
  check(!calm.kpis.some((k) => k.metric === 'pcUnderLagging'), 'Monitor: KPI "thiếu consumer" ẩn khi = 0');
  check(['pcUnderLagging', 'pcMismatch', 'idleConsumers'].every((k) => KAFKA_LAG_METRICS.has(k)), 'chỉ số mới nằm trong KAFKA_LAG_METRICS (đo cùng lượt lag, giữ qua vòng đo nhẹ)');
}

if (failures) {
  console.error(`\n${failures} ca sai`);
  process.exit(1);
}
console.log('\nTất cả ca đều đúng.');
