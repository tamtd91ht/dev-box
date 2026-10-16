// Từ một dòng Monitor đang báo → chỗ cần mở trong tab công cụ: đúng cụm, và
// đúng mục liên quan tới nguyên nhân NẶNG NHẤT (lag → group đang lag, queue
// tồn → danh sách queue…). Cảnh báo nào không có màn hình riêng thì mở Tổng
// quan của cụm — vẫn đúng cụm, khỏi phải tự đi tìm trong rail.

import type { InfraFocus } from '../infraFocus';
import type { Row } from './useMonitor';

const KAFKA_GROUP_METRICS = new Set(['maxConsumerLag', 'deadLagGroups', 'stalledGroups', 'maxStalledSec', 'lagGroupsUnknown']);
const RABBIT_QUEUE_METRICS = new Set(['messagesReady', 'messagesUnacked']);

export function focusFromRow(row: Row): InfraFocus {
  const { res, ev, st } = row;
  const base: InfraFocus = { stack: res.stack, connId: res.id };
  // reasons đã xếp theo luật; lấy lý do nặng nhất (crit/down trước warn).
  const rank = { down: 3, crit: 2, warn: 1 } as const;
  const top = [...ev.reasons].sort((a, b) => rank[b.level] - rank[a.level])[0];
  const metric = top?.metric;

  switch (res.stack) {
    case 'kafka': {
      if (!metric || !KAFKA_GROUP_METRICS.has(metric)) return { ...base, view: 'topics' };
      const groups = st.last?.kafkaGroups ?? [];
      // Group đúng với loại cảnh báo: chết (lag mà 0 member) / tắc lâu nhất /
      // lag lớn nhất. Không có số liệu group (vòng đo nhẹ) → màn Lag quét cả cụm.
      const pick =
        metric === 'deadLagGroups' ? groups.filter((g) => g.described && g.members === 0 && g.lag > 0).sort((a, b) => b.lag - a.lag)[0]
        : metric === 'stalledGroups' || metric === 'maxStalledSec' ? groups.filter((g) => g.stalledSec != null).sort((a, b) => (b.stalledSec ?? 0) - (a.stalledSec ?? 0))[0]
        : metric === 'lagGroupsUnknown' ? undefined
        : [...groups].sort((a, b) => b.lag - a.lag)[0];
      return pick ? { ...base, view: 'groups', group: pick.groupId } : { ...base, view: 'lag' };
    }
    case 'rabbit':
      return { ...base, view: metric && RABBIT_QUEUE_METRICS.has(metric) ? 'queues' : 'overview' };
    default:
      return { ...base, view: 'overview' };
  }
}
