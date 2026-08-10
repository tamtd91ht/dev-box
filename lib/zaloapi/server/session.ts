// Zalo API (thử nghiệm) — kho phiên server-side, CHỈ NẰM TRONG RAM.
//
// Vì sao không ghi xuống đĩa: credential ở đây là TOÀN QUYỀN tài khoản Zalo cá
// nhân (xem rủi ro #3 trong lib/zaloapi/types.ts). Ghi ra file nghĩa là một bản
// sao toàn quyền nằm lại trên máy sau khi tắt app — đổi lại chỉ để khỏi quét QR
// lần nữa. Không đáng. Tắt tiến trình là mất phiên, và đó là chủ ý.
//
// Vòng đời: UI trích cookie+imei từ guest → route gọi login() → ZaloContext cất
// ở đây theo accountKey → mọi lần gửi sau chỉ cần accountKey.

import { login, type ZaloContext, type ZaloCreds } from './client';

/** Phiên hết hạn sau ngần này nếu không dùng — buộc đăng nhập lại cho tươi. */
const TTL_MS = 12 * 60 * 60 * 1000; // 12 giờ

interface Entry {
  ctx: ZaloContext;
  /**
   * Credential thô (cookie/imei/UA) để TỰ ĐĂNG NHẬP LẠI khi phiên hỏng — cookie
   * bị Zalo xoay, secretKey hết hạn, listener rớt lâu. Giữ trong RAM cùng ctx;
   * không ghi đĩa (xem đầu file). Nhờ nó, listener nối lại được mà không cần
   * người dùng bấm Kết nối lại.
   */
  creds: ZaloCreds;
  /** Lúc tạo phiên (login thành công). */
  createdAt: number;
  /** Lần gửi/chạm gần nhất — TTL tính từ đây. */
  touchedAt: number;
  /** Login đang chạy — gộp các lời gọi re-login đồng thời vào một lần. */
  relogin?: Promise<ZaloContext>;
}

/**
 * Next dev server hot-reload sẽ nạp lại module và thổi bay biến module-level,
 * làm mất phiên sau mỗi lần sửa code. Gắn vào globalThis để phiên sống qua
 * reload — cùng thủ thuật mà Prisma/PG pool hay dùng trong Next.
 */
const g = globalThis as typeof globalThis & { __zaloApiSessions?: Map<string, Entry> };
const store: Map<string, Entry> = g.__zaloApiSessions ?? (g.__zaloApiSessions = new Map());

function alive(e: Entry): boolean {
  return Date.now() - e.touchedAt < TTL_MS;
}

/** Cất phiên vừa đăng nhập + creds để tự login lại sau này. Ghi đè phiên cũ. */
export function putSession(accountKey: string, ctx: ZaloContext, creds: ZaloCreds): void {
  const now = Date.now();
  store.set(accountKey, { ctx, creds, createdAt: now, touchedAt: now });
}

/**
 * Lấy context TƯƠI: dùng lại nếu còn hạn, hết hạn/hỏng thì tự login lại bằng
 * creds đã lưu. Nhiều lời gọi đồng thời chia sẻ MỘT lần re-login.
 *
 * `force=true` bỏ qua cache và login lại ngay — dùng khi socket vừa bị Zalo từ
 * chối (cookie có thể đã xoay), để lấy secretKey/cookie mới.
 */
export async function getFreshContext(accountKey: string, force = false): Promise<ZaloContext> {
  const e = store.get(accountKey);
  if (!e) throw new Error('chưa có phiên — Kết nối lại ở tab Zalo API');
  if (!force && alive(e)) {
    e.touchedAt = Date.now();
    return e.ctx;
  }
  if (e.relogin) return e.relogin;
  e.relogin = login(e.creds)
    .then((ctx) => {
      const cur = store.get(accountKey);
      if (cur) {
        cur.ctx = ctx;
        cur.touchedAt = Date.now();
        cur.relogin = undefined;
      }
      return ctx;
    })
    .catch((err) => {
      const cur = store.get(accountKey);
      if (cur) cur.relogin = undefined;
      throw err;
    });
  return e.relogin;
}

/** Lấy phiên còn hạn; chạm vào là gia hạn TTL. Hết hạn thì dọn luôn. */
export function getSession(accountKey: string): ZaloContext | null {
  const e = store.get(accountKey);
  if (!e) return null;
  if (!alive(e)) {
    store.delete(accountKey);
    return null;
  }
  e.touchedAt = Date.now();
  return e.ctx;
}

/** Đăng xuất — xoá hẳn credential khỏi RAM. */
export function dropSession(accountKey: string): boolean {
  return store.delete(accountKey);
}

/** Tóm tắt phiên cho UI. KHÔNG trả cookie/secretKey ra ngoài. */
export interface SessionInfo {
  accountKey: string;
  uid: string;
  /** Có host chat/group để gửi được chưa. */
  ready: boolean;
  createdAt: number;
  touchedAt: number;
  expiresAt: number;
}

function describe(accountKey: string, e: Entry): SessionInfo {
  return {
    accountKey,
    uid: e.ctx.uid,
    ready: !!e.ctx.serviceMap?.chat?.length,
    createdAt: e.createdAt,
    touchedAt: e.touchedAt,
    expiresAt: e.touchedAt + TTL_MS,
  };
}

/** Thông tin một phiên (null nếu không có / hết hạn). */
export function sessionInfo(accountKey: string): SessionInfo | null {
  const e = store.get(accountKey);
  if (!e || !alive(e)) return null;
  return describe(accountKey, e);
}

/** Danh sách phiên đang sống — tiện lợi cho bảng trạng thái ở UI. */
export function listSessions(): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const [k, e] of store) {
    if (alive(e)) out.push(describe(k, e));
    else store.delete(k); // dọn rác nhân thể
  }
  return out;
}
