// /api/presets — "nút tìm nhanh" của Redis/Kafka/Mongo/ES/PG, lưu ở
// configs/presets.json nên đẩy lên git được cùng các config khác.
//
//   GET  ?kind=redis.quickfinds        → unknown[]  (một nhóm)
//   GET                                → { [kind]: unknown[] }  (tất cả)
//   PUT  { kind, list }                → unknown[]  ghi đè cả nhóm
//   POST { kind, list, seed: true }    → { seeded, list }  nhận dữ liệu
//        localStorage cũ, CHỈ ghi khi nhóm trên server còn trống

import { NextResponse, type NextRequest } from 'next/server';
import { listPresets, listAllPresets, savePresets, seedPresets, isPresetKind } from '@/lib/presetStore';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind');
  if (kind === null) return NextResponse.json({ ok: true, result: await listAllPresets() });
  if (!isPresetKind(kind)) return NextResponse.json({ ok: false, error: `Unknown kind: ${kind}` }, { status: 400 });
  return NextResponse.json({ ok: true, result: await listPresets(kind) });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null) as { kind?: unknown; list?: unknown } | null;
  if (!isPresetKind(body?.kind)) return NextResponse.json({ ok: false, error: 'kind required' }, { status: 400 });
  if (!Array.isArray(body?.list)) return NextResponse.json({ ok: false, error: 'list must be an array' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, result: await savePresets(body.kind, body.list) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { kind?: unknown; list?: unknown } | null;
  if (!isPresetKind(body?.kind)) return NextResponse.json({ ok: false, error: 'kind required' }, { status: 400 });
  if (!Array.isArray(body?.list)) return NextResponse.json({ ok: false, error: 'list must be an array' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, result: await seedPresets(body.kind, body.list) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
