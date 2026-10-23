// /api/redis — single dispatch route for all Redis operations.
//
//   POST { action, ... }  where action is one of:
//     'test'   { mode?, host?, port?, nodes?, password? } → { ok, result: { latencyMs } }  (no saved connection)
//     'ping'   { connectionId, db? }             → { ok, result: { latencyMs } }
//     'scan'   { connectionId, db?, match, cursor, count } → { ok, result: { cursor, keys[] } }
//     'lookup' { connectionId, db?, key }         → { ok, result: { cursor:'0', keys[0..1] } }
//     'value'  { connectionId, db?, key }         → { ok, result: { key, type, ttl, value, ... } }
//     'setTtl' { connectionId, db?, key, seconds }→ { ok, result: { applied } }
//     'set'    { connectionId, db?, key, type, value, ttl?, overwrite? } → { ok, result: { created, type } }
//     'del'    { connectionId, db?, key }         → { ok, result: { deleted, lockKeyWarning } }
//     'cmd'    { connectionId, db?, script, commit } → { ok, result: CmdRunResult }
//              màn "⚡ Chạy lệnh": danh sách lệnh cho phép, cổng REDIS_ALLOW_WRITE + readOnly;
//              commit=false chỉ soát lệnh + đọc trạng thái key (lib/redisClient runCommands)
//     'diagnoseMisses' { connectionId, seconds }   → { ok, result: RedisMissDiagnosis }
//              bật TẠM notify-keyspace-events "Em" trong `seconds` giây rồi trả lại (lib/redisDiagnose)
//     'diagnoseFrag'   { connectionId }            → { ok, result: RedisFragDiagnosis }
//              chỉ đọc INFO + CONFIG GET, mỗi node có timeout (lib/redisFragDiagnose)
//     'diagnoseMem'    { connectionId, sample?, history? } → { ok, result: RedisMemDiagnosis }
//              chỉ đọc; sample=true thêm SCAN + MEMORY USAGE có giới hạn (lib/redisMemDiagnose)
//     'listNoTtl'      { connectionId, limit? } → { ok, result: NoTtlKeyList }
//              chỉ đọc; SCAN + TTL có giới hạn đến khi đủ `limit` key không TTL (tối đa 10.000)
//     'keymissScan'    {}                          → { ok, result: KeymissState[] }  mọi kết nối đã lưu
//     'keymissCheck'   { connectionId }            → { ok, result: KeymissState }
//     'keymissRelease' { connectionId, addr? }     → { ok, result: ReleaseResult[] }
//              cờ key-miss mà phân tích hit rate bật tạm: kiểm tra / tắt khi người dùng bấm (lib/redisKeymissGuard)
//     'diagnoseClients' { connectionId, list? }    → { ok, result: RedisClientsDiagnosis }
//              chỉ đọc; list=true thêm CLIENT LIST khi ít client + CPU còn dư (lib/redisClientsDiagnose)
//
// `db` is the logical DB index (0–15) chosen at browse time; it defaults to 0 and is
// forced to 0 for cluster connections (Redis Cluster only has DB 0). 'test' probes a
// not-yet-saved connection straight from the form (single or cluster).
//
// Gated by REDIS_TOOL_ENABLED (403 when off). The browser never talks to Redis
// directly — this server-side handler owns the ioredis socket. Any Redis / network
// error is caught and returned as { ok:false, error, detail } so the UI can render
// it instead of the request hanging.

import { NextResponse, type NextRequest } from 'next/server';
import { REDIS_ENABLED, normalizeDb, ping, scan, lookupKey, getValue, setTtl, setValue, del, testConnection, infoStats, runCommands } from '@/lib/redisClient';
import { getConnection } from '@/lib/redisConnections';
import { diagnoseMisses } from '@/lib/redisDiagnose';
import { diagnoseFragmentation } from '@/lib/redisFragDiagnose';
import { diagnoseMemory, listNoTtlKeys } from '@/lib/redisMemDiagnose';
import { diagnoseClients } from '@/lib/redisClientsDiagnose';
import { checkKeymiss, releaseKeymiss, scanKeymiss } from '@/lib/redisKeymissGuard';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!REDIS_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Redis tool is disabled. Set REDIS_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;

  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  // 'test' probes an unsaved connection — raw form fields, no connectionId. Supports
  // both single (host/port) and cluster (mode:'cluster' + nodes[]).
  if (action === 'test') {
    try {
      const result = await testConnection({
        mode: body.mode === 'cluster' ? 'cluster' : 'single',
        host: body.host != null ? String(body.host) : undefined,
        port: body.port != null ? Number(body.port) : undefined,
        nodes: Array.isArray(body.nodes) ? body.nodes : undefined,
        password: body.password ? String(body.password) : undefined,
      });
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: (err as Error).message || 'Connection test failed', detail: String(err) },
        { status: 502 },
      );
    }
  }

  // Quét cờ key-miss trên MỌI kết nối đã lưu (KeymissFlagHost, 10 phút/lần) — không cần connectionId.
  if (action === 'keymissScan') {
    try {
      return NextResponse.json({ ok: true, result: await scanKeymiss() });
    } catch (err) {
      return NextResponse.json({ ok: false, error: (err as Error).message || 'Scan failed' }, { status: 502 });
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

  const db = normalizeDb(body.db);

  try {
    let result: unknown;
    switch (action) {
      case 'ping':
        result = await ping(conn, db);
        break;
      case 'stats': // INFO snapshot per node (monitor strip)
        result = await infoStats(conn);
        break;
      case 'scan':
        result = await scan(conn, db, String(body.match ?? '*'), String(body.cursor ?? '0'), Number(body.count ?? 100));
        break;
      // Tra ĐÚNG một key theo tên (ô "Đúng key") — TYPE+TTL O(1), không quét.
      case 'lookup':
        result = await lookupKey(conn, db, String(body.key ?? ''));
        break;
      case 'value':
        result = await getValue(conn, db, String(body.key ?? ''));
        break;
      case 'setTtl':
        result = await setTtl(conn, db, String(body.key ?? ''), Number(body.seconds));
        break;
      case 'set':
        result = await setValue(conn, db, {
          key: String(body.key ?? ''),
          type: body.type,
          value: body.value,
          ttl: body.ttl != null ? Number(body.ttl) : undefined,
          overwrite: body.overwrite === true,
        });
        break;
      case 'del':
        result = await del(conn, db, String(body.key ?? ''));
        break;
      case 'cmd': {
        try {
          result = await runCommands(conn, db, body.script, body.commit === true);
        } catch (err) {
          const msg = (err as Error).message || 'command refused';
          const gate = msg.includes('disabled for the whole tool') || msg.includes('is read-only');
          return NextResponse.json({ ok: false, error: msg }, { status: gate ? 403 : 400 });
        }
        break;
      }
      case 'diagnoseMisses': // dạng key nào đang miss (Monitor → Phân tích hit rate)
        result = await diagnoseMisses(conn, Number(body.seconds ?? 10));
        break;
      case 'diagnoseFrag': // phân mảnh bộ nhớ nằm ở đâu (Monitor → Phân tích phân mảnh), chỉ đọc
        result = await diagnoseFragmentation(conn);
        break;
      case 'keymissCheck': // cờ key-miss còn bật không, ai đang nghe (chỉ đọc)
        result = await checkKeymiss(conn);
        break;
      case 'keymissRelease': // tắt cờ key-miss — chỉ khi người dùng bấm
        result = await releaseKeymiss(conn, body.addr ? String(body.addr) : undefined);
        break;
      case 'diagnoseClients': // kết nối đến từ đâu, gần maxclients chưa (Monitor → Phân tích client), chỉ đọc
        result = await diagnoseClients(conn, { list: body.list === true });
        break;
      case 'diagnoseMem': // RAM nằm ở đâu, đầy thì sao, dạng key nào chiếm (Monitor → Phân tích RAM), chỉ đọc
        result = await diagnoseMemory(conn, {
          sample: body.sample === true,
          history: Array.isArray(body.history)
            ? body.history.map((h: { at: unknown; mb: unknown }) => ({ at: Number(h.at), mb: Number(h.mb) })).filter((h: { at: number; mb: number }) => Number.isFinite(h.at) && Number.isFinite(h.mb)).slice(-200)
            : [],
        });
        break;
      case 'listNoTtl': // danh sách key không TTL (Monitor → Phân tích RAM), chỉ đọc
        result = await listNoTtlKeys(conn, Number(body.limit ?? 500));
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || 'Redis operation failed', detail: String(err) },
      { status: 502 },
    );
  }
}
