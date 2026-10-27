// Dữ liệu nhỏ THEO HOST của tab Browser, cất trong localStorage của app:
//   · favicon đã thấy — để tab khôi phục / ô lối tắt ở trang tab mới có biểu
//     tượng ngay, khỏi đợi trang tải xong;
//   · mức thu phóng — như Chrome nhớ zoom theo trang (Ctrl+± ở một tab thì mọi
//     tab cùng host theo, mở lại app vẫn giữ);
//   · lối tắt đã ẩn ở trang tab mới (nút ✕ trên ô) — ẩn chứ KHÔNG xoá lịch sử.
//
// Mọi hàm đều nuốt lỗi localStorage (bị chặn / đầy): mất mấy thứ này chỉ là
// mất một chút tiện, không được làm hỏng tab.

const FAVICON_KEY = 'devbox.browser.favicons';
const ZOOM_KEY = 'devbox.browser.zoom';
const HIDDEN_TILES_KEY = 'devbox.browser.hiddenTiles';

/** Trần số host nhớ favicon — một URL ngắn mỗi host, nhưng không để phình vô hạn. */
const MAX_FAVICONS = 400;

export function hostKey(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

function readMap<T>(key: string): Record<string, T> {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, T> : {};
  } catch { return {}; }
}

function writeMap(key: string, m: Record<string, unknown>): void {
  try { localStorage.setItem(key, JSON.stringify(m)); } catch { /* đầy / bị chặn */ }
}

export function faviconOf(url: string): string | undefined {
  const h = hostKey(url);
  return h ? readMap<string>(FAVICON_KEY)[h] : undefined;
}

/** Ghi favicon của host. Chỉ nhận http(s)/data: — favicon chrome-extension://
 *  hay blob: không dùng lại được ở trang khác. */
export function rememberFavicon(url: string, icon: string): void {
  const h = hostKey(url);
  if (!h || !/^(https?:|data:image\/)/i.test(icon) || icon.length > 4000) return;
  const m = readMap<string>(FAVICON_KEY);
  if (m[h] === icon) return;
  delete m[h];
  m[h] = icon;
  // Object giữ thứ tự chèn → cắt từ đầu là bỏ host lâu không ghé nhất.
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FAVICONS))) delete m[k];
  writeMap(FAVICON_KEY, m);
}

/** Mức zoom đã nhớ của host (1 = 100%, mặc định). */
export function zoomOf(url: string): number {
  const h = hostKey(url);
  const z = h ? readMap<number>(ZOOM_KEY)[h] : undefined;
  return typeof z === 'number' && z >= 0.25 && z <= 5 ? z : 1;
}

/** Nhớ zoom của host; về 100% thì xoá hẳn dòng đó cho gọn. */
export function rememberZoom(url: string, z: number): void {
  const h = hostKey(url);
  if (!h) return;
  const m = readMap<number>(ZOOM_KEY);
  if (Math.abs(z - 1) < 0.001) delete m[h];
  else m[h] = Math.round(z * 100) / 100;
  writeMap(ZOOM_KEY, m);
}

export function hiddenTiles(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_TILES_KEY) || '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

export function hideTile(host: string): void {
  const s = hiddenTiles();
  s.add(host);
  try { localStorage.setItem(HIDDEN_TILES_KEY, JSON.stringify([...s].slice(-200))); } catch { /* bỏ qua */ }
}

export function unhideAllTiles(): void {
  try { localStorage.removeItem(HIDDEN_TILES_KEY); } catch { /* bỏ qua */ }
}
