// Phần THUẦN của màn "⚡ Chạy lệnh" Redis: tách dòng lệnh thành argv, đối chiếu
// danh sách lệnh cho phép, biết lệnh nào đụng key nào, và các luật TTL.
// Không import ioredis — dùng chung được cho server (lib/redisClient) và cho
// scripts/check-redis-command.ts.
//
// DANH SÁCH CHO PHÉP chứ không phải danh sách cấm: chỉ lệnh dữ liệu trên từng
// key. Mọi lệnh quản trị / chặn instance / chạy script (FLUSHALL, FLUSHDB,
// CONFIG, KEYS, DEBUG, SHUTDOWN, EVAL, SCRIPT, MODULE, CLIENT, MONITOR,
// SUBSCRIBE, MIGRATE, RESTORE, SWAPDB, …) đều không có trong bảng nên bị từ chối.
// PERSIST và GETEX PERSIST bị chặn riêng (redis-ttl-mandatory: không tạo key vĩnh viễn).

/** Trần TTL — 30 ngày, giống MAX_TTL_SECONDS ở lib/redisClient. */
export const CMD_MAX_TTL_SECONDS = 2_592_000;
/** Số dòng lệnh tối đa một lượt chạy. */
export const CMD_MAX_LINES = 50;

type KeyFn = (args: string[]) => string[];
const first: KeyFn = (a) => (a.length ? [a[0]] : []);
const firstTwo: KeyFn = (a) => a.slice(0, 2);
const all: KeyFn = (a) => a;
const evenIdx: KeyFn = (a) => a.filter((_, i) => i % 2 === 0);

interface Spec { write: boolean; keys: KeyFn; minArgs: number }

const W = (minArgs: number, keys: KeyFn = first): Spec => ({ write: true, keys, minArgs });
const R = (minArgs: number, keys: KeyFn = first): Spec => ({ write: false, keys, minArgs });

const SPECS: Record<string, Spec> = {
  // string
  SET: W(2), SETNX: W(2), SETEX: W(3), PSETEX: W(3), GETSET: W(2), GETDEL: W(1), GETEX: W(1),
  APPEND: W(2), SETRANGE: W(3), INCR: W(1), INCRBY: W(2), INCRBYFLOAT: W(2), DECR: W(1), DECRBY: W(2),
  MSET: W(2, evenIdx), MSETNX: W(2, evenIdx),
  GET: R(1), MGET: R(1, all), STRLEN: R(1), GETRANGE: R(3),
  // key
  DEL: W(1, all), UNLINK: W(1, all), EXPIRE: W(2), PEXPIRE: W(2), EXPIREAT: W(2), PEXPIREAT: W(2),
  RENAME: W(2, firstTwo), RENAMENX: W(2, firstTwo), COPY: W(2, firstTwo),
  EXISTS: R(1, all), TYPE: R(1), TTL: R(1), PTTL: R(1),
  // hash
  HSET: W(3), HSETNX: W(3), HMSET: W(3), HDEL: W(2), HINCRBY: W(3), HINCRBYFLOAT: W(3),
  HGET: R(2), HMGET: R(2), HGETALL: R(1), HLEN: R(1), HEXISTS: R(2), HKEYS: R(1), HVALS: R(1),
  // list
  LPUSH: W(2), RPUSH: W(2), LPUSHX: W(2), RPUSHX: W(2), LPOP: W(1), RPOP: W(1), LSET: W(3),
  LREM: W(3), LTRIM: W(3), LINSERT: W(4), LMOVE: W(4, firstTwo),
  LRANGE: R(3), LLEN: R(1), LINDEX: R(2),
  // set
  SADD: W(2), SREM: W(2), SPOP: W(1), SMOVE: W(3, firstTwo),
  SMEMBERS: R(1), SCARD: R(1), SISMEMBER: R(2), SMISMEMBER: R(2), SRANDMEMBER: R(1),
  // zset
  ZADD: W(3), ZREM: W(2), ZINCRBY: W(3), ZPOPMIN: W(1), ZPOPMAX: W(1),
  ZREMRANGEBYSCORE: W(3), ZREMRANGEBYRANK: W(3), ZREMRANGEBYLEX: W(3),
  ZRANGE: R(3), ZRANGEBYSCORE: R(3), ZREVRANGE: R(3), ZSCORE: R(2), ZCARD: R(1),
  ZRANK: R(2), ZREVRANK: R(2), ZCOUNT: R(3),
  // stream / hyperloglog
  XADD: W(3), XDEL: W(2), XTRIM: W(3), XLEN: R(1), XRANGE: R(3), XREVRANGE: R(3),
  PFADD: W(1), PFCOUNT: R(1, all),
};

/** Lệnh có thể TẠO key mới — tạo mà không kèm TTL thì cảnh báo ở bước chạy thử. */
export const CREATES_KEY = new Set([
  'SET', 'SETNX', 'GETSET', 'APPEND', 'SETRANGE', 'INCR', 'INCRBY', 'INCRBYFLOAT', 'DECR', 'DECRBY',
  'MSET', 'MSETNX', 'HSET', 'HSETNX', 'HMSET', 'HINCRBY', 'HINCRBYFLOAT', 'LPUSH', 'RPUSH', 'LMOVE',
  'SADD', 'SMOVE', 'ZADD', 'ZINCRBY', 'XADD', 'PFADD', 'COPY',
]);

/** Lệnh đặt TTL cho key đầu tiên của nó. */
export const SETS_TTL = new Set(['EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'SETEX', 'PSETEX']);

const BLOCK_REASON: Record<string, string> = {
  PERSIST: 'PERSIST bỏ TTL → key vĩnh viễn (redis-ttl-mandatory) — không cho phép',
  KEYS: 'KEYS chặn cả instance — dùng ô tìm (SCAN) ở tab Dữ liệu',
  SCAN: 'SCAN — dùng ô tìm ở tab Dữ liệu',
  FLUSHDB: 'FLUSHDB xoá sạch DB — không cho phép',
  FLUSHALL: 'FLUSHALL xoá sạch instance — không cho phép',
};

export interface ParsedCommand {
  /** Dòng gốc (1-based) trong ô nhập. */
  line: number;
  /** Tên lệnh viết HOA. */
  name: string;
  args: string[];
  write: boolean;
  keys: string[];
  /** Có kèm TTL ngay trong lệnh (SET … EX, SETEX, GETEX EX…). */
  inlineTtl: boolean;
  /** SET … KEEPTTL. */
  keepTtl: boolean;
}

/**
 * Tách MỘT dòng thành argv kiểu redis-cli: cách nhau bằng khoảng trắng,
 * "…" hiểu \" \\ \n \t, '…' giữ nguyên văn (chỉ hiểu \').
 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let cur = '';
    let started = false;
    while (i < line.length && !/\s/.test(line[i])) {
      const ch = line[i];
      if (ch === '"' || ch === "'") {
        started = true;
        const q = ch;
        i++;
        let closed = false;
        while (i < line.length) {
          const c = line[i];
          if (c === '\\' && i + 1 < line.length) {
            const n = line[i + 1];
            if (q === '"') {
              cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
              i += 2;
              continue;
            }
            if (n === "'") { cur += "'"; i += 2; continue; }
          }
          if (c === q) { closed = true; i++; break; }
          cur += c;
          i++;
        }
        if (!closed) throw new Error(`thiếu dấu ${q} đóng`);
        continue;
      }
      cur += ch;
      started = true;
      i++;
    }
    if (started) out.push(cur);
  }
  return out;
}

function ttlCheck(value: string, unit: 's' | 'ms', label: string): void {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label}: TTL phải là số nguyên ≥ 1`);
  const sec = unit === 'ms' ? n / 1000 : n;
  if (sec > CMD_MAX_TTL_SECONDS) throw new Error(`${label}: TTL tối đa 30 ngày (${CMD_MAX_TTL_SECONDS}s)`);
}

function atCheck(value: string, unit: 's' | 'ms', label: string, nowMs: number): void {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label}: mốc thời gian không hợp lệ`);
  const sec = (unit === 'ms' ? n - nowMs : n * 1000 - nowMs) / 1000;
  if (sec > CMD_MAX_TTL_SECONDS) throw new Error(`${label}: hết hạn quá 30 ngày nữa — không cho phép`);
}

/** Soát luật TTL trong các tuỳ chọn EX/PX/EXAT/PXAT/PERSIST (SET, GETEX). */
function optionTtl(name: string, opts: string[], nowMs: number): { inline: boolean; keep: boolean } {
  let inline = false;
  let keep = false;
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i].toUpperCase();
    const v = opts[i + 1];
    if (o === 'EX' || o === 'PX') {
      if (v === undefined) throw new Error(`${name}: ${o} thiếu giá trị`);
      ttlCheck(v, o === 'PX' ? 'ms' : 's', `${name} ${o}`); inline = true; i++;
    } else if (o === 'EXAT' || o === 'PXAT') {
      if (v === undefined) throw new Error(`${name}: ${o} thiếu giá trị`);
      atCheck(v, o === 'PXAT' ? 'ms' : 's', `${name} ${o}`, nowMs); inline = true; i++;
    } else if (o === 'PERSIST') {
      throw new Error(`${name} PERSIST bỏ TTL → key vĩnh viễn (redis-ttl-mandatory) — không cho phép`);
    } else if (o === 'KEEPTTL') {
      keep = true;
    }
  }
  return { inline, keep };
}

/** Phân tích + soát MỘT dòng lệnh. Ném lỗi (tiếng Việt) khi bị từ chối. */
export function parseCommand(text: string, line: number, nowMs = Date.now()): ParsedCommand {
  const argv = splitArgs(text);
  if (argv.length === 0) throw new Error('dòng trống');
  const name = argv[0].toUpperCase();
  const args = argv.slice(1);
  if (BLOCK_REASON[name]) throw new Error(BLOCK_REASON[name]);
  const spec = SPECS[name];
  if (!spec) throw new Error(`lệnh "${name}" không có trong danh sách cho phép (chỉ lệnh dữ liệu trên từng key)`);
  if (args.length < spec.minArgs) throw new Error(`${name} cần ít nhất ${spec.minArgs} tham số`);
  if ((name === 'MSET' || name === 'MSETNX') && args.length % 2 !== 0) throw new Error(`${name} cần cặp key value`);

  let inlineTtl = false;
  let keepTtl = false;
  switch (name) {
    case 'EXPIRE': ttlCheck(args[1], 's', name); break;
    case 'PEXPIRE': ttlCheck(args[1], 'ms', name); break;
    case 'EXPIREAT': atCheck(args[1], 's', name, nowMs); break;
    case 'PEXPIREAT': atCheck(args[1], 'ms', name, nowMs); break;
    case 'SETEX': ttlCheck(args[1], 's', name); inlineTtl = true; break;
    case 'PSETEX': ttlCheck(args[1], 'ms', name); inlineTtl = true; break;
    case 'SET': ({ inline: inlineTtl, keep: keepTtl } = optionTtl(name, args.slice(2), nowMs)); break;
    case 'GETEX': ({ inline: inlineTtl } = optionTtl(name, args.slice(1), nowMs)); break;
  }

  const keys = spec.keys(args).filter(Boolean);
  if (keys.length === 0) throw new Error(`${name} thiếu key`);
  return { line, name, args, write: spec.write, keys, inlineTtl, keepTtl };
}

/** Phân tích cả ô nhập: mỗi dòng một lệnh, bỏ dòng trống và dòng bắt đầu bằng #. */
export function parseScript(text: string, nowMs = Date.now()): ParsedCommand[] {
  const out: ParsedCommand[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith('#')) return;
    try {
      out.push(parseCommand(t, i + 1, nowMs));
    } catch (e) {
      throw new Error(`Dòng ${i + 1}: ${(e as Error).message}`);
    }
  });
  if (out.length === 0) throw new Error('chưa có lệnh nào');
  if (out.length > CMD_MAX_LINES) throw new Error(`tối đa ${CMD_MAX_LINES} lệnh một lượt`);
  return out;
}
