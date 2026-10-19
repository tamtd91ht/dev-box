// Gọi API của chính app (/api/*) mà KHÔNG bao giờ treo vô hạn.
//
// Vì sao tồn tại: renderer Chromium chỉ có 6 socket HTTP/1.1 tới mỗi host.
// Ở máy mở nhiều terminal, SSE /api/term/:id + automation watch chiếm sạch 6
// slot — fetch() từ trang khi ấy xếp hàng vô hạn dù server trả lời curl trong
// 11ms. Panel Redis/Kafka "load config mãi không xong" chính là hình dạng của
// lỗi này: không lỗi, không log, chỉ xoay.
//
// Cách chữa theo hai tầng:
//   1. Desktop: đi qua cầu window.desktopApi (electron/preload.cjs) — main
//      process gọi bằng Node http, pool riêng, không dính giới hạn 6 socket.
//   2. Web thường (không có cầu): vẫn fetch, nhưng kèm AbortSignal.timeout để
//      treo biến thành lỗi nhìn thấy được thay vì xoay mãi.

type DesktopApiResult = { ok: boolean; status?: number; body?: string; error?: string };

declare global {
  interface Window {
    desktopApi?: { fetch: (opts: Record<string, unknown>) => Promise<DesktopApiResult> };
  }
}

export interface ApiFetchInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Body đã stringify sẵn (JSON). */
  body?: string;
  /** Mặc định 30s. Quá hạn → throw, không bao giờ treo im lặng. */
  timeoutMs?: number;
}

/** Response tối giản — đủ cho các call site hiện có (ok / status / json()). */
export interface ApiResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export async function apiFetch(path: string, init: ApiFetchInit = {}): Promise<ApiResponse> {
  const { method = 'GET', body, timeoutMs = 30000 } = init;

  const bridge = typeof window !== 'undefined' ? window.desktopApi : undefined;
  if (bridge) {
    const r = await bridge.fetch({ path, method, body, timeoutMs });
    // Cầu trả { ok:false, error } khi CHƯA có phản hồi HTTP (timeout, server
    // chết). Có status là có phản hồi — kể cả 4xx/5xx — để call site tự xử.
    if (r.status === undefined) {
      throw new Error(`Gọi ${path} thất bại: ${r.error || 'không rõ lý do'}`);
    }
    return {
      ok: r.ok,
      status: r.status,
      // Body rỗng phải REJECT như fetch thật — call site dựa vào .catch(() => ({})).
      json: async () => JSON.parse(r.body ?? ''),
    };
  }

  const r = await fetch(path, {
    method,
    ...(body !== undefined
      ? { body, headers: { 'content-type': 'application/json' } }
      : {}),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: unknown) => {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(
        `Gọi ${path} quá ${Math.round(timeoutMs / 1000)}s không có phản hồi — server treo, ` +
          'hoặc 6 kết nối tới localhost đang bị SSE terminal/automation chiếm hết.',
      );
    }
    throw err;
  });
  return { ok: r.ok, status: r.status, json: () => r.json() };
}
