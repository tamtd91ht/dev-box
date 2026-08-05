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

const { app, BrowserWindow, session, ipcMain, shell, Menu, safeStorage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const APP_URL = process.env.DESKTOP_URL || 'http://localhost:3000';

// ── In-app console ────────────────────────────────────────────────────────
// Every line the desktop shell prints (its own lifecycle log + the output of
// the `next dev` server it spawns) is mirrored into this ring buffer and
// streamed to the renderer over IPC. The UI shows it in a hidden-by-default
// Console drawer (components/DesktopConsole.tsx), so the app no longer needs
// a separate terminal window to be inspectable.
const LOG_LIMIT = 2000;
const logBuffer = [];
let logSeq = 0;

function pushLog(source, line) {
  const entry = { id: ++logSeq, ts: Date.now(), source, line };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_LIMIT);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('desktop:log', entry);
  }
  // Still echo to the terminal when launched from one. When launched from the
  // desktop shortcut there is no console attached — swallow the write error.
  try {
    process.stdout.write(`[${source} ${new Date(entry.ts).toISOString()}] ${line}\n`);
  } catch {}
}

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
  pushLog('shell', `${tag}${msg ? ' — ' + msg : ''}`);
}

/**
 * "Cung nha" voi mot workspace: registrable domain (2 nhan cuoi) trung nhau, VD
 * chat.zalo.me ↔ zalo.me, web.telegram.org ↔ telegram.org. Dung de phan biet
 * dieu huong TRONG app voi link ra ngoai. Khong dung eTLD+1 chuan (khong co
 * public-suffix list trong main process) — voi cac host workspace that
 * (zalo.me, telegram.org, google.com...) 2 nhan la du va khong sinh false
 * positive giua hai app khac nhau.
 */
function sameApp(a, b) {
  const reg = (h) => h.toLowerCase().split('.').slice(-2).join('.');
  return !!a && !!b && reg(a) === reg(b);
}

/**
 * Bam link trong workspace → HOI nguoi dung mo o dau (renderer dung modal 3 lua
 * chon: tab Links / Browser trong app / trinh duyet ngoai). Main process khong
 * ve duoc UI nen chi day yeu cau qua IPC; renderer tu quyet dinh va tu mo.
 *
 * Neu khong con cua so nao (dang tat app) thi fallback mo browser ngoai luon,
 * de link khong bi mat hut.
 */
function askOpenTarget(url) {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) {
    shell.openExternal(url);
    log('OpenExternal', `${url} (no window)`);
    return;
  }
  win.webContents.send('workspace:openRequest', url);
  log('OpenRequest', url);
}

/**
 * Link ra ngoai trong Zalo/Telegram KHONG di qua window.open: hai app tu
 * preventDefault() roi dieu huong chinh main frame cua no (location.href /
 * router noi bo). Khi do setWindowOpenHandler khong he chay, guest cu the dieu
 * huong ca workspace sang trang la — CSP cua app hoac router cua no chan lai,
 * nguoi dung thay "bam link khong an gi".
 *
 * Vi vay chan them o tang navigation: main frame roi khoi domain cua chinh
 * workspace → huy dieu huong, hoi mo o dau. Dieu huong trong app (dang nhap,
 * OAuth, doi subdomain) van chay binh thuong.
 *
 * CHI ap cho workspace app (tab Workspace: Zalo/Telegram/...). Cac <webview>
 * khac trong DevBox la TRINH XEM da nang — tab Links (persist:links-*) va
 * viewer Google (persist:ws-google-viewer) song bang viec dieu huong toi ten
 * mien la, ap luat nay vao la tu ban chan chinh minh (link ngoai bi day ra
 * browser, dang nhap accounts.google.com khong bao gio vao duoc).
 */
const WORKSPACE_PARTITION = /^(persist:)?ws-(?!google-viewer\b)[a-z0-9-]+$/i;

function wireExternalNavigation(guest, homeUrl, partition) {
  if (!WORKSPACE_PARTITION.test(partition || '')) return;
  let homeHost = '';
  try {
    homeHost = new URL(homeUrl).hostname;
  } catch {
    /* homeUrl khong parse duoc — bo qua, coi nhu khong co nha */
  }

  // `will-navigate`/`will-redirect` chi ban cho MAIN FRAME (iframe di qua
  // `will-frame-navigate`, ta khong nghe) — nen khong can loc frame o day, quang
  // cao/widget nhung trong trang van chay binh thuong.
  const escapeToBrowser = (event, url) => {
    if (!/^https?:\/\//i.test(url)) return; // zalo:, tg:, mailto:, blob: — de guest tu xu
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (!homeHost || sameApp(host, homeHost)) return; // dieu huong trong app
    event.preventDefault();
    askOpenTarget(url);
  };

  guest.on('will-navigate', escapeToBrowser);
  // Chuyen huong giua chang (link shortener trong tin nhan) cung phai bat, neu
  // khong URL cuoi da nam ngoai app moi bi CSP chan.
  guest.on('will-redirect', escapeToBrowser);
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
// Google chan dang nhap trong embedded browser ("This browser or app may not
// be secure") bang cach soi User-Agent/headers o FLOW DANG NHAP. Workaround
// pho bien: rieng cac host dang nhap Google, trinh UA Firefox (Google khong
// ap heuristic "embedded Chrome" cho Firefox) va bo header Sec-CH-UA* (Firefox
// khong gui client hints nen giu lai la tu mau thuan). Moi trang khac giu
// nguyen UA Chrome cua guest. Dang nhap lot mot lan la cookie luu ben trong
// partition — tu do Docs/Sheets editor day du chay ngay trong app.
const GOOGLE_LOGIN_HOSTS = /(^|\.)accounts\.google\.com$|(^|\.)gds\.google\.com$/;
const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

function configurePartition(part) {
  if (!part || configuredPartitions.has(part)) return;
  configuredPartitions.add(part);
  const ses = session.fromPartition(part);

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const host = new URL(details.url).hostname;
      if (GOOGLE_LOGIN_HOSTS.test(host)) {
        const headers = { ...details.requestHeaders };
        headers['User-Agent'] = FIREFOX_UA;
        for (const k of Object.keys(headers)) {
          if (/^sec-ch-ua/i.test(k)) delete headers[k];
        }
        callback({ requestHeaders: headers });
        return;
      }
    } catch {
      /* URL la ve (chrome-extension:, data:, ...) — bo qua */
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = ALLOWED_PERMISSIONS.has(permission);
    if (!ok) log('PermissionDenied', `${part} · ${permission}`);
    callback(ok);
  });

  // Synchronous permission CHECKS (e.g. Notification.permission, navigator
  // .storage.persisted()) must agree with the request handler, otherwise apps
  // read "denied" and never show notifications.
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  wireDownloadPolicy(ses, part);
}

/**
 * Download policy for ONE session — dùng chung cho session mặc định (UI DevBox,
 * vd nút ⬇ tab Google) lẫn partition của từng webview guest.
 *
 * LUÔN đặt savePath tường minh (tự lưu vào Downloads của máy, tên trùng thì
 * đánh số " (n)"): không đặt thì Electron bật hộp thoại Save native — download
 * không có handler/savePath từng làm app crash văng ra ngoài. Lưu xong mở
 * Explorer trỏ đúng file để người dùng biết nó nằm đâu.
 */
const wiredDownloadSessions = new WeakSet();
function wireDownloadPolicy(ses, label) {
  if (wiredDownloadSessions.has(ses)) return;
  wiredDownloadSessions.add(ses);
  ses.on('will-download', (_event, item) => {
    if (!CONFIG.allowDownload) {
      log('DownloadBlocked', item.getFilename());
      item.cancel();
      return;
    }
    try {
      const dir = app.getPath('downloads');
      const file = item.getFilename() || 'download';
      const ext = path.extname(file);
      const base = path.basename(file, ext);
      let target = path.join(dir, file);
      for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
      item.setSavePath(target);
      log('DownloadStarted', `${label || 'default'} · ${target}`);
      item.once('done', (_e, state) => {
        log('DownloadDone', `${path.basename(target)} · ${state}`);
        if (state === 'completed') shell.showItemInFolder(target);
      });
    } catch (err) {
      log('DownloadError', err && err.message);
      item.cancel();
    }
  });
}

/** Harden + instrument each <webview> guest as it attaches to the window. */
function wireWebviewHardening(win) {
  const wc = win.webContents;

  // `did-attach-webview` chi cho guest, khong cho biet nha cua no la dau va no
  // thuoc partition nao. Ca hai chi co o `will-attach-webview` — ma hai event
  // nay ban lien tiep cho cung mot guest, nen giu tam o day roi doc lai ngay
  // ben duoi.
  let pendingSrc = '';
  let pendingPartition = '';

  // Enforce safe webPreferences on every guest BEFORE it is created.
  wc.on('will-attach-webview', (_event, prefs, params) => {
    pendingSrc = params.src || '';
    pendingPartition = params.partition || '';
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

    // Link ra ngoai bang cach dieu huong chinh main frame (cach Zalo/Telegram
    // mo link trong tin nhan) → browser that, giu workspace o nguyen trang app.
    wireExternalNavigation(guest, pendingSrc || guest.getURL(), pendingPartition);

    // Popups (target=_blank, window.open) → hoi mo o dau, khong bao gio de mo
    // mot cua so roi trong app.
    //
    // TRA VE 'deny' LA CAI BAY: window.open() trong guest se tra ve null, va
    // Zalo KIEM TRA gia tri do — thay null la no ket luan popup bi chan roi
    // hien toast "Co loi xay ra khi mo popup moi, vui long kiem tra lai quyen
    // mo popup cua trang web". Link van mo dung, chi rieng bao loi la sai.
    //
    // Vi vay cho phep tao that mot cua so AN (khong bao gio hien) de guest nhan
    // duoc object khac null → khong con canh bao. Cua so nay bi huy ngay o
    // did-create-window ben duoi.
    //
    // Dat 'about:blank' thay vi de nguyen URL: neu khong, cua so an se THAT SU
    // tai trang do truoc khi bi huy — vua ton mot request vua co the kich hoat
    // side effect hai lan (link dung mot lan, link xac nhan qua email...).
    // Guest chi can mot object window de kiem tra, khong can noi dung.
    guest.setWindowOpenHandler(({ url }) => {
      if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
      askOpenTarget(url);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { show: false, width: 1, height: 1 },
        outlivesOpener: false,
      };
    });

    // Cua so an sinh ra tu setWindowOpenHandler o tren: URL da chuyen cho
    // askOpenTarget nen chan tai trang roi huy luon.
    guest.on('did-create-window', (child) => {
      try {
        child.webContents.on('will-navigate', (e) => e.preventDefault());
        child.webContents.stop();
        child.destroy();
      } catch {
        /* da dong roi */
      }
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

    // DevTools cho guest — debug trang đang xem (Network/Console/Elements):
    //   · F12 (hoặc Ctrl+Shift+I) NGAY TRONG webview → toggle DevTools của guest
    //     (phím trong guest không bubble ra host nên phải bắt ở before-input-event).
    //   · Chuột phải → menu Cut/Copy/Paste + "Inspect element" đúng vị trí click
    //     (webview mặc định không có context menu nào).
    guest.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12' || (input.control && input.shift && (input.key === 'I' || input.key === 'i'))) {
        guest.toggleDevTools();
      }
    });
    guest.on('context-menu', (_e, params) => {
      const menu = Menu.buildFromTemplate([
        { label: 'Cắt', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Sao chép', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Dán', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        ...(params.linkURL ? [{
          label: 'Sao chép địa chỉ liên kết',
          click: () => { require('electron').clipboard.writeText(params.linkURL); },
        }, { type: 'separator' }] : []),
        {
          label: '🔍 Inspect element (DevTools)',
          click: () => { guest.inspectElement(params.x, params.y); },
        },
      ]);
      menu.popup();
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
    stdio: ['ignore', 'pipe', 'pipe'], // captured → in-app Console drawer
    detached: process.platform !== 'win32',  // own process group on POSIX
  });
  // Split the streams into lines and mirror them into the in-app console.
  const forwardStream = (stream) => {
    let acc = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      acc += chunk;
      let nl;
      while ((nl = acc.indexOf('\n')) !== -1) {
        const line = acc.slice(0, nl).replace(/\r$/, '');
        acc = acc.slice(nl + 1);
        if (line.trim()) pushLog('next', line);
      }
    });
    stream.on('end', () => {
      if (acc.trim()) pushLog('next', acc.trimEnd());
      acc = '';
    });
  };
  forwardStream(devServer.stdout);
  forwardStream(devServer.stderr);
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

// Tra focus ve host page — workaround Electron bug: huy <webview> dang giu
// focus xong host van tuong guest giu focus, moi input tren trang chet (nhin
// nhu bi disable) cho toi khi user click ra ngoai cua so. UI goi sau khi dong
// viewer nhung (GoogleDocViewer.onClose).
ipcMain.handle('workspace:focusHost', (evt) => {
  try {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (win) win.focus();
    evt.sender.focus();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
});

// Người dùng chọn "Trình duyệt ngoài" trong hộp thoại mở link. Chỉ nhận http(s)
// — không để renderer nhờ shell chạy scheme lạ (file:, ms-msdt:…).
ipcMain.handle('workspace:openExternal', (_evt, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'invalid url' };
  }
  try {
    shell.openExternal(url);
    log('OpenExternal', url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
});

// ── Mật khẩu đã lưu: mã hóa at-rest bằng safeStorage (DPAPI trên Windows) ──
// safeStorage CHỈ dùng được trong main process, và Next server là process riêng
// (ELECTRON_RUN_AS_NODE) nên API route không với tới. Vì vậy renderer gọi hai
// handler này để niêm phong/mở niêm phong, còn store (lib/passwordStore.ts) chỉ
// giữ ciphertext — copy configs/passwords.json sang máy/user khác là vô dụng.
ipcMain.handle('workspace:encryptSecret', (_evt, plain) => {
  if (typeof plain !== 'string' || !plain) return { ok: false, error: 'empty' };
  try {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'unavailable' };
    return { ok: true, value: safeStorage.encryptString(plain).toString('base64') };
  } catch (err) {
    log('EncryptError', err && err.message);
    return { ok: false, error: err && err.message };
  }
});

ipcMain.handle('workspace:decryptSecret', (_evt, b64) => {
  if (typeof b64 !== 'string' || !b64) return { ok: false, error: 'empty' };
  try {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'unavailable' };
    return { ok: true, value: safeStorage.decryptString(Buffer.from(b64, 'base64')) };
  } catch (err) {
    // Sai user Windows / file copy từ máy khác → không giải mã được.
    log('DecryptError', err && err.message);
    return { ok: false, error: err && err.message };
  }
});

// ── In HTML ra PDF (tab Tools → Chuyển đổi file) ──────────────────────────
// Next server là process riêng nên không gọi được Electron; renderer lấy HTML
// từ /api/convert rồi nhờ handler này in, xong gửi base64 ngược về server ghi
// file. Dùng chính Chromium của app: không thêm dependency, font tiếng Việt
// chuẩn. Cửa sổ in là offscreen, KHÔNG hiện ra và luôn được đóng ở finally.
ipcMain.handle('workspace:htmlToPdf', async (_evt, html) => {
  if (typeof html !== 'string' || !html) return { ok: false, error: 'empty html' };
  let win = null;
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true,
        // Trang in là HTML do server dựng từ file người dùng — cách ly tối đa:
        // không Node, không preload, JS tắt (chỉ cần layout tĩnh).
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: false,
        webSecurity: true,
      },
    });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'default' },
    });
    log('HtmlToPdf', `${pdf.length} bytes`);
    return { ok: true, base64: pdf.toString('base64') };
  } catch (err) {
    log('HtmlToPdfError', err && err.message);
    return { ok: false, error: err && err.message };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
});

// Full log history for the renderer's Console drawer (it then subscribes to
// the `desktop:log` push stream for live lines).
ipcMain.handle('desktop:getLogs', () => logBuffer);

app.whenReady().then(async () => {
  CONFIG = loadConfig();
  // Cửa sổ chính (UI DevBox) chạy trên session mặc định — download từ đó
  // (vd nút ⬇ tab Google) cũng phải đi qua policy tự-lưu, không dialog native.
  wireDownloadPolicy(session.defaultSession, 'default');
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
