// Phân tích LAG của một consumer group Kafka — phần LUẬT thuần.
//
// Số liệu do lib/kafkaDiagnose.ts gom (chỉ đọc): hai lần đo cách nhau vài giây
// cho offset đã commit + log-end từng partition (→ tốc độ sản xuất / tiêu thụ),
// phân công partition cho từng consumer, trạng thái group ở mỗi lần đo, số
// partition + retention của topic, tuổi message chờ lâu nhất. File này biến
// chúng thành kết luận có bằng chứng + cách xử lý. Thuần để kiểm bằng script
// (check:kafka-diagnose) và để client import kiểu mà không kéo kafkajs.
//
// Câu hỏi phải trả lời được: lag do KHÔNG AI tiêu thụ, do consumer KẸT, do
// consumer CHẬM hơn producer (thêm consumer có giúp không?), do DỒN vào một
// partition, do REBALANCE liên tục — hay chỉ là một đợt dồn đang tự tiêu hết.

import { buildPlan, fmtN, fmtSec, sortFindings, type Finding, type PlanStep } from '@/lib/diagnose';

export interface KMember {
  memberId: string;
  clientId: string;
  host: string;
  /** Số partition được gán (theo assignment của consumer protocol). */
  assigned: number;
}

export interface KPartition {
  topic: string;
  partition: number;
  /** "clientId@host" của consumer được gán; null = không ai (hoặc không biết phân công). */
  owner: string | null;
  committed0: number | null;
  committed1: number | null;
  end0: number;
  end1: number;
  hasLeader: boolean;
}

export interface KTopic {
  name: string;
  partitions: number;
  /** null = không đọc được; -1 = giữ vô hạn. */
  retentionMs: number | null;
  compact: boolean;
}

export interface KafkaLagFacts {
  groupId: string;
  /** Độ dài thật của cửa sổ đo (giây). */
  sec: number;
  /** Trạng thái group ở từng lần đo (Stable / PreparingRebalance / CompletingRebalance / Empty / Dead). */
  states: string[];
  /** Danh sách member đổi giữa các lần đo (consumer khởi động lại / rebalance). */
  membersChanged: boolean;
  members: KMember[];
  /** Đọc được phân công partition (group dùng subscribe + consumer protocol). */
  assignmentKnown: boolean;
  partitions: KPartition[];
  topics: KTopic[];
  /** Message chờ lâu nhất mà group chưa xử lý. */
  oldest: { topic: string; partition: number; ageSec: number } | null;
}

export interface KPartitionRow {
  topic: string;
  partition: number;
  lag: number | null;
  produceRate: number;
  consumeRate: number | null;
  owner: string | null;
  status: string;
}

export interface KafkaLagDiagnosis {
  at: number;
  groupId: string;
  sec: number;
  totalLag: number;
  lagDelta: number;
  produceRate: number;
  consumeRate: number;
  members: number;
  partitionCount: number;
  headline: string;
  findings: Finding[];
  plan: PlanStep[];
  /** Partition nặng nhất trước. */
  rows: KPartitionRow[];
  memberRows: KMember[];
}

// ── Ngưỡng ───────────────────────────────────────────────────────────────

const REBALANCING = new Set(['PreparingRebalance', 'CompletingRebalance']);
const SKEW_SHARE = 0.5;
const SKEW_MIN_LAG = 1_000;
const RETENTION_WARN = 0.5;
const RETENTION_CRIT = 0.8;
/** Hết lag trong ngần này giây thì coi là đợt dồn tạm thời. */
const TRANSIENT_ETA_SEC = 600;
const MAX_ROWS = 15;

const r1 = (n: number): number => Math.round(n * 10) / 10;
const rate = (n: number): string => `${fmtN(n)}${n > 0 && n < 10 ? ` (${r1(n)})` : ''} msg/s`;
const tp = (p: { topic: string; partition: number }): string => `${p.topic}:${p.partition}`;
const CLI = 'kafka-consumer-groups.sh --bootstrap-server <broker>';

interface Derived extends KPartition {
  lag: number | null;
  lag0: number | null;
  produce: number;
  consume: number | null;
}

function derive(p: KPartition, sec: number): Derived {
  const lag = p.committed1 === null ? null : Math.max(0, p.end1 - p.committed1);
  const lag0 = p.committed0 === null ? null : Math.max(0, p.end0 - p.committed0);
  return {
    ...p,
    lag,
    lag0,
    produce: Math.max(0, p.end1 - p.end0) / Math.max(1, sec),
    consume: p.committed0 !== null && p.committed1 !== null ? Math.max(0, p.committed1 - p.committed0) / Math.max(1, sec) : null,
  };
}

export function analyzeKafkaLag(f: KafkaLagFacts, at = Date.now()): KafkaLagDiagnosis {
  const out: Finding[] = [];
  const g = f.groupId;
  const ps = f.partitions.map((p) => derive(p, f.sec));
  const lagging = ps.filter((p) => (p.lag ?? 0) > 0);
  const totalLag = ps.reduce((a, p) => a + (p.lag ?? 0), 0);
  const totalLag0 = ps.reduce((a, p) => a + (p.lag0 ?? 0), 0);
  const lagDelta = totalLag - totalLag0;
  const P = ps.reduce((a, p) => a + p.produce, 0);
  const C = ps.reduce((a, p) => a + (p.consume ?? 0), 0);
  const M = f.members.length;
  const N = f.topics.reduce((a, t) => a + t.partitions, 0) || ps.length;
  const lastState = f.states[f.states.length - 1] ?? '?';
  const stuck = lagging.filter((p) => p.consume === 0);
  const progressing = lagging.filter((p) => (p.consume ?? 0) > 0);

  // 0. Partition không có leader — consumer không đọc được, mọi thứ khác là hệ quả.
  const leaderless = ps.filter((p) => !p.hasLeader);
  if (leaderless.length) {
    out.push({
      id: 'no-leader',
      level: 'crit',
      title: `${leaderless.length} partition không có leader — consumer không đọc được`,
      evidence: [leaderless.slice(0, 8).map(tp).join(', ')],
      fix: 'Đây là sự cố phía broker (broker giữ partition đã chết / mất ISR), không phải consumer. Xem tab Kafka › Tổng quan: broker nào mất, partition offline.',
      sql: 'kafka-topics.sh --bootstrap-server <broker> --describe --unavailable-partitions',
      step: { phase: 'now', text: 'Khôi phục broker / leader cho partition offline — consumer không thể đọc khi chưa có leader' },
    });
  }

  // 1. Không còn lag — cảnh báo đã cũ.
  if (totalLag === 0) {
    out.push({
      id: 'stale',
      level: 'ok',
      title: `Group ${g} hiện không còn lag`,
      evidence: [`${f.sec}s vừa đo: tiêu thụ ${rate(C)}, sản xuất ${rate(P)}`],
      step: { phase: 'observe', text: 'Không cần xử lý — lag đã hết; theo dõi nếu lặp lại theo giờ cao điểm' },
    });
  }

  // 2. Không còn consumer nào.
  if (M === 0 && totalLag > 0) {
    out.push({
      id: 'empty',
      level: 'crit',
      title: `Group ${g} không có consumer nào đang chạy (${lastState})`,
      evidence: [
        `Lag ${fmtN(totalLag)} trên ${lagging.length} partition, không ai tiêu thụ`,
        f.oldest ? `Message chờ lâu nhất: ${fmtSec(f.oldest.ageSec)} (${tp(f.oldest)})` : '',
      ].filter(Boolean),
      fix: 'Consumer đã dừng / crash / bị scale về 0, hoặc deploy đổi group.id. Kiểm tra service tiêu thụ topic này. Nếu group đã bỏ hẳn (đổi sang group mới) thì xoá group cũ để hết báo động giả.',
      sql: `${CLI} --describe --group ${g}\n# group không dùng nữa (chỉ chạy được khi group Empty):\n${CLI} --delete --group ${g}`,
      step: { phase: 'now', text: `Khởi động lại / kiểm tra service tiêu thụ của ${g} (đang 0 consumer)` },
    });
  }

  // 3. Rebalance liên tục — trong lúc rebalance group không tiêu thụ.
  const rebalancing = f.states.some((s) => REBALANCING.has(s));
  if (M > 0 && (rebalancing || f.membersChanged)) {
    out.push({
      id: 'rebalance',
      level: rebalancing && f.membersChanged ? 'crit' : 'warn',
      title: rebalancing ? `Group đang rebalance (${f.states.join(' → ')})` : 'Danh sách consumer thay đổi trong lúc đo',
      evidence: [
        f.membersChanged ? 'Member vào/ra giữa các lần đo — consumer khởi động lại hoặc bị đá khỏi group' : '',
        'Trong lúc rebalance cả group dừng tiêu thụ; lặp lại liên tục thì lag chỉ tăng',
      ].filter(Boolean),
      fix: 'Nguyên nhân hay gặp nhất: xử lý một lượt poll lâu hơn max.poll.interval.ms → consumer bị coi là chết → rebalance. Giảm max.poll.records hoặc tăng max.poll.interval.ms; dùng static membership (group.instance.id) để restart không gây rebalance; partition.assignment.strategy = CooperativeStickyAssignor để rebalance không dừng cả group. Xem log consumer tìm "rebalance" / "member … has failed".',
      sql: `${CLI} --describe --group ${g} --members --verbose\n# cấu hình consumer gợi ý:\nmax.poll.records=100\nmax.poll.interval.ms=600000\ngroup.instance.id=<tên-pod-cố-định>\npartition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor`,
      step: { phase: 'now', text: 'Chặn rebalance liên tục: giảm max.poll.records / tăng max.poll.interval.ms, static membership' },
    });
  }

  // 4. Consumer còn sống nhưng kẹt.
  if (M > 0 && stuck.length && !rebalancing) {
    const all = progressing.length === 0;
    const owners = [...new Set(stuck.map((p) => p.owner).filter((x): x is string => !!x))];
    const head = stuck.sort((a, b) => (b.lag ?? 0) - (a.lag ?? 0))[0];
    out.push({
      id: 'stuck',
      level: all ? 'crit' : 'warn',
      title: all
        ? `Consumer còn sống nhưng không commit gì trong ${f.sec}s — kẹt`
        : `${stuck.length} partition đứng im trong khi các partition khác vẫn chạy`,
      evidence: [
        `Đứng im: ${stuck.slice(0, 6).map((p) => `${tp(p)} (lag ${fmtN(p.lag ?? 0)}${p.owner ? ` · ${p.owner}` : ''})`).join(', ')}${stuck.length > 6 ? ` … +${stuck.length - 6}` : ''}`,
        owners.length ? `Consumer giữ các partition này: ${owners.join(', ')}` : '',
        f.oldest ? `Message chờ lâu nhất: ${fmtSec(f.oldest.ageSec)} (${tp(f.oldest)})` : '',
      ].filter(Boolean),
      fix: all
        ? 'Consumer nhận được partition nhưng không tiến: (1) message lỗi (poison) làm xử lý ném lỗi và retry mãi; (2) phụ thuộc phía sau (DB / API) đang treo; (3) tắt auto-commit mà không commit tay. Xem log của consumer; message đang kẹt xem được ở tab Kafka › Pending.'
        : 'Chỉ vài partition kẹt → thường là poison message ở đúng partition đó, hoặc instance giữ partition đó bị treo. Xem log của instance nêu trên; message đang kẹt xem ở tab Kafka › Pending. Bỏ qua message lỗi bằng cách đẩy offset lên 1 (phải dừng group trước) — hoặc tốt hơn là đưa vào dead-letter topic.',
      sql: head && head.committed1 !== null
        ? `# xem message đang kẹt\nkafka-console-consumer.sh --bootstrap-server <broker> --topic ${head.topic} --partition ${head.partition} --offset ${head.committed1} --max-messages 1\n# bỏ qua 1 message (DỪNG consumer trước, group phải Empty):\n${CLI} --group ${g} --reset-offsets --topic ${head.topic}:${head.partition} --to-offset ${head.committed1 + 1} --execute`
        : undefined,
      step: { phase: 'now', text: all
        ? `Tìm vì sao consumer của ${g} không commit: log lỗi, poison message, phụ thuộc phía sau`
        : `Xem log ${owners[0] ?? 'consumer'} và message kẹt ở ${tp(head)}` },
    });
  }

  // 5. Partition có lag nhưng không ai được gán.
  if (f.assignmentKnown && M > 0) {
    const orphan = lagging.filter((p) => !p.owner);
    if (orphan.length) {
      out.push({
        id: 'orphan',
        level: 'warn',
        title: `${orphan.length} partition có lag nhưng không được gán cho consumer nào`,
        evidence: [orphan.slice(0, 8).map((p) => `${tp(p)} (lag ${fmtN(p.lag ?? 0)})`).join(', ')],
        fix: 'Các instance trong group subscribe KHÁC nhau (bản deploy cũ/mới lệch topic), hoặc group từng đọc topic này nhưng giờ không subscribe nữa (offset cũ còn lại → lag ảo). Nếu topic không còn dùng: xoá offset của group trên topic đó.',
        sql: `${CLI} --describe --group ${g} --members --verbose\n# topic không còn đọc nữa:\n${CLI} --group ${g} --delete-offsets --topic ${orphan[0].topic}`,
        step: { phase: 'now', text: `Kiểm tra subscription của các instance ${g} — có partition không ai nhận` },
      });
    }
  }

  // 6. Tốc độ: chậm hơn producer / đang đuổi kịp.
  if (M > 0 && totalLag > 0 && progressing.length) {
    if (C < P * 0.95 && lagDelta > 0) {
      const canScale = M < N;
      out.push({
        id: 'slow',
        level: lagDelta / Math.max(1, f.sec) > 100 ? 'crit' : 'warn',
        title: `Consumer chậm hơn producer — lag tăng ${fmtN(lagDelta / Math.max(1, f.sec))} msg/s`,
        evidence: [
          `Sản xuất ${rate(P)} · tiêu thụ ${rate(C)} (${fmtN(C / Math.max(1, M))} msg/s mỗi consumer)`,
          `${M} consumer / ${N} partition${canScale ? '' : ' — đã đạt trần song song (mỗi partition chỉ 1 consumer)'}`,
        ],
        fix: canScale
          ? `Thêm consumer: tối đa ${N} (bằng số partition) — đang ${M}. Nếu xử lý từng message chậm (gọi DB/API), tăng tốc xử lý (batch, gọi bất đồng bộ) hiệu quả hơn thêm instance.`
          : `Thêm consumer KHÔNG giúp (${M} consumer ≥ ${N} partition, consumer thừa sẽ ngồi chơi). Phải tăng tốc xử lý mỗi message (batch, bất đồng bộ, bỏ việc thừa) hoặc tăng số partition của topic — tăng partition làm đổi phân bố key, xem lại nếu cần thứ tự theo key.`,
        sql: canScale
          ? undefined
          : `kafka-topics.sh --bootstrap-server <broker> --alter --topic ${f.topics[0]?.name ?? '<topic>'} --partitions ${N * 2}`,
        step: canScale
          ? { phase: 'now', text: `Scale consumer của ${g} lên tối đa ${N} instance (đang ${M})` }
          : { phase: 'long', text: `Tăng tốc xử lý mỗi message hoặc tăng partition — đã ${M} consumer/${N} partition` },
      });
    } else if (C > P && lagDelta < 0) {
      const eta = totalLag / Math.max(0.001, C - P);
      out.push({
        id: 'draining',
        level: 'info',
        title: `Đang đuổi kịp — dự kiến hết lag sau ${fmtSec(eta)}`,
        evidence: [`Tiêu thụ ${rate(C)} > sản xuất ${rate(P)} · lag giảm ${fmtN(-lagDelta / Math.max(1, f.sec))} msg/s`],
        fix: eta <= TRANSIENT_ETA_SEC
          ? 'Lag tạm thời do một đợt producer dồn; consumer đủ sức. Không cần xử lý trừ khi lặp lại thường xuyên.'
          : 'Đang giảm nhưng chậm; nếu cần hết sớm thì thêm consumer (nếu còn dưới số partition).',
        step: { phase: 'observe', text: `Theo dõi — lag đang giảm, dự kiến hết sau ${fmtSec(eta)}` },
      });
    } else {
      out.push({
        id: 'steady',
        level: 'info',
        title: `Lag đứng quanh ${fmtN(totalLag)} — consumer theo kịp producer`,
        evidence: [`Tiêu thụ ${rate(C)} ≈ sản xuất ${rate(P)}`, 'Thường do commit theo lô / theo chu kỳ: luôn còn một phần chưa commit'],
      });
    }
  }

  // 7. Lag dồn vào một partition.
  for (const t of f.topics) {
    const tps = ps.filter((p) => p.topic === t.name);
    const tLag = tps.reduce((a, p) => a + (p.lag ?? 0), 0);
    if (tps.length < 3 || tLag < SKEW_MIN_LAG) continue;
    const [top, second] = [...tps].sort((a, b) => (b.lag ?? 0) - (a.lag ?? 0));
    // "Dồn vào MỘT partition": chiếm ≥ nửa lag VÀ gấp đôi partition nặng thứ hai —
    // hai partition lag ngang nhau (mỗi cái 50%) không phải lệch.
    if ((top.lag ?? 0) / tLag < SKEW_SHARE || (top.lag ?? 0) < 2 * (second?.lag ?? 0)) continue;
    const sortedProd = tps.map((p) => p.produce).sort((a, b) => a - b);
    const median = sortedProd[Math.floor(sortedProd.length / 2)];
    const hotKey = top.produce > 0 && top.produce >= Math.max(1, median) * 2;
    out.push({
      id: `skew:${t.name}`,
      level: 'warn',
      title: `${Math.round(((top.lag ?? 0) / tLag) * 100)}% lag của ${t.name} dồn vào partition ${top.partition}`,
      evidence: [
        `${tp(top)}: lag ${fmtN(top.lag ?? 0)} · sản xuất ${rate(top.produce)} (trung vị các partition ${rate(median)})${top.owner ? ` · do ${top.owner} xử lý` : ''}`,
        hotKey ? 'Partition này nhận nhiều message hơn hẳn → key phân vùng bị lệch (hot key)' : 'Partition này không nhận nhiều hơn → consumer giữ nó xử lý chậm hơn',
      ],
      fix: hotKey
        ? 'Key dùng để chia partition dồn vào vài giá trị (vd một tenant/khách hàng rất lớn). Đổi key (thêm hậu tố ngẫu nhiên cho key nóng nếu không cần thứ tự tuyệt đối), hoặc tách key nóng sang topic riêng. Thêm consumer không giúp: một partition chỉ một consumer.'
        : `Xem instance ${top.owner ?? 'giữ partition này'}: máy yếu hơn, đang GC, hay gặp message xử lý lâu. Restart instance đó sẽ chuyển partition sang consumer khác.`,
      step: { phase: hotKey ? 'long' : 'now', text: hotKey
        ? `Sửa key phân vùng lệch của ${t.name} (partition ${top.partition} quá nóng)`
        : `Kiểm tra instance ${top.owner ?? '?'} — partition ${tp(top)} chậm hơn các partition khác` },
    });
  }

  // 8. Consumer thừa.
  if (f.assignmentKnown && M > N) {
    const idle = f.members.filter((m) => m.assigned === 0).length;
    if (idle) {
      out.push({
        id: 'idle',
        level: 'info',
        title: `${idle} consumer không được gán partition nào (ngồi chơi)`,
        evidence: [`${M} consumer / ${N} partition — số consumer có việc tối đa bằng số partition`],
        fix: 'Giảm số instance về ≤ số partition cho đỡ tốn tài nguyên, hoặc tăng partition nếu thật sự cần thêm song song.',
      });
    }
  }

  // 9. Sắp mất dữ liệu vì retention.
  if (f.oldest) {
    const t = f.topics.find((x) => x.name === f.oldest!.topic);
    if (t && !t.compact && t.retentionMs && t.retentionMs > 0) {
      const ratio = (f.oldest.ageSec * 1000) / t.retentionMs;
      if (ratio >= RETENTION_WARN) {
        out.push({
          id: 'retention',
          level: ratio >= RETENTION_CRIT ? 'crit' : 'warn',
          title: `Sắp mất dữ liệu: message chờ ${fmtSec(f.oldest.ageSec)} / retention ${fmtSec(t.retentionMs / 1000)} của ${t.name}`,
          evidence: [`${Math.round(ratio * 100)}% thời hạn giữ — quá hạn thì broker xoá message trước khi consumer kịp đọc`],
          fix: 'Tăng retention TẠM THỜI cho topic để không mất message trong lúc xử lý lag, rồi trả lại sau khi hết lag (retention dài tốn đĩa broker).',
          sql: `kafka-configs.sh --bootstrap-server <broker> --alter --entity-type topics --entity-name ${t.name} --add-config retention.ms=${Math.round(t.retentionMs * 2)}`,
          step: { phase: 'now', text: `Tăng retention tạm cho ${t.name} — message chờ đã ${Math.round(ratio * 100)}% thời hạn giữ` },
        });
      }
    }
  }

  const findings = sortFindings(out);
  const rows: KPartitionRow[] = [...ps]
    .sort((a, b) => (b.lag ?? -1) - (a.lag ?? -1))
    .slice(0, MAX_ROWS)
    .map((p) => ({
      topic: p.topic,
      partition: p.partition,
      lag: p.lag,
      produceRate: r1(p.produce),
      consumeRate: p.consume === null ? null : r1(p.consume),
      owner: p.owner,
      status: !p.hasLeader ? 'Không có leader'
        : (p.lag ?? 0) === 0 ? 'Bắt kịp'
          : p.consume === 0 ? 'Đứng im'
            : (p.consume ?? 0) < p.produce ? 'Chậm hơn producer'
              : 'Đang đuổi kịp',
    }));

  return {
    at,
    groupId: g,
    sec: f.sec,
    totalLag,
    lagDelta,
    produceRate: r1(P),
    consumeRate: r1(C),
    members: M,
    partitionCount: N,
    headline: headline(findings, totalLag, g),
    findings,
    plan: buildPlan(findings, `Phân tích lại sau khi xử lý — lag của ${g} phải giảm đều`),
    rows,
    memberRows: f.members,
  };
}

function headline(findings: Finding[], totalLag: number, g: string): string {
  if (totalLag === 0) return `Group ${g} không còn lag — cảnh báo đã cũ.`;
  const cause = findings.find((x) => x.level === 'crit' || x.level === 'warn');
  if (!cause) {
    const info = findings.find((x) => x.id === 'draining' || x.id === 'steady');
    return `Lag ${fmtN(totalLag)} — ${info ? info.title.charAt(0).toLowerCase() + info.title.slice(1) : 'không thấy nguyên nhân rõ ràng trong cửa sổ đo'}.`;
  }
  return `Lag ${fmtN(totalLag)} — nguyên nhân chính: ${cause.title.charAt(0).toLowerCase()}${cause.title.slice(1)}.`;
}
