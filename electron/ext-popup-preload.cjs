// Preload cho POPUP cua extension (chay trong <webview> cua BrowserExtBar).
//
// Popup duoc nap bang chinh URL `chrome-extension://<id>/popup.html` nen no o
// DUNG ORIGIN cua extension: `chrome.storage`, `chrome.runtime` va messaging
// sang service worker deu la hang that cua Electron. File nay CHI VA them may
// API Electron khong cap:
//
//   · chrome.tabs.query   — popup can biet tab dang xem (url/id)
//   · chrome.tabs.update  — dieu huong tab dang xem
//   · chrome.cookies.getAll / .get — doc cookie HttpOnly cua profile
//
// KHONG ghi de thu gi da co. Neu mot ban Electron sau nay cap that
// `chrome.tabs`, doan nay tu dong dung im (xem kiem tra `existing` ben duoi) —
// de khong bien mot API that thanh do gia.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Bối cảnh tab đang xem. Nhận lúc khởi tạo qua thuộc tính trên <webview>, và
// cập nhật khi người dùng chuyển tab trong lúc popup còn mở.
// Doc tu HASH chu khong phai query: nhieu popup tu doc `location.search` cho
// router cua chung, them tham so la vao do la lam hong router cua nguoi ta.
let ctx = { partition: '', activeUrl: '' };
try {
  const m = /(?:^|[#&])__devbox=([^&]*)/.exec(location.hash || '');
  if (m) {
    const parsed = JSON.parse(decodeURIComponent(m[1]));
    if (parsed && typeof parsed === 'object') ctx = { ...ctx, ...parsed };
  }
} catch {
  /* hash khong phai JSON hop le — cu de rong, shim van chay */
}

/** Tab gia lap: popup chi can id + url + active + windowId. */
const fakeTab = () => ({
  id: 1,
  index: 0,
  windowId: 1,
  active: true,
  highlighted: true,
  pinned: false,
  incognito: false,
  selected: true,
  discarded: false,
  autoDiscardable: true,
  groupId: -1,
  url: ctx.activeUrl,
  pendingUrl: ctx.activeUrl,
  title: '',
  favIconUrl: '',
  status: 'complete',
});

/** Gọi callback nếu có, đồng thời trả Promise — chrome API hỗ trợ cả hai kiểu. */
function dual(result, cb) {
  if (typeof cb === 'function') {
    try { cb(result); } catch (e) { console.error('[devbox] callback lỗi:', e); }
  }
  return Promise.resolve(result);
}

const tabsShim = {
  query(_info, cb) {
    // Popup nào cũng hỏi {active:true,currentWindow:true} — DevBox chỉ có một
    // tab "đang xem" nên trả đúng một phần tử, bỏ qua bộ lọc.
    return dual([fakeTab()], cb);
  },
  get(_id, cb) {
    return dual(fakeTab(), cb);
  },
  getCurrent(cb) {
    return dual(fakeTab(), cb);
  },
  update(idOrProps, propsOrCb, maybeCb) {
    // Hai chữ ký: update(props, cb) và update(tabId, props, cb).
    const props = typeof idOrProps === 'object' ? idOrProps : propsOrCb;
    const cb = typeof propsOrCb === 'function' ? propsOrCb : maybeCb;
    const url = props && typeof props.url === 'string' ? props.url : '';
    if (url) ipcRenderer.send('extPopup:navigate', url);
    return dual(fakeTab(), cb);
  },
  create(props, cb) {
    // "Mở tab mới" — DevBox mở thành tab mới thật trong tab Browser.
    const url = props && typeof props.url === 'string' ? props.url : '';
    if (url) ipcRenderer.send('extPopup:openTab', url);
    return dual(fakeTab(), cb);
  },
  // Nhiều popup gọi sendMessage để nói chuyện với content script. Không có
  // đường đó ở đây, nhưng phải tồn tại để popup không ném ra rồi chết cả UI.
  sendMessage(_id, _msg, _opts, cb) {
    const fn = [_opts, cb].find((x) => typeof x === 'function');
    return dual(undefined, fn);
  },
  onUpdated: { addListener() {}, removeListener() {}, hasListener: () => false },
  onActivated: { addListener() {}, removeListener() {}, hasListener: () => false },
};

const cookiesShim = {
  getAll(details, cb) {
    const domain = (details && details.domain) || '';
    const name = details && details.name;
    const names = name ? [name] : null;
    const p = ipcRenderer
      .invoke('browserExt:getCookies', ctx.partition, domain, names)
      .then((r) => (r && r.ok ? r.cookies : []))
      .catch(() => []);
    if (typeof cb === 'function') p.then((v) => { try { cb(v); } catch (e) { console.error(e); } });
    return p;
  },
  get(details, cb) {
    const p = cookiesShim.getAll(details).then((list) => list[0] || null);
    if (typeof cb === 'function') p.then((v) => { try { cb(v); } catch (e) { console.error(e); } });
    return p;
  },
  // Ghi/xoá cookie chưa mở — đọc là đủ cho các extension nội bộ đang dùng, và
  // ghi cookie tuỳ ý từ popup là quyền quá rộng để cấp mà chưa có ai cần.
  set() { return Promise.resolve(null); },
  remove() { return Promise.resolve(null); },
  onChanged: { addListener() {}, removeListener() {}, hasListener: () => false },
};

/**
 * Gắn shim vào đối tượng `chrome` CÓ SẴN của trang.
 *
 * Popup ở đúng origin extension nên Electron đã dựng sẵn `chrome` thật với
 * storage/runtime. Phải VÁ VÀO đó chứ không thay cả cụm — thay là mất luôn
 * storage/runtime thật, popup hỏng nặng hơn lúc chưa vá.
 *
 * Chạy trong ngữ cảnh trang (executeJavaScript) vì contextBridge không cho ghi
 * đè/mở rộng một object đã tồn tại bên phía trang.
 */
const INSTALL = `(function(){
  try {
    var c = (typeof chrome !== 'undefined' && chrome) ? chrome : (window.chrome = {});
    // KHÔNG đè API thật: chỉ điền vào chỗ còn trống.
    if (!c.tabs)    c.tabs    = window.__devboxTabs;
    if (!c.cookies) c.cookies = window.__devboxCookies;
    delete window.__devboxTabs;
    delete window.__devboxCookies;
    if (!c.runtime) c.runtime = {};
    if (!c.runtime.lastError) c.runtime.lastError = undefined;
  } catch (e) { console.error('[devbox] cài shim lỗi:', e); }
})();`;

contextBridge.exposeInMainWorld('__devboxTabs', tabsShim);
contextBridge.exposeInMainWorld('__devboxCookies', cookiesShim);

// Chạy NGAY khi document bắt đầu, trước script của popup — nếu chạy sau,
// popup đã gọi chrome.tabs.query và ném lỗi trước khi shim kịp có mặt.
webFrame.executeJavaScript(INSTALL).catch((e) => console.error('[devbox] shim:', e));
