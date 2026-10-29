// Host dạng CLUSTER cho PostgreSQL — dùng chung cho server và browser (không import
// gì của Node).
//
// Ô Địa chỉ nhận "host:port" phân cách bằng dấu phẩy, giống chuỗi kết nối libpq:
//   "10.0.0.1:5432"                  một địa chỉ — máy đơn hoặc HA (VIP / proxy)
//   "pg1:5432,pg2:5433,pg3"          cluster — mỗi node một cổng riêng; không ghi cổng = 5432
//   "[fd00::1]:5432,[fd00::2]"       IPv6 phải đặt trong ngoặc vuông
// Khi lưu, mọi node được ghi kèm cổng (canonicalHostList) — không còn field port riêng.
// Server thử lần lượt các node và ưu tiên node PRIMARY (xem resolveEndpoint ở pgClient).

export interface PgEndpoint {
  host: string;
  port: number;
}

/** Bỏ mọi khoảng trắng — người dùng hay gõ "pg1, pg2". */
export function normalizeHostList(raw: string): string {
  return raw.replace(/\s+/g, '');
}

function parseOne(part: string, defaultPort: number): PgEndpoint {
  const bad = () => new Error(`host không hợp lệ: "${part}"`);
  if (!part || /[/@?]/.test(part)) throw bad();
  let host = part;
  let portStr = '';
  if (part.startsWith('[')) {
    const end = part.indexOf(']');
    if (end < 0) throw bad();
    host = part.slice(1, end);
    const rest = part.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) throw bad();
      portStr = rest.slice(1);
    }
  } else {
    const first = part.indexOf(':');
    if (first >= 0) {
      // Nhiều dấu ":" mà không có ngoặc vuông = IPv6 trần, không phải host:port.
      if (part.indexOf(':', first + 1) >= 0) host = part;
      else {
        host = part.slice(0, first);
        portStr = part.slice(first + 1);
      }
    }
  }
  if (!host) throw bad();
  let port = defaultPort;
  if (portStr) {
    port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port không hợp lệ trong "${part}"`);
  }
  return { host, port };
}

/** Tách ô Host thành danh sách node. Ném lỗi (tiếng Việt) nếu có phần không hợp lệ. */
export function parseHostList(raw: string, defaultPort: number): PgEndpoint[] {
  const parts = normalizeHostList(raw).split(',').filter(Boolean);
  if (!parts.length) throw new Error('cần nhập host');
  return parts.map((p) => parseOne(p, defaultPort));
}

export const DEFAULT_PG_PORT = 5432;

export function formatEndpoint(ep: PgEndpoint): string {
  return `${ep.host.includes(':') ? `[${ep.host}]` : ep.host}:${ep.port}`;
}

/**
 * Dạng lưu chuẩn "h1:5432,h2:5433" — node nào cũng có cổng. `defaultPort` chỉ dùng cho
 * node không ghi cổng (bản ghi cũ còn field port riêng, hoặc người dùng bỏ trống cổng).
 */
export function canonicalHostList(raw: string, defaultPort = DEFAULT_PG_PORT): string {
  return parseHostList(raw, defaultPort).map(formatEndpoint).join(',');
}

/** Nhãn hiển thị ngắn gọn cho danh sách kết nối. */
export function formatHostLabel(host: string, defaultPort = DEFAULT_PG_PORT): string {
  try {
    return canonicalHostList(host, defaultPort);
  } catch {
    return normalizeHostList(host);
  }
}
