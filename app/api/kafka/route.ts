// /api/kafka — single dispatch route for all Kafka operations.
//
//   POST { action, ... }  where action is one of:
//     'test'          { brokers }                              → { latencyMs, brokers }  (unsaved connection)
//     'listTopics'    { connectionId }                         → TopicSummary[]
//     'describeTopic' { connectionId, topic }                  → TopicDetail
//     'listGroups'    { connectionId }                         → GroupSummary[]
//     'describeGroup' { connectionId, groupId }                → GroupDetail
//     'consumerLag'   { connectionId }                         → KafkaConsumerLag  (every group, one sweep)
//     'topicGroups'   { connectionId, topic }                  → TopicConsumerGroup[]
//     'peek'          { connectionId, topic, limit? }          → MessagePage
//     'search'        { connectionId, topic, fromMs, toMs, keyword } → MessagePage
//     'produce'       { connectionId, topic, key?, value, partition? } → { partition, offset }
//
// SEARCH requires a full time window (fromMs/toMs) AND a keyword — enforced here
// (400) as well as in the client. Gated by KAFKA_TOOL_ENABLED (403 when off). The
// browser never talks to Kafka directly — this server-side handler owns the
// kafkajs connection. Any Kafka / network error is caught and returned as
// { ok:false, error, detail } so the UI can render it instead of hanging.

import { NextResponse, type NextRequest } from 'next/server';
import {
  KAFKA_ENABLED,
  testConnection,
  clusterHealth,
  hostMetrics,
  brokerReachability,
  listTopics,
  describeTopic,
  listGroups,
  describeGroup,
  consumerLag,
  listTopicGroups,
  peekMessages,
  searchMessages,
  produce,
} from '@/lib/kafkaClient';
import { getConnection } from '@/lib/kafkaConnections';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!KAFKA_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Kafka tool is disabled. Set KAFKA_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;

  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  // 'test' probes an unsaved connection — raw broker list, no connectionId.
  if (action === 'test') {
    try {
      const result = await testConnection({
        brokers: Array.isArray(body.brokers)
          ? body.brokers.map((b: unknown) => String(b))
          : typeof body.brokers === 'string'
            ? body.brokers.split(/[\s,]+/).filter(Boolean)
            : [],
      });
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: (err as Error).message || 'Connection test failed', detail: String(err) },
        { status: 502 },
      );
    }
  }

  const connectionId = body?.connectionId as string | undefined;
  if (!connectionId) {
    return NextResponse.json({ ok: false, error: 'Missing connectionId' }, { status: 400 });
  }

  const conn = await getConnection(connectionId);
  if (!conn) {
    return NextResponse.json({ ok: false, error: `Unknown connection: ${connectionId}` }, { status: 404 });
  }

  // Validate the search contract up front (time window + keyword all required).
  if (action === 'search') {
    const fromMs = Number(body.fromMs);
    const toMs = Number(body.toMs);
    const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !keyword) {
      return NextResponse.json(
        { ok: false, error: 'search requires a time window (fromMs, toMs) and a keyword' },
        { status: 400 },
      );
    }
  }

  try {
    let result: unknown;
    switch (action) {
      case 'listTopics':
        result = await listTopics(conn);
        break;
      case 'clusterHealth': // brokers/URP/offline monitor (60s)
        result = await clusterHealth(conn);
        break;
      case 'hostMetrics': // node_exporter RAM/disk/cpu/load (optional, per connection)
        result = await hostMetrics(conn);
        break;
      case 'brokerReach': // bắt tay TCP từng seed broker — chẩn đoán lúc cụm không trả lời
        result = await brokerReachability(conn);
        break;
      case 'describeTopic':
        result = await describeTopic(conn, String(body.topic ?? ''));
        break;
      case 'listGroups':
        result = await listGroups(conn);
        break;
      case 'describeGroup':
        result = await describeGroup(conn, String(body.groupId ?? ''));
        break;
      case 'consumerLag': // every group's lag + stall age (monitor / automation)
        result = await consumerLag(conn);
        break;
      case 'topicGroups':
        result = await listTopicGroups(conn, String(body.topic ?? ''));
        break;
      case 'peek':
        result = await peekMessages(conn, String(body.topic ?? ''), Number(body.limit ?? 20));
        break;
      case 'search':
        result = await searchMessages(conn, {
          topic: String(body.topic ?? ''),
          fromMs: Number(body.fromMs),
          toMs: Number(body.toMs),
          keyword: String(body.keyword ?? ''),
        });
        break;
      case 'produce':
        result = await produce(conn, {
          topic: String(body.topic ?? ''),
          key: body.key != null ? String(body.key) : undefined,
          value: String(body.value ?? ''),
          partition: body.partition != null ? Number(body.partition) : undefined,
        });
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'Kafka operation failed', detail: String(err) },
      { status: 502 },
    );
  }
}
