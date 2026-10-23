// Phân tích SỨC KHOẺ CỤM / REPLICATION Kafka — phần LUẬT thuần.
//
// Số liệu do lib/kafkaClusterDiagnose.ts gom (chỉ đọc: DescribeCluster, Metadata,
// DescribeConfigs của topic). File này biến chúng thành kết luận có bằng chứng +
// cách xử lý. Thuần để client import kiểu mà không kéo kafkajs.
//
// Câu hỏi phải trả lời được: partition nào đang KHÔNG ghi/đọc được (offline), đang
// MẤT an toàn dữ liệu (ISR thiếu, dưới min.insync.replicas), broker nào VẮNG MẶT,
// tải leader có LỆCH không, và cấu hình topic nào là rủi ro ngầm (RF=1,
// min.insync.replicas ≥ RF).

import { buildPlan, fmtN, sortFindings, type Finding, type PlanStep } from '@/lib/diagnose';

export interface KcPartition {
  topic: string;
  partition: number;
  /** -1 = không có leader (offline). */
  leader: number;
  replicas: number[];
  isr: number[];
  offlineReplicas: number[];
}

export interface KcTopic {
  name: string;
  partitions: number;
  /** Replication factor (số replica của partition đầu). */
  rf: number;
  /** null = không đọc được cấu hình (thiếu quyền / quá giới hạn). */
  minIsr: number | null;
}

export interface KafkaClusterFacts {
  brokers: { nodeId: number; addr: string }[];
  controllerId: number | null;
  topics: KcTopic[];
  partitions: KcPartition[];
  /** Topic nội bộ (__consumer_offsets, __transaction_state) — vẫn kiểm offline / ISR. */
  internalTopics: string[];
  /** Đọc cấu hình topic bị lỗi / bỏ bớt — lý do. */
  configNote?: string;
}

export interface KcBrokerRow {
  nodeId: number;
  addr: string;
  controller: boolean;
  /** Đang vắng: có trong replica list nhưng không có trong DescribeCluster. */
  missing: boolean;
  leaders: number;
  replicas: number;
  /** Partition mà broker này là replica nhưng không nằm trong ISR. */
  outOfIsr: number;
}

export interface KcTopicRow {
  name: string;
  partitions: number;
  rf: number;
  minIsr: number | null;
  offline: number;
  underReplicated: number;
  underMinIsr: number;
}

export interface KafkaClusterDiagnosis {
  at: number;
  headline: string;
  findings: Finding[];
  plan: PlanStep[];
  brokerCount: number;
  topicCount: number;
  partitionCount: number;
  offline: number;
  underReplicated: number;
  underMinIsr: number;
  brokers: KcBrokerRow[];
  /** Topic có vấn đề — nặng nhất trước. */
  topicRows: KcTopicRow[];
}

// ── Ngưỡng ───────────────────────────────────────────────────────────────

/** Broker giữ leader nhiều hơn trung bình ngần này lần → lệch tải. */
const LEADER_SKEW = 1.5;
/** Không xét lệch leader khi cụm quá ít partition. */
const LEADER_SKEW_MIN_PARTS = 30;
/** Tỉ lệ partition mà leader khác preferred (replica đầu) đáng báo. */
const NON_PREFERRED_PCT = 10;
const LIST_MAX = 8;

const list = (xs: string[]): string => (xs.length > LIST_MAX ? `${xs.slice(0, LIST_MAX).join(', ')} … (+${xs.length - LIST_MAX})` : xs.join(', '));

export function analyzeKafkaCluster(f: KafkaClusterFacts, at = Date.now()): KafkaClusterDiagnosis {
  const out: Finding[] = [];
  const live = new Set(f.brokers.map((b) => b.nodeId));
  const topicConf = new Map(f.topics.map((t) => [t.name, t]));

  // ── Gom theo partition ──
  const brokerStat = new Map<number, { leaders: number; replicas: number; outOfIsr: number }>();
  const stat = (id: number) => {
    let s = brokerStat.get(id);
    if (!s) { s = { leaders: 0, replicas: 0, outOfIsr: 0 }; brokerStat.set(id, s); }
    return s;
  };
  const perTopic = new Map<string, { offline: number; under: number; underMin: number }>();
  const tstat = (t: string) => {
    let s = perTopic.get(t);
    if (!s) { s = { offline: 0, under: 0, underMin: 0 }; perTopic.set(t, s); }
    return s;
  };
  let offline = 0;
  let under = 0;
  let underMin = 0;
  let nonPreferred = 0;
  const missing = new Set<number>();
  const offlineParts: string[] = [];
  const underMinParts: string[] = [];

  for (const p of f.partitions) {
    const name = `${p.topic}-${p.partition}`;
    for (const r of p.replicas) {
      stat(r).replicas++;
      if (!live.has(r)) missing.add(r);
      if (!p.isr.includes(r)) stat(r).outOfIsr++;
    }
    if (p.leader === -1) {
      offline++;
      tstat(p.topic).offline++;
      offlineParts.push(name);
      continue;
    }
    stat(p.leader).leaders++;
    if (p.replicas.length && p.leader !== p.replicas[0]) nonPreferred++;
    if (p.isr.length < p.replicas.length) { under++; tstat(p.topic).under++; }
    const minIsr = topicConf.get(p.topic)?.minIsr ?? null;
    if (minIsr !== null && p.isr.length < minIsr) { underMin++; tstat(p.topic).underMin++; underMinParts.push(name); }
  }

  // 1. Offline — ghi / đọc đang lỗi.
  if (offline) {
    out.push({
      id: 'offline',
      level: 'crit',
      title: `${fmtN(offline)} partition KHÔNG có leader — producer / consumer trên đó đang lỗi`,
      evidence: [`Partition: ${list(offlineParts)}`, missing.size ? `Broker vắng mặt: ${[...missing].join(', ')}` : 'Mọi broker trong replica list đều đang có mặt — leader election đang kẹt'],
      fix: 'Đưa broker chứa replica của các partition này trở lại. Nếu mọi replica đều mất và chấp nhận mất dữ liệu, mới cân nhắc unclean leader election cho riêng topic đó.',
      sql: 'kafka-topics.sh --bootstrap-server <broker> --describe --unavailable-partitions',
      step: { phase: 'now', text: `Khôi phục broker giữ replica của ${fmtN(offline)} partition offline` },
    });
  }

  // 2. Broker vắng mặt.
  if (missing.size) {
    out.push({
      id: 'missing-broker',
      level: offline ? 'crit' : 'warn',
      title: `Broker ${[...missing].join(', ')} vắng mặt — vẫn được gán replica nhưng không có trong cụm`,
      evidence: [...missing].map((id) => `Broker ${id}: ${fmtN(brokerStat.get(id)?.replicas ?? 0)} replica được gán`),
      fix: 'Broker đã dừng / mất kết nối tới controller. Kiểm tra process, đĩa, log của broker đó; nếu bỏ hẳn broker thì phải reassign partition sang broker khác.',
      step: { phase: 'now', text: `Kiểm tra broker ${[...missing].join(', ')} (process / đĩa / mạng tới controller)` },
    });
  }

  // 3. Dưới min.insync.replicas — producer acks=all bị từ chối.
  if (underMin) {
    out.push({
      id: 'under-min-isr',
      level: 'crit',
      title: `${fmtN(underMin)} partition có ISR < min.insync.replicas — producer acks=all đang bị từ chối ghi`,
      evidence: [`Partition: ${list(underMinParts)}`],
      fix: 'Ghi với acks=all sẽ lỗi NotEnoughReplicas cho tới khi replica bắt kịp. Ưu tiên đưa replica tụt lại về ISR (broker vắng, đĩa / mạng chậm).',
      step: { phase: 'now', text: 'Đưa replica tụt về ISR để producer acks=all ghi lại được' },
    });
  }

  // 4. Under-replicated — chưa lỗi nhưng mất dự phòng.
  if (under) {
    const outBrokers = [...brokerStat.entries()].filter(([, s]) => s.outOfIsr > 0).sort((a, b) => b[1].outOfIsr - a[1].outOfIsr);
    out.push({
      id: 'urp',
      level: 'warn',
      title: `${fmtN(under)} partition under-replicated — đang thiếu bản sao, thêm một broker hỏng là có thể mất dữ liệu`,
      evidence: [
        `Replica nằm ngoài ISR theo broker: ${outBrokers.map(([id, s]) => `${id} (${fmtN(s.outOfIsr)})`).join(', ') || '—'}`,
      ],
      fix: 'Nếu dồn vào một broker: broker đó chậm (đĩa, GC, mạng) hoặc vừa khởi động lại và đang bắt kịp. Rải đều nhiều broker thường là do tải ghi vượt khả năng replicate.',
      sql: 'kafka-topics.sh --bootstrap-server <broker> --describe --under-replicated-partitions',
      step: { phase: 'now', text: `Xem broker có nhiều replica ngoài ISR nhất (${outBrokers[0]?.[0] ?? '?'}) — đĩa / GC / mạng` },
    });
  }

  // 5. Lệch leader.
  const liveRows = f.brokers.map((b) => ({ id: b.nodeId, leaders: brokerStat.get(b.nodeId)?.leaders ?? 0 }));
  const leaderTotal = liveRows.reduce((a, b) => a + b.leaders, 0);
  if (f.brokers.length > 1 && leaderTotal >= LEADER_SKEW_MIN_PARTS) {
    const avg = leaderTotal / f.brokers.length;
    const hot = liveRows.filter((b) => b.leaders > avg * LEADER_SKEW);
    const npPct = Math.round((nonPreferred / Math.max(1, leaderTotal)) * 100);
    if (hot.length || npPct >= NON_PREFERRED_PCT) {
      out.push({
        id: 'leader-skew',
        level: 'warn',
        title: hot.length
          ? `Leader dồn vào broker ${hot.map((b) => b.id).join(', ')} — gánh nhiều request đọc/ghi hơn các broker khác`
          : `${npPct}% partition đang không do preferred leader giữ`,
        evidence: [
          `Leader theo broker: ${liveRows.map((b) => `${b.id}: ${fmtN(b.leaders)}`).join(' · ')} (trung bình ${fmtN(avg)})`,
          `${fmtN(nonPreferred)} / ${fmtN(leaderTotal)} partition có leader khác preferred (replica đầu)`,
        ],
        fix: 'Thường xảy ra sau khi một broker restart: leader chuyển sang broker khác và không tự về. Chạy preferred leader election (an toàn, không mất dữ liệu) hoặc bật auto.leader.rebalance.enable. Nếu lệch cả số replica thì cần reassign.',
        sql: 'kafka-leader-election.sh --bootstrap-server <broker> --election-type PREFERRED --all-topic-partitions',
        step: { phase: 'now', text: 'Chạy preferred leader election để rải lại leader' },
      });
    }
  }

  // 6. Cấu hình topic rủi ro.
  const userTopics = f.topics.filter((t) => !f.internalTopics.includes(t.name));
  const rf1 = userTopics.filter((t) => t.rf === 1);
  if (rf1.length && f.brokers.length > 1) {
    out.push({
      id: 'rf1',
      level: 'warn',
      title: `${fmtN(rf1.length)} topic có replication factor = 1 — broker giữ nó hỏng là mất dữ liệu / ngừng phục vụ`,
      evidence: [`Topic: ${list(rf1.map((t) => t.name))}`],
      fix: 'Với dữ liệu cần giữ, tăng RF lên 3 bằng kafka-reassign-partitions (chạy lúc thấp điểm — có copy dữ liệu giữa broker). Topic tạm / dễ dựng lại thì có thể để nguyên.',
      step: { phase: 'long', text: 'Tăng replication factor cho topic quan trọng đang RF=1' },
    });
  }
  const strict = userTopics.filter((t) => t.minIsr !== null && t.rf > 1 && t.minIsr >= t.rf);
  if (strict.length) {
    out.push({
      id: 'min-isr-ge-rf',
      level: 'warn',
      title: `${fmtN(strict.length)} topic có min.insync.replicas ≥ replication factor — chỉ cần MỘT broker dừng là producer acks=all không ghi được`,
      evidence: strict.slice(0, LIST_MAX).map((t) => `${t.name}: RF ${t.rf}, min.insync.replicas ${t.minIsr}`),
      fix: 'Đặt min.insync.replicas = RF − 1 (thường RF 3 / min ISR 2) để chịu được một broker bảo trì.',
      sql: strict[0] ? `kafka-configs.sh --bootstrap-server <broker> --alter --entity-type topics --entity-name ${strict[0].name} --add-config min.insync.replicas=${Math.max(1, strict[0].rf - 1)}` : undefined,
      step: { phase: 'long', text: 'Hạ min.insync.replicas về RF − 1 cho topic đang đặt quá chặt' },
    });
  }
  const internalRf1 = f.topics.filter((t) => f.internalTopics.includes(t.name) && t.rf === 1);
  if (internalRf1.length && f.brokers.length > 1) {
    out.push({
      id: 'internal-rf1',
      level: 'warn',
      title: `Topic nội bộ ${internalRf1.map((t) => t.name).join(', ')} có RF = 1 — broker giữ nó hỏng là MỌI consumer group mất offset`,
      evidence: internalRf1.map((t) => `${t.name}: ${t.partitions} partition, RF 1`),
      fix: 'Thường do cụm khởi tạo khi chỉ có một broker (offsets.topic.replication.factor). Reassign __consumer_offsets lên RF 3.',
      step: { phase: 'long', text: 'Tăng RF của __consumer_offsets lên 3' },
    });
  }

  if (f.configNote) {
    out.push({ id: 'config-note', level: 'info', title: 'Không đọc đủ cấu hình topic', evidence: [f.configNote], fix: 'Phần min.insync.replicas có thể thiếu — cần quyền DescribeConfigs trên topic.' });
  }

  if (!out.some((x) => x.level === 'crit' || x.level === 'warn')) {
    out.push({
      id: 'ok',
      level: 'ok',
      title: 'Replication ổn — mọi partition có leader, ISR đủ, leader rải đều',
      evidence: [`${fmtN(f.brokers.length)} broker · ${fmtN(f.topics.length)} topic · ${fmtN(f.partitions.length)} partition`],
    });
  }

  const findings = sortFindings(out);
  const top = findings[0];
  const headline = offline
    ? `${fmtN(offline)} partition offline — có producer / consumer đang lỗi`
    : underMin
      ? `${fmtN(underMin)} partition dưới min.insync.replicas — producer acks=all bị từ chối`
      : top.level === 'ok' ? 'Cụm Kafka khoẻ — không thấy vấn đề replication' : top.title;

  const brokerIds = [...new Set([...f.brokers.map((b) => b.nodeId), ...missing])].sort((a, b) => a - b);
  const brokers: KcBrokerRow[] = brokerIds.map((id) => ({
    nodeId: id,
    addr: f.brokers.find((b) => b.nodeId === id)?.addr ?? '—',
    controller: id === f.controllerId,
    missing: missing.has(id),
    leaders: brokerStat.get(id)?.leaders ?? 0,
    replicas: brokerStat.get(id)?.replicas ?? 0,
    outOfIsr: brokerStat.get(id)?.outOfIsr ?? 0,
  }));

  const risky = new Set([...rf1, ...strict, ...internalRf1].map((t) => t.name));
  const topicRows: KcTopicRow[] = f.topics
    .map((t) => ({ name: t.name, partitions: t.partitions, rf: t.rf, minIsr: t.minIsr, offline: perTopic.get(t.name)?.offline ?? 0, underReplicated: perTopic.get(t.name)?.under ?? 0, underMinIsr: perTopic.get(t.name)?.underMin ?? 0 }))
    .filter((t) => t.offline || t.underReplicated || t.underMinIsr || risky.has(t.name))
    .sort((a, b) => b.offline - a.offline || b.underMinIsr - a.underMinIsr || b.underReplicated - a.underReplicated || a.name.localeCompare(b.name));

  return {
    at,
    headline,
    findings,
    plan: buildPlan(findings, 'Phân tích lại để xác nhận ISR đã đủ và leader đã rải đều'),
    brokerCount: f.brokers.length,
    topicCount: f.topics.length,
    partitionCount: f.partitions.length,
    offline,
    underReplicated: under,
    underMinIsr: underMin,
    brokers,
    topicRows,
  };
}
