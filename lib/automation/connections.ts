'use client';

// Connection pickers for the automation UI.
//
// Every stack registry in the DevBox already exposes `{ id, name, project }` —
// that is all a watch (or a Kafka action) needs, so the editor loads one flat
// option list per stack instead of importing six different connection types.

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
}

const LOADERS: Record<InfraStack, () => Promise<{ connections: ConnOption[] }>> = {
  redis: fetchRedisConnections,
  mongo: fetchMongoConnections,
  es: fetchEsConnections,
  kafka: fetchKafkaConnections,
  rabbit: fetchRabbitConnections,
  pg: fetchPgConnections,
};

const cache = new Map<InfraStack, ConnOption[]>();

/** Load (and memoize) the connection list of one stack. Never throws. */
export async function listConnections(stack: InfraStack): Promise<ConnOption[]> {
  const hit = cache.get(stack);
  if (hit) return hit;
  try {
    const res = await LOADERS[stack]();
    const opts = (res.connections ?? []).map((c) => ({ id: c.id, name: c.name, project: c.project }));
    cache.set(stack, opts);
    return opts;
  } catch {
    return [];
  }
}

/** Drop the memo so a newly-added connection shows up without a restart. */
export const refreshConnections = (): void => cache.clear();

export const connLabel = (c: ConnOption): string => (c.project ? `${c.name} · ${c.project}` : c.name);
