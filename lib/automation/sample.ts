// DevBox Automation — event MẪU cho từng case trigger.
//
// UI (bảng "Biến khả dụng & JSON mẫu", nút "Nạp mẫu" của bảng Thử) và script
// check:automation đều cần một event đại diện. Với infra, mẫu KHÔNG viết tay:
// nó dựng một InfraWatch giả lập rồi gọi CHÍNH infraBreachEvent/
// infraRecoveredEvent — nên field trong mẫu không bao giờ lệch được emission
// thật; thêm field vào sources/infra.ts là mẫu tự có theo.
//
// Tách khỏi meta.ts có chủ đích: meta.ts thuần tuý (catalog + types), còn file
// này import sources/infra.ts — gộp lại sẽ thành vòng import meta ↔ infra.

import type { AutomationEvent, InfraStack, InfraWatch, TriggerType } from './types';
import { infraBreachEvent, infraRecoveredEvent, type MetricMap } from './sources/infra';

interface SampleSpec {
  watch: InfraWatch;
  address: string;
  /** Giá trị lúc vi phạm / lúc hồi phục. */
  breach: number;
  ok: number;
  /** MetricMap của lần đo mẫu — nguồn của fields tuyệt đối (absUsed/absTotal). */
  metrics?: MetricMap;
  /** MetricMap lúc hồi phục — số tuyệt đối phải khớp giá trị `ok`. */
  okMetrics?: MetricMap;
}

/** Mỗi stack một watch "tiêu biểu" — metric hay được canh nhất của stack đó. */
const INFRA_SAMPLES: Record<InfraStack, SampleSpec> = {
  redis: {
    watch: {
      id: 'w-redis-demo',
      name: 'FusionPBX — RAM cạn kiệt (>92%)',
      enabled: true,
      stack: 'redis',
      connectionId: 'omicrm-fusionpbx',
      connectionLabel: 'FusionPBX',
      metric: 'memUsedPct',
      op: 'gt',
      threshold: 92,
      everySec: 30,
      forSec: 120,
      severity: 'critical',
      tags: ['redis', 'omicrm'],
      note: 'Redis này cấp session cho tổng đài FusionPBX.',
    },
    address: '10.0.0.5:6379',
    breach: 95.2,
    ok: 61.3,
    // Cố ý là ca "90% mà nguy": 95.2% của 4GB — chỉ còn 197MB.
    metrics: { memUsedPct: 95.2, memUsedMb: 3899, memTotalMb: 4096 },
    okMetrics: { memUsedPct: 61.3, memUsedMb: 2511, memTotalMb: 4096 },
  },
  mongo: {
    watch: {
      id: 'w-mongo-demo',
      name: 'CRM — replication lag (>10s)',
      enabled: true,
      stack: 'mongo',
      connectionId: 'crm-mg-01',
      connectionLabel: 'CRM Mongo',
      metric: 'replLagSec',
      op: 'gt',
      threshold: 10,
      everySec: 60,
      forSec: 60,
      severity: 'warning',
      tags: ['mongo', 'crm'],
    },
    address: 'mg-01:27017, mg-02:27017, mg-03:27017',
    breach: 42,
    ok: 1,
  },
  es: {
    watch: {
      id: 'w-es-demo',
      name: 'ES-01 — heap cao (>85%)',
      enabled: true,
      stack: 'es',
      connectionId: 'omicrm-es-01',
      connectionLabel: 'ES-01',
      metric: 'heapPct',
      op: 'gt',
      threshold: 85,
      everySec: 60,
      forSec: 120,
      severity: 'warning',
      tags: ['es', 'omicrm'],
    },
    address: 'https://es-01:9200',
    breach: 91.4,
    ok: 68.2,
  },
  kafka: {
    watch: {
      id: 'w-kafka-demo',
      name: 'KF — consumer lag (>10k)',
      enabled: true,
      stack: 'kafka',
      connectionId: 'omicrm-kf-01',
      connectionLabel: 'Kafka OMICRM',
      metric: 'maxConsumerLag',
      op: 'gt',
      threshold: 10000,
      everySec: 120,
      forSec: 300,
      severity: 'warning',
      tags: ['kafka', 'omicrm'],
    },
    address: 'kf-01:9092, kf-02:9092, kf-03:9092',
    breach: 84210,
    ok: 1200,
  },
  rabbit: {
    watch: {
      id: 'w-rabbit-demo',
      name: 'RB-01 — message tồn (>10k)',
      enabled: true,
      stack: 'rabbit',
      connectionId: 'omicrm-rb-01',
      connectionLabel: 'RB-01',
      metric: 'messagesReady',
      op: 'gt',
      threshold: 10000,
      everySec: 30,
      forSec: 120,
      severity: 'warning',
      tags: ['rabbit', 'omicrm'],
    },
    address: 'rb-01:15672',
    breach: 25310,
    ok: 830,
  },
  pg: {
    watch: {
      id: 'w-pg-demo',
      name: 'PG CRM — mất kết nối',
      enabled: true,
      stack: 'pg',
      connectionId: 'crm-pg-01',
      connectionLabel: 'PG CRM',
      metric: 'up',
      op: 'lt',
      threshold: 1,
      everySec: 60,
      forSec: 0,
      severity: 'critical',
      tags: ['pg', 'crm'],
    },
    address: '10.0.0.9:5432/omicrm',
    breach: 0,
    ok: 1,
  },
};

const SAMPLE_DOWN_SEC = 340;

/**
 * Event mẫu cho một trigger (infra: chọn thêm stack, mặc định redis).
 * `at` mặc định là "bây giờ" — UI truyền cố định khi cần render ổn định.
 */
export function sampleEvent(trigger: TriggerType, stack: InfraStack = 'redis', at = Date.now()): AutomationEvent {
  if (trigger === 'infra.metric' || trigger === 'infra.recovered') {
    const spec = INFRA_SAMPLES[stack] ?? INFRA_SAMPLES.redis;
    return trigger === 'infra.metric'
      ? infraBreachEvent(spec.watch, spec.breach, at, { address: spec.address, metrics: spec.metrics })
      : infraRecoveredEvent(spec.watch, spec.ok, at, SAMPLE_DOWN_SEC, {
          address: spec.address,
          metrics: spec.okMetrics ?? spec.metrics,
        });
  }

  if (trigger === 'message.received') {
    // Nhánh Zalo API (đủ field nhất — có threadId thật); nguồn DOM giống hệt
    // nhưng capture:'notification'|'dom' và threadId rỗng. Khớp shape của
    // lib/zaloapi/event.ts zaloIncomingEvent().
    return {
      id: `zaloapi:sample:${at}`,
      ts: at,
      category: 'social',
      type: 'message.received',
      sourceId: 'zaloapi',
      instanceId: 'zapi-1',
      instanceLabel: 'Zalo API — Tài khoản chính',
      title: 'OMITeam',
      text: 'Anh gửi báo cáo giúp em nhé',
      fields: {
        sender: 'Nguyễn Văn A',
        conversation: 'OMITeam',
        chatType: 'group',
        app: 'Zalo API',
        capture: 'ws',
        threadId: 'g8134772156',
      },
    };
  }

  // system.test — bảng thử: field tự do.
  return {
    id: `test:sample:${at}`,
    ts: at,
    category: 'system',
    type: 'system.test',
    sourceId: 'devbox',
    instanceId: 'main',
    instanceLabel: 'DevBox',
    title: 'Sự kiện thử',
    text: 'Nội dung thử từ bảng Test',
    fields: {},
  };
}
