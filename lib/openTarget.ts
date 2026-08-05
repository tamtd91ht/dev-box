// Bấm link trong workspace (Zalo/Telegram…) → mở ở đâu?
//
// Main process không vẽ được UI nên nó chỉ gửi URL sang renderer
// (workspace:openRequest). OpenLinkDialog hỏi người dùng, rồi phát tiếp một
// CustomEvent cho tab đích tự mở.
//
// Dùng CustomEvent trên window thay vì kéo prop xuyên app/page.tsx: tab Links và
// tab Browser đều tự giữ state tab của mình, và cả hai chỉ được MOUNT sau khi
// người dùng ghé lần đầu (`visited` trong page.tsx). Event cho phép page.tsx
// bật tab đúng lúc rồi tab đó tự nhận URL khi đã sẵn sàng.

/** Ba nơi có thể mở một link tới. */
export type OpenTarget = 'links' | 'browser' | 'external';

/** Tên tab trong DevBox tương ứng mỗi đích (external không có tab). */
export const TARGET_TAB: Record<Exclude<OpenTarget, 'external'>, 'links' | 'browser'> = {
  links: 'links',
  browser: 'browser',
};

const EVENT = 'devbox:open-url';

export interface OpenUrlDetail {
  url: string;
  target: Exclude<OpenTarget, 'external'>;
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
 * OpenLinkDialog.
 */
export function onOpenUrl(
  target: Exclude<OpenTarget, 'external'>,
  cb: (url: string) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<OpenUrlDetail>).detail;
    if (detail?.target === target && detail.url) cb(detail.url);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
