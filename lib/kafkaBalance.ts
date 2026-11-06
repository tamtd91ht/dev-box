// Kafka — cân bằng consumer ↔ partition của từng cặp (consumer group · topic). Hàm thuần (không kafkajs, không
// I/O) nên dùng được ở cả server (lib/kafkaClient: lượt quét lag, chi tiết group) lẫn UI (tab Kafka, Monitor) và
// probe Monitor/Automation (chỉ số pcMismatch / pcUnderLagging / idleConsumers). Kiểm bằng check:kafka-balance.
//
// Thiết kế tối ưu: mỗi partition đúng MỘT consumer (số consumer đăng ký topic = số partition).
//   • Thiếu (consumer < partition): một consumer gánh nhiều partition — vẫn chạy, nhưng thông lượng bị trần;
//     đáng lo khi topic ĐANG LAG (thêm consumer, tối đa bằng số partition, là cách tăng tốc trực tiếp nhất).
//   • Thừa (consumer > partition): consumer dư không được giao partition nào, ngồi không (chỉ là dự phòng).
//   • Không có consumer: group có offset trên topic nhưng 0 member (đã có chỉ số emptyGroups / deadLagGroups).

export type PcStatus = 'balanced' | 'under' | 'over' | 'none';

/** Một member đã giải mã từ describeGroups (metadata = topic đăng ký, assignment = partition được giao). */
export interface KafkaMemberInfo {
  memberId: string;
  clientId: string;
  host: string;
  /** Topic member đăng ký (subscription). */
  topics: string[];
  /** topic → các partition được giao. */
  assigned: Record<string, number[]>;
}

export interface KafkaPcRow {
  groupId: string;
  topic: string;
  /** Số partition của topic. */
  partitions: number;
  /** Số consumer (member) của group đăng ký topic. */
  consumers: number;
  /** Số consumer thực sự được giao ≥ 1 partition của topic. */
  active: number;
  /** Lag của group trên topic; null = không biết / chưa đo. */
  lag: number | null;
  status: PcStatus;
}

export interface KafkaPcSummary {
  /** Số cặp group · topic đã xét. */
  pairs: number;
  balanced: number;
  under: number;
  over: number;
  none: number;
  /** Cặp thiếu consumer MÀ đang lag — cần xử lý. */
  underLagging: number;
  /** Tổng consumer ngồi không (thừa so với số partition). */
  idleConsumers: number;
}

export function pcStatus(partitions: number, consumers: number): PcStatus {
  if (consumers <= 0) return 'none';
  if (consumers === partitions) return 'balanced';
  return consumers < partitions ? 'under' : 'over';
}

/**
 * Các cặp group · topic của một group. Topic = những topic member đăng ký hoặc được giao; group 0 member thì
 * lấy `committedTopics` (topic đã commit offset) để ra cặp "không có consumer". Topic nội bộ (`__…`) và topic
 * không biết số partition (vừa xoá…) bị bỏ qua.
 */
export function balanceOf(
  groupId: string,
  members: KafkaMemberInfo[],
  partitionsOf: (topic: string) => number | undefined,
  lagOf: (topic: string) => number | null = () => null,
  committedTopics: string[] = [],
): KafkaPcRow[] {
  const topics = new Set<string>();
  for (const m of members) {
    for (const t of m.topics) topics.add(t);
    for (const t of Object.keys(m.assigned)) topics.add(t);
  }
  if (members.length === 0) for (const t of committedTopics) topics.add(t);
  const rows: KafkaPcRow[] = [];
  for (const topic of topics) {
    if (topic.startsWith('__')) continue;
    const partitions = partitionsOf(topic);
    if (!partitions) continue;
    const consumers = members.filter((m) => m.topics.includes(topic) || topic in m.assigned).length;
    const active = members.filter((m) => (m.assigned[topic]?.length ?? 0) > 0).length;
    rows.push({ groupId, topic, partitions, consumers, active, lag: lagOf(topic), status: pcStatus(partitions, consumers) });
  }
  return rows;
}

export function summarizeBalance(rows: KafkaPcRow[]): KafkaPcSummary {
  const s: KafkaPcSummary = { pairs: rows.length, balanced: 0, under: 0, over: 0, none: 0, underLagging: 0, idleConsumers: 0 };
  for (const r of rows) {
    s[r.status] += 1;
    if (r.status === 'under' && (r.lag ?? 0) > 0) s.underLagging += 1;
    if (r.status === 'over') s.idleConsumers += r.consumers - r.partitions;
  }
  return s;
}

const RANK: Record<PcStatus, number> = { under: 3, over: 2, none: 1, balanced: 0 };
/** Thiếu-mà-lag trước, rồi thiếu, thừa, không consumer, cân bằng; trong cùng mức: lag lớn trước, rồi lệch nhiều trước. */
export function sortBalance(rows: KafkaPcRow[]): KafkaPcRow[] {
  const urgent = (r: KafkaPcRow) => Number(r.status === 'under' && (r.lag ?? 0) > 0);
  return [...rows].sort(
    (a, b) =>
      urgent(b) - urgent(a) ||
      RANK[b.status] - RANK[a.status] ||
      (b.lag ?? -1) - (a.lag ?? -1) ||
      Math.abs(b.partitions - b.consumers) - Math.abs(a.partitions - a.consumers) ||
      a.groupId.localeCompare(b.groupId) ||
      a.topic.localeCompare(b.topic),
  );
}

// ── Câu chữ hiển thị (portal) ───────────────────────────────────────────────

export const PC_TEXT: Record<PcStatus, string> = {
  balanced: 'Cân bằng',
  under: 'Thiếu consumer',
  over: 'Thừa consumer',
  none: 'Không có consumer',
};

/** Tóm tắt ngắn của tỉ lệ: "3 partition/consumer", "+2 consumer rảnh"… */
export function pcRatioText(r: Pick<KafkaPcRow, 'partitions' | 'consumers' | 'status'>): string {
  if (r.status === 'none') return 'chưa ai đọc';
  if (r.status === 'balanced') return '1 partition/consumer';
  if (r.status === 'over') return `+${r.consumers - r.partitions} consumer rảnh`;
  const per = r.partitions / r.consumers;
  return `${Number.isInteger(per) ? per : `~${Math.ceil(per)}`} partition/consumer`;
}

/** Gợi ý xử lý cho một cặp. */
export function pcAdvice(r: KafkaPcRow): string {
  switch (r.status) {
    case 'balanced':
      return 'Tối ưu: mỗi partition một consumer.';
    case 'under':
      return (r.lag ?? 0) > 0
        ? `Đang lag — tăng consumer lên ${r.partitions} (bằng số partition) để mỗi partition có một consumer riêng.`
        : `Đang theo kịp. Khi lưu lượng tăng mà bắt đầu lag thì tăng consumer, tối đa ${r.partitions}.`;
    case 'over':
      return `${r.consumers - r.partitions} consumer không được giao partition nào (chỉ dự phòng) — giảm consumer xuống ${r.partitions} hoặc tăng partition lên ${r.consumers}.`;
    case 'none':
      return 'Group có offset trên topic nhưng không còn consumer nào đang chạy.';
  }
}

/**
 * Ba chỉ số Monitor/Automation từ các cặp group · topic của một lượt quét lag. Luôn ra số (0 khi không có cặp
 * nào lệch) — vắng mặt chỉ khi lượt quét lag không chạy.
 *   pcUnderLagging: cặp thiếu consumer MÀ đang lag (thứ cần làm) · pcMismatch: cặp thiếu + thừa ·
 *   idleConsumers: tổng consumer thừa so với số partition (ngồi không).
 */
export function balanceMetrics(rows: KafkaPcRow[]): { pcMismatch: number; pcUnderLagging: number; idleConsumers: number } {
  const s = summarizeBalance(rows);
  return { pcMismatch: s.under + s.over, pcUnderLagging: s.underLagging, idleConsumers: s.idleConsumers };
}
