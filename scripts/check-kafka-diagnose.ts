// scripts/check-kafka-diagnose.ts — kiểm luật phân tích lag Kafka.
//
// VÌ SAO CÓ FILE NÀY: lời khuyên cho lag rất dễ sai chỗ. "Thêm consumer" là vô
// ích khi số consumer đã bằng số partition, hay khi lag dồn vào một partition
// nóng; "tăng tốc xử lý" là sai khi consumer đang kẹt hẳn vì poison message;
// và báo động cho một đợt dồn đang tự tiêu hết chỉ làm người trực mất ngủ.
// Các ca ở đây khoá những chỗ đó.
//
//   npx tsx scripts/check-kafka-diagnose.ts

import { analyzeKafkaLag, type KafkaLagFacts, type KMember, type KPartition } from '../lib/kafkaDiagnoseRules';

let failures = 0;
const check = (cond: boolean, m: string): void => {
  if (cond) console.log(`✓ ${m}`);
  else { failures += 1; console.error(`✗ ${m}`); }
};

const SEC = 10;
/** Partition với lag ban đầu, tốc độ sản xuất / tiêu thụ (msg/s) trong cửa sổ SEC giây. */
const part = (partition: number, lag0: number, prod: number, cons: number, owner: string | null = 'svc-1@10.0.0.1', topic = 'orders'): KPartition => {
  const end0 = 1_000_000;
  const committed0 = end0 - lag0;
  return {
    topic, partition, owner,
    committed0, committed1: committed0 + cons * SEC,
    end0, end1: end0 + prod * SEC,
    hasLeader: true,
  };
};
const member = (i: number, assigned: number): KMember => ({ memberId: `m${i}`, clientId: `svc-${i}`, host: `10.0.0.${i}`, assigned });
const facts = (over: Partial<KafkaLagFacts>): KafkaLagFacts => ({
  groupId: 'billing', sec: SEC, states: ['Stable', 'Stable', 'Stable'], membersChanged: false,
  members: [member(1, 2), member(2, 2)], assignmentKnown: true,
  partitions: [], topics: [{ name: 'orders', partitions: 4, retentionMs: 7 * 86400_000, compact: false }],
  oldest: null, ...over,
});
const ids = (f: KafkaLagFacts) => analyzeKafkaLag(f).findings.map((x) => x.id);
const get = (f: KafkaLagFacts, id: string) => analyzeKafkaLag(f).findings.find((x) => x.id === id);

// ── Không ai tiêu thụ ──
{
  const f = facts({ members: [], states: ['Empty', 'Empty', 'Empty'], partitions: [part(0, 5000, 50, 0, null), part(1, 3000, 40, 0, null)] });
  const d = analyzeKafkaLag(f);
  check(d.findings[0]?.id === 'empty' && d.findings[0].level === 'crit', '0 consumer + có lag → "không có consumer", đỏ, đứng đầu');
  check(!ids(f).includes('slow') && !ids(f).includes('stuck'), '0 consumer → không bàn chuyện chậm / kẹt');
  check(d.plan[0]?.text.includes('0 consumer'), 'bước đầu: khởi động lại consumer');
}

// ── Consumer sống nhưng kẹt ──
{
  const f = facts({ partitions: [part(0, 8000, 20, 0), part(1, 6000, 20, 0), part(2, 0, 20, 20), part(3, 0, 20, 20)], oldest: { topic: 'orders', partition: 0, ageSec: 3600 } });
  const s = get(f, 'stuck')!;
  check(s.level === 'crit' && s.title.includes('không commit'), 'mọi partition lag đều đứng im → consumer kẹt, đỏ');
  check(!ids(f).includes('slow'), 'kẹt hẳn → không khuyên "thêm consumer"');
  check(!!s.sql?.includes('--offset 992000') && s.sql.includes('--to-offset 992001'), 'lệnh xem đúng message kẹt + bỏ qua 1 message');
}
{
  const f = facts({ partitions: [part(0, 9000, 20, 0, 'svc-2@10.0.0.2'), part(1, 100, 20, 25), part(2, 50, 20, 30), part(3, 0, 20, 20)] });
  const s = get(f, 'stuck')!;
  check(s.level === 'warn' && s.evidence.some((e) => e.includes('svc-2@10.0.0.2')), 'một partition kẹt, các partition khác chạy → nêu đích danh consumer giữ nó');
}

// ── Chậm hơn producer: thêm consumer có giúp không ──
{
  const f = facts({ partitions: [part(0, 1000, 100, 60), part(1, 1000, 100, 60), part(2, 1000, 100, 60), part(3, 1000, 100, 60)] });
  const s = get(f, 'slow')!;
  check(!!s && s.fix!.includes('tối đa 4') && s.step?.phase === 'now', '2 consumer / 4 partition, chậm → thêm consumer (tối đa 4)');
}
{
  const f = facts({ members: [member(1, 1), member(2, 1), member(3, 1), member(4, 1)],
    partitions: [part(0, 1000, 100, 60), part(1, 1000, 100, 60), part(2, 1000, 100, 60), part(3, 1000, 100, 60)] });
  const s = get(f, 'slow')!;
  check(s.fix!.includes('KHÔNG giúp') && s.step?.phase === 'long' && !!s.sql?.includes('--partitions 8'), '4 consumer / 4 partition → thêm consumer KHÔNG giúp; tăng tốc xử lý / tăng partition');
}

// ── Đợt dồn đang tự tiêu ──
{
  const f = facts({ partitions: [part(0, 2000, 10, 50), part(1, 2000, 10, 50), part(2, 0, 10, 10), part(3, 0, 10, 10)] });
  const d = analyzeKafkaLag(f);
  const x = d.findings.find((y) => y.id === 'draining')!;
  check(!!x && x.level === 'info' && x.title.includes('dự kiến hết lag'), 'tiêu thụ > sản xuất → đang đuổi kịp, có ETA, chỉ là thông tin');
  check(!d.findings.some((y) => y.level === 'crit' || y.level === 'warn'), 'đang đuổi kịp → không báo vàng/đỏ');
}

// ── Lag dồn vào một partition ──
{
  const f = facts({ partitions: [part(0, 50_000, 400, 300, 'svc-1@10.0.0.1'), part(1, 100, 50, 50), part(2, 100, 50, 50), part(3, 100, 50, 50)] });
  const s = analyzeKafkaLag(f).findings.find((x) => x.id === 'skew:orders')!;
  check(!!s && s.evidence.some((e) => e.includes('hot key')) && s.fix!.includes('Thêm consumer không giúp'), 'partition nhận nhiều hơn hẳn → hot key, thêm consumer không giúp');
}
{
  const f = facts({ partitions: [part(0, 50_000, 50, 10, 'svc-2@10.0.0.2'), part(1, 100, 50, 50), part(2, 100, 50, 50), part(3, 100, 50, 50)] });
  const s = analyzeKafkaLag(f).findings.find((x) => x.id === 'skew:orders')!;
  check(!!s && s.fix!.includes('svc-2@10.0.0.2') && !s.evidence.some((e) => e.includes('hot key')), 'partition không nóng hơn → consumer giữ nó chậm, nêu tên instance');
}

// ── Rebalance ──
{
  const f = facts({ states: ['Stable', 'PreparingRebalance', 'CompletingRebalance'], membersChanged: true, partitions: [part(0, 5000, 50, 0), part(1, 5000, 50, 0)] });
  const r = get(f, 'rebalance')!;
  check(r.level === 'crit' && r.fix!.includes('max.poll.interval.ms'), 'rebalance + member vào/ra → đỏ, chỉ ra max.poll.interval.ms');
  check(!ids(f).includes('stuck'), 'đang rebalance thì đứng im là hệ quả, không báo "kẹt" riêng');
}

// ── Partition không ai nhận / consumer thừa ──
check(ids(facts({ partitions: [part(0, 5000, 10, 0, null), part(1, 0, 10, 10)] })).includes('orphan'), 'partition có lag mà không ai được gán → báo');
check(!ids(facts({ assignmentKnown: false, partitions: [part(0, 5000, 10, 10, null)] })).includes('orphan'), 'không đọc được phân công (assign tay) → không bịa "không ai nhận"');
check(ids(facts({ members: [member(1, 2), member(2, 2), member(3, 0), member(4, 0), member(5, 0)], partitions: [part(0, 10, 1, 1)] })).includes('idle'), '5 consumer / 4 partition → báo consumer ngồi chơi');

// ── Sắp mất dữ liệu ──
{
  const r = get(facts({ partitions: [part(0, 5000, 10, 0)], oldest: { topic: 'orders', partition: 0, ageSec: 6 * 86400 } }), 'retention')!;
  check(r.level === 'crit' && !!r.sql?.includes('retention.ms=1209600000'), 'message chờ 6/7 ngày retention → đỏ, gợi ý tăng retention tạm (x2)');
}
check(!ids(facts({ topics: [{ name: 'orders', partitions: 4, retentionMs: 86400_000, compact: true }], partitions: [part(0, 5000, 10, 0)], oldest: { topic: 'orders', partition: 0, ageSec: 80_000 } })).includes('retention'),
  'topic compact → không báo retention');

// ── Partition mất leader ──
{
  const p = part(0, 5000, 0, 0);
  p.hasLeader = false;
  const d = analyzeKafkaLag(facts({ partitions: [p, part(1, 0, 10, 10)] }));
  check(d.findings[0]?.id === 'no-leader', 'partition không có leader → lỗi broker, đứng đầu');
}

// ── Cảnh báo cũ ──
{
  const d = analyzeKafkaLag(facts({ partitions: [part(0, 0, 10, 10), part(1, 0, 10, 10)] }));
  check(d.headline.includes('không còn lag') && d.plan.every((s) => s.phase === 'observe'), 'hết lag → nói rõ cảnh báo đã cũ, không bày việc');
}

if (failures) {
  console.error(`\n${failures} ca hỏng`);
  process.exit(1);
}
console.log('\nTất cả ca đều qua');
