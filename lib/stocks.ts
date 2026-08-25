// Bảng giá cổ phiếu VN thu nhỏ — types + client helpers (browser-safe).
//
// Widget nổi ở một góc app (components/StockTickerHost.tsx) hiển thị giá
// realtime các mã ĐƯỢC CẤU HÌNH, poll qua /api/stocks mỗi n giây. Server đứng
// giữa gọi nguồn giá (VPS bgapidatafeed — public, không cần key) để renderer
// không dính CORS và nguồn giá đổi thì chỉ sửa một chỗ.
//
// MẶC ĐỊNH TẮT (enabled: false) — bật trong modal cấu hình (nút 📈 trên header).
// Cấu hình sống ở configs/stocks.json (server-owned, cùng nhà với các
// *connections.json) chứ không phải localStorage: bảng mã + ngưỡng cảnh báo là
// thứ muốn giữ qua dọn cache và sync được giữa máy.

export type StockCorner = 'bl' | 'br' | 'tl' | 'tr';

export interface StockSymbolCfg {
  /** Mã CK, vd "FPT", "HPG" — HOSE/HNX/UPCOM đều qua cùng nguồn. */
  symbol: string;
  /** Ghi chú riêng ("chốt lời T+", "canh mua vùng 20"). */
  note?: string;
  /** Ngưỡng CẢNH BÁO TRÊN: giá khớp ≥ mức này thì pill nháy ⚠ (đơn vị nghìn đồng, như bảng giá). */
  above?: number;
  /** Ngưỡng CẢNH BÁO DƯỚI: giá khớp ≤ mức này thì pill nháy ⚠. */
  below?: number;
}

export interface StocksConfig {
  /** Mặc định FALSE — widget chỉ hiện khi chủ động bật. */
  enabled: boolean;
  /** Chu kỳ poll giá, giây (server kẹp 5–3600). Ngoài giờ giao dịch tự giãn ≥5 phút. */
  intervalSec: number;
  /** Góc màn hình neo widget. */
  position: StockCorner;
  symbols: StockSymbolCfg[];
  /**
   * CHỈ ĐỌC — server đính kèm khi trả config, KHÔNG lưu vào file:
   * STOCKS_ENABLED trong .env.local đang ép bật ('on') / tắt ('off') RIÊNG MÁY
   * NÀY. configs/stocks.json được config-sync mang đi mọi máy, nên cờ bật/tắt
   * per-device phải sống ở env như mọi *_TOOL_ENABLED khác; không đặt biến thì
   * theo `enabled` trong config như thường.
   */
  envLock?: 'on' | 'off' | null;
}

/** Widget có hiện trên MÁY NÀY không — env thắng, config chỉ quyết khi env im. */
export function effectiveEnabled(cfg: StocksConfig): boolean {
  if (cfg.envLock === 'on') return true;
  if (cfg.envLock === 'off') return false;
  return cfg.enabled;
}

export const DEFAULT_STOCKS_CONFIG: StocksConfig = {
  enabled: false,
  intervalSec: 30,
  position: 'bl',
  symbols: [],
};

/** Một mã tại một thời điểm — đơn vị giá: NGHÌN ĐỒNG (71.8 = 71.800đ), như mọi bảng giá VN. */
export interface StockQuote {
  symbol: string;
  /** Giá khớp gần nhất; chưa có lệnh khớp thì bằng tham chiếu. */
  last: number;
  /** Tham chiếu / trần / sàn — nền của quy ước màu vàng/tím/lơ. */
  ref: number;
  ceil: number;
  floor: number;
  high: number;
  low: number;
  open: number;
  /** % thay đổi so tham chiếu, tự tính từ last/ref (nguồn trả string không dấu). */
  changePc: number;
  /** Tổng KL khớp trong ngày (đã quy về cổ phiếu — nguồn VPS đếm theo lô 10). */
  volume: number;
}

export interface StockQuotesResult {
  quotes: StockQuote[];
  /** Mã cấu hình mà nguồn không trả (sai mã, ngừng giao dịch). */
  missing: string[];
  at: number;
}

// ── Quy ước màu bảng giá VN (SSI iBoard/VNDirect/VPS đều thế, dân trade đọc theo phản xạ) ──
//   tím  = kịch trần · xanh lá = tăng · vàng = đứng tham chiếu · đỏ = giảm · xanh lơ = kịch sàn
export type StockTone = 'ceil' | 'up' | 'ref' | 'down' | 'floor';

export function quoteTone(q: StockQuote): StockTone {
  // So bằng có epsilon: giá đã qua string→number, 22.250000000000004 vẫn là trần.
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  if (q.ceil > 0 && eq(q.last, q.ceil)) return 'ceil';
  if (q.floor > 0 && eq(q.last, q.floor)) return 'floor';
  if (q.last > q.ref) return 'up';
  if (q.last < q.ref) return 'down';
  return 'ref';
}

/** Giá vượt ngưỡng cấu hình chưa — trả về ngưỡng nào dính để tooltip nói được lý do. */
export function thresholdHit(cfg: StockSymbolCfg, q: StockQuote): 'above' | 'below' | null {
  if (cfg.above !== undefined && q.last >= cfg.above) return 'above';
  if (cfg.below !== undefined && q.last <= cfg.below) return 'below';
  return null;
}

/**
 * Giờ khớp lệnh HOSE/HNX (T2–T6, giờ VN): 09:00–11:30 và 13:00–15:00.
 * Dùng để widget ghi "ngoài giờ" và tự giãn chu kỳ poll — giá ngoài giờ không
 * đổi, gọi mỗi 10 giây chỉ tốn kết nối.
 */
export function marketOpen(now: Date = new Date()): boolean {
  // Quy về giờ VN (UTC+7) không phụ thuộc timezone máy.
  const vn = new Date(now.getTime() + (now.getTimezoneOffset() + 7 * 60) * 60_000);
  const day = vn.getDay();
  if (day === 0 || day === 6) return false;
  const mins = vn.getHours() * 60 + vn.getMinutes();
  return (mins >= 9 * 60 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins <= 15 * 60);
}

// ── API client ────────────────────────────────────────────────────────────────

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/stocks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; result?: T } | null;
  if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data.result as T;
}

export function fetchStocksConfig(): Promise<StocksConfig> {
  return call<StocksConfig>({ action: 'config' });
}

export function saveStocksConfig(config: StocksConfig): Promise<StocksConfig> {
  return call<StocksConfig>({ action: 'save', config });
}

/** Lấy giá các mã ĐANG CẤU HÌNH (server đọc config, không nhận list từ client). */
export function fetchStockQuotes(): Promise<StockQuotesResult> {
  return call<StockQuotesResult>({ action: 'quotes' });
}
