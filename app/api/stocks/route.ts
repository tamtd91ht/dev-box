// /api/stocks — bảng giá cổ phiếu VN thu nhỏ (configs/stocks.json + proxy giá).
//
//   POST { action:'config' }            → { ok, result: StocksConfig }
//   POST { action:'save', config }      → { ok, result: StocksConfig } (đã normalize)
//   POST { action:'quotes' }            → { ok, result: { quotes[], missing[], at } }
//
// NGUỒN GIÁ: VPS bgapidatafeed (bảng giá công khai của CTCK VPS) — GET một
// phát trả mọi mã, không key, không đăng nhập. Server đứng giữa vì: (1) CORS,
// (2) đổi nguồn (SSI/TCBS/DNSE…) chỉ sửa MỘT hàm mapQuote, widget không biết gì.
//
// 'quotes' đọc danh sách mã TỪ CONFIG ĐÃ LƯU chứ không nhận từ client — một
// nguồn sự thật, không có chuyện widget và modal cấu hình poll hai list lệch nhau.

import { NextResponse, type NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import { configPath } from '@/lib/configDir';
import {
  DEFAULT_STOCKS_CONFIG,
  type StockQuote,
  type StockSymbolCfg,
  type StocksConfig,
} from '@/lib/stocks';

export const runtime = 'nodejs';

const CONFIG_FILE = configPath('stocks.json');

/** Nguồn giá. Mã nối bằng dấu phẩy, HOSE/HNX/UPCOM chung một đường. */
const QUOTE_URL = (symbols: string[]) =>
  `https://bgapidatafeed.vps.com.vn/getliststockdata/${symbols.join(',')}`;
const QUOTE_TIMEOUT_MS = 8_000;

// ── Config I/O ────────────────────────────────────────────────────────────────

const CORNERS = new Set(['bl', 'br', 'tl', 'tr', 'rt', 'rb']);
const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
/** Trần số mã theo dõi — nhiều hơn là bảng giá chứ không còn là widget góc. */
const MAX_SYMBOLS = 30;

/** Ngưỡng cảnh báo: số dương hữu hạn thì giữ, còn lại coi như không đặt. */
function posOrUndef(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Mọi thứ đọc từ đĩa/nhận từ client đều qua đây — file sửa tay hỏng thì về default. */
function normalizeConfig(raw: unknown): StocksConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const symbols: StockSymbolCfg[] = [];
  for (const item of Array.isArray(r.symbols) ? r.symbols : []) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const symbol = String(s.symbol ?? '').trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    const note = typeof s.note === 'string' ? s.note.trim().slice(0, 120) : '';
    symbols.push({
      symbol,
      ...(note ? { note } : {}),
      ...(posOrUndef(s.above) !== undefined ? { above: posOrUndef(s.above) } : {}),
      ...(posOrUndef(s.below) !== undefined ? { below: posOrUndef(s.below) } : {}),
    });
    if (symbols.length >= MAX_SYMBOLS) break;
  }
  const interval = Number(r.intervalSec);
  return {
    enabled: r.enabled === true, // mặc định TẮT — thiếu khoá cũng là tắt
    intervalSec: Number.isFinite(interval) ? Math.min(3600, Math.max(5, Math.round(interval))) : DEFAULT_STOCKS_CONFIG.intervalSec,
    position: CORNERS.has(String(r.position)) ? (String(r.position) as StocksConfig['position']) : DEFAULT_STOCKS_CONFIG.position,
    symbols,
  };
}

/**
 * STOCKS_ENABLED trong .env.local — cờ BẬT/TẮT RIÊNG MÁY NÀY, thắng config.
 * Vì sao cần: configs/stocks.json đi theo config-sync sang mọi máy, còn "máy
 * nào nhìn bảng giá" là chuyện từng máy (cùng lý do *_TOOL_ENABLED nằm ở env).
 */
function envLock(): 'on' | 'off' | null {
  const v = String(process.env.STOCKS_ENABLED ?? '').trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'on') return 'on';
  if (v === 'false' || v === '0' || v === 'off') return 'off';
  return null;
}

async function readConfig(): Promise<StocksConfig> {
  try {
    // Gột BOM: file sửa tay bằng PowerShell (Set-Content -Encoding utf8 trên
    // PS 5.1) mang BOM và JSON.parse chết — âm thầm mất sạch mã đã cấu hình.
    let raw = await fs.readFile(CONFIG_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STOCKS_CONFIG, symbols: [] };
  }
}

async function writeConfig(cfg: StocksConfig): Promise<void> {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── Quotes ────────────────────────────────────────────────────────────────────

/** Số từ nguồn: khi thì number, khi thì string ("71.62"), khi thì rỗng. */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Một dòng VPS → StockQuote. Field nguồn: sym, r (TC), c (trần), f (sàn),
 * lastPrice/lastVolume, lot (tổng KL, ĐẾM THEO LÔ 10 — bảng giá VPS cũng nhân
 * 10 khi hiển thị), highPrice/lowPrice/openPrice, changePc (string KHÔNG dấu →
 * tự tính từ last-ref cho chắc dấu).
 */
function mapQuote(row: Record<string, unknown>): StockQuote | null {
  const symbol = String(row.sym ?? '').trim().toUpperCase();
  if (!symbol) return null;
  const ref = num(row.r);
  // Chưa có lệnh khớp (đầu phiên, mã ít thanh khoản): lastPrice = 0 → dùng TC
  // để widget vẫn có giá đứng vàng thay vì "0.00 -100%".
  const last = num(row.lastPrice) || ref;
  return {
    symbol,
    last,
    ref,
    ceil: num(row.c),
    floor: num(row.f),
    high: num(row.highPrice),
    low: num(row.lowPrice),
    open: num(row.openPrice),
    changePc: ref > 0 ? Math.round(((last - ref) / ref) * 10000) / 100 : 0,
    volume: num(row.lot) * 10,
  };
}

async function fetchQuotes(symbols: string[]): Promise<{ quotes: StockQuote[]; missing: string[] }> {
  if (symbols.length === 0) return { quotes: [], missing: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
  try {
    const res = await fetch(QUOTE_URL(symbols), {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`nguồn giá trả HTTP ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error('nguồn giá trả dữ liệu không phải mảng');
    const quotes = rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map(mapQuote)
      .filter((q): q is StockQuote => q !== null);
    const got = new Set(quotes.map((q) => q.symbol));
    return { quotes, missing: symbols.filter((s) => !got.has(s)) };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`nguồn giá không phản hồi sau ${QUOTE_TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? '');
  try {
    switch (action) {
      case 'config':
        return NextResponse.json({ ok: true, result: { ...(await readConfig()), envLock: envLock() } });
      case 'save': {
        // normalizeConfig dựng object mới từ khoá được biết → envLock client
        // gửi kèm (nếu có) không bao giờ lọt vào file.
        const cfg = normalizeConfig(body?.config);
        await writeConfig(cfg);
        return NextResponse.json({ ok: true, result: { ...cfg, envLock: envLock() } });
      }
      case 'quotes': {
        const cfg = await readConfig();
        const { quotes, missing } = await fetchQuotes(cfg.symbols.map((s) => s.symbol));
        return NextResponse.json({ ok: true, result: { quotes, missing, at: Date.now() } });
      }
      default:
        return NextResponse.json({ ok: false, error: `action không hỗ trợ: "${action}"` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
