// Phím tắt kiểu Chrome của tab Browser. Browser-safe, không phụ thuộc React.
//
// HAI NƠI bắt phím, cùng một bảng:
//   · host page (document keydown) — con trỏ ở thanh tab, ô địa chỉ, trang tab mới;
//   · con trỏ ở TRONG trang web: phím giữ chặt (RESERVED_KEYS) do main process
//     chặn ở before-input-event rồi gửi 'browser:key' về; phím còn lại để trang
//     xử lý trước, LinkViewer bắt lại nếu trang bỏ qua (xem RESERVED_KEYS).
//     Bảng của main nằm ở electron/main.cjs · browserKeyOf —
//     main là CommonJS, không import được file này, nên SỬA MỘT BÊN PHẢI SỬA
//     CẢ BÊN KIA (scripts/check-browser-keys.ts so hai bảng với nhau).
//
// Ctrl+Tab KHÔNG có ở đây: đó là phím "về tab app trước" của khung app
// (appShortcutOf) — chuyển tab Browser dùng Ctrl+PageUp/PageDown như Chrome.

export type BrowserKey =
  | 'newTab' | 'closeTab' | 'reopenTab' | 'nextTab' | 'prevTab' | 'lastTab'
  | 'tab1' | 'tab2' | 'tab3' | 'tab4' | 'tab5' | 'tab6' | 'tab7' | 'tab8'
  | 'focusOmni' | 'find' | 'findNext' | 'findPrev'
  | 'reload' | 'hardReload' | 'back' | 'forward'
  | 'zoomIn' | 'zoomOut' | 'zoomReset'
  | 'bookmark' | 'print' | 'tabSearch' | 'history' | 'toggleMarks';

export interface KeyInput {
  key: string;
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * Tổ hợp phím → hành động, null nếu không phải phím của tab Browser.
 *
 * Nhận diện chữ/số theo `code` (vị trí phím vật lý) để layout khác vẫn đúng
 * ngón như Chrome; phím zoom theo `key` vì '+'/'=' nằm khác chỗ mỗi layout.
 */
export function browserKeyOf(k: KeyInput): BrowserKey | null {
  const ctrl = k.ctrl || k.meta;
  if (!ctrl && !k.alt) {
    if (k.key === 'F5') return k.shift ? 'hardReload' : 'reload';
    if (k.key === 'F6') return 'focusOmni';
    if (k.key === 'F3') return k.shift ? 'findPrev' : 'findNext';
    return null;
  }
  if (k.alt && !ctrl) {
    if (k.shift) return null;
    if (k.key === 'ArrowLeft') return 'back';
    if (k.key === 'ArrowRight') return 'forward';
    if (k.code === 'KeyD') return 'focusOmni';
    return null;
  }
  if (k.alt) return null;
  if (k.shift) {
    switch (k.code) {
      case 'KeyT': return 'reopenTab';
      case 'KeyR': return 'hardReload';
      case 'KeyA': return 'tabSearch';
      case 'KeyB': return 'toggleMarks';
      case 'KeyG': return 'findPrev';
      default: break;
    }
    if (k.key === '+') return 'zoomIn';
    return null;
  }
  switch (k.code) {
    case 'KeyT': return 'newTab';
    case 'KeyW': return 'closeTab';
    case 'KeyL': return 'focusOmni';
    case 'KeyF': return 'find';
    case 'KeyG': return 'findNext';
    case 'KeyR': return 'reload';
    case 'KeyD': return 'bookmark';
    case 'KeyP': return 'print';
    case 'KeyH': return 'history';
    case 'PageDown': return 'nextTab';
    case 'PageUp': return 'prevTab';
    case 'F5': return 'hardReload';
    default: break;
  }
  if (/^Digit[1-8]$/.test(k.code)) return `tab${k.code.slice(5)}` as BrowserKey;
  if (k.code === 'Digit9') return 'lastTab';
  if (k.key === '=' || k.key === '+' || k.code === 'NumpadAdd') return 'zoomIn';
  if (k.key === '-' || k.code === 'NumpadSubtract') return 'zoomOut';
  if (k.key === '0' || k.code === 'Numpad0') return 'zoomReset';
  return null;
}

/**
 * Phím GIỮ CHẶT — như danh sách "reserved" của Chrome: trang web không được
 * cướp. Main process chặn ngay ở before-input-event, trang không bao giờ thấy.
 *
 * Mọi phím KHÁC (Ctrl+F, Ctrl+P, Ctrl+D, Ctrl+H, Ctrl+L, Ctrl+±…) đi tới TRANG
 * TRƯỚC: trang nào tự xử lý (preventDefault — Google Docs mở hộp tìm riêng,
 * Monaco/VS Code web dùng Ctrl+P/Ctrl+D/Ctrl+H) thì thôi; trang để yên thì
 * LinkViewer bắt lại ở cuối chuỗi sự kiện và làm việc của trình duyệt. Chặn hết
 * ở main là phá đúng những web app dev hay dùng nhất.
 *
 * BẢN SAO ở electron/main.cjs · BROWSER_RESERVED_KEYS.
 */
export const RESERVED_KEYS: ReadonlySet<BrowserKey> = new Set<BrowserKey>([
  'newTab', 'closeTab', 'reopenTab', 'nextTab', 'prevTab',
]);

/** Hành động cần bàn phím ở HOST (ô địa chỉ, ô tìm, hộp thoại) — đang đứng
 *  trong trang web thì phải rứt focus khỏi guest trước. */
export const NEED_HOST_KEYS: ReadonlySet<BrowserKey> = new Set<BrowserKey>([
  'newTab', 'focusOmni', 'find', 'bookmark', 'tabSearch', 'history',
]);

/** Các mức thu phóng của Chrome (1 = 100%). */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** Mức kế tiếp theo chiều `dir` (+1 phóng to, -1 thu nhỏ), kẹp ở hai đầu. */
export function stepZoom(cur: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_LEVELS.find((z) => z > cur + 0.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  return [...ZOOM_LEVELS].reverse().find((z) => z < cur - 0.001) ?? ZOOM_LEVELS[0];
}
