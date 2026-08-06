// Bấm link trong tin nhắn Zalo/Telegram → mở ở đâu?
//
// Main process không vẽ được UI nên nó chỉ gửi URL sang renderer
// (workspace:openRequest). OpenLinkDialog hỏi người dùng, rồi phát tiếp một
// CustomEvent cho tab đích tự mở.
//
// Dùng CustomEvent trên window thay vì kéo prop xuyên app/page.tsx: tab Links và
// tab Browser đều tự giữ state tab của mình, và cả hai chỉ được MOUNT sau khi
// người dùng ghé lần đầu (`visited` trong page.tsx). Event cho phép page.tsx
// bật tab đúng lúc rồi tab đó tự nhận URL khi đã sẵn sàng.

/** Hai nơi trong app có thể mở một link tới. */
export type OpenTarget = 'links' | 'browser';

/**
 * Host của Google cần phiên đăng nhập để xem được (Docs/Sheets/Slides, Drive,
 * Gmail, Calendar…). Cố tình KHÔNG khớp mọi thứ có chữ "google": google.com/search,
 * maps, news, YouTube… là trang web thường, mở ở Browser là đúng — chỉ những
 * host mà nội dung nằm sau đăng nhập mới cần viewer có profile.
 */
const GOOGLE_LOGIN_HOSTS =
  /^(docs|sheets|slides|drive|mail|calendar|keep|meet|contacts|accounts|script|sites|groups|classroom|photos)\.google\.com$/i;

/**
 * Không cấu hình gì đặc biệt thì một link đi đâu?
 *
 *   · Link Google cần đăng nhập → tab LINKS (viewer có profile, nội dung nằm sau
 *     đăng nhập nên Browser phiên trống sẽ chỉ ra trang login)
 *   · Mọi link domain khác      → tab BROWSER (trình duyệt đa tab trong app)
 *
 * KHÔNG bao giờ trả về "trình duyệt ngoài": mặc định là mọi thứ xem trong DevBox.
 * Muốn ra Chrome/Edge thật thì bấm nút ↗ trên thanh công cụ của viewer.
 */
export function defaultTargetFor(url: string): OpenTarget {
  try {
    const host = new URL(url).hostname;
    if (GOOGLE_LOGIN_HOSTS.test(host)) return 'links';
  } catch {
    /* URL vẹo — cứ đưa Browser, nó tự chuẩn hóa/báo lỗi */
  }
  return 'browser';
}

const EVENT = 'devbox:open-url';

export interface OpenUrlDetail {
  url: string;
  target: OpenTarget;
}

/** Phát yêu cầu mở URL cho tab đích (Links / Browser). */
export function emitOpenUrl(detail: OpenUrlDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OpenUrlDetail>(EVENT, { detail }));
}

/**
 * Đăng ký nhận yêu cầu mở URL dành cho MỘT tab. Trả về hàm hủy đăng ký.
 *
 * Tab vừa được mount lần đầu sẽ nhận event trễ hơn lúc phát (page.tsx bật tab
 * rồi React mới mount) — vì vậy emitOpenUrl được gọi lại sau một nhịp, xem
 * OpenLinkDialog. Cả hai tab đích đều dựng id tab từ URL nên gọi trùng chỉ kích
 * hoạt lại đúng tab đó chứ không mở hai lần.
 */
export function onOpenUrl(target: OpenTarget, cb: (url: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<OpenUrlDetail>).detail;
    if (detail?.target === target && detail.url) cb(detail.url);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
