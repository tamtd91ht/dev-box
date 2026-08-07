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
