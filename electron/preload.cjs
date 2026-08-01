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
});
