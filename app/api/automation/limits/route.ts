// /api/automation/limits — bản LÂU BỀN của lịch sử bắn (cooldown / maxPerHour /
// dedupe) cho MỌI cửa sổ.
//
//   GET          → snapshot hiện tại (đã prune)
//   PUT snapshot → merge với bản trên đĩa, prune, ghi, trả về bản merge
//
// Vì sao tồn tại: EngineState sống trong RAM renderer — F5, mở lại app, HMR khi
// dev, hay cửa sổ thứ hai là "nghỉ 5 phút giữa 2 lần bắn" mất trắng lịch sử và
// cảnh báo bắn lại ngay poll kế tiếp. Server là điểm chung duy nhất của mọi cửa
// sổ (Electron lẫn browser dev cùng trỏ một Next server), nên lịch sử nằm ở đây.
//
// Merge theo luật "mốc mới nhất thắng" (fires: gộp rồi cắt giờ trượt) — hai cửa
// sổ đẩy chéo nhau không bao giờ làm NGẮN một cooldown đang chạy.

import { NextResponse, type NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import type { EngineStateSnapshot } from '@/lib/automation/engine';

export const runtime = 'nodejs';

const FILE = path.join(process.cwd(), '.automation-limits.json');

const HOUR_MS = 3600e3;
/** cooldownSec dài nhất còn có nghĩa — quá mốc này thì giữ lịch sử chỉ tốn chỗ. */
const LAST_FIRE_TTL_MS = 7 * 24 * HOUR_MS;
const SEEN_TTL_MS = 10 * 60e3;

const EMPTY: EngineStateSnapshot = { lastFire: {}, fires: {}, content: {}, seen: {} };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Ép một object lạ (đĩa hand-edit, body POST) về đúng shape — key hỏng thì bỏ. */
function sanitize(raw: unknown): EngineStateSnapshot {
  if (!raw || typeof raw !== 'object') return { ...EMPTY, lastFire: {}, fires: {}, content: {}, seen: {} };
  const r = raw as Record<string, unknown>;
  const mapOf = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === 'object') {
      for (const [k, ts] of Object.entries(v as Record<string, unknown>)) {
        const n = num(ts);
        if (n !== null) out[k] = n;
      }
    }
    return out;
  };
  const fires: Record<string, number[]> = {};
  if (r.fires && typeof r.fires === 'object') {
    for (const [k, list] of Object.entries(r.fires as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const ns = list.map(num).filter((n): n is number => n !== null);
      if (ns.length) fires[k] = ns;
    }
  }
  return { lastFire: mapOf(r.lastFire), fires, content: mapOf(r.content), seen: mapOf(r.seen) };
}

function merge(a: EngineStateSnapshot, b: EngineStateSnapshot): EngineStateSnapshot {
  const lastFire = { ...a.lastFire };
  for (const [k, ts] of Object.entries(b.lastFire)) if (ts > (lastFire[k] ?? 0)) lastFire[k] = ts;
  const content = { ...a.content };
  for (const [k, ts] of Object.entries(b.content)) if (ts > (content[k] ?? 0)) content[k] = ts;
  const seen = { ...a.seen };
  for (const [k, ts] of Object.entries(b.seen)) if (ts > (seen[k] ?? 0)) seen[k] = ts;
  const fires: Record<string, number[]> = { ...a.fires };
  for (const [k, list] of Object.entries(b.fires)) {
    fires[k] = [...new Set([...(fires[k] ?? []), ...list])].sort((x, y) => x - y);
  }
  return { lastFire, fires, content, seen };
}

function prune(s: EngineStateSnapshot, now: number): EngineStateSnapshot {
  const out: EngineStateSnapshot = { lastFire: {}, fires: {}, content: {}, seen: {} };
  for (const [k, ts] of Object.entries(s.lastFire)) if (now - ts < LAST_FIRE_TTL_MS) out.lastFire[k] = ts;
  for (const [k, list] of Object.entries(s.fires)) {
    const kept = list.filter((t) => now - t < HOUR_MS);
    if (kept.length) out.fires[k] = kept;
  }
  for (const [k, ts] of Object.entries(s.content)) if (now - ts < HOUR_MS) out.content[k] = ts;
  for (const [k, ts] of Object.entries(s.seen)) if (now - ts < SEEN_TTL_MS) out.seen[k] = ts;
  return out;
}

async function read(): Promise<EngineStateSnapshot> {
  try {
    return sanitize(JSON.parse(await fs.readFile(FILE, 'utf8')));
  } catch {
    return { lastFire: {}, fires: {}, content: {}, seen: {} };
  }
}

// Ghi tuần tự: hai cửa sổ PUT cùng lúc thì lần sau xếp hàng sau lần trước,
// không bao giờ hai fs.writeFile chồng lên nhau nửa chừng.
const g = globalThis as unknown as { __autoLimitsQueue?: Promise<unknown> };
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = (g.__autoLimitsQueue ?? Promise.resolve()).then(job, job);
  g.__autoLimitsQueue = next.catch(() => {});
  return next;
}

export async function GET() {
  const now = Date.now();
  return NextResponse.json(prune(await read(), now));
}

export async function PUT(req: NextRequest) {
  const body = sanitize(await req.json().catch(() => null));
  try {
    const merged = await enqueue(async () => {
      const now = Date.now();
      const next = prune(merge(await read(), body), now);
      await fs.writeFile(FILE, JSON.stringify(next) + '\n', 'utf8');
      return next;
    });
    return NextResponse.json(merged);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
