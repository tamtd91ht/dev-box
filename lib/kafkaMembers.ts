// Giải mã member của consumer group (describeGroups): metadata = topic đăng ký, assignment = partition được
// giao. Chỉ group giao thức "consumer" mới có định dạng này (Kafka Connect / group tự quản thì bỏ qua).
// Member giải mã hỏng vẫn được đếm — chỉ là không biết topic/partition của nó.
//
// Chỉ dùng phía server (kéo kafkajs). Logic cân bằng thuần nằm ở lib/kafkaBalance.ts.

import { AssignerProtocol } from 'kafkajs';
import type { KafkaMemberInfo } from './kafkaBalance';

/** Hình tối thiểu của một member trong phản hồi describeGroups. */
export interface RawGroupMember {
  memberId: string;
  clientId?: string;
  clientHost?: string;
  memberMetadata?: Buffer;
  memberAssignment?: Buffer;
}

/** `null` = không phải group consumer thường → không đánh giá được cân bằng. */
export function decodeMembers(protocolType: string | undefined, members: RawGroupMember[] | undefined): KafkaMemberInfo[] | null {
  if (protocolType && protocolType !== 'consumer') return null;
  return (members ?? []).map((m) => {
    let topics: string[] = [];
    let assigned: Record<string, number[]> = {};
    try {
      if (m.memberMetadata?.length) topics = AssignerProtocol.MemberMetadata.decode(m.memberMetadata)?.topics ?? [];
    } catch {
      /* metadata lạ — để trống */
    }
    try {
      if (m.memberAssignment?.length) assigned = AssignerProtocol.MemberAssignment.decode(m.memberAssignment)?.assignment ?? {};
    } catch {
      /* assignment lạ — để trống */
    }
    return { memberId: m.memberId, clientId: m.clientId ?? '', host: (m.clientHost ?? '').replace(/^\//, ''), topics, assigned };
  });
}

/** Nhãn consumer giữ partition: "clientId@host" (thiếu host thì chỉ clientId / memberId). */
export function memberLabel(m: Pick<KafkaMemberInfo, 'memberId' | 'clientId' | 'host'>): string {
  const id = m.clientId || m.memberId;
  return m.host ? `${id}@${m.host}` : id;
}
