// Browser Workspace Framework — the guest-side collector.
//
// ONE generic script, injected into any workspace guest, that reports two things
// on every poll: the unread count and any messages captured since the last poll.
// It is deliberately app-agnostic — Zalo, Telegram Web, WhatsApp Web, Slack,
// Google Chat all expose the same two universal signals:
//
//   1. the Web Notification API — `new Notification(title, {body})` AND
//      `ServiceWorkerRegistration.showNotification(...)` (PWAs like WhatsApp Web
//      and Telegram Web use the service-worker form, so BOTH are hooked)
//   2. a small, vividly-coloured numeric badge in the DOM (red for Zalo, blue
//      for Telegram, green for WhatsApp) + a "(N)" prefix in document.title
//
// A plugin tunes it with a small declarative CaptureSpec — never by forking the
// script. Anything genuinely app-specific goes in `extraScript`.
//
// Privacy: message TEXT is only recorded while the page-level flag
// `window.__wsCap` is true. The renderer sets it from the automation config's
// captureEnabled switch, so with capture off the guest counts unread and stores
// nothing at all.

/** Declarative knobs for the generic collector. */
export interface CaptureSpec {
  /**
   * Notification titles that are the bare app name rather than a conversation
   * (e.g. "WhatsApp"). Used to avoid recording "WhatsApp" as the sender.
   */
  genericTitles?: string[];
  /**
   * Group-chat notifications often read: title = group, body = "Alice: hi".
   * Set the separator (": ") to split sender out of the body. Empty = don't split.
   */
  bodySenderSeparator?: string;
  /**
   * Extra JS statements appended inside the collector, with `push(sender,
   * conversation, text, source)` and `out` in scope. For an app whose
   * notifications are useless and needs real DOM scraping.
   */
  extraScript?: string;
  /** Skip the DOM badge scan (notification counter + title only). */
  disableBadgeScan?: boolean;
}

/** Raw shape the collector returns to the renderer. */
export interface CollectResult {
  /** Unread count. */
  u: number;
  /** Messages captured since the previous poll. */
  m: Array<{ t: number; s: string; c: string; x: string; k: string }>;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Build the collector expression for one plugin. The result is passed verbatim
 * to webview.executeJavaScript(), so it must be a single self-contained
 * expression that returns a JSON-serializable value.
 */
export function buildCollectorScript(spec: CaptureSpec = {}): string {
  const generic = json(spec.genericTitles ?? []);
  const sep = json(spec.bodySenderSeparator ?? '');
  const badgeScan = spec.disableBadgeScan ? 'false' : 'true';
  const extra = spec.extraScript ?? '';

  return `(function(){
  try {
    var GENERIC = ${generic};
    var SEP = ${sep};
    var BADGE_SCAN = ${badgeScan};

    // ── one-time page hooks ────────────────────────────────────────────────
    if(!window.__wsHook){
      window.__wsHook = true;
      window.__wsNoti = window.__wsNoti || 0;
      window.__wsMsgQ = window.__wsMsgQ || [];

      // Record one message. Text is kept ONLY when capture is switched on.
      window.__wsPush = function(sender, conversation, text, source){
        try {
          window.__wsNoti = (window.__wsNoti||0) + 1;
          if(!window.__wsCap) return;                 // capture off → count only
          var q = window.__wsMsgQ;
          q.push({ t: Date.now(), s: String(sender||''), c: String(conversation||''),
                   x: String(text||''), k: source||'notification' });
          if(q.length > 50) q.splice(0, q.length - 50); // bounded, never a leak
        } catch(_){}
      };

      // Split "Alice: hello" (group notifications) into sender + text.
      window.__wsSplit = function(title, body){
        var t = String(title||''), b = String(body||'');
        var sender = t, conv = t, text = b;
        for(var i=0;i<GENERIC.length;i++){ if(t === GENERIC[i]){ conv = ''; sender = ''; } }
        if(SEP){
          var at = b.indexOf(SEP);
          if(at > 0 && at < 40){ sender = b.slice(0, at); text = b.slice(at + SEP.length); }
        }
        if(!sender) sender = t;
        return { sender: sender, conv: conv, text: text };
      };

      // (1a) window.Notification — the classic path (Zalo).
      try {
        var Orig = window.Notification;
        if(typeof Orig === 'function'){
          var Hooked = function(title, options){
            try { var p = window.__wsSplit(title, options && options.body);
                  window.__wsPush(p.sender, p.conv, p.text, 'notification'); } catch(_){}
            return new Orig(title, options);
          };
          Hooked.prototype = Orig.prototype;
          try { Object.defineProperty(Hooked,'permission',{get:function(){ return Orig.permission; }}); } catch(_){}
          Hooked.requestPermission = function(){ return Orig.requestPermission.apply(Orig, arguments); };
          try { Object.defineProperty(window,'Notification',{configurable:true,writable:true,value:Hooked}); }
          catch(_){ window.Notification = Hooked; }
        }
      } catch(_){}

      // (1b) ServiceWorkerRegistration.showNotification — the PWA path used by
      //      WhatsApp Web / Telegram Web. Without this hook they'd be silent.
      try {
        var SWR = window.ServiceWorkerRegistration;
        if(SWR && SWR.prototype && SWR.prototype.showNotification){
          var origShow = SWR.prototype.showNotification;
          SWR.prototype.showNotification = function(title, options){
            try { var p = window.__wsSplit(title, options && options.body);
                  window.__wsPush(p.sender, p.conv, p.text, 'notification'); } catch(_){}
            return origShow.apply(this, arguments);
          };
        }
      } catch(_){}

      // Reading the page clears the notification-based unread counter.
      try {
        var clear = function(){ window.__wsNoti = 0; };
        window.addEventListener('pointerdown', clear, true);
        window.addEventListener('keydown', clear, true);
      } catch(_){}
    }

    var out = { u: 0, m: [] };
    var noti = window.__wsNoti || 0;

    // ── (2) DOM badge scan: a small numeric leaf on a vivid background ──────
    // Vivid = one channel clearly dominates (red Zalo / green WhatsApp / blue
    // Telegram) — colour-agnostic so a new app needs no code here.
    var sum = 0, hits = 0, cand = [];
    if(BADGE_SCAN && document.body){
      function num(t){ t=(t||'').trim(); if(!t||t.length>4) return -1;
        var core = t.charAt(t.length-1)==='+' ? t.slice(0,-1) : t;
        if(!core.length) return -1;
        for(var i=0;i<core.length;i++){ var c=core.charCodeAt(i); if(c<48||c>57) return -1; }
        var n=parseInt(core,10); return isNaN(n)?-1:n; }
      function bg(el){ var cur=el;
        for(var k=0;k<3&&cur;k++){
          var s=getComputedStyle(cur);
          var p=(s.backgroundColor||'').replace('rgba(','').replace('rgb(','').replace(')','').split(',');
          var r=parseInt(p[0],10), a=p.length>3?parseFloat(p[3]):1;
          if(!isNaN(r)&&a>=0.3) return { r:r, g:parseInt(p[1],10), b:parseInt(p[2],10), s:(s.backgroundColor||'') };
          cur=cur.parentElement; }
        return null; }
      function vivid(c){
        var mx=Math.max(c.r,c.g,c.b), mn=Math.min(c.r,c.g,c.b);
        return mx>=120 && (mx-mn)>=45; }
      var nodes = document.body.querySelectorAll('span,div,b,i,em,p,a');
      for(var i=0;i<nodes.length;i++){ var el=nodes[i];
        if(el.children&&el.children.length) continue;
        var n2=num(el.textContent); if(n2<=0) continue;
        var st=getComputedStyle(el);
        if(st.display==='none'||st.visibility==='hidden'||parseFloat(st.opacity||'1')===0) continue;
        var r2=el.getBoundingClientRect();
        if(r2.width<6||r2.width>48||r2.height<6||r2.height>30) continue;
        var c2=bg(el);
        if(cand.length<8) cand.push(el.tagName+'.'+String(el.className).slice(0,40)+'|n='+n2+'|'+Math.round(r2.width)+'x'+Math.round(r2.height)+'|bg='+(c2?c2.s:'none'));
        if(!c2) continue;
        if(vivid(c2)){ sum+=n2; hits++; }
      }
    }

    // ── (3) "(N)" in the document title ────────────────────────────────────
    var title=document.title||'', tc=0;
    var a2=title.indexOf('('), b2=title.indexOf(')');
    if(a2>=0&&b2>a2){ var tn=parseInt(title.slice(a2+1,b2),10); if(!isNaN(tn)&&tn>0) tc=tn; }

    // ── (4) plugin-specific extension point ────────────────────────────────
    var push = function(sender, conversation, text, source){
      window.__wsPush(sender, conversation, text, source||'dom'); };
    ${extra}

    // ── drain + report ─────────────────────────────────────────────────────
    if(window.__wsMsgQ && window.__wsMsgQ.length){
      out.m = window.__wsMsgQ.splice(0, window.__wsMsgQ.length);
    }
    out.u = Math.max(noti, sum, tc);

    if(sum===0 && cand.length>0){
      var now=Date.now();
      if(!window.__wsDiagAt || now-window.__wsDiagAt>60000){
        window.__wsDiagAt=now;
        try{ console.log('[ws-diag] badge candidates: '+cand.join(' || ')); }catch(_){}
      }
    }
    if(window.__wsU!==out.u){ window.__wsU=out.u;
      try{ console.log('[ws-unread] count='+out.u+' (noti='+noti+' badges='+hits+' domSum='+sum+' title='+JSON.stringify(title)+')'); }catch(_){} }
    if(out.m.length){ try{ console.log('[ws-msg] captured '+out.m.length); }catch(_){} }
    return out;
  } catch(e){ try{ console.log('[ws-unread] collector error '+e); }catch(_){} return { u:0, m:[] }; }
})()`;
}

/** Flip the in-page capture flag (renderer → guest). */
export const captureFlagScript = (on: boolean) => `window.__wsCap=${on ? 'true' : 'false'};`;
