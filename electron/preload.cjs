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
