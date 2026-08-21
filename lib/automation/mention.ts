// Bảng phân công tag (@) khi gửi Zalo nhóm — phần ĐÁNH GIÁ, thuần khiết.
//
// Vào: config (danh bạ + bảng phân công) + event. Ra: danh sách người cần tag
// kèm lý do từng người — để dry-run và trace nói được "tag @A vì dòng topic-A"
// thay vì một phép màu vô hình.
//
// Chi phí: vài chục phép so chuỗi trên dữ liệu đã nằm sẵn trong RAM, chỉ chạy
// khi một action zaloApiSend có bật cờ tagAssignees thật sự bắn — tức là sau
// khi rule đã khớp và qua hết cooldown/dedupe. Không thêm request, không I/O.

import { testConditions } from './match';
import type { AutomationConfig, AutomationEvent, MentionAssignment, ZaloMentionPerson } from './types';

/** Người sẽ được tag trong tin nhắn (đổ vào mentionInfo của Zalo). */
export interface ResolvedMention {
  uid: string;
  name: string;
}

export interface MentionResolution {
  people: ResolvedMention[];
  /** Mô tả vì sao — mỗi dòng khớp một câu, kèm alias thiếu danh bạ (nếu có). */
  why: string[];
}

/** Trần số người tag một tin — quá số này là spam cả nhóm, không còn là báo. */
export const MAX_MENTIONS = 5;

/**
 * Nhóm metric "sự cố hạ tầng" (kiểu 'infra'): mất kết nối + tài nguyên máy.
 * Khớp theo tên chính xác HOẶC theo mẫu tài nguyên (disk/mem/cpu/load/heap…)
 * để phủ cả biến thể theo stack (diskUsedPct, hostDiskUsedPct, memResidentMb…)
 * mà không phải liệt kê đuổi theo catalog.
 */
const INFRA_EXACT = new Set([
  'up', // probe không kết nối được — metric chung mọi stack
  'brokers', 'noController', // Kafka: cụm mất broker / mất controller
  'hostsDown', 'hostsTotal', // Kafka: broker host mất node_exporter
  'nodes', 'membersUnhealthy', // ES/Mongo: cụm mất node / member ốm
]);
const INFRA_RESOURCE_RE = /disk|mem|cpu|load|heap|fragmentation/i;

function isInfraMetric(metric: string): boolean {
  return INFRA_EXACT.has(metric) || INFRA_RESOURCE_RE.test(metric);
}

/** Chuỗi gộp những chỗ tên topic có thể xuất hiện trong một event Kafka. */
function topicHaystack(event: AutomationEvent): string {
  const f = event.fields ?? {};
  return [f.topics, f.groups, event.title, event.text]
    .map((x) => String(x ?? ''))
    .join('\n')
    .toLowerCase();
}

/** Một dòng phân công có khớp event này không? */
export function assignmentMatches(a: MentionAssignment, event: AutomationEvent): boolean {
  if (!a.enabled || a.tag.length === 0) return false;
  switch (a.kind) {
    case 'topic': {
      const topics = (a.values ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (!topics.length) return false;
      const hay = topicHaystack(event);
      return topics.some((t) => hay.includes(t));
    }
    case 'infra': {
      const metric = String(event.fields?.metric ?? '');
      if (!metric) return false;
      const only = (a.values ?? []).map((m) => m.trim()).filter(Boolean);
      return only.length > 0 ? only.includes(metric) : isInfraMetric(metric);
    }
    case 'custom':
      return (a.conditions?.length ?? 0) > 0 && testConditions(event, 'all', a.conditions ?? []);
    default:
      return false;
  }
}

/** Nhãn ngắn của một dòng — cho dry-run/trace. */
function assignmentLabel(a: MentionAssignment): string {
  if (a.note?.trim()) return a.note.trim();
  if (a.kind === 'topic') return `topic ${(a.values ?? []).join(', ')}`;
  if (a.kind === 'infra') return (a.values?.length ? `metric ${a.values.join(', ')}` : 'sự cố hạ tầng');
  return 'điều kiện tuỳ ý';
}

/**
 * Gom mọi dòng khớp → danh sách người cần tag (cộng dồn, khử trùng theo uid,
 * trần MAX_MENTIONS) + lý do từng dòng. Alias không có trong danh bạ được nêu
 * đích danh trong `why` thay vì rơi rụng im lặng.
 */
export function resolveMentions(
  config: Pick<AutomationConfig, 'mentionPeople' | 'mentionAssignments'>,
  event: AutomationEvent,
): MentionResolution {
  const byAlias = new Map<string, ZaloMentionPerson>(
    (config.mentionPeople ?? []).map((p) => [p.alias.toLowerCase(), p]),
  );
  const people: ResolvedMention[] = [];
  const seen = new Set<string>();
  const why: string[] = [];
  const missing = new Set<string>();

  for (const a of config.mentionAssignments ?? []) {
    if (!assignmentMatches(a, event)) continue;
    const tagged: string[] = [];
    for (const alias of a.tag) {
      const p = byAlias.get(alias.trim().toLowerCase());
      if (!p || !p.uid.trim()) { missing.add(alias); continue; }
      if (seen.has(p.uid)) continue;
      if (people.length >= MAX_MENTIONS) break;
      seen.add(p.uid);
      people.push({ uid: p.uid.trim(), name: p.name.trim() || p.alias });
      tagged.push(`@${p.name || p.alias}`);
    }
    if (tagged.length) why.push(`${assignmentLabel(a)} → ${tagged.join(' ')}`);
  }
  if (missing.size) why.push(`⚠ alias chưa có trong danh bạ: ${[...missing].join(', ')}`);
  return { people, why };
}
