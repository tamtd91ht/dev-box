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

/**
 * YÊU CẦU ĐANG CHỜ, theo từng tab đích.
 *
 * VÌ SAO CẦN CÁI NÀY — lỗi "lần đầu ra trang trắng, lần hai mới được":
 * tab Links/Browser chỉ được MOUNT sau lần ghé đầu tiên (`visited` trong
 * page.tsx). Bấm một link khi tab đích chưa từng mở thì thứ tự là:
 *
 *     onGoTab(target)      → React xếp lịch mount, CHƯA mount
 *     emitOpenUrl(...)     → phát event... không ai nghe
 *     (mount xong)         → tab lên, rỗng → TRANG TRẮNG
 *
 * Bản trước chữa bằng cách phát lại sau `requestAnimationFrame`. Đó là đoán
 * thời điểm, và một frame không đủ: tab còn phải chạy effect khởi tạo của nó
 * (đọc registry, dựng partition) trước khi kịp gọi onOpenUrl. Đoán trúng hay
 * không tuỳ máy nhanh chậm — nên lần đầu trắng, lần hai (tab đã mount) mới được.
 *
 * Nay bỏ hẳn việc đoán: yêu cầu được GIỮ LẠI ở đây. Ai đăng ký sau cũng nhận
 * được ngay thứ đang chờ, dù mount trễ bao lâu. Xử lý xong thì xoá, nên tab
 * mount lại về sau không mở lại link cũ.
 */
const pending = new Map<OpenTarget, string>();

/** Phát yêu cầu mở URL cho tab đích (Links / Browser). */
export function emitOpenUrl(detail: OpenUrlDetail): void {
  if (typeof window === 'undefined') return;
  if (!detail?.url || !detail.target) return;
  // Ghi vào chỗ chờ TRƯỚC khi phát: nếu đã có listener thì nó xử lý ngay và tự
  // xoá; chưa có thì listener đăng ký sau sẽ thấy.
  pending.set(detail.target, detail.url);
  window.dispatchEvent(new CustomEvent<OpenUrlDetail>(EVENT, { detail }));

  // HẠN DÙNG. Đường bình thường thì tab đích luôn mount rồi tiêu thụ ngay (page.tsx
  // gọi setMode nên tab chắc chắn lên). Nhưng nếu vì lý do nào đó không ai lấy —
  // tab lỗi khi mount, người dùng đổi tab cực nhanh — thì bỏ đi sau một nhịp ngắn,
  // để lần mount nào đó về sau không bất ngờ mở lại một link cũ.
  const url = detail.url;
  const target = detail.target;
  setTimeout(() => { if (pending.get(target) === url) pending.delete(target); }, 10_000);
}

/**
 * Đăng ký nhận yêu cầu mở URL dành cho MỘT tab. Trả về hàm hủy đăng ký.
 *
 * Nhận cả yêu cầu ĐANG CHỜ lúc đăng ký (tab vừa mount) lẫn yêu cầu phát về sau
 * (tab đã mở, người dùng bấm link khác). Cả hai tab đích đều dựng id tab từ URL
 * nên nếu có gọi trùng cũng chỉ kích hoạt lại đúng tab đó, không mở hai lần.
 */
export function onOpenUrl(target: OpenTarget, cb: (url: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const take = (url: string) => {
    // Xoá trước khi gọi: `cb` có thể phát tiếp event (mở tab con…), giữ lại là
    // dễ thành vòng lặp mở đi mở lại.
    if (pending.get(target) === url) pending.delete(target);
    cb(url);
  };

  const handler = (e: Event) => {
    const detail = (e as CustomEvent<OpenUrlDetail>).detail;
    if (detail?.target === target && detail.url) take(detail.url);
  };
  window.addEventListener(EVENT, handler);

  // Có thứ đang chờ sẵn → xử lý luôn. Đây chính là đường cứu ca "tab vừa mount
  // sau khi event đã phát".
  const waiting = pending.get(target);
  if (waiting) take(waiting);

  return () => window.removeEventListener(EVENT, handler);
}
