'use client';

// Zalo API — danh sách tài khoản (nhiều tài khoản, như Workspace).
//
// Mỗi tài khoản là một phiên Zalo độc lập: partition webview riêng
// (`persist:zaloapi-<instanceId>`) + accountKey riêng (`zaloapi::<instanceId>`)
// dùng chung cho registry guest, phiên server, listener, và scope automation.
//
// Mirror lib/workspace/accounts.ts nhưng KHÔNG phụ thuộc WorkspacePlugin — nhánh
// Zalo API không phải một workspace plugin. Danh sách nhớ trong localStorage.

export interface ZaloApiAccount {
  /** Id ổn định — phần đuôi của partition + accountKey. */
  instanceId: string;
  /** Nhãn hiển thị ở rail, sửa được. */
  label: string;
  /**
   * Tự kết nối lại khi mở app, nếu cookie trong partition còn hạn.
   *
   * Vắng mặt = BẬT: tài khoản lưu từ trước khi có cờ này vẫn tự kết nối, đúng
   * hành vi người dùng mong đợi. Tắt cho tài khoản chỉ dùng để quét QR thử —
   * Zalo chỉ cho MỘT kết nối mỗi tài khoản, nên tự nối một tài khoản không
   * dùng là chiếm mất chỗ của phiên thật.
   */
  autoConnect?: boolean;
}

/** Cờ autoConnect đã chuẩn hoá — vắng mặt coi như bật (xem ghi chú ở trên). */
export const zaloApiAutoConnect = (a: ZaloApiAccount): boolean => a.autoConnect !== false;

const STORE_KEY = 'zaloapi:accounts';

/** accountKey dùng ở registry guest + server + scope. */
export const zaloApiAccountKey = (instanceId: string) => `zaloapi::${instanceId}`;
/** Partition webview cho một tài khoản. */
export const zaloApiPartition = (instanceId: string) => `persist:zaloapi-${instanceId}`;

function uid(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  } catch {
    return `a${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/**
 * Nạp danh sách. Lần đầu (chưa có gì trong localStorage) gieo một tài khoản
 * 'main' để tương thích phiên đã đăng nhập từ trước (partition zaloapi-main).
 * Danh sách RỖNG đã lưu được tôn trọng (gỡ hết là gỡ hết).
 */
export function loadZaloApiAccounts(): ZaloApiAccount[] {
  if (typeof window === 'undefined') return [{ instanceId: 'main', label: 'Zalo API 1' }];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? (JSON.parse(raw) as ZaloApiAccount[]) : null;
    if (Array.isArray(arr)) return arr;
  } catch {
    /* fall through to seed */
  }
  const seed = [{ instanceId: 'main', label: 'Zalo API 1' }];
  saveZaloApiAccounts(seed);
  return seed;
}

export function saveZaloApiAccounts(list: ZaloApiAccount[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Tài khoản mới, số thứ tự lấy theo chỗ trống đầu tiên. */
export function newZaloApiAccount(existing: ZaloApiAccount[]): ZaloApiAccount {
  const nums = new Set(
    existing.map((a) => {
      const m = /(\d+)$/.exec(a.label);
      return m ? Number(m[1]) : 0;
    }),
  );
  let n = 1;
  while (nums.has(n)) n += 1;
  return { instanceId: uid(), label: `Zalo API ${n}` };
}
