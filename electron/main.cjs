// Browser Workspace Framework — Electron main process.
//
// This is the desktop SHELL around the existing Next.js DevBox. The main window
// simply loads the DevBox web UI (http://localhost:3000 by default); every
// existing tab (Redis/Kafka/Mongo/…) runs unchanged. The NEW capability is the
// "Workspace" tab: the renderer mounts Electron <webview> guests, one per
// plugin, each with its own persistent session partition.
//
// Responsibilities here (the "Browser Engine" + "Workspace Manager" layers of
// zalo-embed.md):
//   • create the window with webviewTag enabled + a hardened preload
//   • harden every <webview> guest (contextIsolation on, nodeIntegration off)
//   • per-partition permission allow-list, download policy, popup policy
//   • lifecycle logging (created / navigate / fail / crash / destroyed)
//   • clearSession IPC (the workspace "Logout")
//
// It knows NOTHING about Zalo specifically — plugins are declared in the
// renderer (lib/workspace/plugins.ts). Nothing here is hardcoded per website.

const { app, BrowserWindow, session, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const APP_URL = process.env.DESKTOP_URL || 'http://localhost:3000';

// Keep every workspace's browser profile (cookies/localStorage/IndexedDB/cache)
// inside the project at data/browser/ — machine-specific, gitignored — so
// logins persist across restarts and are easy to locate/wipe. Must run before
// app is ready. Persistent partitions land under data/browser/Partitions/.
app.setPath('userData', path.join(app.getAppPath(), 'data', 'browser'));

const DEFAULT_CONFIG = {
  persistSession: true,
  lazyLoad: true,
  maxActiveWorkspace: 3,
  keepAlive: true,
  allowDownload: true,
  enableDevTools: true,
};

// Web APIs a workspace guest is allowed to request. Everything else is denied.
// (Screen capture, geolocation, HID/serial/USB, MIDI are NOT granted.)
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media', // mic + camera for voice/video calls
  'fullscreen',
  'pointerLock',
  'clipboard-read',
  'clipboard-sanitized-write',
  'persistent-storage', // IndexedDB durability — Zalo needs it to hold state
]);

function log(tag, msg) {
  const ts = new Date().toISOString();
  console.log(`[workspace ${ts}] ${tag}${msg ? ' — ' + msg : ''}`);
}

/** Merge userData/workspace.config.json over the defaults. Missing file = defaults. */
function loadConfig() {
  try {
    const file = path.join(app.getPath('userData'), 'workspace.config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cfg = raw && typeof raw === 'object' && raw.workspace ? raw.workspace : raw;
    log('ConfigLoaded', file);
    return { ...DEFAULT_CONFIG, ...(cfg || {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

let CONFIG = { ...DEFAULT_CONFIG };
/** Partitions we've already wired handlers onto (idempotency). */
const configuredPartitions = new Set();

/** Attach permission / download / popup policy to a guest partition once. */
function configurePartition(part) {
  if (!part || configuredPartitions.has(part)) return;
  configuredPartitions.add(part);
  const ses = session.fromPartition(part);

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = ALLOWED_PERMISSIONS.has(permission);
    if (!ok) log('PermissionDenied', `${part} · ${permission}`);
    callback(ok);
  });

  // Synchronous permission CHECKS (e.g. Notification.permission, navigator
  // .storage.persisted()) must agree with the request handler, otherwise apps
  // read "denied" and never show notifications.
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  ses.on('will-download', (event, item) => {
    if (!CONFIG.allowDownload) {
      log('DownloadBlocked', item.getFilename());
      item.cancel();
      return;
    }
    log('DownloadStarted', item.getFilename());
    item.once('done', (_e, state) => log('DownloadDone', `${item.getFilename()} · ${state}`));
  });
}

/** Harden + instrument each <webview> guest as it attaches to the window. */
function wireWebviewHardening(win) {
  const wc = win.webContents;

  // Enforce safe webPreferences on every guest BEFORE it is created.
  wc.on('will-attach-webview', (_event, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    // Keep hidden workspaces (background tabs) running full-speed so new
    // messages / notifications arrive promptly even when not the active tab.
    prefs.backgroundThrottling = false;
    if (params.partition) configurePartition(params.partition);
    log('WebViewCreating', `${params.partition || 'default'} · ${params.src || ''}`);
  });

  wc.on('did-attach-webview', (_event, guest) => {
    log('WebViewCreated', guest.getURL());

    // Popups (target=_blank, window.open) → open in the real browser, never a
    // rogue in-app window.
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
        log('OpenExternal', url);
      }
      return { action: 'deny' };
    });

    // Surface the guest's own diagnostics (`[ws-unread]`, `[ws-diag]`, `[ws-size]`)
    // in THIS terminal so you don't have to open the webview's DevTools to see
    // them. Electron 43 emits console-message as a structured event
    // (event.message); older versions passed (event, level, message). Support
    // both so the forwarding can't silently go dark again.
    guest.on('console-message', (...args) => {
      const ev = args[0];
      const msg = [ev && ev.message, args[2], args[1]].find(
        (v) => typeof v === 'string' && v.startsWith('[ws-'),
      );
      if (msg) log('Guest', msg);
    });

    // Keep wheel/touch scrolling INSIDE the guest: when its inner scroller hits
    // an edge (e.g. pulling old chat history), Chromium would bubble the rest of
    // the gesture out to the host page and drift the whole DevBox frame.
    guest.on('dom-ready', () => {
      guest.insertCSS('html,body{overscroll-behavior:none}').catch(() => {});
    });

    guest.on('did-navigate', (_e, url) => log('Navigate', url));
    guest.on('render-process-gone', (_e, details) =>
      log('Crash', `${guest.getURL()} · ${details.reason}`),
    );
    guest.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3 /* ABORTED */) log('NetworkError', `${code} ${desc} · ${url}`);
    });
    guest.on('destroyed', () => log('WebViewClosed', ''));
  });
}

// ── Dev server lifecycle ──────────────────────────────────────────────────
// So the user only needs ONE command (`npm run desktop`): if nothing is
// serving the DevBox UI yet, start `next dev` ourselves and shut it down when
// the app closes. If a dev server is already up (they ran `npm run dev`
// separately) we reuse it and start nothing.
let devServer = null;

/** Resolve true if something answers an HTTP GET on url within 1s. */
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureDevServer() {
  // Pointed at an external server (prod/staging URL) → never auto-start.
  if (process.env.DESKTOP_URL) {
    log('DevServerSkip', `DESKTOP_URL set → dùng server ngoài (${APP_URL})`);
    return;
  }
  if (await probe(APP_URL)) {
    log('DevServerFound', `${APP_URL} đã chạy sẵn — dùng lại, không tự khởi động`);
    return;
  }
  const appPath = app.getAppPath();
  // Next's JS CLI entry — run it with Electron's bundled Node (no next.cmd /
  // PATH / path-with-spaces pitfalls).
  const nextBin = path.join(appPath, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!fs.existsSync(nextBin)) {
    log('DevServerMissing', `không thấy ${nextBin} — chạy \`npm install\` trước`);
    return;
  }
  log('DevServerStarting', 'next dev — lần đầu biên dịch có thể mất ~10-30s');
  devServer = spawn(process.execPath, [nextBin, 'dev'], {
    cwd: appPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit'], // Next logs land in this terminal
    detached: process.platform !== 'win32',  // own process group on POSIX
  });
  devServer.on('exit', (code) => {
    log('DevServerExited', String(code));
    devServer = null;
  });
  devServer.on('error', (err) => log('DevServerError', err && err.message));
}

/** Kill the dev server (and its worker children) on shutdown. */
function stopDevServer() {
  if (!devServer || devServer.killed) return;
  const pid = devServer.pid;
  log('DevServerStopping', String(pid));
  try {
    if (process.platform === 'win32') {
      // Kill the whole tree — next dev spawns compile workers.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    } else {
      try {
        process.kill(-pid, 'SIGTERM'); // negative pid = the process group
      } catch {
        devServer.kill('SIGTERM');
      }
    }
  } catch (err) {
    log('DevServerStopError', err && err.message);
  }
  devServer = null;
}

async function loadAppWithRetry(win) {
  for (let i = 0; i < 120; i++) {
    try {
      await win.loadURL(APP_URL);
      log('AppLoaded', APP_URL);
      return;
    } catch (err) {
      if (i === 0) log('AppWaiting', `${APP_URL} đang khởi động (next dev biên dịch lần đầu)…`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        `<body style="font:16px system-ui;padding:2rem;color:#333">
           <h2>Không kết nối được DevBox</h2>
           <p>Không mở được <code>${APP_URL}</code>.</p>
           <p>Hãy chạy <code>npm run dev</code> trước, rồi <code>npm run desktop</code> lại.</p>
         </body>`,
      ),
  );
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      webviewTag: true, // enables <webview> in the renderer
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: ['--ws-config=' + JSON.stringify(CONFIG)],
      devTools: true,
    },
  });

  // DevBox UI's own popups (rare) → external browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wireWebviewHardening(win);
  void loadAppWithRetry(win);
  return win;
}

// Wipe a workspace session (the "Logout" button in the UI).
ipcMain.handle('workspace:clearSession', async (_evt, partition) => {
  if (typeof partition !== 'string' || !partition) {
    return { ok: false, error: 'partition required' };
  }
  try {
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();
    await ses.clearCache();
    log('Logout', partition);
    return { ok: true };
  } catch (err) {
    log('LogoutError', `${partition} · ${err && err.message}`);
    return { ok: false, error: err && err.message };
  }
});

app.whenReady().then(async () => {
  CONFIG = loadConfig();
  await ensureDevServer(); // start next dev if nothing is serving :3000 yet
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Make sure the dev server we started doesn't outlive the app.
app.on('before-quit', stopDevServer);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
