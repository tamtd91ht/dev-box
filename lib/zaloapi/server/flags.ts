// Cổng bật/tắt nhánh Zalo API (thử nghiệm).
//
// Mặc định TẮT, và đó là chủ ý: nhánh này vi phạm ToS Zalo và có thể làm khoá
// tài khoản (xem rủi ro đầu lib/zaloapi/types.ts). Phải bật tay trong
// .env.local thì route mới nhận request — không ai vô tình chạy phải.

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');

/** Bật toàn nhánh (route trả 403 khi tắt). */
export const ZALOAPI_ENABLED = on(process.env.ZALOAPI_TOOL_ENABLED);

/**
 * Cho phép GỬI thật. Tách khỏi cổng trên để dùng được chế độ "chỉ đăng nhập +
 * xem", giống cách OFFICE_ALLOW_WRITE tách khỏi OFFICE_TOOL_ENABLED: bật thử
 * nghiệm là một quyết định, cho nó bắn tin ra ngoài là một quyết định khác.
 */
export const ZALOAPI_ALLOW_SEND = on(process.env.ZALOAPI_ALLOW_SEND);
