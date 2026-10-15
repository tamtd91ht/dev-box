// /api/minio — single dispatch route for all MinIO / S3 operations.
//
//   POST { action, ... }  where action is one of:
//     'test'        { host, port, tls, accessKey, secretKey?, connectionId? } → { ok, result: MinioTestResult }
//     'ping'        { connectionId }                          → { ok, result: { latencyMs } }
//     'info'        { connectionId }                          → { ok, result: MinioTestResult }
//     'probe'       { connectionId }                          → { ok, result: { metrics } }   (Monitor/Automation)
//     'consoleLogin' { connectionId }                         → { ok, result: { url, cookies[] } }  (phiên Console, KHÔNG có secret)
//     'metrics'     { connectionId }                          → { ok, result: MinioMetrics }
//     'hostMetrics' { connectionId }                          → { ok, result: HostMetrics[] }
//     'buckets'     { connectionId }                          → { ok, result: MinioBucketInfo[] }
//     'objects'     { connectionId, bucket, prefix?, startAfter? } → { ok, result: MinioListing }
//     'stat'        { connectionId, bucket, object }          → { ok, result: MinioObjectStat }
//     'bucketStats' { connectionId, bucket, prefix? }         → { ok, result: { objects, sizeBytes, truncated } }
//     'presign'     { connectionId, bucket, object, expirySec? } → { ok, result: { url } }
//     -- gated writes (MINIO_ALLOW_WRITE + connection readOnly=false) --
//     'makeBucket'   { connectionId, bucket }
//     'removeBucket' { connectionId, bucket }               (bucket phải rỗng)
//     'removeObject' { connectionId, bucket, object }
//     'removePrefix' { connectionId, bucket, prefix }       (prefix kết thúc bằng "/")
//
// Tải file xuống / xem trước: GET /api/minio/download. Tải lên: POST /api/minio/upload.
// Gated by MINIO_TOOL_ENABLED (403 when off).

import { NextResponse, type NextRequest } from 'next/server';
import {
  MINIO_ENABLED,
  testConnection,
  ping,
  probe,
  metrics,
  hostMetrics,
  consoleLogin,
  listBuckets,
  listObjects,
  statObject,
  bucketStats,
  presignedUrl,
  makeBucket,
  removeBucket,
  removeObject,
  removePrefix,
} from '@/lib/minioClient';
import { getConnection, buildUnsavedConnection } from '@/lib/minioConnections';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!MINIO_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'MinIO tool is disabled. Set MINIO_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  if (action === 'test') {
    try {
      const conn = await buildUnsavedConnection(body ?? {}, typeof body?.connectionId === 'string' ? body.connectionId : undefined);
      return NextResponse.json({ ok: true, result: await testConnection(conn) });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: (err as Error).message || 'Connection test failed', detail: String(err) },
        { status: 502 },
      );
    }
  }

  const connectionId = body?.connectionId as string | undefined;
  if (!connectionId) return NextResponse.json({ ok: false, error: 'Missing connectionId' }, { status: 400 });
  const conn = await getConnection(connectionId);
  if (!conn) return NextResponse.json({ ok: false, error: `Unknown connection: ${connectionId}` }, { status: 404 });

  try {
    let result: unknown;
    switch (action) {
      case 'ping':
        result = await ping(conn);
        break;
      case 'info':
        result = await testConnection(conn);
        break;
      case 'probe':
        result = { metrics: await probe(conn) };
        break;
      case 'consoleLogin': // đăng nhập Console hộ → cookie phiên để nạp vào khung Console
        result = await consoleLogin(conn);
        break;
      case 'metrics': // Prometheus: dung lượng, node/ổ, dung lượng theo bucket
        result = await metrics(conn);
        break;
      case 'hostMetrics': // node_exporter RAM/đĩa/CPU/load (tuỳ chọn, theo connection)
        result = await hostMetrics(conn);
        break;
      case 'buckets':
        result = await listBuckets(conn);
        break;
      case 'objects':
        result = await listObjects(conn, body.bucket, body.prefix ?? '', body.startAfter);
        break;
      case 'stat':
        result = await statObject(conn, body.bucket, body.object);
        break;
      case 'bucketStats':
        result = await bucketStats(conn, body.bucket, body.prefix ?? '');
        break;
      case 'presign':
        result = { url: await presignedUrl(conn, body.bucket, body.object, Number(body.expirySec) || 3600) };
        break;
      case 'makeBucket':
        await makeBucket(conn, body.bucket);
        result = { created: true };
        break;
      case 'removeBucket':
        await removeBucket(conn, body.bucket);
        result = { removed: true };
        break;
      case 'removeObject':
        await removeObject(conn, body.bucket, body.object);
        result = { removed: true };
        break;
      case 'removePrefix':
        result = { removed: await removePrefix(conn, body.bucket, body.prefix) };
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const e = err as Error & { code?: string };
    return NextResponse.json(
      { ok: false, error: e.message || 'MinIO operation failed', code: e.code },
      { status: 502 },
    );
  }
}
