// Zalo API — trích xuất credential từ phiên Zalo Web đã đăng nhập.
//
// Chạy TRONG guest webview (chat.zalo.me đã quét QR) qua executeJavaScript.
// Chỉ cần đọc ra HAI thứ renderer đọc được: `imei` và `uid`. Cookie phiên
// (zpsid/zpw_sek) là HttpOnly nên phải lấy ở main process (readZaloCookies);
// còn secretKey do bước login server-side tự lấy từ response — KHÔNG đọc từ đây.
//
// imei là mảnh quan trọng nhất: Zalo Web sinh nó một lần rồi lưu lại, và cookie
// gắn chặt với đúng imei đó. KHÔNG sinh lại — phải đọc đúng cái đã lưu, nếu
// không mọi request bị từ chối dù cookie đúng. Vì tên khoá đổi theo bản build,
// ta QUÉT localStorage + IndexedDB theo mẫu thay vì chốt cứng một khoá.

/**
 * Biểu thức đọc phiên: hàm async tự gói, trả JSON. IndexedDB đọc bất đồng bộ nên
 * toàn bộ nằm trong một Promise.
 */
export function buildExtractScript(): string {
  return `(async function(){
  var out = { loggedIn:false, session:null, detail:'' };
  try {
    var cookieNames = [];
    try {
      (document.cookie||'').split(';').forEach(function(c){ var k=c.split('=')[0].trim(); if(k) cookieNames.push(k); });
    } catch(_){}

    // ── localStorage: gộp lại rồi khớp mẫu tìm imei/uid ──────────────────────
    var ls = {};
    try { for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); ls[k]=localStorage.getItem(k); } } catch(_){}
    var blob = ''; try { blob = JSON.stringify(ls); } catch(_){}

    function findByKeys(obj, names){
      for(var n=0;n<names.length;n++) for(var key in obj){
        if(key.toLowerCase().indexOf(names[n]) >= 0){ var v=obj[key]; if(v && String(v).length) return String(v); }
      }
      return '';
    }
    function findInBlob(re){ try { var m = blob.match(re); if(m && m[1]) return m[1]; } catch(_){} return ''; }

    var imei = findByKeys(ls, ['imei','deviceid','device_id']) || findInBlob(/"(?:imei|deviceId|device_id)"\\s*:\\s*"([^"]+)"/i);
    var uid = findInBlob(/"(?:uid|userId|ownerId|send2me_id)"\\s*:\\s*"?(\\d{6,})"?/i);

    // ── IndexedDB: Zalo Web mới lưu credential ở đây ─────────────────────────
    if(!imei || !uid){
      try {
        if(window.indexedDB && indexedDB.databases){
          var dbs = await indexedDB.databases();
          for(var d=0; d<dbs.length && (!imei || !uid); d++){
            var name = dbs[d].name; if(!name) continue;
            var db; try { db = await new Promise(function(res,rej){ var r=indexedDB.open(name); r.onsuccess=function(){res(r.result);}; r.onerror=function(){rej(r.error);}; }); } catch(_){ continue; }
            var stores = Array.prototype.slice.call(db.objectStoreNames||[]);
            for(var s=0; s<stores.length && (!imei || !uid); s++){
              var rows = [];
              try { rows = await new Promise(function(res,rej){ var tx=db.transaction(stores[s],'readonly'); var rq=tx.objectStore(stores[s]).getAll(); rq.onsuccess=function(){res(rq.result||[]);}; rq.onerror=function(){rej(rq.error);}; }); } catch(_){ continue; }
              for(var r2=0; r2<rows.length; r2++){
                var txt=''; try { txt = JSON.stringify(rows[r2]); } catch(_){ continue; }
                if(!imei){ var mi = txt.match(/"(?:imei|deviceId|device_id)"\\s*:\\s*"([^"]+)"/i); if(mi) imei=mi[1]; }
                if(!uid){ var mu = txt.match(/"(?:uid|userId|ownerId|send2me_id)"\\s*:\\s*"?(\\d{6,})"?/i); if(mu) uid=mu[1]; }
              }
            }
            try { db.close(); } catch(_){}
          }
        }
      } catch(_){}
    }
    if(!uid){ try { if(window.currentUserInfo && window.currentUserInfo.userId) uid = String(window.currentUserInfo.userId); } catch(_){} }

    // Đã đăng nhập: có uid, hoặc có cookie phiên, hoặc danh sách hội thoại đã render.
    out.loggedIn = !!uid || cookieNames.indexOf('zpsid') >= 0 || !!document.querySelector('.conv-item');
    out.session = { imei: imei||'', uid: uid||'', userAgent: navigator.userAgent };
    out.detail = !out.loggedIn ? 'chưa đăng nhập' : (imei ? 'đọc được imei' : 'đã đăng nhập nhưng chưa dò ra imei');
    return out;
  } catch(e){
    out.detail = 'lỗi trích xuất: ' + (e && e.message ? e.message : e);
    return out;
  }
})()`;
}
