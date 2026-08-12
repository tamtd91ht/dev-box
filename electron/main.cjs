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

const { app, BrowserWindow, session, ipcMain, shell, Menu, safeStorage, clipboard, net } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const APP_URL = process.env.DESKTOP_URL || 'http://localhost:3000';

// ── Mở file từ Explorer ("Open with → VHS DevBox") ─────────────────────────
//
// scripts/install-shortcuts.ps1 đăng ký vào registry HKCU một lệnh dạng
//
//   electron.exe "<repo>" "%1"
//
// nên đường dẫn file người dùng bấm vào tới đây qua process.argv. Chuột phải
// một file .xlsx trong Explorer → app bật lên (hoặc app đang chạy nhảy lên
// trước) và mở đúng file đó ở tab Office / tab Tools.
//
// Đuôi file được nhận PHẢI khớp với những gì renderer mở nổi — xem
// onOpenLocalFile trong app/page.tsx. Thêm đuôi ở đây mà renderer không hiểu
// thì file mở ra chỉ để trống.
//
// Danh sách này RỘNG HƠN danh sách mà install-shortcuts.ps1 đăng ký vào menu
// chuột phải, và như thế là đúng: menu "Open with" chỉ nên nhận những đuôi hay
// gặp, còn ở đây thì cứ mở được là mở — vì file còn tới bằng đường khác (kéo
// vào shortcut, dòng lệnh).
const OPENABLE_EXTS = new Set([
  '.xlsx', '.xlsm', '.csv', // tab Office → Bảng tính
  '.docx', // tab Office → Văn bản
  '.md', '.markdown', '.mdown', '.mkd', '.mdx', // tab Tools → Markdown
  '.json', '.xml', '.svg', '.html', '.htm', // tab Tools → JSON/XML/HTML
]);

/**
 * Nhặt đường dẫn file mở-được ra khỏi một mảng argv.
 *
 * Phải lọc kỹ vì argv còn lẫn: đường dẫn electron.exe, thư mục app ('.' hoặc
 * repo root mà launcher truyền vào), và các cờ `--ws-config=…`/`--inspect`.
 * Chỉ nhận đúng một file có thật, đuôi nằm trong danh sách trên.
 */
function fileFromArgv(argv) {
  for (const raw of argv.slice(1)) {
    if (typeof raw !== 'string' || raw.startsWith('-')) continue;
    const ext = path.extname(raw).toLowerCase();
    if (!OPENABLE_EXTS.has(ext)) continue;
    try {
      const abs = path.resolve(raw);
      if (fs.statSync(abs).isFile()) return abs;
    } catch {}
  }
  return null;
}

/**
 * File Explorer yêu cầu mở nhưng renderer CHƯA sẵn sàng nhận.
 *
 * Khởi động nguội là ca chính: `next dev` biên dịch mất vài chục giây, trong
 * lúc đó chưa có trang nào để gửi IPC tới. Giữ đường dẫn ở đây rồi bắn đi khi
 * did-finish-load. Chỉ giữ MỘT — bấm mở nhiều file trong lúc app đang khởi
 * động thì file cuối thắng, chấp nhận được vì lần mở nguội là hiếm.
 */
let pendingOpenFile = null;

/**
 * Gửi đường dẫn xuống renderer; renderer chưa nạp xong thì xếp hàng chờ.
 *
 * Nhánh xếp hàng chỉ an toàn khi có người sẽ đọc lại: did-finish-load của cửa
 * sổ. Cửa sổ chưa tồn tại (app vừa mới ready) thì createWindow() sắp chạy và
 * sẽ nối listener đó — vẫn tới đích. Cửa sổ đang nạp lại (F5) cũng vậy, vì
 * listener sống theo webContents chứ không theo lượt nạp.
 */
function dispatchOpenFile(abs) {
  if (!abs) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed() || win.webContents.isLoading()) {
    pendingOpenFile = abs;
    log('OpenFileQueued', abs);
    return;
  }
  win.webContents.send('desktop:openLocalFile', abs);
  log('OpenFile', abs);
}

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

// ── User-Agent: nói thật là Chrome, đừng khoe là Electron ─────────────────
//
// UA mặc định của Electron có thêm token `Electron/43.2.0` ở giữa `Chrome/…` và
// `Safari/537.36`. Đúng về kỹ thuật (bên dưới là Chromium thật), nhưng các web
// app của Meta soi UA rất chặt:
//   • WhatsApp Web → "WhatsApp works with Google Chrome 100+" và CHẶN LUÔN, dù
//     Chromium bên dưới là 140. Nó không đọc nổi phiên bản khi gặp token lạ.
//   • Messenger / Facebook → luồng đăng nhập bị coi là "trình duyệt nhúng
//     không an toàn", nhập xong không vào được (nên phiên chẳng có gì để lưu).
//
// Bỏ token `Electron/x.y.z` là hết: phần còn lại của chuỗi đã là UA Chrome hợp
// lệ, không bịa thêm phiên bản nào cả — chỉ ngừng tự khai thêm. Đặt qua
// `userAgentFallback` nên áp cho MỌI session/partition (cửa sổ chính lẫn từng
// <webview> guest) mà không phải sửa từng chỗ. Plugin nào cần UA riêng vẫn
// override được bằng `plugin.userAgent` (lib/workspace/types.ts).
app.userAgentFallback = app.userAgentFallback.replace(/ Electron\/[\d.]+/i, '');

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
 * Tab Workspace (Zalo/Telegram/... — partition `persist:ws-{plugin}-{acct}`).
 *
 * Workspace la MOT APP DONG TRONG APP: quet QR, dang nhap, doi subdomain, bam
 * link trong tin nhan — tat ca phai dien ra NGAY TRONG cua so do. DevBox khong
 * chan, khong hoi, khong day URL di dau ca.
 *
 * Phai phan biet voi cac <webview> con lai vi chung la TRINH XEM da nang va co
 * luat rieng: tab Links (persist:links-*), tab Browser, viewer Google
 * (persist:ws-google-viewer) — khong ap luat cua workspace vao chung.
 */
const WORKSPACE_PARTITION = /^(persist:)?ws-(?!google-viewer\b)[a-z0-9-]+$/i;

/**
 * Tab Browser (trinh duyet da tab trong app — partition `persist:browser-*`,
 * xem bmPartition trong lib/bookmarks.ts).
 *
 * Rieng o day, target=_blank / window.open phai mo TAB MOI TRONG APP chu khong
 * day ra Chrome/Edge: phien dang nhap cua profile nam trong partition nay,
 * browser ngoai khong co cookie do nen link se ra trang login.
 */
const BROWSER_PARTITION = /^(persist:)?browser-[a-z0-9-]+$/i;

/**
 * Tab "Zalo API" (thu nghiem) — partition rieng `persist:zaloapi-*`.
 *
 * Tach han khoi WORKSPACE_PARTITION vi day la nhanh THU NGHIEM: tai su dung API
 * noi bo cua Zalo Web sau khi quet QR. Duoc cap cung quyen guest (permission +
 * sendKey) nhu workspace, nhung nhan dien rieng de log/kiem toan khong lan voi
 * luong DOM cu. Doc cookie HttpOnly cua phien nay la buoc rieng — xem handler
 * `zaloapi:readCookies` ben duoi.
 */
const ZALOAPI_PARTITION = /^(persist:)?zaloapi-[a-z0-9-]+$/i;

/** Guest partition duoc dieu khien tu ngoai (workspace cu HOAC nhanh Zalo API). */
const CONTROLLABLE_PARTITION = (p) =>
  typeof p === 'string' && (WORKSPACE_PARTITION.test(p) || ZALOAPI_PARTITION.test(p));

/**
 * Cua so an tra cho `window.open()` cua guest song bao lau truoc khi bi huy.
 *
 * Khong phai con so tuy y: web app do popup co bi chan hay khong bang cach soi
 * `w.closed` SAU khi goi window.open (Zalo kiem lai sau mot nhip), nen cua so
 * phai con song luc do — huy ngay la `closed === true` va app bao "popup bi
 * chan". 10s du rong cho moi kieu kiem tra tre ma van khong giu rac lai lau.
 */
const POPUP_STUB_TTL_MS = 10_000;

/**
 * Hai host co cung "domain dang ky" (bo subdomain) → coi la CUNG MOT APP.
 * chat.zalo.me vs id.zalo.me → cung zalo.me. Tho nhung du: chi dung de phan biet
 * "URL cua chinh app nay" voi "link nguoi ta gui trong tin nhan".
 */
function sameApp(a, b) {
  const reg = (h) => h.toLowerCase().split('.').slice(-2).join('.');
  return !!a && !!b && reg(a) === reg(b);
}

/** Host cua mot URL, '' neu khong parse duoc. */
function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

/**
 * Bam link trong tin nhan workspace → HOI nguoi dung mo o dau. Renderer dung
 * modal hai lua chon (tab Links / tab Browser) roi tu mo, xem
 * components/OpenLinkDialog.tsx.
 *
 * Main process khong ve duoc UI nen chi day URL qua IPC. Neu khong con cua so
 * nao (dang tat app) thi danh mo browser ngoai — luc do khong con tab Links hay
 * tab Browser nao ton tai de mo vao, va de mat hut link con te hon.
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

/**
 * Partition cua mot guest ('' neu chua biet) — dung de biet guest nay co phai
 * tab Workspace hay khong.
 *
 * Doc bang DANH TINH session chu khong bang bien tam cua `will-attach-webview`:
 * `session.fromPartition(p)` luon tra ve dung mot object cho moi partition, nen
 * phep so sanh nay khong the lan hai guest voi nhau. Neu chot theo bien tam thi
 * co the lech, vi `will-attach-webview` va `did-attach-webview` la hai event roi
 * nhau — nhieu webview mount cung mot nhip render (Zalo + Telegram + tab Links)
 * la thu tu xen vao nhau, va luat cua workspace se ap sai guest.
 */
/** Live guest webContents by partition — for main-process input injection. */
const guestByPartition = new Map();

function partitionOf(guest) {
  for (const part of configuredPartitions) {
    try {
      if (session.fromPartition(part) === guest.session) return part;
    } catch {
      /* partition khong con — bo qua */
    }
  }
  return '';
}

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

// ── Client Hints: khai thuong hieu "Google Chrome" ────────────────────────
//
// Bo token `Electron/...` khoi UA (xem app.userAgentFallback o tren) VAN CHUA
// DU cho WhatsApp Web — no khong doc chuoi UA ma doc User-Agent Client Hints.
// Electron khai brand la "Chromium" chu khong phai "Google Chrome", nen check
// "co phai Chrome that khong" cua WhatsApp truot, va no bao "WhatsApp works
// with Google Chrome 100+" du Chromium ben duoi la 140.
//
// Hai mat trong cung mot su that phai khop nhau, thieu mat nao cung truot:
//   1. HEADER `Sec-CH-UA*` gui kem moi request (xu ly ngay duoi day)
//   2. `navigator.userAgentData` doc trong trang (xem CLIENT_HINTS_PATCH)
// Ca hai deu lay so phien ban tu chinh UA that, khong hardcode — nang Electron
// len la tu dong dung theo, khong con cho nao phai sua tay.
const CHROME_MAJOR = (() => {
  const m = /Chrome\/(\d+)/.exec(app.userAgentFallback || '');
  return m ? m[1] : '140';
})();
const CHROME_FULL = (() => {
  const m = /Chrome\/([\d.]+)/.exec(app.userAgentFallback || '');
  return m ? m[1] : `${CHROME_MAJOR}.0.0.0`;
})();

// Thu tu brand + chuoi "Not?A_Brand" la dung khuon Chrome that gui, giu nguyen
// de khong tao ra mot dau van tay la hoac.
const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not?A_Brand";v="99"`;
const SEC_CH_UA_FULL = `"Chromium";v="${CHROME_FULL}", "Google Chrome";v="${CHROME_FULL}", "Not?A_Brand";v="99.0.0.0"`;

/**
 * Nhung host soi Client Hints de chan "trinh duyet nhung". Chi ap cho dung may
 * host nay — moi trang khac giu nguyen hanh vi mac dinh cua Electron, khong
 * dung den mot dong nao cua lop nay.
 */
const CHROME_BRAND_HOSTS = /(^|\.)(whatsapp\.com|messenger\.com|facebook\.com|fbcdn\.net)$/i;

/**
 * Host duoc phep "thang cap" cookie phien thanh cookie luu ben (xem
 * wireSessionCookiePersistence).
 *
 * Rancher phat `R_SESS` KHONG co Expires tru khi tick "Keep me logged in", nen
 * Chromium giu no trong RAM va mat sach khi dong app — dung mot lan la phai go
 * lai user/pass. Chrome that che giau dieu nay bang "Continue where you left
 * off" (hoi sinh session cookie qua cac lan khoi dong); Electron khong co, nen
 * ta lam phan tuong duong nhung CO GIOI HAN: chi cho dung nhung host noi bo
 * duoc liet ke o day.
 *
 * KHONG mo rong thanh ".*": cookie phien la lua chon co chu dich cua trang web
 * ("het phien thi dang xuat"). Ghi de no cho MOI trang la bien mot may dung
 * chung thanh may luon-dang-nhap-san — chi lam voi cong cu noi bo cua minh.
 */
const PERSIST_SESSION_HOSTS =
  /(^|\.)(rancher[a-z0-9-]*\.omicrm\.services|jenkins[a-z0-9-]*\.(omicrm\.services|vihatsoftware\.com)|gitlab\.vihatgroup\.com)$/i;

/** Cookie phien duoc gia han bao lau khi thang cap thanh luu ben. */
const SESSION_COOKIE_TTL_DAYS = 30;

/**
 * Thang cap cookie PHIEN (khong Expires) thanh cookie luu ben cho cac host o
 * PERSIST_SESSION_HOSTS.
 *
 * `cookies.set` lai chinh cookie do kem `expirationDate` — Chromium ghi de ban
 * ghi cu (cung domain+path+name) va lan nay ghi xuong dia. Viec set nay lai
 * phat them mot su kien 'changed', nhung vong lap dung ngay: cookie moi co
 * `session === false` nen lan hai bi loc o dieu kien dau.
 *
 * `cause === 'expired'|'evicted'|'expired-overwrite'` va `removed` deu bi bo
 * qua: do la cookie dang bi go, dung lai la hoi sinh thu da chet.
 */
function wireSessionCookiePersistence(ses, part) {
  ses.cookies.on('changed', (_evt, cookie, cause, removed) => {
    if (removed || cookie.session !== true) return;
    if (cause !== 'explicit' && cause !== 'overwrite') return;
    if (!PERSIST_SESSION_HOSTS.test(cookie.domain || '')) return;

    // Cookie co domain bat dau bang '.' la cookie ap cho ca subdomain; URL de
    // set phai la host that, nen bo dau cham di.
    const host = (cookie.domain || '').replace(/^\./, '');
    const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;

    ses.cookies
      .set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: Date.now() / 1000 + SESSION_COOKIE_TTL_DAYS * 24 * 3600,
      })
      .then(() => log('CookiePersist', `${part} · ${host} · ${cookie.name}`))
      .catch((err) => log('CookiePersistError', `${part} · ${host} · ${cookie.name} · ${err && err.message}`));
  });
}

/**
 * Va lai `navigator.userAgentData` trong trang cho khop voi header o tren.
 *
 * Chay o `document-start` nen no vao truoc moi script cua trang — WhatsApp doc
 * userAgentData rat som, sua sau khi trang chay la muon. `getHighEntropyValues`
 * cung phai tra ve dung bo do: WhatsApp goi ham nay chu khong chi doc `brands`.
 */
const CLIENT_HINTS_PATCH = `
(function(){
  try{
    var brands = [
      { brand: 'Chromium', version: '${CHROME_MAJOR}' },
      { brand: 'Google Chrome', version: '${CHROME_MAJOR}' },
      { brand: 'Not?A_Brand', version: '99' }
    ];
    var high = {
      architecture: 'x86', bitness: '64', model: '',
      platform: 'Windows', platformVersion: '15.0.0',
      uaFullVersion: '${CHROME_FULL}', wow64: false,
      fullVersionList: [
        { brand: 'Chromium', version: '${CHROME_FULL}' },
        { brand: 'Google Chrome', version: '${CHROME_FULL}' },
        { brand: 'Not?A_Brand', version: '99.0.0.0' }
      ]
    };
    var data = {
      brands: brands, mobile: false, platform: 'Windows',
      getHighEntropyValues: function(hints){
        var out = { brands: brands, mobile: false, platform: 'Windows' };
        (hints||[]).forEach(function(h){ if(h in high) out[h] = high[h]; });
        return Promise.resolve(out);
      },
      toJSON: function(){ return { brands: brands, mobile: false, platform: 'Windows' }; }
    };
    Object.defineProperty(navigator, 'userAgentData', { get: function(){ return data; }, configurable: true });
  }catch(e){}
})();
`;

function configurePartition(part) {
  if (!part || configuredPartitions.has(part)) return;
  configuredPartitions.add(part);
  const ses = session.fromPartition(part);

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const host = new URL(details.url).hostname;
      // [TAM THOI - CHAN DOAN] In moi document request toi Google de biet host
      // that su cua trang dang nhap. Go sau khi da chot regex GOOGLE_LOGIN_HOSTS.
      if (details.resourceType === 'mainFrame' && /google|youtube/i.test(host)) {
        log('GAuthProbe', `${GOOGLE_LOGIN_HOSTS.test(host) ? 'UA-FIREFOX' : 'UA-CHROME '} ${host} ${details.url.slice(0, 120)}`);
      }
      if (GOOGLE_LOGIN_HOSTS.test(host)) {
        const headers = { ...details.requestHeaders };
        headers['User-Agent'] = FIREFOX_UA;
        for (const k of Object.keys(headers)) {
          if (/^sec-ch-ua/i.test(k)) delete headers[k];
        }
        callback({ requestHeaders: headers });
        return;
      }
      // Meta (WhatsApp / Messenger / Facebook): khai brand "Google Chrome".
      // GHI DE chu khong xoa — xoa het Sec-CH-UA* thi trang coi nhu trinh duyet
      // khong ho tro client hints, cung roi vao dung nhanh "hay dung Chrome".
      if (CHROME_BRAND_HOSTS.test(host)) {
        const headers = { ...details.requestHeaders };
        headers['sec-ch-ua'] = SEC_CH_UA;
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"Windows"';
        // Chi gui cac hint "entropy cao" khi trang da hoi den — tu dinh them
        // vao moi request la mot dau van tay khac Chrome that.
        if ('sec-ch-ua-full-version-list' in headers) headers['sec-ch-ua-full-version-list'] = SEC_CH_UA_FULL;
        if ('sec-ch-ua-full-version' in headers) headers['sec-ch-ua-full-version'] = `"${CHROME_FULL}"`;
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
  wireSessionCookiePersistence(ses, part);
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

/**
 * Phím tắt của KHUNG APP cần chạy kể cả khi con trỏ đang ở trong <webview>.
 * Trả về tên phím tắt, hoặc null nếu tổ hợp không phải của app.
 *
 * Nhận diện theo `input.code` (vị trí phím vật lý) đúng như host page làm, để
 * layout AZERTY/JIS vẫn bấm đúng ngón — riêng Tab thì `key` mới ổn định.
 */
function appShortcutOf(input) {
  if (!input.control || input.alt || input.meta) return null;
  if (!input.shift && input.code === 'Backquote') return 'quickTabs';
  if (!input.shift && input.key === 'Tab') return 'prevTab';
  if (input.shift && input.code === 'KeyU') return 'ultraView';
  return null;
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
    const partition = partitionOf(guest);
    const isWorkspaceApp = WORKSPACE_PARTITION.test(partition);
    log('WebViewCreated', `${partition || 'default'} · ${guest.getURL()}`);

    // Track the guest's webContents by partition so `workspace:sendKey` can
    // reach it. A background webview cannot receive a trusted key from the
    // renderer's element-level sendInputEvent; the main process can focus this
    // webContents and inject the key regardless of which tab is showing.
    if (partition) {
      guestByPartition.set(partition, guest);
      guest.on('destroyed', () => {
        if (guestByPartition.get(partition) === guest) guestByPartition.delete(partition);
      });
    }

    // Popups (target=_blank, window.open) → khong bao gio de mo mot cua so roi
    // trong app.
    //
    // TAB WORKSPACE: link trong tin nhan Zalo/Telegram di qua duong nay (Zalo
    // dung handler JS + window.open chu khong phai <a href> thuong — nen popup
    // bi chan la click "khong an gi"). Hoi nguoi dung mo o tab Links hay tab
    // Browser, roi renderer tu mo. CA HAI deu o TRONG app.
    //
    // TUYET DOI KHONG goi guest.loadURL(url) o day. Lan sua truoc lam vay va no
    // dieu huong CHINH cai webview dang chay Zalo sang trang link — Zalo bien
    // mat, mat khung chat, quay lai phai load lai tu dau. Guest phai duoc giu
    // NGUYEN VEN: van dang nhap, van o dung cuoc hoi thoai.
    //
    // Cung khong dung lai lop chan will-navigate/will-redirect (da go o dedeb7c):
    // no bat luon dieu huong cua chinh app — quet QR xong Zalo tu chuyen trang
    // va bi chan lai. Chan o dung tang window.open la du.
    //
    // Cac webview khac (tab Links, tab Browser, viewer Google) giu nguyen luat
    // cu: popup ra trinh duyet that cua may.
    //
    // TRA VE 'deny' LA CAI BAY: window.open() trong guest se tra ve null, va
    // Zalo KIEM TRA gia tri do — thay null la no ket luan popup bi chan roi
    // hien toast "Co loi xay ra khi mo popup moi, vui long kiem tra lai quyen
    // mo popup cua trang web". Link van mo dung, chi rieng bao loi la sai.
    //
    // Vi vay cho phep tao that mot cua so AN (khong bao gio hien) de guest nhan
    // duoc object khac null. Cua so nay bi chan tai trang (`stop()` o
    // did-create-window) nen URL that khong he duoc request lan hai — quan trong
    // voi link dung mot lan / link xac nhan qua email — nhung PHAI SONG mot luc,
    // xem POPUP_STUB_TTL_MS.
    guest.setWindowOpenHandler(({ url }) => {
      if (!/^https?:\/\//i.test(url)) return { action: 'deny' };

      if (isWorkspaceApp) {
        // URL CUA CHINH APP (zalo.me → zalo.me): day la app tu dieu huong, dien
        // hinh la quet QR xong Zalo mo lai app cua no bang window.open. Phai cho
        // no chay NGAY TRONG webview nay — hoi "mo o dau" o day la be luon luong
        // dang nhap. Chi link THAT SU ra ngoai domain moi dem ra hoi.
        // guest.getURL() la URL DANG chay cua guest — dung o thoi diem popup nay
        // no chinh la trang Zalo hien tai, khong can bien tam nao (xem chu thich
        // cua partitionOf ve viec KHONG chot theo bien cua will-attach-webview).
        if (sameApp(hostOf(url), hostOf(guest.getURL()))) {
          setImmediate(() => {
            if (!guest.isDestroyed()) guest.loadURL(url).catch(() => {});
          });
          log('OpenInWorkspace', url);
        } else {
          askOpenTarget(url);
        }
      } else if (BROWSER_PARTITION.test(partition)) {
        // TAB BROWSER: day la trinh duyet trong app, nen target=_blank /
        // window.open phai ra TAB MOI NGAY TRONG TAB BROWSER — dung nhu trinh
        // duyet that. Truoc day day ra Chrome/Edge ngoai, roi khoi phien dang
        // nhap cua profile (cookie nam trong partition cua app, browser ngoai
        // khong co) — bam link la thanh trang login.
        //
        // Gui thang 'workspace:openInBrowserTab' (khong qua askOpenTarget) vi
        // o day khong con gi de hoi: nguoi dung dang O TRONG tab Browser.
        if (!win.isDestroyed()) {
          win.webContents.send('workspace:openInBrowserTab', url);
          log('OpenInBrowserTab', url);
        } else {
          shell.openExternal(url);
        }
      } else {
        shell.openExternal(url);
        log('OpenExternal', url);
      }

      return {
        action: 'allow',
        overrideBrowserWindowOptions: { show: false, width: 1, height: 1 },
        outlivesOpener: false,
      };
    });

    // Cua so an sinh ra tu setWindowOpenHandler o tren: URL da duoc xu ly xong
    // nen chan tai trang, roi de no SONG mot luc truoc khi huy.
    //
    // KHONG DUOC HUY NGAY. Zalo khong chi kiem `w !== null` — no con kiem LAI
    // sau mot nhip, va phep kiem chuan cua web la:
    //     if (!w || w.closed || typeof w.closed === 'undefined') → "popup bi chan"
    // Huy ngay thi lan kiem sau thay `w.closed === true` va toast "Co loi xay ra
    // khi mo popup moi" van hien, du link da mo dung. Da do bang harness
    // Electron (webview + dung phep kiem tren):
    //     huy ngay      → sync OK, async BLOCKED (closed=true)   ← dung loi nay
    //     giu roi huy   → sync OK, async OK      (closed=false)
    // Giu cua so an (1x1, show:false, da stop nen trang trang) vai giay khong ton
    // gi, va het TTL la huy nen khong ro ri.
    guest.on('did-create-window', (child) => {
      try {
        child.webContents.on('will-navigate', (e) => e.preventDefault());
        child.webContents.stop();
      } catch {
        /* da dong roi */
      }
      setTimeout(() => {
        try {
          if (!child.isDestroyed()) child.destroy();
        } catch {
          /* Electron da tu don khi opener dieu huong (outlivesOpener: false) */
        }
      }, POPUP_STUB_TTL_MS);
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

    // Client Hints cho cac host cua Meta: va `navigator.userAgentData` cho khop
    // voi header Sec-CH-UA* da ghi de o configurePartition().
    //
    // Phai chay o `did-start-navigation` chu khong phai `dom-ready`: WhatsApp
    // doc userAgentData ngay trong script dau tien cua trang, den luc DOM xong
    // thi no da ket luan "khong phai Chrome" va ve man hinh chan roi. Chi dong
    // vao dung cac host trong CHROME_BRAND_HOSTS, trang khac khong bi anh huong.
    guest.on('did-start-navigation', (e) => {
      try {
        if (!e.isMainFrame) return;
        if (!CHROME_BRAND_HOSTS.test(new URL(e.url).hostname)) return;
        guest.executeJavaScript(CLIENT_HINTS_PATCH, false).catch(() => {});
      } catch {
        /* URL la ve — bo qua */
      }
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
    //
    // Cùng lý do đó, PHÍM TẮT CỦA APP (Ctrl+` · Ctrl+Tab · Ctrl+Shift+U) cũng
    // chết khi con trỏ đang nằm trong webview: đang chat Zalo thì phím đi thẳng
    // vào trang Zalo, host page không bao giờ thấy keydown. Bắt hộ ở đây rồi
    // chuyển cho renderer — chỉ đúng ba tổ hợp này, phím khác vẫn để guest xử lý
    // nguyên vẹn.
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12' || (input.control && input.shift && (input.key === 'I' || input.key === 'i'))) {
        guest.toggleDevTools();
        return;
      }
      const shortcut = appShortcutOf(input);
      if (!shortcut) return;
      event.preventDefault(); // guest không nhận phím này nữa
      if (win.isDestroyed()) return;
      // Kéo focus về host TRƯỚC khi báo: overlay tiếp cận nhanh có ô tìm kiếm,
      // focus còn kẹt trong guest thì mở ra cũng không gõ được. Cùng cặp lệnh
      // với ipc 'workspace:focusHost' — chỉ win.webContents.focus() đôi khi
      // không rứt nổi focus khỏi frame của guest.
      win.focus();
      win.webContents.focus();
      win.webContents.send('desktop:shortcut', shortcut);
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

  // window.open() tu chinh UI DevBox → MO TRONG APP, khong day ra Edge/Chrome.
  //
  // Day la CHO DUY NHAT moi `window.open(...)` tran trong renderer di qua (nut
  // "mo tren browser" o tab Google, bookmark tab Browser, link trong Mail...).
  // Truoc day no goi shell.openExternal thang, nen "mot so noi" bat ra trinh
  // duyet mac dinh cua may — dung thu ma nguoi dung khong muon.
  //
  // Gio gui sang renderer de no tu chon dich theo defaultTargetFor()
  // (lib/openTarget.ts): link Google can dang nhap → tab Links, con lai → tab
  // Browser. Van 'deny' vi khong bao gio duoc mo mot BrowserWindow roi.
  //
  // Renderer khong nghe duoc (chua mount) thi coi nhu mat link — nen fallback
  // shell.openExternal khi khong gui duoc.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      try {
        win.webContents.send('workspace:openInApp', url);
        log('OpenInApp', url);
      } catch {
        shell.openExternal(url);
        log('OpenExternal', `${url} (send failed)`);
      }
    }
    return { action: 'deny' };
  });

  wireWebviewHardening(win);

  // File mà Explorer nhờ mở lúc app còn đang khởi động: bắn xuống ngay khi
  // trang đã nạp. Dùng did-finish-load chứ không phải ready-to-show — renderer
  // phải chạy rồi mới có listener nhận IPC.
  //
  // Đợi thêm một nhịp: sự kiện này bắn khi HTML nạp xong, mà listener nằm
  // trong useEffect của React nên đăng ký sau đó một chút. Gửi sớm quá thì
  // tin rơi vào khoảng trống và file im lặng không mở.
  win.webContents.on('did-finish-load', () => {
    if (!pendingOpenFile) return;
    const abs = pendingOpenFile;
    pendingOpenFile = null;
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.webContents.send('desktop:openLocalFile', abs);
      log('OpenFile', abs);
    }, 400);
  });

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

// Anh dai dien tai khoan: tai anh HO renderer, tra ve data URL.
//
// VI SAO PHAI O MAIN PROCESS: avatar duoc phuc vu tu CDN khac goc
// (s160-26-ava-talk.zadn.vn, scontent.*, cdn5.telesco.pe) va KHONG kem header
// CORS. Trong guest thi:
//   - fetch()      -> ERR_FAILED, vi khong co Access-Control-Allow-Origin
//   - canvas       -> toDataURL nem SecurityError, vi canvas bi "tainted"
// Ca hai duong deu chet dung voi loai anh ta can. `net.request` cua Electron
// chay o tang mang, KHONG co khai niem CORS — va di qua `session` cua partition
// nen van gui dung cookie, tai duoc anh rieng tu.
//
// CHI cho partition workspace (`ws-*`) va chi tra ve anh: day la mot cai fetch
// tuy y do renderer dieu khien, nen phai khoa lai bang partition + kiem
// Content-Type + gioi han kich thuoc, khong bien no thanh proxy chung.
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB — avatar that chi vai chuc KB

ipcMain.handle('workspace:fetchImage', async (_evt, partition, url) => {
  if (typeof partition !== 'string' || !WORKSPACE_PARTITION.test(partition)) {
    return { ok: false, error: 'partition khong hop le' };
  }
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return { ok: false, error: 'url khong hop le' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'chi ho tro http(s)' };
  }
  try {
    const ses = session.fromPartition(partition);
    const res = await new Promise((resolve, reject) => {
      const req = net.request({ url: parsed.toString(), session: ses, useSessionCookies: true });
      req.on('response', (r) => {
        const chunks = [];
        let size = 0;
        r.on('data', (c) => {
          size += c.length;
          if (size > AVATAR_MAX_BYTES) {
            try { r.destroy(); } catch { /* da dong */ }
            reject(new Error('anh qua lon'));
            return;
          }
          chunks.push(c);
        });
        r.on('end', () =>
          resolve({ status: r.statusCode, type: String(r.headers['content-type'] || ''), body: Buffer.concat(chunks) }),
        );
        r.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `http ${res.status}` };
    // Header co the la "image/jpeg; charset=..." — chi can tien to.
    const mime = (Array.isArray(res.type) ? res.type[0] : res.type).split(';')[0].trim();
    if (!/^image\//i.test(mime)) return { ok: false, error: `khong phai anh (${mime || 'trong'})` };
    return { ok: true, dataUrl: `data:${mime};base64,${res.body.toString('base64')}` };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'that bai' };
  }
});

// Zalo API (thu nghiem): doc cookie HttpOnly cua mot phien.
//
// VI SAO PHAI O MAIN PROCESS: zpsid / zpw_sek (va doi khi zpw_enk) la cookie
// HttpOnly — `document.cookie` trong guest KHONG doc duoc chung, do dinh nghia.
// Chi tang session cua Electron (`session.cookies.get`) moi thay. Day chinh la
// manh ma script trich xuat o renderer bao "phai lay o tang Electron".
//
// CHI cho partition zaloapi-* (nhanh thu nghiem da opt-in), khong mo cho moi
// partition — cookie phien la toan quyen tai khoan, khong phoi bua.
//
// Tra ve cac cookie theo TEN yeu cau (mask do ben renderer lo), kem danh sach
// ten cookie thay duoc de chan doan khi thieu manh nao.
ipcMain.handle('zaloapi:readCookies', async (_evt, partition, names) => {
  if (!ZALOAPI_PARTITION.test(String(partition || ''))) {
    return { ok: false, error: 'partition khong phai zaloapi-*' };
  }
  try {
    const ses = session.fromPartition(partition);
    // LAY MOI COOKIE cua session roi loc theo domain zalo — KHONG dung
    // `.get({domain:'zalo.me'})` vi Electron loc theo domain do BO SOT cookie
    // gan o subdomain nhu `.chat.zalo.me` (dac biet `zpw_sek` — cookie ky phien
    // HttpOnly). Thieu `zpw_sek` la Zalo tra 102 "session key improperly
    // submitted" — dung loi da gap. Lay het roi loc ten cho chac.
    const raw = await ses.cookies.get({});
    const all = raw.filter((c) => /(^|\.)zalo\.me$/i.test(c.domain || ''));
    const wanted = Array.isArray(names) && names.length ? names : ['zpsid', 'zpw_sek', 'zpw_enk', 'app.event.zalo.me', 'zoaw_sek'];
    const out = {};
    for (const c of all) {
      if (wanted.includes(c.name)) out[c.name] = c.value;
    }
    // `header`: TOAN BO cookie zalo ghep lai nhu trinh duyet gui di. Buoc dang
    // nhap server-side can nguyen chuoi nay — thieu mot cai la bi tu choi ca luot.
    // Trung ten (khac domain/path) thi giu cai DAU tien.
    const seenNames = new Set();
    const parts = [];
    for (const c of all) {
      if (seenNames.has(c.name)) continue;
      seenNames.add(c.name);
      parts.push(`${c.name}=${c.value}`);
    }
    const header = parts.join('; ');
    log('ZaloApiCookies', `${partition} · ${all.length}/${raw.length} cookie zalo · zpw_sek=${!!out['zpw_sek']}`);
    return { ok: true, cookies: out, header, seen: all.map((c) => `${c.name}@${c.domain}`) };
  } catch (err) {
    log('ZaloApiCookiesError', `${partition} · ${err && err.message}`);
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

// Bơm một phím THẬT vào guest của một partition (automation gửi tin Zalo).
//
// Vì sao phải ở main process, không phải renderer: ô soạn React của Zalo bỏ
// qua sự kiện giả (isTrusted=false) nên Enter phải là sự kiện thật;
// `<webview>.sendInputEvent` ở renderer chỉ ăn khi webview đang focus, mà rule
// chạy từ tab khác thì webview ở nền. Ở đây focus đúng webContents của guest
// (không đổi cửa sổ đang hiện của người dùng) rồi bơm phím.
//
// Chỉ nhận các phím trong danh sách trắng — không để renderer bơm chuỗi tùy ý.
const SEND_KEYS = { Return: 'Enter', Enter: 'Enter' };
ipcMain.handle('workspace:sendKey', (_evt, partition, keyCode) => {
  const code = SEND_KEYS[keyCode];
  if (!code) return { ok: false, error: 'key not allowed' };
  if (!CONTROLLABLE_PARTITION(partition)) {
    return { ok: false, error: 'bad partition' };
  }
  const guest = guestByPartition.get(partition);
  if (!guest || guest.isDestroyed()) {
    log('SendKey', `${partition} · ✗ guest not found`);
    return { ok: false, error: 'guest not found' };
  }
  try {
    guest.focus(); // focus THIS guest's webContents; does not change the visible tab
    const focused = guest.isFocused();
    // A full physical keystroke: keyDown → char → keyUp. The earlier version
    // sent only keyDown/keyUp with 'Return' and Zalo did not submit even though
    // the event arrived (focused=true). A contenteditable that sends on Enter
    // often needs the char event too, and 'Enter' is the keyCode Chromium maps
    // to key:'Enter', keyCode:13 — what the app's handler checks.
    guest.sendInputEvent({ type: 'keyDown', keyCode: code });
    guest.sendInputEvent({ type: 'char', keyCode: code });
    guest.sendInputEvent({ type: 'keyUp', keyCode: code });
    log('SendKey', `${partition} · ${code} · focused=${focused}`);
    return { ok: true, focused };
  } catch (err) {
    log('SendKey', `${partition} · ✗ ${err && err.message}`);
    return { ok: false, error: err && err.message };
  }
});

// Renderer nhờ mở URL bằng trình duyệt ngoài (nút ↗ ở tab Google, link hướng
// dẫn trong panel lỗi mail). Chỉ nhận http(s) — không để renderer nhờ shell
// chạy scheme lạ (file:, ms-msdt:…).
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

// ── Tab Remote: bật phần mềm điều khiển từ xa có sẵn trên máy ─────────────
//
// DevBox không tự vẽ màn hình máy kia (muốn vậy phải có host capture + relay
// xuyên NAT — tức là viết lại UltraViewer). Nó chỉ NHỚ máy và bật đúng client.
//
// AN TOÀN: renderer KHÔNG được truyền đường dẫn chương trình. Nó chỉ gửi
// `kind` (một khoá trong bảng dưới) + địa chỉ; main process tự tra ra file
// .exe. Nếu để renderer đưa path tuỳ ý thì một trang web trong <webview>
// chiếm được cầu IPC là chạy được mọi thứ trên máy.
//
// Địa chỉ còn phải khớp ADDRESS_OK (đồng bộ với lib/remoteHosts.ts) trước khi
// ghép vào tham số dòng lệnh — chặn chèn tham số kiểu `1.2.3.4 /shadow:1`.
const ADDRESS_OK = /^[A-Za-z0-9._\-:@ ]{1,128}$/;

/** Các chỗ hay cài UltraViewer/AnyDesk/TeamViewer trên Windows. */
function firstExisting(candidates) {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* path lạ — bỏ qua */
    }
  }
  return null;
}

function programFiles() {
  return [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'],
  ].filter(Boolean);
}

/**
 * Dựng lệnh cho một loại kết nối.
 * → { cmd, args } | { error }
 *
 * Mỗi nhánh tự quyết định tham số; địa chỉ đã được kiểm tra ở trên nên chỉ
 * còn việc đặt đúng chỗ. Không dùng shell (spawn với shell:false) nên khoảng
 * trắng trong đường dẫn không thành lỗ hổng.
 */
function buildRemoteCommand(kind, address, username) {
  const addr = address.trim();
  if (kind === 'rdp') {
    // mstsc có sẵn trong Windows. /v: nhận host[:port].
    if (process.platform !== 'win32') return { error: 'RDP chỉ bật sẵn được trên Windows' };
    return { cmd: 'mstsc.exe', args: [`/v:${addr}`] };
  }
  if (kind === 'ultraviewer') {
    const exe = firstExisting(
      programFiles().map((base) => path.join(base, 'UltraViewer', 'UltraViewer_Desktop.exe')),
    );
    if (!exe) return { error: 'Không thấy UltraViewer trên máy — cài rồi thử lại' };
    // UltraViewer không nhận ID qua dòng lệnh: bật lên để người dùng dán ID
    // (DevBox đã copy sẵn vào clipboard trước khi gọi).
    return { cmd: exe, args: [], manual: true };
  }
  if (kind === 'anydesk') {
    const exe = firstExisting(
      programFiles().map((base) => path.join(base, 'AnyDesk', 'AnyDesk.exe')),
    );
    if (!exe) return { error: 'Không thấy AnyDesk trên máy — cài rồi thử lại' };
    return { cmd: exe, args: [addr] };
  }
  if (kind === 'teamviewer') {
    const exe = firstExisting(
      programFiles().map((base) => path.join(base, 'TeamViewer', 'TeamViewer.exe')),
    );
    if (!exe) return { error: 'Không thấy TeamViewer trên máy — cài rồi thử lại' };
    return { cmd: exe, args: ['-i', addr] };
  }
  if (kind === 'vnc') {
    const exe = firstExisting([
      ...programFiles().map((b) => path.join(b, 'RealVNC', 'VNC Viewer', 'vncviewer.exe')),
      ...programFiles().map((b) => path.join(b, 'uvnc bvba', 'UltraVNC', 'vncviewer.exe')),
      ...programFiles().map((b) => path.join(b, 'TightVNC', 'tvnviewer.exe')),
    ]);
    if (!exe) return { error: 'Không thấy VNC Viewer (RealVNC/UltraVNC/TightVNC) trên máy' };
    return { cmd: exe, args: [addr] };
  }
  return { error: `Loại kết nối không hỗ trợ: ${kind}` };
}

ipcMain.handle('workspace:openRemote', (_evt, payload) => {
  const kind = payload && payload.kind;
  const address = payload && payload.address;
  if (typeof kind !== 'string' || typeof address !== 'string' || !address.trim()) {
    return { ok: false, error: 'thiếu thông tin máy' };
  }
  if (!ADDRESS_OK.test(address.trim())) {
    return { ok: false, error: 'địa chỉ chứa ký tự không hợp lệ' };
  }
  const built = buildRemoteCommand(kind, address, payload.username);
  if (built.error) {
    log('RemoteOpenFail', `${kind} ${address} — ${built.error}`);
    return { ok: false, error: built.error };
  }
  // Client không nhận ID qua dòng lệnh (UltraViewer) → chép sẵn ID vào
  // clipboard để người dùng chỉ việc Ctrl+V vào ô "ID máy đối tác".
  if (built.manual) {
    try {
      clipboard.writeText(address.trim());
    } catch {
      /* không chép được thì thôi, vẫn bật client */
    }
  }
  try {
    // detached + unref: client sống độc lập, đóng DevBox không giết nó theo.
    const child = spawn(built.cmd, built.args, {
      detached: true,
      stdio: 'ignore',
      shell: false, // KHÔNG qua shell — tránh mọi chuyện diễn giải chuỗi
    });
    child.on('error', (err) => log('RemoteSpawnError', err && err.message));
    child.unref();
    log('RemoteOpen', `${kind} ${address}`);
    return { ok: true, manual: !!built.manual };
  } catch (err) {
    log('RemoteOpenFail', err && err.message);
    return { ok: false, error: (err && err.message) || 'không bật được client' };
  }
});

// Chép chuỗi vào clipboard (nút chép mật khẩu ở tab Remote). Không ghi giá trị
// vào log — đây là chỗ duy nhất plaintext đi qua main process.
ipcMain.handle('workspace:copyText', (_evt, text) => {
  if (typeof text !== 'string' || !text) return { ok: false, error: 'empty' };
  try {
    clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
});

// Full log history for the renderer's Console drawer (it then subscribes to
// the `desktop:log` push stream for live lines).
ipcMain.handle('desktop:getLogs', () => logBuffer);

// ── Một app duy nhất ───────────────────────────────────────────────────────
//
// BẮT BUỘC từ khi có "Open with": mỗi lần bấm mở file, Windows chạy lại lệnh
// đã đăng ký, tức là một tiến trình Electron MỚI. Không có khoá này thì mỗi
// file mở ra một app riêng, mỗi app lại ensureDevServer() tranh cổng 3000 —
// cái sau thấy cổng bận, hai cửa sổ cùng trỏ vào một dev server, đóng cái này
// thì stopDevServer() giết luôn server của cái kia.
//
// Instance thứ hai chết ngay lập tức, nhưng trước khi chết Electron chuyển
// argv của nó sang instance đang giữ khoá qua 'second-instance' — nhờ đó cú
// bấm "mở file" vẫn tới đích, chỉ là do app đang chạy thực hiện.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      // Người dùng vừa bấm mở file → họ mong thấy app ngay, kể cả khi nó đang
      // thu nhỏ hoặc nằm dưới cửa sổ Explorer.
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    dispatchOpenFile(fileFromArgv(argv));
  });

  app.whenReady().then(async () => {
    CONFIG = loadConfig();
    // Cửa sổ chính (UI DevBox) chạy trên session mặc định — download từ đó
    // (vd nút ⬇ tab Google) cũng phải đi qua policy tự-lưu, không dialog native.
    wireDownloadPolicy(session.defaultSession, 'default');
    // Nhặt file NGAY từ argv gốc: khởi động nguội bằng cách bấm vào file thì
    // đường dẫn nằm ở đây, và phải giữ trước khi ensureDevServer() ngốn mất
    // vài chục giây. createWindow() sẽ bắn nó đi lúc trang nạp xong.
    pendingOpenFile = fileFromArgv(process.argv);
    if (pendingOpenFile) log('OpenFileQueued', pendingOpenFile);
    await ensureDevServer(); // start next dev if nothing is serving :3000 yet
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// macOS đưa file vào app qua sự kiện riêng chứ không qua argv. DevBox chạy
// Windows là chính, nhưng nối vào đây thì mở file trên Mac cũng chạy sẵn.
app.on('open-file', (evt, filePath) => {
  evt.preventDefault();
  const ext = path.extname(filePath).toLowerCase();
  if (OPENABLE_EXTS.has(ext)) dispatchOpenFile(path.resolve(filePath));
});

// Make sure the dev server we started doesn't outlive the app.
app.on('before-quit', stopDevServer);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
