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
// KHONG ghi de thu gi da co: moi shim deu nam sau `if (!c.tabs)` / `if
// (!c.cookies)`. Ban Electron sau nay cap that chrome.tabs thi doan nay tu dong
// dung im, khong bien mot API that thanh do gia.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Boi canh tab dang xem, nhan qua HASH cua URL popup.
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

/**
 * Gắn shim vào đối tượng `chrome` CÓ SẴN của trang.
 *
 * Popup ở đúng origin extension nên Electron đã dựng sẵn `chrome` thật với
 * storage/runtime. Phải VÁ VÀO đó chứ không thay cả cụm — thay là mất luôn
 * storage/runtime thật, popup hỏng nặng hơn lúc chưa vá.
 *
 * Chay trong ngu canh trang (executeJavaScript) vi contextBridge khong cho ghi
 * de/mo rong mot object da ton tai ben phia trang.
 */
// KHONG gan qua contextBridge roi doc lai o main world: hai buoc do khong cung
// mot nhip, va neu INSTALL chay truoc khi bridge kip gan thi no se gan
// `chrome.tabs = undefined` — popup goi chrome.tabs.query la nem loi ngay, va
// man hinh trang. Nhung shim vao THANG trong chuoi INSTALL: mot buoc, khong co
// khe hoi nao de lech.
const INSTALL = `(function(){
  try {
    var c = (typeof chrome !== 'undefined' && chrome) ? chrome : (window.chrome = {});

    // Tab gia lap: popup chi can id + url + active + windowId.
    var CTX = ${JSON.stringify(ctx)};
    function fakeTab(){
      return { id:1, index:0, windowId:1, active:true, highlighted:true, pinned:false,
               incognito:false, selected:true, discarded:false, autoDiscardable:true,
               groupId:-1, url:CTX.activeUrl, pendingUrl:CTX.activeUrl, title:'',
               favIconUrl:'', status:'complete' };
    }
    function dual(v, cb){
      if (typeof cb === 'function') { try { cb(v); } catch(e){ console.error(e); } }
      return Promise.resolve(v);
    }

    if (!c.tabs) c.tabs = {
      query:  function(_i, cb){ return dual([fakeTab()], cb); },
      get:    function(_i, cb){ return dual(fakeTab(), cb); },
      getCurrent: function(cb){ return dual(fakeTab(), cb); },
      update: function(a, b, d){
        var props = (typeof a === 'object') ? a : b;
        var cb = (typeof b === 'function') ? b : d;
        var url = props && typeof props.url === 'string' ? props.url : '';
        if (url) window.__devboxSend('navigate', url);
        return dual(fakeTab(), cb);
      },
      create: function(props, cb){
        var url = props && typeof props.url === 'string' ? props.url : '';
        if (url) window.__devboxSend('openTab', url);
        return dual(fakeTab(), cb);
      },
      sendMessage: function(_i,_m,o,cb){
        var fn = (typeof o === 'function') ? o : cb;
        return dual(undefined, fn);
      },
      onUpdated:   { addListener:function(){}, removeListener:function(){}, hasListener:function(){return false;} },
      onActivated: { addListener:function(){}, removeListener:function(){}, hasListener:function(){return false;} }
    };

    if (!c.cookies) c.cookies = {
      getAll: function(details, cb){
        var p = window.__devboxCookieGet(
          (details && details.domain) || '',
          (details && details.name) ? [details.name] : null
        );
        if (typeof cb === 'function') p.then(function(v){ try { cb(v); } catch(e){ console.error(e); } });
        return p;
      },
      get: function(details, cb){
        var p = c.cookies.getAll(details).then(function(l){ return l[0] || null; });
        if (typeof cb === 'function') p.then(function(v){ try { cb(v); } catch(e){ console.error(e); } });
        return p;
      },
      set:    function(){ return Promise.resolve(null); },
      remove: function(){ return Promise.resolve(null); },
      onChanged: { addListener:function(){}, removeListener:function(){}, hasListener:function(){return false;} }
    };

    if (!c.runtime) c.runtime = {};
  } catch (e) { console.error('[devbox] cai shim loi:', e); }
})();`;

// Hai ham cau noi — day la thu DUY NHAT di qua contextBridge, va shim o tren
// chi goi chung LUC NGUOI DUNG BAM (khong phai luc cai), nen khong con van de
// thu tu nhu cach cu.
contextBridge.exposeInMainWorld('__devboxSend', (kind, url) => {
  if (kind === 'navigate') ipcRenderer.send('extPopup:navigate', url);
  else if (kind === 'openTab') ipcRenderer.send('extPopup:openTab', url);
});
contextBridge.exposeInMainWorld('__devboxCookieGet', (domain, names) =>
  ipcRenderer
    .invoke('browserExt:getCookies', ctx.partition, domain, names)
    .then((r) => (r && r.ok ? r.cookies : []))
    .catch(() => []));

// Chay NGAY khi preload nap, TRUOC moi script cua trang — popup goi
// chrome.tabs.query gan nhu tuc thi, cai sau la da muon.
webFrame.executeJavaScript(INSTALL).catch((e) => console.error('[devbox] shim:', e));
