'use client';

// Connection pickers for the automation UI — and the ADDRESS every infra event
// carries in its metadata.
//
// Mỗi registry đã có sẵn projection public KHÔNG password (PublicXxxConnection);
// ở đây chiếu tiếp xuống một option phẳng { id, name, project, address }. Address
// đi vào fields.address / AlertMeta.address để tin cảnh báo tự nói "máy nào" —
// người trực hoặc bot AI không phải mở DevBox tra ngược connectionId.

import { fetchEsConnections } from '@/lib/es';
import { fetchKafkaConnections } from '@/lib/kafka';
import { fetchMongoConnections } from '@/lib/mongo';
import { fetchPgConnections } from '@/lib/pg';
import { fetchRabbitConnections } from '@/lib/rabbit';
import { fetchRedisConnections } from '@/lib/redis';
import type { InfraStack } from './types';

export interface ConnOption {
  id: string;
  name: string;
  project: string;
  /** "host:port" (nhiều node: nối bằng ", ", tối đa 3 + "(+N)"). '' khi chưa rõ. */
  address: string;
}

/**
 * Gột credential khỏi một chuỗi địa chỉ. Projection public vốn không mang
 * password, nhưng field host là chuỗi NGƯỜI GÕ — "user:pass@10.0.0.1" dán từ
 * connection string là chuyện có thật. Address đi vào tin nhắn Zalo/Telegram
 * nên phòng thủ ở đây, một lần, cho mọi stack.
 */
export function sanitizeAddress(raw: string): string {
  // "scheme://user:pass@host" → "scheme://host" · "user:pass@host" → "host"
  return (raw ?? '').trim().replace(/(^|\/\/)[^@/\s]+@/g, '$1');
}

/** Nối danh sách node thành một address đọc được — cụm ES 12 node không được đẻ ra chuỗi 500 ký tự. */
function joinAddrs(xs: (string | undefined)[]): string {
  const clean = xs.map((x) => sanitizeAddress(x ?? '')).filter(Boolean);
  const head = clean.slice(0, 3).join(', ');
  return clean.length > 3 ? `${head} (+${clean.length - 3})` : head;
}

// Per-stack projectors. Each fetch already returns the password-free public
// shape; all that happens here is choosing what "address" means for that stack.
const LOADERS: Record<InfraStack, () => Promise<ConnOption[]>> = {
  redis: async () =>
    (await fetchRedisConnections()).connections.map((c) => ({
      id: c.id,
      name: c.name,
      project: c.project,
      address: joinAddrs(
        c.mode === 'cluster' && c.nodes?.length
          ? c.nodes.map((nd) => `${nd.host}:${nd.port}`)
          : [c.host ? `${c.host}:${c.port}` : ''],
      ),
    })),
  mongo: async () =>
    (await fetchMongoConnections()).connections.map((c) => ({
      id: c.id,
      name: c.name,
      project: c.project,
      // srv: một hostname DNS đại diện cả cụm — giữ scheme để người đọc hiểu.
      address: joinAddrs(c.hosts.map((h) => (c.scheme === 'mongodb+srv' ? `mongodb+srv://${h}` : h))),
    })),
  es: async () =>
    (await fetchEsConnections()).connections.map((c) => ({
      id: c.id,
      name: c.name,
      project: c.project,
      address: joinAddrs(c.nodes.map((nd) => (c.tls ? `https://${nd}` : nd))),
    })),
  kafka: async () =>
    (await fetchKafkaConnections()).connections.map((c) => ({
      id: c.id,
      name: c.name,
      project: c.project,
      address: joinAddrs(c.brokers),
    })),
  rabbit: async () =>
    (await fetchRabbitConnections()).connections.map((c) => ({
      id: c.id,
      name: c.name,
      project: c.project,
      address: joinAddrs(c.nodes.map((nd) => (c.tls ? `https://${nd}` : nd))),
    })),
  pg: async () =>
    (await fetchPgConnections()).connections.map((c) => ({
      id: c.id,
      name: c.name,
      project: c.project,
      address: joinAddrs([`${c.host}:${c.port}/${c.database}`]),
    })),
};

const cache = new Map<InfraStack, ConnOption[]>();

/** Load (and memoize) the connection list of one stack. Never throws. */
export async function listConnections(stack: InfraStack): Promise<ConnOption[]> {
  const hit = cache.get(stack);
  if (hit) return hit;
  try {
    const opts = await LOADERS[stack]();
    cache.set(stack, opts);
    return opts;
  } catch {
    return [];
  }
}

/**
 * Address của một kết nối, ĐỒNG BỘ từ cache — cho watcher gắn vào event ngay
 * lúc breach mà không chờ I/O. Cache lạnh (vòng poll đầu sau khi mở app) trả
 * '' — cảnh báo vẫn phát đầy đủ, chỉ thiếu address; reconcile() đã warm sẵn
 * nên trạng thái đó chỉ sống được vài giây.
 */
export function peekAddress(stack: InfraStack, connectionId: string): string {
  return cache.get(stack)?.find((c) => c.id === connectionId)?.address ?? '';
}

/** Drop the memo so a newly-added connection shows up without a restart. */
export const refreshConnections = (): void => cache.clear();

export const connLabel = (c: ConnOption): string => (c.project ? `${c.name} · ${c.project}` : c.name);
