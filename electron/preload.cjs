// Browser Workspace Framework — preload bridge.
//
// Runs in an isolated context and exposes a tiny, audited `window.workspace`
// API to the DevBox renderer. No Node access leaks to the page (contextIsolation
// on, nodeIntegration off). The effective config is passed in via an
// additionalArguments flag from the main process (see electron/main.cjs).

const { contextBridge, ipcRenderer } = require('electron');

/** Parse the `--ws-config=<json>` flag the main process injected. */
function readConfig() {
  const arg = process.argv.find((a) => a.startsWith('--ws-config='));
  if (!arg) return {};
  try {
    return JSON.parse(arg.slice('--ws-config='.length));
  } catch {
    return {};
  }
}

contextBridge.exposeInMainWorld('workspace', {
  isDesktop: true,
  version: process.versions.electron,
  config: readConfig(),
  /** Wipe cookies + storage + cache for a partition (the "Logout" action). */
  clearSession: (partition) => ipcRenderer.invoke('workspace:clearSession', partition),
  /** Kéo focus về host page sau khi hủy <webview> (fix input "chết"). */
  focusHost: () => ipcRenderer.invoke('workspace:focusHost'),
  /**
   * Tải một ảnh bằng phiên của partition, trả về data URL.
   *
   * Dùng cho ảnh đại diện tài khoản: avatar nằm ở CDN khác gốc không kèm CORS,
   * nên trong guest thì fetch() lẫn canvas.toDataURL() đều chết. Main process
   * tải ở tầng mạng, không có CORS, mà vẫn gửi đúng cookie phiên.
   * → { ok, dataUrl } | { ok:false, error }
   */
  fetchImage: (partition, url) => ipcRenderer.invoke('workspace:fetchImage', partition, url),
  /**
   * Gửi một phím THẬT vào guest của một partition, từ main process.
   *
   * Automation gửi tin Zalo bằng cách gõ chữ (được) rồi nhấn Enter. Ô soạn của
   * Zalo bỏ qua sự kiện giả (isTrusted=false), nên Enter phải là sự kiện thật.
   * `<webview>.sendInputEvent` ở renderer chỉ ăn khi webview đang focus — mà
   * lúc rule chạy từ tab khác thì webview ở nền. Main process focus đúng
   * webContents của guest rồi bơm phím, không phụ thuộc webview có đang hiện.
   * → { ok } | { ok:false, error }
   */
  sendKey: (partition, keyCode) => ipcRenderer.invoke('workspace:sendKey', partition, keyCode),
  /** Niêm phong/mở niêm phong mật khẩu đã lưu bằng safeStorage (DPAPI). Chỉ
   *  main process có safeStorage, và Next server là process riêng nên không
   *  dùng được — renderer là nơi duy nhất thấy plaintext.
   *  → { ok: true, value } | { ok: false, error: 'unavailable' | ... } */
  encryptSecret: (plain) => ipcRenderer.invoke('workspace:encryptSecret', plain),
  decryptSecret: (b64) => ipcRenderer.invoke('workspace:decryptSecret', b64),
  /** Mở URL bằng trình duyệt ngoài của máy (nút ↗ ở tab Google, link hướng dẫn
   *  trong panel lỗi mail). */
  openExternal: (url) => ipcRenderer.invoke('workspace:openExternal', url),
  /** Bấm link trong tin nhắn Zalo/Telegram → main process hỏi mở ở tab Links
   *  hay tab Browser. Trả về hàm hủy đăng ký. */
  onOpenRequest: (cb) => {
    const handler = (_evt, url) => cb(url);
    ipcRenderer.on('workspace:openRequest', handler);
    return () => ipcRenderer.removeListener('workspace:openRequest', handler);
  },
  /** window.open() từ chính UI DevBox — mở TRONG app (tab Links / tab Browser
   *  tùy defaultTargetFor) thay vì bắn ra Edge/Chrome. Trả về hàm hủy đăng ký. */
  onOpenInApp: (cb) => {
    const handler = (_evt, url) => cb(url);
    ipcRenderer.on('workspace:openInApp', handler);
    return () => ipcRenderer.removeListener('workspace:openInApp', handler);
  },
  /** Link target=_blank / window.open bấm TRONG một tab của tab Browser → mở
   *  thành tab mới ngay trong tab Browser (giữ phiên đăng nhập của profile).
   *  Trả về hàm hủy đăng ký. */
  onOpenInBrowserTab: (cb) => {
    const handler = (_evt, url) => cb(url);
    ipcRenderer.on('workspace:openInBrowserTab', handler);
    return () => ipcRenderer.removeListener('workspace:openInBrowserTab', handler);
  },
  /** Phím tắt khung app (Ctrl+` · Ctrl+Tab · Ctrl+Shift+U) bấm khi con trỏ đang
   *  ở TRONG một <webview>: phím không bubble ra host page nên main process bắt
   *  hộ ở before-input-event rồi chuyển về đây. Trả về hàm hủy đăng ký. */
  onShortcut: (cb) => {
    const handler = (_evt, name) => cb(name);
    ipcRenderer.on('desktop:shortcut', handler);
    return () => ipcRenderer.removeListener('desktop:shortcut', handler);
  },
  /** In HTML ra PDF bằng Chromium của app (tab Tools → Chuyển đổi file).
   *  Next server không gọi được Electron nên renderer làm cầu nối.
   *  → { ok: true, base64 } | { ok: false, error } */
  htmlToPdf: (html) => ipcRenderer.invoke('workspace:htmlToPdf', html),
  /** Tab Remote: bật phần mềm điều khiển từ xa có sẵn trên máy.
   *  CHỈ nhận { kind, address, username? } — kind là khoá trong bảng client
   *  khai sẵn ở main process, renderer không đưa được đường dẫn .exe tuỳ ý.
   *  → { ok: true, manual? } | { ok: false, error }
   *  `manual: true` nghĩa là client không nhận ID qua dòng lệnh (UltraViewer):
   *  ID đã được chép vào clipboard, người dùng tự dán. */
  openRemote: (payload) => ipcRenderer.invoke('workspace:openRemote', payload),
  /** Chép một chuỗi vào clipboard (nút "chép mật khẩu" ở tab Remote — mật khẩu
   *  chỉ được mở niêm phong ngay lúc bấm, không hiện ra màn hình). */
  copyText: (text) => ipcRenderer.invoke('workspace:copyText', text),
  /** Chuột phải file trong Explorer → "Open with → VHS DevBox": main process
   *  chuyển đường dẫn xuống đây, renderer mở nó ở tab Office / tab Tools tuỳ
   *  đuôi file. Bắn cả lúc khởi động nguội lẫn khi app đang chạy (qua
   *  'second-instance'). Trả về hàm hủy đăng ký. */
  onOpenLocalFile: (cb) => {
    const handler = (_evt, filePath) => cb(filePath);
    ipcRenderer.on('desktop:openLocalFile', handler);
    return () => ipcRenderer.removeListener('desktop:openLocalFile', handler);
  },
  /** Tab Terminal — chế độ "cửa sổ mới": mở một BrowserWindow riêng nạp
   *  /terminal/<id>. Cửa sổ chỉ là màn hình gắn vào phiên đang chạy trên Next
   *  server, nên đóng nó (hay nó crash) KHÔNG giết shell. Mở lại cùng id thì
   *  focus cửa sổ đang có.
   *  → { ok: true, focused? } | { ok: false, error } */
  openTerminalWindow: (payload) => ipcRenderer.invoke('workspace:openTerminalWindow', payload),
  /** Zalo API (thử nghiệm): đọc cookie HttpOnly (zpsid/zpw_sek/…) của một phiên
   *  zaloapi-*. Renderer không đọc được cookie HttpOnly qua document.cookie, nên
   *  main process đọc hộ qua session.cookies.get.
   *  → { ok:true, cookies:{name:value}, header:"a=1; b=2", seen:[…] } | { ok:false, error }
   *  `header` là toàn bộ cookie đã ghép — bước đăng nhập server-side cần nó. */
  readZaloCookies: (partition, names) => ipcRenderer.invoke('zaloapi:readCookies', partition, names),
});

// In-app console: the shell + `next dev` log stream the main process buffers
// (see pushLog in electron/main.cjs). Rendered by components/DesktopConsole.tsx.
contextBridge.exposeInMainWorld('desktopConsole', {
  /** Full ring-buffer history: [{ id, ts, source, line }]. */
  getAll: () => ipcRenderer.invoke('desktop:getLogs'),
  /** Subscribe to live lines. Returns the unsubscribe function. */
  onLine: (cb) => {
    const handler = (_evt, entry) => cb(entry);
    ipcRenderer.on('desktop:log', handler);
    return () => ipcRenderer.removeListener('desktop:log', handler);
  },
});
