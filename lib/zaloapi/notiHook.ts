// Zalo API — bắt thông báo NGAY TRONG guest để đếm tin đến (cho badge + chuông).
//
// Vì sao cần dù đã có listener server-side: đo được — trang Zalo trong webview
// tự bắn `new Notification` khi có tin (toast Electron hiện lên), tức TIN CÓ TỚI
// ở tầng trang. Nhưng listener WebSocket server-side là một socket RIÊNG, có thể
// chưa parse được (cmd/schema khác bản build) → badge không lên dù toast có.
//
// Cách chắc ăn cho BADGE: hook chính `new Notification` của trang — đúng kỹ
// thuật collector cũ (lib/workspace/capture.ts) đã chạy ổn định cho Zalo. Nó
// độc lập hoàn toàn với listener: badge lên ngay cả khi listener chưa chạy.
// (Listener vẫn giữ vai trò nuôi automation bằng threadId thật — hai việc khác
// nhau, không thay thế nhau.)
//
// Chỉ ĐẾM số lần bắn, không giữ nội dung. Host poll `drainNotiScript` mỗi nhịp.

/** Cài hook (idempotent). Đếm mỗi lần trang bắn Notification. */
export function buildNotiHookScript(): string {
  return `(function(){
  try {
    if(window.__zaNotiHook) return { installed:true, already:true };
    window.__zaNotiHook = true;
    window.__zaNotiN = window.__zaNotiN || 0;

    function bump(){ try { window.__zaNotiN = (window.__zaNotiN||0) + 1; } catch(_){} }

    // (1) window.Notification — đường Zalo dùng.
    try {
      var Orig = window.Notification;
      if(typeof Orig === 'function'){
        var Hooked = function(title, options){ bump(); return new Orig(title, options); };
        Hooked.prototype = Orig.prototype;
        try { Object.defineProperty(Hooked,'permission',{get:function(){ return Orig.permission; }}); } catch(_){}
        Hooked.requestPermission = function(){ return Orig.requestPermission.apply(Orig, arguments); };
        try { Object.defineProperty(window,'Notification',{configurable:true,writable:true,value:Hooked}); }
        catch(_){ window.Notification = Hooked; }
        window.__zaNotiVia = 'Notification';
      }
    } catch(_){}

    // (2) ServiceWorkerRegistration.showNotification — dự phòng (PWA).
    try {
      var SWR = window.ServiceWorkerRegistration;
      if(SWR && SWR.prototype && SWR.prototype.showNotification){
        var origShow = SWR.prototype.showNotification;
        SWR.prototype.showNotification = function(){ bump(); return origShow.apply(this, arguments); };
      }
    } catch(_){}

    return { installed:true, already:false, via: window.__zaNotiVia || '' };
  } catch(e){ return { installed:false, error: String(e && e.message ? e.message : e) }; }
})()`;
}

/**
 * Hút số thông báo tích luỹ từ lần poll trước (đọc-và-reset trong guest).
 * Đọc `document.hidden` để không cộng lúc người dùng đang xem chính trang này.
 */
export function drainNotiScript(): string {
  return `(function(){
  try {
    if(!window.__zaNotiHook) return { hooked:false, n:0 };
    var n = window.__zaNotiN || 0; window.__zaNotiN = 0;
    return { hooked:true, n:n };
  } catch(e){ return { hooked:false, n:0 }; }
})()`;
}
