// Pure AMQP routing resolver — "if I publish to exchange E with routing key K,
// which queues actually receive it?". Browser-safe (no server imports, no I/O):
// it works off an already-fetched binding list, so the route tester costs ZERO
// extra management-API calls and re-computes instantly as you type.
//
// Why compute instead of asking the broker: RabbitMQ has no "explain route"
// endpoint. The only way to ask the broker is to publish a real message and see
// where it lands — which is a side effect you don't want while debugging. The
// binding table is the whole truth for direct/topic/fanout, so we replay
// RabbitMQ's own matching rules locally.
//
// HONEST LIMIT: `headers` exchanges route on message headers + the x-match
// argument, NOT on the routing key. That cannot be simulated from a routing key
// alone, so resolveRoute() reports `unsupported` for them rather than guessing.

import type { BindingInfo } from './rabbit';

export type ExchangeType = 'direct' | 'topic' | 'fanout' | 'headers' | string;

/** One queue the message reaches, plus the hop chain that got it there. */
export interface RouteHit {
  queue: string;
  /** Exchange→exchange hops walked before landing on the queue (empty = direct hit). */
  via: string[];
  /** The routing key on the final binding into the queue. */
  matchedRoutingKey: string;
}

export interface RouteResult {
  hits: RouteHit[];
  /** Exchange types encountered that cannot be simulated (always `headers`). */
  unsupported: { exchange: string; type: string }[];
  /** True when the named exchange was not found in the binding/exchange set. */
  unknownExchange: boolean;
}

/**
 * AMQP topic matching. Keys are dot-delimited words; `*` matches exactly one
 * word, `#` matches zero or more words. Implemented as a small backtracking
 * matcher over the word arrays — correct for the `#` cases a regex translation
 * gets subtly wrong (e.g. "a.#.b" against "a.b").
 */
export function matchTopicPattern(pattern: string, key: string): boolean {
  const p = pattern === '' ? [] : pattern.split('.');
  const k = key === '' ? [] : key.split('.');

  // memo[pi][ki] — avoids exponential blowup on patterns with several '#'.
  const memo = new Map<string, boolean>();

  const walk = (pi: number, ki: number): boolean => {
    const cacheKey = `${pi}:${ki}`;
    const cached = memo.get(cacheKey);
    if (cached !== undefined) return cached;

    let out: boolean;
    if (pi === p.length) {
      out = ki === k.length;
    } else if (p[pi] === '#') {
      // '#' absorbs 0..n words — try every split point.
      out = false;
      for (let take = 0; ki + take <= k.length; take++) {
        if (walk(pi + 1, ki + take)) { out = true; break; }
      }
    } else if (ki === k.length) {
      out = false; // pattern still has a concrete word but the key ran out
    } else if (p[pi] === '*' || p[pi] === k[ki]) {
      out = walk(pi + 1, ki + 1);
    } else {
      out = false;
    }

    memo.set(cacheKey, out);
    return out;
  };

  return walk(0, 0);
}

/** Does one binding on `type` exchange match `routingKey`? */
function bindingMatches(type: ExchangeType, bindingKey: string, routingKey: string): boolean {
  switch (type) {
    case 'fanout':
      return true; // routing key ignored entirely
    case 'topic':
      return matchTopicPattern(bindingKey, routingKey);
    case 'direct':
      return bindingKey === routingKey;
    default:
      // 'headers' and unknown plugin types — walk() reports these as unsupported
      // before ever getting here, so returning false is only a safety net.
      return false;
  }
}

/**
 * Reduce a declared exchange type to one we can actually simulate.
 *
 * `x-delayed-message` (the delayed-message plugin, in use on this cluster) holds
 * the message for `x-delay` ms and THEN routes it exactly like a normal exchange
 * of the type named in its `x-delayed-type` argument. So the destination set is
 * fully predictable — only the timing isn't — and treating it as unsupported
 * would wrongly report "no queue matched" for an exchange that routes fine.
 *
 * Returns null for anything genuinely unsimulatable (`headers`, unknown plugins).
 */
function effectiveType(type: ExchangeType, args: Record<string, unknown> | undefined): ExchangeType | null {
  if (type === 'direct' || type === 'topic' || type === 'fanout') return type;
  if (type === 'x-delayed-message') {
    const inner = String(args?.['x-delayed-type'] ?? '');
    // Plugin defaults to direct when the argument is absent.
    if (inner === 'topic' || inner === 'fanout' || inner === 'direct') return inner;
    if (inner === '') return 'direct';
    return null; // e.g. x-delayed-type: headers
  }
  return null;
}

/**
 * Resolve every queue reachable from `exchange` with `routingKey`.
 *
 * Walks exchange→exchange bindings recursively so a queue reached through an
 * E→E chain is still found (a real pattern: a topic fan-in exchange bound onto a
 * per-team exchange). Cycles are guarded with a visited set — RabbitMQ permits
 * binding loops and would otherwise hang this walk.
 *
 * `exchangeTypes` maps exchange name → type; anything missing is treated as
 * 'direct' (the AMQP default) rather than skipped, so a partial type map still
 * yields useful output. `exchangeArgs` is only consulted for plugin types that
 * delegate their routing (`x-delayed-message` → `x-delayed-type`).
 */
export function resolveRoute(
  bindings: BindingInfo[],
  exchange: string,
  routingKey: string,
  exchangeTypes: Record<string, ExchangeType>,
  exchangeArgs: Record<string, Record<string, unknown>> = {},
): RouteResult {
  const hits: RouteHit[] = [];
  const unsupported: { exchange: string; type: string }[] = [];
  const seenQueues = new Set<string>();
  const visitedExchanges = new Set<string>();

  // Index bindings by source exchange once — O(n) instead of a scan per hop.
  const bySource = new Map<string, BindingInfo[]>();
  for (const b of bindings) {
    if (!b.source) continue; // default-exchange rows have an empty source
    const arr = bySource.get(b.source) ?? [];
    arr.push(b);
    bySource.set(b.source, arr);
  }

  const knownExchange = bySource.has(exchange) || exchange in exchangeTypes;

  const walk = (ex: string, via: string[]) => {
    if (visitedExchanges.has(ex)) return; // binding cycle
    visitedExchanges.add(ex);

    const declared = exchangeTypes[ex] ?? 'direct';
    const type = effectiveType(declared, exchangeArgs[ex]);
    if (type === null) {
      // Report the DECLARED type — that's what the operator sees in the UI and
      // in the management console, so it's what the message must name.
      unsupported.push({ exchange: ex, type: declared });
      return;
    }

    for (const b of bySource.get(ex) ?? []) {
      if (!bindingMatches(type, b.routingKey, routingKey)) continue;

      if (b.destinationType === 'queue') {
        // Same queue can be reached by several bindings — keep the first path.
        if (seenQueues.has(b.destination)) continue;
        seenQueues.add(b.destination);
        hits.push({ queue: b.destination, via, matchedRoutingKey: b.routingKey });
      } else {
        walk(b.destination, [...via, b.destination]);
      }
    }
  };

  walk(exchange, []);

  return { hits, unsupported, unknownExchange: !knownExchange };
}

/**
 * Publishing to the DEFAULT exchange ("") routes by exact queue name. It has no
 * binding rows, so resolveRoute() can't see it — this is the separate path.
 */
export function resolveDefaultExchange(queueNames: string[], routingKey: string): RouteResult {
  const hit = queueNames.includes(routingKey);
  return {
    hits: hit ? [{ queue: routingKey, via: [], matchedRoutingKey: routingKey }] : [],
    unsupported: [],
    unknownExchange: false,
  };
}
